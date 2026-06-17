"use strict";
const { createConsoleLogger, formatLogEvent } = require("./common/logging.js");
const publicCoinMetadata = require("./coins/metadata.json");

const MAX_BLOCKS = 1000;
const MAX_ALTBLOCKS = 10000;
const STATS_INTERVAL_MS = 60 * 1000;
const POOL_INFO_INTERVAL_MS = 30 * 1000;
const BLOCK_HEADER_INTERVAL_MS = 30 * 1000;
const DEFAULT_NODE_MONITOR_INTERVAL_MS = 60 * 1000;
const PRICE_INTERVAL_MS = 15 * 60 * 1000;
const BEHIND_EMAIL_COOLDOWN_MS = 15 * 60 * 1000;

const PPLNS = 0;
const priceCache = { btc: 0, usd: 0, eur: 0 };
const lastBlockCheckFailures = Object.create(null);
const nodeMonitorLagStart = Object.create(null);
const nodeMonitorFixTime = Object.create(null);
const behindBlockEmailTime = Object.create(null);
const historyState = { blocks: null, altblocks: null };
let networkInfoCache = {};
const logger = createConsoleLogger(console);
let optionalLib2Coins = null;
let optionalLib2CoinsLoaded = false;
let supportsXtmPoolColumns = true;

function formatError(error) {
    if (error === null || typeof error === "undefined") return "unknown error";
    if (error && error.message) return error.message;
    if (typeof error === "object") {
        try {
            return JSON.stringify(error);
        } catch (_jsonError) {
            return String(error);
        }
    }
    return String(error);
}

function daemonNumberConfig(key, fallback) {
    const value = global.config && global.config.daemon ? Number(global.config.daemon[key]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizedHeight(value) {
    if (value === null || typeof value === "undefined" || value === "") return null;
    const height = Number(value);
    return Number.isFinite(height) ? height : null;
}

function missingXtmPoolColumn(error) {
    const message = error && error.message ? error.message : String(error);
    return error && (error.code === "ER_BAD_FIELD_ERROR" || /Unknown column 'xtmBlockID/.test(message));
}

function loadOptionalLib2Coins() {
    if (optionalLib2CoinsLoaded) return optionalLib2Coins;
    optionalLib2CoinsLoaded = true;
    let lib2Coins = {};
    try {
        const factory = require("../lib2/coins.js");
        const loaded = typeof factory === "function" ? factory() : factory;
        lib2Coins = loaded && loaded.COINS ? loaded.COINS : {};
    } catch (_error) {
        lib2Coins = {};
    }
    optionalLib2Coins = Object.assign({}, publicCoinMetadata, lib2Coins);
    return optionalLib2Coins;
}

function formatTemplate(template, values) {
    return String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
        return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
    });
}

function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : formatTemplate(template, values || {});
}

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

function createBlockState() { return { head: null, totals: { global: 0, pplns: 0 } }; }

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

    // Incremental update: scan newest-first only until the cached head reappears, summing the delta.
    // A shrunk entryCount means rows were pruned/reset, so the cached totals are stale: rebuild fully.
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
        // Head vanished (e.g. reorg/prune) so the delta scan is unreliable: rebuild fully.
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

    // Same incremental-delta scheme as refreshBlockState; a shrunk count means a prune/reset, so rebuild.
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
        // Head vanished (e.g. reorg/prune) so the delta scan is unreliable: rebuild fully.
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
    const stats = getCache(`${prefix  }_stats`, {});
    const totals = getCache(`${prefix  }_stats2`, {});

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
        const stats = getCache(Number(port) === activePort ? "global_stats2" : `global_stats2_${  port}`, false);
        if (stats !== false) currentEfforts[port] = stats.roundHashes;
        portCoinAlgo[port] = global.coinFuncs.algoShortTypeStr(port, 0);
    });

    return {
        activePort,
        activePorts: getCache("active_ports", []),
        activePortProfit: xmrProfit ? xmrProfit.value : 0,
        coinProfit: getCache("coin_xmr_profit", {}),
        coinComment: getCache("coin_comment", {}),
        coinDisabledReason: getCache("coin_disabled_reason", {}),
        minBlockRewards,
        currentEfforts,
        pplnsPortShares: getCache("pplns_port_shares", {}),
        pplnsWindowTime: getCache("pplns_window_time", 0) || 0,
        portHash: getCache("port_hash", {}),
        portMinerCount: getCache("portMinerCount", {}),
        portCoinAlgo
    };
}

