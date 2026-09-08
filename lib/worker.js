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
const STOPPED_HASHING_DELAY_MS = 10 * 60 * 1000;
const STARTED_HASHING_TTL_MS = 2 * STOPPED_HASHING_DELAY_MS;
const STOPPED_HASHING_TTL_MS = 2 * STOPPED_HASHING_DELAY_MS;
const PPLNS_POOL_TYPE = global.protos.POOLTYPE["PPLNS"];
const logger = createConsoleLogger(console, "");

/** @typedef {import("../types/runtime").LmdbTxn} LmdbTxn */
/** @typedef {import("../types/runtime").LmdbCursor} LmdbCursor */
/** @typedef {import("../types/runtime").ShareMessage} ShareMessage */
/** @typedef {import("./common/worker_history").HistoryLayout} HistoryLayout */
/** @typedef {{raw: string | null, value: unknown}} CacheEntry */
/** @typedef {Record<string, string | null>} CacheSnapshot */
/** @typedef {{rawShares: number, shares2: number, lastHash: number, port: number, hasPplns: boolean}} MinerSummary */
/** @typedef {Map<string, MinerSummary>} MinerSummaries */
/** @typedef {Map<string, Set<string>>} Identifiers */
/** @typedef {{currentTime: number, hashStart: number, identifierStart: number}} WindowBounds */
/** @typedef {{pplns: number, global: number}} PoolTotals */
/** @typedef {{bounds: WindowBounds, identifiers: Identifiers, minerStats: MinerSummaries, portHashes: Map<number, number>, localStats: PoolTotals, localTimes: PoolTotals}} ShareSnapshot */
/** @typedef {Record<string, {data: CacheEntry, stats: CacheEntry}>} StaleMinerEntries */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** @param {unknown} value @param {number} fallback */
function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** @param {unknown} value @param {number} fallback */
function normalizeFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/** @param {LmdbTxn} txn @param {string} key */
function readCacheString(txn, key) {
    try {
        return txn.getString(global.database.cacheDB, key);
    } catch (_error) {
        return null;
    }
}

/** @param {string} key @param {string | null | undefined} cached @returns {CacheEntry} */
function parseCacheEntry(key, cached) {
    if (cached == null) return { raw: null, value: false };

    try {
        return { raw: cached, value: JSON.parse(cached) };
    } catch (_error) {
        logger.logError("Worker cache", { key, status: "bad cache data" });
        return { raw: cached, value: false };
    }
}

