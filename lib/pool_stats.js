"use strict";

const MAX_BLOCKS = 1000;
const MAX_ALTBLOCKS = 10000;
const STATS_INTERVAL_MS = 60 * 1000;
const POOL_INFO_INTERVAL_MS = 30 * 1000;
const BLOCK_HEADER_INTERVAL_MS = 30 * 1000;
const NODE_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const PRICE_INTERVAL_MS = 15 * 60 * 1000;

const PPLNS = 0;
const priceCache = { btc: 0, usd: 0, eur: 0 };
const lastBlockCheckFailures = Object.create(null);
const historyState = { blocks: null, altblocks: null };
let networkInfoCache = {};

function getCache(key, fallback) {
    const value = global.database.getCache(key);
    return value === false ? fallback : value;
}

function setCaches(entries) {
    if (typeof global.database.bulkSetCache === "function") {
        global.database.bulkSetCache(entries);
        return;
    }

    Object.keys(entries).forEach(function (key) {
        global.database.setCache(key, entries[key]);
    });
}

function scanDb(db, visit, reverse) {
    const txn = global.database.env.beginTxn({ readOnly: true });
    const cursor = new global.database.lmdb.Cursor(txn, db);
    const first = reverse ? "goToLast" : "goToFirst";
    const next = reverse ? "goToPrev" : "goToNext";

    try {
        for (let found = cursor[first](); found; found = cursor[next]()) {
            let keepGoing = true;
            cursor.getCurrentBinary(function (key, data) {
                keepGoing = visit(key, data) !== false;
            });
            if (!keepGoing) break;
        }
    } finally {
        cursor.close();
        txn.abort();
    }
}

function getDbEntryCount(db) {
    if (!db || typeof db.stat !== "function") return null;

    const txn = global.database.env.beginTxn({ readOnly: true });
    try {
        const stat = db.stat(txn);
        return stat && typeof stat.entryCount === "number" ? stat.entryCount : null;
    } finally {
        txn.abort();
    }
}

function createBlockSummary() {
    return { lastBlockFoundTime: 0, lastBlockFound: 0, totalBlocksFound: 0, pending: 0, pendingCount: 0 };
}

function createAltBlockSummary() {
    return { lastBlockFoundTime: 0, totalAltBlocksFound: 0, altBlocksFound: {}, pending: 0, pendingCount: 0 };
}

function createBlockState() {
    return { head: null, totals: { global: 0, pplns: 0 } };
}

function createAltBlockState() {
    return {
        head: null,
        totals: { global: 0, pplns: 0 },
        portTotals: { global: {}, pplns: {} }
    };
}

function updateBlockSummary(summary, key, block) {
    ++summary.totalBlocksFound;
    if (summary.totalBlocksFound === 1) {
        summary.lastBlockFound = key;
        summary.lastBlockFoundTime = Math.floor(block.timestamp / 1000);
    }
    if (summary.pendingCount >= MAX_BLOCKS) return;
    ++summary.pendingCount;
    if (block.valid === true && block.unlocked === false) {
        summary.pending += global.support.coinToDecimal(block.value);
    }
}

function updateAltBlockSummary(summary, block, minBlockRewards) {
    ++summary.totalAltBlocksFound;
    if (summary.totalAltBlocksFound === 1) {
        summary.lastBlockFoundTime = Math.floor(block.timestamp / 1000);
    }
    summary.altBlocksFound[block.port] = (summary.altBlocksFound[block.port] || 0) + 1;
    if (summary.pendingCount >= MAX_ALTBLOCKS) return;
    ++summary.pendingCount;
    if (block.valid === true && block.unlocked === false) {
        summary.pending += block.port in minBlockRewards ? minBlockRewards[block.port] : 0;
    }
}

function incrementPortCount(target, port) {
    target[port] = (target[port] || 0) + 1;
}

function buildBlockState() {
    const state = createBlockState();

    scanDb(global.database.blockDB, function (key, data) {
        const block = global.protos.Block.decode(data);
        if (state.head === null) state.head = { key, hash: block.hash };
        ++state.totals.global;
        if (block.poolType === PPLNS) ++state.totals.pplns;
    }, true);

    return state;
}

