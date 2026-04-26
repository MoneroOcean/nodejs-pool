"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const protobuf = require("protocol-buffers");
const test = require("node:test");

const createPendingJobs = require("../../lib/remote_share/pending_jobs.js");
global.__remoteShareAutostart = false;
const createRemoteShareRuntime = require("../../lib/remote_share.js").createRemoteShareRuntime;
delete global.__remoteShareAutostart;

const PROTOS = protobuf(fs.readFileSync(path.join(__dirname, "..", "..", "lib", "common", "data.proto")));

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForCondition(check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await wait(10);
    }
    throw new Error("Condition not met within " + timeoutMs + "ms");
}

function listenOnPort(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", function onListen() {
            server.removeListener("error", reject);
            resolve(server);
        });
    });
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(function onClose(error) {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function waitForListening(runtime) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const address = runtime.address();
        if (address && address.port) return address;
        await wait(10);
    }
    throw new Error("remote_share runtime did not start listening");
}

async function captureConsole(run) {
    const originalLog = console.log;
    const originalError = console.error;
    const logs = [];
    const errors = [];
    console.log = function captureLog() { logs.push(Array.from(arguments).join(" ")); };
    console.error = function captureError() { errors.push(Array.from(arguments).join(" ")); };
    try {
        await run({ logs: logs, errors: errors });
        return { logs: logs, errors: errors };
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
}

function createFakeCluster(options) {
    const settings = options || {};
    const listeners = new Map();
    let nextWorkerId = 0;

    function workerRecord(id, pid) {
        return {
            id: id,
            process: { pid: pid },
            on() {},
            off() {},
            removeListener() {}
        };
    }

    return {
        isPrimary: settings.isPrimary !== false,
        worker: settings.isPrimary === false ? { id: settings.workerId || 1 } : null,
        fork() {
            nextWorkerId += 1;
            return workerRecord(nextWorkerId, (settings.pidBase || 9000) + nextWorkerId);
        },
        on(eventName, listener) {
            const entries = listeners.get(eventName) || [];
            entries.push(listener);
            listeners.set(eventName, entries);
        },
        off(eventName, listener) {
            const entries = listeners.get(eventName) || [];
            listeners.set(eventName, entries.filter(function keep(current) { return current !== listener; }));
        },
        removeListener(eventName, listener) {
            this.off(eventName, listener);
        },
        disconnect(callback) {
            if (typeof callback === "function") callback();
        },
        emit(eventName) {
            const args = Array.prototype.slice.call(arguments, 1);
            const entries = listeners.get(eventName) || [];
            entries.forEach(function call(listener) {
                listener.apply(null, args);
            });
        }
    };
}

function postFrame(port, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1",
            port,
            path: "/leafApi",
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": body.length
            }
        }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end(body);
    });
}

function installRemoteShareGlobals(overrides) {
    const original = {
        config: global.config,
        database: global.database,
        protos: global.protos,
        coinFuncs: global.coinFuncs,
        support: global.support
    };

    global.config = {
        hostname: "remote-share-test",
        pool_id: 1,
        api: {
            authKey: "secret"
        },
        daemon: {
            port: 18081
        },
        general: {
            adminEmail: "admin@example.com"
        }
    };
    global.database = {
        storeInvalidShare(_payload, callback) {
            callback(true);
        },
        thread_id: ""
    };
    global.protos = PROTOS;
    global.coinFuncs = {
        getPoolProfile() {
            return { pool: {} };
        },
        COIN2PORT() {
            return 18081;
        },
        PORT2COIN() {
            return "XMR";
        },
        PORT2COIN_FULL() {
            return "XMR";
        }
    };
    global.support = {
        sendEmail() {}
    };

    if (overrides) overrides();

    return function restore() {
        global.config = original.config;
        global.database = original.database;
        global.protos = original.protos;
        global.coinFuncs = original.coinFuncs;
        global.support = original.support;
    };
}

