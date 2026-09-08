"use strict";
const { createConsoleLogger, formatLogEvent } = require("./common/logging.js");
const publicCoinMetadata = require("./coins/metadata.json");

/** @typedef {import("../types/runtime").DatabaseRuntime} DatabaseRuntime */
/** @typedef {import("../types/runtime").CoinRuntime} CoinRuntime */
/** @typedef {import("../types/runtime").SupportRuntime} SupportRuntime */
/** @typedef {import("../types/runtime").PoolConfig} PoolConfig */
/** @typedef {import("../types/runtime").BlockMessage} BlockMessage */
/** @typedef {import("../types/runtime").AltBlockMessage} AltBlockMessage */
/** @typedef {import("../types/runtime").BlockHeader} BlockHeader */
/** @typedef {import("../types/runtime").LmdbDbi} LmdbDbi */
/** @typedef {import("../types/runtime").LmdbTxn} LmdbTxn */
/** @typedef {import("../types/runtime").LmdbCursor} LmdbCursor */
/** @typedef {import("../types/runtime").SqlRow} SqlRow */
/** @typedef {{[key: string]: unknown}} UnknownRecord */
/** @typedef {{[key: string]: number}} NumberByPort */
/** @typedef {{[key: string]: string}} StringByPort */
/** @typedef {{time?: number|string, divisor?: number|string, exchange?: string, symbol?: string, [key: string]: unknown}} CoinMetadata */
/** @typedef {{[key: string]: CoinMetadata}} CoinMetadataMap */
/** @typedef {{lastBlockFoundTime: number, lastBlockFound: string|number|Buffer, totalBlocksFound: number, pending: number, pendingCount: number}} BlockSummary */
/** @typedef {{lastBlockFoundTime: number, totalAltBlocksFound: number, altBlocksFound: NumberByPort, pending: number, pendingCount: number}} AltBlockSummary */
/** @typedef {{key: string|number|Buffer, hash: string}} StateHead */
/** @typedef {{head: StateHead|null, totals: {global: number, pplns: number}}} BlockState */
/** @typedef {{head: StateHead|null, totals: {global: number, pplns: number}, portTotals: {global: NumberByPort, pplns: NumberByPort}}} AltBlockState */
/** @typedef {{blocks: BlockState|null, altblocks: AltBlockState|null}} HistoryState */
/** @typedef {{hashRate: number, miners: number, totalHashes: number, roundHashes: number}} StatsSnapshot */
/** @typedef {{totalMinersPaid: number, totalPayments: number}} PaymentSummary */
/** @typedef {{port: number, symbol: string, displayName: string, algo: string, active: boolean, profit: number, comment: string, disabledReason: string, hashrate: number, miners: number, pplnsShare: number, altBlocksFound: number, blockTime?: number|string, atomicUnits?: number|string, exchangeConfigured?: boolean}} CoinStats */
/** @typedef {{activePort: number, activePorts: number[], activePortProfit: number, coinProfit: NumberByPort, coinComment: {[key: string]: string}, coinDisabledReason: {[key: string]: string}, minBlockRewards: NumberByPort, currentEfforts: NumberByPort, pplnsPortShares: NumberByPort, pplnsWindowTime: number, portHash: NumberByPort, portMinerCount: NumberByPort, portCoinAlgo: StringByPort}} SharedStats */
/** @typedef {{hashRate: number, miners: number, totalHashes: number, lastBlockFoundTime: number, lastBlockFound: string|number|Buffer, totalBlocksFound: number, totalMinersPaid: number, totalPayments: number, roundHashes: number, totalAltBlocksFound: number, altBlocksFound: NumberByPort, activePort: number, activePorts: number[], activePortProfit: number, coinProfit: NumberByPort, coinComment: {[key: string]: string}, minBlockRewards: NumberByPort, pending: number, price: PriceCache, currentEfforts: NumberByPort, pplnsPortShares: NumberByPort, pplnsWindowTime: number, portHash: NumberByPort, portMinerCount: NumberByPort, portCoinAlgo: StringByPort, coins: {[key: string]: CoinStats}, updatedAt: number}} PoolStatsRecord */
/** @typedef {{btc: number, usd: number, eur: number}} PriceCache */
/** @typedef {{hidden: unknown, ssl: unknown, poolPort: number|string, difficulty: number|string, portDesc: string, portType: string}} ConfiguredPortRow */
/** @typedef {{port: number|null, tlsPort: number|null, difficulty: number, targetHashrate: number, description: string, portType: string}} ConfiguredPort */
/** @typedef {{blockID: number|string|null, blockIDTime: number|string|Date|null, xtmBlockID: number|string|null, xtmBlockIDTime: number|string|Date|null, hostname: string, ip?: string}} PublicPoolHost */
/** @typedef {{id: number|string, ip?: string, blockID: number|string|null, blockIDTime: number|string|Date|null, xtmBlockID?: number|string|null, xtmBlockIDTime?: number|string|Date|null, hostname: string}} PoolServerRow */
/** @typedef {PublicPoolHost & {ip?: string}} PoolServer */
/** @typedef {{port_type: string, pool_id: number|string, network_port: number|string, starting_diff: number|string, description: string, miners: number, ssl_port: unknown}} PoolPortRow */
/** @typedef {{difficulty: number|string, description: string, miners: number, poolIds: Record<string, number>, host: PoolServer, consistent: boolean, tls: boolean}} AggregatePort */
/** @typedef {{host: PublicPoolHost|undefined, port: number|string, pool_type?: string, difficulty: number|string, description: string, miners: number, tls: boolean}} PoolPortEntry */
/** @typedef {{global: PoolPortEntry[], pplns: PoolPortEntry[], configured: ConfiguredPort[]}} PoolPortCache */
/** @typedef {{difficulty: number, hash: string, height: number, value?: number|null, ts?: number}} NetworkInfoEntry */
/** @typedef {{[key: string]: NetworkInfoEntry|number|string|null|undefined, difficulty?: number, hash?: string, main_height?: number, height?: number, value?: number|null, ts?: number}} NetworkInfo */
/** @typedef {{error: Error|string|boolean|null, body?: BlockHeader}} HeaderReply */
/** @typedef {{blockID?: number|string|null, xtmBlockID?: number|string|null, hostname: string, ip?: string, port?: number|string|null}} MonitorRow */
/** @typedef {{pool_id?: number|string, port?: number|string|null, blockID?: number|string|null, xtmBlockID?: number|string|null, hostname?: string, ip?: string}} MonitorPoolRow */

