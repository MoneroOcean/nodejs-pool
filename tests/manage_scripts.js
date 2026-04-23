"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const accountUtils = require("../script_account_utils.js");
const fixExchangeXmrBalance = require("../manage_scripts/fix_negative_ex_xmr_balance.js");

test.describe("manage_scripts", { concurrency: false }, function suite() {
    test("account utils build parameterized payment clauses", function testPaymentWhere() {
        assert.deepEqual(accountUtils.paymentWhere({ address: "addr", paymentId: "pid" }, false), {
            clause: "payment_address = ? AND payment_id = ?",
            params: ["addr", "pid"]
        });
        assert.deepEqual(accountUtils.paymentWhere({ address: "addr", paymentId: null }, true), {
            clause: "payment_address = ? AND (payment_id IS NULL OR payment_id = '')",
            params: ["addr"]
        });
    });

    test("account utils reject malformed user strings", function testSplitUserValidation() {
        assert.throws(function onMalformedUser() {
            accountUtils.splitUser("addr.pid.extra");
        }, /address>\.<paymentId>/);
        assert.throws(function onEmptyPaymentId() {
            accountUtils.splitUser("addr.");
        }, /address>\.<paymentId>/);
    });

    test("refactored trade-context fix aligns XMR baseline to the current exchange balance", function testTradeContextFix() {
        const plan = fixExchangeXmrBalance.buildTradeContextFix({
            blockId: 12,
            exchange: "nonkyc",
            stage: "Exchange XMR trade",
            baselineBalances: { XMR: 4.5 },
            expectedIncreases: { XMR: 0.75 }
        }, 0, { activeOrders: false });

        assert.equal(plan.cacheKey, "altblock_exchange_trade");
        assert.equal(plan.nextValue.baselineBalances.XMR, -0.75);
        assert.equal(plan.nextValue.expectedIncreases.XMR, 0.75);
    });

    test("refactored trade-context fix refuses non-XMR trade stages", function testWrongStage() {
        assert.throws(function onWrongStage() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange BTC trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 0, { activeOrders: false });
        }, /Exchange XMR trade stage/);
    });

    test("refactored trade-context fix refuses while exchange orders are still active", function testActiveOrders() {
        assert.throws(function onActiveOrders() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 0, { activeOrders: true });
        }, /active exchange orders/);
    });

    test("refactored trade-context fix refuses balances above the stored baseline", function testHigherBalance() {
        assert.throws(function onHigherBalance() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 1.2, { activeOrders: false });
        }, /above stored baseline/);
    });

    test("refactored trade-context fix requires confirmation when balance matches stored baseline", function testSameBalanceNeedsConfirmation() {
        assert.throws(function onSameBalance() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 0 },
                expectedIncreases: { XMR: 0.5 }
            }, 0, { activeOrders: false });
        }, /confirm-manual-withdrawal/);
    });

    test("refactored trade-context fix allows confirmed zero-balance withdrawal recovery", function testConfirmedSameBalance() {
        const plan = fixExchangeXmrBalance.buildTradeContextFix({
            stage: "Exchange XMR trade",
            baselineBalances: { XMR: 0 },
            expectedIncreases: { XMR: 0.5 }
        }, 0, {
            activeOrders: false,
            manualWithdrawalConfirmed: true
        });

        assert.equal(plan.nextValue.baselineBalances.XMR, -0.5);
    });
});
