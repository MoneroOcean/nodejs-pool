"use strict";

function cloneRows(rows) {
    return rows.map(function clone(row) {
        return { ...row };
    });
}

function applyPaymentBatchUpdate(store, sql, params) {
    const prefix = "UPDATE payment_batches SET ";
    if (!sql.startsWith(prefix)) return null;
    const whereIndex = sql.indexOf(" WHERE id = ?");
    if (whereIndex === -1) return null;

    const assignments = sql.slice(prefix.length, whereIndex).split(", ");
    const updates = {};
    let paramIndex = 0;
    assignments.forEach(function readAssignment(assignment) {
        const field = assignment.split(" = ")[0];
        if (assignment.endsWith(" = NULL")) {
            updates[field] = null;
            return;
        }
        updates[field] = params[paramIndex++];
    });

    const batchId = params[paramIndex++];
    const row = store.paymentBatches.find(function findBatch(entry) {
        return entry.id === batchId;
    });
    if (!row) return { affectedRows: 0 };

    let whereClause = sql.slice(whereIndex + " WHERE id = ?".length);
    let allowed = true;
    while (whereClause) {
        if (whereClause.startsWith(" AND status = ?")) {
            allowed = allowed && row.status === params[paramIndex++];
            whereClause = whereClause.slice(" AND status = ?".length);
            continue;
        }
        if (whereClause.startsWith(" AND status IN (")) {
            const endIndex = whereClause.indexOf(")");
            const count = whereClause.slice(" AND status IN (".length, endIndex).split(",").length;
            const allowedStatuses = params.slice(paramIndex, paramIndex + count);
            paramIndex += count;
            allowed = allowed && allowedStatuses.includes(row.status);
            whereClause = whereClause.slice(endIndex + 1);
            continue;
        }
        if (whereClause.startsWith(" AND ")) {
            const nullIndex = whereClause.indexOf(" IS NULL");
            const field = whereClause.slice(" AND ".length, nullIndex);
            allowed = allowed && row[field] === null;
            whereClause = whereClause.slice(nullIndex + " IS NULL".length);
            continue;
        }
        if (!whereClause.trim()) break;
        throw new Error("Unhandled payment_batches WHERE clause: " + whereClause);
    }

    if (!allowed) return { affectedRows: 0 };
    Object.assign(row, updates);
    return { affectedRows: 1 };
}

