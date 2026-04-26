"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    COIN,
    STANDARD_A,
    createHarness,
    txTransferRecord
} = require("./common/fixtures");

test.describe("submit review", { concurrency: false }, function submitReviewSuite() {
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
                get_transfer_by_txid() {
                    return {
                        result: {
                            transfer: txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 200000000,
                                txid: "c".repeat(64)
                            }),
                            transfers: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                fee: 200000000,
                                txid: "c".repeat(64)
                            })]
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

    test("history-checked submit errors stop at wallet height lookup failure without scanning transfers", async () => {
        const harness = createHarness({
            balances: [
                { id: 1, payment_address: STANDARD_A, payment_id: null, pool_type: "pplns", amount: Math.round(0.2 * COIN) }
            ],
            walletScript: {
                transfer: [{ error: { message: "not enough unlocked money" } }],
                get_height: Array.from({ length: 5 }, function () { return new Error("height offline"); })
            }
        });

        await harness.runtime.runCycle();

        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.paymentBatches[0].submitted_at, null);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, null);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet height lookup failed: Error: height offline/);
        assert.equal(harness.wallet.calls.filter(function isHeights(call) { return call.method === "get_height"; }).length, 5);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
        assert.equal(harness.sentEmails.some(function hasFyi(entry) { return entry.subject === "FYI: Payment batch 1 awaiting wallet confirmation"; }), true);
    });

    test("successful submits with a missing tx_key persist submitted state and fail-stop for manual review", async () => {
        const txHash = "b".repeat(64);
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
                get_tx_key: [{ error: { message: "key not found" } }]
            }
        });

        await harness.runtime.runCycle();

        assert.equal(harness.runtime.inspectState().isFailStop, true);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "manual_review");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, txHash);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, null);
        assert.equal(harness.mysql.state.store.paymentBatches[0].total_fee, 300000000);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet transfer for batch 1 succeeded but tx_key is unavailable/);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfer_by_txid"; }).length, 0);
        assert.equal(harness.wallet.calls.filter(function isTxKey(call) { return call.method === "get_tx_key"; }).length, 1);
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
                get_transfer_by_txid: Array.from({ length: 5 }, function () {
                    return { error: { message: "Transaction not found" } };
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
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfer_by_txid"; }).length, 5);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
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
                get_transfer_by_txid: Array.from({ length: 5 }, function () { return new Error("wallet offline"); })
            }
        });

        await harness.runtime.runCycle();

        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitted");
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_hash, txHash);
        assert.equal(harness.mysql.state.store.paymentBatches[0].tx_key, txKey);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        assert.equal(harness.mysql.state.store.payments.length, 0);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet transfer succeeded but tx search is unavailable: Error: wallet offline/);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfer_by_txid"; }).length, 5);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
    });
});
