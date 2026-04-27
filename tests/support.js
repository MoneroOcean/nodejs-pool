"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const supportFactory = require("../lib/common/support.js");

function installSupportGlobals() {
    const original = {
        config: global.config
    };

    global.config = {
        api: {
            secKey: "test-secret"
        },
        rpc: {
            https: false
        },
        daemon: {
            address: "127.0.0.1",
            port: 18081
        },
        wallet: {
            address: "127.0.0.1",
            port: 18081
        },
        general: {
            emailUnsubscribeBaseUrl: "https://api.moneroocean.stream"
        }
    };

    return function restore() {
        global.config = original.config;
    };
}

function createResponse() {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.setEncoding = function setEncoding() {};
    return response;
}

function createRequest() {
    const request = new EventEmitter();
    request.write = function write() {};
    request.end = function end() {};
    request.setTimeout = function setTimeout() {};
    request.destroy = function destroy(error) {
        this.emit("error", error);
    };
    return request;
}

test.describe("support", { concurrency: false }, () => {
    test("rpcPortDaemon2 enforces a hard wall timeout", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalSetTimeout = global.setTimeout;
        const support = supportFactory();

        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            const response = createResponse();
            let interval = null;

            setImmediate(function startResponse() {
                onResponse(response);
                response.emit("data", "{");
                interval = setInterval(function emitChunk() {
                    response.emit("data", "\"tick\":1,");
                }, 20);
            });
            request.on("error", function stopChunks() {
                if (interval !== null) clearInterval(interval);
            });

            return request;
        };
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            return originalSetTimeout(fn, delay === 30 * 1000 ? 10 : delay, ...args);
        };

        try {
            const startedAt = Date.now();
            const result = await new Promise((resolve) => {
                support.rpcPortDaemon2(18081, "", { ping: true }, function onReply(reply) {
                    resolve({
                        elapsedMs: Date.now() - startedAt,
                        reply
                    });
                });
            });

            assert.equal(result.reply instanceof Error, true);
            assert.match(String(result.reply.message), /Request timed out/);
            assert.ok(result.elapsedMs < 1000, "hard timeout should finish promptly");
        } finally {
            http.request = originalRequest;
            global.setTimeout = originalSetTimeout;
            restore();
        }
    });

    test("rpcPortDaemon2 keeps boolean suppressErrorLog call sites working", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const support = supportFactory();

        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            const response = createResponse();

            setImmediate(function respond() {
                onResponse(response);
                response.emit("data", JSON.stringify({ result: { ok: true } }));
                response.emit("end");
            });

            return request;
        };

        try {
            const result = await new Promise((resolve) => {
                support.rpcPortDaemon2(18081, "", { ping: true }, function onReply(reply, statusCode) {
                    resolve({ reply, statusCode });
                }, true);
            });

            assert.deepEqual(result.reply, { result: { ok: true } });
            assert.equal(result.statusCode, 200);
        } finally {
            http.request = originalRequest;
            restore();
        }
    });

    test("rpcPortDaemon2 forces connection close on shared JSON RPC requests by default", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const support = supportFactory();
        let requestOptions;

        http.request = function fakeRequest(options, onResponse) {
            requestOptions = options;
            const request = createRequest();
            const response = createResponse();

            setImmediate(function respond() {
                onResponse(response);
                response.emit("data", JSON.stringify({ result: { ok: true } }));
                response.emit("end");
            });

            return request;
        };

        try {
            const result = await new Promise((resolve) => {
                support.rpcPortDaemon2(18081, "", { ping: true }, function onReply(reply, statusCode) {
                    resolve({ reply, statusCode });
                });
            });

            assert.deepEqual(result.reply, { result: { ok: true } });
            assert.equal(result.statusCode, 200);
            assert.equal(requestOptions.headers.Connection, "close");
        } finally {
            http.request = originalRequest;
            restore();
        }
    });

    test("rpcPortDaemon2 can disable forced connection close", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const support = supportFactory();
        let requestOptions;

        http.request = function fakeRequest(options, onResponse) {
            requestOptions = options;
            const request = createRequest();
            const response = createResponse();

            setImmediate(function respond() {
                onResponse(response);
                response.emit("data", JSON.stringify({ result: { ok: true } }));
                response.emit("end");
            });

            return request;
        };

        try {
            const result = await new Promise((resolve) => {
                support.rpcPortDaemon2(18081, "", { ping: true }, function onReply(reply, statusCode) {
                    resolve({ reply, statusCode });
                }, { suppressErrorLog: true, connectionClose: false });
            });

            assert.deepEqual(result.reply, { result: { ok: true } });
            assert.equal(result.statusCode, 200);
            assert.equal(Object.prototype.hasOwnProperty.call(requestOptions.headers, "Connection"), false);
        } finally {
            http.request = originalRequest;
            restore();
        }
    });

    test("rpcPortDaemon2 logs JSON-RPC errors unless suppressed", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalConsoleError = console.error;
        const support = supportFactory();
        const errors = [];

        console.error = function captureConsoleError(message) {
            errors.push(String(message));
        };
        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            const response = createResponse();

            setImmediate(function respond() {
                onResponse(response);
                response.emit("data", JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    error: {
                        code: -32602,
                        message: "invalid argument 0: invalid hex string"
                    }
                }));
                response.emit("end");
            });

            return request;
        };

        try {
            const result = await new Promise((resolve) => {
                support.rpcPortDaemon2(18081, "", {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_getBlockByNumber",
                    params: ["0x-7", true]
                }, function onReply(reply, statusCode) {
                    resolve({ reply, statusCode });
                });
            });

            assert.equal(result.reply.error.code, -32602);
            assert.equal(result.reply.error.message, "invalid argument 0: invalid hex string");
            assert.equal(result.statusCode, 200);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /http:\/\/127\.0\.0\.1:18081\//);
            assert.match(errors[0], /invalid hex string/);
        } finally {
            console.error = originalConsoleError;
            http.request = originalRequest;
            restore();
        }
    });

    test("miner email includes opaque unsubscribe footer while admin email stays unchanged", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalSetTimeout = global.setTimeout;
        const support = supportFactory();
        let capturedPayload = null;
        let minerTimerCount = 0;

        global.config.general.adminEmail = "admin@example.com";
        global.config.general.emailFrom = "pool@example.com";
        global.config.general.mailgunURL = "http://127.0.0.1/send";
        support._resetEmailState();
        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            let requestBody = "";
            request.write = function write(chunk) {
                requestBody += chunk;
            };
            request.end = function end() {
                capturedPayload = JSON.parse(requestBody);
                const response = createResponse();
                setImmediate(function respond() {
                    onResponse(response);
                    response.emit("data", "{}");
                    response.emit("end");
                });
            };
            return request;
        };
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            if (delay === 5 * 60 * 1000 || delay === 30 * 60 * 1000 || delay === 1000) {
                if (delay !== 1000) minerTimerCount += 1;
                return setImmediate(fn, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            const wallet = "4".repeat(95);
            const minerUrl = support.createEmailUnsubscribeUrl(wallet, "miner@example.com");
            assert.match(minerUrl, /^https:\/\/api\.moneroocean\.stream\/user\/unsubscribeEmail\/[A-Za-z0-9_-]+$/);
            assert.equal(minerUrl.includes(wallet), false);
            const parsed = support.parseEmailUnsubscribeToken(minerUrl.split("/").pop());
            assert.equal(parsed.wallet, wallet);
            assert.equal(parsed.email, "miner@example.com");

            support.sendEmail("miner@example.com", "Subject", "Body", wallet);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(capturedPayload.subject, "MoneroOcean: Subject");
            assert.match(capturedPayload.text, /Body\n\nUnsubscribe: https:\/\/api\.moneroocean\.stream\/user\/unsubscribeEmail\/[A-Za-z0-9_-]+/);
            assert.equal(capturedPayload.text.includes(wallet), false);

            global.config.general.mailgunURL = "";
            support.sendEmail("admin@example.com", "Admin", "Admin body");
            assert.equal(minerTimerCount, 1, "admin email should not be queued through miner accumulator");
        } finally {
            http.request = originalRequest;
            global.setTimeout = originalSetTimeout;
            restore();
        }
    });

    test("miner email batching can use a stable key and appends one unsubscribe footer", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalSetTimeout = global.setTimeout;
        const support = supportFactory();
        let capturedPayload = null;

        global.config.general.adminEmail = "admin@example.com";
        global.config.general.emailFrom = "pool@example.com";
        global.config.general.mailgunURL = "http://127.0.0.1/send";
        support._resetEmailState();
        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            let requestBody = "";
            request.write = function write(chunk) {
                requestBody += chunk;
            };
            request.end = function end() {
                capturedPayload = JSON.parse(requestBody);
                const response = createResponse();
                setImmediate(function respond() {
                    onResponse(response);
                    response.emit("data", "{}");
                    response.emit("end");
                });
            };
            return request;
        };
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            if (delay === 5 * 60 * 1000 || delay === 30 * 60 * 1000 || delay === 1000) {
                return setImmediate(fn, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            const wallet = "4".repeat(95);
            const options = {
                batchKey: "worker-stopped:" + wallet,
                batchSubject: "Workers stopped hashing"
            };
            support.sendEmail("miner@example.com", "Worker stopped hashing: rig01", "Worker: rig01", wallet, options);
            support.sendEmail("miner@example.com", "Worker stopped hashing: rig02", "Worker: rig02", wallet, options);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            assert.equal(capturedPayload.subject, "MoneroOcean: Workers stopped hashing");
            assert.match(capturedPayload.text, /Worker: rig01\n\nWorker: rig02/);
            assert.equal((capturedPayload.text.match(/Unsubscribe: /g) || []).length, 1);
            assert.equal(capturedPayload.text.includes(wallet), false);
        } finally {
            http.request = originalRequest;
            global.setTimeout = originalSetTimeout;
            restore();
        }
    });

    test("email retry failure logs circular HTTP responses without throwing", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalSetTimeout = global.setTimeout;
        const originalConsoleError = console.error;
        const support = supportFactory();
        const errors = [];
        let requestCount = 0;

        support._resetEmailState();
        global.config.general.adminEmail = "ops@example.com";
        global.config.general.emailFrom = "pool@example.com";
        global.config.general.mailgunURL = "http://127.0.0.1/send";

        console.error = function captureConsoleError(message) {
            errors.push(String(message));
        };
        http.request = function fakeRequest(_options, onResponse) {
            requestCount += 1;
            const request = createRequest();
            let requestBody = "";
            request.write = function write(chunk) {
                requestBody += chunk;
            };
            request.end = function end() {
                JSON.parse(requestBody);
                const response = createResponse();
                response.statusCode = 500;
                response.statusMessage = "Internal Server Error";
                response.headers = { "content-type": "application/json" };
                response.socket = { _httpMessage: request };
                request.socket = response.socket;

                setImmediate(function respond() {
                    onResponse(response);
                    response.emit("data", "{\"message\":\"mailgun failed\"}");
                    response.emit("end");
                });
            };
            return request;
        };
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            if (delay === 50 * 1000) {
                return originalSetTimeout(fn, 1001, ...args);
            }
            if (delay === 1000) {
                return setImmediate(fn, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            support.sendEmail("ops@example.com", "Mailgun test", "Body");
            for (let index = 0; index < 30 && errors.length === 0; ++index) {
                await new Promise((resolve) => originalSetTimeout(resolve, 50));
            }

            assert.equal(requestCount, 2);
            assert.equal(errors.length, 1);
            assert.equal(errors[0].includes("\n"), false);
            assert.match(errors[0], /Did not send e-mail to 'ops@example\.com' successfully!/);
            assert.match(errors[0], /status=500 Internal Server Error/);
            assert.match(errors[0], /mailgun failed/);
        } finally {
            console.error = originalConsoleError;
            http.request = originalRequest;
            global.setTimeout = originalSetTimeout;
            restore();
        }
    });

    test("rpcPortDaemon2 logs transport errors without stack traces", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalConsoleError = console.error;
        const support = supportFactory();
        const errors = [];

        console.error = function captureConsoleError(message) {
            errors.push(String(message));
        };
        http.request = function fakeRequest() {
            const request = createRequest();

            setImmediate(function failRequest() {
                const error = new Error("socket hang up");
                error.stack = [
                    "Error: socket hang up",
                    "    at Socket.socketOnEnd (node:_http_client:524:23)",
                    "    at Socket.emit (node:events:530:35)",
                    "    at endReadableNT (node:internal/streams/readable:1696:12)"
                ].join("\n");
                request.emit("error", error);
            });

            return request;
        };

        try {
            const result = await new Promise((resolve) => {
                support.rpcPortDaemon2(18081, "", { ping: true }, function onReply(reply) {
                    resolve(reply);
                });
            });

            assert.equal(result instanceof Error, true);
            assert.equal(errors.length, 1);
            assert.equal(errors[0].includes("\n"), false);
            assert.match(errors[0], /Error doing http:\/\/127\.0\.0\.1:18081\//);
            assert.match(errors[0], /Error: socket hang up$/);
            assert.doesNotMatch(errors[0], /Socket\.socketOnEnd|Socket\.emit|endReadableNT/);
        } finally {
            console.error = originalConsoleError;
            http.request = originalRequest;
            restore();
        }
    });

    test("admin emails include the pool node label", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalConsoleLog = console.log;
        const support = supportFactory();
        let capturedPayload = null;
        const logs = [];
        support._resetEmailState();

        global.config.hostname = "pool-test";
        global.config.bind_ip = "203.0.113.7";
        global.config.general = {
            adminEmail: "ops@example.com",
            emailSig: "Pool %(wallet)s",
            emailFrom: "pool@example.com",
            mailgunURL: "http://127.0.0.1/send"
        };

        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            let requestBody = "";
            request.write = function write(chunk) {
                requestBody += chunk;
            };
            request.end = function end() {
                capturedPayload = JSON.parse(requestBody);
                const response = createResponse();
                setImmediate(function respond() {
                    onResponse(response);
                    response.emit("data", "{}");
                    response.emit("end");
                });
            };
            return request;
        };

        try {
            console.log = function captureLog(message) {
                logs.push(String(message));
            };
            support.sendEmail("ops@example.com", "Daemon failed", "daemon is down");
            await new Promise((resolve) => setImmediate(resolve));

            assert.equal(capturedPayload.subject, "[pool-test] Daemon failed");
            assert.equal(capturedPayload.text, "Pool node: pool-test\n\ndaemon is down");
            assert.deepEqual(logs, ['Email: to="ops@example.com" status=sent response="{}"']);
        } finally {
            console.log = originalConsoleLog;
            http.request = originalRequest;
            restore();
        }
    });

    test("miner emails use pool branding without internal node labels", async () => {
        const restore = installSupportGlobals();
        const originalRequest = http.request;
        const originalSetTimeout = global.setTimeout;
        const support = supportFactory();
        let capturedPayload = null;
        support._resetEmailState();

        global.config.hostname = "pool-test";
        global.config.bind_ip = "203.0.113.7";
        global.config.general = {
            adminEmail: "ops@example.com",
            emailFrom: "pool@example.com",
            mailgunURL: "http://127.0.0.1/send"
        };

        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            let requestBody = "";
            request.write = function write(chunk) {
                requestBody += chunk;
            };
            request.end = function end() {
                capturedPayload = JSON.parse(requestBody);
                const response = createResponse();
                setImmediate(function respond() {
                    onResponse(response);
                    response.emit("data", "{}");
                    response.emit("end");
                });
            };
            return request;
        };
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            if (delay === 5 * 60 * 1000 || delay === 30 * 60 * 1000 || delay === 1000) {
                return setImmediate(fn, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            support.sendEmail("miner@example.com", "Worker stopped", "Worker x stopped", "wallet");
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            assert.equal(capturedPayload.subject, "MoneroOcean: Worker stopped");
            assert.match(capturedPayload.text, /^Hello,\n\nWorker x stopped\n\nUnsubscribe: https:\/\/api\.moneroocean\.stream\/user\/unsubscribeEmail\/[A-Za-z0-9_-]+\n\nThank you,\nMoneroOcean Admin Team$/);
            assert.equal(capturedPayload.text.includes("Pool node:"), false);
            assert.equal(capturedPayload.text.includes("wallet"), false);
        } finally {
            http.request = originalRequest;
            global.setTimeout = originalSetTimeout;
            restore();
        }
    });

    test("email helper formats subjects, fields, masks, and UTC timestamps", () => {
        const restore = installSupportGlobals();
        const support = supportFactory();

        global.config.hostname = "us.moneroocean.stream";
        global.config.general = { emailBrand: "MoneroOcean" };

        try {
            assert.equal(support.formatEmailSubject("Worker stopped", "miner"), "MoneroOcean: Worker stopped");
            assert.equal(support.formatEmailSubject("Daemon failed", "admin"), "[us] Daemon failed");
            assert.equal(support.maskWalletAddress("48abcdef1234567897xYz"), "48abcd...7xYz");
            assert.equal(support.formatPlainTextFields([
                { label: "Pool", value: "MoneroOcean" },
                { label: "Empty", value: "" },
                { label: "Status", value: "stopped" }
            ]), "Pool: MoneroOcean\nStatus: stopped");
            assert.equal(support.formatDateUTC(Date.UTC(2026, 3, 25, 21, 22, 0)), "2026-04-25 21:22:00");
        } finally {
            restore();
        }
    });

    test("deployment base SQL carries the bundled email defaults", () => {
        const support = supportFactory();
        const baseSql = fs.readFileSync(path.join(__dirname, "..", "deployment", "base.sql"), "utf8");
        const sqlString = function sqlString(value) {
            return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/'/g, "''");
        };

        Object.keys(support.emailDefaults.general).forEach(function assertGeneralDefault(item) {
            assert.ok(
                baseSql.includes("('general', '" + item + "', '" + sqlString(support.emailDefaults.general[item]) + "',"),
                "missing general." + item + " default in deployment/base.sql"
            );
        });
        Object.keys(support.emailDefaults.email).forEach(function assertEmailDefault(item) {
            assert.ok(
                baseSql.includes("('email', '" + item + "', '" + sqlString(support.emailDefaults.email[item]) + "',"),
                "missing email." + item + " default in deployment/base.sql"
            );
        });
    });

    test("detectNodeIp ignores wildcard bind addresses", () => {
        const restore = installSupportGlobals();
        const os = require("node:os");
        const originalNetworkInterfaces = os.networkInterfaces;
        const support = supportFactory();

        global.config.bind_ip = "::";
        os.networkInterfaces = function fakeNetworkInterfaces() {
            return {
                lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
                eth0: [{ family: "IPv4", address: "198.51.100.12", internal: false }]
            };
        };

        try {
            assert.equal(support.detectNodeIp(), "198.51.100.12");
        } finally {
            os.networkInterfaces = originalNetworkInterfaces;
            restore();
        }
    });
});
