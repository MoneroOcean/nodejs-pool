"use strict";
const debug = require("debug")("blockManager");
const fs = require("fs");
const childProcess = require("child_process");
const { createConsoleLogger } = require("./common/logging");

const BLOCK_UNLOCK_INTERVAL_MS = 2 * 60 * 1000;
const BLOCK_HASH_CONFIRM_DELAY = 5;
const ALTBLOCK_PRECALC_DELAY = 720;
const MAX_ANCHOR_PRECALC_PER_CYCLE = 10;
const BALANCE_LOOKUP_CONCURRENCY = 24;
const BALANCE_UPDATE_BATCH_SIZE = 100;
const logger = createConsoleLogger(console);

function formatError(error) { return error && error.stack ? error.stack : String(error); }

function hashString(hash) {
    if (typeof hash === "string") return hash;
    if (hash && typeof hash.toString === "function") return hash.toString("hex");
    return String(hash);
}

function normalizePaymentId(paymentId) {
    return typeof paymentId === "string" && paymentId.length > 10 ? paymentId : null;
}

function formatNumber(value) { return Number.isFinite(value) ? value.toFixed(6).replace(/\.?0+$/, "") : String(value); }

function createBlockManagerRuntime(options) {
    const opts = options || {};
    const mysqlPool = opts.mysql || global.mysql;
    const database = opts.database || global.database;
    const coinFuncs = opts.coinFuncs || global.coinFuncs;
    const support = opts.support || global.support;
    const config = opts.config || global.config;
    const protos = opts.protos || global.protos;
    const fsApi = opts.fs || fs;
    const childProcessApi = opts.childProcess || childProcess;
    const setTimeoutFn = opts.setTimeout || setTimeout;
    const clearTimeoutFn = opts.clearTimeout || clearTimeout;
    const blockUnlockIntervalMs = opts.blockUnlockIntervalMs || BLOCK_UNLOCK_INTERVAL_MS;
    const balanceLookupConcurrency = opts.balanceLookupConcurrency || BALANCE_LOOKUP_CONCURRENCY;
    const state = {
        started: false,
        timer: null,
        cyclePromise: null,
        paymentInProgress: false,
        isFullStop: false,
        balanceIdCache: Object.create(null),
        pendingBalanceLookups: new Map(),
        inFlightPrecalc: new Set()
    };

    function cacheKey(paymentAddress, poolType, paymentId) { return paymentAddress + "|" + poolType + "|" + (paymentId === null ? "" : paymentId); }
    function logInfo(scope, fields) { logger.logInfo(scope, typeof fields === "string" ? { status: fields } : fields); }
    function logWarn(scope, fields) { logger.logWarn(scope, typeof fields === "string" ? { status: fields } : fields); }
    function logError(scope, fields) { logger.logError(scope, typeof fields === "string" ? { status: fields } : fields); }
    function formatCoinPort(port) { return coinFuncs.PORT2COIN_FULL(port) + "/" + port; }
    function formatHashes(blockHexes) { return blockHexes.map(hashString).join(", "); }
    function renderEmailTemplate(item, values, fallback) {
        if (support && typeof support.renderEmailTemplate === "function") return support.renderEmailTemplate(item, values, fallback);
        const template = config && config.email && typeof config.email[item] === "string" ? config.email[item] : fallback;
        return support && typeof support.formatTemplate === "function"
            ? support.formatTemplate(template || "", values || {})
            : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
                return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
            });
    }
    function sendAdminTemplateEmail(subjectItem, bodyItem, values, subjectFallback, bodyFallback) {
        support.sendEmail(
            config.general.adminEmail,
            renderEmailTemplate(subjectItem, values || {}, subjectFallback),
            renderEmailTemplate(bodyItem, values || {}, bodyFallback)
        );
    }
    function formatAltWaitSummary(blockHeightWait) {
        return Object.keys(blockHeightWait).sort(function (left, right) { return parseInt(left, 10) - parseInt(right, 10); })
            .map(function (port) { return formatCoinPort(port) + " x" + blockHeightWait[port].length; }).join(", ");
    }

    function fullStop(error) {
        const message = formatError(error);
        state.isFullStop = true;
        logError("Payout", "full stop on balance credit issue: " + message + "; balance credits disabled until restart");
        sendAdminTemplateEmail(
            "blockMgrBalanceSubject",
            "blockMgrBalanceBody",
            { message: message },
            "block_manager unable to make balance increase",
            "The block_manager module has hit an issue making a balance increase: %(message)s.  Please investigate and restart block_manager as appropriate"
        );
    }

    function callCoin(methodName) {
        const args = Array.prototype.slice.call(arguments, 1);
        return new Promise(function (resolve) {
            coinFuncs[methodName].call(coinFuncs, ...args, function (error, body) {
                resolve({ error, body });
            }, true);
        });
    }

    function canRun(cycleName, dropName) {
        if (state.isFullStop) {
            debug("Dropping all " + dropName);
            return false;
        }
        if (state.paymentInProgress) {
            logError(cycleName, "skip while payout is active");
            return false;
        }
        return true;
    }

    async function getTopBlockHeight() {
        const latest = await callCoin("getLastBlockHeader");
        if (latest.error !== null) {
            logError("Top block", "header request failed");
            return null;
        }
        return latest.body.height;
    }

    async function getOrCreateBalanceId(payment) {
        const paymentId = normalizePaymentId(payment.payment_id);
        const poolType = payment.pool_type;
        const key = cacheKey(payment.payment_address, poolType, paymentId);
        async function loadRows(executor) {
            return executor.query(
                paymentId === null
                    ? "SELECT id FROM balance WHERE payment_address = ? AND payment_id IS NULL AND pool_type = ?"
                    : "SELECT id FROM balance WHERE payment_address = ? AND payment_id = ? AND pool_type = ?",
                paymentId === null ? [payment.payment_address, poolType] : [payment.payment_address, paymentId, poolType]
            );
        }
        if (key in state.balanceIdCache) return state.balanceIdCache[key];
        if (state.pendingBalanceLookups.has(key)) return state.pendingBalanceLookups.get(key);

        const lookupPromise = (async function () {
            let rows = await loadRows(mysqlPool);
            if (rows.length > 1) {
                const error = "Multiple balance rows found for " + payment.payment_address + " / " + poolType;
                fullStop(error);
                throw new Error(error);
            }
            if (rows.length === 0) {
                try {
                    const result = await mysqlPool.query(
                        "INSERT INTO balance (payment_address, payment_id, pool_type) VALUES (?, ?, ?)",
                        [payment.payment_address, paymentId, poolType]
                    );
                    state.balanceIdCache[key] = result.insertId;
                    debug("Added to the SQL database: " + result.insertId);
                    return result.insertId;
                } catch (error) {
                    if (!error || (error.code !== "ER_DUP_ENTRY" && String(error.message || error).indexOf("Duplicate entry") === -1)) {
                        throw error;
                    }
                    rows = await loadRows(mysqlPool);
                }
            }
            if (rows.length !== 1) {
                const error = "Unable to resolve balance row for " + payment.payment_address + " / " + poolType;
                fullStop(error);
                throw new Error(error);
            }
            state.balanceIdCache[key] = rows[0].id;
            debug("Found it in MySQL: " + rows[0].id);
            return rows[0].id;
        })();

        state.pendingBalanceLookups.set(key, lookupPromise);
        try {
            return await lookupPromise;
        } finally {
            state.pendingBalanceLookups.delete(key);
        }
    }

    async function resolveBalanceCredits(credits) {
        if (!credits.length) return [];
        const resolved = new Array(credits.length);
        let nextIndex = 0;
        await Promise.all(Array.from({ length: Math.min(balanceLookupConcurrency, credits.length) }, async function () {
            while (nextIndex < credits.length) {
                const index = nextIndex++;
                resolved[index] = { id: await getOrCreateBalanceId(credits[index]), amount: credits[index].amount };
            }
        }));
        const aggregated = new Map();
        for (const credit of resolved) {
            if (!credit.amount) continue;
            aggregated.set(credit.id, (aggregated.get(credit.id) || 0) + credit.amount);
        }
        return Array.from(aggregated, function (entry) {
            return { id: entry[0], amount: entry[1] };
        });
    }

    async function withTransaction(work) {
        if (typeof mysqlPool.getConnection !== "function") {
            throw new Error("MySQL pool does not support block_manager transactions");
        }
        const connection = await mysqlPool.getConnection();
        let inTransaction = false;
        try {
            await connection.beginTransaction();
            inTransaction = true;
            const result = await work(connection);
            await connection.commit();
            inTransaction = false;
            return result;
        } catch (error) {
            if (inTransaction) {
                try {
                    await connection.rollback();
                } catch (_rollbackError) {}
            }
            throw error;
        } finally {
            try {
                if (typeof connection.release === "function") connection.release();
            } catch (_releaseError) {}
        }
    }

    async function applyBalanceCredits(connection, credits) {
        let total = 0;
        for (let index = 0; index < credits.length; index += BALANCE_UPDATE_BATCH_SIZE) {
            const batch = credits.slice(index, index + BALANCE_UPDATE_BATCH_SIZE);
            if (!batch.length) continue;
            const whenClauses = [];
            const ids = [];
            const params = [];
            for (const credit of batch) {
                total += credit.amount;
                whenClauses.push("WHEN ? THEN ?");
                params.push(credit.id, credit.amount);
                ids.push(credit.id);
            }
            params.push(...ids);
            const sql = "UPDATE balance SET amount = amount + CASE id " + whenClauses.join(" ") +
                " ELSE 0 END WHERE id IN (" + ids.map(function () { return "?"; }).join(",") + ")";
            const result = await connection.query(sql, params);
            if (!result || typeof result.affectedRows !== "number" || result.affectedRows < ids.length) {
                logError("Payout SQL", "partial balance update for ids " + ids.join(","));
            }
        }
        return total;
    }

    async function getBalanceSum() {
        const rows = await mysqlPool.query("SELECT SUM(amount) as amt FROM balance");
        if (!rows[0] || typeof rows[0].amt === "undefined") {
            throw new Error("SELECT SUM(amount) as amt FROM balance query returned undefined result");
        }
        return rows[0].amt;
    }

    async function replaceBlockBalanceRows(blockHexes, rows) {
        try {
            await mysqlPool.query("DELETE FROM block_balance WHERE hex IN (?)", [blockHexes]);
            if (!rows.length) return true;
            const result = await mysqlPool.query(
                "INSERT INTO block_balance (hex, payment_address, payment_id, amount) VALUES ?",
                [rows]
            );
            if (!result || typeof result.affectedRows !== "number" || result.affectedRows < rows.length) {
                logError("PPLNS precalc", "block_balance insert failed for " + formatHashes(blockHexes) + ": " + JSON.stringify(result));
                return false;
            }
            return true;
        } catch (error) {
            logError("PPLNS precalc", "block_balance write failed for " + formatHashes(blockHexes) + ": " + formatError(error));
            return false;
        }
    }

    async function writeShareDump(blockHexes, shares4dump) {
        if (!shares4dump.length || !fsApi.existsSync("./block_share_dumps/process.sh")) return;
        shares4dump.sort();
        shares4dump.unshift("#last_16_chars_of_xmr_address\ttimestamp\traw_share_diff\tshare_count\tshare_coin\txmr_share_diff\txmr_share_diff_paid");
        const filename = "block_share_dumps/" + blockHexes[0] + ".cvs";
        try {
            await new Promise(function (resolve, reject) {
                fsApi.writeFile(filename, shares4dump.join("\n"), function (error) {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        } catch (_error) {
            logError("Share dump", "write failed for " + filename);
            return;
        }
        const files = blockHexes.map(function (blockHex) {
            return " block_share_dumps/" + blockHex + ".cvs";
        }).join("");
        await new Promise(function (resolve) {
            childProcessApi.exec("./block_share_dumps/process.sh" + files, function (error, stdout, stderr) {
                if (error) {
                    logError("Share dump", "process.sh failed for " + formatHashes(blockHexes) + " with exit " + error.code);
                } else {
                    logInfo("Share dump", "complete for " + formatHashes(blockHexes));
                }
                resolve();
            });
        });
    }

    function createPplnsPaymentData() {
        return Object.assign(Object.create(null), {
            [config.payout.feeAddress]: { pool_type: "fees", payment_address: config.payout.feeAddress, payment_id: null, amount: 0 },
            [coinFuncs.coinDevAddress]: { pool_type: "fees", payment_address: coinFuncs.coinDevAddress, payment_id: null, amount: 0 },
            [coinFuncs.poolDevAddress]: { pool_type: "fees", payment_address: coinFuncs.poolDevAddress, payment_id: null, amount: 0 }
        });
    }

    function ensurePplnsPaymentRow(paymentData, shareData) {
        const paymentId = typeof shareData.paymentID === "undefined" ? null : shareData.paymentID;
        const userIdentifier = paymentId ? shareData.paymentAddress + "." + paymentId : shareData.paymentAddress;
        if (!(userIdentifier in paymentData)) {
            paymentData[userIdentifier] = {
                pool_type: "pplns",
                payment_address: shareData.paymentAddress,
                payment_id: paymentId,
                amount: 0
            };
        }
        return userIdentifier;
    }

    function appendPplnsDumpRow(shares4dump, userIdentifier, shareData, amountToPay, amountToPayAfterFees) {
        shares4dump.push(
            userIdentifier.slice(-16) + "\t" +
            shareData.timestamp.toString(16) + "\t" +
            shareData.raw_shares + "\t" +
            shareData.share_num + "\t" +
            coinFuncs.PORT2COIN_FULL(shareData.port) + "\t" +
            amountToPay + "\t" +
            (amountToPay === amountToPayAfterFees ? "" : amountToPayAfterFees)
        );
    }

    function addPplnsSharePayments(context, userIdentifier, amountToPay) {
        const feesToPay = amountToPay * (config.payout.pplnsFee / 100);
        const devDonation = feesToPay * (config.payout.devDonation / 100);
        const poolDevDonation = feesToPay * (config.payout.poolDevDonation / 100);
        const amountToPayAfterFees = amountToPay - feesToPay;
        appendPplnsDumpRow(context.shares4dump, userIdentifier, context.shareData, amountToPay, amountToPayAfterFees);
        context.addPayment(userIdentifier, amountToPayAfterFees);
        context.addPayment(config.payout.feeAddress, feesToPay - devDonation - poolDevDonation);
        context.addPayment(coinFuncs.poolDevAddress, poolDevDonation);
        context.addPayment(coinFuncs.coinDevAddress, devDonation);
    }

    async function collectPplnsSharePayments(blockHexes, blockHeight, rewardTotal, addPayment, paymentData, portShares, shares4dump, getTotalPaid) {
        let firstShareTime;
        let lastShareTime;
        let txn = null;
        let cursor = null;
        try {
            txn = database.env.beginTxn({ readOnly: true });
            cursor = new database.lmdb.Cursor(txn, database.shareDB);
            for (let currentHeight = blockHeight; currentHeight > 0 && getTotalPaid() < rewardTotal; --currentHeight) {
                debug("Decrementing the block chain check height to:" + (currentHeight - 1));
                for (let found = cursor.goToRange(currentHeight) === currentHeight; found; found = cursor.goToNextDup()) {
                    cursor.getCurrentBinary(function (_key, data) {
                        let shareData;
                        try {
                            shareData = protos.Share.decode(data);
                        } catch (error) {
                            logError("PPLNS precalc", "share decode failed @ height " + currentHeight + ": " + formatError(error));
                            return;
                        }
                        if (shareData.poolType !== protos.POOLTYPE.PPLNS) return;
                        const userIdentifier = ensurePplnsPaymentRow(paymentData, shareData);
                        if (!firstShareTime) firstShareTime = shareData.timestamp;
                        if (getTotalPaid() < rewardTotal) lastShareTime = shareData.timestamp;

                        const amountToPay = shareData.shares2;
                        addPplnsSharePayments({ addPayment, shareData, shares4dump }, userIdentifier, amountToPay);

                        if (typeof shareData.port !== "undefined") {
                            portShares[shareData.port] = (portShares[shareData.port] || 0) + amountToPay;
                        }
                    });
                }
            }
        } finally {
            if (cursor) cursor.close();
            if (txn) txn.abort();
        }
        return { firstShareTime, lastShareTime };
    }

    async function preCalculatePPLNSPayments(blockHexes, blockHeight, blockDifficulty, isStoreDump) {
        const rewardTotal = 1.0;
        const windowPPLNS = blockDifficulty * config.pplns.shareMulti;
        let totalPaid = 0;
        let totalShares = 0;
        const paymentData = createPplnsPaymentData();
        const portShares = Object.create(null);
        const shares4dump = [];
        let firstShareTime;
        let lastShareTime;

        logInfo("PPLNS precalc", "start " + formatHashes(blockHexes) + " @ anchor " + blockHeight);

        function addPayment(key, amount) {
            if (amount === 0 || totalPaid >= rewardTotal) return;
            totalShares += amount;
            paymentData[key].amount += amount;
            const totalPaidAfter = totalShares / windowPPLNS * rewardTotal;
            if (totalPaidAfter > rewardTotal) {
                const extra = (totalPaidAfter - rewardTotal) / rewardTotal * windowPPLNS;
                paymentData[key].amount -= extra;
                totalPaid = rewardTotal;
                return;
            }
            totalPaid = totalPaidAfter;
        }

        const shareWindow = await collectPplnsSharePayments(blockHexes, blockHeight, rewardTotal, addPayment, paymentData, portShares, shares4dump, function getTotalPaid() {
            return totalPaid;
        });
        firstShareTime = shareWindow.firstShareTime;
        lastShareTime = shareWindow.lastShareTime;

        let totalPayments = 0;
        for (const key of Object.keys(paymentData)) totalPayments += paymentData[key].amount;

        if (totalPayments === 0) {
            logWarn("PPLNS precalc", "no shares for " + formatHashes(blockHexes) + " @ height " + blockHeight + "; retrying with top height");
            sendAdminTemplateEmail(
                "blockMgrNoSharesSubject",
                "blockMgrNoSharesBody",
                { block_hashes: formatHashes(blockHexes) },
                "FYI: No shares to pay block, so it was corrected by using the top height",
                "PPLNS payout cycle for %(block_hashes)s block does not have any shares so will be redone using top height"
            );
            const topBlockHeight = await getTopBlockHeight();
            if (topBlockHeight === null || topBlockHeight === blockHeight) return false;
            return preCalculatePPLNSPayments(blockHexes, topBlockHeight, blockDifficulty, isStoreDump);
        }

        let sumAllPorts = 0;
        for (const port of Object.keys(portShares)) sumAllPorts += portShares[port];
        const pplnsPortShares = Object.create(null);
        if (sumAllPorts > 0) {
            for (const port of Object.keys(portShares)) {
                pplnsPortShares[port] = portShares[port] / sumAllPorts;
            }
        }
        database.setCache("pplns_port_shares", pplnsPortShares);
        database.setCache("pplns_window_time", (firstShareTime - lastShareTime) / 1000);

        const dumpPromise = isStoreDump ? writeShareDump(blockHexes, shares4dump) : Promise.resolve();
        const defaultWindow = blockDifficulty * config.pplns.shareMulti;
        const isNeedCorrection = Math.abs(totalPayments / defaultWindow - 1) > 0.0001;
        const payWindow = isNeedCorrection ? totalPayments : defaultWindow;
        const rows = [];

        for (const key of Object.keys(paymentData)) {
            const payment = paymentData[key];
            if (!payment.amount) continue;
            const rowAmount = payment.amount / payWindow;
            for (const blockHex of blockHexes) {
                rows.push([blockHex, payment.payment_address, payment.payment_id, rowAmount]);
            }
        }

        const isOk = await replaceBlockBalanceRows(blockHexes, rows);
        await dumpPromise;

        logInfo("PPLNS precalc", "done " + formatHashes(blockHexes) + " @ anchor " + blockHeight +
            ", payout " + formatNumber(totalPayments / payWindow * 100) + "% (" +
            formatNumber(totalPayments) + " / " + formatNumber(payWindow) + ")");
        if (isNeedCorrection) {
            logWarn("PPLNS precalc", "corrected payout window for " + formatHashes(blockHexes) + " @ anchor " + blockHeight +
                ", raw payout " + formatNumber(totalPayments / defaultWindow * 100) + "% (" +
                formatNumber(totalPayments) + " / " + formatNumber(defaultWindow) + ")");
            sendAdminTemplateEmail(
                "blockMgrPayoutWindowSubject",
                "blockMgrPayoutWindowBody",
                {
                    block_height: blockHeight,
                    corrected_percent: (totalPayments / payWindow) * 100,
                    default_percent: (totalPayments / defaultWindow) * 100,
                    total_payments: totalPayments,
                    pay_window: payWindow,
                    default_window: defaultWindow
                },
                "Warning: Not enough shares to pay block correctly, so it was corrected by upscaling miner rewards!",
                "PPLNS payout cycle complete on block: %(block_height)s Payout Percentage: %(corrected_percent)s% (precisely %(total_payments)s / %(pay_window)s)\n" +
                "(This PPLNS payout cycle complete on block was corrected: %(block_height)s Payout Percentage: %(default_percent)s% (precisely %(total_payments)s / %(default_window)s))"
            );
        }
        return isOk;
    }

    async function doPPLNSPayments(blockHex, blockReward, blockPort, blockTimestamp) {
        logInfo("PPLNS payout", "start " + hashString(blockHex) + " on " + formatCoinPort(blockPort) + " value " + support.coinToDecimal(blockReward));
        let previousBalanceSum;
        try {
            previousBalanceSum = await getBalanceSum();
        } catch (error) {
            fullStop(error);
            return false;
        }

        const rows = await mysqlPool.query("SELECT payment_address, payment_id, amount FROM block_balance WHERE hex = ?", [blockHex]);
        if (!rows.length) {
            logError("PPLNS payout", "missing block_balance rows for " + hashString(blockHex));
            return false;
        }

        const credits = rows.map(function (row) {
            return {
                payment_address: row.payment_address,
                payment_id: normalizePaymentId(row.payment_id),
                pool_type: "pplns",
                amount: Math.floor(row.amount * blockReward)
            };
        }).filter(function (row) {
            return row.amount !== 0;
        });

        const balanceCredits = await resolveBalanceCredits(credits);
        const totalCredit = balanceCredits.reduce(function (sum, credit) {
            return sum + credit.amount;
        }, 0);
        if (totalCredit === 0) {
            fullStop("Total balance not changed from " + previousBalanceSum + " to " + previousBalanceSum);
            return false;
        }

        try {
            await withTransaction(async function (connection) {
                await connection.query(
                    "INSERT INTO paid_blocks (hex, amount, port, found_time) VALUES (?,?,?,?)",
                    [blockHex, blockReward, parseInt(blockPort, 10), support.formatDate(blockTimestamp)]
                );
                logInfo("PPLNS payout", "crediting " + rows.length + " recipients for " + hashString(blockHex));
                await applyBalanceCredits(connection, balanceCredits);
            });
        } catch (error) {
            logError("PPLNS payout", "transaction failed for " + hashString(blockHex) + ": " + formatError(error));
            return false;
        }

        let balanceSum;
        try {
            balanceSum = await getBalanceSum();
        } catch (error) {
            fullStop(error);
            return false;
        }
        if (String(balanceSum) !== String(previousBalanceSum)) {
            logInfo("PPLNS payout", "total balance " + support.coinToDecimal(previousBalanceSum) + " -> " + support.coinToDecimal(balanceSum));
            return true;
        }

        fullStop("Total balance not changed from " + previousBalanceSum + " to " + balanceSum);
        return false;
    }

    async function executePayout(block, reward, port, unlockLog, unlockFn) {
        if (state.paymentInProgress) {
            logError("Payout", "skip while another payout is active");
            return;
        }
        state.paymentInProgress = true;
        try {
            const isPaid = await doPPLNSPayments(block.hash, reward, port, block.timestamp);
            if (isPaid) {
                logInfo("Payout", unlockLog);
                unlockFn(block.hash);
            }
        } finally {
            state.paymentInProgress = false;
        }
    }

    function notifyBlockPaymentIssue(block) {
        sendAdminTemplateEmail(
            "blockMgrPaymentSubject",
            "blockMgrPaymentBody",
            { block_hash: hashString(block.hash) },
            "block_manager unable to make blockPayments",
            "The block_manager module has hit an issue making blockPayments with block %(block_hash)s"
        );
    }

    async function payCheckedBlock(block, header, reward, port, unlockLog, unlockFn, errorLog, shouldEmail, isValidHeader) {
        if (header.error === null && header.body && isValidHeader(header.body)) {
            await executePayout(block, reward, port, unlockLog, unlockFn);
            return true;
        }
        logError("Payout", errorLog);
        if (shouldEmail) notifyBlockPaymentIssue(block);
        return false;
    }

    function isAltblockOrphanResponse(body) {
        return !!(body && (body.topoheight === -1 || body.confirmations === -1 ||
            (body.error instanceof Object && body.error.message === "The requested hash could not be found.")));
    }

    async function payMainBlock(block) {
        return payCheckedBlock(
            block,
            await callCoin("getBlockHeaderByHash", block.hash),
            block.value,
            config.daemon.port,
            "unlocked main block @ " + block.height + " " + hashString(block.hash),
            function () { database.unlockBlock(block.hash); },
            "main header mismatch for " + hashString(block.hash),
            true,
            function (body) {
                return block.height === body.height && block.value === body.reward && block.difficulty === body.difficulty;
            }
        );
    }

    async function payAltBlock(block) {
        return payCheckedBlock(
            block,
            await callCoin("getPortBlockHeaderByHash", block.port, block.hash),
            block.pay_value,
            block.port,
            "unlocked " + formatCoinPort(block.port) + " block @ " + block.height + " " + hashString(block.hash),
            function () { database.unlockAltBlock(block.hash); },
            "alt header mismatch for " + formatCoinPort(block.port) + " " + hashString(block.hash),
            false,
            function (body) {
                return block.height === body.height && block.value >= body.reward;
            }
        );
    }

    async function preCalculateAndMark(blockHexes, blockHeight, blockDifficulty, isStoreDump, markReady) {
        for (const hex of blockHexes) {
            if (state.inFlightPrecalc.has(hex)) return;
        }
        for (const hex of blockHexes) state.inFlightPrecalc.add(hex);
        try {
            const status = await preCalculatePPLNSPayments(blockHexes, blockHeight, blockDifficulty, isStoreDump);
            if (status) markReady();
        } finally {
            for (const hex of blockHexes) state.inFlightPrecalc.delete(hex);
        }
    }

    async function runBlockUnlocker() {
        if (!canRun("Block unlocker", "block unlocks")) return;
        logInfo("Block unlocker", { status: "start" });
        const blockList = database.getValidLockedBlocks();
        const topBlockHeight = await getTopBlockHeight();
        if (topBlockHeight === null) return;

        for (const block of blockList) {
            if (topBlockHeight - block.height <= BLOCK_HASH_CONFIRM_DELAY) continue;
            if (block.poolType !== protos.POOLTYPE.PPLNS) {
                logError("Block unlocker", "skip legacy non-PPLNS row " + hashString(block.hash));
                continue;
            }
            const header = await callCoin("getBlockHeaderByID", block.height);
            if (header.error !== null) {
                logError("Block unlocker", "main header by height failed @ " + block.height);
                continue;
            }
            if (!header.body || header.body.hash !== block.hash) {
                database.invalidateBlock(block.height);
                logInfo("Block unlocker", "orphaned main block @ " + block.height);
                continue;
            }
            if (block.pay_ready !== true) {
                await preCalculateAndMark([block.hash], block.height, block.difficulty, true, function () {
                    logInfo("Block unlocker", "precalc ready for " + hashString(block.hash) + " @ " + block.height);
                    database.payReadyBlock(block.hash);
                });
                continue;
            }
            if (topBlockHeight - block.height > config.payout.blocksRequired) {
                await payMainBlock(block);
            }
        }
    }

    async function handleAltBlock(block, blockHeightWait, preCalcAnchorBlockHashes) {
        if (block.poolType !== protos.POOLTYPE.PPLNS) {
            logError("Altblock unlocker", "skip legacy non-PPLNS row " + hashString(block.hash));
            return;
        }
        if (block.pay_ready !== true) {
            if (block.value) {
                const anchorHeight = block.anchor_height - (block.anchor_height % config.payout.anchorRound);
                if (!(anchorHeight in preCalcAnchorBlockHashes)) preCalcAnchorBlockHashes[anchorHeight] = [];
                preCalcAnchorBlockHashes[anchorHeight].push(block.hash);
            } else {
                sendAdminTemplateEmail(
                    "blockMgrZeroValueSubject",
                    "blockMgrZeroValueBody",
                    { block_hash: hashString(block.hash) },
                    "FYI: block_manager saw zero value locked block",
                    "The block_manager module saw zero value locked block %(block_hash)s"
                );
            }
            return;
        }
        if (block.pay_value === 0) {
            if (!(block.port in blockHeightWait)) blockHeightWait[block.port] = [];
            blockHeightWait[block.port].push(block.height);
            return;
        }

        const header = await callCoin("getPortBlockHeaderByHash", block.port, block.hash);
        if (isAltblockOrphanResponse(header.body)) {
            database.invalidateAltBlock(block.id);
            logInfo("Altblock unlocker", "orphaned " + formatCoinPort(block.port) + " block @ " + block.height);
            return;
        }
        if (header.error !== null) {
            const profile = coinFuncs.getPoolProfile(block.port);
            if (profile && profile.rpc && profile.rpc.skipHashFallbackByHeight) return;
            logError("Altblock unlocker", "header by hash failed for " + formatCoinPort(block.port) + " @ " + block.height);
            const byHeight = await callCoin("getPortBlockHeaderByID", block.port, block.height);
            if (byHeight.error === null && byHeight.body && byHeight.body.hash !== block.hash) {
                database.invalidateAltBlock(block.id);
                logInfo("Altblock unlocker", "orphaned " + formatCoinPort(block.port) + " block @ " + block.height);
            }
            return;
        }
        await payAltBlock(block);
    }

    async function runAltblockUnlocker() {
        if (!canRun("Altblock unlocker", "altblock unlocks")) return;
        const blockList = database.getValidLockedAltBlocks();
        logInfo("Altblock unlocker", { status: "start", locked: blockList.length });
        const blockHeightWait = Object.create(null);
        const topBlockHeight = await getTopBlockHeight();
        if (topBlockHeight === null) return;
        const preCalcAnchorBlockHashes = Object.create(null);

        for (const block of blockList) {
            if (topBlockHeight - block.anchor_height <= ALTBLOCK_PRECALC_DELAY) continue;
            await handleAltBlock(block, blockHeightWait, preCalcAnchorBlockHashes);
        }

        logInfo("Altblock unlocker", {
            status: "precalc",
            anchor_heights: Object.keys(preCalcAnchorBlockHashes).length
        });
        let preCalcCount = 0;
        for (const anchorHeight of Object.keys(preCalcAnchorBlockHashes)) {
            if (preCalcCount >= MAX_ANCHOR_PRECALC_PER_CYCLE) break;
            preCalcCount += 1;
            const anchorHeader = await callCoin("getBlockHeaderByID", parseInt(anchorHeight, 10));
            if (anchorHeader.error !== null || !anchorHeader.body) {
                logError("Altblock unlocker", "anchor header failed @ " + anchorHeight);
                continue;
            }
            const blockHexes = preCalcAnchorBlockHashes[anchorHeight];
            await preCalculateAndMark(
                blockHexes,
                parseInt(anchorHeight, 10),
                anchorHeader.body.difficulty,
                true,
                function () {
                    logInfo("Altblock unlocker", "precalc ready for " + formatHashes(blockHexes) + " @ anchor " + anchorHeight);
                    for (const blockHex of blockHexes) database.payReadyAltBlock(blockHex);
                }
            );
        }

        if (Object.keys(blockHeightWait).length) {
            logInfo("Altblock unlocker", {
                status: "waiting pay_value",
                coins: formatAltWaitSummary(blockHeightWait)
            });
        }
    }

    async function runCycle() { await runBlockUnlocker(); await runAltblockUnlocker(); }

    function scheduleNextCycle(delayMs) {
        if (!state.started) return;
        state.timer = setTimeoutFn(async function () {
            state.timer = null;
            state.cyclePromise = runCycle();
            try {
                await state.cyclePromise;
            } catch (error) {
                logError("BlockManager", "cycle failed: " + formatError(error));
            } finally {
                state.cyclePromise = null;
                if (state.started) scheduleNextCycle(blockUnlockIntervalMs);
            }
        }, delayMs);
        if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    }

    return {
        start() {
            if (state.started) return this;
            state.started = true;
            scheduleNextCycle(0);
            return this;
        },
        async stop() {
            state.started = false;
            if (state.timer !== null) {
                clearTimeoutFn(state.timer);
                state.timer = null;
            }
            if (state.cyclePromise) {
                try {
                    await state.cyclePromise;
                } catch (_error) {}
            }
        },
        inspectState() {
            return { paymentInProgress: state.paymentInProgress, isFullStop: state.isFullStop, inFlightPrecalc: Array.from(state.inFlightPrecalc), started: state.started };
        },
        preCalculatePPLNSPayments, doPPLNSPayments, runBlockUnlocker, runAltblockUnlocker, runCycle
    };
}

module.exports = { createBlockManagerRuntime };
