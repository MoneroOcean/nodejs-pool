"use strict";

const PENDING_JOB_DB_NAME = "pending_blocks";
const ALT_BAD_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const ALT_POTENTIALLY_BAD_TTL_MS = 60 * 60 * 1000;
const ORPHAN_TRACK_TTL_MS = 12 * 60 * 60 * 1000;
const LOG_STATE_TTL_MS = 12 * 60 * 60 * 1000;

function poolTypeStr(poolType) {
    return poolType === global.protos.POOLTYPE.PPLNS ? "pplns" : "legacy";
}

function isOrphanHeader(header) {
    if (!header) return false;
    return header.orphan_status === true ||
        header.topoheight === -1 ||
        (header.error && typeof header.error.message === "string" && (
            header.error.message.indexOf("can't get block by hash") > -1 ||
            header.error.message.indexOf("hash wasn't found") > -1 ||
            header.error.message.indexOf("Transaction not found") > -1 ||
            header.error.message.indexOf("Requested hash wasn't found in main blockchain") > -1
        ));
}

function nowMs() {
    return Date.now();
}

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
    return coin + "/" + port;
}

function getJobPort(job) {
    if (job && job.type === "altblock" && typeof job.key === "string") {
        const parts = job.key.split(":");
        const port = parseInt(parts[1], 10);
        if (Number.isFinite(port) && port > 0) return port;
    }
    return global.config.daemon.port;
}

function formatBlockLabel(hash) {
    return "Block " + formatCoinPort(global.config.daemon.port) + " hash " + hash;
}

function formatAltBlockLabel(blockDataDecoded) {
    return "Altblock " + formatCoinPort(blockDataDecoded.port) +
        " height " + blockDataDecoded.height +
        " hash " + blockDataDecoded.hash;
}