function buildAltBlockState() {
    const state = createAltBlockState();

    scanDb(global.database.altblockDB, function (key, data) {
        const block = global.protos.AltBlock.decode(data);
        if (state.head === null) state.head = { key, hash: block.hash };
        ++state.totals.global;
        incrementPortCount(state.portTotals.global, block.port);
        if (block.poolType === PPLNS) {
            ++state.totals.pplns;
            incrementPortCount(state.portTotals.pplns, block.port);
        }
    }, true);

    return state;
}

function refreshBlockState() {
    if (historyState.blocks === null) {
        historyState.blocks = buildBlockState();
        return historyState.blocks;
    }

    const state = historyState.blocks;
    const entryCount = getDbEntryCount(global.database.blockDB);
    if (entryCount !== null && entryCount < state.totals.global) {
        historyState.blocks = buildBlockState();
        return historyState.blocks;
    }
    const head = state.head;
    let foundHead = head === null;
    let newHead = null;
    let globalDelta = 0;
    let pplnsDelta = 0;

    scanDb(global.database.blockDB, function (key, data) {
        const block = global.protos.Block.decode(data);
        if (head && key === head.key && block.hash === head.hash) {
            foundHead = true;
            return false;
        }
        if (newHead === null) newHead = { key, hash: block.hash };
        ++globalDelta;
        if (block.poolType === PPLNS) ++pplnsDelta;
    }, true);

    if (!foundHead) {
        historyState.blocks = buildBlockState();
        return historyState.blocks;
    }

    if (newHead !== null) {
        state.head = newHead;
        state.totals.global += globalDelta;
        state.totals.pplns += pplnsDelta;
    }

    return state;
}

function refreshAltBlockState() {
    if (historyState.altblocks === null) {
        historyState.altblocks = buildAltBlockState();
        return historyState.altblocks;
    }

    const state = historyState.altblocks;
    const entryCount = getDbEntryCount(global.database.altblockDB);
    if (entryCount !== null && entryCount < state.totals.global) {
        historyState.altblocks = buildAltBlockState();
        return historyState.altblocks;
    }
    const head = state.head;
    let foundHead = head === null;
    let newHead = null;
    let globalDelta = 0;
    let pplnsDelta = 0;
    const globalPortDelta = {};
    const pplnsPortDelta = {};

    scanDb(global.database.altblockDB, function (key, data) {
        const block = global.protos.AltBlock.decode(data);
        if (head && key === head.key && block.hash === head.hash) {
            foundHead = true;
            return false;
        }
        if (newHead === null) newHead = { key, hash: block.hash };
        ++globalDelta;
        incrementPortCount(globalPortDelta, block.port);
        if (block.poolType === PPLNS) {
            ++pplnsDelta;
            incrementPortCount(pplnsPortDelta, block.port);
        }
    }, true);

    if (!foundHead) {
        historyState.altblocks = buildAltBlockState();
        return historyState.altblocks;
    }

    if (newHead !== null) {
        state.head = newHead;
        state.totals.global += globalDelta;
        state.totals.pplns += pplnsDelta;
        Object.keys(globalPortDelta).forEach(function (port) {
            state.portTotals.global[port] = (state.portTotals.global[port] || 0) + globalPortDelta[port];
        });
        Object.keys(pplnsPortDelta).forEach(function (port) {
            state.portTotals.pplns[port] = (state.portTotals.pplns[port] || 0) + pplnsPortDelta[port];
        });
    }

    return state;
}

function collectRecentBlockSummaries(blockState) {
    const summaries = { global: createBlockSummary(), pplns: createBlockSummary() };
    let globalDone = false;
    let pplnsDone = false;

    scanDb(global.database.blockDB, function (key, data) {
        const block = global.protos.Block.decode(data);

        if (!globalDone) {
            updateBlockSummary(summaries.global, key, block);
            if (summaries.global.pendingCount >= MAX_BLOCKS) globalDone = true;
        }
        if (!pplnsDone && block.poolType === PPLNS) {
            updateBlockSummary(summaries.pplns, key, block);
            if (summaries.pplns.pendingCount >= MAX_BLOCKS) pplnsDone = true;
        }

        return !(globalDone && pplnsDone);
    }, true);

    summaries.global.totalBlocksFound = blockState.totals.global;
    summaries.pplns.totalBlocksFound = blockState.totals.pplns;
    return summaries;
}

