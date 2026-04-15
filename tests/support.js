"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");

const supportFactory = require("../lib/support.js");

function installSupportGlobals() {
    const original = {
        config: global.config
    };

    global.config = {
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
        general: {}
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

test("support rpcPortDaemon2 enforces a hard wall timeout", async () => {
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

test("support rpcPortDaemon2 keeps boolean suppressErrorLog call sites working", async () => {
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

test("support rpcPortDaemon2 logs JSON-RPC errors unless suppressed", async () => {
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
