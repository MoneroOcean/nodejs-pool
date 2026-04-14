"use strict";

const debug = require("debug")("worker");
const cacheUpdateMarker = require("./cache_update_marker");
const recentShareWindow = require("./recent_share_window");
const workerHistory = require("./worker_history");

const HASHRATE_AVG_MIN = 10;
const STAT_CHANGE_ALERT = 0.6;
const STATS_INTERVAL_MS = recentShareWindow.SLOT_INTERVAL_MS;
const HISTORY_INTERVAL_MS = 2 * 60 * 1000;
const CACHE_WRITE_BATCH_SIZE = 500;
const CACHE_MARKER_KEY = "cacheUpdate";
const EMAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STARTED_HASHING_TTL_MS = 20 * 60 * 1000;
const PPLNS_POOL_TYPE = global.protos.POOLTYPE.PPLNS;

function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readCacheJson(txn, key) {
    try {
        const cached = txn.getString(global.database.cacheDB, key);
        if (cached === null) return false;
        return JSON.parse(cached);
    } catch (_error) {
        console.error("Bad cache data with " + key + " key");
        return false;
    }
}

function setToCacheObject(values) {
    const result = Object.create(null);
    for (const value of values) result[value] = 1;
    return result;
}

function cacheObjectToSet(value) {
    const result = new Set();
    if (!value || typeof value !== "object") return result;
    Object.keys(value).forEach(function (key) {
        result.add(key);
    });
    return result;
}

function getMinerParts(miner) {
    return miner.split(/_(.+)/);
}

function isWorkerKey(miner) {
    return miner.indexOf("_") >= 0;
}

function trimArrayToLength(values, maxLength) {
    while (values.length > maxLength) values.pop();
    return values;
}

function writeCacheBatch(entries) {
    if (entries.length === 0) return 0;

    const startedAt = Date.now();
    const txn = global.database.env.beginTxn();
    for (let index = 0; index < entries.length; ++index) {
        txn.putString(global.database.cacheDB, entries[index][0], entries[index][1]);
    }
    txn.commit();
    return Date.now() - startedAt;
}

class CacheUpdateBatcher {
    constructor(batchSize) {
        this.batchSize = batchSize;
        this.entries = [];
        this.totalWriteMs = 0;
        this.flushCount = 0;
        this.markerActive = false;
    }

    set(key, value) {
        this.entries.push([key, JSON.stringify(value)]);
        if (this.entries.length >= this.batchSize) this.flush();
    }

    ensureMarker() {
        if (this.markerActive) return;
        const startedAt = Date.now();
        const txn = global.database.env.beginTxn();
        cacheUpdateMarker.acquireCacheUpdateMarker(txn, global.database.cacheDB, CACHE_MARKER_KEY);
        txn.commit();
        this.totalWriteMs += Date.now() - startedAt;
        this.markerActive = true;
    }

    flush() {
        if (this.entries.length === 0) return;
        this.ensureMarker();
        const entries = this.entries;
        this.entries = [];
        this.totalWriteMs += writeCacheBatch(entries);
        this.flushCount += 1;
    }

    close() {
        this.flush();
        if (!this.markerActive) return;

        const startedAt = Date.now();
        const txn = global.database.env.beginTxn();
        cacheUpdateMarker.releaseCacheUpdateMarker(txn, global.database.cacheDB, CACHE_MARKER_KEY);
        txn.commit();
        this.totalWriteMs += Date.now() - startedAt;
        this.markerActive = false;
    }

    abort() {
        this.entries = [];
        if (!this.markerActive) return;

        try {
            const txn = global.database.env.beginTxn();
            cacheUpdateMarker.releaseCacheUpdateMarker(txn, global.database.cacheDB, CACHE_MARKER_KEY);
            txn.commit();
        } catch (_error) {}
        this.markerActive = false;
    }
}