function createMapStorage() {
    const jobs = new Map();
    return {
        jobs,
        save(job) {
            jobs.set(job.key, { ...job });
        },
        remove(key) {
            jobs.delete(key);
        },
        loadDueJobs(now, limit) {
            return Array.from(jobs.values())
                .filter((job) => job.nextAttemptAt <= now)
                .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt)
                .slice(0, limit)
                .map((job) => ({ ...job }));
        },
        loadAllJobs() {
            return Array.from(jobs.values()).map((job) => ({ ...job }));
        },
        close() {}
    };
}

function createPendingJobDatabase() {
    const stores = {
        blockDB: new Map(),
        altblockDB: new Map()
    };
    const resets = [];

    function getStore(db) {
        if (db === database.blockDB) return stores.blockDB;
        if (db === database.altblockDB) return stores.altblockDB;
        throw new Error("Unknown DB handle");
    }

    const database = {
        blockDB: { name: "blockDB" },
        altblockDB: { name: "altblockDB" },
        env: {
            beginTxn() {
                return {
                    getBinary(db, key) {
                        return getStore(db).has(key) ? getStore(db).get(key) : null;
                    },
                    putBinary(db, key, value) {
                        getStore(db).set(key, Buffer.from(value));
                    },
                    abort() {},
                    commit() {}
                };
            }
        },
        getCache(key) {
            if (key.indexOf("stats2") >= 0) return { roundHashes: 1234 };
            return false;
        },
        incrementCacheData(key, value) {
            resets.push({ key, value });
        },
        isAltBlockInDB(port, height) {
            for (const encoded of stores.altblockDB.values()) {
                const block = PROTOS.AltBlock.decode(encoded);
                if (block.port === port && block.height === height) return true;
            }
            return false;
        }
    };

    return { database, resets, stores };
}

test.describe("remote share ingress", { concurrency: false }, () => {
test("remote_share accepts valid share frames and flushes queued shares", async () => {
    const restore = installRemoteShareGlobals();
    const shareStore = {
        batches: [],
        storeShares(batch) {
            this.batches.push(batch);
        }
    };
    const pendingJobs = {
        enqueueBlock() {
            throw new Error("unexpected block enqueue");
        },
        enqueueAltBlock() {
            throw new Error("unexpected altblock enqueue");
        },
        processDueJobs() {},
        close() {}
    };
    const runtime = createRemoteShareRuntime({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0,
        pendingJobs,
        shareFlushIntervalMs: 10,
        shareStore
    });

    try {
        runtime.start();
        const address = await waitForListening(runtime);
        const sharePayload = PROTOS.Share.encode({
            paymentAddress: "49abc",
            foundBlock: false,
            trustedShare: false,
            poolType: PROTOS.POOLTYPE.PPLNS,
            poolID: 1,
            blockDiff: 100,
            blockHeight: 55,
            timestamp: Date.now(),
            identifier: "rig01",
            raw_shares: 42
        });
        const frame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "secret",
            msg: sharePayload,
            exInt: 55
        });

        const statusCode = await postFrame(address.port, frame);
        assert.equal(statusCode, 200);
        await wait(30);

        assert.equal(shareStore.batches.length, 1);
        assert.equal(shareStore.batches[0].length, 1);
        assert.equal(shareStore.batches[0][0].identifier, "rig01");
    } finally {
        await runtime.stop();
        restore();
    }
});

