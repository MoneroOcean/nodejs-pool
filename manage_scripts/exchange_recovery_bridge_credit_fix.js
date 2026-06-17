"use strict";

// Repairs altblock_exchange_trade when an intermediate bridge asset
// (BASE/BTC/USDT) credited differently than the persisted expectation.
// Use only after confirming no active exchange orders and verifying the current
// bridge balance belongs to the stuck trade.

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

function getBridgeSymbol(tradeContext) {
    if (!tradeContext || typeof tradeContext !== "object") throw new Error("altblock_exchange_trade is not found");
    if (tradeContext.stage === "Exchange BTC trade") return "BTC";
    if (tradeContext.stage === "Exchange USDT trade") return "USDT";
    if (tradeContext.stage === "Exchange BASE trade") {
        const route = Array.isArray(tradeContext.route) ? tradeContext.route : [];
        const symbol = typeof route[1] === "string" ? route[1] : "";
        if (!symbol || symbol === "ALT" || symbol === "BTC" || symbol === "USDT" || symbol === "XMR") {
            throw new Error(`altblock_exchange_trade is missing a valid BASE bridge symbol: ${  formatJson(tradeContext)}`);
        }
        return symbol;
    }
    throw new Error(`altblock_exchange_trade is not at an intermediate bridge-credit stage: ${  formatJson(tradeContext)}`);
}

function buildTradeContextFix(tradeContext, currentBridgeBalance, options) {
    const currentOptions = options || {};
    const bridgeSymbol = getBridgeSymbol(tradeContext);
    const expectedIncrease = asFiniteNumber(
        tradeContext.expectedIncreases && tradeContext.expectedIncreases[bridgeSymbol],
        `altblock_exchange_trade is missing expected ${  bridgeSymbol  } increase`
    );
    if (expectedIncrease <= 0) {
        throw new Error(`altblock_exchange_trade has invalid expected ${  bridgeSymbol  } increase: ${  formatJson(tradeContext)}`);
    }
    const baseline = asFiniteNumber(
        tradeContext.baselineBalances && tradeContext.baselineBalances[bridgeSymbol],
        `altblock_exchange_trade is missing ${  bridgeSymbol  } baseline`
    );
    const currentBalance = asFiniteNumber(currentBridgeBalance, `Current exchange ${  bridgeSymbol  } balance is invalid`);
    if (currentBalance < baseline) {
        throw new Error(
            `Current exchange ${  bridgeSymbol  } balance ${  currentBalance.toFixed(8) 
            } is below stored baseline ${  baseline.toFixed(8) 
            }; this script only supports credited-balance recovery`
        );
    }
    if (currentOptions.activeOrders === true) {
        throw new Error("altblock_exchange_trade still has active exchange orders; refusing to rewrite bridge credit");
    }
    if (currentOptions.reviewedCredit !== true) {
        throw new Error("Rerun with --confirm-reviewed-credit=true after verifying the current bridge balance belongs to this trade");
    }
    const observedIncrease = currentBalance - baseline;
    if (observedIncrease <= 0) {
        throw new Error(
            `Current exchange ${  bridgeSymbol  } balance ${  currentBalance.toFixed(8) 
            } does not show credited balance above the stored baseline ${  baseline.toFixed(8)}`
        );
    }

    const nextTradeContext = clone(tradeContext);
    if (!nextTradeContext.expectedIncreases || typeof nextTradeContext.expectedIncreases !== "object") {
        nextTradeContext.expectedIncreases = {};
    }
    nextTradeContext.expectedIncreases[bridgeSymbol] = observedIncrease;

    return {
        cacheKey: "altblock_exchange_trade",
        currentValue: clone(tradeContext),
        nextValue: nextTradeContext,
        summary: `updated expected ${  bridgeSymbol  } bridge credit to ${  observedIncrease.toFixed(8)}`
    };
}

async function resolveCurrentBalance(cli, tradeContext, exchangeApi, bridgeSymbol) {
    const explicit = cli.get("current-balance");
    if (explicit !== null) return asFiniteNumber(explicit, "Invalid --current-balance value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) throw new Error("altblock_exchange_trade is missing exchange name; rerun with --current-balance");
    return await getExchangeBalance(exchangeApi, exchange, bridgeSymbol);
}

async function buildFixPlan(cli, database) {
    const tradeContext = database.getCache("altblock_exchange_trade");
    if (tradeContext === false) throw new Error("altblock_exchange_trade is not found; this script only supports the refactored runtime");
    const bridgeSymbol = getBridgeSymbol(tradeContext);
    const exchangeApi = loadExchangeApiIfNeeded(cli, ["current-balance"]);
    const currentBalance = await resolveCurrentBalance(cli, tradeContext, exchangeApi, bridgeSymbol);
    const activeOrders = await resolveActiveOrders(cli, tradeContext, exchangeApi);
    const reviewedCredit = parseBooleanOption(
        cli.get("confirm-reviewed-credit"),
        "Invalid --confirm-reviewed-credit value"
    ) === true;
    return buildTradeContextFix(tradeContext, currentBalance, {
        activeOrders,
        reviewedCredit
    });
}

function main() { runFixMain(buildFixPlan); }

if (require.main === module) main();

module.exports = {
    buildTradeContextFix,
    formatFixPlanPreview,
    getBridgeSymbol,
    main
};
