"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const POOL_STATS_PATH = require.resolve("../../lib/pool_stats.js");

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
            port: options.daemonPort || 18000,
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
            return options.ports || [18000, 18081];
        },
        algoShortTypeStr(port) {
            return Number(port) === 18000 ? "rx/0" : "kawpow";
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

test.describe("pool_stats runtime refresh", { concurrency: false }, () => {
let originalConsoleLog;
let originalConsoleError;
let originalSetInterval;
let originalConfig;
let originalDatabase;
let originalMysql;
let originalProtos;
let originalSupport;
let originalCoinFuncs;

test("behind-block emails use concise pool node labels", () => {
    const poolStats = loadPoolStats();
    const email = poolStats.formatBehindBlocksEmail({
        hostname: "jp.moneroocean.stream",
        ip: "0.0.0.0",
        port: 18081
    }, 4);

    assert.deepEqual(email, {
        subject: "Pool node jp is 4 blocks behind",
        body: "Pool node jp is 4 blocks behind for 18081 port"
    });
});

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

test("startPoolStats initializes pool and network caches without waiting for prices", async () => {
    createTestEnvironment({
        daemonPort: "18000",
        ports: ["18000", "18081"],
        caches: {
            global_stats: { hash: 111, minerCount: 5 },
            global_stats2: { totalHashes: 1000, roundHashes: 200 },
            pplns_stats: { hash: 99, minerCount: 4 },
            pplns_stats2: { totalHashes: 900, roundHashes: 180 }
        },
        mysqlQuery(sql, params) {
            if (sql === "SELECT count(*) as miner_count FROM (SELECT 1 FROM payments GROUP BY payment_address, payment_id) as miners") {
                return [{ miner_count: 0 }];
            }
            if (sql === "SELECT count(id) as txn_count FROM transactions") {
                return [{ txn_count: 0 }];
            }
            if (sql === "select * from pools where id < 1000 and last_checkin >= NOW() - INTERVAL 10 MINUTE") return [];
            if (sql === "select * from ports where hidden = 0 and pool_id < 1000 and lastSeen >= NOW() - INTERVAL 10 MINUTE") return [];
            if (sql === "SELECT blockID, hostname, ip, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)") return [];
            throw new Error("Unexpected SQL: " + sql);
        }
    });
    const pendingPriceCallbacks = [];
    const scheduledTasks = [];
    const poolStats = loadPoolStats();

    global.support.https_get = function (_url, callback) {
        pendingPriceCallbacks.push(callback);
    };
    global.setInterval = function (handler, intervalMs) {
        scheduledTasks.push({ handler, intervalMs });
        return scheduledTasks.length;
    };

    const startPromise = poolStats.startPoolStats();

    for (let attempts = 0; attempts < 20 && global.database.getCache("pool_stats_global") === false; ++attempts) {
        await new Promise(function (resolve) {
            setTimeout(resolve, 0);
        });
    }

    assert.deepEqual(global.database.getCache("pool_stats_global"), {
        hashRate: 111,
        miners: 5,
        totalHashes: 1000,
        lastBlockFoundTime: 0,
        lastBlockFound: 0,
        totalBlocksFound: 0,
        totalMinersPaid: 0,
        totalPayments: 0,
        roundHashes: 200,
        totalAltBlocksFound: 0,
        altBlocksFound: {},
        activePort: 18000,
        activePorts: [],
        activePortProfit: 0,
        coinProfit: {},
        coinComment: {},
        minBlockRewards: { 18000: 0 },
        pending: 0,
        price: { btc: 0, usd: 0, eur: 0 },
        currentEfforts: { 18000: 200 },
        pplnsPortShares: {},
        pplnsWindowTime: 0,
        portHash: {},
        portMinerCount: {},
        portCoinAlgo: { 18000: "rx/0", 18081: "kawpow" },
        updatedAt: global.database.getCache("pool_stats_global").updatedAt
    });
    assert.deepEqual(global.database.getCache("networkBlockInfo"), {
        18000: {
            difficulty: 100,
            hash: "aa",
            height: 10,
            value: 2,
            ts: 1234
        },
        18081: {
            difficulty: 100,
            hash: "aa",
            height: 10,
            value: 2,
            ts: 1234
        },
        difficulty: 111,
        hash: "aa",
        main_height: 10,
        height: 10,
        value: 2,
        ts: 1234
    });
    assert.equal(pendingPriceCallbacks.length, 3);
    assert.deepEqual(scheduledTasks, []);

    pendingPriceCallbacks.forEach(function (callback) {
        callback({ data: { monero: { quote: { USD: { price: 1 }, EUR: { price: 1 }, BTC: { price: 1 } } } } });
    });
    await startPromise;
    assert.deepEqual(
        scheduledTasks.map(function (entry) { return entry.intervalMs; }).sort(function (left, right) { return left - right; }),
        [30000, 30000, 60000, 300000, 900000]
    );
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
            if (sql === "SELECT count(id) as txn_count FROM transactions") return [{ txn_count: 0 }];
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