/** @param {unknown} value @returns {value is UnknownRecord} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function finiteNumber(value, fallback) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** @param {unknown} value @returns {number|undefined} */
function optionalNumber(value) {
    if (value === null || typeof value === "undefined" || value === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

/** @param {unknown} value @returns {string|undefined} */
function optionalString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** @param {unknown} value @returns {NumberByPort} */
function numberMap(value) {
    const result = Object.create(null);
    if (!isRecord(value)) return result;
    Object.keys(value).forEach(function addNumber(key) {
        const number = optionalNumber(value[key]);
        if (typeof number === "number") result[key] = number;
    });
    return result;
}

/** @param {unknown} value @returns {{[key: string]: string}} */
function stringMap(value) {
    const result = Object.create(null);
    if (!isRecord(value)) return result;
    Object.keys(value).forEach(function addString(key) {
        if (typeof value[key] === "string") result[key] = value[key];
    });
    return result;
}

/** @param {unknown} value @returns {number[]} */
function numberArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map(optionalNumber).filter(function isNumber(item) { return typeof item === "number"; });
}

const MAX_BLOCKS = 1000;
const MAX_ALTBLOCKS = 10000;
const STATS_INTERVAL_MS = 60 * 1000;
const POOL_INFO_INTERVAL_MS = 30 * 1000;
const BLOCK_HEADER_INTERVAL_MS = 30 * 1000;
const DEFAULT_NODE_MONITOR_INTERVAL_MS = 60 * 1000;
const PRICE_INTERVAL_MS = 15 * 60 * 1000;
const BEHIND_EMAIL_COOLDOWN_MS = 15 * 60 * 1000;

const PPLNS = 0;
/** @type {PriceCache} */
const priceCache = { btc: 0, usd: 0, eur: 0 };
/** @type {NumberByPort} */
const lastBlockCheckFailures = Object.create(null);
/** @type {Record<string, number>} */
const behindBlockEmailTime = Object.create(null);
/** @type {HistoryState} */
const historyState = { blocks: null, altblocks: null };
/** @type {NetworkInfo} */
let networkInfoCache = {};
const logger = createConsoleLogger(console, undefined);
/** @type {CoinMetadataMap|null} */
let optionalLib2Coins = null;
let optionalLib2CoinsLoaded = false;
let supportsXtmPoolColumns = true;

/** @param {unknown} error @returns {string} */
function formatError(error) {
    if (error === null || typeof error === "undefined") return "unknown error";
    if (isRecord(error) && typeof error["message"] === "string") return error["message"];
    if (typeof error === "object") {
        try {
            return JSON.stringify(error);
        } catch (_jsonError) {
            return String(error);
        }
    }
    return String(error);
}

/** @param {string} key @param {number} fallback @returns {number} */
function daemonNumberConfig(key, fallback) {
    const value = global.config && global.config.daemon ? Number(global.config.daemon[key]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** @param {unknown} value @returns {number|null} */
function normalizedHeight(value) {
    if (value === null || typeof value === "undefined" || value === "") return null;
    const height = Number(value);
    return Number.isFinite(height) ? height : null;
}

/** @param {unknown} error @returns {boolean} */
function missingXtmPoolColumn(error) {
    const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : String(error);
    const code = isRecord(error) ? error["code"] : undefined;
    return code === "ER_BAD_FIELD_ERROR" || /Unknown column 'xtmBlockID/.test(message);
}

/** @returns {CoinMetadataMap} */
function loadOptionalLib2Coins() {
    if (optionalLib2CoinsLoaded) return optionalLib2Coins || {};
    optionalLib2CoinsLoaded = true;
    /** @type {CoinMetadataMap} */
    let lib2Coins = {};
    try {
        const factory = require("../lib2/coins.js");
        const loaded = typeof factory === "function" ? factory() : factory;
        if (isRecord(loaded) && isRecord(loaded["COINS"])) {
            Object.keys(loaded["COINS"]).forEach(function copyCoin(key) {
                const coin = loaded["COINS"][key];
                if (!isRecord(coin)) return;
                /** @type {CoinMetadata} */
                const metadata = {};
                Object.keys(coin).forEach(function copyField(field) {
                    metadata[field] = coin[field];
                });
                lib2Coins[key] = metadata;
            });
        }
    } catch (_error) {
        lib2Coins = {};
    }
    /** @type {CoinMetadataMap} */
    const merged = {};
    Object.assign(merged, publicCoinMetadata, lib2Coins);
    optionalLib2Coins = merged;
    return merged;
}

/** @param {unknown} template @param {UnknownRecord} values @returns {string} */
function formatTemplate(template, values) {
    return String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
        return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
    });
}

/** @param {string} item @param {UnknownRecord} values @param {string} fallback @returns {string} */
function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : formatTemplate(template, values || {});
}

