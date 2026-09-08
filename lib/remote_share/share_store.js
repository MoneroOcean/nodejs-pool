"use strict";
const poolTypeStr = require("../common/pool_type.js");
const { getLocalDatabase } = require("../common/database.js");

/** @typedef {import("../../types/runtime").LocalDatabaseRuntime} LocalDatabaseRuntime */
/** @typedef {import("../../types/runtime").LmdbDbi} ShareDbi */
/** @typedef {import("../../types/runtime").LmdbTxn} ShareTransaction */

/** @typedef {import("../../types/runtime").ShareMessage & {raw_shares: number, paymentID?: string|null}} Share */

/**
 * @typedef {object} CacheEntry
 * @property {number|undefined} [totalHashes]
 * @property {number|undefined} [goodShares]
 * @property {number|false|undefined} [roundHashes]
 */

/**
 * @typedef {object} ShareDatabase
 * @property {{beginTxn: () => ShareTransaction}} env
 * @property {unknown} cacheDB
 * @property {unknown} shareDB
 */

/**
 * @typedef {object} ShareStoreOptions
 * @property {LocalDatabaseRuntime} [database]
 */

/**
 * @typedef {object} ShareStore
 * @property {(shares: unknown[]) => boolean} storeShares
 */

/**
 * @param {Record<string, CacheEntry>} cacheUpdates
 * @param {string} key
 * @param {() => CacheEntry} factory
 * @returns {CacheEntry}
 */
function ensureCacheEntry(cacheUpdates, key, factory) {
    const existing = cacheUpdates[key];
    if (existing) return existing;
    const created = factory();
    cacheUpdates[key] = created;
    return created;
}

// blockHeight is the LMDB key for shareDB (opened keyIsUint32). node-lmdb throws
// synchronously for any non-uint32 key, and that throw propagates uncaught out of the
// share-flush timer and kills the master uplink process. A crafted remote-share frame
// can set blockHeight to a negative/out-of-range int32, so validate before storing.
// raw_shares is a proto float (wire NaN/Infinity decode to JS numbers with
// typeof === "number"); accept only finite values so a malformed frame cannot poison
// the cumulative totalHashes/roundHashes accumulators below.
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return value !== null && typeof value === "object";
}

/**
 * @param {unknown} value
 * @returns {value is CacheEntry}
 */
function isCacheEntry(value) {
    if (!isRecord(value)) return false;
    const totalHashes = value["totalHashes"];
    const goodShares = value["goodShares"];
    const roundHashes = value["roundHashes"];
    return (typeof totalHashes === "undefined" || typeof totalHashes === "number") &&
        (typeof goodShares === "undefined" || typeof goodShares === "number") &&
        (typeof roundHashes === "undefined" || typeof roundHashes === "number" || roundHashes === false);
}

/**
 * @param {unknown} value
 * @returns {value is Share}
 */
function isStorableShare(value) {
    if (!isRecord(value)) return false;
    const share = value;
    const paymentAddress = share["paymentAddress"];
    const identifier = share["identifier"];
    const poolType = share["poolType"];
    const rawShares = share["raw_shares"];
    const blockHeight = share["blockHeight"];
    const foundBlock = share["foundBlock"];
    const trustedShare = share["trustedShare"];
    const poolId = share["poolID"];
    const blockDiff = share["blockDiff"];
    const timestamp = share["timestamp"];
    const paymentId = share["paymentID"];
    const port = share["port"];
    const shares = share["shares"];
    const shares2 = share["shares2"];
    const shareNum = share["share_num"];
    /** @param {unknown} item @returns {boolean} */
    const isOptionalInteger = (item) => typeof item === "undefined" || (typeof item === "number" && Number.isInteger(item));
    return typeof paymentAddress === "string" &&
        typeof identifier === "string" &&
        typeof poolType === "number" && Number.isInteger(poolType) && poolType >= 0 && poolType <= 3 &&
        typeof rawShares === "number" &&
        Number.isFinite(rawShares) &&
        typeof blockHeight === "number" &&
        Number.isSafeInteger(blockHeight) &&
        blockHeight >= 0 && blockHeight <= 0xffffffff &&
        typeof foundBlock === "boolean" &&
        typeof trustedShare === "boolean" &&
        typeof poolId === "number" && Number.isInteger(poolId) && poolId >= -0x80000000 && poolId <= 0x7fffffff &&
        typeof blockDiff === "number" && Number.isInteger(blockDiff) &&
        typeof timestamp === "number" && Number.isInteger(timestamp) &&
        (typeof paymentId === "undefined" || paymentId === null || typeof paymentId === "string") &&
        (typeof port === "undefined" || (typeof port === "number" && Number.isSafeInteger(port) && port >= -0x80000000 && port <= 0x7fffffff)) &&
        isOptionalInteger(shares) && isOptionalInteger(shares2) && isOptionalInteger(shareNum);
}