test("remote_share rejects new frames after LMDB map full while flushing shares", async () => {
    const restore = installRemoteShareGlobals();
    const emails = [];
    global.support.sendEmail = function captureEmail() {
        emails.push(Array.from(arguments));
    };
    const shareStore = {
        calls: 0,
        storeShares() {
            this.calls += 1;
            const error = new Error("MDB_MAP_FULL: Environment mapsize limit reached");
            error.code = -30792;
            throw error;
        }
    };
    const pendingJobs = {
        enqueueBlock() {
            throw new Error("unexpected block enqueue");
        },
        enqueueAltBlock() {
            throw new Error("unexpected altblock enqueue");
        },
        processDueJobs() {},
        close() {}
    };
    const runtime = createRemoteShareRuntime({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0,
        pendingJobs,
        shareFlushIntervalMs: 10,
        shareStore
    });

    try {
        runtime.start();
        const address = await waitForListening(runtime);
        const sharePayload = PROTOS.Share.encode({
            paymentAddress: "49abc",
            foundBlock: false,
            trustedShare: false,
            poolType: PROTOS.POOLTYPE.PPLNS,
            poolID: 1,
            blockDiff: 100,
            blockHeight: 55,
            timestamp: Date.now(),
            identifier: "rigMapFull",
            raw_shares: 42
        });
        const shareFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "secret",
            msg: sharePayload,
            exInt: 55
        });
        const blockFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.BLOCK,
            key: "secret",
            msg: PROTOS.Block.encode({
                hash: "ab".repeat(32),
                difficulty: 100,
                shares: 0,
                timestamp: Date.now(),
                poolType: PROTOS.POOLTYPE.PPLNS,
                unlocked: false,
                valid: true
            }),
            exInt: 77
        });

        assert.equal(await postFrame(address.port, shareFrame), 200);
        await waitForCondition(() => emails.length === 1, 500);

        assert.equal(await postFrame(address.port, shareFrame), 503);
        assert.equal(await postFrame(address.port, blockFrame), 503);
        assert.equal(shareStore.calls > 0, true);
        assert.deepEqual(emails[0], [
            "admin@example.com",
            "remote_share rejecting new work due to LMDB full",
            "remote_share is rejecting new share and block frames after LMDB reported map full while flushing queued shares: MDB_MAP_FULL: Environment mapsize limit reached."
        ]);
    } finally {
        await runtime.stop();
        restore();
    }
});

test("remote_share honors port zero even when the default port is unavailable", async () => {
    const restore = installRemoteShareGlobals();
    let blocker = null;
    try {
        try {
            blocker = await listenOnPort(8000);
        } catch (error) {
            if (!error || error.code !== "EADDRINUSE") throw error;
        }

        const runtime = createRemoteShareRuntime({
            clusterEnabled: false,
            host: "127.0.0.1",
            port: 0,
            pendingJobs: {
                enqueueBlock() {},
                enqueueAltBlock() {},
                processDueJobs() {},
                close() {}
            },
            shareStore: {
                storeShares() {}
            }
        });

        try {
            runtime.start();
            const address = await waitForListening(runtime);
            assert.notEqual(address.port, 8000);
        } finally {
            await runtime.stop();
        }
    } finally {
        if (blocker) await closeServer(blocker);
        restore();
    }
});

test("remote_share rejects malformed share payloads and bad auth", async () => {
    const restore = installRemoteShareGlobals();
    const runtime = createRemoteShareRuntime({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0,
        pendingJobs: {
            enqueueBlock() {},
            enqueueAltBlock() {},
            processDueJobs() {},
            close() {}
        },
        shareStore: {
            storeShares() {
                throw new Error("unexpected share flush");
            }
        }
    });

    try {
        runtime.start();
        const address = await waitForListening(runtime);

        const malformedShareFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "secret",
            msg: Buffer.from([0x01, 0x02]),
            exInt: 1
        });
        assert.equal(await postFrame(address.port, malformedShareFrame), 400);

        const validSharePayload = PROTOS.Share.encode({
            paymentAddress: "49abc",
            foundBlock: false,
            trustedShare: false,
            poolType: PROTOS.POOLTYPE.PPLNS,
            poolID: 1,
            blockDiff: 100,
            blockHeight: 55,
            timestamp: Date.now(),
            identifier: "rig01",
            raw_shares: 42
        });
        const badAuthFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "wrong",
            msg: validSharePayload,
            exInt: 1
        });
        assert.equal(await postFrame(address.port, badAuthFrame), 403);
    } finally {
        await runtime.stop();
        restore();
    }
});

