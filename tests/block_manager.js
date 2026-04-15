"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const BLOCK_MANAGER_PATH = require.resolve("../lib/block_manager.js");

function loadBlockManager() {
    delete require.cache[BLOCK_MANAGER_PATH];
    return require(BLOCK_MANAGER_PATH);
}

function cloneRows(rows) {
    return rows.map(function (row) {
        return { ...row };
    });
}

async function captureConsole(run) {
    const original = {
        error: console.error,
        log: console.log,
        warn: console.warn
    };
    const output = { error: [], log: [], warn: [] };

    console.error = function () {
        output.error.push(Array.from(arguments).join(" "));
    };
    console.log = function () {
        output.log.push(Array.from(arguments).join(" "));
    };
    console.warn = function () {
        output.warn.push(Array.from(arguments).join(" "));
    };

    try {
        await run(output);
    } finally {
        console.error = original.error;
        console.log = original.log;
        console.warn = original.warn;
    }

    return output;
}

function createFakeEnvironment(options = {}) {
    const shareDB = { name: "shareDB" };
    const shareEntries = new Map();
    const shareInput = options.shareEntries || [];
    shareInput.forEach(function (entry) {
        shareEntries.set(entry.height, entry.shares.slice());
    });

    const lmdbState = {
        cursorCloses: 0,
        openReaders: 0,
        txnAborts: 0,
        txnBegins: 0
    };

    class Cursor {
        constructor(_txn, db) {
            if (db !== shareDB) throw new Error("Unexpected DB");
            this.keys = Array.from(shareEntries.keys()).sort(function (left, right) {
                return left - right;
            });
            this.currentKey = null;
            this.currentDupIndex = -1;
            this.closed = false;
        }

        goToRange(key) {
            let match = null;
            for (const currentKey of this.keys) {
                if (currentKey >= key) {
                    match = currentKey;
                    break;
                }
            }
            if (match === null) {
                this.currentKey = null;
                this.currentDupIndex = -1;
                return null;
            }
            this.currentKey = match;
            this.currentDupIndex = 0;
            return match;
        }

        goToNextDup() {
            if (this.currentKey === null) return null;
            const shares = shareEntries.get(this.currentKey) || [];
            if (this.currentDupIndex + 1 >= shares.length) return null;
            this.currentDupIndex += 1;
            return this.currentKey;
        }

        getCurrentBinary(callback) {
            callback(this.currentKey, shareEntries.get(this.currentKey)[this.currentDupIndex]);
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            lmdbState.cursorCloses += 1;
        }
    }

    const databaseEvents = {
        invalidatedAltBlocks: [],
        invalidatedBlocks: [],
        payReadyAltBlocks: [],
        payReadyBlocks: [],
        unlockedAltBlocks: [],
        unlockedBlocks: []
    };
    const cacheState = new Map();
    const database = {
        env: {
            beginTxn() {
                lmdbState.txnBegins += 1;
                lmdbState.openReaders += 1;
                let aborted = false;
                return {
                    abort() {
                        if (aborted) return;
                        aborted = true;
                        lmdbState.txnAborts += 1;
                        lmdbState.openReaders -= 1;
                    }
                };
            }
        },
        lmdb: { Cursor },
        shareDB,
        setCache(key, value) {
            cacheState.set(key, value);
        },
        getValidLockedBlocks() {
            return cloneRows(options.lockedBlocks || []);
        },
        getValidLockedAltBlocks() {
            return cloneRows(options.lockedAltBlocks || []);
        },
        invalidateBlock(height) {
            databaseEvents.invalidatedBlocks.push(height);
        },
        invalidateAltBlock(id) {
            databaseEvents.invalidatedAltBlocks.push(id);
        },
        payReadyBlock(hash) {
            databaseEvents.payReadyBlocks.push(hash);
        },
        payReadyAltBlock(hash) {
            databaseEvents.payReadyAltBlocks.push(hash);
        },
        unlockBlock(hash) {
            databaseEvents.unlockedBlocks.push(hash);
        },
        unlockAltBlock(hash) {
            databaseEvents.unlockedAltBlocks.push(hash);
        }
    };

    let balances = cloneRows(options.balances || []);
    let nextBalanceId = balances.reduce(function (maxId, row) {
        return Math.max(maxId, row.id || 0);
    }, 0) + 1;
    let blockBalanceRows = cloneRows(options.blockBalanceRows || []);
    let paidBlocks = cloneRows(options.paidBlocks || []);
    const mysqlState = {
        balanceInsertCount: 0,
        beginCount: 0,
        commitCount: 0,
        queryCalls: [],
        releaseCount: 0,
        rollbackCount: 0
    };

    function selectBalanceRows(store, paymentAddress, paymentId, poolType) {
        return store.filter(function (row) {
            return row.payment_address === paymentAddress &&
                row.pool_type === poolType &&
                row.payment_id === paymentId;
        }).map(function (row) {
            return { id: row.id };
        });
    }

    function handleQuery(sql, params, context = {}) {
        const balanceStore = context.balances || balances;
        const paidBlockStore = context.paidBlocks || paidBlocks;
        mysqlState.queryCalls.push({ sql, params, transactional: !!context.transactional });

        if (sql === "SELECT SUM(amount) as amt FROM balance") {
            return [{ amt: balanceStore.reduce(function (sum, row) { return sum + row.amount; }, 0) }];
        }
        if (sql === "SELECT payment_address, payment_id, amount FROM block_balance WHERE hex = ?") {
            return blockBalanceRows.filter(function (row) {
                return row.hex === params[0];
            }).map(function (row) {
                return {
                    payment_address: row.payment_address,
                    payment_id: row.payment_id,
                    amount: row.amount
                };
            });
        }
        if (sql === "SELECT id FROM balance WHERE payment_address = ? AND payment_id IS NULL AND pool_type = ?") {
            return selectBalanceRows(balanceStore, params[0], null, params[1]);
        }
        if (sql === "SELECT id FROM balance WHERE payment_address = ? AND payment_id = ? AND pool_type = ?") {
            return selectBalanceRows(balanceStore, params[0], params[1], params[2]);
        }
        if (sql === "INSERT INTO balance (payment_address, payment_id, pool_type) VALUES (?, ?, ?)") {
            const row = {
                id: nextBalanceId++,
                payment_address: params[0],
                payment_id: params[1],
                pool_type: params[2],
                amount: 0
            };
            balances.push(row);
            mysqlState.balanceInsertCount += 1;
            return { affectedRows: 1, insertId: row.id };
        }
        if (sql === "DELETE FROM block_balance WHERE hex IN (?)") {
            const keep = new Set(params[0]);
            const before = blockBalanceRows.length;
            blockBalanceRows = blockBalanceRows.filter(function (row) {
                return !keep.has(row.hex);
            });
            return { affectedRows: before - blockBalanceRows.length };
        }
        if (sql === "INSERT INTO block_balance (hex, payment_address, payment_id, amount) VALUES ?") {
            params[0].forEach(function (row) {
                blockBalanceRows.push({
                    hex: row[0],
                    payment_address: row[1],
                    payment_id: row[2],
                    amount: row[3]
                });
            });
            return { affectedRows: params[0].length };
        }
        if (sql === "INSERT INTO paid_blocks (hex, amount, port, found_time) VALUES (?,?,?,?)") {
            if (options.failTransactionOnInsert && context.transactional) {
                throw new Error("insert failed");
            }
            paidBlockStore.push({
                hex: params[0],
                amount: params[1],
                port: params[2],
                found_time: params[3]
            });
            return { affectedRows: 1, insertId: paidBlockStore.length };
        }
        if (sql.indexOf("UPDATE balance SET amount = amount + CASE id ") === 0) {
            if (options.failTransactionOnBalanceUpdate && context.transactional) {
                throw new Error("balance update failed");
            }
            const pairCount = params.length / 3;
            const updates = new Map();
            for (let i = 0; i < pairCount; ++i) {
                updates.set(params[i * 2], params[i * 2 + 1]);
            }
            const ids = params.slice(pairCount * 2);
            let affectedRows = 0;
            ids.forEach(function (id) {
                const row = balanceStore.find(function (entry) {
                    return entry.id === id;
                });
                if (!row) return;
                row.amount += updates.get(id);
                affectedRows += 1;
            });
            return { affectedRows };
        }
        throw new Error("Unhandled SQL: " + sql);
    }

    const mysql = {
        query(sql, params) {
            return Promise.resolve(handleQuery(sql, params));
        },
        async getConnection() {
            const working = {
                balances: cloneRows(balances),
                paidBlocks: cloneRows(paidBlocks)
            };
            return {
                async beginTransaction() {
                    mysqlState.beginCount += 1;
                },
                async query(sql, params) {
                    return handleQuery(sql, params, {
                        balances: working.balances,
                        paidBlocks: working.paidBlocks,
                        transactional: true
                    });
                },
                async commit() {
                    mysqlState.commitCount += 1;
                    balances = working.balances;
                    paidBlocks = working.paidBlocks;
                },
                async rollback() {
                    mysqlState.rollbackCount += 1;
                },
                release() {
                    mysqlState.releaseCount += 1;
                }
            };
        }
    };

    const coinCalls = {
        getBlockHeaderByHash: 0,
        getBlockHeaderByID: 0,
        getLastBlockHeader: 0,
        getPortBlockHeaderByHash: 0,
        getPortBlockHeaderByID: 0
    };
    const lastBlockHeight = options.lastBlockHeight || 200;
    const headerByHeight = options.headerByHeight || {};
    const headerByHash = options.headerByHash || {};
    const portHeaderByHeight = options.portHeaderByHeight || {};
    const portHeaderByHash = options.portHeaderByHash || {};
    const portNames = options.portNames || {};
    const poolProfiles = options.poolProfiles || {};
    const coinFuncs = {
        coinDevAddress: options.coinDevAddress || "coin-dev",
        poolDevAddress: options.poolDevAddress || "pool-dev",
        PORT2COIN_FULL(port) {
            return port in portNames ? portNames[port] : (port ? String(port) : "main");
        },
        getPoolProfile(port) {
            return poolProfiles[port] || null;
        },
        getLastBlockHeader(callback) {
            coinCalls.getLastBlockHeader += 1;
            callback(options.lastBlockHeaderError || null, { height: lastBlockHeight });
        },
        getBlockHeaderByID(blockId, callback) {
            coinCalls.getBlockHeaderByID += 1;
            callback(null, headerByHeight[blockId] || { hash: "main-" + blockId, difficulty: 100, reward: 10, height: blockId });
        },
        getBlockHeaderByHash(blockHash, callback) {
            coinCalls.getBlockHeaderByHash += 1;
            callback(null, headerByHash[blockHash] || { hash: blockHash, difficulty: 100, reward: 10, height: 100 });
        },
        getPortBlockHeaderByID(port, blockId, callback) {
            coinCalls.getPortBlockHeaderByID += 1;
            const key = port + ":" + blockId;
            callback(null, portHeaderByHeight[key] || { hash: "alt-" + blockId, difficulty: 100, reward: 5, height: blockId });
        },
        getPortBlockHeaderByHash(port, blockHash, callback) {
            coinCalls.getPortBlockHeaderByHash += 1;
            const key = port + ":" + blockHash;
            callback(null, portHeaderByHash[key] || { hash: blockHash, reward: 5, height: 100 });
        }
    };

    const supportState = { emails: [] };
    const support = {
        coinToDecimal(value) {
            return String(value);
        },
        formatDate(timestamp) {
            return "ts:" + timestamp;
        },
        sendEmail(subject, title, body) {
            supportState.emails.push({ subject, title, body });
        }
    };

    const config = {
        daemon: { port: 18081 },
        general: { adminEmail: "admin@example.com" },
        payout: {
            anchorRound: 100,
            blocksRequired: 60,
            devDonation: options.devDonation || 0,
            feeAddress: options.feeAddress || "pool-fee",
            pplnsFee: typeof options.pplnsFee === "number" ? options.pplnsFee : 0,
            poolDevDonation: options.poolDevDonation || 0
        },
        pplns: { shareMulti: options.shareMulti || 1 }
    };

    const protos = {
        POOLTYPE: { PPLNS: 0, PPS: 1 },
        Share: {
            decode(data) {
                if (data && data.__throw) throw data.__throw;
                return data;
            }
        }
    };

    return {
        cacheState,
        coinCalls,
        config,
        database,
        databaseEvents,
        lmdbState,
        mysql,
        mysqlState,
        protos,
        support,
        supportState,
        getBalances() {
            return cloneRows(balances);
        },
        getBlockBalanceRows() {
            return cloneRows(blockBalanceRows);
        },
        getPaidBlocks() {
            return cloneRows(paidBlocks);
        },
        runtime() {
            const blockManager = loadBlockManager();
            return blockManager.createBlockManagerRuntime({
                coinFuncs,
                config,
                database,
                mysql,
                protos,
                support
            });
        }
    };
}

