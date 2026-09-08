"use strict";
const http = require("http");
const https = require("https");
const os = require("os");
const { URL } = require("url");
const { createTaskQueue } = require("../common/callbacks.js");

/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */

/**
 * @typedef {object} SendStats
 * @property {number} failed
 * @property {number} networkErrors
 * @property {number} success
 * @property {number} timeouts
 * @property {Record<string, number>} errorCounts
 * @property {Record<string, number>} statusCounts
 */

/** @typedef {{body: Buffer}} SendTask */

/**
 * @typedef {object} SendQueue
 * @property {(task: SendTask, callback?: () => void) => void} push
 * @property {() => number} length
 * @property {() => number} running
 */

/**
 * @typedef {object} RemoteDatabase
 * @property {"remote"} role
 * @property {string|number} thread_id
 * @property {SendStats} sendStats
 * @property {SendQueue} sendQueue
 * @property {NodeJS.Timeout|null} queueMonitor
 * @property {null} data
 * @property {(blockId: number, shareData: Buffer) => void} storeShare
 * @property {(blockId: number, blockData: Buffer) => void} storeBlock
 * @property {(blockId: number, blockData: Buffer) => void} storeAltBlock
 * @property {(minerData: Buffer) => void} storeInvalidShare
 * @property {() => void} initEnv
 * @property {() => void} close
 * @property {(queue: SendQueue, stats: SendStats) => void} logQueueState
 */

const BACKLOG_EMAIL_SUBJECT = "FYI: Pool uplink backlog";
const BACKLOG_EMAIL_THRESHOLD = 20000;
const QUEUE_MONITOR_INTERVAL_MS = 30 * 1000;
const RETRY_DELAY_MS = 1000;

/**
 * @param {string} item
 * @param {Record<string, unknown>} values
 * @param {string} fallback
 * @returns {string}
 */
function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
            return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
        });
}

/**
 * @param {URL} targetUrl
 * @param {Buffer} body
 * @param {(error: Error|null, statusCode?: number) => void} callback
 * @returns {void}
 */
function postOnce(targetUrl, body, callback) {
    const req = (targetUrl.protocol === "https:" ? https : http).request({
        hostname: targetUrl.hostname,
        method: "POST",
        path: targetUrl.pathname + targetUrl.search,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        headers: {
            "Content-Length": Buffer.byteLength(body),
            "Content-Type": "application/octet-stream",
            "Connection": "close"
        }
    }, function onResponse(response) {
        response.resume();
        response.on("end", function onEnd() { callback(null, response.statusCode); });
    });
    req.on("error", callback);
    req.setTimeout(30 * 1000, function onTimeout() { req.destroy(new Error("Remote share POST timed out")); });
    req.end(body);
}

/**
 * @param {SendStats} stats
 * @param {NodeJS.ErrnoException|null} error
 * @param {number|undefined} statusCode
 * @returns {void}
 */
function updateSendStats(stats, error, statusCode) {
    if (!error && statusCode === 200) {
        stats.success += 1;
        return;
    }

    stats.failed += 1;
    if (error) {
        const errorKey = error.message === "Remote share POST timed out"
            ? "timeout"
            : (error.code || error.message || "unknown_error");
        if (errorKey === "timeout") {
            stats.timeouts += 1;
        } else {
            stats.networkErrors += 1;
        }
        stats.errorCounts[errorKey] = (stats.errorCounts[errorKey] || 0) + 1;
        return;
    }

    const statusKey = String(statusCode || 0);
    stats.statusCounts[statusKey] = (stats.statusCounts[statusKey] || 0) + 1;
}

/** @param {SendStats} stats @returns {SendStats} */
function takeSendStatsSnapshot(stats) {
    const snapshot = {
        failed: stats.failed,
        networkErrors: stats.networkErrors,
        success: stats.success,
        timeouts: stats.timeouts,
        errorCounts: stats.errorCounts,
        statusCounts: stats.statusCounts
    };

    stats.failed = 0;
    stats.networkErrors = 0;
    stats.success = 0;
    stats.timeouts = 0;
    stats.errorCounts = Object.create(null);
    stats.statusCounts = Object.create(null);

    return snapshot;
}

/** @param {Record<string, number>} countMap @returns {string} */
function formatCountMap(countMap) {
    return Object.keys(countMap).sort().map(function formatEntry(key) {
        return `${key  }:${  countMap[key]}`;
    }).join(",");
}

/**
 * @param {Buffer} body
 * @param {URL} targetUrl
 * @param {SendStats} stats
 * @param {() => void} callback
 * @returns {void}
 */
function sendUntilSuccess(body, targetUrl, stats, callback) {
    postOnce(targetUrl, body, function onPosted(error, statusCode) {
        updateSendStats(stats, error, statusCode);
        if (!error && statusCode === 200) return callback();
        // Retry on a fixed delay rather than setImmediate: a tight next-tick retry pins a CPU
        // core (each held send-queue slot reconnecting as fast as the event loop runs) and
        // floods the shareHost when it is down/refusing connections. Still retries until success.
        setTimeout(function retry() { sendUntilSuccess(body, targetUrl, stats, callback); }, RETRY_DELAY_MS);
    });
}

