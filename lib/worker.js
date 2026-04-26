"use strict";
const debug = require("debug")("worker");
const { createConsoleLogger } = require("./common/logging");
const { formatLmdbError, isLmdbMapFull } = require("./common/lmdb_errors.js");
const workerHistory = require("./common/worker_history");

const HASHRATE_AVG_MIN = 10;
const HASH_WINDOW_MS = HASHRATE_AVG_MIN * 60 * 1000;
const IDENTIFIER_WINDOW_MS = 20 * 60 * 1000;
const STAT_CHANGE_ALERT = 0.6;
const STATS_INTERVAL_MS = 20 * 1000;
const HISTORY_INTERVAL_MS = 2 * 60 * 1000;
const CACHE_WRITE_BATCH_SIZE = 500;
const EMAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STARTED_HASHING_TTL_MS = 20 * 60 * 1000;
const PPLNS_POOL_TYPE = global.protos.POOLTYPE.PPLNS;
const logger = createConsoleLogger(console);

function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readCacheString(txn, key) {
    try {
        return txn.getString(global.database.cacheDB, key);
    } catch (_error) {
        return null;
    }
}

function parseCacheEntry(key, cached) {
    if (cached === null) return { raw: null, value: false };

    try {
        return { raw: cached, value: JSON.parse(cached) };
    } catch (_error) {
        logger.logError("Worker cache", { key, status: "bad cache data" });
        return { raw: cached, value: false };
    }
}

function readCacheSnapshot(keys) {
    const snapshot = Object.create(null);
    if (!Array.isArray(keys) || keys.length === 0) return snapshot;

    const txn = global.database.env.beginTxn({ readOnly: true });
    try {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(snapshot, key)) continue;
            snapshot[key] = readCacheString(txn, key);
        }
    } finally {
        txn.abort();
    }

    return snapshot;
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

function getMinerParts(miner) { return miner.split(/_(.+)/); }

function getMinerId(share) {
    return typeof share.paymentID !== "undefined" && share.paymentID.length > 10
        ? share.paymentAddress + "." + share.paymentID
        : share.paymentAddress;
}

function isWorkerKey(miner) { return miner.indexOf("_") >= 0; }

function trimArrayToLength(values, maxLength) {
    while (values.length > maxLength) values.pop();
    return values;
}

function formatIntervalSeconds(seconds) {
    if (seconds % 3600 === 0) return (seconds / 3600) + "h";
    if (seconds % 60 === 0) return (seconds / 60) + "m";
    return seconds + "s";
}

function formatMegabytes(bytes) { return (bytes / (1024 * 1024)).toFixed(2); }

function poolEmailBrand() {
    return global.config && global.config.general && typeof global.config.general.emailBrand === "string" && global.config.general.emailBrand
        ? global.config.general.emailBrand
        : "MoneroOcean";
}

function formatEmailTimestamp(timestamp) {
    if (global.support && typeof global.support.formatDateUTC === "function") return global.support.formatDateUTC(timestamp);
    return global.support.formatDate(timestamp);
}

function maskWalletAddress(address) {
    if (global.support && typeof global.support.maskWalletAddress === "function") return global.support.maskWalletAddress(address);
    const value = typeof address === "string" ? address.trim() : "";
    return value.length > 12 ? value.slice(0, 6) + "..." + value.slice(-4) : value;
}

function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") {
        return global.support.renderEmailTemplate(item, values, fallback);
    }
    const template = global.config && global.config.email && typeof global.config.email[item] === "string"
        ? global.config.email[item]
        : fallback;
    if (global.support && typeof global.support.formatTemplate === "function") {
        return global.support.formatTemplate(template || "", values);
    }
    return String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
        return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
    });
}

function sendAdminTemplateEmail(subjectItem, bodyItem, values, subjectFallback, bodyFallback) {
    global.support.sendEmail(
        global.config.general.adminEmail,
        renderEmailTemplate(subjectItem, values || {}, subjectFallback),
        renderEmailTemplate(bodyItem, values || {}, bodyFallback)
    );
}

function writeCacheBatch(entries) {
    if (entries.length === 0) return 0;

    const startedAt = Date.now();
    const txn = global.database.env.beginTxn();
    let committed = false;
    try {
        for (let index = 0; index < entries.length; ++index) {
            txn.putString(global.database.cacheDB, entries[index][0], entries[index][1]);
        }
        txn.commit();
        committed = true;
        return Date.now() - startedAt;
    } finally {
        if (!committed) {
            try {
                txn.abort();
            } catch (_error) {}
        }
    }
}

