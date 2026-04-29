"use strict";
const http = require("http");
const https = require("https");
const os = require("os");
const { URL } = require("url");
const { createTaskQueue } = require("../common/callbacks.js");

const BACKLOG_EMAIL_SUBJECT = "FYI: Pool uplink backlog";
const BACKLOG_EMAIL_THRESHOLD = 20000;
const QUEUE_MONITOR_INTERVAL_MS = 30 * 1000;

function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
            return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
        });
}

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

function formatCountMap(countMap) {
    return Object.keys(countMap).sort().map(function formatEntry(key) {
        return key + ":" + countMap[key];
    }).join(",");
}

function sendUntilSuccess(body, targetUrl, stats, callback) {
    postOnce(targetUrl, body, function onPosted(error, statusCode) {
        updateSendStats(stats, error, statusCode);
        if (!error && statusCode === 200) return callback();
        setImmediate(function retry() { sendUntilSuccess(body, targetUrl, stats, callback); });
    });
}

function sendRemoteFrame(msgType, blockId, payload) {
    process.send({
        type: "sendRemote",
        body: global.protos.WSData.encode({ msgType, key: global.config.api.authKey, msg: payload, exInt: blockId }).toString("hex")
    });
}

function Database() {
    const targetUrl = new URL(global.config.general.shareHost);
    this.sendStats = {
        failed: 0,
        networkErrors: 0,
        success: 0,
        timeouts: 0,
        errorCounts: Object.create(null),
        statusCounts: Object.create(null)
    };

    this.sendQueue = createTaskQueue(os.cpus().length * 32, function processTask(task, callback) {
        sendUntilSuccess(task.body, targetUrl, this.sendStats, callback);
    }.bind(this));

    function logQueueState(queue, stats) {
        const queued = queue.length();
        const running = queue.running();
        const snapshot = takeSendStatsSnapshot(stats);
        const shouldLogQueue = queued > 20 || running > 20;
        const shouldLogFailures = snapshot.failed > 0;

        if (!shouldLogQueue && !shouldLogFailures) return;

        let logLine = global.database.thread_id + "IMPORTANT: Remote: queued=" + queued + " running=" + running;
        if (snapshot.success > 0) logLine += " ok=" + snapshot.success;
        if (snapshot.failed > 0) {
            logLine += " failed=" + snapshot.failed;
            if (snapshot.timeouts > 0) logLine += " timeout=" + snapshot.timeouts;
            if (snapshot.networkErrors > 0) logLine += " network=" + snapshot.networkErrors;
            const statusSummary = formatCountMap(snapshot.statusCounts);
            if (statusSummary) logLine += " statuses=" + statusSummary;
            const errorSummary = formatCountMap(snapshot.errorCounts);
            if (errorSummary) logLine += " errors=" + errorSummary;
        }
        console.log(logLine);
    }

    this.logQueueState = logQueueState;

    this.queueMonitor = setInterval(function monitorQueue(queue, stats) {
        if (!global.database || (global.database.thread_id !== "[M] " && global.database.thread_id !== "(Master) ")) return;

        const queued = queue.length();
        const running = queue.running();
        logQueueState(queue, stats);
        if (queued >= BACKLOG_EMAIL_THRESHOLD && global.support && typeof global.support.sendAdminFyi === "function") {
            const values = {
                queued: queued,
                running: running,
                target: global.config.general.shareHost,
                host: global.config.hostname
            };
            global.support.sendAdminFyi("pool:uplink-backlog", renderEmailTemplate("uplinkBacklogSubject", values, BACKLOG_EMAIL_SUBJECT), renderEmailTemplate("uplinkBacklogBody", values, "Queued shares: %(queued)s\nRunning sends: %(running)s\nTarget: %(target)s\nHost: %(host)s\n"));
        }
    }, QUEUE_MONITOR_INTERVAL_MS, this.sendQueue, this.sendStats);
    if (this.queueMonitor && typeof this.queueMonitor.unref === "function") this.queueMonitor.unref();

    this.storeShare = function storeShare(blockId, shareData) { sendRemoteFrame(global.protos.MESSAGETYPE.SHARE, blockId, shareData); };
    this.storeBlock = function storeBlock(blockId, blockData) { sendRemoteFrame(global.protos.MESSAGETYPE.BLOCK, blockId, blockData); };
    this.storeAltBlock = function storeAltBlock(blockId, blockData) { sendRemoteFrame(global.protos.MESSAGETYPE.ALTBLOCK, blockId, blockData); };
    this.storeInvalidShare = function storeInvalidShare(minerData) { sendRemoteFrame(global.protos.MESSAGETYPE.INVALIDSHARE, 1, minerData); };
    this.initEnv = function initEnv() { this.data = null; };
    this.close = function close() { if (this.queueMonitor) { clearInterval(this.queueMonitor); this.queueMonitor = null; } };
}

module.exports = Database;
