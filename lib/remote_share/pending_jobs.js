"use strict";

const PENDING_JOB_DB_NAME = "remoteSharePending";
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
            const jobs = [];
            const txn = database.env.beginTxn({ readOnly: true });
            const cursor = new database.lmdb.Cursor(txn, getPendingJobDb());
            try {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentString(function onCurrent(key, value) { // jshint ignore:line
                        try {
                            const job = JSON.parse(value);
                            if (job.nextAttemptAt <= timeNow) jobs.push(job);
                        } catch (_error) {
                            jobs.push({ key, type: "invalid", invalid: true });
                        }
                    });
                    if (jobs.length >= limit) break;
                }
            } finally {
                cursor.close();
                txn.abort();
            }
            jobs.sort(function bySchedule(left, right) {
                return left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt;
            });
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
    const database = options && options.database ? options.database : global.database;
    const retryDelayMs = options && options.retryDelayMs ? options.retryDelayMs : 30 * 1000;
    const orphanGraceMs = options && options.orphanGraceMs ? options.orphanGraceMs : 10 * 60 * 1000;
    const logger = options && options.logger ? options.logger : console;
    const storage = options && options.storage ? options.storage : createLmdbStorage(database);

    const state = {
        processing: false,
        badAltBlocks: new Map(),
        potentiallyBadAltBlocks: new Map(),
        orphanSince: new Map(),
        loggedStates: new Map()
    };

    function logState(jobKey, nextState, message) {
        const timeNow = nowMs();
        const prev = state.loggedStates.get(jobKey);
        if (!prev || prev.state !== nextState || timeNow - prev.time >= 10 * 60 * 1000) {
            logger.log(message);
            state.loggedStates.set(jobKey, { state: nextState, time: timeNow });
        }
    }

    function clearState(jobKey) {
        state.loggedStates.delete(jobKey);
        state.orphanSince.delete(jobKey);
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
                    saveDrop(job, result.status, "Finalized orphan block " + blockDataDecoded.hash);
                    return callback();
                }
                saveRetry(job, "waiting_orphan", "Waiting for orphan confirmation for block " + blockDataDecoded.hash);
                return callback();
            }

            if (err || !header || !header.reward) {
                saveRetry(job, "waiting_block_header", "Waiting for block header/reward for block " + blockDataDecoded.hash);
                return callback();
            }

            blockDataDecoded.value = header.reward;
            const result = saveResolvedBlock(job.blockId, blockDataDecoded);
            saveDrop(job, result.status, (result.status === "stored" ? "Stored block " : "Skipped duplicate block ") + blockDataDecoded.hash);
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
                    saveDrop(job, result.status, "Finalized orphan altblock " + blockDataDecoded.hash + " on " + blockDataDecoded.port + " port");
                    return callback();
                }
                saveRetry(job, "waiting_alt_orphan", "Waiting for orphan confirmation for altblock " + blockDataDecoded.hash + " on " + blockDataDecoded.port + " port");
                return callback();
            }

            const profile = global.coinFuncs.getPoolProfile(blockDataDecoded.port);
            const unlockConfirmationDepth = profile && profile.rpc ? profile.rpc.unlockConfirmationDepth : 0;
            if (unlockConfirmationDepth && header && header.depth < unlockConfirmationDepth) {
                saveRetry(job, "waiting_for_depth", "Waiting for depth on " + blockDataDecoded.port + " port block hash " + blockDataDecoded.hash);
                return callback();
            }

            if (err || !header || !header.reward) {
                if (state.badAltBlocks.has(blockDataDecoded.hash)) {
                    saveDrop(job, "invalid_altblock", "Dropping invalid altblock " + blockDataDecoded.hash + " on " + blockDataDecoded.port + " port");
                    return callback();
                }
                const badBlockMap = state.potentiallyBadAltBlocks.get(blockDataDecoded.port) || new Map();
                badBlockMap.set(blockDataDecoded.hash, timeNow);
                state.potentiallyBadAltBlocks.set(blockDataDecoded.port, badBlockMap);
                saveRetry(job, "waiting_altblock_header", "Waiting for altblock header/reward for " + blockDataDecoded.hash + " on " + blockDataDecoded.port + " port");
                return callback();
            }

            markBadAltBlocks(blockDataDecoded.port, timeNow);
            blockDataDecoded.value = header.reward;
            const result = saveResolvedAltBlock(job.blockId, blockDataDecoded);
            saveDrop(job, result.status, (result.status === "stored" ? "Stored altblock " : "Skipped duplicate altblock ") + blockDataDecoded.hash + " on " + blockDataDecoded.port + " port");
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
        saveDrop(job, "unknown_job_type", "Dropping unknown remoteShare pending job " + job.key);
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
            if (state.processing) return;
            state.processing = true;
            pruneState();

            const jobs = storage.loadDueJobs(nowMs(), 100);
            let index = 0;
            const next = () => {
                if (index >= jobs.length) {
                    state.processing = false;
                    return;
                }
                processJob(jobs[index++], next);
            };
            next();
        },

        close() {
            storage.close();
            state.badAltBlocks.clear();
            state.potentiallyBadAltBlocks.clear();
            state.orphanSince.clear();
            state.loggedStates.clear();
        }
    };
};
