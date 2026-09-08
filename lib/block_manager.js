"use strict";
const createTransactionRunner = require("./common/mysql_transaction.js");
const debug = require("debug")("blockManager");
const fs = require("fs");
const childProcess = require("child_process");
const { createConsoleLogger } = require("./common/logging");

const BLOCK_UNLOCK_INTERVAL_MS = 2 * 60 * 1000;
const BLOCK_HASH_CONFIRM_DELAY = 5; // blocks of depth before a main block's hash is trusted (reorg safety)
const ALTBLOCK_PRECALC_DELAY = 720; // anchor-chain depth (blocks) before precalculating altblock payouts
const MAX_ANCHOR_PRECALC_PER_CYCLE = 10;
const BALANCE_LOOKUP_CONCURRENCY = 24;
const BALANCE_UPDATE_BATCH_SIZE = 100;
const logger = createConsoleLogger(console, undefined);

/** @typedef {import("../types/runtime").SqlPool} SqlPool */
/** @typedef {import("../types/runtime").SqlConnection} SqlConnection */
/** @typedef {import("../types/runtime").DatabaseRuntime} DatabaseRuntime */
/** @typedef {import("../types/runtime").CoinRuntime} CoinRuntime */
/** @typedef {import("../types/runtime").SupportRuntime} SupportRuntime */
/** @typedef {import("../types/runtime").PoolConfig} PoolConfig */
/** @typedef {import("../types/runtime").ProtoTypes} ProtoTypes */
/** @typedef {import("../types/runtime").BlockHeader} BlockHeader */
/** @typedef {import("../types/runtime").BlockRecord} BlockRecord */
/** @typedef {import("../types/runtime").AltBlock} AltBlock */
/** @typedef {import("../types/runtime").Share} Share */
/** @typedef {{[key: string]: unknown}} UnknownRecord */
/** @typedef {{id: number|string}} BalanceRow */
/** @typedef {{insertId: number|string, affectedRows?: number}} SqlResult */
/** @typedef {{amt: number|string}} BalanceSumRow */
/** @typedef {{payment_address: string, payment_id: string|null, pool_type: string, amount: number}} PaymentRow */
/** @typedef {{id: number|string, amount: number}} BalanceCredit */
/** @typedef {{[key: string]: PaymentRow}} PaymentData */
/** @typedef {{[key: string]: number[]}} BlockHeightWait */
/** @typedef {{[key: string]: string[]}} BlockHashByAnchor */
/** @typedef {{[key: string]: number}} NumberByPort */
/** @typedef {{addPayment: (key: string, amount: number) => void, shareData: Share, shares4dump: string[]}} PplnsShareContext */
/** @typedef {{firstShareTime: number|undefined, lastShareTime: number|undefined}} ShareWindow */
/** @typedef {{head: {key: string|number|Buffer, hash: string}|null, totals: {global: number, pplns: number}}} BlockState */
/** @typedef {{head: {key: string|number|Buffer, hash: string}|null, totals: {global: number, pplns: number}, portTotals: {global: NumberByPort, pplns: NumberByPort}}} AltBlockState */
/** @typedef {{started: boolean, timer: NodeJS.Timeout|null, cyclePromise: Promise<void>|null, paymentInProgress: boolean, isFullStop: boolean, balanceIdCache: {[key: string]: number|string}, pendingBalanceLookups: Map<string, Promise<number|string>>, inFlightPrecalc: Set<string>}} BlockManagerState */
/** @typedef {{error: Error|string|boolean|null, body?: BlockHeader}} CoinReply */
/** @typedef {"getLastBlockHeader"|"getBlockHeaderByID"|"getBlockHeaderByHash"|"getPortBlockHeaderByID"|"getPortBlockHeaderByHash"} CoinMethod */
/** @typedef {{mysql?: SqlPool, database?: DatabaseRuntime, coinFuncs?: CoinRuntime, support?: SupportRuntime, config?: PoolConfig, protos?: ProtoTypes, fs?: typeof fs, childProcess?: typeof childProcess, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, blockUnlockIntervalMs?: number, balanceLookupConcurrency?: number}} BlockManagerOptions */

/** @param {unknown} value @returns {value is UnknownRecord} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} error @returns {string} */
function formatError(error) {
    if (isRecord(error) && typeof error["message"] === "string") return error["message"];
    return String(error);
}

/** @param {unknown} hash @returns {string} */
function hashString(hash) {
    if (typeof hash === "string") return hash;
    if (Buffer.isBuffer(hash)) return hash.toString("hex");
    if (isRecord(hash) && typeof hash.toString === "function") return hash.toString();
    return String(hash);
}

/** @param {unknown} paymentId @returns {string|null} */
function normalizePaymentId(paymentId) {
    return typeof paymentId === "string" && paymentId.length > 10 ? paymentId : null;
}

/** @param {number} value @returns {string} */
function formatNumber(value) { return Number.isFinite(value) ? value.toFixed(6).replace(/\.?0+$/, "") : String(value); }