function safePortCoin(port) {
    if (global.coinFuncs && typeof global.coinFuncs.PORT2COIN === "function") {
        const symbol = global.coinFuncs.PORT2COIN(port);
        if (symbol) return symbol;
    }
    return global.config && global.config.general && global.config.general.coinCode ? global.config.general.coinCode : String(port);
}

function safePortDisplayCoin(port, symbol) {
    if (global.coinFuncs && typeof global.coinFuncs.PORT2COIN_FULL === "function") {
        const displayName = global.coinFuncs.PORT2COIN_FULL(port);
        if (displayName) return displayName;
    }
    return symbol;
}

function buildCoinMetadata(sharedStats) {
    const coins = {};
    const lib2Coins = loadOptionalLib2Coins();

    global.coinFuncs.getPORTS().forEach(function build(portValue) {
        const port = Number(portValue);
        const portKey = String(portValue);
        const lib2Coin = lib2Coins[portKey] || lib2Coins[port];
        const symbol = lib2Coin && lib2Coin.symbol ? lib2Coin.symbol : safePortCoin(port);
        const coin = {
            port,
            symbol,
            displayName: safePortDisplayCoin(port, symbol),
            algo: sharedStats.portCoinAlgo[portKey] || sharedStats.portCoinAlgo[port] || global.coinFuncs.algoShortTypeStr(port, 0),
            active: Number(sharedStats.activePort) === port || sharedStats.activePorts.map(Number).indexOf(port) !== -1,
            profit: sharedStats.coinProfit[portKey] || sharedStats.coinProfit[port] || 0,
            comment: sharedStats.coinComment[portKey] || sharedStats.coinComment[port] || "",
            disabledReason: sharedStats.coinDisabledReason[portKey] || sharedStats.coinDisabledReason[port] || "",
            hashrate: sharedStats.portHash[portKey] || sharedStats.portHash[port] || 0,
            miners: sharedStats.portMinerCount[portKey] || sharedStats.portMinerCount[port] || 0,
            pplnsShare: sharedStats.pplnsPortShares[portKey] || sharedStats.pplnsPortShares[port] || 0,
            altBlocksFound: 0
        };

        if (lib2Coin) {
            if (typeof lib2Coin.time !== "undefined") coin.blockTime = lib2Coin.time;
            if (typeof lib2Coin.divisor !== "undefined") coin.atomicUnits = lib2Coin.divisor;
            coin.exchangeConfigured = typeof lib2Coin.exchange === "string" && lib2Coin.exchange.length > 0;
        }

        coins[portKey] = coin;
    });

    return coins;
}

function buildPoolStatsRecord(snapshot, blockSummary, altBlockSummary, paymentSummary, sharedStats) {
    const coins = buildCoinMetadata(sharedStats);
    Object.keys(coins).forEach(function assignAltBlocks(port) {
        coins[port].altBlocksFound = altBlockSummary.altBlocksFound[port] || 0;
    });

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
        coins,
        updatedAt: Math.floor(Date.now() / 1000)
    };
}

function normalizeBool(value) { return value === true || value === 1 || value === "1"; }

function configuredPortTargetHashrate(difficulty) {
    const targetTime = global.config && global.config.pool && Number(global.config.pool.targetTime) > 0 ? Number(global.config.pool.targetTime) : 30;
    return Number(difficulty) / targetTime;
}

function configuredPortEntry(row) {
    const difficulty = Number(row.difficulty);
    return {
        port: normalizeBool(row.ssl) ? null : Number(row.poolPort),
        tlsPort: normalizeBool(row.ssl) ? Number(row.poolPort) : null,
        difficulty,
        targetHashrate: configuredPortTargetHashrate(difficulty),
        description: row.portDesc,
        portType: row.portType
    };
}

function configuredMatchKey(row) {
    return [row.portType || "", Number(row.difficulty), row.portDesc || ""].join("|");
}

