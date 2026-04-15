"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

test("pool remote uplink posts raw share payloads as application/octet-stream", async () => {
    const Database = require("../lib/pool/remote_uplink.js");
    const originalSetInterval = global.setInterval;
    const handles = [];
    let server;

    global.setInterval = function patchedSetInterval(...args) {
        const handle = originalSetInterval(...args);
        if (handle && typeof handle.unref === "function") handle.unref();
        handles.push(handle);
        return handle;
    };

    try {
        const requestPromise = new Promise((resolve, reject) => {
            server = http.createServer((req, res) => {
                const chunks = [];
                req.on("data", (chunk) => chunks.push(chunk));
                req.on("end", () => {
                    res.statusCode = 200;
                    res.end("ok");
                    resolve({
                        body: Buffer.concat(chunks),
                        headers: req.headers
                    });
                });
                req.on("error", reject);
            });
            server.on("error", reject);
        });

        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });

        global.config = {
            hostname: "pool-harness",
            general: {
                adminEmail: "admin@example.com",
                shareHost: `http://127.0.0.1:${server.address().port}/leafApi`
            }
        };

        const database = new Database();
        global.database = {
            thread_id: "[M] "
        };

        const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        await new Promise((resolve) => {
            database.sendQueue.push({ body: payload }, resolve);
        });

        const request = await requestPromise;
        assert.equal(request.headers["content-type"], "application/octet-stream");
        assert.equal(request.body.equals(payload), true);
        database.close();
    } finally {
        global.setInterval = originalSetInterval;
        delete global.config;
        delete global.database;
        for (const handle of handles) clearInterval(handle);
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    }
});

test("pool remote uplink queue monitor emits FYI backlog email once threshold is reached", async () => {
    const Database = require("../lib/pool/remote_uplink.js");
    const originalSetInterval = global.setInterval;
    const intervals = [];

    global.setInterval = function captureSetInterval(fn, ms, queue) {
        intervals.push({ fn, ms, queue });
        return {
            unref() {},
            hasRef() { return false; }
        };
    };

    try {
        const emails = [];
        global.config = {
            hostname: "pool-harness",
            general: {
                adminEmail: "admin@example.com",
                shareHost: "http://127.0.0.1:8000/leafApi"
            }
        };
        global.support = {
            sendEmail(to, subject, body) {
                emails.push({ to, subject, body });
            }
        };
        global.database = {
            thread_id: "[M] "
        };

        const database = new Database();
        const monitor = intervals.find((entry) => entry.ms === 30 * 1000);
        assert.ok(monitor);

        monitor.fn({
            length() {
                return 20000;
            },
            running() {
                return 3;
            }
        }, database.sendStats);

        assert.equal(emails.length, 1);
        assert.equal(emails[0].subject, "FYI: Pool uplink backlog");
        assert.match(emails[0].body, /Queued shares: 20000/);
        database.close();
    } finally {
        global.setInterval = originalSetInterval;
        delete global.config;
        delete global.database;
        delete global.support;
    }
});

test("pool remote uplink queue monitor reports failed response statuses", async () => {
    const Database = require("../lib/pool/remote_uplink.js");
    const originalSetInterval = global.setInterval;
    const originalConsoleLog = console.log;
    const intervals = [];
    const logs = [];
    let server;
    let requestCount = 0;

    console.log = function captureLog(message) {
        logs.push(message);
    };
    global.setInterval = function captureSetInterval(fn, ms, ...args) {
        intervals.push({ fn, ms, args });
        return {
            unref() {},
            hasRef() { return false; }
        };
    };

    try {
        server = http.createServer((req, res) => {
            requestCount += 1;
            res.statusCode = requestCount === 1 ? 403 : 200;
            res.end("ok");
        });
        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });

        global.config = {
            hostname: "pool-harness",
            general: {
                adminEmail: "admin@example.com",
                shareHost: `http://127.0.0.1:${server.address().port}/leafApi`
            }
        };
        global.database = {
            thread_id: "[M] "
        };

        const database = new Database();
        await new Promise((resolve) => {
            database.sendQueue.push({ body: Buffer.from([0xaa]) }, resolve);
        });

        const monitor = intervals.find((entry) => entry.ms === 30 * 1000);
        assert.ok(monitor);
        monitor.fn(...monitor.args);

        assert.equal(requestCount, 2);
        assert.ok(logs.some((line) => /failed=1/.test(line) && /statuses=403:1/.test(line) && /ok=1/.test(line)));
        database.close();
    } finally {
        console.log = originalConsoleLog;
        global.setInterval = originalSetInterval;
        delete global.config;
        delete global.database;
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    }
});
