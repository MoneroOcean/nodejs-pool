"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const PAYMENTS_PATH = require.resolve("../lib/payments.js");
const COIN = 1000000000000;
const STANDARD_A = "4".repeat(95);
const STANDARD_B = "5".repeat(95);
const STANDARD_C = "6".repeat(95);
const INTEGRATED = "8".repeat(106);
const FEE_ADDRESS = "9".repeat(95);

function loadPaymentsModule() {
    const previous = global.__paymentsAutostart;
    global.__paymentsAutostart = false;
    delete require.cache[PAYMENTS_PATH];
    const moduleRef = require(PAYMENTS_PATH);
    if (typeof previous === "undefined") delete global.__paymentsAutostart;
    else global.__paymentsAutostart = previous;
    return moduleRef;
}

function cloneRows(rows) {
    return rows.map(function clone(row) {
        return { ...row };
    });
}

function createClock(startAt = Date.UTC(2026, 3, 17, 12, 0, 0)) {
    let current = startAt;
    return {
        now() {
            return current;
        },
        advance(ms) {
            current += ms;
        }
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise(function assignCallbacks(res, rej) {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createTimerHarness() {
    let nextId = 1;
    const timers = new Map();

    return {
        setTimeout(fn, delay) {
            const handle = {
                id: nextId++,
                unref() {}
            };
            timers.set(handle.id, { delay, fn, handle });
            return handle;
        },
        clearTimeout(handle) {
            timers.delete(handle && handle.id ? handle.id : handle);
        },
        async fireNext() {
            const entry = Array.from(timers.values()).sort(function sort(left, right) {
                return left.handle.id - right.handle.id;
            })[0];
            if (!entry) throw new Error("No pending timers");
            timers.delete(entry.handle.id);
            return await entry.fn();
        },
        pendingCount() {
            return timers.size;
        }
    };
}

async function captureConsole(run) {
    const original = {
        error: console.error,
        log: console.log,
        warn: console.warn
    };
    const output = { error: [], log: [], warn: [] };

    console.error = function captureError() {
        output.error.push(Array.from(arguments).join(" "));
    };
    console.log = function captureLog() {
        output.log.push(Array.from(arguments).join(" "));
    };
    console.warn = function captureWarn() {
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

function createSupport(clock, sentEmails) {
    return {
        coinToDecimal(amount) {
            return amount / COIN;
        },
        decimalToCoin(amount) {
            return Math.round(amount * COIN);
        },
        formatDate(timestampMs) {
            const date = new Date(timestampMs);
            const pad = function pad(value) { return String(value).padStart(2, "0"); };
            return date.getUTCFullYear() + "-" +
                pad(date.getUTCMonth() + 1) + "-" +
                pad(date.getUTCDate()) + " " +
                pad(date.getUTCHours()) + ":" +
                pad(date.getUTCMinutes()) + ":" +
                pad(date.getUTCSeconds());
        },
        formatTemplate(template, values) {
            return template.replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
                return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
            });
        },
        sleep(ms) {
            clock.advance(ms);
            return Promise.resolve();
        },
        sendEmail(to, subject, body) {
            sentEmails.push({ to, subject, body });
        }
    };
}

function createWallet(script) {
    const calls = [];
    const plan = {
        getbalance: [{ result: { balance: 1000 * COIN, unlocked_balance: 1000 * COIN } }],
        store() {
            return { result: { stored: true } };
        },
        transfer: [],
        get_transfers: [{ result: { out: [], pending: [], pool: [] } }],
        get_tx_key: [{ result: { tx_key: "f".repeat(64) } }]
    };
    Object.assign(plan, script || {});

    function nextReply(method, params) {
        const handler = plan[method];
        if (typeof handler === "function") return handler(params, calls);
        if (Array.isArray(handler)) {
            if (!handler.length) throw new Error("No scripted wallet reply left for " + method);
            const next = handler.shift();
            return typeof next === "function" ? next(params, calls) : next;
        }
        return handler;
    }

    return {
        calls,
        rpcWallet(method, params, callback) {
            calls.push({ method, params });
            Promise.resolve(nextReply(method, params)).then(function resolveReply(reply) {
                setImmediate(function replyAsync() {
                    callback(reply);
                });
            }).catch(function rejectReply(error) {
                setImmediate(function replyError() {
                    callback(error);
                });
            });
        }
    };
}

function createConfig() {
    return {
        coin: {
            sigDigits: COIN
        },
        general: {
            adminEmail: "admin@example.com",
            coinCode: "XMR",
            sigDivisor: COIN
        },
        payout: {
            defaultPay: 0.1,
            denom: 0.000001,
            exchangeMin: 0.1,
            feeAddress: FEE_ADDRESS,
            feeSlewAmount: 0.0001,
            feeSlewEnd: 4,
            feesForTXN: 10,
            maxPaymentTxns: 2,
            mixIn: 10,
            priority: 1,
            timer: 120,
            walletMin: 0.01
        }
    };
}

function txTransferRecord(clock, items, options = {}) {
    return {
        fee: options.fee,
        payment_id: options.paymentId || null,
        timestamp: Math.floor(clock.now() / 1000),
        txid: options.txid || "a".repeat(64),
        destinations: items.map(function toDestination(item) {
            return {
                address: item.address,
                amount: item.amount
            };
        })
    };
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

function createHarness(options = {}) {
    const clock = options.clock || createClock();
    const sentEmails = [];
    const support = createSupport(clock, sentEmails);
    const wallet = createWallet(options.walletScript);
    support.rpcWallet = wallet.rpcWallet;
    const databaseCache = new Map();
    const database = {
        setCache(key, value) {
            databaseCache.set(key, value);
        },
        getCache(key) {
            return databaseCache.get(key);
        }
    };
    const config = createConfig();
    const mysql = createFakeMysql({
        balances: options.balances,
        failures: options.failures,
        paymentBatchItems: options.paymentBatchItems,
        paymentBatches: options.paymentBatches,
        payments: options.payments,
        transactions: options.transactions,
        users: options.users
    });
    const timers = options.timers || createTimerHarness();
    const payments = loadPaymentsModule();
    const runtime = payments.createPaymentsRuntime({
        clearTimeout: timers.clearTimeout.bind(timers),
        config,
        database,
        mysql,
        now: clock.now.bind(clock),
        setTimeout: timers.setTimeout.bind(timers),
        support
    });

    return {
        clock,
        config,
        database,
        mysql,
        runtime,
        sentEmails,
        support,
        timers,
        wallet
    };
}

function createBatchRow(overrides = {}) {
    const grossAmount = Object.prototype.hasOwnProperty.call(overrides, "total_gross")
        ? overrides.total_gross
        : Math.round(0.2 * COIN);
    const totalFee = Object.prototype.hasOwnProperty.call(overrides, "total_fee")
        ? overrides.total_fee
        : Math.round(0.0001 * COIN);
    const totalNet = Object.prototype.hasOwnProperty.call(overrides, "total_net")
        ? overrides.total_net
        : grossAmount - totalFee;
    return {
        id: 1,
        status: "submitting",
        batch_type: "bulk",
        total_gross: grossAmount,
        total_net: totalNet,
        total_fee: totalFee,
        destination_count: 1,
        created_at: "2026-04-17 11:00:00",
        updated_at: "2026-04-17 11:00:00",
        submit_started_at: "2026-04-17 11:10:00",
        submitted_at: null,
        finalized_at: null,
        released_at: null,
        last_reconciled_at: null,
        reconcile_attempts: 0,
        reconcile_clean_passes: 0,
        tx_hash: null,
        tx_key: null,
        transaction_id: null,
        last_error_text: null,
        ...overrides
    };
}

function createBatchItemRow(overrides = {}) {
    const grossAmount = Object.prototype.hasOwnProperty.call(overrides, "gross_amount")
        ? overrides.gross_amount
        : Math.round(0.2 * COIN);
    const feeAmount = Object.prototype.hasOwnProperty.call(overrides, "fee_amount")
        ? overrides.fee_amount
        : Math.round(0.0001 * COIN);
    const netAmount = Object.prototype.hasOwnProperty.call(overrides, "net_amount")
        ? overrides.net_amount
        : grossAmount - feeAmount;
    return {
        id: 1,
        batch_id: 1,
        balance_id: 1,
        destination_order: 0,
        pool_type: "pplns",
        payment_address: STANDARD_A,
        payment_id: null,
        gross_amount: grossAmount,
        net_amount: netAmount,
        fee_amount: feeAmount,
        created_at: "2026-04-17 11:00:00",
        ...overrides
    };
}

test.describe("payments runtime", { concurrency: false }, function paymentsSuite() {
    test("planBatches preserves threshold rules, fee address trimming, denom rounding, integrated singles, bulk sizing, and skips explicit payment-id balances", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.1000009 * COIN) },
                { id: 2, payment_address: STANDARD_B, payment_id: null, pool_type: "pplns", amount: Math.round(0.25 * COIN) },
                { id: 3, payment_address: STANDARD_C, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) },
                { id: 4, payment_address: INTEGRATED, payment_id: null, pool_type: "pplns", amount: Math.round(0.15 * COIN) },
                { id: 5, payment_address: "7".repeat(95), payment_id: "abcdef0123456789", pool_type: "pplns", amount: Math.round(0.16 * COIN) },
                { id: 6, payment_address: FEE_ADDRESS, payment_id: null, pool_type: "fees", amount: Math.round(10.25 * COIN) },
                { id: 7, payment_address: "3".repeat(95), payment_id: "0000000000000000", pool_type: "pplns", amount: Math.round(0.18 * COIN) }
            ],
            users: [
                { username: STANDARD_B, payout_threshold: Math.round(0.2 * COIN) }
            ]
        });

        const batches = await harness.runtime.planBatches();
        assert.equal(batches.length, 3);
        assert.deepEqual(batches.map(function mapType(batch) { return batch.batchType; }), ["bulk", "bulk", "integrated"]);
        assert.deepEqual(batches[0].items.map(function ids(item) { return item.balanceId; }), [1, 2]);
        assert.deepEqual(batches[1].items.map(function ids(item) { return item.balanceId; }), [3, 6]);
        assert.equal(batches[0].items[0].grossAmount, Math.round(0.1 * COIN));
        assert.equal(batches[1].items[1].grossAmount, Math.round(0.25 * COIN));
        assert.equal(batches[2].items[0].paymentAddress, INTEGRATED);
        assert.equal(batches.some(function hasSkippedPaymentId(batch) {
            return batch.items.some(function hasPaymentId(item) { return item.balanceId === 5 || item.balanceId === 7; });
        }), false);
    });

    test("standard payouts use defaultPay when threshold rows are missing or zero and honor the exact boundary", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.0999999 * COIN) },
                { id: 2, payment_address: STANDARD_B, payment_id: null, pool_type: "pplns", amount: Math.round(0.1 * COIN) },
                { id: 3, payment_address: STANDARD_C, payment_id: null, pool_type: "pplns", amount: Math.round(0.1 * COIN) }
            ],
            users: [
                { username: STANDARD_C, payout_threshold: 0 }
            ]
        });

        const batches = await harness.runtime.planBatches();
        assert.equal(batches.length, 1);
        assert.deepEqual(batches[0].items.map(function ids(item) { return item.balanceId; }), [2, 3]);
    });

    test("integrated payouts use defaultPay when threshold rows are missing or zero and honor the exact exchange boundary", async () => {
        const integratedAtBoundary = "9".repeat(106);
        const integratedZeroThreshold = "7".repeat(106);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: INTEGRATED, payment_id: null, pool_type: "pplns", amount: Math.round(0.0999999 * COIN) },
                { id: 2, payment_address: integratedAtBoundary, payment_id: null, pool_type: "pplns", amount: Math.round(0.1 * COIN) },
                { id: 3, payment_address: integratedZeroThreshold, payment_id: null, pool_type: "pplns", amount: Math.round(0.1 * COIN) }
            ],
            users: [
                { username: integratedZeroThreshold, payout_threshold: 0 }
            ]
        });

        const batches = await harness.runtime.planBatches();
        assert.equal(batches.length, 2);
        assert.deepEqual(batches.map(function ids(batch) { return batch.items[0].balanceId; }), [2, 3]);
        assert.equal(batches.every(function everyIntegrated(batch) { return batch.batchType === "integrated"; }), true);
    });

    test("integrated payouts still honor a custom threshold above exchange minimum", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: INTEGRATED, payment_id: null, pool_type: "pplns", amount: Math.round(0.15 * COIN) }
            ],
            users: [
                { username: INTEGRATED, payout_threshold: Math.round(0.2 * COIN) }
            ]
        });

        const batches = await harness.runtime.planBatches();
        assert.equal(batches.length, 0);
    });

    test("runCycle finalizes an integrated batch and logs the full intended and finalized batch details", async () => {
        const transferFee = 300000000;
        const longTxKey = "b".repeat(1088);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: INTEGRATED, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            users: [
                { username: INTEGRATED, payout_threshold: 0, email: "miner@example.com" }
            ],
            walletScript: {
                transfer: [{
                    result: {
                        fee: transferFee,
                        tx_hash: "a".repeat(64),
                        tx_key: longTxKey
                    }
                }]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        let logCountAtTransfer = -1;
        const output = await captureConsole(async function run(outputRef) {
            harness.wallet.rpcWallet = function scriptedWallet(method, params, callback) {
                harness.wallet.calls.push({ method, params });
                if (method === "transfer") logCountAtTransfer = outputRef.log.length;
                const reply = method === "transfer"
                    ? { result: { fee: transferFee, tx_hash: "a".repeat(64), tx_key: longTxKey } }
                    : method === "getbalance"
                        ? { result: { balance: 10 * COIN, unlocked_balance: 10 * COIN } }
                        : method === "get_transfers"
                            ? {
                                result: {
                                    out: [txTransferRecord(harness.clock, [{ address: INTEGRATED, amount: transferItemAmount }], {
                                        fee: transferFee,
                                        txid: "a".repeat(64)
                                    })],
                                    pending: [],
                                    pool: []
                                }
                            }
                        : method === "get_tx_key"
                            ? { result: { tx_key: longTxKey } }
                            : { result: { out: [], pending: [], pool: [] } };
                setImmediate(function asyncReply() {
                    callback(reply);
                });
            };
            harness.support.rpcWallet = harness.wallet.rpcWallet;
            await harness.runtime.runCycle();
        });

        const batch = harness.mysql.state.store.paymentBatches[0];
        assert.equal(batch.status, "finalized");
        assert.equal(batch.tx_key, longTxKey);
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.payments.length, 1);
        assert.equal(Object.prototype.hasOwnProperty.call(harness.mysql.state.store.paymentBatchItems[0], "payment_id"), false);
        assert.equal(harness.database.getCache("lastPaymentCycle"), Math.floor(harness.clock.now() / 1000));
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.wallet.calls.find(function findTransfer(call) { return call.method === "transfer"; }).params.payment_id, undefined);
        assert.match(output.log.find(function findPlan(line) { return line.includes("Payments cycle: plan"); }), /candidates=1 batches=1/);
        assert.equal(output.log.find(function findPlan(line) { return line.includes("Payments cycle: plan"); }).includes(INTEGRATED), false);
        assert.ok(logCountAtTransfer > 0);
        assert.match(output.log.slice(0, logCountAtTransfer).join("\n"), new RegExp(INTEGRATED));
        assert.match(output.log.join("\n"), /wallet_balance=10 XMR wallet_unlocked=10 XMR required_net=/);
        assert.match(output.log.join("\n"), /tx_hash=/);
        assert.match(output.log.join("\n"), /tx_key=/);
        assert.match(output.log.join("\n"), /https:\/\/xmrchain\.net\/prove\//);
    });

    test("accepted wallet transfer retries wallet-history visibility during submit and finalizes in the same cycle", async () => {
        const transferFee = 300000000;
        const txHash = "1".repeat(64);
        const txKey = "2".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{
                    result: {
                        fee: transferFee,
                        tx_hash: txHash,
                        tx_key: txKey
                    }
                }],
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    function replyTransfer() {
                        return {
                            result: {
                                out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                    fee: transferFee,
                                    txid: txHash
                                })],
                                pending: [],
                                pool: []
                            }
                        };
                    }
                ]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, txHash);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, txKey);
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.payments.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].amount, 0);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
        assert.equal(harness.database.getCache("lastPaymentCycle"), Math.floor(harness.clock.now() / 1000));
        assert.equal(harness.sentEmails.some(function hasFyi(entry) { return entry.subject === "FYI: Payment batch 1 awaiting wallet confirmation"; }), false);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 2);
        assert.equal(harness.mysql.state.store.transactions[0].transaction_hash, txHash);
    });

    test("startup recovery finalizes a submitted integrated batch even when wallet history exposes payment_id", async () => {
        const txHash = "6".repeat(64);
        const txKey = "7".repeat(64);
        const grossAmount = Math.round(0.042052 * COIN);
        const netAmount = 41655908132;
        const totalFee = 30640000;
        const clock = createClock(Date.UTC(2026, 3, 18, 5, 10, 34));
        const harness = createHarness({
            clock,
            balances: [
                { id: 1, payment_address: INTEGRATED, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 4 }
            ],
            paymentBatches: [{
                id: 4,
                status: "submitted",
                batch_type: "integrated",
                total_gross: grossAmount,
                total_net: netAmount,
                total_fee: totalFee,
                destination_count: 1,
                created_at: "2026-04-18 05:10:19",
                updated_at: "2026-04-18 05:10:20",
                submit_started_at: "2026-04-18 05:10:19",
                submitted_at: "2026-04-18 05:10:20",
                finalized_at: null,
                released_at: null,
                last_reconciled_at: null,
                reconcile_attempts: 0,
                reconcile_clean_passes: 0,
                tx_hash: txHash,
                tx_key: txKey,
                transaction_id: null,
                last_error_text: "wallet transfer succeeded but tx " + txHash + " is not visible in wallet history yet"
            }],
            paymentBatchItems: [{
                id: 1,
                batch_id: 4,
                balance_id: 1,
                destination_order: 0,
                pool_type: "pplns",
                payment_address: INTEGRATED,
                gross_amount: grossAmount,
                net_amount: netAmount,
                fee_amount: grossAmount - netAmount,
                created_at: "2026-04-18 05:10:19"
            }],
            walletScript: {
                get_transfers: [{
                    result: {
                        out: [txTransferRecord(clock, [{ address: INTEGRATED, amount: netAmount }], {
                            fee: totalFee,
                            paymentId: "004258d2bfdd764c",
                            txid: txHash
                        })],
                        pending: [],
                        pool: []
                    }
                }]
            }
        });

        await harness.runtime.recoverPendingBatches("startup");
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[0].transaction_id, 1);
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.transactions[0].transaction_hash, txHash);
        assert.equal(harness.mysql.state.store.payments.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].amount, 0);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
    });

    test("reserve transaction failure rolls back cleanly and does not update lastPaymentCycle", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            failures: [{
                once: true,
                match(sql) {
                    return sql.indexOf("UPDATE balance SET pending_batch_id = ? WHERE pending_batch_id IS NULL") === 0;
                },
                error: new Error("reserve write failed")
            }]
        });

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 0);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.state.rollbackCount, 1);
        assert.equal(harness.database.getCache("lastPaymentCycle"), undefined);
        assert.equal(harness.runtime.inspectState().isFailStop, false);
    });

    test("not enough unlocked money checks wallet history before pinning the exact batch for retry", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "not enough unlocked money" } }],
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } }
                ]
            }
        });

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "retrying");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 5);
        assert.equal(harness.database.getCache("lastPaymentCycle"), undefined);
    });

    test("daemon rejection with no wallet match pins the batch for retry", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "transaction was rejected by daemon" } }],
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } }
                ]
            }
        });

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "retrying");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 5);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
    });

    test("guarded retry hold does not reopen a batch another runtime already finalized", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const finalizedAt = "2026-04-17 12:00:30";
        const txHash = "c".repeat(64);
        const txKey = "d".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount }
            ],
            failures: [{
                once: true,
                match(sql) {
                    if (!sql.startsWith("UPDATE payment_batches SET status = ?, submit_started_at = ?, submitted_at = ?, updated_at = ?, last_reconciled_at = ?, last_error_text = ?, tx_hash = ?, tx_key = ? WHERE id = ? AND status = ?")) return false;
                    const batch = harness.mysql.state.store.paymentBatches[0];
                    Object.assign(batch, {
                        status: "finalized",
                        submitted_at: finalizedAt,
                        finalized_at: finalizedAt,
                        updated_at: finalizedAt,
                        transaction_id: 99,
                        tx_hash: txHash,
                        tx_key: txKey,
                        total_fee: feeAmount,
                        last_error_text: null
                    });
                    harness.mysql.state.store.transactions.push({
                        id: 99,
                        address: STANDARD_A,
                        payment_id: null,
                        xmr_amt: grossAmount,
                        transaction_hash: txHash,
                        mixin: 10,
                        fees: feeAmount,
                        payees: 1
                    });
                    harness.mysql.state.store.payments.push({
                        id: 1,
                        unlocked_time: finalizedAt,
                        paid_time: finalizedAt,
                        pool_type: "pplns",
                        payment_address: STANDARD_A,
                        transaction_id: 99,
                        amount: netAmount,
                        payment_id: null,
                        transfer_fee: feeAmount
                    });
                    harness.mysql.state.store.balances[0].amount = 0;
                    harness.mysql.state.store.balances[0].pending_batch_id = null;
                    return false;
                }
            }],
            walletScript: {
                transfer: [{ error: { message: "not enough unlocked money" } }],
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } }
                ]
            }
        });

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[0].transaction_id, 99);
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.payments.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
    });

    test("a pinned retrying batch blocks later payouts until the same batch clears", async () => {
        const bulkTxHash = "a".repeat(64);
        const integratedTxHash = "b".repeat(64);
        const bulkTxKey = "c".repeat(64);
        const integratedTxKey = "d".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) },
                { id: 2, payment_address: INTEGRATED, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                getbalance: [
                    { result: { balance: 1000 * COIN, unlocked_balance: 1000 * COIN } },
                    { result: { balance: 1000 * COIN, unlocked_balance: 1000 * COIN } },
                    { result: { balance: 1000 * COIN, unlocked_balance: 1000 * COIN } }
                ],
                transfer: [
                    { error: { message: "not enough unlocked money" } },
                    { result: { fee: 300000000, tx_hash: bulkTxHash, tx_key: bulkTxKey } },
                    { result: { fee: 300000000, tx_hash: integratedTxHash, tx_key: integratedTxKey } }
                ],
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    function replyTransfers() {
                        return {
                            result: {
                                out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: bulkTransferAmount }], {
                                    fee: 300000000,
                                    txid: bulkTxHash
                                })],
                                pending: [],
                                pool: []
                            }
                        };
                    },
                    function replyTransfers() {
                        return {
                            result: {
                                out: [
                                    txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: bulkTransferAmount }], {
                                        fee: 300000000,
                                        txid: bulkTxHash
                                    }),
                                    txTransferRecord(harness.clock, [{ address: INTEGRATED, amount: integratedTransferAmount }], {
                                        fee: 300000000,
                                        txid: integratedTxHash
                                    })
                                ],
                                pending: [],
                                pool: []
                            }
                        };
                    }
                ]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const bulkTransferAmount = plannedBatches[0].items[0].netAmount;
        const integratedTransferAmount = plannedBatches[1].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "retrying");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.mysql.state.store.balances[1].pending_batch_id, null);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);

        harness.clock.advance(10 * 60 * 1000 + 1000);
        await harness.runtime.runCycle();
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 3);
        assert.equal(harness.mysql.state.store.paymentBatches.length, 2);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[1].status, "finalized");
        assert.equal(harness.mysql.state.store.transactions.length, 2);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
        assert.equal(harness.mysql.state.store.balances[1].pending_batch_id, null);
    });

    test("not enough money fail-stops for manual review when wallet history already contains one exact matching transfer", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "not enough money" } }],
                get_transfers: [function replyTransfer() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 300000000,
                                txid: "7".repeat(64)
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [{ result: { tx_key: "8".repeat(64) } }]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, "7".repeat(64));
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, "8".repeat(64));
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.equal(harness.mysql.state.store.balances[0].amount, Math.round(0.2 * COIN));
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 1);
    });

    test("guarded manual-review escalation does not regress a batch another runtime already finalized", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const transferFee = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - transferFee;
        const walletFee = 300000000;
        const finalizedAt = "2026-04-17 12:01:00";
        const txHash = "7".repeat(64);
        const txKey = "8".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount }
            ],
            failures: [{
                once: true,
                match(sql) {
                    if (!sql.startsWith("UPDATE payment_batches SET status = ?, updated_at = ?, last_error_text = ?, tx_hash = ?, tx_key = ?, total_fee = ? WHERE id = ? AND status = ?")) return false;
                    const batch = harness.mysql.state.store.paymentBatches[0];
                    Object.assign(batch, {
                        status: "finalized",
                        submitted_at: finalizedAt,
                        finalized_at: finalizedAt,
                        updated_at: finalizedAt,
                        transaction_id: 1,
                        tx_hash: txHash,
                        tx_key: txKey,
                        total_fee: walletFee,
                        last_error_text: null
                    });
                    harness.mysql.state.store.transactions.push({
                        id: 1,
                        address: STANDARD_A,
                        payment_id: null,
                        xmr_amt: grossAmount,
                        transaction_hash: txHash,
                        mixin: 10,
                        fees: walletFee,
                        payees: 1
                    });
                    harness.mysql.state.store.payments.push({
                        id: 1,
                        unlocked_time: finalizedAt,
                        paid_time: finalizedAt,
                        pool_type: "pplns",
                        payment_address: STANDARD_A,
                        transaction_id: 1,
                        amount: netAmount,
                        payment_id: null,
                        transfer_fee: transferFee
                    });
                    harness.mysql.state.store.balances[0].amount = 0;
                    harness.mysql.state.store.balances[0].pending_batch_id = null;
                    return false;
                }
            }],
            walletScript: {
                transfer: [{ error: { message: "not enough money" } }],
                get_transfers: [function replyTransfer() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: walletFee,
                                txid: txHash
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [{ result: { tx_key: txKey } }]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.runtime.inspectState().isFailStop, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[0].transaction_id, 1);
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.payments.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
    });

    test("daemon rejection fail-stops for manual review when wallet history already contains one exact matching transfer", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "transaction was rejected by daemon" } }],
                get_transfers: [function replyTransfer() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 300000000,
                                txid: "8".repeat(64)
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [{ result: { tx_key: "9".repeat(64) } }]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, "8".repeat(64));
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, "9".repeat(64));
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.equal(harness.mysql.state.store.balances[0].amount, Math.round(0.2 * COIN));
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 1);
    });

    test("implausibly low wallet fee on transfer success is held instead of being accepted", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{
                    result: {
                        fee: 10,
                        tx_hash: "a".repeat(64),
                        tx_key: "b".repeat(64)
                    }
                }],
                get_transfers: [function replyTransfer() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 10,
                                txid: "a".repeat(64)
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, null);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.equal(harness.mysql.state.store.balances[0].amount, Math.round(0.2 * COIN));
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].last_error_text, "wallet reconcile returned incomplete transfer data");
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 1);
        assert.equal(harness.sentEmails.some(function hasFyi(entry) { return entry.subject === "FYI: Payment batch 1 awaiting wallet confirmation"; }), true);
        assert.equal(harness.database.getCache("lastPaymentCycle"), undefined);
    });

    test("finalize transaction rollback leaves a submitted batch for recovery and does not reduce balances", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            failures: [{
                once: true,
                match(sql) {
                    return sql === "INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, amount, payment_id, transfer_fee) VALUES ?";
                },
                error: new Error("payments insert failed")
                }],
            walletScript: {
                transfer: [{
                    result: {
                        fee: 200000000,
                        tx_hash: "c".repeat(64),
                        tx_key: "d".repeat(64)
                    }
                }],
                get_transfers() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 200000000,
                                txid: "c".repeat(64)
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.balances[0].amount, Math.round(0.2 * COIN));
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.database.getCache("lastPaymentCycle"), undefined);
        assert.equal(harness.mysql.state.state.rollbackCount >= 1, true);

        harness.clock.advance(10 * 60 * 1000 + 1000);
        await harness.runtime.runCycle();
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].amount, 0);
    });

    test("guarded submitted persist does not regress a batch another runtime already finalized", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = 200000000;
        const transferFee = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - transferFee;
        const finalizedAt = "2026-04-17 12:00:45";
        const txHash = "e".repeat(64);
        const txKey = "f".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount }
            ],
            failures: [{
                once: true,
                match(sql) {
                    if (!sql.startsWith("UPDATE payment_batches SET status = ?, submitted_at = ?, updated_at = ?, tx_hash = ?, tx_key = ?, total_fee = ?, last_error_text = ? WHERE id = ? AND status = ?")) return false;
                    const batch = harness.mysql.state.store.paymentBatches[0];
                    Object.assign(batch, {
                        status: "finalized",
                        submitted_at: finalizedAt,
                        finalized_at: finalizedAt,
                        updated_at: finalizedAt,
                        transaction_id: 1,
                        tx_hash: txHash,
                        tx_key: txKey,
                        total_fee: feeAmount,
                        last_error_text: null
                    });
                    harness.mysql.state.store.transactions.push({
                        id: 1,
                        address: STANDARD_A,
                        payment_id: null,
                        xmr_amt: grossAmount,
                        transaction_hash: txHash,
                        mixin: 10,
                        fees: feeAmount,
                        payees: 1
                    });
                    harness.mysql.state.store.payments.push({
                        id: 1,
                        unlocked_time: finalizedAt,
                        paid_time: finalizedAt,
                        pool_type: "pplns",
                        payment_address: STANDARD_A,
                        transaction_id: 1,
                        amount: netAmount,
                        payment_id: null,
                        transfer_fee: transferFee
                    });
                    harness.mysql.state.store.balances[0].amount = 0;
                    harness.mysql.state.store.balances[0].pending_batch_id = null;
                    return false;
                }
            }],
            walletScript: {
                transfer: [{ result: { fee: feeAmount, tx_hash: txHash, tx_key: txKey } }]
            }
        });

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[0].transaction_id, 1);
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.payments.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
        assert.equal(harness.database.getCache("lastPaymentCycle"), Math.floor(harness.clock.now() / 1000));
    });

    test("startup recovery releases a stale reserved batch before new planning", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN), pending_batch_id: 7 }
            ],
            paymentBatches: [
                {
                    id: 7,
                    status: "reserved",
                    batch_type: "bulk",
                    total_gross: Math.round(0.2 * COIN),
                    total_net: Math.round(0.1999 * COIN),
                    total_fee: Math.round(0.0001 * COIN),
                    destination_count: 1,
                    created_at: "2026-04-17 11:00:00",
                    updated_at: "2026-04-17 11:00:00",
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
                }
            ],
            paymentBatchItems: [
                {
                    id: 1,
                    batch_id: 7,
                    balance_id: 1,
                    destination_order: 0,
                    pool_type: "pplns",
                    payment_address: STANDARD_A,
                    payment_id: null,
                    gross_amount: Math.round(0.2 * COIN),
                    net_amount: Math.round(0.1999 * COIN),
                    fee_amount: Math.round(0.0001 * COIN),
                    created_at: "2026-04-17 11:00:00"
                }
            ]
        });

        await harness.runtime.recoverPendingBatches("startup");
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "retryable");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
    });

    test("startup recovery does not release a reserved batch after another runtime already advanced it", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN), pending_batch_id: 7 }
            ],
            failures: [{
                once: true,
                match(sql, _params, context) {
                    if (!sql.startsWith("UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND status = ?")) return false;
                    if (!context.store) return false;
                    Object.assign(context.store.paymentBatches[0], {
                        status: "submitted",
                        submit_started_at: "2026-04-17 11:10:00",
                        submitted_at: "2026-04-17 11:10:05",
                        tx_hash: "a".repeat(64),
                        tx_key: "b".repeat(64),
                        total_fee: 200000000
                    });
                    return false;
                }
            }],
            paymentBatches: [
                {
                    id: 7,
                    status: "reserved",
                    batch_type: "bulk",
                    total_gross: Math.round(0.2 * COIN),
                    total_net: Math.round(0.1999 * COIN),
                    total_fee: Math.round(0.0001 * COIN),
                    destination_count: 1,
                    created_at: "2026-04-17 11:00:00",
                    updated_at: "2026-04-17 11:00:00",
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
                }
            ],
            paymentBatchItems: [
                {
                    id: 1,
                    batch_id: 7,
                    balance_id: 1,
                    destination_order: 0,
                    pool_type: "pplns",
                    payment_address: STANDARD_A,
                    payment_id: null,
                    gross_amount: Math.round(0.2 * COIN),
                    net_amount: Math.round(0.1999 * COIN),
                    fee_amount: Math.round(0.0001 * COIN),
                    created_at: "2026-04-17 11:00:00"
                }
            ]
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");
        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].released_at, null);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 7);
    });

    test("wallet timeout during submit reconciles to one exact match without resubmission", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [new Error("Request timed out")],
                get_transfers: [function replyTransfer() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 300000000,
                                txid: "e".repeat(64)
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [{ result: { tx_key: "f".repeat(64) } }]
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const transferItemAmount = plannedBatches[0].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.mysql.state.store.transactions[0].transaction_hash, "e".repeat(64));
    });

    test("ambiguous transfer errors keep the reservation held until an exact wallet match appears", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "daemon busy" } }],
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } }
                ]
            }
        });

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.database.getCache("lastPaymentCycle"), undefined);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 5);
        assert.equal(harness.sentEmails.some(function hasFyi(entry) { return entry.subject === "FYI: Payment batch 1 awaiting wallet confirmation"; }), true);

        harness.clock.advance(5 * 60 * 1000);
        await harness.runtime.recoverPendingBatches("pass-2");
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 5);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);

        harness.clock.advance(5 * 60 * 1000 + 1000);
        await harness.runtime.recoverPendingBatches("pass-3");
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 6);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
    });

    test("missing wallet matches keep the reservation held and throttle reconcile checks", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN), pending_batch_id: 3 }
            ],
            paymentBatches: [
                {
                    id: 3,
                    status: "submitting",
                    batch_type: "bulk",
                    total_gross: Math.round(0.2 * COIN),
                    total_net: Math.round(0.1999 * COIN),
                    total_fee: Math.round(0.0001 * COIN),
                    destination_count: 1,
                    created_at: "2026-04-17 11:00:00",
                    updated_at: "2026-04-17 11:00:00",
                    submit_started_at: "2026-04-17 11:10:00",
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
                }
            ],
            paymentBatchItems: [
                {
                    id: 1,
                    batch_id: 3,
                    balance_id: 1,
                    destination_order: 0,
                    pool_type: "pplns",
                    payment_address: STANDARD_A,
                    payment_id: null,
                    gross_amount: Math.round(0.2 * COIN),
                    net_amount: Math.round(0.1999 * COIN),
                    fee_amount: Math.round(0.0001 * COIN),
                    created_at: "2026-04-17 11:00:00"
                }
            ],
            walletScript: {
                get_transfers: [
                    { result: { out: [], pending: [], pool: [] } },
                    { result: { out: [], pending: [], pool: [] } }
                ]
            }
        });

        await harness.runtime.recoverPendingBatches("pass-1");
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_clean_passes, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 3);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 1);

        harness.clock.advance(5 * 60 * 1000);
        await harness.runtime.recoverPendingBatches("pass-2");
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 3);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 1);

        harness.clock.advance(5 * 60 * 1000 + 1000);
        await harness.runtime.recoverPendingBatches("pass-3");
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 3);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 2);
        assert.equal(harness.sentEmails.some(function hasFyi(entry) { return entry.subject === "FYI: Payment batch 3 awaiting wallet confirmation"; }), true);
    });

    test("multiple plausible wallet matches fail-stop the runtime for manual review", async () => {
        const matchA = txTransferRecord(createClock(), [{ address: STANDARD_A, amount: Math.round(0.1999 * COIN) }], { fee: 100, txid: "1".repeat(64) });
        const matchB = txTransferRecord(createClock(), [{ address: STANDARD_A, amount: Math.round(0.1999 * COIN) }], { fee: 100, txid: "2".repeat(64) });
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN), pending_batch_id: 5 }
            ],
            paymentBatches: [{
                id: 5,
                status: "submitting",
                batch_type: "bulk",
                total_gross: Math.round(0.2 * COIN),
                total_net: Math.round(0.1999 * COIN),
                total_fee: Math.round(0.0001 * COIN),
                destination_count: 1,
                created_at: "2026-04-17 11:00:00",
                updated_at: "2026-04-17 11:00:00",
                submit_started_at: "2026-04-17 11:10:00",
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
            }],
            paymentBatchItems: [{
                id: 1,
                batch_id: 5,
                balance_id: 1,
                destination_order: 0,
                pool_type: "pplns",
                payment_address: STANDARD_A,
                payment_id: null,
                gross_amount: Math.round(0.2 * COIN),
                net_amount: Math.round(0.1999 * COIN),
                fee_amount: Math.round(0.0001 * COIN),
                created_at: "2026-04-17 11:00:00"
            }],
            walletScript: {
                get_transfers: [{
                    result: {
                        out: [matchA, matchB],
                        pending: [],
                        pool: []
                    }
                }]
            }
        });

        await harness.runtime.recoverPendingBatches("startup");
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
    });

    test("proven wallet send with missing tx_key fail-stops for manual review", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN), pending_batch_id: 6 }
            ],
            paymentBatches: [{
                id: 6,
                status: "submitting",
                batch_type: "bulk",
                total_gross: Math.round(0.2 * COIN),
                total_net: Math.round(0.1999 * COIN),
                total_fee: Math.round(0.0001 * COIN),
                destination_count: 1,
                created_at: "2026-04-17 11:00:00",
                updated_at: "2026-04-17 11:00:00",
                submit_started_at: "2026-04-17 11:10:00",
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
            }],
            paymentBatchItems: [{
                id: 1,
                batch_id: 6,
                balance_id: 1,
                destination_order: 0,
                pool_type: "pplns",
                payment_address: STANDARD_A,
                payment_id: null,
                gross_amount: Math.round(0.2 * COIN),
                net_amount: Math.round(0.1999 * COIN),
                fee_amount: Math.round(0.0001 * COIN),
                created_at: "2026-04-17 11:00:00"
            }],
            walletScript: {
                get_transfers: [{
                    result: {
                        out: [txTransferRecord(createClock(), [{ address: STANDARD_A, amount: Math.round(0.1999 * COIN) }], { fee: 100, txid: "3".repeat(64) })],
                        pending: [],
                        pool: []
                    }
                }],
                get_tx_key: [{ error: { message: "key not found" } }]
            }
        });

        await harness.runtime.recoverPendingBatches("startup");
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
    });

    test("submitted batches with an implausibly low persisted fee fail-stop for manual review", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN), pending_batch_id: 8 }
            ],
            paymentBatches: [{
                id: 8,
                status: "submitted",
                batch_type: "bulk",
                total_gross: Math.round(0.2 * COIN),
                total_net: Math.round(0.1999 * COIN),
                total_fee: 10,
                destination_count: 1,
                created_at: "2026-04-17 11:00:00",
                updated_at: "2026-04-17 11:00:00",
                submit_started_at: "2026-04-17 11:10:00",
                submitted_at: "2026-04-17 11:10:05",
                finalized_at: null,
                released_at: null,
                last_reconciled_at: null,
                reconcile_attempts: 0,
                reconcile_clean_passes: 0,
                tx_hash: "4".repeat(64),
                tx_key: "5".repeat(64),
                transaction_id: null,
                last_error_text: null
            }],
            paymentBatchItems: [{
                id: 1,
                batch_id: 8,
                balance_id: 1,
                destination_order: 0,
                pool_type: "pplns",
                payment_address: STANDARD_A,
                payment_id: null,
                gross_amount: Math.round(0.2 * COIN),
                net_amount: Math.round(0.1999 * COIN),
                fee_amount: Math.round(0.0001 * COIN),
                created_at: "2026-04-17 11:00:00"
            }]
        });

        await harness.runtime.recoverPendingBatches("startup");
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 8);
    });

    test("advisory lock blocks a second runtime from processing payouts", async () => {
        const sharedMysql = createFakeMysql({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ]
        });
        const clock = createClock();
        const sentEmails = [];
        const support = createSupport(clock, sentEmails);
        const wallet = createWallet({
            transfer: [{ result: { fee: 100, tx_hash: "4".repeat(64), tx_key: "5".repeat(64) } }]
        });
        support.rpcWallet = wallet.rpcWallet;
        const databaseA = { cache: new Map(), setCache(key, value) { this.cache.set(key, value); } };
        const databaseB = { cache: new Map(), setCache(key, value) { this.cache.set(key, value); } };
        const payments = loadPaymentsModule();
        const runtimeA = payments.createPaymentsRuntime({
            clearTimeout,
            config: createConfig(),
            database: databaseA,
            mysql: sharedMysql,
            now: clock.now.bind(clock),
            setTimeout,
            support
        });
        const runtimeB = payments.createPaymentsRuntime({
            clearTimeout,
            config: createConfig(),
            database: databaseB,
            mysql: sharedMysql,
            now: clock.now.bind(clock),
            setTimeout,
            support
        });

        await runtimeA.runCycle();
        await runtimeB.runCycle();
        assert.equal(runtimeB.inspectState().isFailStop, true);
        assert.equal(sentEmails.some(function matchSubject(entry) { return entry.subject === "Payment runtime fail-stop"; }), true);
        await runtimeA.stop();
        await runtimeB.stop();
    });

    test("conditional submit claim prevents two runtimes from transferring the same retrying batch", async () => {
        // This test models split-brain around retry submission after exclusivity
        // has already broken down, for example if the dedicated MySQL advisory-lock
        // connection dies before the original runtime stops and a replacement
        // runtime takes over. The separate advisory lock names below are only a
        // test harness shortcut to force that overlap. Once that happens, the same
        // retrying batch must still be claimable by only one runtime before wallet
        // transfer starts.
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.000095238095 * COIN);
        const netAmount = grossAmount - feeAmount;
        const transferDeferred = createDeferred();
        let transferResolved = false;
        const sharedMysql = createFakeMysql({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [{
                id: 1,
                status: "retrying",
                batch_type: "bulk",
                total_gross: grossAmount,
                total_net: netAmount,
                total_fee: feeAmount,
                destination_count: 1,
                created_at: "2026-04-17 11:00:00",
                updated_at: "2026-04-17 11:00:00",
                submit_started_at: null,
                submitted_at: null,
                finalized_at: null,
                released_at: null,
                last_reconciled_at: "2026-04-17 11:00:00",
                reconcile_attempts: 1,
                reconcile_clean_passes: 0,
                tx_hash: null,
                tx_key: null,
                transaction_id: null,
                last_error_text: "retry me"
            }],
            paymentBatchItems: [{
                id: 1,
                batch_id: 1,
                balance_id: 1,
                destination_order: 0,
                pool_type: "pplns",
                payment_address: STANDARD_A,
                gross_amount: grossAmount,
                net_amount: netAmount,
                fee_amount: feeAmount,
                created_at: "2026-04-17 11:00:00"
            }]
        });
        const clock = createClock();
        const sentEmails = [];
        const support = createSupport(clock, sentEmails);
        const wallet = createWallet({
            getbalance() {
                return { result: { balance: 1000 * COIN, unlocked_balance: 1000 * COIN } };
            },
            transfer: [transferDeferred.promise.then(function resolveTransfer() {
                transferResolved = true;
                return { result: { fee: 300000000, tx_hash: "a".repeat(64), tx_key: "b".repeat(64) } };
            })],
            get_transfers() {
                return {
                    result: {
                        out: transferResolved
                            ? [txTransferRecord(clock, [{ address: STANDARD_A, amount: netAmount }], { fee: 300000000, txid: "a".repeat(64) })]
                            : [],
                        pending: [],
                        pool: []
                    }
                };
            }
        });
        support.rpcWallet = wallet.rpcWallet;
        const payments = loadPaymentsModule();
        const databaseA = { cache: new Map(), setCache(key, value) { this.cache.set(key, value); } };
        const databaseB = { cache: new Map(), setCache(key, value) { this.cache.set(key, value); } };
        const runtimeA = payments.createPaymentsRuntime({
            advisoryLockName: "nodejs-pool:payments:a",
            clearTimeout,
            config: createConfig(),
            database: databaseA,
            mysql: sharedMysql,
            now: clock.now.bind(clock),
            setTimeout,
            support
        });
        const runtimeB = payments.createPaymentsRuntime({
            advisoryLockName: "nodejs-pool:payments:b",
            clearTimeout,
            config: createConfig(),
            database: databaseB,
            mysql: sharedMysql,
            now: clock.now.bind(clock),
            setTimeout,
            support
        });

        const cycleA = runtimeA.runCycle();
        const cycleB = runtimeB.runCycle();
        await Promise.resolve();
        await Promise.resolve();
        transferDeferred.resolve();
        await Promise.all([cycleA, cycleB]);

        assert.equal(wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);
        assert.equal(sharedMysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(sharedMysql.state.store.transactions.length, 1);
        assert.equal(sharedMysql.state.store.payments.length, 1);
        assert.equal(sharedMysql.state.store.balances[0].pending_batch_id, null);
        await runtimeA.stop();
        await runtimeB.stop();
    });

    test("preflight requires unlocked balance to cover the planned payout plus a conservative wallet fee buffer", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ]
        });
        const plannedBatches = await harness.runtime.planBatches();
        const unlockedBalance = plannedBatches[0].totalNet + Math.round(0.0005 * COIN);

        harness.support.rpcWallet = function scriptedWallet(method, params, callback) {
            harness.wallet.calls.push({ method, params });
            setImmediate(function replyAsync() {
                if (method === "getbalance") {
                    callback({ result: { balance: 10 * COIN, unlocked_balance: unlockedBalance } });
                    return;
                }
                callback({ result: {} });
            });
        };

        await harness.runtime.runCycle();

        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 0);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "retrying");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet preflight insufficient balance/);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /required_total=/);
    });

    test("history-checked submit errors hold the claimed batch when wallet history is unavailable", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "not enough unlocked money" } }],
                get_transfers: Array.from({ length: 5 }, function () { return new Error("wallet offline"); })
            }
        });

        await harness.runtime.runCycle();

        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.paymentBatches[0].submitted_at, null);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, null);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet submit failed but history check is unavailable: Error: wallet offline/);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 5);
        assert.equal(harness.sentEmails.some(function hasFyi(entry) { return entry.subject === "FYI: Payment batch 1 awaiting wallet confirmation"; }), true);
    });

    test("submitted batches hold during recovery when wallet history for the known tx is unavailable", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const txHash = "1".repeat(64);
        const txKey = "2".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({
                    status: "submitted",
                    submitted_at: "2026-04-17 11:10:05",
                    tx_hash: txHash,
                    tx_key: txKey,
                    total_fee: 300000000
                })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ],
            walletScript: {
                get_transfers: [new Error("wallet offline")]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_attempts, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_clean_passes, 0);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet reconcile unavailable while waiting for submitted tx/);
    });

    test("submitted batches keep the reservation when the known tx is still not visible", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const txHash = "3".repeat(64);
        const txKey = "4".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({
                    status: "submitted",
                    submitted_at: "2026-04-17 11:10:05",
                    tx_hash: txHash,
                    tx_key: txKey,
                    total_fee: 300000000
                })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ],
            walletScript: {
                get_transfers: [{ result: { out: [], pending: [], pool: [] } }]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_attempts, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_clean_passes, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /is not visible in wallet history yet/);
    });

    test("ambiguous submitting batches hold during recovery when wallet history is unavailable", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({ total_gross: grossAmount, total_net: netAmount, total_fee: feeAmount })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ],
            walletScript: {
                get_transfers: [new Error("wallet offline")]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_attempts, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_clean_passes, 0);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet reconcile unavailable: Error: wallet offline/);
    });

    test("recovery persists a matched tx hash and holds when tx_key lookup is only temporarily unavailable", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const txHash = "5".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({ total_gross: grossAmount, total_net: netAmount, total_fee: feeAmount })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ],
            walletScript: {
                get_transfers: [function replyTransfers() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [new Error("tx key temporarily unavailable")]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, txHash);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, null);
        assert.equal(harness.mysql.state.store.paymentBatches[0].total_fee, 300000000);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet match found but waiting for tx_key/);
        assert.equal(harness.runtime.inspectState().isFailStop, false);
    });

    test("submitted batches with a visible tx hold when tx_key retrieval is temporarily unavailable during finalize", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const txHash = "6".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({
                    status: "submitted",
                    submitted_at: "2026-04-17 11:10:05",
                    tx_hash: txHash,
                    tx_key: null,
                    total_fee: 300000000,
                    total_gross: grossAmount,
                    total_net: netAmount
                })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ],
            walletScript: {
                get_transfers: [function replyTransfers() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [new Error("wallet busy")]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, null);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /waiting for tx_key: Error: wallet busy/);
    });

    test("submitted batches with a visible tx fail-stop when tx_key is permanently unavailable during finalize", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const txHash = "7".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({
                    status: "submitted",
                    submitted_at: "2026-04-17 11:10:05",
                    tx_hash: txHash,
                    tx_key: null,
                    total_fee: 300000000,
                    total_gross: grossAmount,
                    total_net: netAmount
                })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ],
            walletScript: {
                get_transfers: [function replyTransfers() {
                    return {
                        result: {
                            out: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            })],
                            pending: [],
                            pool: []
                        }
                    };
                }],
                get_tx_key: [{ error: { message: "key not found" } }]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet send proven for batch 1 but tx_key is unavailable/);
    });

    test("successful submits without an immediate tx_key persist submitted state and wait for wallet visibility", async () => {
        const txHash = "8".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{
                    result: {
                        fee: 300000000,
                        tx_hash: txHash
                    }
                }],
                get_tx_key: [new Error("wallet busy")],
                get_transfers: Array.from({ length: 5 }, function () {
                    return { result: { out: [], pending: [], pool: [] } };
                })
            }
        });

        await harness.runtime.runCycle();

        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, txHash);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, null);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, new RegExp("wallet transfer succeeded but tx " + txHash + " is not visible in wallet history yet"));
    });

    test("successful submits hold the submitted batch when post-submit wallet history lookup is unavailable", async () => {
        const txHash = "9".repeat(64);
        const txKey = "a".repeat(64);
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{
                    result: {
                        fee: 300000000,
                        tx_hash: txHash,
                        tx_key: txKey
                    }
                }],
                get_transfers: Array.from({ length: 5 }, function () { return new Error("wallet offline"); })
            }
        });

        await harness.runtime.runCycle();

        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, txHash);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, txKey);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet transfer succeeded but tx search is unavailable: Error: wallet offline/);
    });

    test("startup recovery fail-stops immediately when a manual-review batch already exists", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: grossAmount, pending_batch_id: 1 }
            ],
            paymentBatches: [
                createBatchRow({
                    status: "manual_review",
                    submitted_at: "2026-04-17 11:10:05",
                    tx_hash: "b".repeat(64),
                    tx_key: "c".repeat(64),
                    total_fee: 300000000,
                    total_gross: grossAmount,
                    total_net: netAmount
                })
            ],
            paymentBatchItems: [
                createBatchItemRow({ gross_amount: grossAmount, net_amount: netAmount, fee_amount: feeAmount })
            ]
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.match(harness.runtime.inspectState().failStopReason, /manual-review batch 1 blocks new payouts/);
    });

    test("start schedules the cycle and wallet-store heartbeat and stop waits for the active cycle", async () => {
        const timers = createTimerHarness();
        const transferDeferred = createDeferred();
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            timers,
            walletScript: {
                transfer: [transferDeferred.promise.then(function reply() {
                    return { result: { fee: 100, tx_hash: "6".repeat(64), tx_key: "7".repeat(64) } };
                })]
            }
        });

        harness.runtime.start();
        assert.equal(harness.wallet.calls.filter(function isStore(call) { return call.method === "store"; }).length, 1);
        assert.equal(timers.pendingCount(), 2);
        const firing = timers.fireNext();
        await Promise.resolve();
        assert.equal(timers.pendingCount(), 1);
        const stopPromise = harness.runtime.stop();
        let stopResolved = false;
        stopPromise.then(function markResolved() {
            stopResolved = true;
        });
        await Promise.resolve();
        assert.equal(stopResolved, false);
        transferDeferred.resolve();
        await firing;
        await stopPromise;
        assert.equal(stopResolved, true);
        assert.equal(timers.pendingCount(), 0);
    });
});
