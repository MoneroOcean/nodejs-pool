"use strict";
const { formatLogEvent } = require("../common/logging.js");
const poolTypeStr = require("../common/pool_type.js");

/** @typedef {import("../../types/runtime").AltBlockMessage} AltBlockMessage */
/** @typedef {import("../../types/runtime").BlockMessage} BlockMessage */
/** @typedef {import("../../types/runtime").CoinProfile} CoinProfile */
/** @typedef {import("../../types/runtime").DatabaseRuntime} DatabaseRuntime */
/** @typedef {import("../../types/runtime").LmdbCursor} LmdbCursor */
/** @typedef {import("../../types/runtime").LmdbDbi} LmdbDbi */
/** @typedef {import("../../types/runtime").LmdbTxn} LmdbTxn */
/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */

/** @typedef {ProtoMessage & {error?: Error|string|{message?: string}|null, errorSource?: string, orphan_status?: boolean, topoheight?: number, reward?: number, depth?: number}} PendingHeader */
/** @typedef {{key: string, type: "block"|"altblock", blockId: number, payload: string, createdAt: number, nextAttemptAt: number, attempts: number, lastError: string|null}} StoredPendingJob */
/** @typedef {{key: string, type: "invalid", invalid: true}} InvalidPendingJob */
/** @typedef {StoredPendingJob|InvalidPendingJob} PendingJob */
/** @typedef {PendingJob[] & {nextDueAt: number|null}} DueJobs */
/** @typedef {{save: (job: StoredPendingJob) => void, remove: (key: string) => void, loadDueJobs: (timeNow: number, limit: number) => DueJobs, loadAllJobs: () => PendingJob[], close: () => void}} PendingStorage */
/** @typedef {{log: (message: string) => void}} PendingLogger */
/** @typedef {{backoff?: boolean, stale?: boolean}} RetryOptions */
/** @typedef {{closed: boolean, closeComplete: boolean, closePromise: Promise<void>|null, closeReject: ((reason?: unknown) => void)|null, closeResolve: (() => void)|null, processing: boolean, badAltBlocks: Map<string, number>, potentiallyBadAltBlocks: Map<number, Map<string, number>>, orphanSince: Map<string, number>, loggedStates: Map<string, {state: string, time: number}>, lastStalePendingBlockAlertCheckAt: number, nextDueJobCheckAt: number}} PendingState */
/** @typedef {{database?: DatabaseRuntime, retryDelayMs?: number, maxRetryDelayMs?: number, orphanGraceMs?: number, stalePendingBlockAgeMs?: number, stalePendingBlockAlertCheckMs?: number, stalePendingBlockAlertCooldownMs?: number, stalePendingBlockSampleLimit?: number, stalePendingBlockProcessLimit?: number, stalePendingBlockRetryDelayMs?: number, logger?: PendingLogger, storage?: PendingStorage}} PendingOptions */
/** @typedef {{job: StoredPendingJob, block: BlockMessage|AltBlockMessage, fields: Record<string, unknown>, timeNow: number, error: unknown, header: PendingHeader|undefined, retryState: string, event: string, saveResolved: (blockId: number, block: BlockMessage|AltBlockMessage) => {status: string}, callback: () => void}} OrphanOptions */
/** @typedef {{enqueueBlock: (blockId: number, payload: Buffer, block: BlockMessage) => void, enqueueAltBlock: (blockId: number, payload: Buffer, block: AltBlockMessage) => void, processDueJobs: () => void, getPendingSummary: () => string, close: () => Promise<void>}} PendingJobs */

const PENDING_JOB_DB_NAME = "pending_blocks";
const ALT_BAD_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const ALT_POTENTIALLY_BAD_TTL_MS = 60 * 60 * 1000;
const ORPHAN_TRACK_TTL_MS = 12 * 60 * 60 * 1000;
const LOG_STATE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 30 * 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_PENDING_BLOCK_AGE_MS = 30 * DAY_MS;
const DEFAULT_STALE_PENDING_BLOCK_ALERT_CHECK_MS = DAY_MS;
const DEFAULT_STALE_PENDING_BLOCK_ALERT_COOLDOWN_MS = DAY_MS;
const DEFAULT_STALE_PENDING_BLOCK_SAMPLE_LIMIT = 20;
const DEFAULT_STALE_PENDING_BLOCK_PROCESS_LIMIT = 5;
const DEFAULT_STALE_PENDING_BLOCK_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

// An orphan is recognized either by explicit daemon flags or by matching the
// daemon's "block/hash not found" error strings (a reward lookup miss is not an orphan).
/**
 * @param {ProtoMessage|undefined} value
 * @returns {value is PendingHeader}
 */
function isPendingHeader(value) {
    return value !== undefined && value !== null && typeof value === "object";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object";
}

