"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    COIN,
    STANDARD_A,
    createBatchItemRow,
    createBatchRow,
    createHarness,
    txTransferRecord
} = require("./fixtures");

test.describe("recovery submitted", { concurrency: false }, function recoverySubmittedSuite() {
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
                get_transfer_by_txid: [new Error("wallet offline")]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_attempts, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_clean_passes, 0);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet reconcile unavailable while waiting for submitted tx/);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfer_by_txid"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
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
                get_transfer_by_txid: [{ error: { message: "Transaction not found" } }]
            }
        });

        const recovered = await harness.runtime.recoverPendingBatches("startup");

        assert.equal(recovered, false);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_attempts, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].reconcile_clean_passes, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /is not visible in wallet history yet/);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfer_by_txid"; }).length, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
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
                get_transfer_by_txid: [function replyTransfers() {
                    return {
                        result: {
                            transfer: txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            }),
                            transfers: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            })]
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
                get_transfer_by_txid: [function replyTransfers() {
                    return {
                        result: {
                            transfer: txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            }),
                            transfers: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: netAmount }], {
                                fee: 300000000,
                                txid: txHash
                            })]
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
});