function createLmdbStorage(database) {
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

    function withCursorEntries(txn, dbi, callback) {
        if (!dbi) return;
        const cursor = new database.lmdb.Cursor(txn, dbi);
        try {
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                cursor.getCurrentString(callback); // jshint ignore:line
            }
        } finally {
            cursor.close();
        }
    }

    getPendingJobDb();

    return {
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

        loadDueJobs(timeNow, limit) {
            const jobsByKey = new Map();
            const txn = database.env.beginTxn({ readOnly: true });
            try {
                function collectJobs(key, value) {
                    if (jobsByKey.size >= limit || jobsByKey.has(key)) return;
                    try {
                        const job = JSON.parse(value);
                        if (job.nextAttemptAt <= timeNow) jobsByKey.set(key, job);
                    } catch (_error) {
                        jobsByKey.set(key, { key, type: "invalid", invalid: true });
                    }
                }

                withCursorEntries(txn, getPendingJobDb(), collectJobs);
            } finally {
                txn.abort();
            }
            const jobs = Array.from(jobsByKey.values());
            jobs.sort(function bySchedule(left, right) {
                return left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt;
            });
            return jobs;
        },

        loadAllJobs() {
            const jobs = [];
            const txn = database.env.beginTxn({ readOnly: true });
            try {
                withCursorEntries(txn, getPendingJobDb(), function collectJobs(key, value) {
                    try {
                        jobs.push(JSON.parse(value));
                    } catch (_error) {
                        jobs.push({ key, type: "invalid", invalid: true });
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

module.exports = function createPendingJobs(options) {
    const opts = options || {};
    const database = opts.database || global.database;
    const retryDelayMs = opts.retryDelayMs || 30 * 1000;
    const orphanGraceMs = opts.orphanGraceMs || 10 * 60 * 1000;
    const logger = opts.logger || console;
    const storage = opts.storage || createLmdbStorage(database);

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
        loggedStates: new Map()
    };

    function logState(jobKey, nextState, message) {
        const prev = state.loggedStates.get(jobKey);
        if (!prev || prev.state !== nextState) {
            logger.log(message);
            state.loggedStates.set(jobKey, { state: nextState, time: nowMs() });
        }
    }

    function clearState(jobKey) {
        state.loggedStates.delete(jobKey);
        state.orphanSince.delete(jobKey);
    }

    function clearTransientState() {
        state.badAltBlocks.clear();
        state.potentiallyBadAltBlocks.clear();
        state.orphanSince.clear();
        state.loggedStates.clear();
    }

    function pruneState() {
        const timeNow = nowMs();
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

    function finishCloseIfIdle() {
        if (!state.closed || state.processing || state.closeComplete || state.closeResolve === null) return;
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

    function saveRetry(job, stateName, message) {
        const timeNow = nowMs();
        job.attempts += 1;
        job.nextAttemptAt = timeNow + retryDelayMs;
        job.lastError = stateName;
        storage.save(job);
        if (message) logState(job.key, stateName, message);
    }

    function saveDrop(job, stateName, message) {
        if (message) logState(job.key, stateName, message);
        storage.remove(job.key);
        clearState(job.key);
    }

    function saveResolvedBlock(blockId, blockDataDecoded) {
        const shares = database.getCache(poolTypeStr(blockDataDecoded.poolType) + "_stats2");
        blockDataDecoded.shares = shares ? shares.roundHashes : 0;

        const txn = database.env.beginTxn();
        try {
            if (txn.getBinary(database.blockDB, blockId) !== null) {
                txn.abort();
                return { status: "duplicate" };
            }
            txn.putBinary(database.blockDB, blockId, global.protos.Block.encode(blockDataDecoded));
            txn.commit();
        } catch (error) {
            txn.abort();
            throw error;
        }

        database.incrementCacheData("global_stats2", [{ location: "roundHashes", value: false }]);
        database.incrementCacheData(poolTypeStr(blockDataDecoded.poolType) + "_stats2", [{ location: "roundHashes", value: false }]);
        return { status: "stored" };
    }

    function saveResolvedAltBlock(blockId, blockDataDecoded) {
        const portSuffix = "_" + blockDataDecoded.port.toString();
        const shares = database.getCache(poolTypeStr(blockDataDecoded.poolType) + "_stats2" + portSuffix);
        blockDataDecoded.shares = shares ? shares.roundHashes : 0;
        blockDataDecoded.pay_value = 0;

        if (database.isAltBlockInDB(blockDataDecoded.port, blockDataDecoded.height)) {
            return { status: "duplicate" };
        }

        const txn = database.env.beginTxn();
        try {
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

        database.incrementCacheData("global_stats2" + portSuffix, [{ location: "roundHashes", value: false }]);
        database.incrementCacheData(poolTypeStr(blockDataDecoded.poolType) + "_stats2" + portSuffix, [{ location: "roundHashes", value: false }]);
        return { status: "stored" };
    }

    function processBlockJob(job, callback) {
        let blockDataDecoded;
        try {
            blockDataDecoded = global.protos.Block.decode(Buffer.from(job.payload, "base64"));
        } catch (_error) {
            saveDrop(job, "invalid_block_payload", "Dropping invalid block payload for " + job.key);
            return callback();
        }
        const blockLabel = formatBlockLabel(blockDataDecoded.hash);

        global.coinFuncs.getBlockHeaderByHash(blockDataDecoded.hash, function onHeader(err, header) {
            const timeNow = nowMs();
            if (err && isOrphanHeader(header)) {
                const orphanKey = job.key;
                const firstSeen = state.orphanSince.get(orphanKey) || timeNow;
                state.orphanSince.set(orphanKey, firstSeen);
                if (timeNow - firstSeen >= orphanGraceMs) {
                    blockDataDecoded.value = 0;
                    blockDataDecoded.valid = false;
                    blockDataDecoded.unlocked = true;
                    const result = saveResolvedBlock(job.blockId, blockDataDecoded);
                    saveDrop(job, result.status, blockLabel + " finalized as orphan");
                    return callback();
                }
                saveRetry(job, "waiting_orphan", blockLabel + " waiting for orphan confirmation");
                return callback();
            }

            if (err || !header || !header.reward) {
                saveRetry(job, "waiting_block_header", blockLabel + " waiting for header/reward");
                return callback();
            }

            blockDataDecoded.value = header.reward;
            const result = saveResolvedBlock(job.blockId, blockDataDecoded);
            saveDrop(job, result.status, blockLabel + (result.status === "stored" ? " stored" : " duplicate, skipped"));
            return callback();
        });
    }

    function markBadAltBlocks(port, timeNow) {
        if (!state.potentiallyBadAltBlocks.has(port)) return;
        const badBlockMap = state.potentiallyBadAltBlocks.get(port);
        for (const hash of badBlockMap.keys()) state.badAltBlocks.set(hash, timeNow);
        state.potentiallyBadAltBlocks.delete(port);
    }

    function processAltBlockJob(job, callback) {
        let blockDataDecoded;
        try {
            blockDataDecoded = global.protos.AltBlock.decode(Buffer.from(job.payload, "base64"));
        } catch (_error) {
            saveDrop(job, "invalid_altblock_payload", "Dropping invalid altblock payload for " + job.key);
            return callback();
        }
        const altBlockLabel = formatAltBlockLabel(blockDataDecoded);

        global.coinFuncs.getPortBlockHeaderByHash(blockDataDecoded.port, blockDataDecoded.hash, function onHeader(err, header) {
            const timeNow = nowMs();

            if (err && isOrphanHeader(header)) {
                const orphanKey = job.key;
                const firstSeen = state.orphanSince.get(orphanKey) || timeNow;
                state.orphanSince.set(orphanKey, firstSeen);
                if (timeNow - firstSeen >= orphanGraceMs) {
                    blockDataDecoded.value = 0;
                    blockDataDecoded.valid = false;
                    blockDataDecoded.unlocked = true;
                    const result = saveResolvedAltBlock(job.blockId, blockDataDecoded);
                    saveDrop(job, result.status, altBlockLabel + " finalized as orphan");
                    return callback();
                }
                saveRetry(job, "waiting_alt_orphan", altBlockLabel + " waiting for orphan confirmation");
                return callback();
            }

            const profile = global.coinFuncs.getPoolProfile(blockDataDecoded.port);
            const unlockConfirmationDepth = profile && profile.rpc ? profile.rpc.unlockConfirmationDepth : 0;
            if (unlockConfirmationDepth && header && header.depth < unlockConfirmationDepth) {
                saveRetry(job, "waiting_for_depth", altBlockLabel + " waiting for maturity");
                return callback();
            }

            if (err || !header || !header.reward) {
                if (state.badAltBlocks.has(blockDataDecoded.hash)) {
                    saveDrop(job, "invalid_altblock", altBlockLabel + " invalid, dropped");
                    return callback();
                }
                const badBlockMap = state.potentiallyBadAltBlocks.get(blockDataDecoded.port) || new Map();
                badBlockMap.set(blockDataDecoded.hash, timeNow);
                state.potentiallyBadAltBlocks.set(blockDataDecoded.port, badBlockMap);
                saveRetry(job, "waiting_altblock_header", altBlockLabel + " waiting for header/reward");
                return callback();
            }

            markBadAltBlocks(blockDataDecoded.port, timeNow);
            blockDataDecoded.value = header.reward;
            const result = saveResolvedAltBlock(job.blockId, blockDataDecoded);
            saveDrop(job, result.status, altBlockLabel + (result.status === "stored" ? " stored" : " duplicate, skipped"));
            return callback();
        });
    }

    function processJob(job, callback) {
        if (!job || !job.key) return callback();
        if (job.invalid === true) {
            storage.remove(job.key);
            clearState(job.key);
            return callback();
        }
        if (job.type === "block") return processBlockJob(job, callback);
        if (job.type === "altblock") return processAltBlockJob(job, callback);
        saveDrop(job, "unknown_job_type", "Dropping unknown remote_share pending job " + job.key);
        return callback();
    }

    return {
        enqueueBlock(blockId, payload, block) {
            storage.save({
                key: "block:" + blockId + ":" + block.hash,
                type: "block",
                blockId,
                payload: Buffer.from(payload).toString("base64"),
                createdAt: nowMs(),
                nextAttemptAt: nowMs(),
                attempts: 0,
                lastError: null
            });
        },

        enqueueAltBlock(blockId, payload, block) {
            storage.save({
                key: "alt:" + block.port + ":" + block.height + ":" + block.hash,
                type: "altblock",
                blockId,
                payload: Buffer.from(payload).toString("base64"),
                createdAt: nowMs(),
                nextAttemptAt: nowMs(),
                attempts: 0,
                lastError: null
            });
        },

        processDueJobs() {
            if (state.processing || state.closed) return;
            state.processing = true;
            try {
                pruneState();

                const jobs = storage.loadDueJobs(nowMs(), 100);
                let index = 0;
                const next = () => {
                    if (index >= jobs.length) {
                        state.processing = false;
                        finishCloseIfIdle();
                        return;
                    }
                    processJob(jobs[index++], next);
                };
                next();
            } catch (error) {
                state.processing = false;
                finishCloseIfIdle();
                throw error;
            }
        },

        getPendingSummary() {
            const jobs = storage.loadAllJobs();
            if (jobs.length === 0) return "";

            const counts = Object.create(null);
            for (const job of jobs) {
                const label = formatCoinPort(getJobPort(job));
                counts[label] = (counts[label] || 0) + 1;
            }

            const parts = Object.keys(counts).sort().map(function formatPart(label) {
                return label + "=" + counts[label];
            });

            return "Pending blocks: total=" + jobs.length + " " + parts.join(" ");
        },

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