/** @param {PendingHeader|undefined} header @returns {boolean} */
function isOrphanHeader(header) {
    if (!header) return false;
    return Boolean(header.orphan_status === true ||
        header.topoheight === -1 ||
        (header.errorSource !== "wallet_reward_lookup" && header.error && typeof header.error !== "string" && typeof header.error.message === "string" && (
            header.error.message.indexOf("can't get block by hash") > -1 ||
            header.error.message.indexOf("hash wasn't found") > -1 ||
            header.error.message.indexOf("Transaction not found") > -1 ||
            header.error.message.indexOf("Requested hash wasn't found in main blockchain") > -1
        )));
}

/** @param {number} port @returns {string} */
function formatCoinPort(port) {
    let coin = "";
    if (global.coinFuncs) {
        if (typeof global.coinFuncs.PORT2COIN_FULL === "function") {
            coin = global.coinFuncs.PORT2COIN_FULL(port) || "";
        } else if (typeof global.coinFuncs.PORT2COIN === "function") {
            coin = global.coinFuncs.PORT2COIN(port) || "";
        }
    }
    if (typeof coin !== "string" || coin.length === 0) coin = "PORT";
    return `${coin  }/${  port}`;
}

/** @param {unknown} err @param {PendingHeader|undefined} [header] @returns {string} */
function formatHeaderErrorDetail(err, header) {
    const detail = header && header.error ? header.error : err;
    if (!detail) return "";
    if (detail instanceof Error) return detail.message || String(detail);
    if (typeof detail === "string") return detail;
    if (isRecord(detail) && typeof detail["message"] === "string") return detail["message"];
    try {
        return JSON.stringify(detail);
    } catch (_error) {
        return String(detail);
    }
}

/** @param {Record<string, unknown>} fields @param {unknown} err @param {PendingHeader|undefined} header @returns {Record<string, unknown>} */
function withDetail(fields, err, header) {
    const detail = formatHeaderErrorDetail(err, header)
        .replace(/\s*\r?\n\s*/g, " ")
        .trim();
    if (detail) fields["detail"] = detail;
    return fields;
}

/** @param {string} item @param {Record<string, unknown>} values @param {string} fallback @returns {string} */
function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
            return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
        });
}

/** @param {StoredPendingJob} job @returns {BlockMessage|AltBlockMessage|null} */
function safeDecodePendingPayload(job) {
    if (!job || typeof job.payload !== "string" || !global.protos) return null;
    try {
        if (job.type === "block") return global.protos.Block.decode(Buffer.from(job.payload, "base64"));
        if (job.type === "altblock") return global.protos.AltBlock.decode(Buffer.from(job.payload, "base64"));
    } catch (_error) { /* undecodable payload; treat as no job */ }
    return null;
}

/** @param {unknown} key @returns {number|null} */
function parseAltPortFromJobKey(key) {
    if (typeof key !== "string") return null;
    const parts = key.split(":");
    if (parts.length < 2) return null;
    const part = parts[1];
    if (typeof part !== "string") return null;
    const port = parseInt(part, 10);
    return Number.isFinite(port) ? port : null;
}

/** @param {StoredPendingJob} job @param {number} timeNow @returns {string} */
function formatStalePendingBlock(job, timeNow) {
    const decoded = safeDecodePendingPayload(job);
    const fields = [`type=${  job.type}`];
    if (job.type === "altblock") {
        const decodedPort = decoded && typeof decoded["port"] === "number" ? decoded["port"] : null;
        const port = decodedPort || parseAltPortFromJobKey(job.key);
        if (port) fields.push(`chain=${  formatCoinPort(port)}`);
        const decodedHeight = decoded && typeof decoded["height"] === "number" ? decoded["height"] : null;
        if (decodedHeight) fields.push(`height=${  decodedHeight}`);
    } else {
        fields.push(`chain=${  formatCoinPort(global.config && global.config.daemon ? global.config.daemon.port : 0)}`);
        if (typeof job.blockId !== "undefined") fields.push(`blockId=${  job.blockId}`);
    }
    if (decoded && decoded.hash) fields.push(`hash=${  decoded.hash}`);
    else if (typeof job.key === "string") fields.push(`job=${  job.key}`);
    fields.push(`ageDays=${  Math.floor(Math.max(0, timeNow - job.createdAt) / DAY_MS)}`);
    fields.push(`attempts=${  job.attempts || 0}`);
    if (job.lastError) fields.push(`lastError=${  job.lastError}`);
    return fields.join(" ");
}

/**
 * JSON data in this database is an input boundary. Keep malformed rows visible
 * to the normal processing path so they can be removed instead of crashing a
 * periodic pending-job sweep.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {PendingJob}
 */
function normalizePendingJob(value, key) {
    if (!isRecord(value)) return { key, type: "invalid", invalid: true };
    const type = value["type"];
    const blockId = value["blockId"];
    const payload = value["payload"];
    const createdAt = value["createdAt"];
    const nextAttemptAt = value["nextAttemptAt"];
    const attempts = value["attempts"];
    const lastError = value["lastError"];
    if ((type !== "block" && type !== "altblock") || typeof blockId !== "number" ||
        !Number.isFinite(blockId) || typeof payload !== "string" ||
        typeof createdAt !== "number" || !Number.isFinite(createdAt) ||
        typeof nextAttemptAt !== "number" || !Number.isFinite(nextAttemptAt) ||
        typeof attempts !== "number" || !Number.isFinite(attempts) || attempts < 0 ||
        (typeof lastError !== "string" && lastError !== null)) {
        return { key, type: "invalid", invalid: true };
    }
    return {
        key,
        type,
        blockId,
        payload,
        createdAt,
        nextAttemptAt,
        attempts,
        lastError
    };
}