function collectRecentAltBlockSummaries(altBlockState, minBlockRewards) {
    const summaries = { global: createAltBlockSummary(), pplns: createAltBlockSummary() };
    let globalDone = false;
    let pplnsDone = false;

    scanDb(global.database.altblockDB, function (_key, data) {
        const block = global.protos.AltBlock.decode(data);

        if (!globalDone) {
            updateAltBlockSummary(summaries.global, block, minBlockRewards);
            if (summaries.global.pendingCount >= MAX_ALTBLOCKS) globalDone = true;
        }
        if (!pplnsDone && block.poolType === PPLNS) {
            updateAltBlockSummary(summaries.pplns, block, minBlockRewards);
            if (summaries.pplns.pendingCount >= MAX_ALTBLOCKS) pplnsDone = true;
        }

        return !(globalDone && pplnsDone);
    }, true);

    summaries.global.totalAltBlocksFound = altBlockState.totals.global;
    summaries.pplns.totalAltBlocksFound = altBlockState.totals.pplns;
    summaries.global.altBlocksFound = Object.assign({}, altBlockState.portTotals.global);
    summaries.pplns.altBlocksFound = Object.assign({}, altBlockState.portTotals.pplns);
    return summaries;
}

function loadStatsSnapshot(prefix) {
    const stats = getCache(prefix + "_stats", {});
    const totals = getCache(prefix + "_stats2", {});

    return {
        hashRate: stats.hash || 0,
        miners: stats.minerCount || 0,
        totalHashes: totals.totalHashes || 0,
        roundHashes: totals.roundHashes || 0
    };
}

function loadSharedStats(minBlockRewards) {
    const activePort = Number(global.config.daemon.port);
    const currentEfforts = {};
    const portCoinAlgo = {};
    const xmrProfit = getCache("xmr_profit", null);

    if (!(activePort in minBlockRewards)) minBlockRewards[activePort] = 0;

    global.coinFuncs.getPORTS().forEach(function (port) {
        const stats = getCache(port === activePort ? "global_stats2" : "global_stats2_" + port, false);
        if (stats !== false) currentEfforts[port] = stats.roundHashes;
        portCoinAlgo[port] = global.coinFuncs.algoShortTypeStr(port, 0);
    });

    return {
        activePort,
        activePorts: getCache("active_ports", []),
        activePortProfit: xmrProfit ? xmrProfit.value : 0,
        coinProfit: getCache("coin_xmr_profit", {}),
        coinComment: getCache("coin_comment", {}),
        minBlockRewards,
        currentEfforts,
        pplnsPortShares: getCache("pplns_port_shares", {}),
        pplnsWindowTime: getCache("pplns_window_time", 0) || 0,
        portHash: getCache("port_hash", {}),
        portMinerCount: getCache("portMinerCount", {}),
        portCoinAlgo
    };
}

function buildPoolStatsRecord(snapshot, blockSummary, altBlockSummary, paymentSummary, sharedStats) {
    return {
        hashRate: snapshot.hashRate,
        miners: snapshot.miners,
        totalHashes: snapshot.totalHashes,
        lastBlockFoundTime: Math.max(blockSummary.lastBlockFoundTime, altBlockSummary.lastBlockFoundTime),
        lastBlockFound: blockSummary.lastBlockFound,
        totalBlocksFound: blockSummary.totalBlocksFound,
        totalMinersPaid: paymentSummary.totalMinersPaid,
        totalPayments: paymentSummary.totalPayments,
        roundHashes: snapshot.roundHashes,
        totalAltBlocksFound: altBlockSummary.totalAltBlocksFound,
        altBlocksFound: altBlockSummary.altBlocksFound,
        activePort: sharedStats.activePort,
        activePorts: sharedStats.activePorts,
        activePortProfit: sharedStats.activePortProfit,
        coinProfit: sharedStats.coinProfit,
        coinComment: sharedStats.coinComment,
        minBlockRewards: sharedStats.minBlockRewards,
        pending: blockSummary.pending + altBlockSummary.pending,
        price: priceCache,
        currentEfforts: sharedStats.currentEfforts,
        pplnsPortShares: sharedStats.pplnsPortShares,
        pplnsWindowTime: sharedStats.pplnsWindowTime,
        portHash: sharedStats.portHash,
        portMinerCount: sharedStats.portMinerCount,
        portCoinAlgo: sharedStats.portCoinAlgo,
        updatedAt: Math.floor(Date.now() / 1000)
    };
}

