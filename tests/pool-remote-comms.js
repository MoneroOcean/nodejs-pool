"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

test("remote_comms posts raw share payloads as application/octet-stream", async () => {
    const Database = require("../lib/remote_comms.js");
    const originalSetInterval = global.setInterval;
    const handles = [];
    let server;

    global.setInterval = function (...args) {
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
            general: {
                shareHost: `http://127.0.0.1:${server.address().port}/leafApi`
            }
        };

        const database = new Database();
        global.database = {
            thread_id: "(Master) "
        };

        const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        await new Promise((resolve) => {
            database.sendQueue.push({ body: payload }, resolve);
        });

        const request = await requestPromise;
        assert.equal(request.headers["content-type"], "application/octet-stream");
        assert.equal(request.body.equals(payload), true);
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