/** @param {string} key @param {unknown} fallback @returns {unknown} */
function getCache(key, fallback) {
    const value = global.database.getCache(key);
    // LMDB cache misses use false, while a stale JSON null should behave like a miss too.
    return value === false || value === null || typeof value === "undefined" ? fallback : value;
}

/** @param {UnknownRecord} entries @returns {void} */
function setCaches(entries) {
    if (typeof global.database.bulkSetCache === "function") {
        global.database.bulkSetCache(entries);
        return;
    }

    Object.keys(entries).forEach(function (key) {
        global.database.setCache(key, entries[key]);
    });
}

/** @param {LmdbDbi} db @param {(key: string|number|Buffer, data: Buffer) => boolean|void} visit @param {boolean} reverse @returns {void} */
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

/** @param {LmdbDbi} db @returns {number|null} */
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

/** @returns {BlockSummary} */
function createBlockSummary() {
    return { lastBlockFoundTime: 0, lastBlockFound: 0, totalBlocksFound: 0, pending: 0, pendingCount: 0 };
}

/** @returns {AltBlockSummary} */
function createAltBlockSummary() {
    return { lastBlockFoundTime: 0, totalAltBlocksFound: 0, altBlocksFound: {}, pending: 0, pendingCount: 0 };
}

/** @returns {BlockState} */
function createBlockState() { return { head: null, totals: { global: 0, pplns: 0 } }; }

/** @returns {AltBlockState} */
function createAltBlockState() {
    /** @type {NumberByPort} */
    const globalPortTotals = Object.create(null);
    /** @type {NumberByPort} */
    const pplnsPortTotals = Object.create(null);
    return {
        head: null,
        totals: { global: 0, pplns: 0 },
        portTotals: { global: globalPortTotals, pplns: pplnsPortTotals }
    };
}

/** @param {BlockSummary} summary @param {string|number|Buffer} key @param {BlockMessage} block @returns {void} */
function updateBlockSummary(summary, key, block) {
    ++summary.totalBlocksFound;
    if (summary.totalBlocksFound === 1) {
        summary.lastBlockFound = key;
        summary.lastBlockFoundTime = Math.floor(block.timestamp / 1000);
    }
    if (summary.pendingCount >= MAX_BLOCKS) return;
    ++summary.pendingCount;
    if (block.valid === true && block.unlocked === false && typeof block.value === "number") {
        summary.pending += global.support.coinToDecimal(block.value);
    }
}

/** @param {AltBlockSummary} summary @param {AltBlockMessage} block @param {NumberByPort} minBlockRewards @returns {void} */
function updateAltBlockSummary(summary, block, minBlockRewards) {
    ++summary.totalAltBlocksFound;
    if (summary.totalAltBlocksFound === 1) {
        summary.lastBlockFoundTime = Math.floor(block.timestamp / 1000);
    }
    const port = String(block.port);
    summary.altBlocksFound[port] = (summary.altBlocksFound[port] || 0) + 1;
    if (summary.pendingCount >= MAX_ALTBLOCKS) return;
    ++summary.pendingCount;
    if (block.valid === true && block.unlocked === false) {
        summary.pending += minBlockRewards[port] || 0;
    }
}

/** @param {NumberByPort} target @param {number} port @returns {void} */
function incrementPortCount(target, port) {
    target[port] = (target[port] || 0) + 1;
}

/** @returns {BlockState} */
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

