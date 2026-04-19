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

function createUnlockerEnvironment(options = {}) {
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
        getValidLockedAltBlocks() {
            return cloneRows(options.lockedAltBlocks || []);
        },
        getValidLockedBlocks() {
            return cloneRows(options.lockedBlocks || []);
        },
        invalidateAltBlock(id) {
            databaseEvents.invalidatedAltBlocks.push(id);
        },
        invalidateBlock(height) {
            databaseEvents.invalidatedBlocks.push(height);
        },
        lmdb: { Cursor },
        payReadyAltBlock(hash) {
            databaseEvents.payReadyAltBlocks.push(hash);
        },
        payReadyBlock(hash) {
            databaseEvents.payReadyBlocks.push(hash);
        },
        setCache(key, value) {
            cacheState.set(key, value);
        },
        shareDB,
        unlockAltBlock(hash) {
            databaseEvents.unlockedAltBlocks.push(hash);
        },
        unlockBlock(hash) {
            databaseEvents.unlockedBlocks.push(hash);
        }
    };

    let balances = cloneRows(options.balances || []);
    let nextBalanceId = balances.reduce(function (maxId, row) {
        return Math.max(maxId, row.id || 0);
    }, 0) + 1;
    let blockBalanceRows = cloneRows(options.blockBalanceRows || []);
    let paidBlocks = cloneRows(options.paidBlocks || []);
    const mysqlState = {
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
            ids.forEach(function (id) {
                const row = balanceStore.find(function (entry) {
                    return entry.id === id;
                });
                if (row) row.amount += updates.get(id);
            });
            return { affectedRows: ids.length };
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
    const coinFuncs = {
        coinDevAddress: "coin-dev",
        poolDevAddress: "pool-dev",
        PORT2COIN_FULL(port) {
            return portNames[port] || (port ? String(port) : "main");
        },
        getBlockHeaderByHash(blockHash, callback) {
            coinCalls.getBlockHeaderByHash += 1;
            callback(null, headerByHash[blockHash] || { hash: blockHash, difficulty: 100, reward: 10, height: 100 });
        },
        getBlockHeaderByID(blockId, callback) {
            coinCalls.getBlockHeaderByID += 1;
            callback(null, headerByHeight[blockId] || { hash: "main-" + blockId, difficulty: 100, reward: 10, height: blockId });
        },
        getLastBlockHeader(callback) {
            coinCalls.getLastBlockHeader += 1;
            callback(options.lastBlockHeaderError || null, { height: lastBlockHeight });
        },
        getPortBlockHeaderByHash(port, blockHash, callback) {
            coinCalls.getPortBlockHeaderByHash += 1;
            const key = port + ":" + blockHash;
            callback(null, portHeaderByHash[key] || { hash: blockHash, reward: 5, height: 100 });
        },
        getPortBlockHeaderByID(port, blockId, callback) {
            coinCalls.getPortBlockHeaderByID += 1;
            const key = port + ":" + blockId;
            callback(null, portHeaderByHeight[key] || { hash: "alt-" + blockId, difficulty: 100, reward: 5, height: blockId });
        }
    };

    const config = {
        daemon: { port: 18081 },
        general: { adminEmail: "admin@example.com" },
        payout: {
            anchorRound: 100,
            blocksRequired: 60,
            devDonation: 0,
            feeAddress: "pool-fee",
            pplnsFee: 0,
            poolDevDonation: 0
        },
        pplns: { shareMulti: 1 }
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
        coinCalls,
        databaseEvents,
        lmdbState,
        mysqlState,
        getBlockBalanceRows() {
            return cloneRows(blockBalanceRows);
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

test.describe("block_manager unlockers", { concurrency: false }, () => {
    test("altblock unlocker groups anchor precalc and marks each hash ready", async () => {
        const env = createUnlockerEnvironment({
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
        const env = createUnlockerEnvironment({
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
