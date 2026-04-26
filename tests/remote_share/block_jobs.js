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

test.describe("remote share block jobs", { concurrency: false }, () => {
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
        getBlockHeaderByHash(_hash, callback, suppressErrorLog) {
            headerCalls += 1;
            assert.equal(suppressErrorLog, true);
            if (headerCalls === 1) return callback({ message: "Core is busy" }, null);
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
        assert.equal(logs.some((line) =>
            line.includes("Pending block:") &&
            line.includes("chain=XMR/18081") &&
            line.includes('status=waiting-header-reward') &&
            line.includes('detail=\"Core is busy\"')
        ), true);

        const retryJob = Array.from(storage.jobs.values())[0];
        retryJob.nextAttemptAt = 0;
        storage.save(retryJob);
        pendingJobs.processDueJobs();

        assert.equal(storage.jobs.size, 0);
        assert.equal(stores.blockDB.size, 1);
        const stored = PROTOS.Block.decode(Array.from(stores.blockDB.values())[0]);
        assert.equal(stored.value, 25);
        assert.equal(logs.some((line) =>
            line.includes("Pending block:") &&
            line.includes("chain=XMR/18081") &&
            line.includes("status=stored")
        ), true);
    } finally {
        pendingJobs.close();
        restore();
    }
});

test("pending altblock jobs keep orphan detail in module logs and suppress raw daemon logs", () => {
    const restore = installRemoteShareGlobals();
    const { database } = createPendingJobDatabase();
    const storage = createMapStorage();
    const logs = [];

    global.coinFuncs = {
        getPortBlockHeaderByHash(_port, _hash, callback, suppressErrorLog) {
            assert.equal(suppressErrorLog, true);
            callback(true, { error: { message: "Transaction not found." } });
        },
        getPoolProfile() {
            return { rpc: { unlockConfirmationDepth: 5 } };
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

        assert.equal(storage.jobs.size, 1);
        assert.equal(logs.some((line) =>
            line.includes("Pending altblock:") &&
            line.includes("chain=WOW/19994") &&
            line.includes("height=1000") &&
            line.includes("status=waiting-orphan-confirmation") &&
            line.includes('detail=\"Transaction not found.\"')
        ), true);
    } finally {
        pendingJobs.close();
        restore();
    }
});

test("pending block jobs back off retries and cap the delay", () => {
    const restore = installRemoteShareGlobals();
    const { database } = createPendingJobDatabase();
    const storage = createMapStorage();
    const originalDateNow = Date.now;
    let fakeNow = 1000;

    Date.now = () => fakeNow;
    global.coinFuncs = {
        getBlockHeaderByHash(_hash, callback) {
            callback(true, null);
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
        retryDelayMs: 10,
        maxRetryDelayMs: 80,
        storage
    });

    try {
        const block = {
            hash: "ab".repeat(32),
            difficulty: 100,
            shares: 0,
            timestamp: fakeNow,
            poolType: PROTOS.POOLTYPE.PPLNS,
            unlocked: false,
            valid: true
        };
        pendingJobs.enqueueBlock(13, PROTOS.Block.encode(block), block);

        pendingJobs.processDueJobs();
        let retryJob = Array.from(storage.jobs.values())[0];
        assert.equal(retryJob.attempts, 1);
        assert.equal(retryJob.nextAttemptAt, 1010);

        fakeNow = 2000;
        pendingJobs.processDueJobs();
        retryJob = Array.from(storage.jobs.values())[0];
        assert.equal(retryJob.attempts, 2);
        assert.equal(retryJob.nextAttemptAt, 2020);

        fakeNow = 3000;
        pendingJobs.processDueJobs();
        retryJob = Array.from(storage.jobs.values())[0];
        assert.equal(retryJob.attempts, 3);
        assert.equal(retryJob.nextAttemptAt, 3040);

        fakeNow = 4000;
        pendingJobs.processDueJobs();
        retryJob = Array.from(storage.jobs.values())[0];
        assert.equal(retryJob.attempts, 4);
        assert.equal(retryJob.nextAttemptAt, 4080);

        fakeNow = 5000;
        pendingJobs.processDueJobs();
        retryJob = Array.from(storage.jobs.values())[0];
        assert.equal(retryJob.attempts, 5);
        assert.equal(retryJob.nextAttemptAt, 5080);
    } finally {
        Date.now = originalDateNow;
        pendingJobs.close();
        restore();
    }
});

});
