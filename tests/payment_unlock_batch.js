"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    ADVISORY_LOCK_NAME,
    collectRiskFlags,
    collectUnsafeUnlockFlags,
    unlockBatch
} = require("../manage_scripts/payment_unlock_batch.js");

function cloneRows(rows) {
    return rows.map(function clone(row) {
        return { ...row };
    });
}

function createMysql(options = {}) {
    const liveStore = {
        balances: cloneRows(options.balances || []).map(function normalizeBalance(row) {
            return { pending_batch_id: null, ...row };
        }),
        paymentBatchItems: cloneRows(options.paymentBatchItems || []),
        paymentBatches: cloneRows(options.paymentBatches || [])
    };
    const locks = new Map(options.locks || []);
    const state = {
        beginCount: 0,
        commitCount: 0,
        releaseCount: 0,
        rollbackCount: 0
    };
    let nextConnectionId = 100;

    function cloneStore(store) {
        return {
            balances: cloneRows(store.balances),
            paymentBatchItems: cloneRows(store.paymentBatchItems),
            paymentBatches: cloneRows(store.paymentBatches)
        };
    }

    function activeStore(context) {
        return context.store || liveStore;
    }

    function releaseLocksForConnection(connectionId) {
        for (const entry of Array.from(locks.entries())) {
            if (entry[1] === connectionId) locks.delete(entry[0]);
        }
    }

    function handleQuery(sql, params, context) {
        const store = activeStore(context);

        if (sql === "SELECT CONNECTION_ID() AS connection_id") {
            return [{ connection_id: context.connectionId }];
        }
        if (sql === "SELECT GET_LOCK(?, 0) AS locked") {
            const lockName = params[0];
            const owner = locks.get(lockName);
            if (typeof owner === "undefined" || owner === context.connectionId) {
                locks.set(lockName, context.connectionId);
                return [{ locked: 1 }];
            }
            return [{ locked: 0 }];
        }
        if (sql === "SELECT RELEASE_LOCK(?) AS released") {
            const owner = locks.get(params[0]);
            if (owner === context.connectionId) {
                locks.delete(params[0]);
                return [{ released: 1 }];
            }
            return [{ released: 0 }];
        }
        if (sql === "SELECT * FROM payment_batches WHERE id = ?") {
            const row = store.paymentBatches.find(function findBatch(entry) {
                return entry.id === params[0];
            });
            return row ? [{ ...row }] : [];
        }
        if (sql === "SELECT * FROM payment_batch_items WHERE batch_id = ? ORDER BY destination_order ASC") {
            return store.paymentBatchItems.filter(function include(row) {
                return row.batch_id === params[0];
            }).sort(function sort(left, right) {
                return left.destination_order - right.destination_order;
            }).map(function clone(row) {
                return { ...row };
            });
        }
        if (sql === "SELECT id, payment_address, payment_id, amount FROM balance WHERE pending_batch_id = ? ORDER BY id ASC") {
            return store.balances.filter(function include(row) {
                return row.pending_batch_id === params[0];
            }).sort(function sort(left, right) {
                return left.id - right.id;
            }).map(function mapRow(row) {
                return {
                    id: row.id,
                    payment_address: row.payment_address,
                    payment_id: row.payment_id,
                    amount: row.amount
                };
            });
        }
        if (sql === "UPDATE balance SET pending_batch_id = NULL WHERE pending_batch_id = ?") {
            let affectedRows = 0;
            store.balances.forEach(function clearBatch(row) {
                if (row.pending_batch_id !== params[0]) return;
                row.pending_batch_id = null;
                affectedRows += 1;
            });
            return { affectedRows };
        }
        if (sql === "UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND submit_started_at IS NULL AND status IN (?, ?)") {
            const row = store.paymentBatches.find(function findBatch(entry) {
                return entry.id === params[4] &&
                    entry.submit_started_at === null &&
                    (entry.status === params[5] || entry.status === params[6]);
            });
            if (!row) return { affectedRows: 0 };
            row.status = params[0];
            row.released_at = params[1];
            row.updated_at = params[2];
            row.last_error_text = params[3];
            return { affectedRows: 1 };
        }
        throw new Error("Unhandled SQL: " + sql);
    }

    return {
        async getConnection() {
            const connectionId = nextConnectionId++;
            let transactionalStore = null;
            return {
                threadId: connectionId,
                async beginTransaction() {
                    state.beginCount += 1;
                    transactionalStore = cloneStore(liveStore);
                },
                async query(sql, params = []) {
                    return handleQuery(sql, params, { connectionId, store: transactionalStore });
                },
                async commit() {
                    state.commitCount += 1;
                    if (!transactionalStore) return;
                    liveStore.balances = transactionalStore.balances;
                    liveStore.paymentBatchItems = transactionalStore.paymentBatchItems;
                    liveStore.paymentBatches = transactionalStore.paymentBatches;
                    transactionalStore = null;
                },
                async rollback() {
                    state.rollbackCount += 1;
                    transactionalStore = null;
                },
                release() {
                    state.releaseCount += 1;
                    releaseLocksForConnection(connectionId);
                }
            };
        },
        state: {
            locks,
            state,
            store: liveStore
        }
    };
}

function createSupport() {
    return {
        formatDate(timestampMs) {
            const date = new Date(timestampMs);
            const pad = function pad(value) { return String(value).padStart(2, "0"); };
            return date.getUTCFullYear() + "-" +
                pad(date.getUTCMonth() + 1) + "-" +
                pad(date.getUTCDate()) + " " +
                pad(date.getUTCHours()) + ":" +
                pad(date.getUTCMinutes()) + ":" +
                pad(date.getUTCSeconds());
        }
    };
}

