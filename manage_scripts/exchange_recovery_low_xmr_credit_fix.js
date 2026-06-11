"use strict";

// Repairs altblock_exchange_trade when the final XMR buy credited less than the
// persisted expectation, usually due to precision, fees, or partial fill review.
// Use only after confirming no active exchange orders and that the observed XMR
// increase is the complete amount the exchange filled for this trade.

const {
    asFiniteNumber,
    clone,
    formatFixPlanPreview,
    formatJson,
    getExchangeBalance,
    loadExchangeApiIfNeeded,
    parseBooleanOption,
    resolveActiveOrders,
    runFixMain
} = require("./exchange_recovery_trade_common.js");

function normalizeCoinAmount(value) { return Number(asFiniteNumber(value, "Invalid coin amount").toFixed(8)); }

function buildTradeContextFix(tradeContext, currentXmrBalance, options) {
    if (!tradeContext || typeof tradeContext !== "object") throw new Error("altblock_exchange_trade is not found");
    if (tradeContext.stage !== "Exchange XMR trade") {
        throw new Error("altblock_exchange_trade is not at Exchange XMR trade stage: " + formatJson(tradeContext));
    }

    const currentOptions = options || {};
    const expectedIncrease = asFiniteNumber(
        tradeContext.expectedIncreases && tradeContext.expectedIncreases.XMR,
        "altblock_exchange_trade is missing expected XMR increase"
    );
    if (expectedIncrease <= 0) throw new Error("altblock_exchange_trade has invalid expected XMR increase: " + formatJson(tradeContext));
    const baseline = asFiniteNumber(
        tradeContext.baselineBalances && tradeContext.baselineBalances.XMR,
        "altblock_exchange_trade is missing XMR baseline"
    );

    const currentBalance = asFiniteNumber(currentXmrBalance, "Current exchange XMR balance is invalid");
    if (currentBalance < baseline) {
        throw new Error(
            "Current exchange XMR balance " + currentBalance.toFixed(8) +
            " is below the stored baseline " + baseline.toFixed(8) +
            "; use exchange_recovery_xmr_balance_fix.js for backward-balance cases"
        );
    }
    if (currentOptions.activeOrders === true) {
        throw new Error("altblock_exchange_trade still has active exchange orders; refusing to rewrite expected XMR credit");
    }

    const observedIncrease = normalizeCoinAmount(Math.max(0, currentBalance - baseline));
    if (observedIncrease <= 0) {
        throw new Error("Current exchange XMR balance has not increased above baseline: " + currentBalance.toFixed(8));
    }
    if (observedIncrease >= expectedIncrease) {
        throw new Error(
            "Observed XMR increase " + observedIncrease.toFixed(8) +
            " is not below the stored expectation " + expectedIncrease.toFixed(8) +
            "; this script is only for low-credit / precision-mismatch cases"
        );
    }
    if (currentOptions.reviewedCredit !== true) {
        throw new Error("Rerun with --confirm-reviewed-credit=true after confirming the exchange filled only the observed XMR amount");
    }

    const nextTradeContext = clone(tradeContext);
    if (!nextTradeContext.expectedIncreases || typeof nextTradeContext.expectedIncreases !== "object") {
        nextTradeContext.expectedIncreases = {};
    }
    nextTradeContext.expectedIncreases.XMR = observedIncrease;

    return {
        cacheKey: "altblock_exchange_trade",
        currentValue: clone(tradeContext),
        nextValue: nextTradeContext,
        summary: "rewrote expected XMR increase from " + expectedIncrease.toFixed(8) + " to " + observedIncrease.toFixed(8)
    };
}

async function resolveCurrentXmrBalance(cli, tradeContext, exchangeApi) {
    const explicit = cli.get("current-balance", cli.get("current-xmr-balance"));
    if (explicit !== null) return asFiniteNumber(explicit, "Invalid --current-balance value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) throw new Error("altblock_exchange_trade is missing exchange name; rerun with --current-balance");
    return await getExchangeBalance(exchangeApi, exchange, "XMR");
}

async function buildFixPlan(cli, database) {
    const tradeContext = database.getCache("altblock_exchange_trade");
    if (tradeContext !== false) {
        const exchangeApi = loadExchangeApiIfNeeded(cli, ["current-balance", "current-xmr-balance"]);
        const currentXmrBalance = await resolveCurrentXmrBalance(cli, tradeContext, exchangeApi);
        const activeOrders = await resolveActiveOrders(cli, tradeContext, exchangeApi);
        const reviewedCredit = parseBooleanOption(
            cli.get("confirm-reviewed-credit"),
            "Invalid --confirm-reviewed-credit value"
        ) === true;
        return buildTradeContextFix(tradeContext, currentXmrBalance, {
            activeOrders,
            reviewedCredit
        });
    }
    throw new Error("altblock_exchange_trade is not found; this script only supports the refactored runtime");
}

function main() { runFixMain(buildFixPlan); }

if (require.main === module) main();

module.exports = {
    buildTradeContextFix,
    formatFixPlanPreview,
    main
};
