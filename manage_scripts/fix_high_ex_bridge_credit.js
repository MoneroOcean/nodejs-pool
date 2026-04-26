"use strict";
const { formatFixPlanPreview } = require("./fix_trade_preview_common.js");

function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

function formatJson(value) { return JSON.stringify(value); }

function asFiniteNumber(value, message) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(message);
    return parsed;
}

function parseBooleanOption(value, message) {
    if (value === null || typeof value === "undefined") return null;
    switch (String(value).toLowerCase()) {
        case "1":
        case "true":
        case "yes":
            return true;
        case "0":
        case "false":
        case "no":
            return false;
        default:
            throw new Error(message);
    }
}

function getBridgeSymbol(tradeContext) {
    if (!tradeContext || typeof tradeContext !== "object") throw new Error("altblock_exchange_trade is not found");
    if (tradeContext.stage === "Exchange BTC trade") return "BTC";
    if (tradeContext.stage === "Exchange USDT trade") return "USDT";
    if (tradeContext.stage === "Exchange BASE trade") {
        const route = Array.isArray(tradeContext.route) ? tradeContext.route : [];
        const symbol = typeof route[1] === "string" ? route[1] : "";
        if (!symbol || symbol === "ALT" || symbol === "BTC" || symbol === "USDT" || symbol === "XMR") {
            throw new Error("altblock_exchange_trade is missing a valid BASE bridge symbol: " + formatJson(tradeContext));
        }
        return symbol;
    }
    throw new Error("altblock_exchange_trade is not at an intermediate bridge-credit stage: " + formatJson(tradeContext));
}

function buildTradeContextFix(tradeContext, currentBridgeBalance, options) {
    const currentOptions = options || {};
    const bridgeSymbol = getBridgeSymbol(tradeContext);
    const expectedIncrease = asFiniteNumber(
        tradeContext.expectedIncreases && tradeContext.expectedIncreases[bridgeSymbol],
        "altblock_exchange_trade is missing expected " + bridgeSymbol + " increase"
    );
    if (expectedIncrease <= 0) {
        throw new Error("altblock_exchange_trade has invalid expected " + bridgeSymbol + " increase: " + formatJson(tradeContext));
    }
    const baseline = asFiniteNumber(
        tradeContext.baselineBalances && tradeContext.baselineBalances[bridgeSymbol],
        "altblock_exchange_trade is missing " + bridgeSymbol + " baseline"
    );
    const currentBalance = asFiniteNumber(currentBridgeBalance, "Current exchange " + bridgeSymbol + " balance is invalid");
    if (currentBalance < baseline) {
        throw new Error(
            "Current exchange " + bridgeSymbol + " balance " + currentBalance.toFixed(8) +
            " is below stored baseline " + baseline.toFixed(8) +
            "; this script only supports credited-balance recovery"
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
            "Current exchange " + bridgeSymbol + " balance " + currentBalance.toFixed(8) +
            " does not show credited balance above the stored baseline " + baseline.toFixed(8)
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
        summary: "updated expected " + bridgeSymbol + " bridge credit to " + observedIncrease.toFixed(8)
    };
}

async function getExchangeBalance(exchangeApi, exchange, symbol) {
    try {
        return Number(await exchangeApi.get_balance(exchange, symbol)) || 0;
    } catch (error) {
        throw new Error("Can't get " + symbol + " balance on " + exchange + ": " + (error && error.message ? error.message : String(error)));
    }
}

async function getActiveOrders(exchangeApi, exchange) {
    try {
        const active = await exchangeApi.is_active_orders(exchange);
        if (active === null || typeof active === "undefined") throw new Error("active order state unavailable");
        return Boolean(active);
    } catch (error) {
        throw new Error("Can't get active order state on " + exchange + ": " + (error && error.message ? error.message : String(error)));
    }
}

function loadExchangeApi() {
    try {
        return require("../lib2/exchanges.js")();
    } catch (error) {
        throw new Error(error.message || String(error));
    }
}

async function resolveCurrentBalance(cli, tradeContext, exchangeApi, bridgeSymbol) {
    const explicit = cli.get("current-balance");
    if (explicit !== null) return asFiniteNumber(explicit, "Invalid --current-balance value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) throw new Error("altblock_exchange_trade is missing exchange name; rerun with --current-balance");
    return await getExchangeBalance(exchangeApi, exchange, bridgeSymbol);
}

async function resolveActiveOrders(cli, tradeContext, exchangeApi) {
    const explicit = cli.get("active-orders");
    if (explicit !== null) return parseBooleanOption(explicit, "Invalid --active-orders value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) {
        throw new Error("altblock_exchange_trade is missing exchange name; rerun with --active-orders=false after confirming no open orders");
    }
    return await getActiveOrders(exchangeApi, exchange);
}

async function buildFixPlan(cli, database) {
    const tradeContext = database.getCache("altblock_exchange_trade");
    if (tradeContext === false) throw new Error("altblock_exchange_trade is not found; this script only supports the refactored runtime");
    const bridgeSymbol = getBridgeSymbol(tradeContext);
    const needsExchangeApi = cli.get("current-balance") === null || cli.get("active-orders") === null;
    let exchangeApi = null;
    if (needsExchangeApi) {
        try {
            exchangeApi = loadExchangeApi();
        } catch (error) {
            throw new Error(
                "Unable to load exchange API (" + error.message +
                "). Rerun with --current-balance=<balance> and --active-orders=false after confirming no open orders."
            );
        }
    }
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

async function main() {
    const cli = require("../script_utils.js")();
    cli.init(async function run() {
        try {
            const fixPlan = await buildFixPlan(cli, global.database);
            console.log(formatFixPlanPreview(fixPlan));
            setTimeout(function applyFix() {
                global.database.setCache(fixPlan.cacheKey, fixPlan.nextValue);
                console.log("Done.");
                process.exit(0);
            }, 10 * 1000);
        } catch (error) {
            console.error(error.message || String(error));
            process.exit(1);
        }
    });
}

if (require.main === module) main();

module.exports = {
    buildTradeContextFix,
    formatFixPlanPreview,
    getBridgeSymbol
};