function sortRows(rows) {
    return rows.slice().sort(function (left, right) {
        const leftKey = left.hex + ":" + left.payment_address + ":" + (left.payment_id || "");
        const rightKey = right.hex + ":" + right.payment_address + ":" + (right.payment_id || "");
        return leftKey.localeCompare(rightKey);
    });
}

function assertApproxRows(actualRows, expectedRows) {
    const actual = sortRows(actualRows);
    const expected = sortRows(expectedRows);
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < actual.length; ++index) {
        assert.equal(actual[index].hex, expected[index].hex);
        assert.equal(actual[index].payment_address, expected[index].payment_address);
        assert.equal(actual[index].payment_id, expected[index].payment_id);
        assert.ok(Math.abs(actual[index].amount - expected[index].amount) < 1e-12);
    }
}

test.describe("block_manager", { concurrency: false }, () => {
    test("precalc keeps cutoff-share payout behavior and remains idempotent", async () => {
        const env = createFakeEnvironment({
            pplnsFee: 10,
            shareEntries: [{
                height: 100,
                shares: [
                    {
                        paymentAddress: "miner-a",
                        paymentID: null,
                        poolType: 0,
                        port: 18081,
                        raw_shares: 60,
                        share_num: 1,
                        shares2: 60,
                        timestamp: 1000
                    },
                    {
                        paymentAddress: "miner-b",
                        paymentID: null,
                        poolType: 0,
                        port: 18081,
                        raw_shares: 60,
                        share_num: 1,
                        shares2: 60,
                        timestamp: 900
                    }
                ]
            }]
        });
        const runtime = env.runtime();

        assert.equal(await runtime.preCalculatePPLNSPayments(["cutoff"], 100, 100, false), true);
        assertApproxRows(env.getBlockBalanceRows(), [
            { hex: "cutoff", payment_address: "miner-a", payment_id: null, amount: 0.54 },
            { hex: "cutoff", payment_address: "miner-b", payment_id: null, amount: 0.4 },
            { hex: "cutoff", payment_address: "pool-fee", payment_id: null, amount: 0.06 }
        ]);
        assert.equal(await runtime.preCalculatePPLNSPayments(["cutoff"], 100, 100, false), true);
        assertApproxRows(env.getBlockBalanceRows(), [
            { hex: "cutoff", payment_address: "miner-a", payment_id: null, amount: 0.54 },
            { hex: "cutoff", payment_address: "miner-b", payment_id: null, amount: 0.4 },
            { hex: "cutoff", payment_address: "pool-fee", payment_id: null, amount: 0.06 }
        ]);
        assert.equal(env.lmdbState.openReaders, 0);
        assert.equal(env.lmdbState.cursorCloses, 2);
        assert.equal(env.lmdbState.txnAborts, 2);
    });

    test("precalc closes LMDB readers after share decode errors", async () => {
        const env = createFakeEnvironment({
            shareEntries: [{
                height: 100,
                shares: [
                    { __throw: new Error("bad share") },
                    {
                        paymentAddress: "miner-a",
                        paymentID: null,
                        poolType: 0,
                        port: 18081,
                        raw_shares: 100,
                        share_num: 1,
                        shares2: 100,
                        timestamp: 1000
                    }
                ]
            }]
        });
        const runtime = env.runtime();

        assert.equal(await runtime.preCalculatePPLNSPayments(["decode-ok"], 100, 100, false), true);
        assert.equal(env.lmdbState.openReaders, 0);
        assert.equal(env.lmdbState.cursorCloses, 1);
        assert.equal(env.lmdbState.txnAborts, 1);
        assert.equal(env.getBlockBalanceRows().length, 1);
    });

    test("payout collapses concurrent same-recipient balance creation", async () => {
        const env = createFakeEnvironment({
            blockBalanceRows: [
                { hex: "pay-hex", payment_address: "miner-a", payment_id: null, amount: 0.5 },
                { hex: "pay-hex", payment_address: "miner-a", payment_id: null, amount: 0.5 }
            ]
        });
        const runtime = env.runtime();

        assert.equal(await runtime.doPPLNSPayments("pay-hex", 10, 18081, 1234), true);
        assert.equal(env.mysqlState.balanceInsertCount, 1);
        assert.deepEqual(env.getBalances(), [{
            id: 1,
            payment_address: "miner-a",
            payment_id: null,
            pool_type: "pplns",
            amount: 10
        }]);
        assert.equal(env.getPaidBlocks().length, 1);
        assert.equal(env.mysqlState.beginCount, 1);
        assert.equal(env.mysqlState.commitCount, 1);
    });

    test("payout transaction rolls back balance changes on failure", async () => {
        const env = createFakeEnvironment({
            blockBalanceRows: [
                { hex: "rollback-hex", payment_address: "miner-a", payment_id: null, amount: 1 }
            ],
            failTransactionOnBalanceUpdate: true
        });
        const runtime = env.runtime();

        assert.equal(await runtime.doPPLNSPayments("rollback-hex", 10, 18081, 1234), false);
        assert.equal(env.getPaidBlocks().length, 0);
        assert.deepEqual(env.getBalances(), [{
            id: 1,
            payment_address: "miner-a",
            payment_id: null,
            pool_type: "pplns",
            amount: 0
        }]);
        assert.equal(env.mysqlState.rollbackCount, 1);
    });

    test("failed precalc does not leave hashes stuck in flight", async () => {
        const env = createFakeEnvironment({
            lastBlockHeight: 200,
            lockedBlocks: [{
                hash: "main-a",
                height: 100,
                difficulty: 100,
                pay_ready: false,
                poolType: 0
            }],
            headerByHeight: {
                100: { hash: "main-a", difficulty: 100, reward: 10, height: 100 }
            },
            shareEntries: []
        });
        const runtime = env.runtime();

        await runtime.runBlockUnlocker();
        assert.deepEqual(runtime.inspectState().inFlightPrecalc, []);
        await runtime.runBlockUnlocker();
        assert.deepEqual(runtime.inspectState().inFlightPrecalc, []);
        assert.equal(env.databaseEvents.payReadyBlocks.length, 0);
        assert.ok(env.coinCalls.getLastBlockHeader >= 6);
    });

    test("block unlocker skips non-pplns rows before header checks", async () => {
        const env = createFakeEnvironment({
            lockedBlocks: [{
                hash: "legacy-a",
                height: 100,
                difficulty: 100,
                pay_ready: false,
                poolType: 1
            }]
        });
        const runtime = env.runtime();

        await runtime.runBlockUnlocker();
        assert.equal(env.coinCalls.getBlockHeaderByID, 0);
        assert.equal(env.databaseEvents.payReadyBlocks.length, 0);
        assert.equal(env.databaseEvents.invalidatedBlocks.length, 0);
    });

    test("payment failures clear paymentInProgress and do not unlock blocks", async () => {
        const env = createFakeEnvironment({
            lastBlockHeight: 200,
            lockedBlocks: [{
                hash: "main-fail",
                height: 100,
                difficulty: 100,
                pay_ready: true,
                poolType: 0,
                timestamp: 44,
                value: 10
            }],
            headerByHeight: {
                100: { hash: "main-fail", difficulty: 100, reward: 10, height: 100 }
            },
            headerByHash: {
                "main-fail": { hash: "main-fail", difficulty: 100, reward: 10, height: 100 }
            },
            blockBalanceRows: [
                { hex: "main-fail", payment_address: "miner-a", payment_id: null, amount: 1 }
            ],
            failTransactionOnBalanceUpdate: true
        });
        const runtime = env.runtime();

        await runtime.runBlockUnlocker();
        assert.equal(runtime.inspectState().paymentInProgress, false);
        assert.deepEqual(env.databaseEvents.unlockedBlocks, []);
    });

    test("altblock unlocker groups anchor precalc and marks each hash ready", async () => {
        const env = createFakeEnvironment({
            lastBlockHeight: 1000,
            lockedAltBlocks: [
                { id: 1, hash: "alt-a", anchor_height: 100, pay_ready: false, poolType: 0, value: 5, port: 18082, height: 90 },
                { id: 2, hash: "alt-b", anchor_height: 100, pay_ready: false, poolType: 0, value: 6, port: 18083, height: 91 }
            ],
            headerByHeight: {
                100: { hash: "anchor-100", difficulty: 100, reward: 10, height: 100 }
            },
            shareEntries: [{
                height: 100,
                shares: [{
                    paymentAddress: "miner-a",
                    paymentID: null,
                    poolType: 0,
                    port: 18081,
                    raw_shares: 100,
                    share_num: 1,
                    shares2: 100,
                    timestamp: 1000
                }]
            }]
        });
        const runtime = env.runtime();

        await runtime.runAltblockUnlocker();
        assert.deepEqual(env.databaseEvents.payReadyAltBlocks.sort(), ["alt-a", "alt-b"]);
        assertApproxRows(env.getBlockBalanceRows(), [
            { hex: "alt-a", payment_address: "miner-a", payment_id: null, amount: 1 },
            { hex: "alt-b", payment_address: "miner-a", payment_id: null, amount: 1 }
        ]);
        assert.equal(env.lmdbState.openReaders, 0);
    });

    test("altblock unlocker logs pay_value waits as one coin-port summary line", async () => {
        const env = createFakeEnvironment({
            lastBlockHeight: 1000,
            portNames: {
                9231: "ALPHA",
                16000: "BETA"
            },
            lockedAltBlocks: [
                { id: 1, hash: "wait-a", anchor_height: 100, pay_ready: true, poolType: 0, value: 5, pay_value: 0, port: 9231, height: 1797336 },
                { id: 2, hash: "wait-b", anchor_height: 100, pay_ready: true, poolType: 0, value: 6, pay_value: 0, port: 9231, height: 1798742 },
                { id: 3, hash: "wait-c", anchor_height: 100, pay_ready: true, poolType: 0, value: 7, pay_value: 0, port: 16000, height: 2049299 }
            ]
        });
        const runtime = env.runtime();

        const output = await captureConsole(async function () {
            await runtime.runAltblockUnlocker();
        });
        const waitLine = output.log.find(function (line) {
            return line.indexOf("Altblock unlocker: waiting pay_value on ") === 0;
        });

        assert.equal(waitLine, "Altblock unlocker: waiting pay_value on ALPHA/9231 x2, BETA/16000 x1");
        assert.equal(waitLine.indexOf("1797336"), -1);
        assert.equal(waitLine.indexOf("2049299"), -1);
    });
});
