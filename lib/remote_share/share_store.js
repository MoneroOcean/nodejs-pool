"use strict";
const poolTypeStr = require("../common/pool_type.js");

function ensureCacheEntry(cacheUpdates, key, factory) {
    if (!(key in cacheUpdates)) cacheUpdates[key] = factory();
    return cacheUpdates[key];
}

function getMinerId(share) {
    return typeof share.paymentID !== "undefined" && share.paymentID.length > 10
        ? share.paymentAddress + "." + share.paymentID
        : share.paymentAddress;
}

function mergeCacheEntry(txn, cacheDb, key, nextValue) {
    const cacheStore = txn.getString(cacheDb, key);
    if (cacheStore === null) {
        txn.putString(cacheDb, key, JSON.stringify(nextValue));
        return;
    }

    const cached = JSON.parse(cacheStore);
    if ("totalHashes" in nextValue) {
        cached.totalHashes = (cached.totalHashes || 0) + nextValue.totalHashes;
    }
    if ("goodShares" in nextValue) {
        cached.goodShares = (cached.goodShares || 0) + nextValue.goodShares;
    }
    if ("roundHashes" in nextValue) {
        if (nextValue.roundHashes === false) {
            cached.roundHashes = 0;
        } else {
            cached.roundHashes = (cached.roundHashes || 0) + nextValue.roundHashes;
        }
    }
    txn.putString(cacheDb, key, JSON.stringify(cached));
}

function applyShareCacheUpdates(cacheUpdates, share, defaultStatsPort) {
    const minerID = getMinerId(share);
    const minerWorkerID = minerID + "_" + share.identifier;
    const shareNum = typeof share.share_num !== "undefined" && share.share_num ? share.share_num : 1;
    const globalStatsKey = "global_stats2";
    const statsTypeKey = poolTypeStr(share.poolType) + "_stats2";
    const minerEntry = ensureCacheEntry(cacheUpdates, minerID, function createMinerEntry() { return { totalHashes: 0, goodShares: 0 }; });
    const workerEntry = ensureCacheEntry(cacheUpdates, minerWorkerID, function createWorkerEntry() { return { totalHashes: 0, goodShares: 0 }; });
    const statsTypeEntry = ensureCacheEntry(cacheUpdates, statsTypeKey, function createStatsEntry() { return { totalHashes: 0, roundHashes: 0 }; });
    let portSuffix = typeof share.port !== "undefined" && share.port !== global.config.daemon.port ? "_" + share.port.toString() : "";

    if (portSuffix === "") {
        cacheUpdates[globalStatsKey].totalHashes += share.raw_shares;
        cacheUpdates[globalStatsKey].roundHashes += share.raw_shares;
        statsTypeEntry.totalHashes += share.raw_shares;
        statsTypeEntry.roundHashes += share.raw_shares;
        portSuffix = "_" + defaultStatsPort.toString();
    }
    if (portSuffix !== "") {
        const globalPortEntry = ensureCacheEntry(cacheUpdates, globalStatsKey + portSuffix, function createPortGlobalEntry() { return { totalHashes: 0, roundHashes: 0 }; });
        const statsPortEntry = ensureCacheEntry(cacheUpdates, statsTypeKey + portSuffix, function createPortStatsEntry() { return { totalHashes: 0, roundHashes: 0 }; });
        cacheUpdates[globalStatsKey].totalHashes += share.raw_shares;
        globalPortEntry.totalHashes += share.raw_shares;
        globalPortEntry.roundHashes += share.raw_shares;
        statsTypeEntry.totalHashes += share.raw_shares;
        statsPortEntry.totalHashes += share.raw_shares;
        statsPortEntry.roundHashes += share.raw_shares;
    }
    minerEntry.totalHashes += share.raw_shares;
    minerEntry.goodShares += shareNum;
    workerEntry.totalHashes += share.raw_shares;
    workerEntry.goodShares += shareNum;
}

module.exports = function createShareStore(options) {
    const database = options && options.database ? options.database : global.database;

    return {
        storeShares(shares) {
            if (!Array.isArray(shares) || shares.length === 0) return false;

            const cacheUpdates = Object.create(null);
            cacheUpdates.global_stats2 = { totalHashes: 0, roundHashes: 0 };

            const mainProfile = global.coinFuncs.getPoolProfile(global.config.daemon.port);
            const defaultStatsCoin = mainProfile && mainProfile.pool ? mainProfile.pool.dualSubmitDisplayCoin : null;
            const defaultStatsPort = defaultStatsCoin ? global.coinFuncs.COIN2PORT(defaultStatsCoin) : global.config.daemon.port;

            for (const share of shares) {
                if (typeof share.raw_shares !== "number") {
                    console.error("Error in share parser: " + JSON.stringify(share));
                    continue;
                }

                applyShareCacheUpdates(cacheUpdates, share, defaultStatsPort);
            }

            const txn = database.env.beginTxn();
            try {
                for (const key of Object.keys(cacheUpdates)) {
                    mergeCacheEntry(txn, database.cacheDB, key, cacheUpdates[key]);
                }

                for (const share of shares) {
                    if (typeof share.raw_shares !== "number") continue;
                    txn.putBinary(database.shareDB, share.blockHeight, global.protos.Share.encode(share));
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