/** @param {PendingJob[]} jobs @param {number|null} nextDueAt @returns {DueJobs} */
function createDueJobs(jobs, nextDueAt) {
    return Object.assign(jobs.slice(), { nextDueAt });
}

/** @param {PendingJob} left @param {PendingJob} right @returns {number} */
function compareJobSchedule(left, right) {
    const leftAttempt = left.type === "invalid" ? Number.MAX_SAFE_INTEGER : left.nextAttemptAt;
    const rightAttempt = right.type === "invalid" ? Number.MAX_SAFE_INTEGER : right.nextAttemptAt;
    if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
    const leftCreated = left.type === "invalid" ? Number.MAX_SAFE_INTEGER : left.createdAt;
    const rightCreated = right.type === "invalid" ? Number.MAX_SAFE_INTEGER : right.createdAt;
    return leftCreated - rightCreated;
}

/** @param {unknown} cache @returns {number} */
function getRoundHashes(cache) {
    if (isRecord(cache) && typeof cache["roundHashes"] === "number") return cache["roundHashes"];
    return 0;
}

/** @param {BlockMessage|AltBlockMessage|undefined} block @returns {block is AltBlockMessage} */
function isAltBlockMessage(block) {
    return block !== undefined && typeof block["port"] === "number" && typeof block["height"] === "number";
}

/** @param {PendingHeader|undefined} header @returns {number|null} */
function getHeaderReward(header) {
    if (!header || typeof header.reward !== "number" || !header.reward) return null;
    return header.reward;
}

/** @param {DatabaseRuntime} database @returns {PendingStorage} */
function createLmdbStorage(database) {
    /** @type {LmdbDbi|null} */
    let pendingJobDb = null;

    function getPendingJobDb() {
        if (!pendingJobDb) {
            pendingJobDb = database.env.openDbi({
                name: PENDING_JOB_DB_NAME,
                create: true
            });
        }
        return pendingJobDb;
    }

    /**
     * @param {LmdbTxn} txn
     * @param {LmdbDbi|null} dbi
     * @param {(key: string|number|Buffer, value: string) => boolean|void} callback
     * @returns {void}
     */
    function withCursorEntries(txn, dbi, callback) {
        if (!dbi) return;
        const cursor = new database.lmdb.Cursor(txn, dbi);
        try {
            for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
                // getCurrentString invokes its callback synchronously; relay an
                // early-stop (callback returning false) out to break the cursor loop.
                let shouldContinue = true;
                cursor.getCurrentString(function onCurrentEntry(key, value) { // jshint ignore:line
                    if (callback(key, value) === false) shouldContinue = false;
                });
                if (!shouldContinue) break;
            }
        } finally {
            cursor.close();
        }
    }

    getPendingJobDb();

    return {
        /** @param {StoredPendingJob} job @returns {void} */
        save(job) {
            const txn = database.env.beginTxn();
            try {
                txn.putString(getPendingJobDb(), job.key, JSON.stringify(job));
                txn.commit();
            } catch (error) {
                txn.abort();
                throw error;
            }
        },

        /** @param {string} key @returns {void} */
        remove(key) {
            const txn = database.env.beginTxn();
            try {
                txn.del(getPendingJobDb(), key);
                txn.commit();
            } catch (error) {
                txn.abort();
                throw error;
            }
        },

        /** @param {number} timeNow @param {number} limit @returns {DueJobs} */
        loadDueJobs(timeNow, limit) {
            /** @type {Map<string, PendingJob>} */
            const jobsByKey = new Map();
            /** @type {number|null} */
            let nextDueAt = null;
            const txn = database.env.beginTxn({ readOnly: true });
            try {
                /** @param {string|number|Buffer} key @param {string} value @returns {boolean} */
                function collectJobs(key, value) {
                    if (jobsByKey.size >= limit) return false;
                    const normalizedKey = String(key);
                    if (jobsByKey.has(normalizedKey)) return true;
                    try {
                        const job = normalizePendingJob(JSON.parse(value), normalizedKey);
                        if (job.type === "invalid") jobsByKey.set(normalizedKey, job);
                        else if (job.nextAttemptAt <= timeNow) jobsByKey.set(normalizedKey, job);
                        else if (nextDueAt === null || job.nextAttemptAt < nextDueAt) {
                            nextDueAt = job.nextAttemptAt;
                        }
                    } catch (_error) {
                        jobsByKey.set(normalizedKey, { key: normalizedKey, type: "invalid", invalid: true });
                    }
                    return jobsByKey.size < limit;
                }

                withCursorEntries(txn, getPendingJobDb(), collectJobs);
            } finally {
                txn.abort();
            }
            const jobs = Array.from(jobsByKey.values());
            jobs.sort(compareJobSchedule);
            return createDueJobs(jobs, nextDueAt);
        },

        /** @returns {PendingJob[]} */
        loadAllJobs() {
            /** @type {PendingJob[]} */
            const jobs = [];
            const txn = database.env.beginTxn({ readOnly: true });
            try {
                withCursorEntries(txn, getPendingJobDb(), function collectJobs(key, value) {
                    const normalizedKey = String(key);
                    try {
                        jobs.push(normalizePendingJob(JSON.parse(value), normalizedKey));
                    } catch (_error) {
                        jobs.push({ key: normalizedKey, type: "invalid", invalid: true });
                    }
                });
            } finally {
                txn.abort();
            }
            return jobs;
        },

        close() {
            if (pendingJobDb && typeof pendingJobDb.close === "function") {
                pendingJobDb.close();
                pendingJobDb = null;
            }
        }
    };
}

