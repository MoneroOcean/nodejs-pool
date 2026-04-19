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

test.describe("remote share", { concurrency: false }, () => {
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
    const originalDateNow = Date.now;
    let fakeNow = 1000;

    Date.now = () => fakeNow;
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
        let retryJob = Array.from(storage.jobs.values())[0];
        assert.equal(retryJob.attempts, 1);
        assert.equal(retryJob.nextAttemptAt, 1001);

        fakeNow = 2000;
        pendingJobs.processDueJobs();
        retryJob = Array.from(storage.jobs.values())[0];

        assert.equal(storage.jobs.size, 1);
        assert.equal(retryJob.attempts, 2);
        assert.equal(retryJob.nextAttemptAt, 2001);
        assert.equal(logs.filter((line) => line.includes("waiting for maturity")).length, 1);
        assert.equal(logs.some((line) => line.includes("Altblock WOW/19994 height 1000")), true);
        assert.equal(logs.some((line) => line.includes("waiting for maturity")), true);
        assert.equal(logs.some((line) => line.includes("1/5")), false);
        assert.equal(logs.some((line) => line.includes("Pausing altblock")), false);
    } finally {
        Date.now = originalDateNow;
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
