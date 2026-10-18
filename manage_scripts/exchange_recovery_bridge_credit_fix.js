"use strict";

// Repairs altblock_exchange_trade when an intermediate bridge asset
// (BASE/BTC/USDT) credited differently than the persisted expectation.
// Use only after confirming no active exchange orders and verifying the current
// bridge balance belongs to the stuck trade.
// A missing legacy expectation additionally requires the net bridge credit from
// reviewed exchange fill records. A stale or snapshot baseline must be supplied
// explicitly from those records as well.

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

/** @param {unknown} input */
function getBridgeSymbol(input) {
    const tradeContext = requireTradeContext(input);
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

/** @param {unknown} input @param {unknown} currentBridgeBalance @param {{activeOrders?: boolean | null, reviewedCredit?: boolean, expectedIncrease?: unknown, baselineBalance?: unknown}} [options] @returns {import("./exchange_recovery_preview_common.js").FixPlan} */
function buildTradeContextFix(input, currentBridgeBalance, options) {
    const tradeContext = requireTradeContext(input);
    const currentOptions = options || {};
    const bridgeSymbol = getBridgeSymbol(tradeContext);
    const storedIncrease = tradeContext.expectedIncreases[bridgeSymbol];
    const expectedIncrease = typeof storedIncrease === "undefined" ? 0 : asFiniteNumber(
        storedIncrease,
        `altblock_exchange_trade has invalid expected ${  bridgeSymbol  } increase`
    );
    if (expectedIncrease < 0) {
        throw new Error(`altblock_exchange_trade has invalid expected ${  bridgeSymbol  } increase: ${  formatJson(tradeContext)}`);
    }
    const restoringExpectation = expectedIncrease === 0;
    const suppliedIncrease = currentOptions.expectedIncrease;
    const hasSuppliedIncrease = suppliedIncrease !== null && typeof suppliedIncrease !== "undefined";
    const suppliedBaseline = currentOptions.baselineBalance;
    const hasSuppliedBaseline = suppliedBaseline !== null && typeof suppliedBaseline !== "undefined";
    if (restoringExpectation && !hasSuppliedIncrease) {
        throw new Error(`Missing expected ${bridgeSymbol} increase; supply --expected-increase=<net credit> only after verifying exchange fill records`);
    }
    if (!restoringExpectation && (hasSuppliedIncrease || hasSuppliedBaseline)) {
        throw new Error("--expected-increase and --baseline-balance only support a missing or zero bridge expectation");
    }
    const verifiedIncrease = restoringExpectation
        ? asFiniteNumber(suppliedIncrease, "Invalid --expected-increase value")
        : expectedIncrease;
    if (verifiedIncrease <= 0) throw new Error("--expected-increase must be positive");
    if (tradeContext["recoverySource"] === "balance_snapshot" && !hasSuppliedBaseline) {
        throw new Error("Balance snapshot recovery requires --baseline-balance=<verified pre-fill balance>");
    }
    if (tradeContext["submitPending"]) {
        throw new Error("altblock_exchange_trade has an unresolved pending submit; refusing to rewrite bridge credit");
    }
    const baseline = asFiniteNumber(
        hasSuppliedBaseline ? suppliedBaseline : tradeContext.baselineBalances[bridgeSymbol],
        `altblock_exchange_trade is missing ${  bridgeSymbol  } baseline`
    );
    if (baseline < 0) throw new Error("Bridge baseline must be nonnegative");
    const currentBalance = asFiniteNumber(currentBridgeBalance, `Current exchange ${  bridgeSymbol  } balance is invalid`);
    if (currentBalance < baseline) {
        throw new Error(
            `Current exchange ${  bridgeSymbol  } balance ${  currentBalance.toFixed(8) 
            } is below stored baseline ${  baseline.toFixed(8) 
            }; this script only supports credited-balance recovery`
        );
    }
    if (currentOptions.activeOrders !== false) {
        throw new Error("Confirm no active exchange orders before rewriting bridge credit");
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
    if (restoringExpectation) {
        // Permit floating-point cancellation, not an unexplained account credit.
        const tolerance = Math.max(1e-8,
            Number.EPSILON * Math.max(Math.abs(currentBalance), Math.abs(baseline)) * 8);
        if (Math.abs(observedIncrease - verifiedIncrease) > tolerance) {
            throw new Error(`Observed ${bridgeSymbol} increase ${observedIncrease} does not match verified fill credit ${verifiedIncrease}`);
        }
    }

    const nextTradeContext = clone(tradeContext);
    const repairedIncrease = restoringExpectation ? verifiedIncrease : observedIncrease;
    nextTradeContext.expectedIncreases[bridgeSymbol] = repairedIncrease;
    if (hasSuppliedBaseline) nextTradeContext.baselineBalances[bridgeSymbol] = baseline;
    if (restoringExpectation) nextTradeContext["recoverySource"] = "reviewed_fill_records";

    return {
        cacheKey: "altblock_exchange_trade",
        currentValue: clone(input),
        nextValue: nextTradeContext,
        summary: `updated expected ${  bridgeSymbol  } bridge credit to ${  repairedIncrease.toFixed(8)}`
    };
}

/** @param {import("../script_utils.js").Cli} cli @param {import("./exchange_recovery_trade_common.js").TradeContext} tradeContext @param {import("./exchange_recovery_trade_common.js").ExchangeApi | null} exchangeApi @param {string} bridgeSymbol @returns {Promise<number>} */
async function resolveCurrentBalance(cli, tradeContext, exchangeApi, bridgeSymbol) {
    const explicit = cli.get("current-balance");
    if (explicit !== null) return asFiniteNumber(explicit, "Invalid --current-balance value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) throw new Error("altblock_exchange_trade is missing exchange name; rerun with --current-balance");
    return await getExchangeBalance(exchangeApi, exchange, bridgeSymbol);
}

/** @param {import("../script_utils.js").Cli} cli @param {import("../types/runtime").LocalDatabaseRuntime} database @returns {Promise<import("./exchange_recovery_preview_common.js").FixPlan>} */
async function buildFixPlan(cli, database) {
    const cachedContext = database.getCache("altblock_exchange_trade");
    const tradeContext = requireTradeContext(cachedContext);
    if (cachedContext === false) throw new Error("altblock_exchange_trade is not found; this script only supports the refactored runtime");
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
        reviewedCredit,
        expectedIncrease: cli.get("expected-increase"),
        baselineBalance: cli.get("baseline-balance")
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
