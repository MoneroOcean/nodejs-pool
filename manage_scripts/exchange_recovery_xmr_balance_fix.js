"use strict";

// Repairs altblock_exchange_trade when final XMR settlement is stuck because
// the exchange XMR balance moved backward or was manually withdrawn.
// Use only after confirming no active exchange orders and that the current XMR
// balance should become the new settlement reference.

const {
    asFiniteNumber,
    clone,
    formatFixPlanPreview,
    formatJson,
    getExchangeBalance,
    loadExchangeApiIfNeeded,
    parseBooleanOption,
    resolveActiveOrders,
    runFixMain,
    requireTradeContext
} = require("./exchange_recovery_trade_common.js");

/** @param {unknown} input @param {unknown} currentXmrBalance @param {{activeOrders?: boolean | null, reviewedCredit?: boolean, manualWithdrawalConfirmed?: boolean}} [options] @returns {import("./exchange_recovery_preview_common.js").FixPlan} */
function buildTradeContextFix(input, currentXmrBalance, options) {
    const tradeContext = requireTradeContext(input);
    if (tradeContext.stage !== "Exchange XMR trade") {
        throw new Error(`altblock_exchange_trade is not at Exchange XMR trade stage: ${  formatJson(tradeContext)}`);
    }

    const currentOptions = options || {};
    const expectedIncrease = asFiniteNumber(
        tradeContext.expectedIncreases["XMR"],
        "altblock_exchange_trade is missing expected XMR increase"
    );
    if (expectedIncrease <= 0) throw new Error(`altblock_exchange_trade has invalid expected XMR increase: ${  formatJson(tradeContext)}`);
    const baseline = asFiniteNumber(
        tradeContext.baselineBalances["XMR"],
        "altblock_exchange_trade is missing XMR baseline"
    );

    const currentBalance = asFiniteNumber(currentXmrBalance, "Current exchange XMR balance is invalid");
    if (currentBalance < 0) throw new Error(`Current exchange XMR balance is invalid: ${  currentBalance}`);
    if (currentOptions.activeOrders === true) {
        throw new Error("altblock_exchange_trade still has active exchange orders; refusing to rewrite XMR baseline");
    }
    if (currentBalance > baseline) {
        throw new Error(
            `Current exchange XMR balance ${  currentBalance.toFixed(8) 
            } is above stored baseline ${  baseline.toFixed(8) 
            }; this script is only for manual withdrawal/backward-balance cases`
        );
    }
    if (currentBalance === baseline && currentOptions.manualWithdrawalConfirmed !== true) {
        throw new Error(
            "Current exchange XMR balance matches the stored baseline; rerun with --confirm-manual-withdrawal=true if you already moved XMR off exchange"
        );
    }

    const nextTradeContext = clone(tradeContext);
    nextTradeContext.baselineBalances["XMR"] = currentBalance - expectedIncrease;

    return {
        cacheKey: "altblock_exchange_trade",
        currentValue: clone(input),
        nextValue: nextTradeContext,
        summary: `refactored altblock_exchange_trade path with current XMR balance ${  currentBalance.toFixed(8)}`
    };
}

/** @param {import("../script_utils.js").Cli} cli @param {import("./exchange_recovery_trade_common.js").TradeContext} tradeContext @param {import("./exchange_recovery_trade_common.js").ExchangeApi | null} exchangeApi @returns {Promise<number>} */
async function resolveCurrentXmrBalance(cli, tradeContext, exchangeApi) {
    const explicit = cli.get("current-balance", cli.get("current-xmr-balance"));
    if (explicit !== null) return asFiniteNumber(explicit, "Invalid --current-balance value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) throw new Error("altblock_exchange_trade is missing exchange name; rerun with --current-balance");
    return await getExchangeBalance(exchangeApi, exchange, "XMR");
}

/** @param {import("../script_utils.js").Cli} cli @param {import("../types/runtime").LocalDatabaseRuntime} database @returns {Promise<import("./exchange_recovery_preview_common.js").FixPlan>} */
async function buildFixPlan(cli, database) {
    const cachedContext = database.getCache("altblock_exchange_trade");
    const tradeContext = requireTradeContext(cachedContext);
    if (cachedContext !== false) {
        const exchangeApi = loadExchangeApiIfNeeded(cli, ["current-balance", "current-xmr-balance"]);
        const currentXmrBalance = await resolveCurrentXmrBalance(cli, tradeContext, exchangeApi);
        const activeOrders = await resolveActiveOrders(cli, tradeContext, exchangeApi);
        const manualWithdrawalConfirmed = parseBooleanOption(
            cli.get("confirm-manual-withdrawal"),
            "Invalid --confirm-manual-withdrawal value"
        ) === true;
        return buildTradeContextFix(tradeContext, currentXmrBalance, {
            activeOrders,
            manualWithdrawalConfirmed
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