function createFakeMysql(options = {}) {
    const liveStore = {
        balances: cloneRows(options.balances || []).map(function normalizeBalance(row) {
            return { pending_batch_id: null, ...row };
        }),
        paymentBatchItems: cloneRows(options.paymentBatchItems || []),
        paymentBatches: cloneRows(options.paymentBatches || []),
        payments: cloneRows(options.payments || []),
        transactions: cloneRows(options.transactions || []),
        users: cloneRows(options.users || []).map(function normalizeUser(row) {
            return {
                enable_email: true,
                payout_threshold: 0,
                ...row
            };
        })
    };
    const locks = new Map();
    const failures = (options.failures || []).map(function cloneFailure(failure) {
        return { ...failure, used: false };
    });
    const state = {
        beginCount: 0,
        commitCount: 0,
        queryCalls: [],
        releaseCount: 0,
        rollbackCount: 0
    };
    let nextConnectionId = 100;
    let nextBatchId = liveStore.paymentBatches.reduce(function maxId(value, row) { return Math.max(value, row.id || 0); }, 0) + 1;
    let nextBatchItemId = liveStore.paymentBatchItems.reduce(function maxId(value, row) { return Math.max(value, row.id || 0); }, 0) + 1;
    let nextPaymentId = liveStore.payments.reduce(function maxId(value, row) { return Math.max(value, row.id || 0); }, 0) + 1;
    let nextTransactionId = liveStore.transactions.reduce(function maxId(value, row) { return Math.max(value, row.id || 0); }, 0) + 1;

    function cloneStore(store) {
        return {
            balances: cloneRows(store.balances),
            paymentBatchItems: cloneRows(store.paymentBatchItems),
            paymentBatches: cloneRows(store.paymentBatches),
            payments: cloneRows(store.payments),
            transactions: cloneRows(store.transactions),
            users: cloneRows(store.users)
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

    function maybeFail(sql, params, context) {
        for (const failure of failures) {
            if (failure.used && failure.once !== false) continue;
            if (!failure.match(sql, params, context)) continue;
            failure.used = true;
            throw failure.error || new Error("forced mysql failure");
        }
    }

    function queryBalancePlan(store, minAmount) {
        return store.balances.filter(function eligible(row) {
            return row.amount >= minAmount && row.pending_batch_id === null;
        }).sort(function sort(left, right) {
            return left.id - right.id;
        }).map(function mapRow(row) {
            const user = store.users.find(function findUser(candidate) {
                return candidate.username === row.payment_address;
            });
            return {
                id: row.id,
                payment_address: row.payment_address,
                payment_id: row.payment_id,
                pool_type: row.pool_type,
                amount: row.amount,
                payout_threshold: user ? user.payout_threshold : 0
            };
        });
    }

    function handleQuery(sql, params, context) {
        maybeFail(sql, params, context);
        state.queryCalls.push({ sql, params, connectionId: context.connectionId || 0, transactional: !!context.store });
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
        if (sql === "SELECT IS_USED_LOCK(?) AS owner_id") {
            return [{ owner_id: locks.has(params[0]) ? locks.get(params[0]) : null }];
        }
        if (sql === "SELECT RELEASE_LOCK(?) AS released") {
            const owner = locks.get(params[0]);
            if (owner === context.connectionId) {
                locks.delete(params[0]);
                return [{ released: 1 }];
            }
            return [{ released: 0 }];
        }
        if (sql.indexOf("SELECT balance.id, balance.payment_address") === 0) {
            return queryBalancePlan(store, params[0]);
        }
        if (sql === "SELECT * FROM payment_batches WHERE status IN ('manual_review', 'reserved', 'retrying', 'submitting', 'submitted') ORDER BY id ASC") {
            return store.paymentBatches.filter(function include(row) {
                return ["manual_review", "reserved", "retrying", "submitting", "submitted"].includes(row.status);
            }).sort(function sort(left, right) {
                return left.id - right.id;
            }).map(function clone(row) { return { ...row }; });
        }
        if (sql === "SELECT * FROM payment_batches WHERE id = ? LIMIT 1") {
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
            }).map(function clone(row) { return { ...row }; });
        }
        if (sql === "SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1") {
            return store.users.filter(function include(row) {
                return row.username === params[0] && row.enable_email;
            }).slice(0, 1).map(function clone(row) {
                return { email: row.email };
            });
        }
        if (sql === "UPDATE users SET enable_email = 0 WHERE username = ? AND email = ?") {
            const row = store.users.find(function findUser(entry) {
                return entry.username === params[0] && entry.email === params[1];
            });
            if (!row) return { affectedRows: 0 };
            row.enable_email = 0;
            return { affectedRows: 1 };
        }
        if (sql === "UPDATE users SET enable_email = 0 WHERE username = ?") {
            const row = store.users.find(function findUser(entry) {
                return entry.username === params[0];
            });
            if (!row) return { affectedRows: 0 };
            row.enable_email = 0;
            return { affectedRows: 1 };
        }
        if (sql.indexOf("INSERT INTO payment_batches ") === 0) {
            const row = {
                id: nextBatchId++,
                status: params[0],
                batch_type: params[1],
                total_gross: params[2],
                total_net: params[3],
                total_fee: params[4],
                destination_count: params[5],
                created_at: params[6],
                updated_at: params[7],
                submit_started_at: null,
                submitted_at: null,
                finalized_at: null,
                released_at: null,
                last_reconciled_at: null,
                reconcile_attempts: 0,
                reconcile_clean_passes: 0,
                tx_hash: null,
                tx_key: null,
                transaction_id: null,
                last_error_text: null
            };
            store.paymentBatches.push(row);
            return { affectedRows: 1, insertId: row.id };
        }
        if (sql.indexOf("INSERT INTO payment_batch_items ") === 0) {
            params[0].forEach(function insertRow(row) {
                store.paymentBatchItems.push({
                    id: nextBatchItemId++,
                    batch_id: row[0],
                    balance_id: row[1],
                    destination_order: row[2],
                    pool_type: row[3],
                    payment_address: row[4],
                    gross_amount: row[5],
                    net_amount: row[6],
                    fee_amount: row[7],
                    created_at: row[8]
                });
            });
            return { affectedRows: params[0].length };
        }
        if (sql.indexOf("UPDATE balance SET pending_batch_id = ? WHERE pending_batch_id IS NULL AND id IN (") === 0) {
            const batchId = params[0];
            const ids = params.slice(1);
            let affectedRows = 0;
            ids.forEach(function updateId(id) {
                const row = store.balances.find(function findRow(entry) {
                    return entry.id === id && entry.pending_batch_id === null;
                });
                if (!row) return;
                row.pending_batch_id = batchId;
                affectedRows += 1;
            });
            return { affectedRows };
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
        if (sql === "UPDATE payment_batches SET status = ?, submit_started_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND status = ?") {
            const row = store.paymentBatches.find(function findBatch(entry) {
                return entry.id === params[4] && entry.status === params[5];
            });
            if (!row) return { affectedRows: 0 };
            row.status = params[0];
            row.submit_started_at = params[1];
            row.updated_at = params[2];
            row.last_error_text = params[3];
            return { affectedRows: 1 };
        }
        if (sql.indexOf("UPDATE payment_batches SET ") === 0) return applyPaymentBatchUpdate(store, sql, params);
        if (sql === "INSERT INTO transactions (address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?)") {
            const row = {
                id: nextTransactionId++,
                address: params[0],
                payment_id: params[1],
                xmr_amt: params[2],
                transaction_hash: params[3],
                mixin: params[4],
                fees: params[5],
                payees: params[6]
            };
            store.transactions.push(row);
            return { affectedRows: 1, insertId: row.id };
        }
        if (sql === "INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, amount, payment_id, transfer_fee) VALUES ?") {
            params[0].forEach(function insertRow(row) {
                store.payments.push({
                    id: nextPaymentId++,
                    unlocked_time: row[0],
                    paid_time: row[1],
                    pool_type: row[2],
                    payment_address: row[3],
                    transaction_id: row[4],
                    amount: row[5],
                    payment_id: row[6],
                    transfer_fee: row[7]
                });
            });
            return { affectedRows: params[0].length };
        }
        if (sql.indexOf("UPDATE balance SET amount = amount - CASE id ") === 0) {
            const pairCount = (params.length - 1) / 3;
            const deductions = new Map();
            for (let index = 0; index < pairCount; ++index) {
                deductions.set(params[index * 2], params[index * 2 + 1]);
            }
            const batchId = params[pairCount * 2];
            const ids = params.slice(pairCount * 2 + 1);
            let affectedRows = 0;
            ids.forEach(function updateId(id) {
                const row = store.balances.find(function findRow(entry) {
                    return entry.id === id && entry.pending_batch_id === batchId;
                });
                if (!row) return;
                row.amount -= deductions.get(id);
                row.pending_batch_id = null;
                affectedRows += 1;
            });
            return { affectedRows };
        }
        throw new Error("Unhandled SQL: " + sql);
    }

    const mysql = {
        query(sql, params = []) {
            return Promise.resolve(handleQuery(sql, params, { connectionId: 0, store: null }));
        },
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
                    liveStore.payments = transactionalStore.payments;
                    liveStore.transactions = transactionalStore.transactions;
                    liveStore.users = transactionalStore.users;
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

    return mysql;
}

module.exports = {
    createFakeMysql
};
