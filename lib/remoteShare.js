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
    const clusterEnabled = opts.clusterEnabled !== false;
    const isPrimary = clusterEnabled ? isPrimaryProcess(clusterApi) : true;
    const shareStore = opts.shareStore || createShareStore({ database: global.database });
    const pendingJobs = opts.pendingJobs || createPendingJobs({ database: global.database });

    const app = express();
    const state = {
        attachedWorkers: new Set(),
        clusterListeners: [],
        pendingJobInterval: null,
        server: null,
        shareDrainActive: false,
        shareQueue: [],
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

            shareStore.storeShares(state.shareQueue.splice(0, shareBatchSize));
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
        pendingJobs.processDueJobs();
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
            pendingJobs.processDueJobs();
            break;
        }
    }

    function enqueuePendingJob(msgData, decoder, enqueue, errorText, res) {
        let payload;
        try {
            payload = decoder(msgData.msg);
        } catch (_error) {
            return res.status(400).end();
        }
        try {
            enqueue(msgData.exInt, msgData.msg, payload);
        } catch (error) {
            console.error(errorText + error);
            return res.status(500).end();
        }
        notifyPendingJobUpdate();
        return res.status(200).end();
    }

    function handleLeafFrame(req, res) {
        let msgData;
        try {
            msgData = global.protos.WSData.decode(req.body);
        } catch (_error) {
            console.log("Invalid WS frame");
            return res.status(400).end();
        }

        if (msgData.key !== global.config.api.authKey) return res.status(403).end();

        switch (msgData.msgType) {
        case global.protos.MESSAGETYPE.SHARE: {
            let share;
            try {
                share = global.protos.Share.decode(msgData.msg);
            } catch (_error) {
                return res.status(400).end();
            }
            acceptShare(share);
            return res.status(200).end();
        }
        case global.protos.MESSAGETYPE.BLOCK:
            return enqueuePendingJob(msgData, global.protos.Block.decode, function enqueueBlock(blockId, payload, block) {
                pendingJobs.enqueueBlock(blockId, payload, block);
            }, "Failed to enqueue block job: ", res);
        case global.protos.MESSAGETYPE.ALTBLOCK:
            return enqueuePendingJob(msgData, global.protos.AltBlock.decode, function enqueueAltBlock(blockId, payload, block) {
                pendingJobs.enqueueAltBlock(blockId, payload, block);
            }, "Failed to enqueue altblock job: ", res);
        case global.protos.MESSAGETYPE.INVALIDSHARE:
            return global.database.storeInvalidShare(msgData.msg, function onStored(isStored) {
                return res.status(isStored ? 200 : 400).end();
            });
        default:
            return res.status(400).end();
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
                    pendingJobs.processDueJobs();
                }, pendingJobPollMs);
                if (typeof state.pendingJobInterval.unref === "function") state.pendingJobInterval.unref();
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