/** @returns {AltBlockState} */
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

/** @returns {BlockState} */
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
    /** @type {StateHead|null} */
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
        return true;
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

/** @returns {AltBlockState} */
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
    /** @type {StateHead|null} */
    let newHead = null;
    let globalDelta = 0;
    let pplnsDelta = 0;
    /** @type {NumberByPort} */
    const globalPortDelta = Object.create(null);
    /** @type {NumberByPort} */
    const pplnsPortDelta = Object.create(null);

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
        return true;
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
            state.portTotals.global[port] = (state.portTotals.global[port] || 0) + (globalPortDelta[port] || 0);
        });
        Object.keys(pplnsPortDelta).forEach(function (port) {
            state.portTotals.pplns[port] = (state.portTotals.pplns[port] || 0) + (pplnsPortDelta[port] || 0);
        });
    }

    return state;
}

/** @param {BlockState} blockState @returns {{global: BlockSummary, pplns: BlockSummary}} */
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

/** @param {AltBlockState} altBlockState @param {NumberByPort} minBlockRewards @returns {{global: AltBlockSummary, pplns: AltBlockSummary}} */
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

/** @param {string} prefix @returns {StatsSnapshot} */
function loadStatsSnapshot(prefix) {
    const statsValue = getCache(`${prefix  }_stats`, {});
    const stats = isRecord(statsValue) ? statsValue : {};
    const totalsValue = getCache(`${prefix  }_stats2`, {});
    const totals = isRecord(totalsValue) ? totalsValue : {};

    return {
        hashRate: finiteNumber(stats["hash"], 0),
        miners: finiteNumber(stats["minerCount"], 0),
        totalHashes: finiteNumber(totals["totalHashes"], 0),
        roundHashes: finiteNumber(totals["roundHashes"], 0)
    };
}

/** @param {NumberByPort} minBlockRewards @returns {SharedStats} */
function loadSharedStats(minBlockRewards) {
    const activePort = Number(global.config.daemon.port);
    /** @type {NumberByPort} */
    const currentEfforts = Object.create(null);
    /** @type {StringByPort} */
    const portCoinAlgo = Object.create(null);
    const xmrProfitValue = getCache("xmr_profit", null);
    const xmrProfit = isRecord(xmrProfitValue) ? xmrProfitValue : null;

    if (!(String(activePort) in minBlockRewards)) minBlockRewards[String(activePort)] = 0;

    global.coinFuncs.getPORTS().forEach(function (port) {
        const statsValue = getCache(Number(port) === activePort ? "global_stats2" : `global_stats2_${  port}`, false);
        const stats = isRecord(statsValue) ? statsValue : null;
        if (stats) currentEfforts[String(port)] = finiteNumber(stats["roundHashes"], 0);
        portCoinAlgo[String(port)] = global.coinFuncs.algoShortTypeStr(Number(port));
    });

    return {
        activePort,
        activePorts: numberArray(getCache("active_ports", [])),
        activePortProfit: xmrProfit ? finiteNumber(xmrProfit["value"], 0) : 0,
        coinProfit: numberMap(getCache("coin_xmr_profit", {})),
        coinComment: stringMap(getCache("coin_comment", {})),
        coinDisabledReason: stringMap(getCache("coin_disabled_reason", {})),
        minBlockRewards,
        currentEfforts,
        pplnsPortShares: numberMap(getCache("pplns_port_shares", {})),
        pplnsWindowTime: finiteNumber(getCache("pplns_window_time", 0), 0),
        portHash: numberMap(getCache("port_hash", {})),
        portMinerCount: numberMap(getCache("portMinerCount", {})),
        portCoinAlgo
    };
}

/** @param {number} port @returns {string} */
function safePortCoin(port) {
    if (global.coinFuncs && typeof global.coinFuncs.PORT2COIN === "function") {
        const symbol = global.coinFuncs.PORT2COIN(port);
        if (symbol) return symbol;
    }
    return global.config && global.config.general && global.config.general.coinCode ? global.config.general.coinCode : String(port);
}

/** @param {number} port @param {string} symbol @returns {string} */
function safePortDisplayCoin(port, symbol) {
    if (global.coinFuncs && typeof global.coinFuncs.PORT2COIN_FULL === "function") {
        const displayName = global.coinFuncs.PORT2COIN_FULL(port);
        if (displayName) return displayName;
    }
    return symbol;
}

/** @param {NumberByPort} metrics @param {number} port @returns {number} */
function getPortMetric(metrics, port) {
    const portKey = String(port);
    return metrics[portKey] || 0;
}

/** @param {number} childPort @returns {number|null} */
function getMergedMiningParentPort(childPort) {
    if (!global.coinFuncs || typeof global.coinFuncs.getPoolProfile !== "function" || typeof global.coinFuncs.getPORTS !== "function") return null;

    for (const parentPortValue of global.coinFuncs.getPORTS()) {
        const parentPort = Number(parentPortValue);
        const profile = global.coinFuncs.getPoolProfile(parentPort);
        const pool = profile && profile.pool;
        if (pool && Number(pool.dualSubmitReportPort) === Number(childPort) && pool.dualSubmitDisplayCoin) return parentPort;
    }

    return null;
}

