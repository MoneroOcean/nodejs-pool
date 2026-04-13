"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const POOL_STATS_PATH = require.resolve("../lib/pool_stats.js");

function clone(value) {
    if (typeof value === "undefined") return value;
    return JSON.parse(JSON.stringify(value));
}

function loadPoolStats() {
    const previousAutostart = global.__poolStatsAutostart;
    global.__poolStatsAutostart = false;
    delete require.cache[POOL_STATS_PATH];

    try {
        return require(POOL_STATS_PATH);
    } finally {
        if (typeof previousAutostart === "undefined") delete global.__poolStatsAutostart;
        else global.__poolStatsAutostart = previousAutostart;
    }
}

function createTestEnvironment(options = {}) {
    const blockDB = { name: "blocks" };
    const altblockDB = { name: "altblocks" };
    const stores = new Map([
        [blockDB, new Map(options.blocks || [])],
        [altblockDB, new Map(options.altblocks || [])]
    ]);
    const caches = new Map(Object.entries(clone(options.caches || {})));
    const cacheWrites = [];
    const mysqlQueries = [];
    const readCounts = { blocks: 0, altblocks: 0 };

    function sortEntries(entries) {
        return Array.from(entries).sort(function (left, right) {
            return left[0] - right[0];
        });
    }

    class Cursor {
        constructor(_txn, db) {
            this.db = db;
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

        getCurrentBinary(callback) {
            readCounts[this.db.name] += 1;
            callback(this.entries[this.index][0], this.entries[this.index][1]);
        }

        close() {}
    }

    global.config = {
        coin: { name: "Monero" },
        daemon: {
            port: 18000,
            enableAlgoSwitching: true
        },
        general: {
            cmcKey: "test-key",
            adminEmail: "admin@example.com"
        },
        pool: {
            geoDNS: "pool.example.com"
        }
    };
    global.database = {
        env: {
            beginTxn() {
                return {
                    abort() {},
                    commit() {}
                };
            }
        },
        lmdb: { Cursor },
        blockDB,
        altblockDB,
        getCache(key) {
            return caches.has(key) ? clone(caches.get(key)) : false;
        },
        setCache(key, value) {
            const entry = clone(value);
            caches.set(key, entry);
            cacheWrites.push({ key, value: entry });
        }
    };
    global.mysql = {
        query(sql, params) {
            mysqlQueries.push({ sql, params });
            return Promise.resolve(options.mysqlQuery ? options.mysqlQuery(sql, params) : []);
        }
    };
    global.protos = {
        POOLTYPE: {
            PPLNS: 0,
            PPS: 1,
            SOLO: 3
        },
        Block: {
            decode(value) {
                return value;
            }
        },
        AltBlock: {
            decode(value) {
                return value;
            }
        }
    };
    global.support = {
        coinToDecimal(value) {
            return value;
        },
        https_get(url, callback) {
            const symbol = new URL(url).searchParams.get("convert");
            const price = options.prices && symbol in options.prices ? options.prices[symbol] : 0;
            callback({
                data: {
                    monero: {
                        quote: {
                            [symbol]: { price }
                        }
                    }
                }
            });
        },
        formatDateFromSQL(value) {
            return "formatted:" + value;
        },
        rpcPortDaemon(_port, _method, _params, callback) {
            callback({ result: { difficulty: 111 } });
        },
        sendEmail() {}
    };
    global.coinFuncs = {
        getPORTS() {
            return [18000, 18081];
        },
        algoShortTypeStr(port) {
            return port === 18000 ? "rx/0" : "kawpow";
        },
        getPortLastBlockHeaderWithRewardDiff(_port, callback) {
            callback(null, {
                difficulty: 100,
                hash: "aa",
                height: 10,
                reward: 2,
                timestamp: 1234
            });
        },
        getPortLastBlockHeader(_port, callback) {
            callback(null, { height: 10 });
        },
        fixDaemonIssue() {}
    };

    return {
        blockStore: stores.get(blockDB),
        altblockStore: stores.get(altblockDB),
        caches,
        cacheWrites,
        mysqlQueries,
        readCounts,
        resetReadCounts() {
            readCounts.blocks = 0;
            readCounts.altblocks = 0;
        }
    };
}

test.describe("pool_stats", { concurrency: false }, () => {
let originalConsoleLog;
let originalConsoleError;
let originalSetInterval;
let originalConfig;
let originalDatabase;
let originalMysql;
let originalProtos;
let originalSupport;
let originalCoinFuncs;

test.beforeEach(() => {
    delete require.cache[POOL_STATS_PATH];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalSetInterval = global.setInterval;
    originalConfig = global.config;
    originalDatabase = global.database;
    originalMysql = global.mysql;
    originalProtos = global.protos;
    originalSupport = global.support;
    originalCoinFuncs = global.coinFuncs;
});

test.afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    global.setInterval = originalSetInterval;
    global.config = originalConfig;
    global.database = originalDatabase;
    global.mysql = originalMysql;
    global.protos = originalProtos;
    global.support = originalSupport;
    global.coinFuncs = originalCoinFuncs;
    delete global.__poolStatsAutostart;
    delete require.cache[POOL_STATS_PATH];
});

test("module loads for tests without lmdb or real pool state", () => {
    const poolStats = loadPoolStats();

    assert.equal(typeof poolStats.refreshPoolStats, "function");
    assert.equal(typeof poolStats.startPoolStats, "function");
});

test("refreshPoolStats writes lean global and pplns stats without pps or solo branches", async () => {
    const state = createTestEnvironment({
        caches: {
            global_stats: { hash: 111, minerCount: 5 },
            global_stats2: { totalHashes: 1000, roundHashes: 200 },
            pplns_stats: { hash: 99, minerCount: 4 },
            pplns_stats2: { totalHashes: 900, roundHashes: 180 },
            global_stats2_18081: { roundHashes: 33 },
            min_block_rewards: { 18081: 2, 18082: 3 },
            active_ports: [18081],
            xmr_profit: { value: 1.25 },
            coin_xmr_profit: { 18081: 0.5 },
            coin_comment: { 18081: "stable" },
            pplns_port_shares: { 18081: 44 },
            pplns_window_time: 600,
            port_hash: { 18081: 77 },
            portMinerCount: { 18081: 2 }
        },
        blocks: [
            [110, { hash: "pplns-block", timestamp: 4000, poolType: 0, valid: true, unlocked: false, value: 5 }],
            [120, { hash: "pps-block", timestamp: 5000, poolType: 1, valid: true, unlocked: false, value: 7 }]
        ],
        altblocks: [
            [210, { hash: "pplns-alt", timestamp: 6000, poolType: 0, valid: true, unlocked: false, port: 18081 }],
            [220, { hash: "pps-alt", timestamp: 7000, poolType: 1, valid: true, unlocked: false, port: 18082 }]
        ],
        prices: {
            USD: 150,
            EUR: 140,
            BTC: 0.005
        },
        mysqlQuery(sql, params) {
            if (sql === "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments GROUP BY payment_address, payment_id) as miners") {
                return [{ miner_count: 3 }];
            }
            if (
                sql === "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments WHERE pool_type = ? GROUP BY payment_address, payment_id) as miners" &&
                params[0] === "pplns"
            ) {
                return [{ miner_count: 2 }];
            }
            if (sql === "SELECT count(id) as txn_count FROM transactions") {
                return [{ txn_count: 9 }];
            }
            if (sql === "SELECT count(distinct transaction_id) as txn_count FROM payments WHERE pool_type = ?" && params[0] === "pplns") {
                return [{ txn_count: 4 }];
            }
            throw new Error("Unexpected SQL: " + sql);
        }
    });
    const poolStats = loadPoolStats();
    const logs = [];

    console.log = function (message) {
        logs.push(message);
    };

    const result = await poolStats.refreshPoolStats();

    assert.equal(result.global.totalBlocksFound, 2);
    assert.equal(result.global.totalAltBlocksFound, 2);
    assert.deepEqual(result.global.altBlocksFound, { 18081: 1, 18082: 1 });
    assert.equal(result.global.pending, 17);
    assert.equal(result.global.totalMinersPaid, 3);
    assert.equal(result.global.totalPayments, 9);
    assert.equal(result.global.lastBlockFound, 120);
    assert.equal(result.global.lastBlockFoundTime, 7);
    assert.deepEqual(result.global.price, { btc: 0.005, usd: 150, eur: 140 });
    assert.equal(result.global.currentEfforts[18000], 200);
    assert.equal(result.global.currentEfforts[18081], 33);
    assert.equal(result.global.portCoinAlgo[18081], "kawpow");
    assert.equal(typeof result.global.updatedAt, "number");

    assert.equal(result.pplns.totalBlocksFound, 1);
    assert.equal(result.pplns.totalAltBlocksFound, 1);
    assert.deepEqual(result.pplns.altBlocksFound, { 18081: 1 });
    assert.equal(result.pplns.pending, 7);
    assert.equal(result.pplns.totalMinersPaid, 2);
    assert.equal(result.pplns.totalPayments, 4);
    assert.equal(result.pplns.lastBlockFound, 110);
    assert.equal(result.pplns.lastBlockFoundTime, 6);

    assert.deepEqual(logs, [poolStats.buildStatsStatusLine(result.global)]);
    assert.deepEqual(
        state.cacheWrites.map(function (entry) { return entry.key; }).sort(),
        ["pool_stats_global", "pool_stats_pplns"]
    );
    assert.equal(
        state.mysqlQueries.some(function (entry) {
            return Array.isArray(entry.params) && (entry.params[0] === "pps" || entry.params[0] === "solo");
        }),
        false
    );
});

test("refreshPoolInformation keeps pool port output focused on pplns", async () => {
    const state = createTestEnvironment({
        mysqlQuery(sql) {
            if (sql === "select * from pools where id < 1000 and last_checkin >= NOW() - INTERVAL 10 MINUTE") {
                return [
                    { id: 1, ip: "10.0.0.1", blockID: 100, blockIDTime: "2026-01-01 00:00:00", hostname: "node-a" },
                    { id: 2, ip: "10.0.0.2", blockID: 101, blockIDTime: "2026-01-01 00:01:00", hostname: "node-b" }
                ];
            }
            if (sql === "select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE") {
                return [
                    { pool_id: 1, port_type: "pplns", network_port: 3333, starting_diff: 1000, description: "Main", miners: 2 },
                    { pool_id: 2, port_type: "pplns", network_port: 3333, starting_diff: 1000, description: "Main", miners: 3 },
                    { pool_id: 1, port_type: "solo", network_port: 4444, starting_diff: 2000, description: "Solo", miners: 1 }
                ];
            }
            throw new Error("Unexpected SQL: " + sql);
        }
    });
    const poolStats = loadPoolStats();

    await poolStats.refreshPoolInformation();

    assert.deepEqual(state.caches.get("poolServers"), {
        1: {
            ip: "10.0.0.1",
            blockID: 100,
            blockIDTime: "formatted:2026-01-01 00:00:00",
            hostname: "node-a"
        },
        2: {
            ip: "10.0.0.2",
            blockID: 101,
            blockIDTime: "formatted:2026-01-01 00:01:00",
            hostname: "node-b"
        }
    });
    assert.deepEqual(state.caches.get("poolPorts"), {
        global: [
            {
                host: {
                    blockID: 100,
                    blockIDTime: "formatted:2026-01-01 00:00:00",
                    hostname: "pool.example.com"
                },
                port: 3333,
                pool_type: "pplns",
                difficulty: 1000,
                miners: 5,
                description: "Main"
            }
        ],
        pplns: [
            {
                host: {
                    ip: "10.0.0.1",
                    blockID: 100,
                    blockIDTime: "formatted:2026-01-01 00:00:00",
                    hostname: "node-a"
                },
                port: 3333,
                difficulty: 1000,
                description: "Main",
                miners: 2
            },
            {
                host: {
                    ip: "10.0.0.2",
                    blockID: 101,
                    blockIDTime: "formatted:2026-01-01 00:01:00",
                    hostname: "node-b"
                },
                port: 3333,
                difficulty: 1000,
                description: "Main",
                miners: 3
            }
        ]
    });
});

test("second stats refresh reuses tiny history caches and avoids full DB rescans", async () => {
    const blocks = [];
    const altblocks = [];

    for (let i = 1; i <= 1500; ++i) {
        blocks.push([i, { hash: "block-" + i, timestamp: i * 1000, poolType: 0, valid: true, unlocked: false, value: 1 }]);
    }
    for (let i = 1; i <= 12050; ++i) {
        altblocks.push([i, { hash: "alt-" + i, timestamp: i * 1000, poolType: 0, valid: true, unlocked: false, port: 18081 }]);
    }

    const state = createTestEnvironment({
        caches: {
            global_stats: { hash: 10, minerCount: 2 },
            global_stats2: { totalHashes: 100, roundHashes: 50 },
            pplns_stats: { hash: 10, minerCount: 2 },
            pplns_stats2: { totalHashes: 100, roundHashes: 50 },
            global_stats2_18081: { roundHashes: 25 },
            min_block_rewards: { 18081: 2 }
        },
        blocks,
        altblocks,
        prices: {
            USD: 1,
            EUR: 1,
            BTC: 1
        },
        mysqlQuery(sql, params) {
            if (sql === "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments GROUP BY payment_address, payment_id) as miners") {
                return [{ miner_count: 0 }];
            }
            if (
                sql === "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments WHERE pool_type = ? GROUP BY payment_address, payment_id) as miners" &&
                params[0] === "pplns"
            ) {
                return [{ miner_count: 0 }];
            }
            if (sql === "SELECT count(id) as txn_count FROM transactions") return [{ txn_count: 0 }];
            if (sql === "SELECT count(distinct transaction_id) as txn_count FROM payments WHERE pool_type = ?" && params[0] === "pplns") {
                return [{ txn_count: 0 }];
            }
            throw new Error("Unexpected SQL: " + sql);
        }
    });
    const poolStats = loadPoolStats();

    console.log = function () {};

    await poolStats.refreshPoolStats();
    const firstReads = { blocks: state.readCounts.blocks, altblocks: state.readCounts.altblocks };

    state.resetReadCounts();
    await poolStats.refreshPoolStats();

    assert.equal(state.readCounts.blocks, 1001);
    assert.equal(state.readCounts.altblocks, 10001);
    assert.equal(state.readCounts.blocks < firstReads.blocks, true);
    assert.equal(state.readCounts.altblocks < firstReads.altblocks, true);
});
});