function buildStatsStatusLine(stats) {
    return (
        "Pool stats: miners=" +
        stats.miners +
        " hashRate=" +
        stats.hashRate +
        " lastBlock=" +
        stats.lastBlockFound +
        " blocks=" +
        stats.totalBlocksFound +
        " alt=" +
        stats.totalAltBlocksFound +
        " pending=" +
        stats.pending
    );
}

async function getCmcPrice(symbol) {
    const slug = global.config.coin.name.toLowerCase();
    const url =
        "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=" +
        slug +
        "&convert=" +
        symbol +
        "&CMC_PRO_API_KEY=" +
        global.config.general.cmcKey;
    const response = await new Promise(function (resolve) {
        global.support.https_get(url, resolve);
    });
    const data = response && response.data;
    const firstKey = data ? Object.keys(data)[0] : null;
    const quote = firstKey && data[firstKey] ? data[firstKey].quote : null;

    if (quote && symbol in quote) return parseFloat(quote[symbol].price);

    console.error("Can't get price data from: " + JSON.stringify(response));
    return 0;
}

async function refreshPrices() {
    const [usd, eur, btc] = await Promise.all([getCmcPrice("USD"), getCmcPrice("EUR"), getCmcPrice("BTC")]);

    if (btc) priceCache.btc = btc;
    if (usd) priceCache.usd = usd;
    if (eur) priceCache.eur = eur;

    return priceCache;
}

async function loadPaymentSummaries() {
    try {
        const [globalMiners, pplnsMiners, globalPayments, pplnsPayments] = await Promise.all([
            global.mysql.query(
                "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments GROUP BY payment_address, payment_id) as miners"
            ),
            global.mysql.query(
                "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments WHERE pool_type = ? GROUP BY payment_address, payment_id) as miners",
                ["pplns"]
            ),
            global.mysql.query("SELECT count(id) as txn_count FROM transactions"),
            global.mysql.query("SELECT count(distinct transaction_id) as txn_count FROM payments WHERE pool_type = ?", ["pplns"])
        ]);

        return {
            global: {
                totalMinersPaid: globalMiners[0] ? globalMiners[0].miner_count : 0,
                totalPayments: globalPayments[0] ? globalPayments[0].txn_count : 0
            },
            pplns: {
                totalMinersPaid: pplnsMiners[0] ? pplnsMiners[0].miner_count : 0,
                totalPayments: pplnsPayments[0] ? pplnsPayments[0].txn_count : 0
            }
        };
    } catch (error) {
        console.error("SQL query failed: " + error);
        return {
            global: { totalMinersPaid: 0, totalPayments: 0 },
            pplns: { totalMinersPaid: 0, totalPayments: 0 }
        };
    }
}

async function refreshPoolStats() {
    const minBlockRewards = getCache("min_block_rewards", {});
    const paymentPromise = loadPaymentSummaries();
    const blockState = refreshBlockState();
    const altBlockState = refreshAltBlockState();
    const blockSummaries = collectRecentBlockSummaries(blockState);
    const altBlockSummaries = collectRecentAltBlockSummaries(altBlockState, minBlockRewards);
    const sharedStats = loadSharedStats(minBlockRewards);
    const paymentSummaries = await paymentPromise;

    const stats = {
        global: buildPoolStatsRecord(
            loadStatsSnapshot("global"),
            blockSummaries.global,
            altBlockSummaries.global,
            paymentSummaries.global,
            sharedStats
        ),
        pplns: buildPoolStatsRecord(
            loadStatsSnapshot("pplns"),
            blockSummaries.pplns,
            altBlockSummaries.pplns,
            paymentSummaries.pplns,
            sharedStats
        )
    };

    setCaches({
        pool_stats_global: stats.global,
        pool_stats_pplns: stats.pplns
    });
    console.log(buildStatsStatusLine(stats.global));
    return stats;
}

