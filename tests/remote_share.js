"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const protobuf = require("protocol-buffers");
const test = require("node:test");

const createPendingJobs = require("../lib/remote_share/pending_jobs.js");
global.__remoteShareAutostart = false;
const createRemoteShareRuntime = require("../lib/remote_share.js").createRemoteShareRuntime;
delete global.__remoteShareAutostart;

const PROTOS = protobuf(fs.readFileSync(path.join(__dirname, "..", "lib", "common", "data.proto")));

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test.describe("remote share", { concurrency: false }, () => {
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
        requestSummaryIntervalMs: 20,
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
            /fail=400:2,403:1/.test(line) &&
            /reject=frame:1,auth:1,share:1/.test(line)
        )), 200);
    } finally {
        console.log = originalConsoleLog;
        await runtime.stop();
        restore();
    }
});

test("remote_share enqueues block work durably and returns success immediately", async () => {
    const restore = installRemoteShareGlobals();
    const pendingJobs = {
        blocks: [],
        enqueueBlock(blockId, payload, block) {
            this.blocks.push({ blockId, payload, block });
        },
        enqueueAltBlock() {},
        processDueJobsCalled: 0,
        processDueJobs() {
            this.processDueJobsCalled += 1;
        },
        close() {}
    };
    const runtime = createRemoteShareRuntime({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0,
        pendingJobs,
        shareStore: {
            storeShares() {}
        }
    });

    try {
        runtime.start();
        const address = await waitForListening(runtime);
        const blockPayload = PROTOS.Block.encode({
            hash: "ab".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true
        });
        const frame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.BLOCK,
            key: "secret",
            msg: blockPayload,
            exInt: 77
        });

        assert.equal(await postFrame(address.port, frame), 200);
        assert.equal(pendingJobs.blocks.length, 1);
        assert.equal(pendingJobs.blocks[0].blockId, 77);
        assert.equal(pendingJobs.processDueJobsCalled > 0, true);
    } finally {
        await runtime.stop();
        restore();
    }
});

test("remote_share stop flushes queued shares and awaits pending job shutdown", async () => {
    const restore = installRemoteShareGlobals();
    const shareStore = {
        batches: [],
        storeShares(batch) {
            this.batches.push(batch);
        }
    };
    const pendingJobs = {
        closeFinished: false,
        enqueueBlock() {},
        enqueueAltBlock() {},
        processDueJobs() {},
        close() {
            return new Promise((resolve) => {
                setTimeout(() => {
                    this.closeFinished = true;
                    resolve();
                }, 20);
            });
        }
    };
    const runtime = createRemoteShareRuntime({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0,
        pendingJobs,
        shareFlushIntervalMs: 1000,
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
            identifier: "rigStop",
            raw_shares: 42
        });
        const frame = PROTOS.WSData.encode({
            msgType: PROTOS.MESSAGETYPE.SHARE,
            key: "secret",
            msg: sharePayload,
            exInt: 55
        });

        assert.equal(await postFrame(address.port, frame), 200);
        await runtime.stop();

        assert.equal(shareStore.batches.length, 1);
        assert.equal(shareStore.batches[0].length, 1);
        assert.equal(shareStore.batches[0][0].identifier, "rigStop");
        assert.equal(pendingJobs.closeFinished, true);
    } finally {
        restore();
    }
});

test("pending block jobs retry until a reward is available and then store the block", () => {
    const restore = installRemoteShareGlobals();
    const { database, stores } = createPendingJobDatabase();
    const storage = createMapStorage();
    const logs = [];
    let headerCalls = 0;

    global.coinFuncs = {
        getBlockHeaderByHash(_hash, callback) {
            headerCalls += 1;
            if (headerCalls === 1) return callback(true, null);
            callback(null, { reward: 25 });
        },
        getPoolProfile() {
            return { pool: {} };
        },
        PORT2COIN() {
            return "XMR";
        },
        PORT2COIN_FULL() {
            return "XMR";
        }
    };

    const pendingJobs = createPendingJobs({
        database,
        logger: { log(message) { logs.push(message); } },
        retryDelayMs: 1,
        storage
    });

    try {
        const block = {
            hash: "cd".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true
        };
        pendingJobs.enqueueBlock(11, PROTOS.Block.encode(block), block);

        pendingJobs.processDueJobs();
        assert.equal(storage.jobs.size, 1);

        const retryJob = Array.from(storage.jobs.values())[0];
        retryJob.nextAttemptAt = 0;
        storage.save(retryJob);
        pendingJobs.processDueJobs();

        assert.equal(storage.jobs.size, 0);
        assert.equal(stores.blockDB.size, 1);
        const stored = PROTOS.Block.decode(Array.from(stores.blockDB.values())[0]);
        assert.equal(stored.value, 25);
        assert.match(logs.join("\n"), /Block XMR\/18081 hash .* stored/);
    } finally {
        pendingJobs.close();
        restore();
    }
});