function createWorkerRuntime() {
    const state = {
        prevPoolStateTime: 0,
        prevPoolHashrate: 0,
        prevPoolWorkers: 0,
        minerEmail: Object.create(null),
        minerEmailTime: Object.create(null),
        workersStartedHashingTime: Object.create(null),
        workersStoppedHashingTime: Object.create(null),
        workersStoppedHashingEmailTime: Object.create(null),
        historyLayoutCache: null,
        historyLayoutLogged: false,
        nextHistoryAt: 0,
        started: false,
        pruneTimer: null
    };

    function getHistoryLayout(statsBufferLength, statsBufferHours) {
        const cachedLayout = state.historyLayoutCache;
        if (
            cachedLayout &&
            cachedLayout.statsBufferLength === statsBufferLength &&
            cachedLayout.statsBufferHours === statsBufferHours
        ) {
            return cachedLayout.layout;
        }

        const layout = workerHistory.buildTierLayout(statsBufferLength, statsBufferHours);
        state.historyLayoutCache = {
            statsBufferLength: statsBufferLength,
            statsBufferHours: statsBufferHours,
            layout: layout
        };
        return layout;
    }

    function pruneTransientState() {
        const currentTime = Date.now();

        Object.keys(state.minerEmailTime).forEach(function (address) {
            if (currentTime - state.minerEmailTime[address] <= EMAIL_CACHE_TTL_MS) return;
            delete state.minerEmailTime[address];
            delete state.minerEmail[address];
        });

        Object.keys(state.workersStartedHashingTime).forEach(function (miner) {
            if (currentTime - state.workersStartedHashingTime[miner] <= STARTED_HASHING_TTL_MS) return;
            delete state.workersStartedHashingTime[miner];
        });
    }

    function getAddressEmail(address, callback) {
        const currentTime = Date.now();
        if (!(address in state.minerEmailTime) || currentTime - state.minerEmailTime[address] > 10 * 60 * 1000) {
            state.minerEmailTime[address] = currentTime;
            state.minerEmail[address] = null;
            global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [address]).then(function (rows) {
                if (rows.length === 0) {
                    delete state.minerEmail[address];
                    return;
                }

                state.minerEmail[address] = rows[0].email;
                callback(state.minerEmail[address]);
            }).catch(function (error) {
                console.error("Can't get email address for " + address + ": " + error.message);
            });
            return;
        }

        if (!(address in state.minerEmail)) return;
        if (state.minerEmail[address] === null) {
            if (currentTime - state.minerEmailTime[address] < 5 * 1000) {
                setTimeout(getAddressEmail, 10 * 1000, address, callback);
            }
            return;
        }

        callback(state.minerEmail[address]);
    }

    function sendWorkerStartedHashingEmail(miner, email, currentTime) {
        const addressParts = getMinerParts(miner);
        const address = addressParts[0];
        const worker = addressParts[1];
        const emailData = {
            worker: worker,
            timestamp: global.support.formatDate(currentTime),
            poolEmailSig: global.config.general.emailSig
        };

        global.support.sendEmail(
            email,
            global.support.formatTemplate(global.config.email.workerStartHashingSubject, emailData),
            global.support.formatTemplate(global.config.email.workerStartHashingBody, emailData),
            address
        );
    }

    function delayedSendWorkerStoppedHashingEmail(miner, currentTime) {
        if (miner in state.workersStartedHashingTime && Date.now() - state.workersStartedHashingTime[miner] <= 10 * 60 * 1000) {
            delete state.workersStartedHashingTime[miner];
            return;
        }

        delete state.workersStartedHashingTime[miner];

        const addressParts = getMinerParts(miner);
        const address = addressParts[0];

        getAddressEmail(address, function (email) {
            state.workersStoppedHashingEmailTime[miner] = Date.now();
            const emailData = {
                worker: addressParts[1],
                timestamp: global.support.formatDate(currentTime),
                poolEmailSig: global.config.general.emailSig
            };

            global.support.sendEmail(
                email,
                global.support.formatTemplate(global.config.email.workerNotHashingSubject, emailData),
                global.support.formatTemplate(global.config.email.workerNotHashingBody, emailData),
                address
            );
        });
    }

    function updateWorkerTransitions(activeMinerKeys, previousMinerKeys, currentTime, readTxn, batcher) {
        for (const miner of previousMinerKeys) {
            if (activeMinerKeys.has(miner)) continue;

            const minerStats = readCacheJson(readTxn, miner);
            if (!minerStats) continue;

            minerStats.hash = 0;
            batcher.set(miner, minerStats);

            if (!isWorkerKey(miner)) continue;

            const worker = getMinerParts(miner)[1];
            if (typeof worker === "undefined" || worker.includes("silent")) continue;
            if (miner in state.workersStoppedHashingTime) continue;

            state.workersStoppedHashingTime[miner] = currentTime;
            setTimeout(delayedSendWorkerStoppedHashingEmail, 10 * 60 * 1000, miner, currentTime);
        }

        for (const miner of activeMinerKeys) {
            if (previousMinerKeys.has(miner) || !isWorkerKey(miner)) continue;

            const addressParts = getMinerParts(miner);
            const worker = addressParts[1];
            if (typeof worker === "undefined" || worker.includes("silent")) continue;

            state.workersStartedHashingTime[miner] = currentTime;
            if (!(miner in state.workersStoppedHashingEmailTime)) continue;

            delete state.workersStoppedHashingTime[miner];
            delete state.workersStoppedHashingEmailTime[miner];
            getAddressEmail(addressParts[0], function (email) {
                sendWorkerStartedHashingEmail(miner, email, currentTime);
            });
        }
    }

    function mergeIdentifier(identifiers, address, identifier) {
        if (typeof identifier !== "string" || identifier.length === 0) return;
        let identifierSet = identifiers.get(address);
        if (!identifierSet) {
            identifierSet = new Set();
            identifiers.set(address, identifierSet);
        }
        identifierSet.add(identifier);
    }

    function mergeMinerSummary(minerStats, miner, rawShares, shares2, lastHash, port, hasPplns) {
        if (!shares2) return;

        let summary = minerStats.get(miner);
        if (!summary) {
            summary = { rawShares: 0, shares2: 0, lastHash: lastHash, port: port, hasPplns: !!hasPplns };
            minerStats.set(miner, summary);
        }

        summary.rawShares += rawShares;
        summary.shares2 += shares2;
        if (summary.lastHash < lastHash) {
            summary.lastHash = lastHash;
            summary.port = port;
        }
        if (hasPplns) summary.hasPplns = true;
    }

    function applyShareToSnapshot(share, bounds, identifiers, minerStats, portHashes, localStats, localTimes) {
        if (share.timestamp < bounds.identifierStart || share.timestamp >= bounds.alignedNow) return;

        const minerID = recentShareWindow.getMinerId(share);
        mergeIdentifier(identifiers, minerID, share.identifier);

        if (share.timestamp < bounds.hashStart) return;

        const shares2 = share.shares2;
        localStats.global += shares2;
        if (localTimes.global < share.timestamp) localTimes.global = share.timestamp;

        const isPplnsShare = share.poolType === PPLNS_POOL_TYPE;
        if (isPplnsShare) {
            localStats.pplns += shares2;
            if (localTimes.pplns < share.timestamp) localTimes.pplns = share.timestamp;
        }

        const port = typeof share.port !== "undefined" && share.port ? share.port : global.config.daemon.port;
        portHashes.set(port, (portHashes.get(port) || 0) + share.raw_shares);

        if (!shares2) return;

        mergeMinerSummary(minerStats, minerID, share.raw_shares, shares2, share.timestamp, port, isPplnsShare);
        if (typeof share.identifier === "string" && share.identifier.length > 0) {
            mergeMinerSummary(minerStats, minerID + "_" + share.identifier, share.raw_shares, shares2, share.timestamp, port, isPplnsShare);
        }
    }

    function applySlotToSnapshot(slotPayload, bounds, identifiers, minerStats, portHashes, localStats, localTimes) {
        Object.keys(slotPayload.identifiers).forEach(function (address) {
            Object.keys(slotPayload.identifiers[address]).forEach(function (identifier) {
                mergeIdentifier(identifiers, address, identifier);
            });
        });

        if (recentShareWindow.getSlotStart(slotPayload.slot) < bounds.hashStart) return;

        localStats.global += slotPayload.globalShares2;
        localStats.pplns += slotPayload.pplnsShares2;
        if (localTimes.global < slotPayload.globalLastHash) localTimes.global = slotPayload.globalLastHash;
        if (localTimes.pplns < slotPayload.pplnsLastHash) localTimes.pplns = slotPayload.pplnsLastHash;

        Object.keys(slotPayload.portHashes).forEach(function (port) {
            const numericPort = normalizePositiveInteger(port, global.config.daemon.port);
            portHashes.set(numericPort, (portHashes.get(numericPort) || 0) + slotPayload.portHashes[port]);
        });

        Object.keys(slotPayload.miners).forEach(function (miner) {
            const entry = slotPayload.miners[miner];
            mergeMinerSummary(minerStats, miner, entry[0], entry[1], entry[2], entry[3], entry[4] === 1);
        });
    }

    function buildActiveMinerState(minerStats) {
        const activeMinerKeys = new Set();
        const minerPorts = new Map();
        const localMinerCount = { pplns: 0, global: 0 };

        for (const [miner, summary] of minerStats.entries()) {
            if (!summary.shares2) continue;
            activeMinerKeys.add(miner);
            if (isWorkerKey(miner)) continue;
            minerPorts.set(miner, summary.port);
            localMinerCount.global += 1;
            if (summary.hasPplns) localMinerCount.pplns += 1;
        }

        return {
            activeMinerKeys,
            minerPorts,
            localMinerCount
        };
    }

    function shouldRunHistoryTick(currentTime) {
        if (!state.nextHistoryAt) {
            state.nextHistoryAt = currentTime + HISTORY_INTERVAL_MS;
            return true;
        }

        if (currentTime < state.nextHistoryAt) return false;
        do {
            state.nextHistoryAt += HISTORY_INTERVAL_MS;
        } while (state.nextHistoryAt <= currentTime);
        return true;
    }

    function updateShareStats2(height, callback) {
        const currentTime = Date.now();
        const windowBounds = recentShareWindow.getHybridWindowBounds(currentTime);
        const expectedWindowSlotCount = Math.max(0, windowBounds.endSlotId - windowBounds.startSlotId + 1);
        const statsBufferLength = normalizePositiveInteger(global.config.general.statsBufferLength, 1);
        const statsBufferHours = Math.max(1, normalizeFiniteNumber(global.config.general.statsBufferHours, 1));
        const historyLayout = getHistoryLayout(statsBufferLength, statsBufferHours);
        const historyTick = shouldRunHistoryTick(currentTime);
        const locTime = windowBounds.hashStart;

        let startMessage = "Starting stats collection for " + height + " height";
        if (!state.historyLayoutLogged) {
            startMessage += " (history tiers: " + historyLayout.capacities.join("/") + ")";
            state.historyLayoutLogged = true;
        }
        console.log(startMessage);

        const identifiers = new Map();
        const minerStats = new Map();
        const portHashes = new Map();
        const localStats = { pplns: 0, global: 0 };
        const localTimes = { pplns: locTime, global: locTime };
        let oldestTime = windowBounds.alignedNow;
        let loopBreakout = 0;
        let minerCount = 0;
        let tailShareCount = 0;
        let windowSlotCount = 0;

        const shareTxn = global.database.env.beginTxn({ readOnly: true });
        const shareCursor = new global.database.lmdb.Cursor(shareTxn, global.database.shareDB);

        try {
            do {
                let shareCount = 0;
                for (let found = shareCursor.goToRange(height) === height; found; ++shareCount, found = shareCursor.goToNextDup()) {
                    shareCursor.getCurrentBinary(function (_key, share) {
                        try {
                            share = global.protos.Share.decode(share);
                        } catch (_error) {
                            console.error(share);
                            return;
                        }

                        if (share.timestamp < oldestTime) oldestTime = share.timestamp;
                        if (share.timestamp < windowBounds.tailStart || share.timestamp >= windowBounds.alignedNow) return;
                        applyShareToSnapshot(share, windowBounds, identifiers, minerStats, portHashes, localStats, localTimes);
                        tailShareCount += 1;
                    });
                }
                debug("On " + height + " height iterated " + shareCount + " elements");
            } while (++loopBreakout <= 60 && --height >= 0 && oldestTime > windowBounds.tailStart);
        } finally {
            shareCursor.close();
            shareTxn.abort();
        }

        debug("Share loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

        const cacheTxn = global.database.env.beginTxn({ readOnly: true });
        const batcher = new CacheUpdateBatcher(CACHE_WRITE_BATCH_SIZE);
        let historyUpdateCount = 0;

        try {
            for (let slotId = windowBounds.startSlotId; slotId <= windowBounds.endSlotId; ++slotId) {
                const slotPayload = recentShareWindow.normalizeSlotPayload(
                    readCacheJson(cacheTxn, recentShareWindow.getSlotCacheKey(slotId)),
                    slotId
                );
                if (!slotPayload) continue;
                applySlotToSnapshot(slotPayload, windowBounds, identifiers, minerStats, portHashes, localStats, localTimes);
                windowSlotCount += 1;
            }

            const activeState = buildActiveMinerState(minerStats);
            const activeMinerKeys = activeState.activeMinerKeys;
            const minerPorts = activeState.minerPorts;
            const localMinerCount = activeState.localMinerCount;
            minerCount = 0;
            identifiers.forEach(function (identifierSet) {
                minerCount += identifierSet.size;
            });

            const previousMinerKeys = cacheObjectToSet(readCacheJson(cacheTxn, "minerSet"));
            if (previousMinerKeys.size === 0) {
                for (const miner of activeMinerKeys) previousMinerKeys.add(miner);
            }

            ["pplns", "global"].forEach(function (key) {
                const hash = localStats[key] / (HASHRATE_AVG_MIN * 60);
                const lastHash = localTimes[key];
                const minerCountForKey = localMinerCount[key];
                let cachedData = readCacheJson(cacheTxn, key + "_stats");

                if (cachedData === false || typeof cachedData !== "object") {
                    cachedData = {
                        hash: hash,
                        totalHashes: 0,
                        lastHash: lastHash,
                        minerCount: minerCountForKey,
                        hashHistory: [{ ts: currentTime, hs: hash }],
                        minerHistory: [{ ts: currentTime, cn: minerCountForKey }]
                    };
                } else {
                    cachedData.hash = hash;
                    cachedData.lastHash = lastHash;
                    cachedData.minerCount = minerCountForKey;
                    if (!Array.isArray(cachedData.hashHistory)) cachedData.hashHistory = [];
                    if (!Array.isArray(cachedData.minerHistory)) cachedData.minerHistory = [];
                    if (historyTick) {
                        cachedData.hashHistory.unshift({ ts: currentTime, hs: cachedData.hash });
                        trimArrayToLength(cachedData.hashHistory, statsBufferLength);
                        cachedData.minerHistory.unshift({ ts: currentTime, cn: cachedData.minerCount });
                        trimArrayToLength(cachedData.minerHistory, statsBufferLength);
                    }
                }

                batcher.set(key + "_stats", cachedData);
            });

            const portHashCache = Object.create(null);
            for (const [port, value] of portHashes.entries()) {
                portHashCache[port] = value / (HASHRATE_AVG_MIN * 60);
            }
            batcher.set("port_hash", portHashCache);

            for (const [miner, summary] of minerStats.entries()) {
                const keyStats = "stats:" + miner;
                const keyHistory = "history:" + miner;
                const hash = summary.rawShares / (HASHRATE_AVG_MIN * 60);
                const hash2 = summary.shares2 / (HASHRATE_AVG_MIN * 60);

                batcher.set(keyStats, { hash: hash, hash2: hash2, lastHash: summary.lastHash });

                if (!historyTick) continue;

                const updatedHistory = workerHistory.appendHistorySample(
                    readCacheJson(cacheTxn, keyHistory),
                    historyLayout,
                    { ts: currentTime, hs: hash, hs2: hash2 }
                );
                batcher.set(keyHistory, updatedHistory);

                historyUpdateCount += 1;
            }

            debug("History loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

            updateWorkerTransitions(activeMinerKeys, previousMinerKeys, currentTime, cacheTxn, batcher);
            debug("Worker transition loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

            for (const [address, identifierSet] of identifiers.entries()) {
                batcher.set("identifiers:" + address, Array.from(identifierSet).sort());
            }

            const portMinerCount = Object.create(null);
            for (const [miner, port] of minerPorts.entries()) {
                portMinerCount[port] = (portMinerCount[port] || 0) + 1;
            }

            batcher.set("portMinerCount", portMinerCount);
            batcher.set("minerSet", setToCacheObject(activeMinerKeys));
        } finally {
            cacheTxn.abort();
        }

        try {
            batcher.close();
        } catch (error) {
            batcher.abort();
            console.error("Can't write to pool DB: " + error);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Pool DB is overflowed!", "Can't wite to pool DB: " + error);
            callback();
            return;
        }

        const poolHashrate = localStats.global / (HASHRATE_AVG_MIN * 60);
        const poolWorkers = minerCount;
        const cachedWindowMinutes = (windowSlotCount * recentShareWindow.SLOT_INTERVAL_MS / 60000).toFixed(1);
        const windowCoveragePct = expectedWindowSlotCount === 0
            ? "100.0"
            : ((windowSlotCount / expectedWindowSlotCount) * 100).toFixed(1);

        console.log(
            "Processed " + minerCount + " workers (" + historyUpdateCount + " history) for " +
            ((Date.now() - currentTime) / 1000) + " seconds (" + (batcher.totalWriteMs / 1000) +
            " seconds DB write across " + batcher.flushCount + " batches, " +
            windowSlotCount + "/" + expectedWindowSlotCount + " window slots (" +
            windowCoveragePct + "%, " + cachedWindowMinutes + "m cached), " +
            tailShareCount + " tail shares). Pool hashrate is: " + poolHashrate
        );

        if (!state.prevPoolStateTime || currentTime - state.prevPoolStateTime > HASHRATE_AVG_MIN * 60 * 1000) {
            const poolHashrateRatio = state.prevPoolHashrate ? poolHashrate / state.prevPoolHashrate : 1;
            const poolWorkersRatio = state.prevPoolWorkers ? poolWorkers / state.prevPoolWorkers : 1;
            if (
                poolHashrateRatio < (1 - STAT_CHANGE_ALERT) || poolHashrateRatio > (1 + STAT_CHANGE_ALERT) ||
                poolWorkersRatio < (1 - STAT_CHANGE_ALERT) || poolWorkersRatio > (1 + STAT_CHANGE_ALERT)
            ) {
                global.support.sendEmail(
                    global.config.general.adminEmail,
                    "FYI: Pool hashrate/workers changed significantly",
                    "Pool hashrate changed from " + state.prevPoolHashrate + " to " + poolHashrate + " (" + poolHashrateRatio + ")\n" +
                    "Pool number of workers changed from " + state.prevPoolWorkers + " to " + poolWorkers + " (" + poolWorkersRatio + ")\n"
                );
            }
            state.prevPoolHashrate = poolHashrate;
            state.prevPoolWorkers = poolWorkers;
            state.prevPoolStateTime = currentTime;
        }

        callback();
    }

    function updateShareStats() {
        global.coinFuncs.getLastBlockHeader(function (err, body) {
            if (err !== null) {
                setTimeout(updateShareStats, STATS_INTERVAL_MS);
                return;
            }

            updateShareStats2(body.height + 1, function () {
                setTimeout(updateShareStats, STATS_INTERVAL_MS);
            });
        }, true);
    }

    function startWorker() {
        if (state.started) return;
        state.started = true;

        global.support.sendEmail(global.config.general.adminEmail, "Restarting worker module", "Restarted worker module!");
        updateShareStats();
        state.pruneTimer = setInterval(pruneTransientState, 2 * 60 * 60 * 1000);
    }

    return {
        createWorkerRuntime,
        delayedSendWorkerStoppedHashingEmail,
        getAddressEmail,
        pruneTransientState,
        startWorker,
        state,
        updateShareStats,
        updateShareStats2
    };
}

const runtime = createWorkerRuntime();

module.exports = {
    createWorkerRuntime,
    delayedSendWorkerStoppedHashingEmail: runtime.delayedSendWorkerStoppedHashingEmail,
    getAddressEmail: runtime.getAddressEmail,
    pruneTransientState: runtime.pruneTransientState,
    startWorker: runtime.startWorker,
    state: runtime.state,
    updateShareStats: runtime.updateShareStats,
    updateShareStats2: runtime.updateShareStats2
};

if (global.__workerAutostart !== false) {
    runtime.startWorker();
}