async function refreshPoolPorts(poolServers) {
    try {
        const rows = await global.mysql.query(
            "select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE"
        );
        const cache = { global: [], pplns: [] };
        const serverCount = Object.keys(poolServers).length;
        const aggregateByPort = Object.create(null);

        rows.forEach(function (row) {
            if (row.port_type !== "pplns") return;

            const host = poolServers[row.pool_id];
            cache.pplns.push({
                host,
                port: row.network_port,
                difficulty: row.starting_diff,
                description: row.description,
                miners: row.miners
            });

            if (!host) return;
            if (!(row.network_port in aggregateByPort)) {
                aggregateByPort[row.network_port] = {
                    difficulty: row.starting_diff,
                    description: row.description,
                    miners: 0,
                    poolIds: Object.create(null),
                    host,
                    consistent: true
                };
            }

            const entry = aggregateByPort[row.network_port];
            if (entry.difficulty !== row.starting_diff) entry.consistent = false;
            entry.poolIds[row.pool_id] = 1;
            entry.miners += row.miners;
        });

        Object.keys(aggregateByPort).forEach(function (port) {
            const entry = aggregateByPort[port];
            if (!entry.consistent || Object.keys(entry.poolIds).length !== serverCount) return;

            cache.global.push({
                host: {
                    blockID: entry.host.blockID,
                    blockIDTime: entry.host.blockIDTime,
                    hostname: global.config.pool.geoDNS
                },
                port: Number(port),
                pool_type: "pplns",
                difficulty: entry.difficulty,
                miners: entry.miners,
                description: entry.description
            });
        });

        global.database.setCache("poolPorts", cache);
        return cache;
    } catch (error) {
        console.error("SQL query failed: " + error);
        return false;
    }
}

async function refreshPoolInformation() {
    try {
        const rows = await global.mysql.query(
            "select * from pools where id < 1000 and last_checkin >= NOW() - INTERVAL 10 MINUTE"
        );
        const poolServers = {};

        rows.forEach(function (row) {
            poolServers[row.id] = {
                ip: row.ip,
                blockID: row.blockID,
                blockIDTime: global.support.formatDateFromSQL(row.blockIDTime),
                hostname: row.hostname
            };
        });

        global.database.setCache("poolServers", poolServers);
        await refreshPoolPorts(poolServers);
        return poolServers;
    } catch (error) {
        console.error("SQL query failed: " + error);
        return false;
    }
}

function getHeader(port) {
    return new Promise(function (resolve) {
        global.coinFuncs.getPortLastBlockHeaderWithRewardDiff(port, function (error, body) {
            resolve({ error, body });
        }, true);
    });
}

function rpcPortDaemon(port, method, params) {
    return new Promise(function (resolve) {
        global.support.rpcPortDaemon(port, method, params, resolve, true);
    });
}

async function refreshBlockHeader() {
    const mainPort = Number(global.config.daemon.port);
    const ports = global.config.daemon.enableAlgoSwitching ? global.coinFuncs.getPORTS() : [mainPort];
    const nextInfo = Object.assign({}, networkInfoCache);

    for (const port of ports) {
        const result = await getHeader(port);
        if (result.error) continue;

        nextInfo[port] = {
            difficulty: parseInt(result.body.difficulty),
            hash: result.body.hash ? result.body.hash : result.body.hashrate,
            height: result.body.height,
            value: result.body.reward,
            ts: parseInt(result.body.timestamp)
        };

        if (port !== mainPort) continue;

        const rpcResult = await rpcPortDaemon(port, "get_info", []);
        const hasRpcResult = !!(rpcResult && typeof rpcResult === "object" && rpcResult.result);
        if (!hasRpcResult) {
            console.error("PoolStats get_info failed for " + port + " port. Using last block header data.");
        }
        nextInfo.difficulty = hasRpcResult ? rpcResult.result.difficulty : result.body.difficulty;
        nextInfo.hash = result.body.hash;
        nextInfo.main_height = result.body.height;
        nextInfo.height = result.body.height;
        nextInfo.value = result.body.reward;
        nextInfo.ts = result.body.timestamp;
    }

    networkInfoCache = nextInfo;
    global.database.setCache("networkBlockInfo", networkInfoCache);
    return networkInfoCache;
}