test("remote_share logs ingress summaries for accepted and rejected frames", async () => {
    const restore = installRemoteShareGlobals();
    const originalConsoleLog = console.log;
    const logs = [];
    console.log = function captureLog(message) {
        logs.push(message);
    };

    const runtime = createRemoteShareRuntime({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0,
        pendingJobs: {
            enqueueBlock() {},
            enqueueAltBlock() {},
            processDueJobs() {},
            close() {}
        },
        requestSummaryIntervalMs: 100,
        shareFlushIntervalMs: 5,
        shareStore: {
            storeShares() {}
        },
        shareSummaryIntervalMs: 20
    });

    try {
        runtime.start();
        const address = await waitForListening(runtime);

        const validSharePayload = PROTOS.Share.encode({
            paymentAddress: "49abc",
            foundBlock: false,
            trustedShare: false,
            poolType: PROTOS.POOLTYPE.PPLNS,
            poolID: 1,
            blockDiff: 100,
            blockHeight: 55,
            timestamp: Date.now(),
            identifier: "rig01",
            raw_shares: 42
        });

        const validFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "secret",
            msg: validSharePayload,
            exInt: 1
        });
        const malformedShareFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "secret",
            msg: Buffer.from([0x01, 0x02]),
            exInt: 1
        });
        const badAuthFrame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "wrong",
            msg: validSharePayload,
            exInt: 1
        });

        assert.equal(await postFrame(address.port, validFrame), 200);
        assert.equal(await postFrame(address.port, malformedShareFrame), 400);
        assert.equal(await postFrame(address.port, badAuthFrame), 403);
        assert.equal(await postFrame(address.port, Buffer.from([0x01, 0x02, 0x03])), 400);
        await waitForCondition(() => logs.some((line) => (
            line.includes("(Single) Ingress summary:") &&
            /req=4/.test(line) &&
            /ok=1/.test(line) &&
            /share=1/.test(line) &&
            /fail="400:2,403:1"/.test(line) &&
            /reject="frame:1,auth:1,share:1"/.test(line)
        )), 200);
    } finally {
        console.log = originalConsoleLog;
        await runtime.stop();
        restore();
    }
});

test("remote_share cluster lifecycle logs use pool-style master prefixes", async () => {
    const restore = installRemoteShareGlobals();
    const clusterApi = createFakeCluster({ isPrimary: true, pidBase: 9200 });

    try {
        const output = await captureConsole(async function run() {
            const runtime = createRemoteShareRuntime({
                cluster: clusterApi,
                clusterEnabled: true,
                os: { cpus() { return [{}, {}]; } },
                pendingJobs: {
                    enqueueBlock() {},
                    enqueueAltBlock() {},
                    processDueJobs() {},
                    close() {}
                },
                shareStore: {
                    storeShares() {}
                }
            });

            runtime.start();
            clusterApi.emit("online", { process: { pid: 9201 } });
            clusterApi.emit("exit", { process: { pid: 9201 } }, 9, "SIGTERM");
            await runtime.stop();
        });

        assert.ok(output.logs.includes("[M] IMPORTANT: Cluster start: workers=2"));
        assert.ok(output.logs.includes("[M] Worker online: pid=9201"));
        assert.ok(output.errors.includes("[M] Worker exit: pid=9201 code=9 signal=SIGTERM"));
    } finally {
        restore();
    }
});

test("remote_share cluster worker listen logs use pool-style worker prefixes", async () => {
    const restore = installRemoteShareGlobals();
    const clusterApi = createFakeCluster({ isPrimary: false, workerId: 6 });

    try {
        const output = await captureConsole(async function run() {
            const runtime = createRemoteShareRuntime({
                cluster: clusterApi,
                clusterEnabled: true,
                host: "127.0.0.1",
                port: 0,
                pendingJobs: {
                    enqueueBlock() {},
                    enqueueAltBlock() {},
                    processDueJobs() {},
                    close() {}
                },
                shareStore: {
                    storeShares() {}
                }
            });

            runtime.start();
            await waitForListening(runtime);
            await runtime.stop();
        });

        assert.ok(output.logs.some((line) => line.startsWith("[S6:" + process.pid + "] Listen: service=remote-share host=127.0.0.1 port=")));
    } finally {
        restore();
    }
});

});
