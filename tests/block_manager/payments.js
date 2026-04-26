"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const BLOCK_MANAGER_PATH = require.resolve("../../lib/block_manager.js");

function loadBlockManager() {
    delete require.cache[BLOCK_MANAGER_PATH];
    return require(BLOCK_MANAGER_PATH);
}

function cloneRows(rows) {
    return rows.map(function (row) {
        return { ...row };
    });
}

function createPaymentEnvironment(options = {}) {
    const shareDB = { name: "shareDB" };
    const shareEntries = new Map();
    const shareInput = options.shareEntries || [];
    shareInput.forEach(function (entry) {
        shareEntries.set(entry.height, entry.shares.slice());
    });

    const lmdbState = {
        cursorCloses: 0,
        openReaders: 0,
        txnAborts: 0
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

    const cacheState = new Map();
    const database = {
        env: {
            beginTxn() {
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
        setCache(key, value) {
            cacheState.set(key, value);
        },
        shareDB
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
        rollbackCount: 0
    };

    function selectBalanceRows(store, paymentAddress, paymentId, poolType) {
        return store.filter(function (row) {
            return row.payment_address === paymentAddress &&
                row.payment_id === paymentId &&
                row.pool_type === poolType;
        }).map(function (row) {
            return { id: row.id };
        });
    }

    function handleQuery(sql, params, context = {}) {
        const balanceStore = context.balances || balances;
        const paidBlockStore = context.paidBlocks || paidBlocks;

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
            blockBalanceRows = blockBalanceRows.filter(function (row) {
                return !keep.has(row.hex);
            });
            return { affectedRows: 1 };
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
            return { affectedRows: 1 };
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
                release() {}
            };
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

    const coinFuncs = {
        coinDevAddress: "coin-dev",
        poolDevAddress: "pool-dev",
        PORT2COIN_FULL(port) {
            return port ? String(port) : "main";
        }
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

    const support = {
        coinToDecimal(value) {
            return String(value);
        },
        formatDate(timestamp) {
            return "ts:" + timestamp;
        },
        sendEmail() {}
    };

    return {
        cacheState,
        lmdbState,
        mysqlState,
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
            return loadBlockManager().createBlockManagerRuntime({
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

test.describe("block_manager payments", { concurrency: false }, () => {
    test("precalc keeps cutoff-share payout behavior and remains idempotent", async () => {
        const env = createPaymentEnvironment({
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
        const env = createPaymentEnvironment({
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
        const env = createPaymentEnvironment({
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
        const env = createPaymentEnvironment({
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
});