function buildConfiguredPorts(rows) {
    const visibleRows = rows.filter(function visible(row) { return !normalizeBool(row.hidden); });
    const nonTls = visibleRows.filter(function noTls(row) { return !normalizeBool(row.ssl); });
    const tls = visibleRows.filter(function yesTls(row) { return normalizeBool(row.ssl); });
    const tlsByKey = Object.create(null);
    const pairedTlsPorts = Object.create(null);
    const configured = [];

    tls.forEach(function indexTls(row) {
        const key = configuredMatchKey(row);
        if (!tlsByKey[key]) tlsByKey[key] = [];
        tlsByKey[key].push(row);
    });

    nonTls.forEach(function addNonTls(row) {
        const entry = configuredPortEntry(row);
        const matches = tlsByKey[configuredMatchKey(row)] || [];
        const match = matches.shift();
        if (match) {
            entry.tlsPort = Number(match.poolPort);
            pairedTlsPorts[match.poolPort] = true;
        }
        configured.push(entry);
    });

    tls.forEach(function addUnpairedTls(row) {
        if (pairedTlsPorts[row.poolPort]) return;
        configured.push(configuredPortEntry(row));
    });

    return configured;
}

function publicPoolHost(host) {
    if (!host) return host;
    return {
        blockID: host.blockID,
        blockIDTime: host.blockIDTime,
        xtmBlockID: host.xtmBlockID,
        xtmBlockIDTime: host.xtmBlockIDTime,
        hostname: host.hostname
    };
}

function buildStatsStatusLine(stats) {
    return formatLogEvent("Pool stats", {
        miners: stats.miners,
        hashRate: stats.hashRate,
        lastBlock: stats.lastBlockFound,
        blocks: stats.totalBlocksFound,
        alt: stats.totalAltBlocksFound,
        pending: stats.pending
    });
}

async function getCmcPrice(symbol) {
    const slug = global.config.coin.name.toLowerCase();
    const url =
        `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=${ 
        slug 
        }&convert=${ 
        symbol 
        }&CMC_PRO_API_KEY=${ 
        global.config.general.cmcKey}`;
    const response = await new Promise(function (resolve) {
        global.support.https_get(url, resolve);
    });
    const data = response && response.data;
    const firstKey = data ? Object.keys(data)[0] : null;
    const quote = firstKey && data[firstKey] ? data[firstKey].quote : null;

    if (quote && symbol in quote) return parseFloat(quote[symbol].price);

    logger.logError("Price refresh", { status: "missing-quote", detail: JSON.stringify(response) });
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
        const [globalMiners, globalPayments] = await Promise.all([
            global.mysql.query(
                "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments GROUP BY payment_address, payment_id) as miners"
            ),
            global.mysql.query("SELECT count(id) as txn_count FROM transactions")
        ]);
        const paymentSummary = {
            totalMinersPaid: globalMiners[0] ? globalMiners[0].miner_count : 0,
            totalPayments: globalPayments[0] ? globalPayments[0].txn_count : 0
        };

        return {
            global: paymentSummary,
            pplns: paymentSummary
        };
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
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
        const [rows, configuredRows] = await Promise.all([
            global.mysql.query("select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE"),
            global.mysql.query("SELECT * FROM port_config WHERE hidden = 0")
        ]);
        const cache = { global: [], pplns: [], configured: buildConfiguredPorts(configuredRows) };
        const serverCount = Object.keys(poolServers).length;
        const aggregateByPort = Object.create(null);

        rows.forEach(function (row) {
            if (row.port_type !== "pplns") return;

            const host = poolServers[row.pool_id];
            cache.pplns.push({
                host: publicPoolHost(host),
                port: row.network_port,
                difficulty: row.starting_diff,
                description: row.description,
                miners: row.miners,
                tls: normalizeBool(row.ssl_port)
            });

            if (!host) return;
            if (!(row.network_port in aggregateByPort)) {
                aggregateByPort[row.network_port] = {
                    difficulty: row.starting_diff,
                    description: row.description,
                    miners: 0,
                    poolIds: Object.create(null),
                    host,
                    consistent: true,
                    tls: normalizeBool(row.ssl_port)
                };
            }

            const entry = aggregateByPort[row.network_port];
            if (entry.difficulty !== row.starting_diff) entry.consistent = false;
            if (entry.tls !== normalizeBool(row.ssl_port)) entry.consistent = false;
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
                    xtmBlockID: entry.host.xtmBlockID,
                    xtmBlockIDTime: entry.host.xtmBlockIDTime,
                    hostname: global.config.pool.geoDNS
                },
                port: Number(port),
                pool_type: "pplns",
                difficulty: entry.difficulty,
                miners: entry.miners,
                description: entry.description,
                tls: entry.tls
            });
        });

        global.database.setCache("poolPorts", cache);
        return cache;
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
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
                xtmBlockID: row.xtmBlockID,
                xtmBlockIDTime: row.xtmBlockIDTime ? global.support.formatDateFromSQL(row.xtmBlockIDTime) : row.xtmBlockIDTime,
                hostname: row.hostname
            };
        });

        global.database.setCache("poolServers", poolServers);
        await refreshPoolPorts(poolServers);
        return poolServers;
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
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

