"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

function createTlsFixtures(directory) {
    function openssl(...args) {
        execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
    }
    for (const name of ["cert", "unrelated"]) {
        openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2",
            "-subj", "/CN=uplink-test.invalid", "-addext", "basicConstraints=critical,CA:TRUE");
    }
    openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
        "-nodes", "-keyout", "child.key", "-out", "child.csr", "-subj", "/CN=uplink-test.invalid");
    openssl("x509", "-req", "-in", "child.csr", "-CA", "cert.pem", "-CAkey", "cert.key",
        "-set_serial", "2", "-days", "2", "-out", "child.pem");
    fs.writeFileSync(path.join(directory, "index.txt"), "");
    fs.writeFileSync(path.join(directory, "serial"), "03\n");
    fs.writeFileSync(path.join(directory, "ca.conf"), "[ca]\ndefault_ca=test_ca\n[test_ca]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ndefault_md=sha256\npolicy=test_policy\n[test_policy]\ncommonName=supplied\n");
    openssl("ca", "-batch", "-config", "ca.conf", "-selfsign", "-in", "child.csr",
        "-keyfile", "child.key", "-cert", "child.pem", "-startdate", "20000101000000Z",
        "-enddate", "20000102000000Z", "-out", "expired.pem");
    function identity(name, keyName = name) {
        return {
            cert: fs.readFileSync(path.join(directory, `${name}.pem`)),
            key: fs.readFileSync(path.join(directory, `${keyName}.key`))
        };
    }
    return { pinned: identity("cert"), unrelated: identity("unrelated"), child: identity("child"), expired: identity("expired", "child") };
}

async function waitForFailure(database) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
        if (database.sendStats.networkErrors > 0) return;
        await delay(20);
    }
    assert.fail("TLS failure was not recorded within five seconds");
}

