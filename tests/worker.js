"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const RECENT_SHARE_WINDOW_PATH = require.resolve("../lib/recent_share_window.js");
const WORKER_PATH = require.resolve("../lib/worker.js");
const WORKER_HISTORY_PATH = require.resolve("../lib/worker_history.js");

function loadWorker() {
    const previousAutostart = global.__workerAutostart;
    global.__workerAutostart = false;
    delete require.cache[WORKER_PATH];

    try {
        return require(WORKER_PATH);
    } finally {
        if (typeof previousAutostart === "undefined") delete global.__workerAutostart;
        else global.__workerAutostart = previousAutostart;
    }
}

function loadWorkerHistory() {
    delete require.cache[WORKER_HISTORY_PATH];
    return require(WORKER_HISTORY_PATH);
}

function loadRecentShareWindow() {
    delete require.cache[RECENT_SHARE_WINDOW_PATH];
    return require(RECENT_SHARE_WINDOW_PATH);
}

function createFakeEnvironment(options) {
    options = options || {};

    const cacheDB = { name: "cache" };
    const shareDB = { name: "share" };
    const cacheStore = new Map(options.cacheEntries || []);
    const shareStore = new Map();
    const emails = [];

    (options.shares || []).forEach(function (entry) {
        const bucket = shareStore.get(entry.height) || [];
        bucket.push(entry.share);
        shareStore.set(entry.height, bucket);
    });

    class Cursor {
        constructor(_txn, db) {
            this.db = db;
            this.key = null;
            this.index = -1;
        }

        goToRange(key) {
            if (this.db !== shareDB || !shareStore.has(key)) {
                this.key = null;
                this.index = -1;
                return null;
            }

            this.key = key;
            this.index = 0;
            return key;
        }

        goToNextDup() {
            if (this.db !== shareDB || this.key === null) return null;
            const entries = shareStore.get(this.key) || [];
            if (this.index + 1 >= entries.length) {
                this.index = -1;
                return null;
            }

            this.index += 1;
            return this.key;
        }

        getCurrentBinary(callback) {
            callback(this.key, shareStore.get(this.key)[this.index]);
        }

        close() {}
    }

    const env = {
        writeCommits: 0,
        commits: [],
        beginTxn(txnOptions) {
            const operations = [];
            const readOnly = !!(txnOptions && txnOptions.readOnly);

            return {
                getString(db, key) {
                    if (db !== cacheDB) return null;
                    return cacheStore.has(key) ? cacheStore.get(key) : null;
                },
                putString(db, key, value) {
                    operations.push(["putString", db, key, value]);
                },
                del(db, key) {
                    operations.push(["del", db, key]);
                },
                commit() {
                    if (readOnly) return;
                    operations.forEach(function (entry) {
                        if (entry[0] === "putString") {
                            cacheStore.set(entry[2], entry[3]);
                            return;
                        }
                        cacheStore.delete(entry[2]);
                    });
                    env.commits.push(operations.slice());
                    env.writeCommits += 1;
                },
                abort() {}
            };
        }
    };

    global.config = {
        daemon: {
            port: 18081
        },
        general: {
            adminEmail: "admin@example.com",
            emailSig: "sig",
            statsBufferHours: options.statsBufferHours || 1,
            statsBufferLength: options.statsBufferLength || 9
        },
        email: {
            workerNotHashingBody: "stopped",
            workerNotHashingSubject: "stopped-subject",
            workerStartHashingBody: "started",
            workerStartHashingSubject: "started-subject"
        }
    };
    global.database = {
        cacheDB: cacheDB,
        env: env,
        lmdb: { Cursor: Cursor },
        shareDB: shareDB
    };
    global.mysql = {
        query() {
            return Promise.resolve([]);
        }
    };
    global.protos = {
        POOLTYPE: {
            PPLNS: 0
        },
        Share: {
            decode(value) {
                return value;
            }
        }
    };
    global.support = {
        formatDate(value) {
            return String(value);
        },
        formatTemplate(template) {
            return template;
        },
        sendEmail() {
            emails.push(Array.from(arguments));
        }
    };

    return {
        cacheStore: cacheStore,
        emails: emails,
        env: env
    };
}