function getPoolHashesPerDifficulty(port) {
    if (!(global.coinFuncs && typeof global.coinFuncs.getPoolHashesPerDifficulty === "function")) return 1;
    const scale = Number(global.coinFuncs.getPoolHashesPerDifficulty(port));
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function networkDifficulty(port, difficulty) {
    const value = Number(difficulty);
    if (!Number.isFinite(value)) return parseInt(difficulty);
    const scale = getPoolHashesPerDifficulty(port);
    return scale === 1 ? value : Math.round(value * scale);
}

async function refreshBlockHeader() {
    const mainPort = Number(global.config.daemon.port);
    const ports = global.config.daemon.enableAlgoSwitching ? global.coinFuncs.getPORTS() : [mainPort];
    const nextInfo = Object.assign({}, networkInfoCache);

    for (const port of ports) {
        const result = await getHeader(port);
        if (result.error) continue;

        nextInfo[port] = {
            difficulty: networkDifficulty(port, result.body.difficulty),
            hash: result.body.hash ? result.body.hash : result.body.hashrate,
            height: result.body.height,
            value: result.body.reward,
            ts: parseInt(result.body.timestamp)
        };

        if (Number(port) !== mainPort) continue;

        // Mirror the active coin's header into legacy top-level fields that older API consumers read.
        nextInfo.difficulty = networkDifficulty(port, result.body.difficulty);
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

function daemonFailBody(values) {
    const body = renderEmailTemplate(
        "statsDaemonFailBody",
        values,
        "The worker failed to return last block header for %(port)s port. Error detail: %(error)s. Please verify if the daemon or merged-mining relay is running properly."
    );
    return body.includes(values.error) ? body : `${body  }\n\nError detail: ${  values.error}`;
}

function badHeaderStart(port, error) {
    const values = { port, error: formatError(error) };
    logger.logError("Node monitor", { port, status: "header-unavailable", error: values.error, detail: "skipping node monitor" });
    if (port in lastBlockCheckFailures) {
        if (++lastBlockCheckFailures[port] >= 5) {
            global.support.sendEmail(
                global.config.general.adminEmail,
                renderEmailTemplate("statsDaemonFailSubject", values, "Failed to query daemon for %(port)s port for last block header"),
                daemonFailBody(values)
            );
        }
        return;
    }
    lastBlockCheckFailures[port] = 1;
}

function badHeaderStop(port) {
    if (!(port in lastBlockCheckFailures)) return;

    if (lastBlockCheckFailures[port] >= 5) {
        const values = { port };
        global.support.sendEmail(
            global.config.general.adminEmail,
            renderEmailTemplate("statsDaemonRecoverSubject", values, "Querying daemon for %(port)s port for last block header is back to normal"),
            renderEmailTemplate("statsDaemonRecoverBody", values, "A warning was sent to you indicating that the worker failed to return the last block header for %(port)s port. The issue seems to be solved now.")
        );
    }

    delete lastBlockCheckFailures[port];
}

function getLastBlockHeaderMM(port) {
    return new Promise(function (resolve) {
        const fn = typeof global.coinFuncs.getPortLastBlockHeaderMM === "function"
            ? global.coinFuncs.getPortLastBlockHeaderMM
            : global.coinFuncs.getPortLastBlockHeader;
        fn.call(global.coinFuncs, port, function (error, block) {
            resolve({ error, block });
        }, true);
    });
}

function poolNodeLabel(hostname) {
    const raw = typeof hostname === "string" ? hostname.trim() : "";
    if (!raw) return "unknown";
    return raw.replace(/\.moneroocean\.stream$/i, "").split(".")[0] || raw;
}

function formatBehindBlocksEmail(row, lag, chain) {
    const node = poolNodeLabel(row.hostname);
    const values = { node, lag, port: row.port };
    const chainLabel = chain ? `${chain  } ` : "";
    return {
        subject: renderEmailTemplate("statsBehindBlocksSubject", values, "Pool node %(node)s is %(lag)s blocks behind"),
        body: renderEmailTemplate("statsBehindBlocksBody", values, `Pool node %(node)s is %(lag)s blocks behind for ${  chainLabel  }%(port)s port`)
    };
}

function maybeSendBehindBlocksEmail(row, lag, chain) {
    const key = [chain || "xmr", row.hostname || row.ip || "unknown", row.port || ""].join(":");
    const now = Date.now();
    if (behindBlockEmailTime[key] && now - behindBlockEmailTime[key] < BEHIND_EMAIL_COOLDOWN_MS) return;
    behindBlockEmailTime[key] = now;

    const email = formatBehindBlocksEmail(row, lag, chain);
    global.support.sendEmail(
        global.config.general.adminEmail,
        email.subject,
        email.body
    );
}

function nodeLagStatus(options) {
    const { chain, port, height, topHeight } = options;
    const lagBlocks = daemonNumberConfig("stuckTemplateLagBlocks", 5);
    const graceMs = daemonNumberConfig("stuckTemplateGraceSeconds", 300) * 1000;
    const cooldownMs = daemonNumberConfig("stuckTemplateFixCooldownSeconds", 900) * 1000;
    const key = `${chain  }:${  port}`;

    if (!topHeight || height === null || topHeight - height < lagBlocks) {
        delete nodeMonitorLagStart[key];
        delete nodeMonitorFixTime[key];
        return "healthy";
    }

    const now = Date.now();
    if (!nodeMonitorLagStart[key]) {
        nodeMonitorLagStart[key] = now;
        return "grace";
    }
    if (now - nodeMonitorLagStart[key] < graceMs) return "grace";
    if (nodeMonitorFixTime[key] && now - nodeMonitorFixTime[key] < cooldownMs) return "cooldown";

    return "ready";
}

function runNodeLagFix(options) {
    const { chain, port, xmrHeight, xtmHeight, topXmrHeight, topXtmHeight, keys } = options;
    const reason = chain === "both" ? "template-stuck" : (chain === "xtm" ? "xtm-lag" : "xmr-lag");
    const now = Date.now();

    keys.forEach(function markFixed(key) {
        nodeMonitorFixTime[key] = now;
    });

    global.coinFuncs.fixDaemonIssue({
        reason,
        port,
        xmrHeight,
        expectedXmrHeight: chain === "xmr" || chain === "both" ? topXmrHeight : undefined,
        xtmHeight,
        expectedXtmHeight: chain === "xtm" || chain === "both" ? topXtmHeight : undefined
    });
    return "fix";
}

async function queryNodeMonitorRows() {
    if (!supportsXtmPoolColumns) {
        return global.mysql.query(
            "SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
    }

    try {
        return await global.mysql.query(
            "SELECT blockID, xtmBlockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
    } catch (error) {
        if (!missingXtmPoolColumn(error)) throw error;
        supportsXtmPoolColumns = false;
        return global.mysql.query(
            "SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
    }
}

async function monitorNodes() {
    try {
        const mainPort = Number(global.config.daemon.port);
        const rows = await queryNodeMonitorRows();
        const header = await getLastBlockHeaderMM(mainPort);

        if (header.error !== null && typeof header.error !== "undefined") {
            badHeaderStart(mainPort, header.error);
            return false;
        }

        badHeaderStop(mainPort);

        const xmrHeight = normalizedHeight(header.block && header.block.height);
        const xtmHeight = normalizedHeight(header.block && header.block.mm && header.block.mm.height);
        let topXmrHeight = 0;
        let topXtmHeight = 0;
        let matchingRows = 0;
        rows.forEach(function (row) {
            if (row.port && Number(row.port) !== mainPort) {
                logger.logError("Node monitor", {
                    port: row.port,
                    status: "pool-port-mismatch",
                    detail: `master port ${  mainPort}`
                });
                return;
            }

            matchingRows += 1;
            const rowXmrHeight = normalizedHeight(row.blockID);
            const rowXtmHeight = normalizedHeight(row.xtmBlockID);
            if (rowXmrHeight !== null && rowXmrHeight > topXmrHeight) topXmrHeight = rowXmrHeight;
            if (rowXtmHeight !== null && rowXtmHeight > topXtmHeight) topXtmHeight = rowXtmHeight;
        });

        const lagBlocks = daemonNumberConfig("stuckTemplateLagBlocks", 5);
        rows.forEach(function (row) {
            if (row.port && Number(row.port) !== mainPort) return;
            const rowXmrHeight = normalizedHeight(row.blockID);
            const rowXtmHeight = normalizedHeight(row.xtmBlockID);
            if (rowXmrHeight !== null && topXmrHeight - rowXmrHeight >= lagBlocks) maybeSendBehindBlocksEmail(row, topXmrHeight - rowXmrHeight, "XMR");
            if (rowXtmHeight !== null && topXtmHeight - rowXtmHeight >= lagBlocks) maybeSendBehindBlocksEmail(row, topXtmHeight - rowXtmHeight, "XTM");
        });

        // Lag is measured against the highest peer; with a single node topHeight is its own height, so skip.
        if (matchingRows > 1) {
            const xmr = nodeLagStatus({ chain: "xmr", port: mainPort, height: xmrHeight, topHeight: topXmrHeight });
            const xtm = nodeLagStatus({ chain: "xtm", port: mainPort, height: xtmHeight, topHeight: topXtmHeight });

            if (xmr === "ready" && xtm === "ready") {
                runNodeLagFix({ chain: "both", port: mainPort, xmrHeight, xtmHeight, topXmrHeight, topXtmHeight, keys: [`xmr:${  mainPort}`, `xtm:${  mainPort}`] });
            } else if (xmr === "ready") {
                runNodeLagFix({ chain: "xmr", port: mainPort, xmrHeight, xtmHeight, topXmrHeight, topXtmHeight, keys: [`xmr:${  mainPort}`] });
            } else if (xtm === "ready") {
                runNodeLagFix({ chain: "xtm", port: mainPort, xmrHeight, xtmHeight, topXmrHeight, topXtmHeight, keys: [`xtm:${  mainPort}`] });
            }
        }

        return true;
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
        return false;
    }
}

async function runTask(name, task) {
    try {
        return await task();
    } catch (error) {
        logger.logError(`Pool stats ${  name}`, { status: "failed", detail: formatError(error) });
        return null;
    }
}

function scheduleTask(name, intervalMs, task) {
    let running = false;
    setInterval(function () {
        if (running) return;
        running = true;
        runTask(name, task).then(function () {
            running = false;
        });
    }, intervalMs);
}

async function startPoolStats() {
    await Promise.all([
        runTask("price refresh", refreshPrices),
        runTask("pool stats", refreshPoolStats),
        runTask("pool information", refreshPoolInformation),
        runTask("network headers", refreshBlockHeader),
        runTask("node monitor", monitorNodes)
    ]);

    scheduleTask("pool stats", STATS_INTERVAL_MS, refreshPoolStats);
    scheduleTask("pool information", POOL_INFO_INTERVAL_MS, refreshPoolInformation);
    scheduleTask("network headers", BLOCK_HEADER_INTERVAL_MS, refreshBlockHeader);
    scheduleTask("node monitor", daemonNumberConfig("stuckTemplateCheckInterval", DEFAULT_NODE_MONITOR_INTERVAL_MS), monitorNodes);
    scheduleTask("price refresh", PRICE_INTERVAL_MS, refreshPrices);
}

module.exports = {
    buildStatsStatusLine,
    formatBehindBlocksEmail,
    monitorNodes,
    refreshPoolStats,
    refreshPoolInformation,
    startPoolStats
};

if (global.__poolStatsAutostart !== false) {
    startPoolStats();
}