/**
 * @param {number} msgType
 * @param {number} blockId
 * @param {Buffer} payload
 * @returns {void}
 */
function sendRemoteFrame(msgType, blockId, payload) {
    const send = process.send;
    if (typeof send !== "function") throw new Error("Remote share uplink requires an IPC parent");
    const authKey = global.config.api["authKey"];
    if (typeof authKey !== "string") throw new Error("api.authKey must be configured");
    send({
        type: "sendRemote",
        body: global.protos.WSData.encode({ msgType, key: authKey, msg: payload, exInt: blockId }).toString("hex")
    });
}

/** @param {string} name @returns {number} */
function getMessageType(name) {
    const messageType = global.protos.MESSAGETYPE[name];
    if (typeof messageType !== "number") throw new Error(`Unknown remote message type ${  name}`);
    return messageType;
}

/** @constructor @this {RemoteDatabase} */
function Database() {
    this.role = "remote";
    this.thread_id = "";
    const shareHost = global.config.general["shareHost"];
    if (typeof shareHost !== "string" || shareHost.length === 0) throw new Error("general.shareHost must be configured");
    const targetUrl = new URL(shareHost);
    this.sendStats = {
        failed: 0,
        networkErrors: 0,
        success: 0,
        timeouts: 0,
        errorCounts: Object.create(null),
        statusCounts: Object.create(null)
    };

    // Sends are network-bound, so over-subscribe CPUs for concurrency.
    const sendStats = this.sendStats;
    /** @param {SendTask} task @param {() => void} callback */
    function processTask(task, callback) {
        sendUntilSuccess(task.body, targetUrl, sendStats, callback);
    }
    this.sendQueue = createTaskQueue(os.cpus().length * 32, processTask);

    /**
     * @param {SendQueue} queue
     * @param {SendStats} stats
     * @returns {void}
     */
    function logQueueState(queue, stats) {
        const queued = queue.length();
        const running = queue.running();
        const snapshot = takeSendStatsSnapshot(stats);
        const shouldLogQueue = queued > 20 || running > 20;
        const shouldLogFailures = snapshot.failed > 0;

        if (!shouldLogQueue && !shouldLogFailures) return;

        let logLine = `${global.database.thread_id  }IMPORTANT: Remote: queued=${  queued  } running=${  running}`;
        if (snapshot.success > 0) logLine += ` ok=${  snapshot.success}`;
        if (snapshot.failed > 0) {
            logLine += ` failed=${  snapshot.failed}`;
            if (snapshot.timeouts > 0) logLine += ` timeout=${  snapshot.timeouts}`;
            if (snapshot.networkErrors > 0) logLine += ` network=${  snapshot.networkErrors}`;
            const statusSummary = formatCountMap(snapshot.statusCounts);
            if (statusSummary) logLine += ` statuses=${  statusSummary}`;
            const errorSummary = formatCountMap(snapshot.errorCounts);
            if (errorSummary) logLine += ` errors=${  errorSummary}`;
        }
        console.log(logLine);
    }

    this.logQueueState = logQueueState;

    this.queueMonitor = setInterval(function monitorQueue(queue, stats) {
        // Only the master process owns the send queue, so skip on workers.
        if (!global.database || (global.database.thread_id !== "[M] " && global.database.thread_id !== "(Master) ")) return;

        const queued = queue.length();
        const running = queue.running();
        logQueueState(queue, stats);
        if (queued >= BACKLOG_EMAIL_THRESHOLD && global.support && typeof global.support.sendAdminFyi === "function") {
            const values = {
                queued,
                running,
                target: shareHost,
                host: global.config.hostname
            };
            global.support.sendAdminFyi("pool:uplink-backlog", renderEmailTemplate("uplinkBacklogSubject", values, BACKLOG_EMAIL_SUBJECT), renderEmailTemplate("uplinkBacklogBody", values, "Queued shares: %(queued)s\nRunning sends: %(running)s\nTarget: %(target)s\nHost: %(host)s\n"));
        }
    }, QUEUE_MONITOR_INTERVAL_MS, this.sendQueue, this.sendStats);
    if (this.queueMonitor && typeof this.queueMonitor.unref === "function") this.queueMonitor.unref();

    /** @param {number} blockId @param {Buffer} shareData */
    this.storeShare = function storeShare(blockId, shareData) { sendRemoteFrame(getMessageType("SHARE"), blockId, shareData); };
    /** @param {number} blockId @param {Buffer} blockData */
    this.storeBlock = function storeBlock(blockId, blockData) { sendRemoteFrame(getMessageType("BLOCK"), blockId, blockData); };
    /** @param {number} blockId @param {Buffer} blockData */
    this.storeAltBlock = function storeAltBlock(blockId, blockData) { sendRemoteFrame(getMessageType("ALTBLOCK"), blockId, blockData); };
    // exInt normally carries block height; invalid shares have none, so send placeholder 1 (proto field is required).
    /** @param {Buffer} minerData */
    this.storeInvalidShare = function storeInvalidShare(minerData) { sendRemoteFrame(getMessageType("INVALIDSHARE"), 1, minerData); };
    this.initEnv = function initEnv() { this.data = null; };
    this.close = function close() { if (this.queueMonitor) { clearInterval(this.queueMonitor); this.queueMonitor = null; } };
}

module.exports = Database;
