"use strict";

const http = require("http");
const https = require("https");
const os = require("os");
const { URL } = require("url");

const BACKLOG_EMAIL_SUBJECT = "FYI: Pool uplink backlog";
const BACKLOG_EMAIL_THRESHOLD = 20000;
const QUEUE_MONITOR_INTERVAL_MS = 30 * 1000;

function postOnce(targetUrl, body, callback) {
    const requestUrl = new URL(targetUrl);
    const req = (requestUrl.protocol === "https:" ? https : http).request({
        hostname: requestUrl.hostname,
        method: "POST",
        path: requestUrl.pathname + requestUrl.search,
        port: requestUrl.port || (requestUrl.protocol === "https:" ? 443 : 80),
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

function sendUntilSuccess(body, targetUrl, callback) {
    postOnce(targetUrl, body, function onPosted(error, statusCode) {
        if (!error && statusCode === 200) return callback();
        setImmediate(function retry() { sendUntilSuccess(body, targetUrl, callback); });
    });
}

function createTaskQueue(concurrency, worker) {
    const pending = [];
    let running = 0;

    function pump() {
        while (running < concurrency && pending.length > 0) {
            const task = pending.shift();
            running += 1;
            worker(task.data, function onDone() {
                running -= 1;
                if (typeof task.callback === "function") task.callback();
                pump();
            });
        }
    }

    return {
        push(data, callback) { pending.push({ data, callback }); pump(); },
        length() { return pending.length; },
        running() { return running; }
    };
}

function sendRemoteFrame(msgType, blockId, payload) {
    process.send({
        type: "sendRemote",
        body: global.protos.WSData.encode({ msgType, key: global.config.api.authKey, msg: payload, exInt: blockId }).toString("hex")
    });
}

function Database() {
    this.sendQueue = createTaskQueue(os.cpus().length * 32, function processTask(task, callback) {
        sendUntilSuccess(task.body, global.config.general.shareHost, callback);
    });

    this.queueMonitor = setInterval(function monitorQueue(queue) {
        if (!global.database || global.database.thread_id !== "(Master) ") return;

        const queued = queue.length();
        const running = queue.running();
        if (queued > 20 || running > 20) {
            console.log(global.database.thread_id + "Remote queue state: " + queued + " items in the queue " + running + " items being processed");
        }
        if (queued >= BACKLOG_EMAIL_THRESHOLD && global.support && typeof global.support.sendEmail === "function") {
            global.support.sendEmail(
                global.config.general.adminEmail,
                BACKLOG_EMAIL_SUBJECT,
                "Queued shares: " + queued + "\nRunning sends: " + running + "\nTarget: " + global.config.general.shareHost + "\nHost: " + global.config.hostname + "\n"
            );
        }
    }, QUEUE_MONITOR_INTERVAL_MS, this.sendQueue);
    if (this.queueMonitor && typeof this.queueMonitor.unref === "function") this.queueMonitor.unref();

    this.storeShare = function storeShare(blockId, shareData) { sendRemoteFrame(global.protos.MESSAGETYPE.SHARE, blockId, shareData); };
    this.storeBlock = function storeBlock(blockId, blockData) { sendRemoteFrame(global.protos.MESSAGETYPE.BLOCK, blockId, blockData); };
    this.storeAltBlock = function storeAltBlock(blockId, blockData) { sendRemoteFrame(global.protos.MESSAGETYPE.ALTBLOCK, blockId, blockData); };
    this.storeInvalidShare = function storeInvalidShare(minerData) { sendRemoteFrame(global.protos.MESSAGETYPE.INVALIDSHARE, 1, minerData); };
    this.initEnv = function initEnv() { this.data = null; };
    this.close = function close() { if (this.queueMonitor) { clearInterval(this.queueMonitor); this.queueMonitor = null; } };
}

module.exports = Database;
