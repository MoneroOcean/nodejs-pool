"use strict";

const cluster = require("cluster");
const express = require("express");
const os = require("os");

const createPendingJobs = require("./remote_share/pending_jobs");
const createShareStore = require("./remote_share/share_store");

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8000;
const DEFAULT_SHARE_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SHARE_BATCH_SIZE = 5000;
const DEFAULT_PENDING_JOB_POLL_MS = 1000;
const DEFAULT_SHARE_SUMMARY_INTERVAL_MS = 60 * 1000;
const DEFAULT_REQUEST_SUMMARY_INTERVAL_MS = 60 * 1000;

function isPrimaryProcess(clusterApi) {
    if (typeof clusterApi.isPrimary === "boolean") return clusterApi.isPrimary;
    return clusterApi.isMaster;
}

function removeListener(target, eventName, listener) {
    if (!target || !listener) return;
    if (typeof target.off === "function") return target.off(eventName, listener);
    target.removeListener(eventName, listener);
}

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
        requestSummaryInterval: null,
        requestStats: {
            altBlockRequests: 0,
            authRejected: 0,
            badAltBlockPayloads: 0,
            badBlockPayloads: 0,
            badSharePayloads: 0,
            blockRequests: 0,
            bytes: 0,
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
            status500: 0,
            unknownRequests: 0
        },
        server: null,
        shareDrainActive: false,
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

    function threadName() {
        if (!clusterEnabled) return "(Single) ";
        if (isPrimary) return "(Master) ";
        return "(Worker " + clusterApi.worker.id + " - " + process.pid + ") ";
    }

    function queueShare(share) {
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

    function drainShareQueue() {
        if (state.shareDrainActive || state.shareQueue.length === 0) return;
        state.shareDrainActive = true;

        const flushNextChunk = () => {
            if (state.shareQueue.length === 0) {
                state.shareDrainActive = false;
                return;
            }

            const batch = state.shareQueue.splice(0, shareBatchSize);
            shareStore.storeShares(batch);
            state.shareStats.flushBatches += 1;
            state.shareStats.flushed += batch.length;
            state.shareStats.totalFlushed += batch.length;
            if (state.shareQueue.length > 0) return setImmediate(flushNextChunk);
            state.shareDrainActive = false;
        };

        flushNextChunk();
    }

    function notifyPendingJobUpdate() {
        if (clusterEnabled && !isPrimary && typeof process.send === "function") {
            process.send({ type: "remoteSharePendingJob" });
            return;
        }
        processPendingJobs("worker_message");
    }

    function acceptShare(share) {
        if (clusterEnabled && !isPrimary && typeof process.send === "function") {
            process.send({ type: "remoteShareShare", share });
            return;
        }
        queueShare(share);
    }

    function handleWorkerMessage(message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
        case "remoteShareShare":
            if (message.share) queueShare(message.share);
            break;
        case "remoteSharePendingJob":
            processPendingJobs("ipc");
            break;
        }
    }

    function processPendingJobs(reason) {
        try {
            pendingJobs.processDueJobs();
        } catch (error) {
            const timeNow = Date.now();
            if (timeNow - state.pendingJobLastErrorAt >= 30 * 1000) {
                state.pendingJobLastErrorAt = timeNow;
                console.error(threadName() + "Pending job processing failed (" + reason + "): " + (error && error.stack ? error.stack : error));
            }
        }
    }

    function enqueuePendingJob(msgData, decoder, enqueue, errorText, res) {
        let payload;
        try {
            payload = decoder(msgData.msg);
        } catch (_error) {
            return false;
        }
        try {
            enqueue(msgData.exInt, msgData.msg, payload);
        } catch (error) {
            console.error(errorText + error);
            return null;
        }
        notifyPendingJobUpdate();
        return true;
    }

    function recordStatus(statusCode) {
        const key = "status" + statusCode;
        if (key in state.requestStats) {
            state.requestStats[key] += 1;
        }
    }

    function respond(res, statusCode) {
        recordStatus(statusCode);
        return res.status(statusCode).end();
    }

    function hasRequestActivity() {
        return Object.keys(state.requestStats).some(function hasActivity(key) {
            return state.requestStats[key] !== 0;
        });
    }

    function logRequestSummary() {
        if (!hasRequestActivity()) return;

        console.log(
            threadName() + "Ingress summary: requests=" + state.requestStats.requests +
            " bytes=" + state.requestStats.bytes +
            " share=" + state.requestStats.shareRequests +
            " shareAccepted=" + state.requestStats.shareAccepted +
            " block=" + state.requestStats.blockRequests +
            " alt=" + state.requestStats.altBlockRequests +
            " invalidShare=" + state.requestStats.invalidShareRequests +
            " status=200:" + state.requestStats.status200 +
            ",400:" + state.requestStats.status400 +
            ",403:" + state.requestStats.status403 +
            ",500:" + state.requestStats.status500 +
            " rejects=frame:" + state.requestStats.invalidFrames +
            ",auth:" + state.requestStats.authRejected +
            ",share:" + state.requestStats.badSharePayloads +
            ",block:" + state.requestStats.badBlockPayloads +
            ",alt:" + state.requestStats.badAltBlockPayloads +
            ",invalidShare:" + state.requestStats.invalidShareRejected +
            ",unknown:" + state.requestStats.unknownRequests +
            " queued=block:" + state.requestStats.queuedBlocks +
            ",alt:" + state.requestStats.queuedAltBlocks
        );

        for (const key of Object.keys(state.requestStats)) {
            state.requestStats[key] = 0;
        }
    }

    function logShareSummary() {
        const accepted = state.shareStats.accepted;
        const flushed = state.shareStats.flushed;
        const queueDepth = state.shareQueue.length;
        if (accepted === 0 && flushed === 0 && queueDepth === 0) return;

        console.log(
            threadName() + "Share summary: accepted=" + accepted +
            " flushed=" + flushed +
            " flushBatches=" + state.shareStats.flushBatches +
            " queue=" + queueDepth +
            " maxQueue=" + state.shareStats.maxQueueDepth +
            " draining=" + (state.shareDrainActive ? 1 : 0) +
            " totalAccepted=" + state.shareStats.totalAccepted +
            " totalFlushed=" + state.shareStats.totalFlushed
        );

        state.shareStats.accepted = 0;
        state.shareStats.flushed = 0;
        state.shareStats.flushBatches = 0;
        state.shareStats.maxQueueDepth = queueDepth;
    }

    function handleLeafFrame(req, res) {
        state.requestStats.requests += 1;
        state.requestStats.bytes += req.body ? req.body.length : 0;
        let msgData;
        try {
            msgData = global.protos.WSData.decode(req.body);
        } catch (_error) {
            state.requestStats.invalidFrames += 1;
            console.log(threadName() + "Invalid WS frame");
            return respond(res, 400);
        }

        if (msgData.key !== global.config.api.authKey) {
            state.requestStats.authRejected += 1;
            return respond(res, 403);
        }

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
            state.requestStats.shareAccepted += 1;
            acceptShare(share);
            return respond(res, 200);
        }
        case global.protos.MESSAGETYPE.BLOCK: {
            state.requestStats.blockRequests += 1;
            const queuedBlock = enqueuePendingJob(msgData, global.protos.Block.decode, function enqueueBlock(blockId, payload, block) {
                pendingJobs.enqueueBlock(blockId, payload, block);
            }, "Failed to enqueue block job: ", res);
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
            }, "Failed to enqueue altblock job: ", res);
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
        state.server = app.listen(opts.port || DEFAULT_PORT, opts.host || DEFAULT_HOST, function onListen() {
            console.log("Process " + process.pid + " is listening to all incoming requests");
        });
    }

    function attachWorker(worker) {
        worker.on("message", handleWorkerMessage);
        state.attachedWorkers.add(worker);
    }

    function detachWorker(worker) {
        if (!state.attachedWorkers.has(worker)) return;
        removeListener(worker, "message", handleWorkerMessage);
        state.attachedWorkers.delete(worker);
    }

    function addClusterListener(eventName, listener) {
        clusterApi.on(eventName, listener);
        state.clusterListeners.push({ eventName, listener });
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
                state.shareSummaryInterval = setInterval(logShareSummary, shareSummaryIntervalMs);
                if (typeof state.shareSummaryInterval.unref === "function") state.shareSummaryInterval.unref();
            }

            if (!clusterEnabled) {
                listenServer();
                return this;
            }

            if (isPrimary) {
                const numWorkers = opts.numWorkers || osApi.cpus().length;
                console.log("Master cluster setting up " + numWorkers + " workers...");
                for (let i = 0; i < numWorkers; i++) attachWorker(clusterApi.fork());
                addClusterListener("online", function onOnline(worker) {
                    console.log("Worker " + worker.process.pid + " is online");
                });
                addClusterListener("exit", function onExit(worker, code, signal) {
                    detachWorker(worker);
                    console.log("Worker " + worker.process.pid + " died with code: " + code + ", and signal: " + signal);
                    console.log("Starting a new worker");
                    attachWorker(clusterApi.fork());
                });
                return this;
            }

            listenServer();
            return this;
        },

        stop() {
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

            if (pendingJobs && typeof pendingJobs.close === "function") pendingJobs.close();
            for (const worker of state.attachedWorkers) removeListener(worker, "message", handleWorkerMessage);
            state.attachedWorkers.clear();
            for (const entry of state.clusterListeners) removeListener(clusterApi, entry.eventName, entry.listener);
            state.clusterListeners.length = 0;

            if (state.server === null) return Promise.resolve();
            return new Promise((resolve) => {
                state.server.close(function onClose() {
                    state.server = null;
                    resolve();
                });
            });
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
