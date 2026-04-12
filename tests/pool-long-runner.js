"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const LONG_RUNNER_PATH = require.resolve("../lib/longRunner.js");

function loadLongRunner() {
    const previousAutostart = global.__longRunnerAutostart;
    global.__longRunnerAutostart = false;
    delete require.cache[LONG_RUNNER_PATH];

    try {
        return require(LONG_RUNNER_PATH);
    } finally {
        if (typeof previousAutostart === "undefined") delete global.__longRunnerAutostart;
        else global.__longRunnerAutostart = previousAutostart;
    }
}

function createFakeEnvironment(options = {}) {
    const cacheDB = { name: "cache" };
    const altblockDB = { name: "altblock" };
    const stores = new Map([
        [cacheDB, new Map(options.cacheEntries || [])],
        [altblockDB, new Map(options.altblockEntries || [])]
    ]);

    function sortEntries(entries) {
        return Array.from(entries).sort(function (left, right) {
            const leftKey = left[0];
            const rightKey = right[0];
            if (typeof leftKey === "number" && typeof rightKey === "number") return leftKey - rightKey;
            return String(leftKey).localeCompare(String(rightKey));
        });
    }

    class Cursor {
        constructor(_txn, db) {
            this.entries = sortEntries(stores.get(db).entries());
            this.index = -1;
        }

        goToFirst() {
            this.index = this.entries.length ? 0 : -1;
            return this.index === -1 ? null : this.entries[this.index][0];
        }

        goToNext() {
            if (this.index === -1 || this.index + 1 >= this.entries.length) {
                this.index = -1;
                return null;
            }
            this.index += 1;
            return this.entries[this.index][0];
        }

        goToLast() {
            this.index = this.entries.length ? this.entries.length - 1 : -1;
            return this.index === -1 ? null : this.entries[this.index][0];
        }

        goToPrev() {
            if (this.index <= 0) {
                this.index = -1;
                return null;
            }
            this.index -= 1;
            return this.entries[this.index][0];
        }

        getCurrentString(callback) {
            callback(this.entries[this.index][0], this.entries[this.index][1]);
        }

        getCurrentBinary(callback) {
            callback(this.entries[this.index][0], this.entries[this.index][1]);
        }

        close() {}
    }

    const env = {
        writeCommits: 0,
        beginTxn(options = {}) {
            const operations = [];
            const readOnly = !!options.readOnly;

            return {
                del(db, key) {
                    operations.push(["del", db, key]);
                },
                putString(db, key, value) {
                    operations.push(["putString", db, key, value]);
                },
                commit() {
                    if (readOnly) return;

                    operations.forEach(function (entry) {
                        const store = stores.get(entry[1]);
                        if (entry[0] === "del") {
                            store.delete(entry[2]);
                            return;
                        }
                        store.set(entry[2], entry[3]);
                    });
                    env.writeCommits += 1;
                },
                abort() {}
            };
        }
    };

    let cleanShareCalls = 0;
    const mysqlCalls = [];
    global.config = {
        pool: {
            address: "4".repeat(options.addressLength || 95)
        }
    };
    global.database = {
        env,
        lmdb: { Cursor },
        cacheDB,
        altblockDB,
        getCache(key) {
            const raw = stores.get(cacheDB).get(key);
            return typeof raw === "undefined" ? false : JSON.parse(raw);
        },
        getValidLockedBlocks() {
            return (options.lockedBlocks || []).slice();
        },
        getValidLockedAltBlocks() {
            return (options.lockedAltBlocks || []).slice();
        },
        cleanShareDB() {
            cleanShareCalls += 1;
        }
    };
    global.protos = {
        AltBlock: {
            decode(value) {
                return value;
            }
        }
    };
    global.mysql = {
        query(sql, params) {
            mysqlCalls.push({ sql, params });
            if (typeof options.mysqlQuery === "function") {
                return Promise.resolve(options.mysqlQuery(sql, params, mysqlCalls));
            }
            return Promise.resolve([]);
        }
    };

    return {
        cacheStore: stores.get(cacheDB),
        altblockStore: stores.get(altblockDB),
        env,
        mysqlCalls,
        getCleanShareCalls() {
            return cleanShareCalls;
        }
    };
}