async function withTlsUplink(identity, certPath, run) {
    const Database = require("../../lib/pool/remote_uplink.js");
    const originalSetInterval = global.setInterval;
    const originalConfig = global.config;
    const originalDatabase = global.database;
    const intervals = [];
    const bodies = [];
    const sockets = new Set();
    let database;
    let connections = 0;
    const server = https.createServer(identity, (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks));
            assert.equal(req.url, "/leafApi?test=tls");
            assert.equal(req.headers["content-type"], "application/octet-stream");
            res.end("ok");
        });
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server.on("secureConnection", () => { connections += 1; });
    global.setInterval = (...args) => {
        const handle = originalSetInterval(...args);
        handle.unref();
        intervals.push(handle);
        return handle;
    };
    try {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        global.config = {
            hostname: "pool-harness",
            general: {
                adminEmail: "admin@example.com",
                shareHost: `https://127.0.0.1:${server.address().port}/leafApi?test=tls`
            }
        };
        if (certPath !== undefined) global.config.general.shareTlsCert = certPath;
        global.database = { thread_id: "[M] " };
        database = new Database();
        await run({
            database, server, bodies,
            connectionCount: () => connections,
            send: (body) => new Promise((resolve) => database.sendQueue.push({ body }, resolve))
        });
    } finally {
        if (database) database.close();
        global.setInterval = originalSetInterval;
        global.config = originalConfig;
        global.database = originalDatabase;
        for (const handle of intervals) clearInterval(handle);
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

test.describe("pool remote uplink", { concurrency: false }, () => {
let fixtureDirectory;
let tlsFixtures;
test.before(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-uplink-tls-"));
    tlsFixtures = createTlsFixtures(fixtureDirectory);
});
test.after(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

test("HTTPS loads the default pinned certificate, permits its hostname mismatch, and reuses one connection", { timeout: 10000 }, async () => {
    const originalCwd = process.cwd();
    process.chdir(fixtureDirectory);
    try {
        await withTlsUplink(tlsFixtures.pinned, undefined, async ({ send, bodies, connectionCount }) => {
            const payloads = [Buffer.from([0xde, 0xad]), Buffer.from([0xbe, 0xef]), Buffer.from([0x01, 0x02])];
            for (const payload of payloads) await send(payload);
            assert.deepEqual(bodies, payloads, "each distinct frame must be delivered exactly once");
            assert.equal(connectionCount(), 1, "serial frames must reuse the TLS connection");
        });
    } finally {
        process.chdir(originalCwd);
    }
});

for (const [name, initialIdentity] of [["unrelated self-signed certificate", "unrelated"], ["CA-signed child of the pinned certificate", "child"]]) {
    test(`HTTPS rejects the ${name} and retries the intact frame after the pinned server recovers`, { timeout: 10000 }, async () => {
        await withTlsUplink(tlsFixtures[initialIdentity], path.join(fixtureDirectory, "cert.pem"), async ({ database, server, send, bodies }) => {
            const payload = Buffer.from([0x00, 0xff, 0xca, 0xfe]);
            const delivery = send(payload);
            try {
                await waitForFailure(database);
                assert.deepEqual(bodies, [], "an unauthenticated server must not receive the frame");
                assert.equal(database.sendQueue.running(), 1, "failed TLS must retain its pending frame");
            } finally {
                server.setSecureContext(tlsFixtures.pinned);
                await delivery;
            }
            assert.deepEqual(bodies, [payload], "retry must preserve the frame without duplicating it");
            assert.equal(database.sendStats.success, 1);
        });
    });
}

test("HTTPS rejects an expired certificate even when it exactly matches the configured pin", { timeout: 10000 }, async () => {
    await withTlsUplink(tlsFixtures.expired, path.join(fixtureDirectory, "expired.pem"), async ({ database, send, bodies }) => {
        // Observe the first retry scheduling without leaving a permanently failing send task alive.
        const originalSetTimeout = global.setTimeout;
        let delivery;
        let retry;
        global.setTimeout = (fn, ms, ...args) => {
            if (ms === 1000 && !retry) {
                retry = fn;
                return { unref() {} };
            }
            return originalSetTimeout(fn, ms, ...args);
        };
        try {
            delivery = send(Buffer.from([0xee]));
            await waitForFailure(database);
            assert.deepEqual(bodies, []);
            assert.ok(database.sendStats.errorCounts.CERT_HAS_EXPIRED, "certificate validity dates must still be enforced");
        } finally {
            global.setTimeout = originalSetTimeout;
            // The retained retry is deliberately not launched; closing the harness destroys all sockets.
            assert.ok(retry, "the rejected frame must be scheduled for retry");
            void delivery;
        }
    });
});

test("posts raw share payloads as application/octet-stream", async () => {
    const Database = require("../../lib/pool/remote_uplink.js");
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

test("queue monitor emits FYI backlog email once threshold is reached", async () => {
    const Database = require("../../lib/pool/remote_uplink.js");
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
            },
            sendAdminFyi(key, subject, body) {
                emails.push({ to: global.config.general.adminEmail, key, subject, body });
                return true;
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

test("queue monitor reports failed response statuses", async () => {
    const Database = require("../../lib/pool/remote_uplink.js");
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

test("store methods frame remote messages with the configured auth key and message type", () => {
    const Database = require("../../lib/pool/remote_uplink.js");
    const originalSetInterval = global.setInterval;
    const originalProcessSend = process.send;
    const encodedFrames = [];
    const sentMessages = [];

    global.setInterval = function captureSetInterval() {
        return {
            unref() {},
            hasRef() { return false; }
        };
    };

    try {
        process.send = function captureSend(message) {
            assert.equal(this, process, "process.send must retain process as its receiver");
            sentMessages.push(message);
        };
        global.config = {
            hostname: "pool-harness",
            api: {
                authKey: "uplink-auth-key"
            },
            general: {
                adminEmail: "admin@example.com",
                shareHost: "http://127.0.0.1:8000/leafApi"
            }
        };
        global.database = {
            thread_id: "[M] "
        };
        global.protos = {
            MESSAGETYPE: {
                SHARE: 1,
                BLOCK: 2,
                ALTBLOCK: 3,
                INVALIDSHARE: 4
            },
            WSData: {
                encode(frame) {
                    encodedFrames.push(frame);
                    return Buffer.from("c0de", "hex");
                }
            }
        };

        const database = new Database();
        database.storeShare(101, Buffer.from("share"));
        database.storeBlock(102, Buffer.from("block"));
        database.storeAltBlock(103, Buffer.from("alt"));
        database.storeInvalidShare(Buffer.from("invalid"));

        assert.equal(sentMessages.length, 4);
        assert.deepEqual(sentMessages.map((entry) => entry.type), ["sendRemote", "sendRemote", "sendRemote", "sendRemote"]);
        assert.deepEqual(sentMessages.map((entry) => entry.body), ["c0de", "c0de", "c0de", "c0de"]);
        assert.deepEqual(encodedFrames.map((entry) => entry.msgType), [1, 2, 3, 4]);
        assert.deepEqual(encodedFrames.map((entry) => entry.exInt), [101, 102, 103, 1]);
        assert.equal(encodedFrames.every((entry) => entry.key === "uplink-auth-key"), true);
        database.close();
    } finally {
        global.setInterval = originalSetInterval;
        process.send = originalProcessSend;
        delete global.config;
        delete global.database;
        delete global.protos;
    }
});

test("send queue retries failed posts on a delay, not a tight next-tick loop", async () => {
    const Database = require("../../lib/pool/remote_uplink.js");
    const originalSetInterval = global.setInterval;
    const originalSetTimeout = global.setTimeout;
    const retryDelays = [];
    let server;
    let requestCount = 0;

    global.setInterval = function captureSetInterval() {
        return { unref() {}, hasRef() { return false; } };
    };
    // Record the retry scheduling delays (postOnce uses req.setTimeout, not global setTimeout,
    // so this only catches the retry path). Pass through to real timers so the flow completes.
    global.setTimeout = function captureSetTimeout(fn, ms, ...args) {
        retryDelays.push(ms);
        return originalSetTimeout(fn, ms, ...args);
    };

    try {
        server = http.createServer((req, res) => {
            requestCount += 1;
            if (requestCount === 1) { req.socket.destroy(); return; } // first post fails
            res.statusCode = 200;
            res.end("ok");
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

        global.config = {
            hostname: "pool-harness",
            general: {
                adminEmail: "admin@example.com",
                shareHost: `http://127.0.0.1:${server.address().port}/leafApi`
            }
        };
        global.database = { thread_id: "[M] " };

        const database = new Database();
        await new Promise((resolve) => {
            database.sendQueue.push({ body: Buffer.from([0xcc]) }, resolve);
        });

        assert.equal(requestCount, 2, "retried once after the network error, then succeeded");
        // The retry must be scheduled with a real delay (>= RETRY_DELAY_MS), never next-tick,
        // so a sustained shareHost outage cannot pin a CPU core / flood the endpoint.
        assert.ok(retryDelays.some((ms) => ms >= 1000), `retry uses a delay, not setImmediate (delays seen: ${retryDelays})`);
        database.close();
    } finally {
        global.setInterval = originalSetInterval;
        global.setTimeout = originalSetTimeout;
        delete global.config;
        delete global.database;
        if (server) await new Promise((resolve) => server.close(resolve));
    }
});

test("send queue retries transient network errors and the monitor logs the network failure summary", async () => {
    const Database = require("../../lib/pool/remote_uplink.js");
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
            if (requestCount === 1) {
                req.socket.destroy();
                return;
            }
            res.statusCode = 200;
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
            database.sendQueue.push({ body: Buffer.from([0xbb]) }, resolve);
        });

        const monitor = intervals.find((entry) => entry.ms === 30 * 1000);
        assert.ok(monitor);
        monitor.fn(...monitor.args);

        assert.equal(requestCount, 2);
        assert.ok(logs.some((line) => /failed=1/.test(line) && /network=1/.test(line) && /ok=1/.test(line)));
        assert.ok(logs.some((line) => /errors=.*ECONNRESET:1|errors=.*socket hang up:1/.test(line)));
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
});