/** @param {PendingOptions|undefined} options @returns {PendingJobs} */
module.exports = function createPendingJobs(options) {
    const opts = options || {};
    const database = opts.database || global.database;
    const retryDelayMs = opts.retryDelayMs || DEFAULT_RETRY_DELAY_MS;
    const maxRetryDelayMs = opts.maxRetryDelayMs || DEFAULT_MAX_RETRY_DELAY_MS;
    const orphanGraceMs = opts.orphanGraceMs || 10 * 60 * 1000;
    const stalePendingBlockAgeMs = typeof opts.stalePendingBlockAgeMs === "number" ? opts.stalePendingBlockAgeMs : DEFAULT_STALE_PENDING_BLOCK_AGE_MS;
    const stalePendingBlockAlertCheckMs = typeof opts.stalePendingBlockAlertCheckMs === "number" ? opts.stalePendingBlockAlertCheckMs : DEFAULT_STALE_PENDING_BLOCK_ALERT_CHECK_MS;
    const stalePendingBlockAlertCooldownMs = typeof opts.stalePendingBlockAlertCooldownMs === "number" ? opts.stalePendingBlockAlertCooldownMs : DEFAULT_STALE_PENDING_BLOCK_ALERT_COOLDOWN_MS;
    const stalePendingBlockSampleLimit = typeof opts.stalePendingBlockSampleLimit === "number" ? opts.stalePendingBlockSampleLimit : DEFAULT_STALE_PENDING_BLOCK_SAMPLE_LIMIT;
    const stalePendingBlockProcessLimit = typeof opts.stalePendingBlockProcessLimit === "number" ? opts.stalePendingBlockProcessLimit : DEFAULT_STALE_PENDING_BLOCK_PROCESS_LIMIT;
    const stalePendingBlockRetryDelayMs = typeof opts.stalePendingBlockRetryDelayMs === "number" ? opts.stalePendingBlockRetryDelayMs : DEFAULT_STALE_PENDING_BLOCK_RETRY_DELAY_MS;
    const logger = opts.logger || console;
    const storage = opts.storage || createLmdbStorage(database);

    /** @type {PendingState} */
    const state = {
        closed: false,
        closeComplete: false,
        closePromise: null,
        closeReject: null,
        closeResolve: null,
        processing: false,
        badAltBlocks: new Map(),
        potentiallyBadAltBlocks: new Map(),
        orphanSince: new Map(),
        loggedStates: new Map(),
        lastStalePendingBlockAlertCheckAt: 0,
        nextDueJobCheckAt: 0
    };

    /** @param {string} jobKey @param {string} nextState @param {string} message @returns {void} */
    function logState(jobKey, nextState, message) {
        const prev = state.loggedStates.get(jobKey);
        if (!prev || prev.state !== nextState) {
            logger.log(message);
            state.loggedStates.set(jobKey, { state: nextState, time: Date.now() });
        }
    }

    /** @param {string} jobKey @returns {void} */
    function clearState(jobKey) {
        state.loggedStates.delete(jobKey);
        state.orphanSince.delete(jobKey);
    }

    /** @returns {void} */
    function clearTransientState() {
        state.badAltBlocks.clear();
        state.potentiallyBadAltBlocks.clear();
        state.orphanSince.clear();
        state.loggedStates.clear();
    }

    /** @returns {void} */
    function pruneState() {
        const timeNow = Date.now();
        for (const [hash, seenAt] of state.badAltBlocks.entries()) {
            if (timeNow - seenAt > ALT_BAD_BLOCK_TTL_MS) state.badAltBlocks.delete(hash);
        }
        for (const [port, blockMap] of state.potentiallyBadAltBlocks.entries()) {
            for (const [hash, seenAt] of blockMap.entries()) {
                if (timeNow - seenAt > ALT_POTENTIALLY_BAD_TTL_MS) blockMap.delete(hash);
            }
            if (blockMap.size === 0) state.potentiallyBadAltBlocks.delete(port);
        }
        for (const [jobKey, seenAt] of state.orphanSince.entries()) {
            if (timeNow - seenAt > ORPHAN_TRACK_TTL_MS) state.orphanSince.delete(jobKey);
        }
        for (const [jobKey, seen] of state.loggedStates.entries()) {
            if (timeNow - seen.time > LOG_STATE_TTL_MS) state.loggedStates.delete(jobKey);
        }
    }

    /** @returns {void} */
    function finishCloseIfIdle() {
        if (!state.closed || state.processing || state.closeComplete || state.closeResolve === null || state.closeReject === null) return;
        state.closeComplete = true;
        const resolve = state.closeResolve;
        const reject = state.closeReject;
        state.closePromise = null;
        state.closeResolve = null;
        state.closeReject = null;
        try {
            storage.close();
            clearTransientState();
            resolve();
        } catch (error) {
            clearTransientState();
            reject(error);
        }
    }

    /** @param {StoredPendingJob} job @param {string} stateName @param {string} message @param {RetryOptions|undefined} retryOpts @returns {void} */
    function saveRetry(job, stateName, message, retryOpts) {
        const retryOptions = retryOpts || {};
        const timeNow = Date.now();
        job.attempts += 1;
        let nextRetryDelayMs = retryDelayMs;
        if (retryOptions.backoff === true) {
            const retryMultiplier = Math.pow(2, Math.max(0, job.attempts - 1));
            const retryBackoffMs = retryDelayMs * retryMultiplier;
            nextRetryDelayMs = Math.min(retryBackoffMs, maxRetryDelayMs);
        }
        if (retryOptions.stale === true) nextRetryDelayMs = Math.max(nextRetryDelayMs, stalePendingBlockRetryDelayMs);
        job.nextAttemptAt = Math.round(timeNow + nextRetryDelayMs);
        job.lastError = stateName;
        storage.save(job);
        if (message) logState(job.key, stateName, message);
    }

    /** @param {StoredPendingJob} job @param {string} stateName @param {string} message @returns {void} */
    function saveDrop(job, stateName, message) {
        if (message) logState(job.key, stateName, message);
        storage.remove(job.key);
        clearState(job.key);
    }

    /** @param {OrphanOptions} orphanOptions @returns {void} */
    function handleOrphanHeader(orphanOptions) {
        const {
            job,
            block,
            fields,
            timeNow,
            error,
            header,
            retryState,
            event,
            saveResolved,
            callback
        } = orphanOptions;
        const firstSeen = state.orphanSince.get(job.key) || timeNow;
        state.orphanSince.set(job.key, firstSeen);
        if (timeNow - firstSeen >= orphanGraceMs) {
            block.value = 0;
            block.valid = false;
            block.unlocked = true;
            const result = saveResolved(job.blockId, block);
            saveDrop(job, result.status, formatLogEvent(event, Object.assign({}, fields, { status: "orphan-finalized" })));
            callback();
            return;
        }
        saveRetry(job, retryState, formatLogEvent(event, withDetail(Object.assign({}, fields, {
            status: "waiting-orphan-confirmation"
        }), error, header)), undefined);
        callback();
    }

    /** @param {PendingJob} job @param {number} timeNow @returns {job is StoredPendingJob} */
    function isStalePendingBlock(job, timeNow) {
        if (!job || (job.type !== "block" && job.type !== "altblock")) return false;
        if (typeof job.createdAt !== "number") return false;
        return timeNow - job.createdAt >= stalePendingBlockAgeMs;
    }

    /** @param {StoredPendingJob} job @param {number} timeNow @returns {void} */
    function saveStaleThrottle(job, timeNow) {
        job.nextAttemptAt = Math.round(timeNow + stalePendingBlockRetryDelayMs);
        job.lastError = "stale_pending_throttled";
        storage.save(job);
        logState(job.key, "stale_pending_throttled", formatLogEvent("Pending job", {
            job: job.key,
            status: "stale-throttled",
            ageDays: Math.floor(Math.max(0, timeNow - job.createdAt) / DAY_MS)
        }));
    }

    /** @param {PendingJob[]} jobs @param {number} timeNow @returns {PendingJob[]} */
    function selectJobsForProcessing(jobs, timeNow) {
        /** @type {PendingJob[]} */
        const selected = [];
        const staleLimit = Math.max(0, stalePendingBlockProcessLimit);
        let staleSelected = 0;
        for (const job of jobs) {
            if (isStalePendingBlock(job, timeNow)) {
                if (staleSelected >= staleLimit) {
                    saveStaleThrottle(job, timeNow);
                    continue;
                }
                staleSelected += 1;
            }
            selected.push(job);
        }
        return selected;
    }

    /** @param {number} timeNow @returns {void} */
    function maybeSendStalePendingBlockAlert(timeNow) {
        if (state.lastStalePendingBlockAlertCheckAt && timeNow - state.lastStalePendingBlockAlertCheckAt < stalePendingBlockAlertCheckMs) return;
        state.lastStalePendingBlockAlertCheckAt = timeNow;
        if (!global.support || typeof global.support.sendAdminFyi !== "function") return;
        if (!global.config || !global.config.general || !global.config.general.adminEmail) return;

        let staleJobs;
        try {
            staleJobs = storage.loadAllJobs().filter(function findStalePendingBlock(job) {
                return isStalePendingBlock(job, timeNow);
            });
        } catch (error) {
            if (logger && typeof logger.log === "function") {
                logger.log(formatLogEvent("Pending block alert", {
                    status: "failed",
                    detail: formatHeaderErrorDetail(error)
                }));
            }
            return;
        }
        if (staleJobs.length === 0) return;

        staleJobs.sort(function byAge(left, right) {
            return left.createdAt - right.createdAt || String(left.key).localeCompare(String(right.key));
        });

        const sampleJobs = staleJobs.slice(0, Math.max(1, stalePendingBlockSampleLimit));
        const jobLines = sampleJobs.map(function formatJob(job) {
            return `- ${  formatStalePendingBlock(job, timeNow)}`;
        });
        if (staleJobs.length > sampleJobs.length) {
            jobLines.push(`- ... ${  staleJobs.length - sampleJobs.length  } more pending block(s) omitted`);
        }

        const values = {
            count: staleJobs.length,
            age_days: Math.floor(stalePendingBlockAgeMs / DAY_MS),
            jobs: jobLines.join("\n")
        };
        /** @type {(key: string, subject: string, body: string, options?: {cooldownMs: number}) => void} */
        const sendAdminFyi = global.support.sendAdminFyi;
        sendAdminFyi(
            "remote_share:stale-pending-blocks",
            renderEmailTemplate("remoteShareStalePendingSubject", values, "FYI: Pending blocks not verified for over a month"),
            renderEmailTemplate("remoteShareStalePendingBody", values, "remote_share has %(count)s pending block(s) older than %(age_days)s days.\n\n%(jobs)s\n\nPlease verify wallet/daemon sync and pending_blocks."),
            { cooldownMs: stalePendingBlockAlertCooldownMs }
        );
    }

    /** @param {number} blockId @param {BlockMessage|AltBlockMessage} blockDataDecoded @returns {{status: string}} */
    function saveResolvedBlock(blockId, blockDataDecoded) {
        const shares = database.getCache(`${poolTypeStr(blockDataDecoded.poolType)  }_stats2`);
        blockDataDecoded.shares = getRoundHashes(shares);

        const txn = database.env.beginTxn();
        try {
            const existingBinary = txn.getBinary(database.blockDB, blockId);
            if (existingBinary !== null) {
                const existing = global.protos.Block.decode(existingBinary);
                // Main blocks are keyed by height, so two blocks at the same height collide. If the
                // recorded block has the SAME hash it is a genuine duplicate. If it is a DIFFERENT
                // hash but was already orphaned (valid===false, e.g. invalidated after a reorg), the
                // newly-resolved valid block is the canonical one for this height -> replace the orphan
                // tombstone instead of dropping the new block. If a DIFFERENT still-valid block holds
                // the slot we cannot keep both at this height key, so it is left as "duplicate"
                // (the full fix -- height in the Block value + forward-probe, like AltBlock -- is
                // tracked as R14 option 1).
                if (existing.hash === blockDataDecoded.hash || existing.valid !== false) {
                    txn.abort();
                    return { status: "duplicate" };
                }
            }
            txn.putBinary(database.blockDB, blockId, global.protos.Block.encode(blockDataDecoded));
            txn.commit();
        } catch (error) {
            txn.abort();
            throw error;
        }

        database.incrementCacheData("global_stats2", [{ location: "roundHashes", value: false }]);
        database.incrementCacheData(`${poolTypeStr(blockDataDecoded.poolType)  }_stats2`, [{ location: "roundHashes", value: false }]);
        return { status: "stored" };
    }

    /** @param {number} blockId @param {AltBlockMessage} blockDataDecoded @returns {{status: string}} */
    function saveResolvedAltBlock(blockId, blockDataDecoded) {
        const portSuffix = `_${  blockDataDecoded.port.toString()}`;
        const shares = database.getCache(`${poolTypeStr(blockDataDecoded.poolType)  }_stats2${  portSuffix}`);
        blockDataDecoded.shares = getRoundHashes(shares);
        blockDataDecoded.pay_value = 0;

        const txn = database.env.beginTxn();
        try {
            // Distinct alt-blocks can share a blockId, so probe forward for a free slot,
            // bailing out early if this exact hash is already stored.
            let currentBlockId = blockId;
            let existingBlockData;
            while ((existingBlockData = txn.getBinary(database.altblockDB, currentBlockId)) !== null) {
                const existingBlock = global.protos.AltBlock.decode(existingBlockData);
                if (existingBlock.hash === blockDataDecoded.hash) {
                    txn.abort();
                    return { status: "duplicate" };
                }
                currentBlockId += 1;
            }
            txn.putBinary(database.altblockDB, currentBlockId, global.protos.AltBlock.encode(blockDataDecoded));
            txn.commit();
        } catch (error) {
            txn.abort();
            throw error;
        }

        database.incrementCacheData(`global_stats2${  portSuffix}`, [{ location: "roundHashes", value: false }]);
        database.incrementCacheData(`${poolTypeStr(blockDataDecoded.poolType)  }_stats2${  portSuffix}`, [{ location: "roundHashes", value: false }]);
        return { status: "stored" };
    }

    /** @param {StoredPendingJob} job @param {() => void} callback @returns {void} */
    function processBlockJob(job, callback) {
        let blockDataDecoded;
        try {
            blockDataDecoded = global.protos.Block.decode(Buffer.from(job.payload, "base64"));
        } catch (_error) {
            saveDrop(job, "invalid_block_payload", formatLogEvent("Pending block", { job: job.key, status: "invalid-payload" }));
            return callback();
        }
        const blockFields = {
            chain: formatCoinPort(global.config.daemon.port),
            hash: blockDataDecoded.hash
        };

        global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function onHeader(err, header) {
            const timeNow = Date.now();
            const pendingHeader = isPendingHeader(header) ? header : undefined;
            const orphanHeader = err && isOrphanHeader(pendingHeader);
            if (orphanHeader) {
                return handleOrphanHeader({
                    job,
                    block: blockDataDecoded,
                    fields: blockFields,
                    timeNow,
                    error: err,
                    header: pendingHeader,
                    retryState: "waiting_orphan",
                    event: "Pending block",
                    saveResolved: saveResolvedBlock,
                    callback
                });
            }

            const reward = getHeaderReward(pendingHeader);
            if (err || reward === null) {
                /** @type {RetryOptions} */
                const retryOptions = { backoff: true };
                if (isStalePendingBlock(job, timeNow)) retryOptions.stale = true;
                saveRetry(job, "waiting_block_header", formatLogEvent("Pending block", withDetail(Object.assign({}, blockFields, {
                    status: "waiting-header-reward"
                }), err, pendingHeader)), retryOptions);
                return callback();
            }

            blockDataDecoded.value = reward;
            const result = saveResolvedBlock(job.blockId, blockDataDecoded);
            saveDrop(job, result.status, formatLogEvent("Pending block", Object.assign({}, blockFields, {
                status: result.status === "stored" ? "stored" : "duplicate-skipped"
            })));
            return callback();
        }, true);
    }

    /** @param {number} port @param {number} timeNow @returns {void} */
    function markBadAltBlocks(port, timeNow) {
        if (!state.potentiallyBadAltBlocks.has(port)) return;
        const badBlockMap = state.potentiallyBadAltBlocks.get(port);
        if (!badBlockMap) return;
        for (const hash of badBlockMap.keys()) state.badAltBlocks.set(hash, timeNow);
        state.potentiallyBadAltBlocks.delete(port);
    }

    /** @param {CoinProfile|null} profile @param {PendingHeader|undefined} header @returns {boolean} */
    function isWaitingForAltDepth(profile, header) {
        const unlockConfirmationDepth = profile && isRecord(profile.rpc) && typeof profile.rpc["unlockConfirmationDepth"] === "number"
            ? profile.rpc["unlockConfirmationDepth"]
            : 0;
        return unlockConfirmationDepth > 0 && header !== undefined && typeof header.depth === "number" && header.depth < unlockConfirmationDepth;
    }

    /** @param {StoredPendingJob} job @param {() => void} callback @returns {void} */
    function processAltBlockJob(job, callback) {
        let blockDataDecoded;
        try {
            blockDataDecoded = global.protos.AltBlock.decode(Buffer.from(job.payload, "base64"));
        } catch (_error) {
            saveDrop(job, "invalid_altblock_payload", formatLogEvent("Pending altblock", { job: job.key, status: "invalid-payload" }));
            return callback();
        }
        const altBlockFields = {
            chain: formatCoinPort(blockDataDecoded.port),
            height: blockDataDecoded.height,
            hash: blockDataDecoded.hash
        };

        global.coinFuncs.getPortBlockHeaderByHash(blockDataDecoded.port, blockDataDecoded.hash, function onHeader(err, header) {
            const timeNow = Date.now();
            const pendingHeader = isPendingHeader(header) ? header : undefined;

            if (err && isOrphanHeader(pendingHeader)) {
                return handleOrphanHeader({
                    job,
                    block: blockDataDecoded,
                    fields: altBlockFields,
                    timeNow,
                    error: err,
                    header: pendingHeader,
                    retryState: "waiting_alt_orphan",
                    event: "Pending altblock",
                    saveResolved(blockId, block) {
                        if (!isAltBlockMessage(block)) throw new Error("Invalid altblock orphan payload");
                        return saveResolvedAltBlock(blockId, block);
                    },
                    callback
                });
            }

            const profile = global.coinFuncs.getPoolProfile(blockDataDecoded.port);
            if (isWaitingForAltDepth(profile, pendingHeader)) {
                /** @type {RetryOptions|undefined} */
                const retryOptions = isStalePendingBlock(job, timeNow) ? { stale: true } : undefined;
                saveRetry(job, "waiting_for_depth", formatLogEvent("Pending altblock", Object.assign({}, altBlockFields, { status: "waiting-maturity" })), retryOptions);
                return callback();
            }

            const reward = getHeaderReward(pendingHeader);
            if (err || reward === null) {
                if (state.badAltBlocks.has(blockDataDecoded.hash)) {
                    saveDrop(job, "invalid_altblock", formatLogEvent("Pending altblock", Object.assign({}, altBlockFields, { status: "invalid-dropped" })));
                    return callback();
                }
                const badBlockMap = state.potentiallyBadAltBlocks.get(blockDataDecoded.port) || new Map();
                badBlockMap.set(blockDataDecoded.hash, timeNow);
                state.potentiallyBadAltBlocks.set(blockDataDecoded.port, badBlockMap);
                /** @type {RetryOptions} */
                const retryOptions = { backoff: true };
                if (isStalePendingBlock(job, timeNow)) retryOptions.stale = true;
                saveRetry(job, "waiting_altblock_header", formatLogEvent("Pending altblock", withDetail(Object.assign({}, altBlockFields, {
                    status: "waiting-header-reward"
                }), err, pendingHeader)), retryOptions);
                return callback();
            }

            markBadAltBlocks(blockDataDecoded.port, timeNow);
            blockDataDecoded.value = reward;
            const result = saveResolvedAltBlock(job.blockId, blockDataDecoded);
            saveDrop(job, result.status, formatLogEvent("Pending altblock", Object.assign({}, altBlockFields, {
                status: result.status === "stored" ? "stored" : "duplicate-skipped"
            })));
            return callback();
        }, true);
    }

    /** @param {PendingJob} job @param {() => void} callback @returns {void} */
    function processJob(job, callback) {
        if (!job.key) return callback();
        if (job.type === "invalid") {
            storage.remove(job.key);
            clearState(job.key);
            return callback();
        }
        if (job.type === "block") return processBlockJob(job, callback);
        if (job.type === "altblock") return processAltBlockJob(job, callback);
        saveDrop(job, "unknown_job_type", formatLogEvent("Pending job", { job: job.key, status: "unknown-type" }));
        return callback();
    }

    return {
        /** @param {number} blockId @param {Buffer} payload @param {BlockMessage} block @returns {void} */
        enqueueBlock(blockId, payload, block) {
            state.nextDueJobCheckAt = 0;
            storage.save({
                key: `block:${  blockId  }:${  block.hash}`,
                type: "block",
                blockId,
                payload: Buffer.from(payload).toString("base64"),
                createdAt: Date.now(),
                nextAttemptAt: Date.now(),
                attempts: 0,
                lastError: null
            });
        },

        /** @param {number} blockId @param {Buffer} payload @param {AltBlockMessage} block @returns {void} */
        enqueueAltBlock(blockId, payload, block) {
            state.nextDueJobCheckAt = 0;
            storage.save({
                key: `alt:${  block.port  }:${  block.height  }:${  block.hash}`,
                type: "altblock",
                blockId,
                payload: Buffer.from(payload).toString("base64"),
                createdAt: Date.now(),
                nextAttemptAt: Date.now(),
                attempts: 0,
                lastError: null
            });
        },

        /** @returns {void} */
        processDueJobs() {
            if (state.processing || state.closed) return;
            const timeNow = Date.now();
            maybeSendStalePendingBlockAlert(timeNow);
            if (state.nextDueJobCheckAt && timeNow < state.nextDueJobCheckAt) return;
            state.processing = true;
            try {
                pruneState();

                const jobs = storage.loadDueJobs(timeNow, 100);
                if (jobs.length === 0 && typeof jobs.nextDueAt === "number") {
                    state.nextDueJobCheckAt = jobs.nextDueAt;
                } else {
                    state.nextDueJobCheckAt = 0;
                }
                const jobsToProcess = selectJobsForProcessing(jobs, timeNow);
                let index = 0;
                const next = () => {
                    if (index >= jobsToProcess.length) {
                        state.processing = false;
                        finishCloseIfIdle();
                        return;
                    }
                    const job = jobsToProcess[index++];
                    if (!job) return next();
                    processJob(job, next);
                };
                next();
            } catch (error) {
                state.processing = false;
                finishCloseIfIdle();
                throw error;
            }
        },

        /** @returns {string} */
        getPendingSummary() {
            const jobs = storage.loadAllJobs();
            if (jobs.length === 0) return "";

            /** @type {Record<string, number>} */
            const counts = Object.create(null);
            for (const job of jobs) {
                const label = job && job.type === "altblock" && typeof job.key === "string"
                    ? formatCoinPort(parseAltPortFromJobKey(job.key) || global.config.daemon.port)
                    : formatCoinPort(global.config.daemon.port);
                counts[label] = (counts[label] || 0) + 1;
            }

            const parts = Object.keys(counts).sort().map(function formatPart(label) {
                return `${label  }=${  counts[label] ?? 0}`;
            });

            return `Pending blocks: total=${  jobs.length  } ${  parts.join(" ")}`;
        },

        /** @returns {Promise<void>} */
        close() {
            if (state.closeComplete) return Promise.resolve();
            if (state.closePromise) return state.closePromise;
            state.closed = true;
            state.closePromise = new Promise((resolve, reject) => {
                state.closeResolve = resolve;
                state.closeReject = reject;
                finishCloseIfIdle();
            });
            return state.closePromise;
        }
    };
};