/** @param {Share} share @returns {string} */
function getMinerId(share) {
    return typeof share.paymentID === "string" && share.paymentID.length > 10
        ? `${share.paymentAddress  }.${  share.paymentID}`
        : share.paymentAddress;
}

/**
 * @param {ShareTransaction} txn
 * @param {ShareDbi} cacheDb
 * @param {string} key
 * @param {CacheEntry} nextValue
 * @returns {void}
 */
function mergeCacheEntry(txn, cacheDb, key, nextValue) {
    const cacheStore = txn.getString(cacheDb, key);
    if (cacheStore === null) {
        txn.putString(cacheDb, key, JSON.stringify(nextValue));
        return;
    }

    const cachedValue = JSON.parse(cacheStore);
    if (!isCacheEntry(cachedValue)) throw new Error(`Invalid cache entry for ${  key}`);
    const cached = cachedValue;
    if (typeof nextValue.totalHashes === "number") {
        cached.totalHashes = (cached.totalHashes || 0) + nextValue.totalHashes;
    }
    if (typeof nextValue.goodShares === "number") {
        cached.goodShares = (cached.goodShares || 0) + nextValue.goodShares;
    }
    if (typeof nextValue.roundHashes !== "undefined") {
        if (nextValue.roundHashes === false) {
            cached.roundHashes = 0;
        } else {
            cached.roundHashes = (cached.roundHashes || 0) + nextValue.roundHashes;
        }
    }
    txn.putString(cacheDb, key, JSON.stringify(cached));
}

/** @param {CacheEntry} entry @param {number} value @returns {void} */
function addTotalHashes(entry, value) {
    entry.totalHashes = (entry.totalHashes || 0) + value;
}

/** @param {CacheEntry} entry @param {number} value @returns {void} */
function addRoundHashes(entry, value) {
    entry.roundHashes = (entry.roundHashes === false ? 0 : entry.roundHashes || 0) + value;
}

/** @param {CacheEntry} entry @param {number} value @returns {void} */
function addGoodShares(entry, value) {
    entry.goodShares = (entry.goodShares || 0) + value;
}

/**
 * @param {Record<string, CacheEntry>} cacheUpdates
 * @param {Share} share
 * @param {number} defaultStatsPort
 * @returns {void}
 */
