"use strict";

const { createFakeMysql } = require("./fake_mysql");

const PAYMENTS_PATH = require.resolve("../../../lib/payments.js");
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
        get_height() {
            return { result: { height: 3655400 } };
        },
        store() {
            return { result: { stored: true } };
        },
        transfer: [],
        get_transfer_by_txid() {
            return { error: { message: "Transaction not found" } };
        },
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
        rpcWallet(method, params, callback, options) {
            calls.push({ method, params, options });
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
        locked: options.locked === true,
        payment_id: options.paymentId || null,
        timestamp: Math.floor(clock.now() / 1000),
        txid: options.txid || "a".repeat(64),
        type: options.type || "out",
        destinations: items.map(function toDestination(item) {
            return {
                address: item.address,
                amount: item.amount
            };
        })
    };
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

module.exports = {
    COIN,
    FEE_ADDRESS,
    INTEGRATED,
    STANDARD_A,
    STANDARD_B,
    STANDARD_C,
    captureConsole,
    createBatchItemRow,
    createBatchRow,
    createClock,
    createConfig,
    createDeferred,
    createFakeMysql,
    createHarness,
    createSupport,
    createTimerHarness,
    createWallet,
    loadPaymentsModule,
    txTransferRecord
};