test.describe("payment unlock batch helper", { concurrency: false }, () => {
    test("risk helpers separate post-submit hard stops from force-only warnings", () => {
        const batch = {
            status: "submitting",
            submit_started_at: "2026-04-18 12:00:00",
            submitted_at: null,
            tx_hash: null,
            tx_key: null,
            transaction_id: null,
            finalized_at: null,
            released_at: "2026-04-18 11:59:00"
        };
        const items = [{ payment_address: "4".repeat(95) }];
        const reservedBalances = [];

        assert.deepEqual(collectUnsafeUnlockFlags(batch), ["submit_started_at is set"]);
        assert.deepEqual(collectRiskFlags(batch, items, reservedBalances), [
            "status is submitting",
            "released_at is already set",
            "reserved balance rows (0) do not match batch items (1)"
        ]);
    });

    test("unlockBatch releases a pre-submit retrying batch under the payments advisory lock", async () => {
        const mysql = createMysql({
            balances: [
                { id: 1, payment_address: "4".repeat(95), payment_id: null, amount: 100, pending_batch_id: 3 }
            ],
            paymentBatchItems: [{
                id: 1,
                batch_id: 3,
                balance_id: 1,
                destination_order: 0,
                payment_address: "4".repeat(95)
            }],
            paymentBatches: [{
                id: 3,
                status: "retrying",
                submit_started_at: null,
                submitted_at: null,
                tx_hash: null,
                tx_key: null,
                transaction_id: null,
                finalized_at: null,
                released_at: null,
                updated_at: "2026-04-18 11:00:00",
                last_error_text: "retry me"
            }]
        });

        const result = await unlockBatch({
            batchId: 3,
            force: false,
            mysql,
            nowMs: Date.UTC(2026, 3, 18, 12, 0, 0),
            support: createSupport()
        });

        assert.equal(result.batch.status, "retrying");
        assert.equal(result.clearedPendingRows, 1);
        assert.deepEqual(result.riskFlags, []);
        assert.equal(mysql.state.store.balances[0].pending_batch_id, null);
        assert.equal(mysql.state.store.paymentBatches[0].status, "retryable");
        assert.equal(mysql.state.store.paymentBatches[0].released_at, "2026-04-18 12:00:00");
        assert.equal(mysql.state.state.beginCount, 1);
        assert.equal(mysql.state.state.commitCount, 1);
        assert.equal(mysql.state.state.rollbackCount, 0);
        assert.equal(mysql.state.locks.size, 0);
    });

    test("unlockBatch refuses post-submit batches even when force is requested", async () => {
        const mysql = createMysql({
            balances: [
                { id: 1, payment_address: "4".repeat(95), payment_id: null, amount: 100, pending_batch_id: 7 }
            ],
            paymentBatchItems: [{
                id: 1,
                batch_id: 7,
                balance_id: 1,
                destination_order: 0,
                payment_address: "4".repeat(95)
            }],
            paymentBatches: [{
                id: 7,
                status: "submitting",
                submit_started_at: "2026-04-18 11:59:50",
                submitted_at: null,
                tx_hash: null,
                tx_key: null,
                transaction_id: null,
                finalized_at: null,
                released_at: null,
                updated_at: "2026-04-18 11:59:50",
                last_error_text: "submitting"
            }]
        });

        await assert.rejects(async function rejectUnsafeBatch() {
            await unlockBatch({
                batchId: 7,
                force: true,
                mysql,
                nowMs: Date.UTC(2026, 3, 18, 12, 0, 0),
                support: createSupport()
            });
        }, function assertUnsafe(error) {
            assert.equal(error.code, "unsafe_batch");
            assert.deepEqual(error.flags, ["submit_started_at is set"]);
            return true;
        });

        assert.equal(mysql.state.store.balances[0].pending_batch_id, 7);
        assert.equal(mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(mysql.state.state.beginCount, 0);
        assert.equal(mysql.state.state.commitCount, 0);
        assert.equal(mysql.state.locks.size, 0);
    });

    test("unlockBatch refuses to run while the payments advisory lock is held elsewhere", async () => {
        const mysql = createMysql({
            balances: [
                { id: 1, payment_address: "4".repeat(95), payment_id: null, amount: 100, pending_batch_id: 9 }
            ],
            paymentBatchItems: [{
                id: 1,
                batch_id: 9,
                balance_id: 1,
                destination_order: 0,
                payment_address: "4".repeat(95)
            }],
            paymentBatches: [{
                id: 9,
                status: "retrying",
                submit_started_at: null,
                submitted_at: null,
                tx_hash: null,
                tx_key: null,
                transaction_id: null,
                finalized_at: null,
                released_at: null,
                updated_at: "2026-04-18 11:59:50",
                last_error_text: "retrying"
            }]
        });
        mysql.state.locks.set(ADVISORY_LOCK_NAME, 999);

        await assert.rejects(async function rejectBusyLock() {
            await unlockBatch({
                batchId: 9,
                force: false,
                mysql,
                nowMs: Date.UTC(2026, 3, 18, 12, 0, 0),
                support: createSupport()
            });
        }, function assertBusyLock(error) {
            assert.equal(error.code, "lock_busy");
            assert.match(error.message, /Payment advisory lock is busy/);
            return true;
        });

        assert.equal(mysql.state.store.balances[0].pending_batch_id, 9);
        assert.equal(mysql.state.store.paymentBatches[0].status, "retrying");
    });
});