class CacheUpdateBatcher {
    constructor(batchSize) {
        this.batchSize = batchSize;
        this.entries = [];
        this.totalWriteMs = 0;
        this.flushCount = 0;
        this.comparedBytes = 0;
        this.skippedBytes = 0;
    }

    set(key, value) {
        this.setSerialized(key, JSON.stringify(value));
    }

    setSerialized(key, value) {
        this.entries.push([key, value]);
        if (this.entries.length >= this.batchSize) this.flush();
    }

    flush() {
        if (this.entries.length === 0) return;
        const entries = this.entries;
        this.entries = [];
        this.totalWriteMs += writeCacheBatch(entries);
        this.flushCount += 1;
    }

    close() {
        this.flush();
    }

    abort() {
        this.entries = [];
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
        lmdbFailStop: false,
        nextHistoryAt: 0,
        started: false,
        pruneTimer: null
    };

    function enterLmdbFailStop(scope, error) {
        if (!isLmdbMapFull(error)) return false;
        if (state.lmdbFailStop) return true;
        const detail = formatLmdbError(error);
        state.lmdbFailStop = true;
        state.started = false;
        if (state.pruneTimer !== null) {
            clearInterval(state.pruneTimer);
            state.pruneTimer = null;
        }
        logger.logError("Worker DB", {
            status: "lmdb map full",
            scope,
            detail
        });
        sendAdminTemplateEmail(
            "workerLmdbFullSubject",
            "workerLmdbFullBody",
            { scope, detail },
            "Worker module paused due to LMDB full",
            "worker paused after LMDB reported map full while %(scope)s: %(detail)s."
        );
        return true;
    }

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

    function queueCacheWriteIfChanged(batcher, key, value, currentRaw) {
        const serializedValue = JSON.stringify(value);
        const serializedSize = Buffer.byteLength(key) + Buffer.byteLength(serializedValue);
        const previousValue = typeof currentRaw === "string" ? currentRaw : null;
        batcher.comparedBytes += serializedSize;
        if (previousValue === serializedValue) {
            batcher.skippedBytes += serializedSize;
            return false;
        }
        batcher.setSerialized(key, serializedValue);
        return true;
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
                logger.logError("Worker email", {
                    address,
                    status: "lookup failed",
                    detail: error.message
                });
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
            pool: poolEmailBrand(),
            worker: worker,
            wallet: maskWalletAddress(address),
            address: address,
            timestamp: formatEmailTimestamp(currentTime),
            notice_delay: "10 minutes without submitted hashes",
            poolEmailSig: global.config.general.emailSig
        };

        global.support.sendEmail(
            email,
            renderEmailTemplate("workerStartHashingSubject", emailData),
            renderEmailTemplate("workerStartHashingBody", emailData),
            address,
            {
                batchKey: "worker-started:" + address,
                batchSubject: "Workers started hashing"
            }
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
                pool: poolEmailBrand(),
                worker: addressParts[1],
                wallet: maskWalletAddress(address),
                address: address,
                timestamp: formatEmailTimestamp(currentTime),
                notice_delay: "10 minutes without submitted hashes",
                poolEmailSig: global.config.general.emailSig
            };

