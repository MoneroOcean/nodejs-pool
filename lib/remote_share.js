"use strict";
const cluster = require("cluster");
const express = require("express");
const os = require("os");
const { createConsoleLogger, formatThreadName } = require("./common/logging.js");
const { formatLmdbError, isLmdbMapFull } = require("./common/lmdb_errors.js");
const isPrimaryProcess = require("./common/is_primary_process.js");

const createPendingJobs = require("./remote_share/pending_jobs");
const createShareStore = require("./remote_share/share_store");

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8000;
const DEFAULT_SHARE_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SHARE_BATCH_SIZE = 5000;
const DEFAULT_PENDING_JOB_POLL_MS = 1000;
const DEFAULT_SHARE_SUMMARY_INTERVAL_MS = 60 * 1000;
const DEFAULT_REQUEST_SUMMARY_INTERVAL_MS = 60 * 1000;

function formatError(error) { return error && error.stack ? error.stack : String(error); }

function createRemoteShareRuntime(options) {
    const opts = options || {};
    const clusterApi = opts.cluster || cluster;
    const osApi = opts.os || os;
    const shareFlushIntervalMs = opts.shareFlushIntervalMs || DEFAULT_SHARE_FLUSH_INTERVAL_MS;
    const shareBatchSize = opts.shareBatchSize || DEFAULT_SHARE_BATCH_SIZE;
    const pendingJobPollMs = opts.pendingJobPollMs || DEFAULT_PENDING_JOB_POLL_MS;
    const shareSummaryIntervalMs = opts.shareSummaryIntervalMs || DEFAULT_SHARE_SUMMARY_INTERVAL_MS;
    const requestSummaryIntervalMs = opts.requestSummaryIntervalMs || DEFAULT_REQUEST_SUMMARY_INTERVAL_MS;
    const clusterEnabled = opts.clusterEnabled !== false;
    const isPrimary = clusterEnabled ? isPrimaryProcess(clusterApi) : true;
    const shareStore = opts.shareStore || createShareStore({ database: global.database });
    const pendingJobs = opts.pendingJobs || createPendingJobs({ database: global.database });

    const app = express();
    const state = {
        attachedWorkers: new Set(),
        clusterListeners: [],
        pendingJobInterval: null,
        pendingJobLastErrorAt: 0,
        parentMessageListener: null,
        lmdbRejecting: false,
        lmdbRejectDetail: "",
        lmdbRejectScope: "",
        requestSummaryInterval: null,
        requestStats: {
            altBlockRequests: 0,
            authRejected: 0,
            badAltBlockPayloads: 0,
            badBlockPayloads: 0,
            badSharePayloads: 0,
            blockRequests: 0,
            invalidFrames: 0,
            invalidShareRejected: 0,
            invalidShareRequests: 0,
            queuedAltBlocks: 0,
            queuedBlocks: 0,
            requests: 0,
            shareAccepted: 0,
            shareRequests: 0,
            status200: 0,
            status400: 0,
            status403: 0,
            status503: 0,
            status500: 0,
            unknownRequests: 0
        },
        server: null,
        shareDrainActive: false,
        shareDrainWaiters: [],
        shareQueue: [],
        shareSummaryInterval: null,
        shareStats: {
            accepted: 0,
            flushBatches: 0,
            flushed: 0,
            maxQueueDepth: 0,
            totalAccepted: 0,
            totalFlushed: 0
        },
        shareTimer: null,
        started: false
    };

    function renderEmailTemplate(item, values, fallback) {
        if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
        const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
        return global.support && typeof global.support.formatTemplate === "function"
            ? global.support.formatTemplate(template || "", values || {})
            : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
                return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
            });
    }

    function threadName() {
        return formatThreadName({
            single: !clusterEnabled,
            primary: clusterEnabled && isPrimary,
            workerId: clusterApi.worker && clusterApi.worker.id,
            pid: process.pid
        });
    }
    const logger = createConsoleLogger(console, threadName);

    function notifyWorkersRejectWrites(scope, detail) {
        if (!clusterEnabled || !isPrimary) return;
        for (const worker of state.attachedWorkers) {
            if (typeof worker.send !== "function") continue;
            try {
                worker.send({ type: "remoteShareRejectWrites", scope, detail });
            } catch (_error) {}
        }
    }

    function enterLmdbRejectMode(scope, error, suppressLog) {
        if (!isLmdbMapFull(error)) return false;
        const detail = formatLmdbError(error);
        const firstEnter = !state.lmdbRejecting;
        state.lmdbRejecting = true;
        state.lmdbRejectScope = scope;
        state.lmdbRejectDetail = detail;
        if (firstEnter || !suppressLog) {
            logger.logError("LMDB", { status: "map full", scope, detail });
        }
        if (firstEnter) {
            notifyWorkersRejectWrites(scope, detail);
            if (global.support && typeof global.support.sendEmail === "function" && global.config?.general?.adminEmail) {
                const values = { scope, detail };
                global.support.sendEmail(
                    global.config.general.adminEmail,
                    renderEmailTemplate("remoteShareLmdbSubject", values, "remote_share rejecting new work due to LMDB full"),
                    renderEmailTemplate("remoteShareLmdbBody", values, "remote_share is rejecting new share and block frames after LMDB reported map full while %(scope)s: %(detail)s.")
                );
            }
        }
        return true;
    }

    function queueShare(share) {
        if (state.lmdbRejecting) return;
        state.shareQueue.push(share);
        state.shareStats.accepted += 1;
        state.shareStats.totalAccepted += 1;
        if (state.shareQueue.length > state.shareStats.maxQueueDepth) {
            state.shareStats.maxQueueDepth = state.shareQueue.length;
        }
        if (state.shareTimer !== null) return;
        state.shareTimer = setTimeout(function onShareTimer() {
            state.shareTimer = null;
            drainShareQueue();
        }, shareFlushIntervalMs);
        if (typeof state.shareTimer.unref === "function") state.shareTimer.unref();
    }

    function resolveShareDrainWaiters(error) {
        if (state.shareDrainWaiters.length === 0) return;
        const waiters = state.shareDrainWaiters;
        state.shareDrainWaiters = [];
        for (const waiter of waiters) {
            if (error) waiter.reject(error);
            else waiter.resolve();
        }
    }

    function finishShareDrain(error) {
        state.shareDrainActive = false;
        if (error || state.shareQueue.length === 0) resolveShareDrainWaiters(error);
    }

    function drainShareQueue() {
        if (state.lmdbRejecting) {
            state.shareDrainActive = false;
            resolveShareDrainWaiters();
            return;
        }
        if (state.shareDrainActive || state.shareQueue.length === 0) {
            if (!state.shareDrainActive && state.shareQueue.length === 0) resolveShareDrainWaiters();
            return;
        }
        state.shareDrainActive = true;

        const flushNextChunk = () => {
            if (state.shareQueue.length === 0) {
                finishShareDrain();
                return;
            }

            const batch = state.shareQueue.splice(0, shareBatchSize);
            try {
                shareStore.storeShares(batch);
            } catch (error) {
                if (enterLmdbRejectMode("flushing queued shares", error, true)) {
                    state.shareQueue = batch.concat(state.shareQueue);
                    finishShareDrain();
                    return;
                }
                finishShareDrain(error);
                throw error;
            }
            state.shareStats.flushBatches += 1;
            state.shareStats.flushed += batch.length;
            state.shareStats.totalFlushed += batch.length;
            if (state.shareQueue.length > 0) return setImmediate(flushNextChunk);
            finishShareDrain();
        };

        flushNextChunk();
    }

    function waitForShareDrain() {
        if (state.lmdbRejecting) return Promise.resolve();
        if (!state.shareDrainActive && state.shareQueue.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            state.shareDrainWaiters.push({ resolve, reject });
            if (!state.shareDrainActive && state.shareQueue.length > 0) drainShareQueue();
        });
    }

    function notifyPendingJobUpdate() {
        if (clusterEnabled && !isPrimary && typeof process.send === "function") {
            process.send({ type: "remoteSharePendingJob" });
            return;
        }
        processPendingJobs("worker_message");
    }

    function acceptShare(share) {
        if (state.lmdbRejecting) return false;
        if (clusterEnabled && !isPrimary && typeof process.send === "function") {
            process.send({ type: "remoteShareShare", share });
            return true;
        }
        queueShare(share);
        return true;
    }

    function handleParentMessage(message) {
        if (!message || typeof message !== "object") return;
        if (message.type !== "remoteShareRejectWrites") return;
        state.lmdbRejecting = true;
        state.lmdbRejectScope = message.scope || "worker notification";
        state.lmdbRejectDetail = message.detail || "";
        logger.logError("LMDB", {
            status: "map full",
            scope: state.lmdbRejectScope,
            detail: state.lmdbRejectDetail || "worker notified by primary"
        });
    }

    function handleWorkerMessage(message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
        case "remoteShareShare":
            if (message.share && !state.lmdbRejecting) queueShare(message.share);
            break;
        case "remoteSharePendingJob":
            processPendingJobs("ipc");
            break;
        }
    }

    function processPendingJobs(reason) {
        if (state.lmdbRejecting) return;
        try {
            pendingJobs.processDueJobs();
        } catch (error) {
            if (enterLmdbRejectMode("processing pending jobs", error, true)) return;
            const timeNow = Date.now();
            if (timeNow - state.pendingJobLastErrorAt >= 30 * 1000) {
                state.pendingJobLastErrorAt = timeNow;
                logger.logError("Pending job processing failed", { reason: reason, detail: formatError(error) });
            }
        }
    }

    function enqueuePendingJob(msgData, decoder, enqueue, jobType) {
        let payload;
        try {
            payload = decoder(msgData.msg);
        } catch (_error) {
            return false;
        }
        try {
            enqueue(msgData.exInt, msgData.msg, payload);
        } catch (error) {
            logger.logError("Pending " + jobType, { status: "enqueue-failed", detail: formatError(error) });
            return null;
        }
        notifyPendingJobUpdate();
        return true;
    }

    function respond(res, statusCode) {
        const key = "status" + statusCode;
        if (key in state.requestStats) state.requestStats[key] += 1;
        return res.status(statusCode).end();
    }

    function logRequestSummary() {
        if (!Object.keys(state.requestStats).some(function hasActivity(key) {
            return state.requestStats[key] !== 0;
        })) return;

        const fields = {
            req: state.requestStats.requests,
            ok: state.requestStats.status200,
            share: state.requestStats.shareAccepted,
            block: state.requestStats.blockRequests,
            alt: state.requestStats.altBlockRequests,
            invalidShare: state.requestStats.invalidShareRequests,
            queued: state.requestStats.queuedBlocks + state.requestStats.queuedAltBlocks
        };
        const failureParts = [];
        if (state.requestStats.status400 > 0) failureParts.push("400:" + state.requestStats.status400);
        if (state.requestStats.status403 > 0) failureParts.push("403:" + state.requestStats.status403);
        if (state.requestStats.status503 > 0) failureParts.push("503:" + state.requestStats.status503);
        if (state.requestStats.status500 > 0) failureParts.push("500:" + state.requestStats.status500);
        if (failureParts.length > 0) fields.fail = failureParts.join(",");

        const rejectParts = [];
        if (state.requestStats.invalidFrames > 0) rejectParts.push("frame:" + state.requestStats.invalidFrames);
        if (state.requestStats.authRejected > 0) rejectParts.push("auth:" + state.requestStats.authRejected);
        if (state.requestStats.badSharePayloads > 0) rejectParts.push("share:" + state.requestStats.badSharePayloads);
        if (state.requestStats.badBlockPayloads > 0) rejectParts.push("block:" + state.requestStats.badBlockPayloads);
        if (state.requestStats.badAltBlockPayloads > 0) rejectParts.push("alt:" + state.requestStats.badAltBlockPayloads);
        if (state.requestStats.invalidShareRejected > 0) rejectParts.push("invalidShare:" + state.requestStats.invalidShareRejected);
        if (state.requestStats.unknownRequests > 0) rejectParts.push("unknown:" + state.requestStats.unknownRequests);
        if (rejectParts.length > 0) fields.reject = rejectParts.join(",");

        logger.logInfo("Ingress summary", fields);

        for (const key of Object.keys(state.requestStats)) {
            state.requestStats[key] = 0;
        }
    }

    function logShareSummary() {
        const accepted = state.shareStats.accepted;
        const flushed = state.shareStats.flushed;
        const queueDepth = state.shareQueue.length;
        if (accepted === 0 && flushed === 0 && queueDepth === 0) return;

        logger.logInfo("Share summary", {
            accepted: accepted,
            flushed: flushed,
            flushBatches: state.shareStats.flushBatches,
            queue: queueDepth,
            maxQueue: state.shareStats.maxQueueDepth,
            draining: state.shareDrainActive ? 1 : 0,
            totalAccepted: state.shareStats.totalAccepted,
            totalFlushed: state.shareStats.totalFlushed
        });

        state.shareStats.accepted = 0;
        state.shareStats.flushed = 0;
        state.shareStats.flushBatches = 0;
        state.shareStats.maxQueueDepth = queueDepth;
    }

    function logPendingSummary() {
        if (!pendingJobs || typeof pendingJobs.getPendingSummary !== "function") return;
        const summary = pendingJobs.getPendingSummary();
        if (summary) console.log(threadName() + summary);
    }

    function handleLeafFrame(req, res) {
        state.requestStats.requests += 1;
        let msgData;
        try {
            msgData = global.protos.WSData.decode(req.body);
        } catch (_error) {
            state.requestStats.invalidFrames += 1;
            logger.logInfo("Ingress", { status: "invalid-ws-frame" });
            return respond(res, 400);
        }

        if (msgData.key !== global.config.api.authKey) {
            state.requestStats.authRejected += 1;
            return respond(res, 403);
        }
        if (state.lmdbRejecting) return respond(res, 503);

        switch (msgData.msgType) {
        case global.protos.MESSAGETYPE.SHARE: {
            state.requestStats.shareRequests += 1;
            let share;
            try {
                share = global.protos.Share.decode(msgData.msg);
            } catch (_error) {
                state.requestStats.badSharePayloads += 1;
                return respond(res, 400);
            }
            if (!acceptShare(share)) return respond(res, 503);
            state.requestStats.shareAccepted += 1;
            return respond(res, 200);
        }
        case global.protos.MESSAGETYPE.BLOCK: {
            state.requestStats.blockRequests += 1;
            const queuedBlock = enqueuePendingJob(msgData, global.protos.Block.decode, function enqueueBlock(blockId, payload, block) {
                pendingJobs.enqueueBlock(blockId, payload, block);
            }, "block");
            if (queuedBlock === false) {
                state.requestStats.badBlockPayloads += 1;
                return respond(res, 400);
            }
            if (queuedBlock === null) return respond(res, 500);
            state.requestStats.queuedBlocks += 1;
            return respond(res, 200);
        }
        case global.protos.MESSAGETYPE.ALTBLOCK: {
            state.requestStats.altBlockRequests += 1;
            const queuedAltBlock = enqueuePendingJob(msgData, global.protos.AltBlock.decode, function enqueueAltBlock(blockId, payload, block) {
                pendingJobs.enqueueAltBlock(blockId, payload, block);
            }, "altblock");
            if (queuedAltBlock === false) {
                state.requestStats.badAltBlockPayloads += 1;
                return respond(res, 400);
            }
            if (queuedAltBlock === null) return respond(res, 500);
            state.requestStats.queuedAltBlocks += 1;
            return respond(res, 200);
        }
        case global.protos.MESSAGETYPE.INVALIDSHARE:
            state.requestStats.invalidShareRequests += 1;
            return global.database.storeInvalidShare(msgData.msg, function onStored(isStored) {
                if (!isStored) state.requestStats.invalidShareRejected += 1;
                return respond(res, isStored ? 200 : 400);
            });
        default:
            state.requestStats.unknownRequests += 1;
            return respond(res, 400);
        }
    }

    function listenServer() {
        if (state.server !== null) return;
        state.server = app.listen(opts.port ?? DEFAULT_PORT, opts.host ?? DEFAULT_HOST, function onListen() {
            logger.logInfo("Listen", { service: "remote-share", host: opts.host ?? DEFAULT_HOST, port: state.server.address().port });
        });
    }

    function attachWorker(worker) {
        worker.on("message", handleWorkerMessage);
        state.attachedWorkers.add(worker);
        if (state.lmdbRejecting && typeof worker.send === "function") {
            try {
                worker.send({ type: "remoteShareRejectWrites", scope: state.lmdbRejectScope, detail: state.lmdbRejectDetail });
            } catch (_error) {}
        }
    }

    function detachWorker(worker) {
        if (!state.attachedWorkers.has(worker)) return;
        if (typeof worker.off === "function") worker.off("message", handleWorkerMessage);
        else worker.removeListener("message", handleWorkerMessage);
        state.attachedWorkers.delete(worker);
    }

    function addClusterListener(eventName, listener) {
        clusterApi.on(eventName, listener);
        state.clusterListeners.push({ eventName, listener });
    }

    function closeServer() {
        if (state.server === null) return Promise.resolve();
        return new Promise((resolve) => {
            const server = state.server;
            server.close(function onClose() {
                if (state.server === server) state.server = null;
                resolve();
            });
        });
    }

    function disconnectWorkers() {
        if (!clusterEnabled || !isPrimary || state.attachedWorkers.size === 0 || typeof clusterApi.disconnect !== "function") {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            let resolved = false;
            function finish() {
                if (resolved) return;
                resolved = true;
                resolve();
            }
            try {
                clusterApi.disconnect(finish);
            } catch (_error) {
                finish();
            }
        });
    }

    app.use(express.raw({ type: () => true, limit: "1mb" }));
    app.post("/leafApi", handleLeafFrame);

    return {
        start() {
            if (state.started) return this;
            state.started = true;
            global.database.thread_id = threadName();

            if (isPrimary) {
                state.pendingJobInterval = setInterval(function pollPendingJobs() {
                    processPendingJobs("interval");
                }, pendingJobPollMs);
                if (typeof state.pendingJobInterval.unref === "function") state.pendingJobInterval.unref();
            }

            if (!clusterEnabled || !isPrimary) {
                state.requestSummaryInterval = setInterval(logRequestSummary, requestSummaryIntervalMs);
                if (typeof state.requestSummaryInterval.unref === "function") state.requestSummaryInterval.unref();
            }

            if (!clusterEnabled || isPrimary) {
                state.shareSummaryInterval = setInterval(function logMasterSummary() {
                    logShareSummary();
                    logPendingSummary();
                }, shareSummaryIntervalMs);
                if (typeof state.shareSummaryInterval.unref === "function") state.shareSummaryInterval.unref();
            }

            if (!clusterEnabled) {
                listenServer();
                return this;
            }

            if (isPrimary) {
                const numWorkers = opts.numWorkers || osApi.cpus().length;
                logger.logInfo("IMPORTANT: Cluster start", { workers: numWorkers });
                for (let i = 0; i < numWorkers; i++) attachWorker(clusterApi.fork());
                addClusterListener("online", function onOnline(worker) {
                    logger.logInfo("Worker online", { pid: worker.process.pid });
                });
                addClusterListener("exit", function onExit(worker, code, signal) {
                    detachWorker(worker);
                    logger.logError("Worker exit", { pid: worker.process.pid, code: code, signal: signal });
                    if (!state.started) return;
                    attachWorker(clusterApi.fork());
                });
                return this;
            }

            if (typeof process.on === "function" && clusterEnabled && !isPrimary) {
                state.parentMessageListener = handleParentMessage;
                process.on("message", state.parentMessageListener);
            }
            listenServer();
            return this;
        },

        async stop() {
            if (!state.started) return Promise.resolve();
            state.started = false;

            if (state.shareTimer !== null) {
                clearTimeout(state.shareTimer);
                state.shareTimer = null;
            }
            if (state.pendingJobInterval !== null) {
                clearInterval(state.pendingJobInterval);
                state.pendingJobInterval = null;
            }
            if (state.requestSummaryInterval !== null) {
                clearInterval(state.requestSummaryInterval);
                state.requestSummaryInterval = null;
            }
            if (state.shareSummaryInterval !== null) {
                clearInterval(state.shareSummaryInterval);
                state.shareSummaryInterval = null;
            }
            if (state.parentMessageListener) {
                if (typeof process.off === "function") process.off("message", state.parentMessageListener);
                else if (typeof process.removeListener === "function") process.removeListener("message", state.parentMessageListener);
                state.parentMessageListener = null;
            }

            await closeServer();
            await disconnectWorkers();
            await waitForShareDrain();
            if (pendingJobs && typeof pendingJobs.close === "function") {
                await Promise.resolve(pendingJobs.close());
            }
            for (const worker of state.attachedWorkers) {
                if (typeof worker.off === "function") worker.off("message", handleWorkerMessage);
                else worker.removeListener("message", handleWorkerMessage);
            }
            state.attachedWorkers.clear();
            for (const entry of state.clusterListeners) {
                if (!clusterApi || !entry.listener) continue;
                if (typeof clusterApi.off === "function") clusterApi.off(entry.eventName, entry.listener);
                else clusterApi.removeListener(entry.eventName, entry.listener);
            }
            state.clusterListeners.length = 0;
        },

        address() {
            return state.server ? state.server.address() : null;
        }
    };
}

const runtime = global.__remoteShareAutostart === false ? null : createRemoteShareRuntime();
if (runtime) runtime.start();

module.exports = runtime || {};
module.exports.createRemoteShareRuntime = createRemoteShareRuntime;
