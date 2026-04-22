"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    COIN,
    FEE_ADDRESS,
    INTEGRATED,
    STANDARD_A,
    STANDARD_B,
    STANDARD_C,
    captureConsole,
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
} = require("./common/fixtures");

test.describe("payments runtime", { concurrency: false }, function paymentsRuntimeSuite() {
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

    test("wallet-store heartbeat logs and reschedules when the wallet store RPC throws", async () => {
        const timers = createTimerHarness();
        const harness = createHarness({ timers });

        harness.support.rpcWallet = function throwingWallet(method) {
            harness.wallet.calls.push({ method, params: [] });
            if (method === "store") throw new Error("disk full");
        };

        const output = await captureConsole(async function runWithCapturedConsole() {
            harness.runtime.start();
            assert.equal(timers.pendingCount(), 2);
            await timers.fireNext();
            await timers.fireNext();
        });

        const storeCalls = harness.wallet.calls.filter(function isStore(call) {
            return call.method === "store";
        });
        assert.equal(storeCalls.length, 2);
        assert.equal(timers.pendingCount(), 2);
        assert.equal(output.warn.some(function matchWarn(line) {
            return /wallet store heartbeat failed: Error: disk full/.test(line);
        }), true);

        await harness.runtime.stop();
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
            get_transfer_by_txid() {
                return {
                    result: {
                        transfer: transferResolved
                            ? txTransferRecord(clock, [{ address: STANDARD_A, amount: netAmount }], { fee: 300000000, txid: "a".repeat(64) })
                            : null,
                        transfers: transferResolved
                            ? [txTransferRecord(clock, [{ address: STANDARD_A, amount: netAmount }], { fee: 300000000, txid: "a".repeat(64) })]
                            : []
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

    test("lost retry claim fail-stops when another runtime already escalated the batch to manual review", async () => {
        const grossAmount = Math.round(0.2 * COIN);
        const feeAmount = Math.round(0.0001 * COIN);
        const netAmount = grossAmount - feeAmount;
        const sharedMysql = createFakeMysql({
            failures: [{
                once: true,
                match(sql, _params, context) {
                    if (sql !== "UPDATE payment_batches SET status = ?, submit_started_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND status = ?") return false;
                    const store = context.store || sharedMysql.state.store;
                    Object.assign(store.paymentBatches[0], {
                        status: "manual_review",
                        updated_at: "2026-04-17 11:10:05",
                        last_error_text: "operator review required"
                    });
                    return false;
                }
            }],
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
        const wallet = createWallet();
        support.rpcWallet = wallet.rpcWallet;
        const payments = loadPaymentsModule();
        const runtime = payments.createPaymentsRuntime({
            clearTimeout,
            config: createConfig(),
            database: { cache: new Map(), setCache(key, value) { this.cache.set(key, value); } },
            mysql: sharedMysql,
            now: clock.now.bind(clock),
            setTimeout,
            support
        });

        const recovered = await runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(runtime.inspectState().isFailStop, true);
        assert.match(runtime.inspectState().failStopReason, /manual-review batch 1 blocks payout after submit-claim loss/);
        assert.equal(sharedMysql.state.store.paymentBatches[0].status, "manual_review");
        assert.equal(wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 0);
        await runtime.stop();
    });

    test("runtime fail-stops when advisory lock ownership disappears between cycles", async () => {
        const sharedMysql = createFakeMysql();
        const clock = createClock();
        const sentEmails = [];
        const support = createSupport(clock, sentEmails);
        const wallet = createWallet();
        support.rpcWallet = wallet.rpcWallet;
        const database = { cache: new Map(), setCache(key, value) { this.cache.set(key, value); } };
        const payments = loadPaymentsModule();
        const runtime = payments.createPaymentsRuntime({
            clearTimeout,
            config: createConfig(),
            database,
            mysql: sharedMysql,
            now: clock.now.bind(clock),
            setTimeout,
            support
        });

        await runtime.runCycle();
        sharedMysql.state.locks.set("nodejs-pool:payments", 99999);

        const result = await runtime.runCycle();

        assert.equal(result.clean, false);
        assert.equal(runtime.inspectState().isFailStop, true);
        assert.match(runtime.inspectState().failStopReason, /lost advisory lock nodejs-pool:payments/);
        assert.equal(sentEmails.some(function matchSubject(entry) { return entry.subject === "Payment runtime fail-stop"; }), true);
        await runtime.stop();
    });
});