function createShare(share) {
    return {
        identifier: share.identifier,
        paymentAddress: share.paymentAddress,
        paymentID: share.paymentID,
        poolType: 0,
        port: share.port || 18081,
        raw_shares: share.rawShares,
        shares2: share.shares2,
        timestamp: share.timestamp
    };
}

function runUpdate(runtime, height) {
    return new Promise(function (resolve) {
        runtime.updateShareStats2(height, resolve);
    });
}

function toStoredTimestamp(value) {
    return Math.round(value / 1000) * 1000;
}

test.describe("worker", { concurrency: false }, () => {
    let originalConfig;
    let originalDatabase;
    let originalMysql;
    let originalProtos;
    let originalSupport;
    let originalConsoleError;
    let originalConsoleLog;
    let originalDateNow;

    test.beforeEach(() => {
        delete require.cache[WORKER_PATH];
        delete require.cache[WORKER_HISTORY_PATH];
        delete require.cache[RECENT_SHARE_WINDOW_PATH];
        originalConfig = global.config;
        originalDatabase = global.database;
        originalMysql = global.mysql;
        originalProtos = global.protos;
        originalSupport = global.support;
        originalConsoleError = console.error;
        originalConsoleLog = console.log;
        originalDateNow = Date.now;
        console.error = function () {};
        console.log = function () {};
    });

    test.afterEach(() => {
        global.config = originalConfig;
        global.database = originalDatabase;
        global.mysql = originalMysql;
        global.protos = originalProtos;
        global.support = originalSupport;
        console.error = originalConsoleError;
        console.log = originalConsoleLog;
        Date.now = originalDateNow;
        delete global.__workerAutostart;
        delete require.cache[WORKER_PATH];
        delete require.cache[WORKER_HISTORY_PATH];
        delete require.cache[RECENT_SHARE_WINDOW_PATH];
    });

    test("worker histories import legacy points and continue in v2 format", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        const workerName = "rigA";
        const workerKey = address + "_" + workerName;
        const historyKey = "history:" + workerKey;
        const state = createFakeEnvironment({
            cacheEntries: [
                [historyKey, JSON.stringify({
                    hashHistory: [
                        { ts: now - 5 * 60 * 1000, hs: 11, hs2: 5 },
                        { ts: now - 7 * 60 * 1000, hs: 9, hs2: 4 }
                    ]
                })]
            ],
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: workerName,
                        rawShares: 600,
                        shares2: 300,
                        timestamp: now - 30 * 1000
                    })
                },
                {
                    height: 0,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "old",
                        rawShares: 1,
                        shares2: 0,
                        timestamp: now - 3 * 60 * 60 * 1000
                    })
                }
            ]
        });
        const worker = loadWorker();
        const workerHistory = loadWorkerHistory();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        const storedHistory = JSON.parse(state.cacheStore.get(historyKey));
        assert.equal(storedHistory.v, workerHistory.HISTORY_VERSION);
        assert.equal(storedHistory.kind, workerHistory.HISTORY_KIND);
        assert.equal(storedHistory.encoding, workerHistory.HISTORY_ENCODING);
        assert.equal(Array.isArray(storedHistory.tiers), true);
        assert.equal(typeof storedHistory.tiers[0].data, "string");
        assert.equal("points" in storedHistory.tiers[0], false);

        const decoded = workerHistory.toHashHistory(storedHistory);
        assert.ok(decoded.length >= 3);
        assert.equal(decoded.some(function (point) { return point.ts === toStoredTimestamp(now - 5 * 60 * 1000); }), true);
        assert.equal(decoded.some(function (point) { return point.ts === toStoredTimestamp(now - 7 * 60 * 1000); }), true);
        assert.ok(decoded[0].hs > 0);
    });

    test("account histories import legacy points and continue in v2 format", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        const historyKey = "history:" + address;
        const state = createFakeEnvironment({
            cacheEntries: [
                [historyKey, JSON.stringify({
                    hashHistory: [
                        { ts: now - 11 * 60 * 1000, hs: 17, hs2: 8 },
                        { ts: now - 13 * 60 * 1000, hs: 13, hs2: 6 }
                    ]
                })]
            ],
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "rigA",
                        rawShares: 1200,
                        shares2: 600,
                        timestamp: now - 20 * 1000
                    })
                },
                {
                    height: 0,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "old",
                        rawShares: 1,
                        shares2: 0,
                        timestamp: now - 3 * 60 * 60 * 1000
                    })
                }
            ]
        });
        const worker = loadWorker();
        const workerHistory = loadWorkerHistory();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        const storedHistory = JSON.parse(state.cacheStore.get(historyKey));
        assert.equal(storedHistory.v, workerHistory.HISTORY_VERSION);
        assert.equal(storedHistory.kind, workerHistory.HISTORY_KIND);
        assert.equal(storedHistory.encoding, workerHistory.HISTORY_ENCODING);
        assert.equal(Array.isArray(storedHistory.tiers), true);
        assert.equal(typeof storedHistory.tiers[0].data, "string");
        assert.equal("points" in storedHistory.tiers[0], false);

        const decoded = workerHistory.toHashHistory(storedHistory);
        assert.ok(decoded.length >= 3);
        assert.equal(decoded.some(function (point) { return point.ts === toStoredTimestamp(now - 11 * 60 * 1000); }), true);
        assert.equal(decoded.some(function (point) { return point.ts === toStoredTimestamp(now - 13 * 60 * 1000); }), true);
        assert.ok(decoded[0].hs > 0);
    });

    test("text v2 histories are imported and rewritten in binary form", () => {
        const workerHistory = loadWorkerHistory();
        const layout = workerHistory.buildTierLayout(9, 1);
        const now = Date.now();
        const oldPointTs = now - 6 * 60 * 1000;
        const newerPointTs = now - 4 * 60 * 1000;
        const stalePointTs = now - 60 * 60 * 1000;
        const appendedTs = now;

        const textPayload = {
            v: workerHistory.HISTORY_VERSION,
            kind: workerHistory.HISTORY_KIND,
            baseIntervalSec: layout.baseIntervalSec,
            tierRatio: layout.tierRatio,
            capacities: layout.capacities.slice(),
            tiers: layout.capacities.map(function (capacity, index) {
                if (index !== 0) return { head: 0, size: 0, points: [] };
                assert.equal(capacity, 3);
                return {
                    head: 1,
                    size: 2,
                    points: [
                        stalePointTs, 1, 1,
                        oldPointTs, 11, 5,
                        newerPointTs, 13, 6
                    ]
                };
            })
        };

        const storedHistory = workerHistory.appendHistorySample(textPayload, layout, {
            ts: appendedTs,
            hs: 17,
            hs2: 8
        });

        assert.equal(storedHistory.encoding, workerHistory.HISTORY_ENCODING);
        assert.equal(typeof storedHistory.tiers[0].data, "string");
        assert.equal("points" in storedHistory.tiers[0], false);

        const decoded = workerHistory.toHashHistory(storedHistory);
        assert.equal(decoded.length, 3);
        assert.equal(decoded[0].ts, toStoredTimestamp(appendedTs));
        assert.equal(decoded[1].ts, toStoredTimestamp(newerPointTs));
        assert.equal(decoded[2].ts, toStoredTimestamp(oldPointTs));
    });

    test("recent share window builds aligned slot updates and resets stale ring payloads", () => {
        const recentShareWindow = loadRecentShareWindow();
        const baseTime = 1710000000000;
        const address = "4".repeat(95);
        const shares = [
            createShare({
                paymentAddress: address,
                identifier: "rigA",
                rawShares: 400,
                shares2: 200,
                timestamp: baseTime + 5 * 1000
            }),
            createShare({
                paymentAddress: address,
                identifier: "rigA",
                rawShares: 600,
                shares2: 300,
                timestamp: baseTime + 15 * 1000
            }),
            createShare({
                paymentAddress: address,
                identifier: "rigB",
                rawShares: 700,
                shares2: 0,
                timestamp: baseTime + recentShareWindow.SLOT_INTERVAL_MS + 1
            })
        ];

        const updates = recentShareWindow.buildSlotUpdates(shares, {
            defaultPort: 18081,
            pplnsPoolType: 0
        });
        const firstSlotId = recentShareWindow.getSlotId(baseTime + 5 * 1000);
        const secondSlotId = recentShareWindow.getSlotId(baseTime + recentShareWindow.SLOT_INTERVAL_MS + 1);
        const firstSlot = updates.get(firstSlotId);
        const secondSlot = updates.get(secondSlotId);

        assert.equal(updates.size, 2);
        assert.equal(firstSlot.globalShares2, 500);
        assert.equal(firstSlot.miners[address][0], 1000);
        assert.equal(firstSlot.miners[address][1], 500);
        assert.equal(firstSlot.miners[address + "_rigA"][0], 1000);
        assert.equal(firstSlot.identifiers[address].rigA, 1);
        assert.equal(firstSlot.portHashes["18081"], 1000);
        assert.equal(secondSlot.globalShares2, 0);
        assert.equal(secondSlot.identifiers[address].rigB, 1);

        const staleRingPayload = JSON.parse(JSON.stringify(firstSlot));
        staleRingPayload.slot = firstSlotId - recentShareWindow.SLOT_RING_SIZE;
        const writable = recentShareWindow.getWritableSlotPayload(staleRingPayload, firstSlotId);
        assert.equal(writable.slot, firstSlotId);
        assert.deepEqual(Object.keys(writable.miners), []);
    });

    test("worker histories are written on each history cycle without the old ten minute gate", async () => {
        const now = 1710000000000;
        let fakeNow = now;
        Date.now = function () { return fakeNow; };
        const address = "4".repeat(95);
        const workerName = "rigB";
        const workerKey = address + "_" + workerName;
        const historyKey = "history:" + workerKey;
        const shares = [
            {
                height: 1,
                share: createShare({
                    paymentAddress: address,
                    identifier: workerName,
                    rawShares: 600,
                    shares2: 300,
                    timestamp: now - 30 * 1000
                })
            },
            {
                height: 0,
                share: createShare({
                    paymentAddress: address,
                    identifier: "old",
                    rawShares: 1,
                    shares2: 0,
                    timestamp: now - 3 * 60 * 60 * 1000
                })
            }
        ];
        createFakeEnvironment({ shares: shares });
        const worker = loadWorker();
        const workerHistory = loadWorkerHistory();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        let decoded = workerHistory.toHashHistory(JSON.parse(global.database.env.beginTxn({ readOnly: true }).getString(global.database.cacheDB, historyKey)));
        assert.equal(decoded.length, 1);

        fakeNow = now + 60 * 1000;
        shares[0].share.raw_shares = 1200;
        shares[0].share.shares2 = 900;
        shares[0].share.timestamp = fakeNow - 10 * 1000;
        await runUpdate(runtime, 1);
        decoded = workerHistory.toHashHistory(JSON.parse(global.database.env.beginTxn({ readOnly: true }).getString(global.database.cacheDB, historyKey)));
        assert.equal(decoded.length, 1);

        fakeNow = now + 120 * 1000;
        shares[0].share.raw_shares = 1800;
        shares[0].share.shares2 = 1200;
        shares[0].share.timestamp = fakeNow - 10 * 1000;
        await runUpdate(runtime, 1);

        decoded = workerHistory.toHashHistory(JSON.parse(global.database.env.beginTxn({ readOnly: true }).getString(global.database.cacheDB, historyKey)));
        assert.equal(decoded.length, 2);
        assert.ok(decoded[0].hs > decoded[1].hs);
    });

    test("worker merges cached recent-window slots with exact tail rescan", async () => {
        const recentShareWindow = loadRecentShareWindow();
        const now = recentShareWindow.alignTimestampToSlot(1710002400000) + 1234;
        let fakeNow = now;
        Date.now = function () { return fakeNow; };
        const bounds = recentShareWindow.getHybridWindowBounds(fakeNow);
        const address = "4".repeat(95);
        const workerName = "rigHybrid";
        const tailShare = createShare({
            paymentAddress: address,
            identifier: workerName,
            rawShares: 1200,
            shares2: 900,
            timestamp: bounds.tailStart + 15 * 1000
        });
        const olderWindowShare = createShare({
            paymentAddress: address,
            identifier: workerName,
            rawShares: 600,
            shares2: 300,
            timestamp: bounds.tailStart - recentShareWindow.SLOT_INTERVAL_MS
        });
        const slotUpdates = recentShareWindow.buildSlotUpdates([olderWindowShare], {
            defaultPort: 18081,
            pplnsPoolType: 0
        });
        const slotId = recentShareWindow.getSlotId(olderWindowShare.timestamp);
        const slotKey = recentShareWindow.getSlotCacheKey(slotId);
        const stopShare = createShare({
            paymentAddress: address,
            identifier: "old",
            rawShares: 1,
            shares2: 0,
            timestamp: bounds.tailStart - 3 * 60 * 60 * 1000
        });

        const state = createFakeEnvironment({
            cacheEntries: [[slotKey, JSON.stringify(slotUpdates.get(slotId))]],
            shares: [
                { height: 1, share: tailShare },
                { height: 0, share: stopShare }
            ]
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        const workerStats = JSON.parse(state.cacheStore.get("stats:" + address + "_" + workerName));
        const addressStats = JSON.parse(state.cacheStore.get("stats:" + address));
        const identifiers = JSON.parse(state.cacheStore.get("identifiers:" + address));

        assert.equal(workerStats.hash, (600 + 1200) / (10 * 60));
        assert.equal(workerStats.hash2, (300 + 900) / (10 * 60));
        assert.equal(addressStats.hash, (600 + 1200) / (10 * 60));
        assert.equal(addressStats.hash2, (300 + 900) / (10 * 60));
        assert.deepEqual(identifiers, [workerName]);
    });

    test("worker cache writes flush in batches for large history updates", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        const shares = [];

        for (let index = 0; index < 260; ++index) {
            shares.push({
                height: 1,
                share: createShare({
                    paymentAddress: address,
                    identifier: "rig" + index,
                    rawShares: 600 + index,
                    shares2: 300 + index,
                    timestamp: now - 30 * 1000
                })
            });
        }

        shares.push({
            height: 0,
            share: createShare({
                paymentAddress: address,
                identifier: "old",
                rawShares: 1,
                shares2: 0,
                timestamp: now - 3 * 60 * 60 * 1000
            })
        });

        const state = createFakeEnvironment({ shares: shares, statsBufferLength: 27, statsBufferHours: 4 });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        assert.ok(state.env.writeCommits >= 4);
        assert.equal(state.cacheStore.has("stats:" + address + "_rig0"), true);
        assert.equal(state.cacheStore.has("history:" + address + "_rig0"), true);

        const flattenedOps = state.env.commits.flat();
        const markerPuts = flattenedOps.filter(function (entry) {
            return entry[0] === "putString" && entry[2] === "cacheUpdate";
        }).length;
        const markerDeletes = flattenedOps.filter(function (entry) {
            return entry[0] === "del" && entry[2] === "cacheUpdate";
        }).length;

        assert.equal(markerPuts, 1);
        assert.equal(markerDeletes, 1);
    });

    test("worker preserves an existing cacheUpdate marker while flushing batches", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        const shares = [];

        for (let index = 0; index < 260; ++index) {
            shares.push({
                height: 1,
                share: createShare({
                    paymentAddress: address,
                    identifier: "rig" + index,
                    rawShares: 600 + index,
                    shares2: 300 + index,
                    timestamp: now - 30 * 1000
                })
            });
        }

        shares.push({
            height: 0,
            share: createShare({
                paymentAddress: address,
                identifier: "old",
                rawShares: 1,
                shares2: 0,
                timestamp: now - 3 * 60 * 60 * 1000
            })
        });

        const state = createFakeEnvironment({
            cacheEntries: [["cacheUpdate", "1"]],
            shares: shares,
            statsBufferLength: 27,
            statsBufferHours: 4
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        assert.equal(state.cacheStore.get("cacheUpdate"), "1");

        const flattenedOps = state.env.commits.flat();
        const markerWrites = flattenedOps.filter(function (entry) {
            return entry[0] === "putString" && entry[2] === "cacheUpdate";
        }).map(function (entry) {
            return entry[3];
        });
        const markerDeletes = flattenedOps.filter(function (entry) {
            return entry[0] === "del" && entry[2] === "cacheUpdate";
        }).length;

        assert.deepEqual(markerWrites.slice(-2), ["2", "1"]);
        assert.equal(markerDeletes, 0);
    });

    test("worker runtime reuses cached history layout when config is unchanged", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "rigA",
                        rawShares: 800,
                        shares2: 400,
                        timestamp: now - 15 * 1000
                    })
                },
                {
                    height: 0,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "old",
                        rawShares: 1,
                        shares2: 0,
                        timestamp: now - 3 * 60 * 60 * 1000
                    })
                }
            ],
            statsBufferLength: 27,
            statsBufferHours: 4
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        const firstLayout = runtime.state.historyLayoutCache.layout;

        await runUpdate(runtime, 1);

        assert.strictEqual(runtime.state.historyLayoutCache.layout, firstLayout);
    });

    test("worker logs history tiers only on the first cycle", async () => {
        const now = 1710000000000;
        let fakeNow = now;
        const logs = [];
        Date.now = function () { return fakeNow; };
        console.log = function (message) {
            logs.push(message);
        };

        const address = "4".repeat(95);
        createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "rigA",
                        rawShares: 800,
                        shares2: 400,
                        timestamp: now - 15 * 1000
                    })
                },
                {
                    height: 0,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "old",
                        rawShares: 1,
                        shares2: 0,
                        timestamp: now - 3 * 60 * 60 * 1000
                    })
                }
            ],
            statsBufferLength: 27,
            statsBufferHours: 4
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        fakeNow += 20 * 1000;
        await runUpdate(runtime, 1);

        const startLogs = logs.filter(function (message) {
            return message.indexOf("Starting stats collection for ") === 0;
        });
        const tierLogs = startLogs.filter(function (message) {
            return message.indexOf("history tiers: ") >= 0;
        });

        assert.equal(startLogs.length, 2);
        assert.equal(tierLogs.length, 1);
    });

    test("worker history tier layout honors both statsBufferLength and statsBufferHours", () => {
        const workerHistory = loadWorkerHistory();
        const layout = workerHistory.buildTierLayout(1001, 72);
        const coverage = layout.capacities.reduce(function (sum, capacity, index) {
            return sum + capacity * layout.intervalsSec[index];
        }, 0);

        assert.equal(layout.maxPoints, 1001);
        assert.ok(coverage >= 72 * 60 * 60);
        assert.equal(layout.capacities.reduce(function (sum, capacity) { return sum + capacity; }, 0), 1001);
    });
});