            global.support.sendEmail(
                email,
                renderEmailTemplate("workerNotHashingSubject", emailData),
                renderEmailTemplate("workerNotHashingBody", emailData),
                address,
                {
                    batchKey: "worker-stopped:" + address,
                    batchSubject: "Workers stopped hashing"
                }
            );
        });
    }

    function updateWorkerTransitions(activeMinerKeys, previousMinerKeys, currentTime, staleMinerEntries, batcher) {
        for (const miner of previousMinerKeys) {
            if (activeMinerKeys.has(miner)) continue;

            const minerEntry = staleMinerEntries[miner] || { raw: null, value: false };
            const minerStats = minerEntry.value;
            if (!minerStats) continue;

            minerStats.hash = 0;
            queueCacheWriteIfChanged(batcher, miner, minerStats, minerEntry.raw);

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
        if (share.timestamp < bounds.identifierStart || share.timestamp >= bounds.currentTime) return;

        const minerID = getMinerId(share);
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
        const windowBounds = {
            currentTime: currentTime,
            hashStart: Math.max(0, currentTime - HASH_WINDOW_MS),
            identifierStart: Math.max(0, currentTime - IDENTIFIER_WINDOW_MS)
        };
        const statsBufferLength = normalizePositiveInteger(global.config.general.statsBufferLength, 1);
        const statsBufferHours = Math.max(1, normalizeFiniteNumber(global.config.general.statsBufferHours, 1));
        const historyLayout = getHistoryLayout(statsBufferLength, statsBufferHours);
        const historyTick = shouldRunHistoryTick(currentTime);
        const locTime = windowBounds.hashStart;
        const requestedHeight = height;

        if (!state.historyLayoutLogged) {
            logger.logInfo("Worker config", {
                history_tiers: historyLayout.capacities.join("/"),
                history_intervals: historyLayout.intervalsSec.map(formatIntervalSeconds).join("/")
            });
            state.historyLayoutLogged = true;
        }
        const identifiers = new Map();
        const minerStats = new Map();
        const portHashes = new Map();
        const localStats = { pplns: 0, global: 0 };
        const localTimes = { pplns: locTime, global: locTime };
        let oldestTime = currentTime;
        let loopBreakout = 0;
        let minerCount = 0;

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
                            logger.logError("Worker share", {
                                height,
                                status: "decode failed",
                                detail: share
                            });
                            return;
                        }

                        if (share.timestamp < oldestTime) oldestTime = share.timestamp;
                        if (share.timestamp < windowBounds.identifierStart || share.timestamp >= currentTime) return;
                        applyShareToSnapshot(share, windowBounds, identifiers, minerStats, portHashes, localStats, localTimes);
                    });
                }
                debug("On " + height + " height iterated " + shareCount + " elements");
            } while (++loopBreakout <= 60 && --height >= 0 && oldestTime > windowBounds.identifierStart);
        } finally {
            shareCursor.close();
            shareTxn.abort();
        }

        debug("Share loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

        const batcher = new CacheUpdateBatcher(CACHE_WRITE_BATCH_SIZE);
        let historyUpdateCount = 0;

        const activeState = buildActiveMinerState(minerStats);
        const activeMinerKeys = activeState.activeMinerKeys;
        const minerPorts = activeState.minerPorts;
        const localMinerCount = activeState.localMinerCount;
        minerCount = 0;
        identifiers.forEach(function (identifierSet) {
            minerCount += identifierSet.size;
        });

        const baseSnapshot = readCacheSnapshot([
            "minerSet",
            "pplns_stats",
            "global_stats",
            "port_hash",
            "portMinerCount"
        ]);
        const minerSetEntry = parseCacheEntry("minerSet", baseSnapshot.minerSet);
        const previousMinerKeys = cacheObjectToSet(minerSetEntry.value);
        if (previousMinerKeys.size === 0) {
            for (const miner of activeMinerKeys) previousMinerKeys.add(miner);
        }

        const extraSnapshotKeys = [];
        for (const [miner] of minerStats.entries()) {
            extraSnapshotKeys.push("stats:" + miner);
            if (historyTick) extraSnapshotKeys.push("history:" + miner);
        }
        for (const miner of previousMinerKeys) {
            if (activeMinerKeys.has(miner)) continue;
            extraSnapshotKeys.push(miner);
        }
        for (const [address] of identifiers.entries()) {
            extraSnapshotKeys.push("identifiers:" + address);
        }
        const extraSnapshot = readCacheSnapshot(extraSnapshotKeys);
        const staleMinerEntries = Object.create(null);
        for (const miner of previousMinerKeys) {
            if (activeMinerKeys.has(miner)) continue;
            staleMinerEntries[miner] = parseCacheEntry(miner, extraSnapshot[miner]);
        }

        ["pplns", "global"].forEach(function (key) {
            const keyStats = key + "_stats";
            const hash = localStats[key] / (HASHRATE_AVG_MIN * 60);
            const lastHash = localTimes[key];
            const minerCountForKey = localMinerCount[key];
            const statsEntry = parseCacheEntry(keyStats, baseSnapshot[keyStats]);
            let cachedData = statsEntry.value;

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

            queueCacheWriteIfChanged(batcher, keyStats, cachedData, statsEntry.raw);
        });

        const portHashCache = Object.create(null);
        for (const [port, value] of portHashes.entries()) {
            portHashCache[port] = value / (HASHRATE_AVG_MIN * 60);
        }
        queueCacheWriteIfChanged(batcher, "port_hash", portHashCache, baseSnapshot.port_hash);

        for (const [miner, summary] of minerStats.entries()) {
            const keyStats = "stats:" + miner;
            const keyHistory = "history:" + miner;
            const hash = summary.rawShares / (HASHRATE_AVG_MIN * 60);
            const hash2 = summary.shares2 / (HASHRATE_AVG_MIN * 60);

            queueCacheWriteIfChanged(batcher, keyStats, { hash: hash, hash2: hash2, lastHash: summary.lastHash }, extraSnapshot[keyStats]);

            if (!historyTick) continue;

            const historyEntry = parseCacheEntry(keyHistory, extraSnapshot[keyHistory]);
            const updatedHistory = workerHistory.appendHistorySample(
                historyEntry.value,
                historyLayout,
                { ts: currentTime, hs: hash, hs2: hash2 }
            );
            if (queueCacheWriteIfChanged(batcher, keyHistory, updatedHistory, historyEntry.raw)) {
                historyUpdateCount += 1;
            }

        }

        debug("History loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

        updateWorkerTransitions(activeMinerKeys, previousMinerKeys, currentTime, staleMinerEntries, batcher);
        debug("Worker transition loop: " + ((Date.now() - currentTime) / 1000) + " seconds");

        for (const [address, identifierSet] of identifiers.entries()) {
            const identifierKey = "identifiers:" + address;
            queueCacheWriteIfChanged(batcher, identifierKey, Array.from(identifierSet).sort(), extraSnapshot[identifierKey]);
        }

        const portMinerCount = Object.create(null);
        for (const [miner, port] of minerPorts.entries()) {
            portMinerCount[port] = (portMinerCount[port] || 0) + 1;
        }

        queueCacheWriteIfChanged(batcher, "portMinerCount", portMinerCount, baseSnapshot.portMinerCount);
        queueCacheWriteIfChanged(batcher, "minerSet", setToCacheObject(activeMinerKeys), minerSetEntry.raw);

        try {
            batcher.close();
        } catch (error) {
            batcher.abort();
            if (!enterLmdbFailStop("writing worker cache", error)) {
                logger.logError("Worker DB", { status: "cache write failed", detail: error });
                sendAdminTemplateEmail(
                    "workerDbWriteSubject",
                    "workerDbWriteBody",
                    { error: error },
                    "Pool DB write failed",
                    "Cannot write to pool DB: %(error)s"
                );
            }
            callback();
            return;
        }

        const poolHashrate = localStats.global / (HASHRATE_AVG_MIN * 60);
        const poolWorkers = minerCount;

        logger.logInfo("Summary", {
            height: requestedHeight,
            workers: minerCount,
            history_updates: historyUpdateCount,
            duration_ms: Date.now() - currentTime,
            db_write_ms: batcher.totalWriteMs,
            db_write_batches: batcher.flushCount,
            skipped_mb: formatMegabytes(batcher.skippedBytes),
            compared_mb: formatMegabytes(batcher.comparedBytes),
            hashrate: poolHashrate
        });

        if (!state.prevPoolStateTime || currentTime - state.prevPoolStateTime > HASHRATE_AVG_MIN * 60 * 1000) {
            const poolHashrateRatio = state.prevPoolHashrate ? poolHashrate / state.prevPoolHashrate : 1;
            const poolWorkersRatio = state.prevPoolWorkers ? poolWorkers / state.prevPoolWorkers : 1;
            if (
                poolHashrateRatio < (1 - STAT_CHANGE_ALERT) || poolHashrateRatio > (1 + STAT_CHANGE_ALERT) ||
                poolWorkersRatio < (1 - STAT_CHANGE_ALERT) || poolWorkersRatio > (1 + STAT_CHANGE_ALERT)
            ) {
                sendAdminTemplateEmail(
                    "workerPoolChangeSubject",
                    "workerPoolChangeBody",
                    {
                        old_hashrate: state.prevPoolHashrate,
                        new_hashrate: poolHashrate,
                        hashrate_ratio: poolHashrateRatio,
                        old_workers: state.prevPoolWorkers,
                        new_workers: poolWorkers,
                        workers_ratio: poolWorkersRatio
                    },
                    "FYI: Pool hashrate/workers changed significantly",
                    "Pool hashrate changed from %(old_hashrate)s to %(new_hashrate)s (%(hashrate_ratio)s)\n" +
                    "Pool number of workers changed from %(old_workers)s to %(new_workers)s (%(workers_ratio)s)\n"
                );
            }
            state.prevPoolHashrate = poolHashrate;
            state.prevPoolWorkers = poolWorkers;
            state.prevPoolStateTime = currentTime;
        }

        callback();
    }

    function updateShareStats() {
        if (!state.started || state.lmdbFailStop) return;
        global.coinFuncs.getLastBlockHeader(function (err, body) {
            if (!state.started || state.lmdbFailStop) return;
            if (err !== null) {
                if (state.started && !state.lmdbFailStop) setTimeout(updateShareStats, STATS_INTERVAL_MS);
                return;
            }

            updateShareStats2(body.height + 1, function () {
                if (state.started && !state.lmdbFailStop) setTimeout(updateShareStats, STATS_INTERVAL_MS);
            });
        }, true);
    }

    function startWorker() {
        if (state.started || state.lmdbFailStop) return;
        state.started = true;

        sendAdminTemplateEmail(
            "workerRestartSubject",
            "workerRestartBody",
            {},
            "Restarting worker module",
            "Restarted worker module!"
        );
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