function badHeaderStart(port) {
    console.error("Issue in getting block header for " + port + " port. Skipping node monitor");
    if (port in lastBlockCheckFailures) {
        if (++lastBlockCheckFailures[port] >= 5) {
            global.support.sendEmail(
                global.config.general.adminEmail,
                "Failed to query daemon for " + port + " port for last block header",
                "The worker failed to return last block header for " + port + " port. Please verify if the daemon is running properly."
            );
        }
        return;
    }
    lastBlockCheckFailures[port] = 1;
}

function badHeaderStop(port) {
    if (!(port in lastBlockCheckFailures)) return;

    if (lastBlockCheckFailures[port] >= 5) {
        global.support.sendEmail(
            global.config.general.adminEmail,
            "Quering daemon for " + port + " port for last block header is back to normal",
            "An warning was sent to you indicating that the the worker failed to return the last block header for " +
            port +
            " port. The issue seems to be solved now."
        );
    }

    delete lastBlockCheckFailures[port];
}

function getLastBlockHeader(port) {
    return new Promise(function (resolve) {
        global.coinFuncs.getPortLastBlockHeader(port, function (error, block) {
            resolve({ error, block });
        }, true);
    });
}

async function monitorNodes() {
    try {
        const mainPort = Number(global.config.daemon.port);
        const rows = await global.mysql.query(
            "SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
        const header = await getLastBlockHeader(mainPort);

        if (header.error !== null && typeof header.error !== "undefined") {
            badHeaderStart(mainPort);
            return false;
        }

        badHeaderStop(mainPort);

        let topHeight = 0;
        let isMasterDaemonIssue = rows.length > 1;
        rows.forEach(function (row) {
            if (row.port && Number(row.port) !== mainPort) {
                console.error(
                    "INTERNAL ERROR: pool node port " +
                    row.port +
                    " do not match master port " +
                    mainPort
                );
                isMasterDaemonIssue = false;
                return;
            }

            if (topHeight < row.blockID) topHeight = row.blockID;
            if (Math.abs(header.block.height - row.blockID) > 3) {
                global.support.sendEmail(
                    global.config.general.adminEmail,
                    "Pool server behind in blocks",
                    "The pool server: " +
                    row.hostname +
                    " with IP: " +
                    row.ip +
                    " is " +
                    (header.block.height - row.blockID) +
                    " blocks behind for " +
                    row.port +
                    " port"
                );
                return;
            }

            isMasterDaemonIssue = false;
        });

        if (isMasterDaemonIssue) {
            global.coinFuncs.fixDaemonIssue(header.block.height, topHeight, mainPort);
        }

        return true;
    } catch (error) {
        console.error("SQL query failed: " + error);
        return false;
    }
}

async function runTask(name, task) {
    try {
        return await task();
    } catch (error) {
        console.error("PoolStats " + name + " failed: " + (error && error.stack ? error.stack : error));
        return null;
    }
}

function scheduleTask(name, intervalMs, task) {
    let running = false;
    setInterval(function () {
        if (running) {
            console.error("PoolStats " + name + " is still running. Skipping this cycle.");
            return;
        }
        running = true;
        runTask(name, task).then(function () {
            running = false;
        });
    }, intervalMs);
}

async function startPoolStats() {
    scheduleTask("pool stats", STATS_INTERVAL_MS, refreshPoolStats);
    scheduleTask("pool information", POOL_INFO_INTERVAL_MS, refreshPoolInformation);
    scheduleTask("network headers", BLOCK_HEADER_INTERVAL_MS, refreshBlockHeader);
    scheduleTask("node monitor", NODE_MONITOR_INTERVAL_MS, monitorNodes);
    scheduleTask("price refresh", PRICE_INTERVAL_MS, refreshPrices);

    await Promise.all([
        runTask("price refresh", refreshPrices),
        runTask("pool stats", refreshPoolStats),
        runTask("pool information", refreshPoolInformation),
        runTask("network headers", refreshBlockHeader),
        runTask("node monitor", monitorNodes)
    ]);
}

module.exports = {
    buildStatsStatusLine,
    refreshPoolStats,
    refreshPoolInformation,
    startPoolStats
};

if (global.__poolStatsAutostart !== false) {
    startPoolStats();
}