/** @param {SharedStats} sharedStats @returns {{[key: string]: CoinStats}} */
function buildCoinMetadata(sharedStats) {
    /** @type {{[key: string]: CoinStats}} */
    const coins = Object.create(null);
    const lib2Coins = loadOptionalLib2Coins();

    global.coinFuncs.getPORTS().forEach(function build(portValue) {
        const port = Number(portValue);
        const portKey = String(portValue);
        const lib2Coin = lib2Coins[portKey] || lib2Coins[String(port)];
        const symbol = lib2Coin && typeof lib2Coin.symbol === "string" && lib2Coin.symbol ? lib2Coin.symbol : safePortCoin(port);
        const mergedMiningParentPort = getMergedMiningParentPort(port);
        const ownHashrate = getPortMetric(sharedStats.portHash, port);
        const ownMiners = getPortMetric(sharedStats.portMinerCount, port);
        /** @type {CoinStats} */
        const coin = {
            port,
            symbol,
            displayName: safePortDisplayCoin(port, symbol),
            algo: sharedStats.portCoinAlgo[portKey] || global.coinFuncs.algoShortTypeStr(port),
            active: Number(sharedStats.activePort) === port || sharedStats.activePorts.indexOf(port) !== -1,
            profit: sharedStats.coinProfit[portKey] || 0,
            comment: sharedStats.coinComment[portKey] || "",
            disabledReason: sharedStats.coinDisabledReason[portKey] || "",
            hashrate: ownHashrate || (mergedMiningParentPort === null ? 0 : getPortMetric(sharedStats.portHash, mergedMiningParentPort)),
            miners: ownMiners || (mergedMiningParentPort === null ? 0 : getPortMetric(sharedStats.portMinerCount, mergedMiningParentPort)),
            pplnsShare: sharedStats.pplnsPortShares[portKey] || 0,
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

/** @param {StatsSnapshot} snapshot @param {BlockSummary} blockSummary @param {AltBlockSummary} altBlockSummary @param {PaymentSummary} paymentSummary @param {SharedStats} sharedStats @returns {PoolStatsRecord} */
function buildPoolStatsRecord(snapshot, blockSummary, altBlockSummary, paymentSummary, sharedStats) {
    const coins = buildCoinMetadata(sharedStats);
    Object.keys(coins).forEach(function assignAltBlocks(port) {
        const coin = coins[port];
        if (coin) coin.altBlocksFound = altBlockSummary.altBlocksFound[port] || 0;
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

/** @param {unknown} value @returns {boolean} */
function normalizeBool(value) { return value === true || value === 1 || value === "1"; }

/** @param {number|string} difficulty @returns {number} */
function configuredPortTargetHashrate(difficulty) {
    const targetTime = global.config && global.config.pool && Number(global.config.pool.targetTime) > 0 ? Number(global.config.pool.targetTime) : 30;
    return Number(difficulty) / targetTime;
}

/** @param {ConfiguredPortRow} row @returns {ConfiguredPort} */
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

/** @param {ConfiguredPortRow} row @returns {string} */
function configuredMatchKey(row) {
    return [row.portType || "", Number(row.difficulty), row.portDesc || ""].join("|");
}

/** @param {ConfiguredPortRow[]} rows @returns {ConfiguredPort[]} */
function buildConfiguredPorts(rows) {
    const visibleRows = rows.filter(function visible(row) { return !normalizeBool(row.hidden); });
    const nonTls = visibleRows.filter(function noTls(row) { return !normalizeBool(row.ssl); });
    const tls = visibleRows.filter(function yesTls(row) { return normalizeBool(row.ssl); });
    /** @type {Record<string, ConfiguredPortRow[]>} */
    const tlsByKey = Object.create(null);
    /** @type {Record<string, boolean>} */
    const pairedTlsPorts = Object.create(null);
    /** @type {ConfiguredPort[]} */
    const configured = [];

    tls.forEach(function indexTls(row) {
        const key = configuredMatchKey(row);
        if (!tlsByKey[key]) tlsByKey[key] = [];
        const rowsForKey = tlsByKey[key];
        if (rowsForKey) rowsForKey.push(row);
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

/** @param {PoolServer|undefined} host @returns {PublicPoolHost|undefined} */
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

/** @param {PoolStatsRecord} stats @returns {string} */
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

/** @param {string} symbol @returns {Promise<number>} */
async function getCmcPrice(symbol) {
    const slug = global.config.coin.name.toLowerCase();
    const url =
        `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=${ 
        slug 
        }&convert=${ 
        symbol 
        }&CMC_PRO_API_KEY=${ 
        global.config.general.cmcKey}`;
    /** @type {Promise<unknown>} */
    const responsePromise = new Promise(function (resolve) {
        global.support.https_get(url, resolve);
    });
    const response = await responsePromise;
    const responseRecord = isRecord(response) ? response : null;
    const data = responseRecord && isRecord(responseRecord["data"]) ? responseRecord["data"] : null;
    const firstKey = data ? Object.keys(data)[0] : undefined;
    const firstKeyValue = firstKey === undefined || data === null ? undefined : data[firstKey];
    const firstCoin = isRecord(firstKeyValue) ? firstKeyValue : null;
    const quote = firstCoin && isRecord(firstCoin["quote"]) ? firstCoin["quote"] : null;
    const quoteEntry = quote && isRecord(quote[symbol]) ? quote[symbol] : null;
    const price = quoteEntry ? optionalNumber(quoteEntry["price"]) : undefined;

    if (typeof price === "number") return price;

    logger.logError("Price refresh", { status: "missing-quote", detail: JSON.stringify(response) });
    return 0;
}

/** @returns {Promise<PriceCache>} */
async function refreshPrices() {
    const [usd, eur, btc] = await Promise.all([getCmcPrice("USD"), getCmcPrice("EUR"), getCmcPrice("BTC")]);

    if (btc) priceCache.btc = btc;
    if (usd) priceCache.usd = usd;
    if (eur) priceCache.eur = eur;

    return priceCache;
}

/** @returns {Promise<{global: PaymentSummary, pplns: PaymentSummary}>} */
async function loadPaymentSummaries() {
    try {
        /** @type {Promise<Array<{miner_count: number|string}>>} */
        const minersPromise = global.mysql.query(
            "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments GROUP BY payment_address, payment_id) as miners"
        );
        /** @type {Promise<Array<{txn_count: number|string}>>} */
        const paymentsPromise = global.mysql.query("SELECT count(id) as txn_count FROM transactions");
        const [globalMiners, globalPayments] = await Promise.all([minersPromise, paymentsPromise]);
        const paymentSummary = {
            totalMinersPaid: globalMiners[0] ? finiteNumber(globalMiners[0].miner_count, 0) : 0,
            totalPayments: globalPayments[0] ? finiteNumber(globalPayments[0].txn_count, 0) : 0
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

/** @returns {Promise<{global: PoolStatsRecord, pplns: PoolStatsRecord}>} */
async function refreshPoolStats() {
    const minBlockRewards = numberMap(getCache("min_block_rewards", {}));
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

/** @param {Record<string, PoolServer>} poolServers @returns {Promise<PoolPortCache|false>} */
async function refreshPoolPorts(poolServers) {
    try {
        /** @type {Promise<PoolPortRow[]>} */
        const rowsPromise = global.mysql.query("select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE");
        /** @type {Promise<ConfiguredPortRow[]>} */
        const configuredRowsPromise = global.mysql.query("SELECT * FROM port_config WHERE hidden = 0");
        const [rows, configuredRows] = await Promise.all([rowsPromise, configuredRowsPromise]);
        /** @type {PoolPortCache} */
        const cache = { global: [], pplns: [], configured: buildConfiguredPorts(configuredRows) };
        const serverCount = Object.keys(poolServers).length;
        /** @type {Record<string, AggregatePort>} */
        const aggregateByPort = Object.create(null);

        rows.forEach(function (row) {
            if (row.port_type !== "pplns") return;

            const host = poolServers[String(row.pool_id)];
            cache.pplns.push({
                host: publicPoolHost(host),
                port: row.network_port,
                difficulty: row.starting_diff,
                description: row.description,
                miners: row.miners,
                tls: normalizeBool(row.ssl_port)
            });

            if (!host) return;
            const networkPort = String(row.network_port);
            if (!(networkPort in aggregateByPort)) {
                aggregateByPort[networkPort] = {
                    difficulty: row.starting_diff,
                    description: row.description,
                    miners: 0,
                    poolIds: Object.create(null),
                    host,
                    consistent: true,
                    tls: normalizeBool(row.ssl_port)
                };
            }

            const entry = aggregateByPort[networkPort];
            if (!entry) return;
            if (entry.difficulty !== row.starting_diff) entry.consistent = false;
            if (entry.tls !== normalizeBool(row.ssl_port)) entry.consistent = false;
            entry.poolIds[row.pool_id] = 1;
            entry.miners += row.miners;
        });

        Object.keys(aggregateByPort).forEach(function (port) {
            const entry = aggregateByPort[port];
            if (!entry) return;
            if (!entry.consistent || Object.keys(entry.poolIds).length !== serverCount) return;

            cache.global.push({
                host: {
                    blockID: entry.host.blockID,
                    blockIDTime: entry.host.blockIDTime,
                    xtmBlockID: entry.host.xtmBlockID,
                    xtmBlockIDTime: entry.host.xtmBlockIDTime,
                    hostname: global.config.pool.geoDNS || ""
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

/** @returns {Promise<Record<string, PoolServer>|false>} */
async function refreshPoolInformation() {
    try {
        /** @type {PoolServerRow[]} */
        const rows = await global.mysql.query(
            "select * from pools where id < 1000 and last_checkin >= NOW() - INTERVAL 10 MINUTE"
        );
        /** @type {Record<string, PoolServer>} */
        const poolServers = Object.create(null);

        rows.forEach(function (row) {
            const blockIDTime = row.blockIDTime === null || typeof row.blockIDTime === "undefined"
                ? null
                : global.support.formatDateFromSQL(row.blockIDTime);
            const xtmBlockIDTime = row.xtmBlockIDTime === null || typeof row.xtmBlockIDTime === "undefined"
                ? null
                : global.support.formatDateFromSQL(row.xtmBlockIDTime);
            /** @type {PoolServer} */
            const server = {
                blockID: row.blockID,
                blockIDTime,
                xtmBlockID: typeof row.xtmBlockID === "undefined" ? null : row.xtmBlockID,
                xtmBlockIDTime,
                hostname: row.hostname
            };
            if (typeof row.ip === "string") server.ip = row.ip;
            poolServers[String(row.id)] = server;
        });

        global.database.setCache("poolServers", poolServers);
        await refreshPoolPorts(poolServers);
        return poolServers;
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
        return false;
    }
}

/** @param {number} port @returns {Promise<HeaderReply>} */
function getHeader(port) {
    /** @type {Promise<HeaderReply>} */
    const headerPromise = new Promise(function (resolve) {
        global.coinFuncs.getPortLastBlockHeaderWithRewardDiff(port, function (error, body) {
            if (typeof body === "undefined") resolve({ error });
            else resolve({ error, body });
        }, true);
    });
    return headerPromise;
}

/** @param {number} port @returns {number} */
function getPoolHashesPerDifficulty(port) {
    if (!(global.coinFuncs && typeof global.coinFuncs.getPoolHashesPerDifficulty === "function")) return 1;
    const scale = Number(global.coinFuncs.getPoolHashesPerDifficulty(port));
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** @param {number} port @param {number} difficulty @returns {number} */
function networkDifficulty(port, difficulty) {
    if (global.coinFuncs && typeof global.coinFuncs.getPoolWorkDifficulty === "function") {
        return global.coinFuncs.getPoolWorkDifficulty(port, difficulty);
    }
    const value = Number(difficulty);
    if (!Number.isFinite(value)) return Number.parseInt(String(difficulty), 10);
    const scale = getPoolHashesPerDifficulty(port);
    return scale === 1 ? value : Math.round(value * scale);
}

/** @returns {Promise<NetworkInfo>} */
async function refreshBlockHeader() {
    const mainPort = Number(global.config.daemon.port);
    const ports = global.config.daemon.enableAlgoSwitching ? global.coinFuncs.getPORTS().map(Number) : [mainPort];
    /** @type {NetworkInfo} */
    const nextInfo = Object.assign({}, networkInfoCache);

    for (const port of ports) {
        const result = await getHeader(port);
        if (result.error || !result.body) continue;
        if (typeof result.body.difficulty !== "number" || !Number.isFinite(result.body.difficulty)) continue;
        const hash = typeof result.body.hash === "string" && result.body.hash
            ? result.body.hash
            : optionalString(result.body["hashrate"]) || "";
        const timestamp = optionalNumber(result.body.timestamp);

        nextInfo[String(port)] = {
            difficulty: networkDifficulty(port, result.body.difficulty),
            hash,
            height: result.body.height,
            ...(typeof result.body.reward === "undefined" ? {} : { value: result.body.reward }),
            ...(typeof timestamp === "number" ? { ts: timestamp } : {})
        };

        if (Number(port) !== mainPort) continue;

        // Mirror the active coin's header into legacy top-level fields that older API consumers read.
        nextInfo.difficulty = networkDifficulty(port, result.body.difficulty);
        nextInfo.hash = hash;
        nextInfo.main_height = result.body.height;
        nextInfo.height = result.body.height;
        if (typeof result.body.reward === "number") nextInfo.value = result.body.reward;
        if (typeof timestamp === "number") nextInfo.ts = timestamp;
    }

    networkInfoCache = nextInfo;
    global.database.setCache("networkBlockInfo", networkInfoCache);
    return networkInfoCache;
}

/** @param {UnknownRecord} values @returns {string} */
function daemonFailBody(values) {
    const body = renderEmailTemplate(
        "statsDaemonFailBody",
        values,
        "The worker failed to return last block header for %(port)s port. Error detail: %(error)s. Please verify if the daemon or merged-mining relay is running properly."
    );
    const error = String(values["error"]);
    return body.includes(error) ? body : `${body  }\n\nError detail: ${  error}`;
}

/** @param {number} port @param {unknown} error @returns {void} */
function badHeaderStart(port, error) {
    const values = { port, error: formatError(error) };
    logger.logError("Node monitor", { port, status: "header-unavailable", error: values.error, detail: "skipping node monitor" });
    const previousFailures = lastBlockCheckFailures[String(port)];
    if (typeof previousFailures === "number") {
        const failureCount = previousFailures + 1;
        lastBlockCheckFailures[String(port)] = failureCount;
        if (failureCount >= 5) {
            global.support.sendEmail(
                global.config.general.adminEmail,
                renderEmailTemplate("statsDaemonFailSubject", values, "Failed to query daemon for %(port)s port for last block header"),
                daemonFailBody(values)
            );
        }
        return;
    }
    lastBlockCheckFailures[String(port)] = 1;
}

/** @param {number} port @returns {void} */
function badHeaderStop(port) {
    const failureCount = lastBlockCheckFailures[String(port)];
    if (typeof failureCount !== "number") return;

    if (failureCount >= 5) {
        const values = { port };
        global.support.sendEmail(
            global.config.general.adminEmail,
            renderEmailTemplate("statsDaemonRecoverSubject", values, "Querying daemon for %(port)s port for last block header is back to normal"),
            renderEmailTemplate("statsDaemonRecoverBody", values, "A warning was sent to you indicating that the worker failed to return the last block header for %(port)s port. The issue seems to be solved now.")
        );
    }

    delete lastBlockCheckFailures[String(port)];
}

/** @param {number} port @returns {Promise<HeaderReply>} */
function getLastBlockHeaderMM(port) {
    /** @type {Promise<HeaderReply>} */
    const headerPromise = new Promise(function (resolve) {
        /** @type {import("../types/runtime").CoinCallback<BlockHeader>} */
        const callback = function (error, block) {
            if (typeof block === "undefined") resolve({ error });
            else resolve({ error, body: block });
        };
        if (typeof global.coinFuncs.getPortLastBlockHeaderMM === "function") {
            global.coinFuncs.getPortLastBlockHeaderMM(port, callback, true);
            return;
        }
        global.coinFuncs.getPortLastBlockHeader(port, callback, true);
    });
    return headerPromise;
}

/** @param {unknown} hostname @returns {string} */
function poolNodeLabel(hostname) {
    const raw = typeof hostname === "string" ? hostname.trim() : "";
    if (!raw) return "unknown";
    return raw.replace(/\.moneroocean\.stream$/i, "").split(".")[0] || raw;
}

/** @param {MonitorRow} row @param {number} lag @param {string|undefined} chain @returns {{subject: string, body: string}} */
function formatBehindBlocksEmail(row, lag, chain) {
    const node = poolNodeLabel(row.hostname);
    const values = { node, lag, port: row.port };
    const chainLabel = chain ? `${chain  } ` : "";
    return {
        subject: renderEmailTemplate("statsBehindBlocksSubject", values, "Pool node %(node)s is %(lag)s blocks behind"),
        body: renderEmailTemplate("statsBehindBlocksBody", values, `Pool node %(node)s is %(lag)s blocks behind for ${  chainLabel  }%(port)s port`)
    };
}

/** @param {MonitorRow} row @param {number} lag @param {string|undefined} chain @returns {void} */
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

/** @returns {Promise<MonitorRow[]>} */
async function queryNodeMonitorRows() {
    if (!supportsXtmPoolColumns) {
        /** @type {Promise<MonitorRow[]>} */
        const rowsPromise = global.mysql.query(
            "SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
        return rowsPromise;
    }

    try {
        /** @type {Promise<MonitorRow[]>} */
        const rowsPromise = global.mysql.query(
            "SELECT blockID, xtmBlockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
        return await rowsPromise;
    } catch (error) {
        if (!missingXtmPoolColumn(error)) throw error;
        supportsXtmPoolColumns = false;
        /** @type {Promise<MonitorRow[]>} */
        const rowsPromise = global.mysql.query(
            "SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
        );
        return rowsPromise;
    }
}

/** @returns {Promise<boolean>} */
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

        let topXmrHeight = 0;
        let topXtmHeight = 0;
        rows.forEach(function (row) {
            if (row.port && Number(row.port) !== mainPort) {
                logger.logError("Node monitor", {
                    port: row.port,
                    status: "pool-port-mismatch",
                    detail: `master port ${  mainPort}`
                });
                return;
            }

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

        // The pool master owns lag grace/cooldown and daemon recovery; stats only reports lag.

        return true;
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
        return false;
    }
}

/** @template T @param {string} name @param {() => Promise<T>} task @returns {Promise<T|null>} */
async function runTask(name, task) {
    try {
        return await task();
    } catch (error) {
        logger.logError(`Pool stats ${  name}`, { status: "failed", detail: formatError(error) });
        return null;
    }
}

/** @param {string} name @param {number} intervalMs @param {() => Promise<unknown>} task @returns {void} */
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

/** @returns {Promise<void>} */
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