test.describe("longRunner", { concurrency: false }, () => {
let originalConsoleError;
let originalConsoleLog;
let originalSetInterval;
let originalDatabase;
let originalMysql;
let originalConfig;
let originalProtos;

test.beforeEach(() => {
    delete require.cache[LONG_RUNNER_PATH];
    originalConsoleError = console.error;
    originalConsoleLog = console.log;
    originalSetInterval = global.setInterval;
    originalDatabase = global.database;
    originalMysql = global.mysql;
    originalConfig = global.config;
    originalProtos = global.protos;
});

test.afterEach(() => {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    global.setInterval = originalSetInterval;
    global.database = originalDatabase;
    global.mysql = originalMysql;
    global.config = originalConfig;
    global.protos = originalProtos;
    delete global.__longRunnerAutostart;
    delete require.cache[LONG_RUNNER_PATH];
});

test("cleanCacheDB prunes stale workers, freezes dead account stats, and ignores malformed cache rows", () => {
    const now = Date.now();
    const address = "4".repeat(95);
    const state = createFakeEnvironment({
        cacheEntries: [
            ["identifiers:" + address, JSON.stringify(["rigA", "rigB"])],
            ["stats:" + address + "_rigA", JSON.stringify({ lastHash: now - 2 * 24 * 60 * 60 * 1000 })],
            ["stats:" + address + "_rigB", JSON.stringify({ lastHash: now - 2 * 24 * 60 * 60 * 1000 })],
            ["identifiers:" + address + "-broken", "{not-json"],
            ["stats:" + address, JSON.stringify({ hash: 10, hash2: 5, lastHash: now - 2 * 24 * 60 * 60 * 1000, other: 9 })],
            [address + "_oldworker", JSON.stringify({ value: 1 })],
            ["history:" + address + "_oldworker", JSON.stringify({ hashHistory: [1] })],
            ["stats:" + address + "_oldworker", JSON.stringify({ lastHash: now - 8 * 24 * 60 * 60 * 1000 })],
            [address + "_missingHistory", JSON.stringify({ value: 2 })],
            ["stats:" + address + "_missingHistory", JSON.stringify({ lastHash: now })],
            [address + "_missingStats", JSON.stringify({ value: 3 })],
            ["history:" + address + "_missingStats", JSON.stringify({ hashHistory: [2] })],
            [address + "_fresh", JSON.stringify({ value: 4 })],
            ["history:" + address + "_fresh", JSON.stringify({ hashHistory: [3] })],
            ["stats:" + address + "_fresh", JSON.stringify({ lastHash: now })],
            ["tiny_old", JSON.stringify({ untouched: true })]
        ]
    });
    const longRunner = loadLongRunner();

    longRunner.cleanCacheDB();

    assert.equal(state.cacheStore.get("identifiers:" + address), "[]");
    assert.deepEqual(JSON.parse(state.cacheStore.get("stats:" + address)), {
        hash: 0,
        hash2: 0,
        lastHash: now - 2 * 24 * 60 * 60 * 1000,
        other: 9
    });
    assert.equal(state.cacheStore.has(address + "_oldworker"), false);
    assert.equal(state.cacheStore.has("history:" + address + "_oldworker"), false);
    assert.equal(state.cacheStore.has("stats:" + address + "_oldworker"), false);
    assert.equal(state.cacheStore.has(address + "_missingHistory"), false);
    assert.equal(state.cacheStore.has("stats:" + address + "_missingHistory"), false);
    assert.equal(state.cacheStore.has(address + "_missingStats"), false);
    assert.equal(state.cacheStore.has("history:" + address + "_missingStats"), false);
    assert.equal(state.cacheStore.has(address + "_fresh"), true);
    assert.equal(state.cacheStore.has("history:" + address + "_fresh"), true);
    assert.equal(state.cacheStore.has("stats:" + address + "_fresh"), true);
    assert.equal(state.cacheStore.get("identifiers:" + address + "-broken"), "{not-json");
    assert.equal(state.cacheStore.get("tiny_old"), JSON.stringify({ untouched: true }));
});

test("cleanCacheDB flushes large delete sets in multiple LMDB write transactions", () => {
    const now = Date.now();
    const address = "4".repeat(95);
    const cacheEntries = [];

    for (let i = 0; i < 200; ++i) {
        const worker = address + "_stale" + i;
        cacheEntries.push([worker, JSON.stringify({ value: i })]);
        cacheEntries.push(["history:" + worker, JSON.stringify({ hashHistory: [i] })]);
        cacheEntries.push(["stats:" + worker, JSON.stringify({ lastHash: now - 8 * 24 * 60 * 60 * 1000 })]);
    }

    const state = createFakeEnvironment({ cacheEntries });
    const longRunner = loadLongRunner();

    longRunner.cleanCacheDB();

    assert.ok(state.env.writeCommits >= 2);
    assert.equal(state.cacheStore.size, 0);
});

test("cleanAltBlockDB removes only unlocked overflow or expired rows", () => {
    const now = Date.now();
    const altblockEntries = [];

    for (let i = 1; i <= 10001; ++i) {
        altblockEntries.push([i, { port: 9000, unlocked: true, timestamp: now }]);
    }
    altblockEntries.push([20000, { port: 9001, unlocked: true, timestamp: now - (365 * 24 * 60 * 60 * 1000) - 1 }]);
    altblockEntries.push([30000, { port: 9002, unlocked: false, timestamp: now - (365 * 24 * 60 * 60 * 1000) - 1 }]);

    const state = createFakeEnvironment({ altblockEntries });
    const longRunner = loadLongRunner();

    longRunner.cleanAltBlockDB();

    assert.equal(state.altblockStore.has(1), false);
    assert.equal(state.altblockStore.has(2), true);
    assert.equal(state.altblockStore.has(10001), true);
    assert.equal(state.altblockStore.has(20000), false);
    assert.equal(state.altblockStore.has(30000), true);
});

test("cleanBlockBalanceTable keeps locked and recent hashes and deletes stale rows in SQL batches", async () => {
    const staleHexes = Array.from({ length: 251 }, function (_entry, index) {
        return "stale-" + index;
    });
    const deleteBatches = [];
    createFakeEnvironment({
        lockedBlocks: [{ hash: "keep-locked" }],
        lockedAltBlocks: [{ hash: "keep-alt" }],
        mysqlQuery(sql, params) {
            if (sql.indexOf("SELECT hex FROM paid_blocks") === 0) return [{ hex: "keep-recent" }];
            if (sql.indexOf("SELECT DISTINCT hex FROM block_balance") === 0) {
                return ["keep-locked", "keep-alt", "keep-recent"].concat(staleHexes).map(function (hex) {
                    return { hex };
                });
            }
            if (sql.indexOf("DELETE FROM block_balance") === 0) {
                deleteBatches.push(params[0].slice());
                return { affectedRows: params[0].length };
            }
            throw new Error("Unexpected SQL: " + sql);
        }
    });
    const longRunner = loadLongRunner();

    await longRunner.cleanBlockBalanceTable();

    assert.deepEqual(deleteBatches.map(function (batch) { return batch.length; }), [250, 1]);
    assert.deepEqual(deleteBatches.flat().sort(), staleHexes.slice().sort());
});

test("runTask swallows task failures after logging them", async () => {
    const errors = [];
    console.error = function (message) {
        errors.push(String(message));
    };
    const longRunner = loadLongRunner();

    await longRunner.runTask("boom", async function () {
        throw new Error("fail");
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /LongRunner boom failed:/);
    assert.match(errors[0], /fail/);
});

test("scheduleTask skips overlapping runs and resumes after the active run finishes", async () => {
    let intervalHandler = null;
    let resolveRun = null;
    let runCount = 0;
    const errors = [];

    console.error = function (message) {
        errors.push(String(message));
    };
    global.setInterval = function (handler, intervalMs) {
        intervalHandler = handler;
        assert.equal(intervalMs, 1234);
        return 1;
    };

    const longRunner = loadLongRunner();
    longRunner.scheduleTask("overlap", 1234, async function () {
        runCount += 1;
        await new Promise(function (resolve) {
            resolveRun = resolve;
        });
    });

    intervalHandler();
    intervalHandler();
    assert.equal(runCount, 1);
    assert.equal(errors.some(function (line) { return line.includes("Skipping this cycle."); }), true);

    resolveRun();
    await new Promise(function (resolve) {
        setImmediate(resolve);
    });

    intervalHandler();
    assert.equal(runCount, 2);
});

test("startLongRunner executes all startup tasks once and schedules recurring intervals", async () => {
    const intervals = [];
    const state = createFakeEnvironment({
        mysqlQuery(sql) {
            if (sql.indexOf("SELECT hex FROM paid_blocks") === 0) return [];
            if (sql.indexOf("SELECT DISTINCT hex FROM block_balance") === 0) return [];
            if (sql.indexOf("DELETE FROM block_balance") === 0) return { affectedRows: 0 };
            throw new Error("Unexpected SQL: " + sql);
        }
    });

    global.setInterval = function (handler, intervalMs) {
        intervals.push(intervalMs);
        return { handler, intervalMs };
    };

    const longRunner = loadLongRunner();
    await longRunner.startLongRunner();

    assert.equal(state.getCleanShareCalls(), 1);
    assert.deepEqual(intervals, [
        4 * 60 * 60 * 1000,
        longRunner.DAY_MS,
        7 * longRunner.DAY_MS,
        longRunner.DAY_MS
    ]);
});
});