test("pending job close waits for in-flight processing before closing storage", async () => {
    const restore = installRemoteShareGlobals();
    const { database } = createPendingJobDatabase();
    const jobs = new Map();
    const storage = {
        closed: false,
        closeCount: 0,
        save(job) {
            assert.equal(this.closed, false);
            jobs.set(job.key, { ...job });
        },
        remove(key) {
            assert.equal(this.closed, false);
            jobs.delete(key);
        },
        loadDueJobs(now, limit) {
            return Array.from(jobs.values())
                .filter((job) => job.nextAttemptAt <= now)
                .slice(0, limit)
                .map((job) => ({ ...job }));
        },
        loadAllJobs() {
            return Array.from(jobs.values()).map((job) => ({ ...job }));
        },
        close() {
            this.closed = true;
            this.closeCount += 1;
        }
    };
    let finishHeaderLookup;

    global.coinFuncs = {
        getBlockHeaderByHash(_hash, callback) {
            finishHeaderLookup = callback;
        },
        getPoolProfile() {
            return { pool: {} };
        },
        PORT2COIN() {
            return "XMR";
        },
        PORT2COIN_FULL() {
            return "XMR";
        }
    };

    const pendingJobs = createPendingJobs({
        database,
        logger: { log() {} },
        retryDelayMs: 1,
        storage
    });

    try {
        const block = {
            hash: "aa".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true
        };
        pendingJobs.enqueueBlock(12, PROTOS.Block.encode(block), block);
        pendingJobs.processDueJobs();

        const closePromise = pendingJobs.close();
        assert.equal(storage.closed, false);
        assert.equal(typeof finishHeaderLookup, "function");

        finishHeaderLookup(true, null);
        await closePromise;

        assert.equal(storage.closed, true);
        assert.equal(storage.closeCount, 1);
        assert.equal(jobs.size, 1);
        assert.equal(Array.from(jobs.values())[0].attempts, 1);
    } finally {
        restore();
    }
});

test("pending altblock jobs do not spam repeated waiting-for-depth logs", () => {
    const restore = installRemoteShareGlobals();
    const { database } = createPendingJobDatabase();
    const storage = createMapStorage();
    const logs = [];

    global.coinFuncs = {
        getPortBlockHeaderByHash(_port, _hash, callback) {
            callback(null, { reward: 11, depth: 1 });
        },
        getPoolProfile() {
            return {
                rpc: {
                    unlockConfirmationDepth: 5
                }
            };
        },
        PORT2COIN() {
            return "WOW";
        },
        PORT2COIN_FULL() {
            return "WOW";
        }
    };

    const pendingJobs = createPendingJobs({
        database,
        logger: { log(message) { logs.push(message); } },
        retryDelayMs: 1,
        storage
    });

    try {
        const altBlock = {
            hash: "ef".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true,
            port: 19994,
            height: 1000,
            anchor_height: 999
        };
        pendingJobs.enqueueAltBlock(25, PROTOS.AltBlock.encode(altBlock), altBlock);

        pendingJobs.processDueJobs();
        const retryJob = Array.from(storage.jobs.values())[0];
        retryJob.nextAttemptAt = 0;
        storage.save(retryJob);
        pendingJobs.processDueJobs();

        assert.equal(storage.jobs.size, 1);
        assert.equal(logs.filter((line) => line.includes("waiting for maturity")).length, 1);
        assert.equal(logs.some((line) => line.includes("Altblock WOW/19994 height 1000")), true);
        assert.equal(logs.some((line) => line.includes("waiting for maturity")), true);
        assert.equal(logs.some((line) => line.includes("1/5")), false);
        assert.equal(logs.some((line) => line.includes("Pausing altblock")), false);
    } finally {
        pendingJobs.close();
        restore();
    }
});

test("pending block summary groups jobs by coin and port", () => {
    const restore = installRemoteShareGlobals();
    const { database } = createPendingJobDatabase();
    const storage = createMapStorage();

    global.coinFuncs = {
        getPoolProfile() {
            return { pool: {} };
        },
        PORT2COIN(port) {
            return port === 11812 ? "AEON" : "XMR";
        },
        PORT2COIN_FULL(port) {
            return port === 11812 ? "AEON" : "XMR";
        }
    };

    const pendingJobs = createPendingJobs({
        database,
        logger: { log() {} },
        storage
    });

    try {
        pendingJobs.enqueueBlock(10, PROTOS.Block.encode({
            hash: "01".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true
        }), { hash: "01".repeat(32) });
        pendingJobs.enqueueAltBlock(11, PROTOS.AltBlock.encode({
            hash: "02".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true,
            port: 11812,
            height: 1000,
            anchor_height: 999
        }), {
            hash: "02".repeat(32),
            port: 11812,
            height: 1000
        });
        pendingJobs.enqueueAltBlock(12, PROTOS.AltBlock.encode({
            hash: "03".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: Date.now(),
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true,
            port: 11812,
            height: 1001,
            anchor_height: 1000
        }), {
            hash: "03".repeat(32),
            port: 11812,
            height: 1001
        });

        assert.equal(pendingJobs.getPendingSummary(), "Pending blocks: total=3 AEON/11812=2 XMR/18081=1");
    } finally {
        pendingJobs.close();
        restore();
    }
});

test("remote_share logs periodic pending block summaries with coin labels", async () => {
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
            getPendingSummary() {
                return "Pending blocks: total=3 WOW/11812=1 XMR/18081=2";
            },
            close() {}
        },
        shareStore: {
            storeShares() {}
        },
        shareSummaryIntervalMs: 20
    });

    try {
        runtime.start();
        await waitForCondition(() => logs.some((line) => line.includes("(Single) Pending blocks: total=3 WOW/11812=1 XMR/18081=2")), 200);
    } finally {
        console.log = originalConsoleLog;
        await runtime.stop();
        restore();
    }
});
});