function applyShareCacheUpdates(cacheUpdates, share, defaultStatsPort) {
    const minerID = getMinerId(share);
    const minerWorkerID = `${minerID  }_${  share.identifier}`;
    const shareNum = typeof share.share_num !== "undefined" && share.share_num ? share.share_num : 1;
    const globalStatsKey = "global_stats2";
    const globalStatsEntry = ensureCacheEntry(cacheUpdates, globalStatsKey, function createGlobalEntry() { return { totalHashes: 0, roundHashes: 0 }; });
    const statsTypeKey = `${poolTypeStr(share.poolType)  }_stats2`;
    const minerEntry = ensureCacheEntry(cacheUpdates, minerID, function createMinerEntry() { return { totalHashes: 0, goodShares: 0 }; });
    const workerEntry = ensureCacheEntry(cacheUpdates, minerWorkerID, function createWorkerEntry() { return { totalHashes: 0, goodShares: 0 }; });
    const statsTypeEntry = ensureCacheEntry(cacheUpdates, statsTypeKey, function createStatsEntry() { return { totalHashes: 0, roundHashes: 0 }; });
    let portSuffix = typeof share.port !== "undefined" && share.port !== global.config.daemon.port ? `_${  share.port.toString()}` : "";

    if (portSuffix === "") {
        addTotalHashes(globalStatsEntry, share.raw_shares);
        addRoundHashes(globalStatsEntry, share.raw_shares);
        addTotalHashes(statsTypeEntry, share.raw_shares);
        addRoundHashes(statsTypeEntry, share.raw_shares);
        portSuffix = `_${  defaultStatsPort.toString()}`;
    }
    if (portSuffix !== "") {
        const globalPortEntry = ensureCacheEntry(cacheUpdates, globalStatsKey + portSuffix, function createPortGlobalEntry() { return { totalHashes: 0, roundHashes: 0 }; });
        const statsPortEntry = ensureCacheEntry(cacheUpdates, statsTypeKey + portSuffix, function createPortStatsEntry() { return { totalHashes: 0, roundHashes: 0 }; });
        addTotalHashes(globalStatsEntry, share.raw_shares);
        addTotalHashes(globalPortEntry, share.raw_shares);
        addRoundHashes(globalPortEntry, share.raw_shares);
        addTotalHashes(statsTypeEntry, share.raw_shares);
        addTotalHashes(statsPortEntry, share.raw_shares);
        addRoundHashes(statsPortEntry, share.raw_shares);
    }
    addTotalHashes(minerEntry, share.raw_shares);
    addGoodShares(minerEntry, shareNum);
    addTotalHashes(workerEntry, share.raw_shares);
    addGoodShares(workerEntry, shareNum);
}

/**
 * @param {ShareStoreOptions|undefined} options
 * @returns {ShareStore}
 */
module.exports = function createShareStore(options) {
    const database = getLocalDatabase(options && options.database ? options.database : global.database);

    return {
        storeShares(shares) {
            if (!Array.isArray(shares) || shares.length === 0) return false;

            /** @type {Record<string, CacheEntry>} */
            const cacheUpdates = Object.create(null);
            cacheUpdates["global_stats2"] = { totalHashes: 0, roundHashes: 0 };

            const mainProfile = global.coinFuncs.getPoolProfile(global.config.daemon.port);
            const defaultStatsCoin = mainProfile && mainProfile.pool && typeof mainProfile.pool["dualSubmitDisplayCoin"] === "string"
                ? mainProfile.pool["dualSubmitDisplayCoin"]
                : null;
            const defaultStatsPort = defaultStatsCoin
                ? global.coinFuncs.COIN2PORT(defaultStatsCoin) ?? global.config.daemon.port
                : global.config.daemon.port;

            for (const share of shares) {
                if (!isStorableShare(share)) {
                    console.error(`Error in share parser: ${  JSON.stringify(share)}`);
                    continue;
                }

                applyShareCacheUpdates(cacheUpdates, share, defaultStatsPort);
            }

            const txn = database.env.beginTxn();
            try {
                for (const key of Object.keys(cacheUpdates)) {
                    const cacheEntry = cacheUpdates[key];
                    if (cacheEntry) mergeCacheEntry(txn, database.cacheDB, key, cacheEntry);
                }

                for (const share of shares) {
                    if (!isStorableShare(share)) continue;
                    // Mining code historically uses null for an absent payment ID. The wire
                    // encoder expects that optional field to be omitted, so normalize it here.
                    if (share.paymentID === null) {
                        const { paymentID: _paymentID, ...withoutPaymentId } = share;
                        txn.putBinary(database.shareDB, share.blockHeight, global.protos.Share.encode(withoutPaymentId));
                    } else {
                        txn.putBinary(database.shareDB, share.blockHeight, global.protos.Share.encode(share));
                    }
                }

                txn.commit();
                return true;
            } catch (error) {
                txn.abort();
                throw error;
            }
        }
    };
};
