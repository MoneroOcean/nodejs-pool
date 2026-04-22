"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    COIN,
    INTEGRATED,
    STANDARD_A,
    createClock,
    createHarness,
    txTransferRecord
} = require("./common/fixtures");

test.describe("recovery cycle", { concurrency: false }, function recoveryCycleSuite() {
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
                get_transfer_by_txid: [{
                    result: {
                        transfer: txTransferRecord(clock, [{ address: INTEGRATED, amount: netAmount }], {
                            fee: totalFee,
                            paymentId: "004258d2bfdd764c",
                            txid: txHash
                        }),
                        transfers: [txTransferRecord(clock, [{ address: INTEGRATED, amount: netAmount }], {
                            fee: totalFee,
                            paymentId: "004258d2bfdd764c",
                            txid: txHash
                        })]
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
});
