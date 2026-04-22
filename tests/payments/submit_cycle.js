"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    COIN,
    INTEGRATED,
    STANDARD_A,
    captureConsole,
    createHarness,
    txTransferRecord
} = require("./common/fixtures");

test.describe("submit cycle", { concurrency: false }, function submitCycleSuite() {
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
                        : method === "get_transfer_by_txid"
                            ? {
                                result: {
                                    transfer: txTransferRecord(harness.clock, [{ address: INTEGRATED, amount: transferItemAmount }], {
                                        fee: transferFee,
                                        txid: "a".repeat(64)
                                    }),
                                    transfers: [txTransferRecord(harness.clock, [{ address: INTEGRATED, amount: transferItemAmount }], {
                                        fee: transferFee,
                                        txid: "a".repeat(64)
                                    })]
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
                get_transfer_by_txid: [
                    { error: { message: "Transaction not found" } },
                    function replyTransfer() {
                        return {
                            result: {
                                transfer: txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                    fee: transferFee,
                                    txid: txHash
                                }),
                                transfers: [txTransferRecord(harness.clock, [{ address: STANDARD_A, amount: transferItemAmount }], {
                                    fee: transferFee,
                                    txid: txHash
                                })]
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
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfer_by_txid"; }).length, 2);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 0);
        assert.equal(harness.mysql.state.store.transactions[0].transaction_hash, txHash);
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

    test("not enough unlocked money checks wallet history before holding the claimed batch", async () => {
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
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.notEqual(harness.mysql.state.store.paymentBatches[0].submit_started_at, null);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
        const historyCalls = harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; });
        assert.equal(historyCalls.length, 5);
        assert.equal(harness.wallet.calls.filter(function isHeights(call) { return call.method === "get_height"; }).length, 5);
        assert.deepEqual(historyCalls[0].params, {
            out: true,
            pending: true,
            pool: true,
            filter_by_height: true,
            min_height: 3655400 - 31 * 24 * 30,
            max_height: 3655400
        });
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet submit failed after claim with no wallet match yet: not enough unlocked money/);
        assert.equal(harness.database.getCache("lastPaymentCycle"), undefined);
    });

    test("daemon rejection with no wallet match holds the claimed batch for later reconcile", async () => {
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
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.notEqual(harness.mysql.state.store.paymentBatches[0].submit_started_at, null);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.wallet.calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length, 5);
        assert.match(harness.mysql.state.store.paymentBatches[0].last_error_text, /wallet submit failed after claim with no wallet match yet: transaction was rejected by daemon/);
        assert.equal(harness.mysql.state.store.transactions.length, 0);
    });

    test("guarded post-claim hold does not regress a batch another runtime already finalized", async () => {
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
                    if (!sql.startsWith("UPDATE payment_batches SET last_reconciled_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND status = ?")) return false;
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

    test("a held submitting batch clears through reconcile before the next payout submits", async () => {
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
                get_transfers: function replyTransfers(_params, calls) {
                    const transferCalls = calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length;
                    const historyChecks = calls.filter(function isTransfers(call) { return call.method === "get_transfers"; }).length;
                    if (transferCalls === 1 && historyChecks <= 5) return { result: { out: [], pending: [], pool: [] } };
                    if (transferCalls === 1) {
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
                    }
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
                },
                get_transfer_by_txid(params) {
                    if (params.txid !== integratedTxHash) return { error: { message: "Unknown txid " + params.txid } };
                    return {
                        result: {
                            transfer: txTransferRecord(harness.clock, [{ address: INTEGRATED, amount: integratedTransferAmount }], {
                                fee: 300000000,
                                txid: integratedTxHash
                            }),
                            transfers: [txTransferRecord(harness.clock, [{ address: INTEGRATED, amount: integratedTransferAmount }], {
                                fee: 300000000,
                                txid: integratedTxHash
                            })]
                        }
                    };
                }
            }
        });
        const plannedBatches = await harness.runtime.planBatches();
        const bulkTransferAmount = plannedBatches[0].items[0].netAmount;
        const integratedTransferAmount = plannedBatches[1].items[0].netAmount;

        await harness.runtime.runCycle();
        assert.equal(harness.mysql.state.store.paymentBatches.length, 1);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "submitting");
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, 1);
        assert.equal(harness.mysql.state.store.balances[1].pending_batch_id, null);
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 1);

        harness.clock.advance(10 * 60 * 1000 + 1000);
        await harness.runtime.runCycle();
        assert.equal(harness.wallet.calls.filter(function isTransfer(call) { return call.method === "transfer"; }).length, 2);
        assert.equal(harness.mysql.state.store.paymentBatches.length, 2);
        assert.equal(harness.mysql.state.store.paymentBatches[0].status, "finalized");
        assert.equal(harness.mysql.state.store.paymentBatches[1].status, "submitted");
        assert.equal(harness.mysql.state.store.transactions.length, 1);
        assert.equal(harness.mysql.state.store.balances[0].pending_batch_id, null);
        assert.equal(harness.mysql.state.store.balances[1].pending_batch_id, 2);
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
});
