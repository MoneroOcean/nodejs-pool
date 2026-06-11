"use strict";
const { formatFixPlanPreview } = require("./exchange_recovery_preview_common.js");

function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function formatJson(value) {
    return JSON.stringify(value);
}

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

function loadExchangeApiIfNeeded(cli, balanceOptions) {
    const hasExplicitBalance = balanceOptions.some(function hasOption(name) {
        return cli.get(name) !== null;
    });
    if (hasExplicitBalance && cli.get("active-orders") !== null) return null;
    try {
        return loadExchangeApi();
    } catch (error) {
        throw new Error(
            "Unable to load exchange API (" + error.message +
            "). Rerun with --current-balance=<balance> and --active-orders=false after confirming no open orders."
        );
    }
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

// All trade recovery scripts preview the exact cache rewrite and retain the
// deliberate ten-second operator cancellation window before applying it.
function runFixMain(buildFixPlan) {
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

module.exports = {
    asFiniteNumber,
    clone,
    formatFixPlanPreview,
    formatJson,
    getExchangeBalance,
    loadExchangeApiIfNeeded,
    parseBooleanOption,
    resolveActiveOrders,
    runFixMain
};