/** @param {string[]} keys */
function readCacheSnapshot(keys) {
    /** @type {CacheSnapshot} */
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

/** @param {Set<string>} values */
function setToCacheObject(values) {
    /** @type {Record<string, number>} */
    const result = Object.create(null);
    for (const value of values) result[value] = 1;
    return result;
}

/** @param {unknown} value */
function cacheObjectToSet(value) {
    const result = new Set(/** @type {string[]} */ ([]));
    if (!value || typeof value !== "object") return result;
    Object.keys(value).forEach(function (key) {
        result.add(key);
    });
    return result;
}

/** @param {string} miner @returns {[string, string]} */
function getMinerParts(miner) {
    const separator = miner.indexOf("_");
    return separator < 0 ? [miner, ""] : [miner.slice(0, separator), miner.slice(separator + 1)];
}

/** @param {ShareMessage} share */
function getMinerId(share) {
    return typeof share.paymentID === "string" && share.paymentID.length > 10
        ? `${share.paymentAddress  }.${  share.paymentID}`
        : share.paymentAddress;
}

/** @param {string} miner */
function isWorkerKey(miner) { return miner.indexOf("_") >= 0; }

/** @template T @param {T[]} values @param {number} maxLength */
function trimArrayToLength(values, maxLength) {
    if (values.length > maxLength) values.length = maxLength;
    return values;
}

/** @param {unknown} payload @param {HistoryLayout} layout @param {import("./common/worker_history").HistoryPointInput} point */
function appendPoolHashHistorySample(payload, layout, point) {
    const history = Array.isArray(payload) ? workerHistory.importHistoryPayload(payload, layout) : payload;
    return workerHistory.appendHistorySample(history, layout, point);
}

/** @param {number} seconds */
function formatIntervalSeconds(seconds) {
    const roundedSeconds = Math.round(seconds);
    if (roundedSeconds % 3600 === 0) return `${roundedSeconds / 3600  }h`;
    if (roundedSeconds % 60 === 0) return `${roundedSeconds / 60  }m`;
    return `${roundedSeconds  }s`;
}

/** @param {number} bytes */
function formatMegabytes(bytes) { return (bytes / (1024 * 1024)).toFixed(2); }

function poolEmailBrand() {
    return global.config && global.config.general && typeof global.config.general.emailBrand === "string" && global.config.general.emailBrand
        ? global.config.general.emailBrand
        : "MoneroOcean";
}

/** @param {number} timestamp */
function formatEmailTimestamp(timestamp) {
    if (global.support && typeof global.support.formatDateUTC === "function") return global.support.formatDateUTC(timestamp);
    return global.support.formatDate(timestamp);
}

/** @param {string} address */
function maskWalletAddress(address) {
    if (global.support && typeof global.support.maskWalletAddress === "function") return global.support.maskWalletAddress(address);
    const value = typeof address === "string" ? address.trim() : "";
    return value.length > 12 ? `${value.slice(0, 6)  }...${  value.slice(-4)}` : value;
}

/** @param {string} item @param {Record<string, unknown>} values @param {string} [fallback] */
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

/** @param {string} subjectItem @param {string} bodyItem @param {Record<string, unknown>} values @param {string} subjectFallback @param {string} bodyFallback @returns {void} */
function sendAdminTemplateEmail(subjectItem, bodyItem, values, subjectFallback, bodyFallback) {
    const subject = renderEmailTemplate(subjectItem, values || {}, subjectFallback);
    const body = renderEmailTemplate(bodyItem, values || {}, bodyFallback);
    if (subject.indexOf("FYI:") === 0 && typeof global.support.sendAdminFyi === "function") {
        global.support.sendAdminFyi(`worker:${  subjectItem}`, subject, body);
        return;
    }
    global.support.sendEmail(global.config.general.adminEmail, subject, body);
}

/** @param {[string, string][]} entries */
function writeCacheBatch(entries) {
    if (entries.length === 0) return 0;

    const startedAt = Date.now();
    const txn = global.database.env.beginTxn();
    let committed = false;
    try {
        for (const [key, value] of entries) txn.putString(global.database.cacheDB, key, value);
        txn.commit();
        committed = true;
        return Date.now() - startedAt;
    } finally {
        if (!committed) {
            try {
                txn.abort();
            } catch (_error) { /* best-effort txn abort on failure path; ignore if already closed */ }
        }
    }
}

class CacheUpdateBatcher {
    /** @param {number} batchSize */
    constructor(batchSize) {
        this.batchSize = batchSize;
        /** @type {[string, string][]} */
        this.entries = [];
        this.totalWriteMs = 0;
        this.flushCount = 0;
        this.comparedBytes = 0;
        this.skippedBytes = 0;
    }

    /** @param {string} key @param {unknown} value */
    set(key, value) {
        this.setSerialized(key, JSON.stringify(value));
    }

    /** @param {string} key @param {string} value */
    setSerialized(key, value) {
        this.entries.push([key, value]);
        if (this.entries.length >= this.batchSize) this.flush();
    }

    flush() {
        if (this.entries.length === 0) return;
        const entries = this.entries;
        /** @type {[string, string][]} */
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
        minerEmail: /** @type {Record<string, string | null>} */ (Object.create(null)),
        minerEmailTime: /** @type {Record<string, number>} */ (Object.create(null)),
        workersStartedHashingTime: /** @type {Record<string, number>} */ (Object.create(null)),
        workersStoppedHashingTime: /** @type {Record<string, number>} */ (Object.create(null)),
        workersStoppedHashingEmailTime: /** @type {Record<string, number>} */ (Object.create(null)),
        historyLayoutCache: /** @type {{statsBufferLength: number, statsBufferHours: number, layout: HistoryLayout} | null} */ (null),
        historyLayoutLogged: false,
        lastShareStatsHeight: 0,
        lmdbFailStop: false,
        nextHistoryAt: 0,
        started: false,
        pruneTimer: /** @type {NodeJS.Timeout | null} */ (null)
    };

    /** @param {string} scope @param {unknown} error */
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

    /** @param {number} statsBufferLength @param {number} statsBufferHours */
    function getHistoryLayout(statsBufferLength, statsBufferHours) {
        const cachedLayout = state.historyLayoutCache;
        if (
            cachedLayout &&
            cachedLayout.statsBufferLength === statsBufferLength &&
            cachedLayout.statsBufferHours === statsBufferHours
        ) {
            return cachedLayout.layout;
        }

        const layout = workerHistory.buildTierLayout(statsBufferLength, statsBufferHours, undefined);
        state.historyLayoutCache = {
            statsBufferLength,
            statsBufferHours,
            layout
        };
        return layout;
    }

    /** @param {CacheUpdateBatcher} batcher @param {string} key @param {unknown} value @param {string | null | undefined} currentRaw */
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

        Object.entries(state.minerEmailTime).forEach(function ([address, timestamp]) {
            if (currentTime - timestamp <= EMAIL_CACHE_TTL_MS) return;
            delete state.minerEmailTime[address];
            delete state.minerEmail[address];
        });

        Object.entries(state.workersStartedHashingTime).forEach(function ([miner, timestamp]) {
            if (currentTime - timestamp <= STARTED_HASHING_TTL_MS) return;
            delete state.workersStartedHashingTime[miner];
        });

        Object.entries(state.workersStoppedHashingTime).forEach(function ([miner, timestamp]) {
            if (currentTime - timestamp <= STOPPED_HASHING_TTL_MS) return;
            delete state.workersStoppedHashingTime[miner];
        });
    }

    /** @param {string} address @param {(email: string) => void} callback */
    function getAddressEmail(address, callback) {
        const currentTime = Date.now();
        const lastLookupAt = state.minerEmailTime[address];
        if (lastLookupAt === undefined || currentTime - lastLookupAt > 10 * 60 * 1000) {
            state.minerEmailTime[address] = currentTime;
            state.minerEmail[address] = null;
            global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [address]).then(function (rows) {
                const email = rows[0]?.["email"];
                if (typeof email !== "string" || email.length === 0) {
                    delete state.minerEmail[address];
                    return;
                }

                state.minerEmail[address] = email;
                callback(email);
            }).catch(/** @param {unknown} error */ function (error) {
                logger.logError("Worker email", {
                    address,
                    status: "lookup failed",
                    detail: error instanceof Error ? error.message : String(error)
                });
            });
            return;
        }

        const cachedEmail = state.minerEmail[address];
        if (cachedEmail === undefined) return;
        if (cachedEmail === null) {
            if (currentTime - lastLookupAt < 5 * 1000) {
                setTimeout(getAddressEmail, 10 * 1000, address, callback);
            }
            return;
        }

        callback(cachedEmail);
    }

    /** @param {string} miner @param {string} email @param {number} currentTime */
    function sendWorkerStartedHashingEmail(miner, email, currentTime) {
        const addressParts = getMinerParts(miner);
        const address = addressParts[0];
        const worker = addressParts[1];
        const emailData = {
            pool: poolEmailBrand(),
            worker,
            wallet: maskWalletAddress(address),
            address,
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
                batchKey: `worker-started:${  address}`,
                batchSubject: "Workers started hashing"
            }
        );
    }

    /** @param {string} miner @param {number} currentTime */
    function delayedSendWorkerStoppedHashingEmail(miner, currentTime) {
        const startedAt = state.workersStartedHashingTime[miner];
        if (startedAt !== undefined && Date.now() - startedAt <= STOPPED_HASHING_DELAY_MS) {
            delete state.workersStartedHashingTime[miner];
            delete state.workersStoppedHashingTime[miner];
            return;
        }

        delete state.workersStartedHashingTime[miner];
        delete state.workersStoppedHashingTime[miner];

        const addressParts = getMinerParts(miner);
        const address = addressParts[0];

        getAddressEmail(address, function (email) {
            state.workersStoppedHashingEmailTime[miner] = Date.now();
            const emailData = {
                pool: poolEmailBrand(),
                worker: addressParts[1],
                wallet: maskWalletAddress(address),
                address,
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
                    batchKey: `worker-stopped:${  address}`,
                    batchSubject: "Workers stopped hashing"
                }
            );
        });
    }

    /** @param {Set<string>} activeMinerKeys @param {Set<string>} previousMinerKeys @param {number} currentTime @param {StaleMinerEntries} staleMinerEntries @param {CacheUpdateBatcher} batcher */
    function updateWorkerTransitions(activeMinerKeys, previousMinerKeys, currentTime, staleMinerEntries, batcher) {
        for (const miner of previousMinerKeys) {
            if (activeMinerKeys.has(miner)) continue;

            const minerEntry = staleMinerEntries[miner];
            const minerDataEntry = minerEntry?.data || { raw: null, value: false };
            const statsEntry = minerEntry?.stats || { raw: null, value: false };
            const statsData = statsEntry.value;
            if (isRecord(statsData)) {
                statsData["hash"] = 0;
                statsData["hash2"] = 0;
                queueCacheWriteIfChanged(batcher, `stats:${  miner}`, statsData, statsEntry.raw);
            }

            const minerData = minerDataEntry.value;
            if (!isRecord(minerData)) continue;

            minerData["hash"] = 0;
            queueCacheWriteIfChanged(batcher, miner, minerData, minerDataEntry.raw);

            if (!isWorkerKey(miner)) continue;

            const worker = getMinerParts(miner)[1];
            if (!worker || worker.includes("silent")) continue;
            if (miner in state.workersStoppedHashingTime) continue;

            state.workersStoppedHashingTime[miner] = currentTime;
            const timer = setTimeout(delayedSendWorkerStoppedHashingEmail, STOPPED_HASHING_DELAY_MS, miner, currentTime);
            if (timer && typeof timer.unref === "function") timer.unref();
        }

        for (const miner of activeMinerKeys) {
            if (previousMinerKeys.has(miner) || !isWorkerKey(miner)) continue;

            const addressParts = getMinerParts(miner);
            const worker = addressParts[1];
            if (!worker || worker.includes("silent")) continue;

            state.workersStartedHashingTime[miner] = currentTime;
            if (!(miner in state.workersStoppedHashingEmailTime)) continue;

            delete state.workersStoppedHashingTime[miner];
            delete state.workersStoppedHashingEmailTime[miner];
            getAddressEmail(addressParts[0], function (email) {
                sendWorkerStartedHashingEmail(miner, email, currentTime);
            });
        }
    }

    /** @param {Set<string>} identifierSet @param {string} identifierKey @param {string | null | undefined} cachedRaw */
    function mergedIdentifiers(identifierSet, identifierKey, cachedRaw) {
        const retained = new Set(identifierSet);
        const entry = parseCacheEntry(identifierKey, cachedRaw);
        const previousIdentifiers = Array.isArray(entry.value) ? entry.value : [];
        for (const identifier of previousIdentifiers) {
            if (typeof identifier === "string" && identifier.length > 0) retained.add(identifier);
        }
        return Array.from(retained).sort();
    }

    /** @param {Identifiers} identifiers @param {string} address @param {unknown} identifier */
    function mergeIdentifier(identifiers, address, identifier) {
        if (typeof identifier !== "string" || identifier.length === 0) return;
        let identifierSet = identifiers.get(address);
        if (!identifierSet) {
            identifierSet = new Set();
            identifiers.set(address, identifierSet);
        }
        identifierSet.add(identifier);
    }

    /** @param {MinerSummaries} minerStats @param {string} miner @param {number} rawShares @param {number} shares2 @param {number} lastHash @param {number} port @param {boolean} hasPplns */
    function mergeMinerSummary(minerStats, miner, rawShares, shares2, lastHash, port, hasPplns) {
        if (!shares2) return;

        let summary = minerStats.get(miner);
        if (!summary) {
            summary = { rawShares: 0, shares2: 0, lastHash, port, hasPplns: Boolean(hasPplns) };
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

    /** @param {number} port */
    function lastShareAlgoFromPort(port) {
        if (!global.coinFuncs || typeof global.coinFuncs.algoShortTypeStr !== "function") return false;
        return global.coinFuncs.algoShortTypeStr(port || global.config.daemon.port) || false;
    }

    /** @param {ShareMessage} share @param {ShareSnapshot} snapshot */
    function applyShareToSnapshot(share, snapshot) {
        const {bounds, identifiers, minerStats, portHashes, localStats, localTimes} = snapshot;
        if (share.timestamp < bounds.identifierStart || share.timestamp >= bounds.currentTime) return;

        const minerID = getMinerId(share);
        mergeIdentifier(identifiers, minerID, share.identifier);

        if (share.timestamp < bounds.hashStart) return;

        const shares2 = normalizeFiniteNumber(share.shares2, 0);
        const rawShares = normalizeFiniteNumber(share.raw_shares, 0);
        localStats.global += shares2;
        if (localTimes.global < share.timestamp) localTimes.global = share.timestamp;

        const isPplnsShare = share.poolType === PPLNS_POOL_TYPE;
        if (isPplnsShare) {
            localStats.pplns += shares2;
            if (localTimes.pplns < share.timestamp) localTimes.pplns = share.timestamp;
        }

        const port = typeof share.port !== "undefined" && share.port ? share.port : global.config.daemon.port;
        portHashes.set(port, (portHashes.get(port) || 0) + rawShares);

        if (!shares2) return;

        mergeMinerSummary(minerStats, minerID, rawShares, shares2, share.timestamp, port, isPplnsShare);
        if (typeof share.identifier === "string" && share.identifier.length > 0) {
            mergeMinerSummary(minerStats, `${minerID  }_${  share.identifier}`, rawShares, shares2, share.timestamp, port, isPplnsShare);
        }
    }

    /** @param {MinerSummaries} minerStats */
    function buildActiveMinerState(minerStats) {
        const activeMinerKeys = new Set(/** @type {string[]} */ ([]));
        const minerPorts = new Map(/** @type {[string, number][]} */ ([]));
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

    /** @param {number} currentTime */
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

    /** @param {HistoryLayout} historyLayout */
    function logHistoryLayoutOnce(historyLayout) {
        if (state.historyLayoutLogged) return;
        logger.logInfo("Worker config", {
            history_tiers: historyLayout.capacities.join("/"),
            history_intervals: historyLayout.intervalsSec.map(formatIntervalSeconds).join("/")
        });
        state.historyLayoutLogged = true;
    }

    /** @param {number} height @param {ShareSnapshot} snapshot */
    function scanShareSnapshot(height, snapshot) {
        const windowBounds = snapshot.bounds;
        let oldestTime = windowBounds.currentTime;
        let loopBreakout = 0;
        let currentHeight = height;
        const shareTxn = global.database.env.beginTxn({ readOnly: true });
        /** @type {LmdbCursor | null} */
        let shareCursor = null;
        try {
            shareCursor = new global.database.lmdb.Cursor(shareTxn, global.database.shareDB);
            do {
                let shareCount = 0;
                for (let found = shareCursor.goToRange(currentHeight) === currentHeight; found; ++shareCount, found = shareCursor.goToNextDup() !== null) {
                    shareCursor.getCurrentBinary(function (_key, share) {
                        let decodedShare;
                        try {
                            decodedShare = global.protos.Share.decode(share);
                        } catch (_error) {
                            logger.logError("Worker share", { height: currentHeight, status: "decode failed", detail: share });
                            return;
                        }
                        if (decodedShare.timestamp < oldestTime) oldestTime = decodedShare.timestamp;
                        applyShareToSnapshot(decodedShare, snapshot);
                    });
                }
                debug(`On ${  currentHeight  } height iterated ${  shareCount  } elements`);
                // Shares are keyed by block height; walk back until older than the identifier window, capped at 60.
            } while (++loopBreakout <= 60 && --currentHeight >= 0 && oldestTime > windowBounds.identifierStart);
        } finally {
            try {
                if (shareCursor) shareCursor.close();
            } finally {
                shareTxn.abort();
            }
        }
    }

    /** @param {MinerSummaries} minerStats @param {Set<string>} previousMinerKeys @param {Set<string>} activeMinerKeys @param {Identifiers} identifiers @param {boolean} historyTick */
    function buildExtraSnapshotKeys(minerStats, previousMinerKeys, activeMinerKeys, identifiers, historyTick) {
        const keys = [];
        for (const [miner] of minerStats.entries()) {
            keys.push(`stats:${  miner}`);
            if (historyTick) keys.push(`history:${  miner}`);
        }
        for (const miner of previousMinerKeys) {
            if (!activeMinerKeys.has(miner)) {
                keys.push(miner);
                keys.push(`stats:${  miner}`);
            }
        }
        for (const [address] of identifiers.entries()) keys.push(`identifiers:${  address}`);
        return keys;
    }

    /** @param {Identifiers} identifiers */
    function countIdentifiers(identifiers) {
        let minerCount = 0;
        identifiers.forEach(function (identifierSet) {
            minerCount += identifierSet.size;
        });
        return minerCount;
    }

    /** @param {CacheUpdateBatcher} batcher @param {CacheSnapshot} baseSnapshot @param {PoolTotals} localStats @param {PoolTotals} localTimes @param {PoolTotals} localMinerCount @param {number} currentTime @param {boolean} historyTick @param {number} statsBufferLength @param {HistoryLayout} historyLayout */
    function queuePoolStats(batcher, baseSnapshot, localStats, localTimes, localMinerCount, currentTime, historyTick, statsBufferLength, historyLayout) {
        const poolKeys = /** @type {const} */ (["pplns", "global"]);
        poolKeys.forEach(function (key) {
            const keyStats = `${key  }_stats`;
            const hash = localStats[key] / (HASHRATE_AVG_MIN * 60);
            const statsEntry = parseCacheEntry(keyStats, baseSnapshot[keyStats]);
            let cachedData = statsEntry.value;
            if (!isRecord(cachedData)) {
                cachedData = {
                    hash,
                    totalHashes: 0,
                    lastHash: localTimes[key],
                    minerCount: localMinerCount[key],
                    hashHistory: appendPoolHashHistorySample(null, historyLayout, { ts: currentTime, hs: hash }),
                    minerHistory: [{ ts: currentTime, cn: localMinerCount[key] }]
                };
            } else {
                cachedData["hash"] = hash;
                cachedData["lastHash"] = localTimes[key];
                cachedData["minerCount"] = localMinerCount[key];
                const minerHistory = Array.isArray(cachedData["minerHistory"]) ? cachedData["minerHistory"] : [];
                cachedData["minerHistory"] = minerHistory;
                if (historyTick) {
                    cachedData["hashHistory"] = appendPoolHashHistorySample(cachedData["hashHistory"], historyLayout, { ts: currentTime, hs: hash });
                    minerHistory.unshift({ ts: currentTime, cn: cachedData["minerCount"] });
                    trimArrayToLength(minerHistory, statsBufferLength);
                }
            }
            queueCacheWriteIfChanged(batcher, keyStats, cachedData, statsEntry.raw);
        });
    }

    /** @param {CacheUpdateBatcher} batcher @param {MinerSummaries} minerStats @param {CacheSnapshot} extraSnapshot @param {HistoryLayout} historyLayout @param {number} currentTime @param {boolean} historyTick */
    function queueMinerStats(batcher, minerStats, extraSnapshot, historyLayout, currentTime, historyTick) {
        let historyUpdateCount = 0;
        for (const [miner, summary] of minerStats.entries()) {
            const keyStats = `stats:${  miner}`;
            const keyHistory = `history:${  miner}`;
            const hash = summary.rawShares / (HASHRATE_AVG_MIN * 60);
            const hash2 = summary.shares2 / (HASHRATE_AVG_MIN * 60);
            queueCacheWriteIfChanged(batcher, keyStats, { hash, hash2, lastHash: summary.lastHash, lastShareAlgo: lastShareAlgoFromPort(summary.port) }, extraSnapshot[keyStats]);
            if (!historyTick) continue;
            const historyEntry = parseCacheEntry(keyHistory, extraSnapshot[keyHistory]);
            const updatedHistory = workerHistory.appendHistorySample(historyEntry.value, historyLayout, { ts: currentTime, hs: hash, hs2: hash2 });
            if (queueCacheWriteIfChanged(batcher, keyHistory, updatedHistory, historyEntry.raw)) historyUpdateCount += 1;
        }
        return historyUpdateCount;
    }

    // Handle a worker cache write failure from either a mid-cycle batch flush or the final
    // flush. A map-full error pauses the worker (enterLmdbFailStop); any other write error is
    // logged and the admin notified. Callers abort the cycle after this returns.
    /** @param {CacheUpdateBatcher} batcher @param {unknown} error */
    function failWorkerCacheWrite(batcher, error) {
        batcher.abort();
        if (!enterLmdbFailStop("writing worker cache", error)) {
            logger.logError("Worker DB", { status: "cache write failed", detail: error });
            sendAdminTemplateEmail("workerDbWriteSubject", "workerDbWriteBody", { error }, "Pool DB write failed", "Cannot write to pool DB: %(error)s");
        }
    }

    /** @param {number} currentTime @param {number} poolHashrate @param {number} poolWorkers */
    function alertPoolStateChange(currentTime, poolHashrate, poolWorkers) {
        if (state.prevPoolStateTime && currentTime - state.prevPoolStateTime <= HASH_WINDOW_MS) return;
        const poolHashrateRatio = state.prevPoolHashrate ? poolHashrate / state.prevPoolHashrate : 1;
        const poolWorkersRatio = state.prevPoolWorkers ? poolWorkers / state.prevPoolWorkers : 1;
        if (poolHashrateRatio < (1 - STAT_CHANGE_ALERT) || poolHashrateRatio > (1 + STAT_CHANGE_ALERT) ||
            poolWorkersRatio < (1 - STAT_CHANGE_ALERT) || poolWorkersRatio > (1 + STAT_CHANGE_ALERT)) {
            sendAdminTemplateEmail("workerPoolChangeSubject", "workerPoolChangeBody", {
                old_hashrate: state.prevPoolHashrate,
                new_hashrate: poolHashrate,
                hashrate_ratio: poolHashrateRatio,
                old_workers: state.prevPoolWorkers,
                new_workers: poolWorkers,
                workers_ratio: poolWorkersRatio
            }, "FYI: Pool hashrate/workers changed significantly", "Pool hashrate changed from %(old_hashrate)s to %(new_hashrate)s (%(hashrate_ratio)s)\n" +
                "Pool number of workers changed from %(old_workers)s to %(new_workers)s (%(workers_ratio)s)\n");
        }
        state.prevPoolHashrate = poolHashrate;
        state.prevPoolWorkers = poolWorkers;
        state.prevPoolStateTime = currentTime;
    }

    /** @param {number} height @param {() => void} callback */
    function updateShareStats2(height, callback) {
        const currentTime = Date.now();
        const windowBounds = {
            currentTime,
            hashStart: Math.max(0, currentTime - HASH_WINDOW_MS),
            identifierStart: Math.max(0, currentTime - IDENTIFIER_WINDOW_MS)
        };
        const statsBufferLength = normalizePositiveInteger(global.config.general.statsBufferLength, 1);
        const statsBufferHours = Math.max(1, normalizeFiniteNumber(global.config.general.statsBufferHours, 1));
        const historyLayout = getHistoryLayout(statsBufferLength, statsBufferHours);
        const historyTick = shouldRunHistoryTick(currentTime);
        const locTime = windowBounds.hashStart;
        const requestedHeight = height;

        logHistoryLayoutOnce(historyLayout);
        const identifiers = new Map(/** @type {[string, Set<string>][]} */ ([]));
        const minerStats = new Map(/** @type {[string, MinerSummary][]} */ ([]));
        const portHashes = new Map(/** @type {[number, number][]} */ ([]));
        const localStats = { pplns: 0, global: 0 };
        const localTimes = { pplns: locTime, global: locTime };
        scanShareSnapshot(height, {bounds: windowBounds, identifiers, minerStats, portHashes, localStats, localTimes});

        debug(`Share loop: ${  (Date.now() - currentTime) / 1000  } seconds`);

        const batcher = new CacheUpdateBatcher(CACHE_WRITE_BATCH_SIZE);
        const activeState = buildActiveMinerState(minerStats);
        const activeMinerKeys = activeState.activeMinerKeys;
        const minerPorts = activeState.minerPorts;
        const localMinerCount = activeState.localMinerCount;
        const minerCount = countIdentifiers(identifiers);

        const baseSnapshot = readCacheSnapshot([
            "minerSet",
            "pplns_stats",
            "global_stats",
            "port_hash",
            "portMinerCount"
        ]);
        const minerSetEntry = parseCacheEntry("minerSet", baseSnapshot["minerSet"]);
        const previousMinerKeys = cacheObjectToSet(minerSetEntry.value);
        if (previousMinerKeys.size === 0) {
            for (const miner of activeMinerKeys) previousMinerKeys.add(miner);
        }

        if (activeMinerKeys.size === 0 && minerCount === 0 && previousMinerKeys.size !== 0 &&
            state.lastShareStatsHeight && requestedHeight + 100 < state.lastShareStatsHeight) {
            logger.logError("Worker share snapshot", {
                status: "ignored stale empty scan",
                height: requestedHeight,
                previous_height: state.lastShareStatsHeight,
                previous_workers: previousMinerKeys.size
            });
            global.support.sendEmail(global.config.general.adminEmail, "Worker ignored stale empty share scan",
                `Worker ignored a stale empty share scan.\nRequested height: ${  requestedHeight 
                }\nPrevious height: ${  state.lastShareStatsHeight  }\nPrevious workers: ${  previousMinerKeys.size}`);
            callback();
            return;
        }

        const extraSnapshot = readCacheSnapshot(buildExtraSnapshotKeys(minerStats, previousMinerKeys, activeMinerKeys, identifiers, historyTick));
        /** @type {StaleMinerEntries} */
        const staleMinerEntries = Object.create(null);
        for (const miner of previousMinerKeys) {
            if (activeMinerKeys.has(miner)) continue;
            staleMinerEntries[miner] = {
                data: parseCacheEntry(miner, extraSnapshot[miner]),
                stats: parseCacheEntry(`stats:${  miner}`, extraSnapshot[`stats:${  miner}`])
            };
        }

        // All cache writes run inside one try/catch. The batcher also flushes mid-cycle once
        // CACHE_WRITE_BATCH_SIZE entries accumulate, so a write failure (map-full or otherwise)
        // can surface before the final flush; catching here keeps it from escaping the
        // getLastBlockHeader callback uncaught and crashing the process.
        let historyUpdateCount = 0;
        try {
            queuePoolStats(batcher, baseSnapshot, localStats, localTimes, localMinerCount, currentTime, historyTick, statsBufferLength, historyLayout);

            /** @type {Record<number, number>} */
            const portHashCache = Object.create(null);
            for (const [port, value] of portHashes.entries()) {
                portHashCache[port] = value / (HASHRATE_AVG_MIN * 60);
            }
            queueCacheWriteIfChanged(batcher, "port_hash", portHashCache, baseSnapshot["port_hash"]);

            historyUpdateCount = queueMinerStats(batcher, minerStats, extraSnapshot, historyLayout, currentTime, historyTick);

            debug(`History loop: ${  (Date.now() - currentTime) / 1000  } seconds`);

            updateWorkerTransitions(activeMinerKeys, previousMinerKeys, currentTime, staleMinerEntries, batcher);
            debug(`Worker transition loop: ${  (Date.now() - currentTime) / 1000  } seconds`);

            for (const [address, identifierSet] of identifiers.entries()) {
                const identifierKey = `identifiers:${  address}`;
                queueCacheWriteIfChanged(batcher, identifierKey, mergedIdentifiers(identifierSet, identifierKey, extraSnapshot[identifierKey]), extraSnapshot[identifierKey]);
            }

            /** @type {Record<number, number>} */
            const portMinerCount = Object.create(null);
            for (const port of minerPorts.values()) {
                portMinerCount[port] = (portMinerCount[port] || 0) + 1;
            }

            queueCacheWriteIfChanged(batcher, "portMinerCount", portMinerCount, baseSnapshot["portMinerCount"]);
            queueCacheWriteIfChanged(batcher, "minerSet", setToCacheObject(activeMinerKeys), minerSetEntry.raw);

            batcher.close();
        } catch (error) {
            failWorkerCacheWrite(batcher, error);
            callback();
            return;
        }

        if (requestedHeight > state.lastShareStatsHeight) state.lastShareStatsHeight = requestedHeight;

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

        alertPoolStateChange(currentTime, poolHashrate, poolWorkers);

        callback();
    }

    function scheduleShareStatsRetry() {
        if (state.started && !state.lmdbFailStop) setTimeout(updateShareStats, STATS_INTERVAL_MS);
    }

    function updateShareStats() {
        if (!state.started || state.lmdbFailStop) return;
        global.coinFuncs.getLastBlockHeader(function (err, body) {
            if (!state.started || state.lmdbFailStop) return;

            // A daemon can return a transport-success callback with an incomplete header. Validate and
            // normalize the height at this boundary so the share scan never receives undefined data (or
            // concatenates a numeric string with 1), and retry the next cycle instead of throwing here.
            const rawHeight = body && body.height;
            const height = (typeof rawHeight === "number" || typeof rawHeight === "string") && String(rawHeight).trim() !== ""
                ? Number(rawHeight)
                : NaN;
            if (err !== null || !Number.isSafeInteger(height) || height < 0) {
                scheduleShareStatsRetry();
                return;
            }

            updateShareStats2(height + 1, function () {
                scheduleShareStatsRetry();
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