/** @param {BlockManagerOptions|undefined} options */
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
    /** @type {BlockManagerState} */
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
    const withTransaction = createTransactionRunner(
        mysqlPool,
        "MySQL pool does not support block_manager transactions"
    );

    /** @param {string} paymentAddress @param {string} poolType @param {string|null} paymentId @returns {string} */
    function cacheKey(paymentAddress, poolType, paymentId) { return `${paymentAddress  }|${  poolType  }|${  paymentId === null ? "" : paymentId}`; }
    /** @param {string} scope @param {string|UnknownRecord} fields @returns {void} */
    function logInfo(scope, fields) { logger.logInfo(scope, typeof fields === "string" ? { status: fields } : fields); }
    /** @param {string} scope @param {string|UnknownRecord} fields @returns {void} */
    function logWarn(scope, fields) { logger.logWarn(scope, typeof fields === "string" ? { status: fields } : fields); }
    /** @param {string} scope @param {string|UnknownRecord} fields @returns {void} */
    function logError(scope, fields) { logger.logError(scope, typeof fields === "string" ? { status: fields } : fields); }
    /** @param {number|string} port @returns {string} */
    function formatCoinPort(port) { return `${coinFuncs.PORT2COIN_FULL(port)  }/${  port}`; }
    /** @param {Array<unknown>} blockHexes @returns {string} */
    function formatHashes(blockHexes) { return blockHexes.map(hashString).join(", "); }
    /** @param {string} item @param {UnknownRecord} values @param {string} fallback @returns {string} */
    function renderEmailTemplate(item, values, fallback) {
        if (support && typeof support.renderEmailTemplate === "function") return support.renderEmailTemplate(item, values, fallback);
        const template = config && config.email && typeof config.email[item] === "string" ? config.email[item] : fallback;
        return support && typeof support.formatTemplate === "function"
            ? support.formatTemplate(template || "", values || {})
            : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
                return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
            });
    }
    /** @param {string} subjectItem @param {string} bodyItem @param {UnknownRecord} values @param {string} subjectFallback @param {string} bodyFallback @returns {void} */
    function sendAdminTemplateEmail(subjectItem, bodyItem, values, subjectFallback, bodyFallback) {
        const subject = renderEmailTemplate(subjectItem, values || {}, subjectFallback);
        const body = renderEmailTemplate(bodyItem, values || {}, bodyFallback);
        if (subject.indexOf("FYI:") === 0 && typeof support.sendFyi === "function") {
            support.sendFyi(config.general.adminEmail, `block_manager:${  subjectItem}`, subject, body);
            return;
        }
        support.sendEmail(config.general.adminEmail, subject, body);
    }
    /** @param {BlockHeightWait} blockHeightWait @returns {string} */
    function formatAltWaitSummary(blockHeightWait) {
        return Object.keys(blockHeightWait).sort(function (left, right) { return parseInt(left, 10) - parseInt(right, 10); })
            .map(function (port) {
                const heights = blockHeightWait[port];
                return heights ? `${formatCoinPort(port)  } x${  heights.length}` : "";
            }).filter(Boolean).join(", ");
    }

    /** @param {unknown} error @returns {void} */
    function fullStop(error) {
        const message = formatError(error);
        state.isFullStop = true;
        logError("Payout", `full stop on balance credit issue: ${  message  }; balance credits disabled until restart`);
        sendAdminTemplateEmail(
            "blockMgrBalanceSubject",
            "blockMgrBalanceBody",
            { message },
            "block_manager unable to make balance increase",
            "The block_manager module has hit an issue making a balance increase: %(message)s.  Please investigate and restart block_manager as appropriate"
        );
    }

    /**
     * Keep the small dynamic dispatch here so every RPC callback is normalized
     * to the same error-first result before the unlocker logic consumes it.
     *
     * @param {CoinMethod} methodName
     * @param {...(number|string|Buffer)} args
     * @returns {Promise<CoinReply>}
     */
    function callCoin(methodName, ...args) {
        return new Promise(function (resolve) {
            /** @param {Error|string|boolean|null} error @param {BlockHeader} [body] */
            const callback = function (error, body) {
                if (typeof body === "undefined") resolve({ error });
                else resolve({ error, body });
            };
            if (methodName === "getLastBlockHeader") {
                coinFuncs.getLastBlockHeader(callback, true);
                return;
            }
            if (methodName === "getBlockHeaderByID") {
                const blockId = args[0];
                if (typeof blockId !== "number" && typeof blockId !== "string") throw new TypeError("block id is required");
                coinFuncs.getBlockHeaderByID(blockId, callback, true);
                return;
            }
            if (methodName === "getBlockHeaderByHash") {
                const hash = args[0];
                if (typeof hash !== "string" && !Buffer.isBuffer(hash)) throw new TypeError("block hash is required");
                coinFuncs.getBlockHeaderByHash(hash, callback, true);
                return;
            }
            const port = args[0];
            const value = args[1];
            if (typeof port !== "number") throw new TypeError("coin port is required");
            if (methodName === "getPortBlockHeaderByID") {
                if (typeof value !== "number" && typeof value !== "string") throw new TypeError("block id is required");
                coinFuncs.getPortBlockHeaderByID(port, value, callback, true);
                return;
            }
            if (typeof value !== "string" && !Buffer.isBuffer(value)) throw new TypeError("block hash is required");
            coinFuncs.getPortBlockHeaderByHash(port, value, callback, true);
        });
    }

    /** @param {string} cycleName @param {string} dropName @returns {boolean} */
    function canRun(cycleName, dropName) {
        if (state.isFullStop) {
            debug(`Dropping all ${  dropName}`);
            return false;
        }
        if (state.paymentInProgress) {
            logError(cycleName, "skip while payout is active");
            return false;
        }
        return true;
    }

    /** @returns {Promise<number|null>} */
    async function getTopBlockHeight() {
        const latest = await callCoin("getLastBlockHeader");
        const rawHeight = latest.body && latest.body["height"];
        const height = (typeof rawHeight === "number" || typeof rawHeight === "string") && String(rawHeight).trim() !== ""
            ? Number(rawHeight)
            : NaN;
        if (latest.error !== null || !Number.isSafeInteger(height) || height < 0) {
            logError("Top block", "header request failed");
            return null;
        }
        return height;
    }

    /** @param {PaymentRow} payment @returns {Promise<number|string>} */
    async function getOrCreateBalanceId(payment) {
        const paymentId = normalizePaymentId(payment.payment_id);
        const poolType = payment.pool_type;
        const key = cacheKey(payment.payment_address, poolType, paymentId);
        /** @param {SqlPool|SqlConnection} executor @returns {Promise<BalanceRow[]>} */
        async function loadRows(executor) {
            /** @type {Promise<BalanceRow[]>} */
            const rowsPromise = executor.query(
                paymentId === null
                    ? "SELECT id FROM balance WHERE payment_address = ? AND payment_id IS NULL AND pool_type = ?"
                    : "SELECT id FROM balance WHERE payment_address = ? AND payment_id = ? AND pool_type = ?",
                paymentId === null ? [payment.payment_address, poolType] : [payment.payment_address, paymentId, poolType]
            );
            return rowsPromise;
        }
        const cachedId = state.balanceIdCache[key];
        if (typeof cachedId !== "undefined") return cachedId;
        const pendingLookup = state.pendingBalanceLookups.get(key);
        if (pendingLookup) return pendingLookup;

        const lookupPromise = (async function () {
            let rows = await loadRows(mysqlPool);
            if (rows.length > 1) {
                const error = `Multiple balance rows found for ${  payment.payment_address  } / ${  poolType}`;
                fullStop(error);
                throw new Error(error);
            }
            if (rows.length === 0) {
                try {
                    /** @type {SqlResult} */
                    const result = await mysqlPool.query(
                        "INSERT INTO balance (payment_address, payment_id, pool_type) VALUES (?, ?, ?)",
                        [payment.payment_address, paymentId, poolType]
                    );
                    state.balanceIdCache[key] = result.insertId;
                    debug(`Added to the SQL database: ${  result.insertId}`);
                    return result.insertId;
                } catch (error) {
                    const code = isRecord(error) ? error["code"] : undefined;
                    const message = isRecord(error) ? error["message"] : undefined;
                    if (code !== "ER_DUP_ENTRY" && String(message || error).indexOf("Duplicate entry") === -1) {
                        throw error;
                    }
                    rows = await loadRows(mysqlPool);
                }
            }
            if (rows.length !== 1) {
                const error = `Unable to resolve balance row for ${  payment.payment_address  } / ${  poolType}`;
                fullStop(error);
                throw new Error(error);
            }
            const row = rows[0];
            if (!row) throw new Error("Unable to resolve balance row after lookup");
            state.balanceIdCache[key] = row.id;
            debug(`Found it in MySQL: ${  row.id}`);
            return row.id;
        })();

        state.pendingBalanceLookups.set(key, lookupPromise);
        try {
            return await lookupPromise;
        } finally {
            state.pendingBalanceLookups.delete(key);
        }
    }

    /** @param {PaymentRow[]} credits @returns {Promise<BalanceCredit[]>} */
    async function resolveBalanceCredits(credits) {
        if (!credits.length) return [];
        /** @type {Array<BalanceCredit|undefined>} */
        const resolved = new Array(credits.length);
        let nextIndex = 0;
        await Promise.all(Array.from({ length: Math.min(balanceLookupConcurrency, credits.length) }, async function () {
            while (nextIndex < credits.length) {
                const index = nextIndex++;
                const payment = credits[index];
                if (!payment) continue;
                resolved[index] = { id: await getOrCreateBalanceId(payment), amount: payment.amount };
            }
        }));
        /** @type {Map<number|string, number>} */
        const aggregated = new Map();
        for (const credit of resolved) {
            if (!credit) continue;
            if (!credit.amount) continue;
            aggregated.set(credit.id, (aggregated.get(credit.id) || 0) + credit.amount);
        }
        return Array.from(aggregated, function (entry) {
            return { id: entry[0], amount: entry[1] };
        });
    }

    /** @param {SqlConnection} connection @param {BalanceCredit[]} credits @returns {Promise<number>} */
    async function applyBalanceCredits(connection, credits) {
        let total = 0;
        for (let index = 0; index < credits.length; index += BALANCE_UPDATE_BATCH_SIZE) {
            const batch = credits.slice(index, index + BALANCE_UPDATE_BATCH_SIZE);
            if (!batch.length) continue;
            /** @type {string[]} */
            const whenClauses = [];
            /** @type {Array<number|string>} */
            const ids = [];
            /** @type {import("../types/runtime").SqlParam[]} */
            const params = [];
            for (const credit of batch) {
                total += credit.amount;
                whenClauses.push("WHEN ? THEN ?");
                params.push(credit.id, credit.amount);
                ids.push(credit.id);
            }
            params.push(...ids);
            const sql = `UPDATE balance SET amount = amount + CASE id ${  whenClauses.join(" ") 
                } ELSE 0 END WHERE id IN (${  ids.map(function () { return "?"; }).join(",")  })`;
            /** @type {SqlResult} */
            const result = await connection.query(sql, params);
            if (!result || result.affectedRows !== ids.length) {
                // The paid_blocks insert and balance updates share this transaction. Abort on any
                // mismatch so a partial credit can never be recorded as a completed payout.
                const affectedRows = result && typeof result.affectedRows === "number" ? result.affectedRows : "unknown";
                throw new Error(`balance update affected ${  affectedRows  } of ${  ids.length  } rows`);
            }
        }
        return total;
    }

    /** @returns {Promise<number|string>} */
    async function getBalanceSum() {
        /** @type {BalanceSumRow[]} */
        const rows = await mysqlPool.query("SELECT SUM(amount) as amt FROM balance");
        if (!rows[0] || (typeof rows[0].amt !== "number" && typeof rows[0].amt !== "string")) {
            throw new Error("SELECT SUM(amount) as amt FROM balance query returned an invalid result");
        }
        return rows[0].amt;
    }

    /** @param {string[]} blockHexes @param {Array<[string, string, string|null, number]>} rows @returns {Promise<boolean>} */
    async function replaceBlockBalanceRows(blockHexes, rows) {
        try {
            await mysqlPool.query("DELETE FROM block_balance WHERE hex IN (?)", [blockHexes]);
            if (!rows.length) return true;
            /** @type {SqlResult} */
            const result = await mysqlPool.query(
                "INSERT INTO block_balance (hex, payment_address, payment_id, amount) VALUES ?",
                [rows]
            );
            if (!result || typeof result.affectedRows !== "number" || result.affectedRows < rows.length) {
                logError("PPLNS precalc", `block_balance insert failed for ${  formatHashes(blockHexes)  }: ${  JSON.stringify(result)}`);
                return false;
            }
            return true;
        } catch (error) {
            logError("PPLNS precalc", `block_balance write failed for ${  formatHashes(blockHexes)  }: ${  formatError(error)}`);
            return false;
        }
    }

    /** @param {unknown} hash @returns {boolean} */
    function isCanonicalBlockHex(hash) {
        return typeof hash === "string" && /^[0-9a-fA-F]{64}$/.test(hash);
    }

    /** @param {string[]} blockHexes @param {string[]} shares4dump @returns {Promise<void>} */
    async function writeShareDump(blockHexes, shares4dump) {
        if (!shares4dump.length || !fsApi.existsSync("./block_share_dumps/process.sh")) return;
        if (!blockHexes.length || blockHexes.some(function (blockHex) { return !isCanonicalBlockHex(blockHex); })) {
            logError("Share dump", `skipping dump due to non-canonical block hash in ${  formatHashes(blockHexes)}`);
            return;
        }
        shares4dump.sort();
        shares4dump.unshift("#last_16_chars_of_xmr_address\ttimestamp\traw_share_diff\tshare_count\tshare_coin\txmr_share_diff\txmr_share_diff_paid");
        const filename = `block_share_dumps/${  blockHexes[0]  }.cvs`;
        try {
            /** @type {Promise<void>} */
            const writePromise = new Promise(function (resolve, reject) {
                fsApi.writeFile(filename, shares4dump.join("\n"), function (error) {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
            await writePromise;
        } catch (_error) {
            logError("Share dump", `write failed for ${  filename}`);
            return;
        }
        const files = blockHexes.map(function (blockHex) {
            return `block_share_dumps/${  blockHex  }.cvs`;
        });
        /** @type {Promise<void>} */
        const processPromise = new Promise(function (resolve) {
            childProcessApi.execFile("./block_share_dumps/process.sh", files, function (error) {
                if (error) {
                    logError("Share dump", `process.sh failed for ${  formatHashes(blockHexes)  } with exit ${  error.code}`);
                } else {
                    logInfo("Share dump", `complete for ${  formatHashes(blockHexes)}`);
                }
                resolve();
            });
        });
        await processPromise;
    }

    /** @returns {PaymentData} */
    function createPplnsPaymentData() {
        /** @type {PaymentData} */
        const paymentData = Object.assign(Object.create(null), {
            [config.payout.feeAddress]: { pool_type: "fees", payment_address: config.payout.feeAddress, payment_id: null, amount: 0 },
            [coinFuncs.coinDevAddress]: { pool_type: "fees", payment_address: coinFuncs.coinDevAddress, payment_id: null, amount: 0 },
            [coinFuncs.poolDevAddress]: { pool_type: "fees", payment_address: coinFuncs.poolDevAddress, payment_id: null, amount: 0 }
        });
        return paymentData;
    }

    /** @param {PaymentData} paymentData @param {Share} shareData @returns {string} */
    function ensurePplnsPaymentRow(paymentData, shareData) {
        const paymentId = typeof shareData.paymentID === "undefined" ? null : shareData.paymentID;
        const userIdentifier = paymentId ? `${shareData.paymentAddress  }.${  paymentId}` : shareData.paymentAddress;
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

    /** @param {string[]} shares4dump @param {string} userIdentifier @param {Share} shareData @param {number} amountToPay @param {number} amountToPayAfterFees @returns {void} */
    function appendPplnsDumpRow(shares4dump, userIdentifier, shareData, amountToPay, amountToPayAfterFees) {
        const sharePort = typeof shareData.port === "number" ? coinFuncs.PORT2COIN_FULL(shareData.port) : "unknown";
        shares4dump.push(
            `${userIdentifier.slice(-16)  }\t${
            shareData.timestamp.toString(16)  }\t${
            shareData.raw_shares  }\t${
            shareData.share_num  }\t${
            sharePort  }\t${
            amountToPay  }\t${ 
            amountToPay === amountToPayAfterFees ? "" : amountToPayAfterFees}`
        );
    }

    /** @param {PplnsShareContext} context @param {string} userIdentifier @param {number} amountToPay @returns {void} */
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

    /**
     * @param {number} blockHeight
     * @param {number} rewardTotal
     * @param {(key: string, amount: number) => void} addPayment
     * @param {PaymentData} paymentData
     * @param {NumberByPort} portShares
     * @param {string[]} shares4dump
     * @param {() => number} getTotalPaid
     * @returns {Promise<ShareWindow>}
     */
    async function collectPplnsSharePayments(blockHeight, rewardTotal, addPayment, paymentData, portShares, shares4dump, getTotalPaid) {
        /** @type {number|undefined} */
        let firstShareTime;
        /** @type {number|undefined} */
        let lastShareTime;
        /** @type {import("../types/runtime").LmdbTxn|null} */
        let txn = null;
        /** @type {import("../types/runtime").LmdbCursor|null} */
        let cursor = null;
        try {
            // One read txn is intentionally held for the whole scan so the PPLNS payout is
            // summed against a single consistent snapshot. Do NOT chunk this or release the txn
            // mid-scan to "reduce snapshot pinning": a concurrent cleanShareDB could delete
            // shares between chunks before they are counted, undercounting the window and paying
            // miners incorrectly. The scan is synchronous and bounded by the PPLNS window
            // (getTotalPaid() < rewardTotal); the transient page-pin is the cost of correctness.
            txn = database.env.beginTxn({ readOnly: true });
            cursor = new database.lmdb.Cursor(txn, database.shareDB);
            for (let currentHeight = blockHeight; currentHeight > 0 && getTotalPaid() < rewardTotal; --currentHeight) {
                debug(`Decrementing the block chain check height to:${  currentHeight - 1}`);
                for (let found = cursor.goToRange(currentHeight); found === currentHeight; found = cursor.goToNextDup()) {
                    cursor.getCurrentBinary(function (_key, data) {
                        /** @type {Share} */
                        let shareData;
                        try {
                            shareData = protos.Share.decode(data);
                        } catch (error) {
                            logError("PPLNS precalc", `share decode failed @ height ${  currentHeight  }: ${  formatError(error)}`);
                            return;
                        }
                        if (shareData.poolType !== protos.POOLTYPE.PPLNS) return;
                        const userIdentifier = ensurePplnsPaymentRow(paymentData, shareData);
                        const amountToPay = shareData.shares2;
                        if (typeof amountToPay !== "number" || !Number.isFinite(amountToPay) || amountToPay <= 0) return;
                        if (firstShareTime === undefined) firstShareTime = shareData.timestamp;
                        if (getTotalPaid() < rewardTotal) lastShareTime = shareData.timestamp;
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

    /** @param {string[]} blockHexes @param {number} blockHeight @param {number} blockDifficulty @param {boolean} isStoreDump @returns {Promise<boolean>} */
    async function preCalculatePPLNSPayments(blockHexes, blockHeight, blockDifficulty, isStoreDump) {
        const rewardTotal = 1.0;
        const windowPPLNS = blockDifficulty * config.pplns.shareMulti;
        let totalPaid = 0;
        let totalShares = 0;
        const paymentData = createPplnsPaymentData();
        /** @type {NumberByPort} */
        const portShares = Object.create(null);
        /** @type {string[]} */
        const shares4dump = [];

        logInfo("PPLNS precalc", `start ${  formatHashes(blockHexes)  } @ anchor ${  blockHeight}`);

        /** @param {string} key @param {number} amount @returns {void} */
        function addPayment(key, amount) {
            if (amount === 0 || totalPaid >= rewardTotal) return;
            totalShares += amount;
            const payment = paymentData[key];
            if (!payment) throw new Error(`Missing payment row for ${  key}`);
            payment.amount += amount;
            const totalPaidAfter = totalShares / windowPPLNS * rewardTotal;
            if (totalPaidAfter > rewardTotal) {
                // This share crosses the window edge: trim its overshoot so cumulative payout caps at the full reward.
                const extra = (totalPaidAfter - rewardTotal) / rewardTotal * windowPPLNS;
                payment.amount -= extra;
                totalPaid = rewardTotal;
                return;
            }
            totalPaid = totalPaidAfter;
        }

        const shareWindow = await collectPplnsSharePayments(blockHeight, rewardTotal, addPayment, paymentData, portShares, shares4dump, function getTotalPaid() {
            return totalPaid;
        });
        const firstShareTime = shareWindow.firstShareTime;
        const lastShareTime = shareWindow.lastShareTime;

        let totalPayments = 0;
        for (const key of Object.keys(paymentData)) {
            const payment = paymentData[key];
            if (payment) totalPayments += payment.amount;
        }

        if (totalPayments === 0) {
            logWarn("PPLNS precalc", `no shares for ${  formatHashes(blockHexes)  } @ height ${  blockHeight  }; retrying with top height`);
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

        if (firstShareTime === undefined || lastShareTime === undefined) {
            logError("PPLNS precalc", `share timestamps missing for ${  formatHashes(blockHexes)  } @ height ${  blockHeight}`);
            return false;
        }

        let sumAllPorts = 0;
        for (const port of Object.keys(portShares)) {
            const portShare = portShares[port];
            if (typeof portShare === "number") sumAllPorts += portShare;
        }
        /** @type {NumberByPort} */
        const pplnsPortShares = Object.create(null);
        if (sumAllPorts > 0) {
            for (const port of Object.keys(portShares)) {
                const portShare = portShares[port];
                if (typeof portShare === "number") pplnsPortShares[port] = portShare / sumAllPorts;
            }
        }
        database.setCache("pplns_port_shares", pplnsPortShares);
        // Shares are walked newest-first, so firstShareTime is newest and lastShareTime oldest; the span is positive.
        database.setCache("pplns_window_time", (firstShareTime - lastShareTime) / 1000);

        const dumpPromise = isStoreDump ? writeShareDump(blockHexes, shares4dump) : Promise.resolve();
        const defaultWindow = blockDifficulty * config.pplns.shareMulti;
        const isNeedCorrection = Math.abs(totalPayments / defaultWindow - 1) > 0.0001;
        const payWindow = isNeedCorrection ? totalPayments : defaultWindow;
        /** @type {Array<[string, string, string|null, number]>} */
        const rows = [];

        for (const key of Object.keys(paymentData)) {
            const payment = paymentData[key];
            if (!payment) continue;
            if (!payment.amount) continue;
            const rowAmount = payment.amount / payWindow;
            for (const blockHex of blockHexes) {
                rows.push([blockHex, payment.payment_address, payment.payment_id, rowAmount]);
            }
        }

        const isOk = await replaceBlockBalanceRows(blockHexes, rows);
        await dumpPromise;

        logInfo("PPLNS precalc", `done ${  formatHashes(blockHexes)  } @ anchor ${  blockHeight 
            }, payout ${  formatNumber(totalPayments / payWindow * 100)  }% (${ 
            formatNumber(totalPayments)  } / ${  formatNumber(payWindow)  })`);
        if (isNeedCorrection) {
            logWarn("PPLNS precalc", `corrected payout window for ${  formatHashes(blockHexes)  } @ anchor ${  blockHeight 
                }, raw payout ${  formatNumber(totalPayments / defaultWindow * 100)  }% (${ 
                formatNumber(totalPayments)  } / ${  formatNumber(defaultWindow)  })`);
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

    /** @param {string|Buffer} blockHex @param {number} blockReward @param {number|string} blockPort @param {number} blockTimestamp @returns {Promise<boolean>} */
    async function doPPLNSPayments(blockHex, blockReward, blockPort, blockTimestamp) {
        logInfo("PPLNS payout", `start ${  hashString(blockHex)  } on ${  formatCoinPort(blockPort)  } value ${  support.coinToDecimal(blockReward)}`);
        let previousBalanceSum;
        try {
            previousBalanceSum = await getBalanceSum();
        } catch (error) {
            fullStop(error);
            return false;
        }

        /** @type {Array<{payment_address: string, payment_id: string|null, amount: number}>} */
        const rows = await mysqlPool.query("SELECT payment_address, payment_id, amount FROM block_balance WHERE hex = ?", [blockHex]);
        if (!rows.length) {
            logError("PPLNS payout", `missing block_balance rows for ${  hashString(blockHex)}`);
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
            fullStop(`Total balance not changed from ${  previousBalanceSum  } to ${  previousBalanceSum}`);
            return false;
        }

        try {
            await withTransaction(async function (connection) {
                await connection.query(
                    "INSERT INTO paid_blocks (hex, amount, port, found_time) VALUES (?,?,?,?)",
                    [blockHex, blockReward, Number.parseInt(String(blockPort), 10), support.formatDate(blockTimestamp)]
                );
                logInfo("PPLNS payout", `crediting ${  rows.length  } recipients for ${  hashString(blockHex)}`);
                await applyBalanceCredits(connection, balanceCredits);
            });
        } catch (error) {
            logError("PPLNS payout", `transaction failed for ${  hashString(blockHex)  }: ${  formatError(error)}`);
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
            logInfo("PPLNS payout", `total balance ${  support.coinToDecimal(previousBalanceSum)  } -> ${  support.coinToDecimal(balanceSum)}`);
            return true;
        }

        fullStop(`Total balance not changed from ${  previousBalanceSum  } to ${  balanceSum}`);
        return false;
    }

    /** @param {BlockRecord|AltBlock} block @param {number} reward @param {number|string} port @param {string} unlockLog @param {(hash: string) => void} unlockFn @returns {Promise<void>} */
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

    /** @param {BlockRecord|AltBlock} block @returns {void} */
    function notifyBlockPaymentIssue(block) {
        sendAdminTemplateEmail(
            "blockMgrPaymentSubject",
            "blockMgrPaymentBody",
            { block_hash: hashString(block.hash) },
            "block_manager unable to make blockPayments",
            "The block_manager module has hit an issue making blockPayments with block %(block_hash)s"
        );
    }

    /** @param {BlockRecord|AltBlock} block @param {CoinReply} header @param {number} reward @param {number|string} port @param {string} unlockLog @param {() => void} unlockFn @param {string} errorLog @param {boolean} shouldEmail @param {(body: BlockHeader) => boolean} isValidHeader @returns {Promise<boolean>} */
    async function payCheckedBlock(block, header, reward, port, unlockLog, unlockFn, errorLog, shouldEmail, isValidHeader) {
        if (header.error === null && header.body && isValidHeader(header.body)) {
            await executePayout(block, reward, port, unlockLog, unlockFn);
            return true;
        }
        logError("Payout", errorLog);
        if (shouldEmail) notifyBlockPaymentIssue(block);
        return false;
    }

    /** @param {unknown} body @returns {boolean} */
    function isAltblockOrphanResponse(body) {
        // orphan_status===true is how cryptonote daemons (monerod et al) flag a found block that was
        // orphaned: get_block_header_by_hash returns the alt block non-null with orphan_status=true
        // (verified against the live XMR daemon; a valid main-chain block returns orphan_status=false).
        // Without this, an orphaned cryptonote altblock passes the orphan check and is paid.
        return Boolean(isRecord(body) && (body["orphan_status"] === true || body["topoheight"] === -1 || body["confirmations"] === -1 ||
            (isRecord(body["error"]) && body["error"]["message"] === "The requested hash could not be found.")));
    }

    /** @param {BlockRecord} block @returns {Promise<boolean>} */
    async function payMainBlock(block) {
        if (typeof block.value !== "number") {
            logError("Payout", `main block has no reward ${  hashString(block.hash)}`);
            return false;
        }
        return payCheckedBlock(
            block,
            await callCoin("getBlockHeaderByHash", block.hash),
            block.value,
            config.daemon.port,
            `unlocked main block @ ${  block.height  } ${  hashString(block.hash)}`,
            function () { database.unlockBlock(block.hash); },
            `main header mismatch for ${  hashString(block.hash)}`,
            true,
            function (body) {
                return block.height === body.height && block.value === body.reward && block.difficulty === body.difficulty;
            }
        );
    }

    /** @param {AltBlock} block @returns {Promise<boolean>} */
    async function payAltBlock(block) {
        if (typeof block.pay_value !== "number") {
            logError("Payout", `alt block has no pay value ${  hashString(block.hash)}`);
            return false;
        }
        return payCheckedBlock(
            block,
            await callCoin("getPortBlockHeaderByHash", block.port, block.hash),
            block.pay_value,
            block.port,
            `unlocked ${  formatCoinPort(block.port)  } block @ ${  block.height  } ${  hashString(block.hash)}`,
            function () { database.unlockAltBlock(block.hash); },
            `alt header mismatch for ${  formatCoinPort(block.port)  } ${  hashString(block.hash)}`,
            false,
            function (body) {
                return typeof body.reward === "number" && typeof block.value === "number" && block.height === body.height && block.value >= body.reward;
            }
        );
    }

    /** @param {string[]} blockHexes @param {number} blockHeight @param {number} blockDifficulty @param {boolean} isStoreDump @param {() => void} markReady @returns {Promise<void>} */
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

    /** @returns {Promise<void>} */
    async function runBlockUnlocker() {
        if (!canRun("Block unlocker", "block unlocks")) return;
        logInfo("Block unlocker", { status: "start" });
        const blockList = database.getValidLockedBlocks();
        const topBlockHeight = await getTopBlockHeight();
        if (topBlockHeight === null) return;

        for (const block of blockList) {
            if (topBlockHeight - block.height <= BLOCK_HASH_CONFIRM_DELAY) continue;
            if (block.poolType !== protos.POOLTYPE.PPLNS) {
                logError("Block unlocker", `skip legacy non-PPLNS row ${  hashString(block.hash)}`);
                continue;
            }
            const header = await callCoin("getBlockHeaderByID", block.height);
            if (header.error !== null) {
                logError("Block unlocker", `main header by height failed @ ${  block.height}`);
                continue;
            }
            if (!header.body || header.body.hash !== block.hash) {
                database.invalidateBlock(block.height);
                logInfo("Block unlocker", `orphaned main block @ ${  block.height}`);
                continue;
            }
            if (block.pay_ready !== true) {
                await preCalculateAndMark([block.hash], block.height, block.difficulty, true, function () {
                    logInfo("Block unlocker", `precalc ready for ${  hashString(block.hash)  } @ ${  block.height}`);
                    database.payReadyBlock(block.hash);
                });
                continue;
            }
            if (topBlockHeight - block.height > config.payout.blocksRequired) {
                await payMainBlock(block);
            }
        }
    }

    /** @param {AltBlock} block @param {BlockHeightWait} blockHeightWait @param {BlockHashByAnchor} preCalcAnchorBlockHashes @returns {Promise<void>} */
    async function handleAltBlock(block, blockHeightWait, preCalcAnchorBlockHashes) {
        if (block.poolType !== protos.POOLTYPE.PPLNS) {
            logError("Altblock unlocker", `skip legacy non-PPLNS row ${  hashString(block.hash)}`);
            return;
        }
        if (block.pay_ready !== true) {
            if (block.value) {
                const anchorHeight = block.anchor_height - (block.anchor_height % config.payout.anchorRound);
                if (!(anchorHeight in preCalcAnchorBlockHashes)) preCalcAnchorBlockHashes[anchorHeight] = [];
                const hashes = preCalcAnchorBlockHashes[anchorHeight];
                if (hashes) hashes.push(block.hash);
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
            const heights = blockHeightWait[block.port];
            if (heights) heights.push(block.height);
            return;
        }

        const header = await callCoin("getPortBlockHeaderByHash", block.port, block.hash);
        if (isAltblockOrphanResponse(header.body)) {
            database.invalidateAltBlock(block.id);
            logInfo("Altblock unlocker", `orphaned ${  formatCoinPort(block.port)  } block @ ${  block.height}`);
            return;
        }
        if (header.error !== null) {
            const profile = coinFuncs.getPoolProfile(block.port);
            if (profile && profile.rpc && profile.rpc.skipHashFallbackByHeight) return;
            logError("Altblock unlocker", `header by hash failed for ${  formatCoinPort(block.port)  } @ ${  block.height}`);
            const byHeight = await callCoin("getPortBlockHeaderByID", block.port, block.height);
            if (byHeight.error === null && byHeight.body && byHeight.body.hash !== block.hash) {
                database.invalidateAltBlock(block.id);
                logInfo("Altblock unlocker", `orphaned ${  formatCoinPort(block.port)  } block @ ${  block.height}`);
            }
            return;
        }
        await payAltBlock(block);
    }

    /** @returns {Promise<void>} */
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
                logError("Altblock unlocker", `anchor header failed @ ${  anchorHeight}`);
                continue;
            }
            const blockHexes = preCalcAnchorBlockHashes[anchorHeight];
            if (!blockHexes) continue;
            if (typeof anchorHeader.body.difficulty !== "number" || !Number.isFinite(anchorHeader.body.difficulty)) {
                logError("Altblock unlocker", `anchor header has no difficulty @ ${  anchorHeight}`);
                continue;
            }
            await preCalculateAndMark(
                blockHexes,
                parseInt(anchorHeight, 10),
                anchorHeader.body.difficulty,
                true,
                function () {
                    logInfo("Altblock unlocker", `precalc ready for ${  formatHashes(blockHexes)  } @ anchor ${  anchorHeight}`);
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

    /** @returns {Promise<void>} */
    async function runCycle() { await runBlockUnlocker(); await runAltblockUnlocker(); }

    /** @param {number} delayMs @returns {void} */
    function scheduleNextCycle(delayMs) {
        if (!state.started) return;
        state.timer = setTimeoutFn(async function () {
            state.timer = null;
            state.cyclePromise = runCycle();
            try {
                await state.cyclePromise;
            } catch (error) {
                logError("BlockManager", `cycle failed: ${  formatError(error)}`);
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
                } catch (_error) { /* in-flight cycle failure already handled elsewhere; ignore here */ }
            }
        },
        inspectState() {
            return { paymentInProgress: state.paymentInProgress, isFullStop: state.isFullStop, inFlightPrecalc: Array.from(state.inFlightPrecalc), started: state.started };
        },
        preCalculatePPLNSPayments, doPPLNSPayments, runBlockUnlocker, runAltblockUnlocker, runCycle
    };
}

module.exports = { createBlockManagerRuntime };
