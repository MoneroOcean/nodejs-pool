"use strict";
const { formatFixPlanPreview } = require("./exchange_recovery_preview_common.js");

/** @typedef {ReturnType<typeof import("../lib2/exchanges.js")>} ExchangeApi */
/** @typedef {{stage: string, exchange: string, route: string[], baselineBalances: Record<string, number>, expectedIncreases: Record<string, number>, [field: string]: unknown}} TradeContext */

/**
 * Cache contents are a system boundary. Normalize absent metadata here, so
 * recovery calculations consume definite records rather than optional fields.
 * @param {unknown} value
 * @returns {TradeContext}
 */
function requireTradeContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("altblock_exchange_trade is not found");
    if (!("stage" in value) || typeof value.stage !== "string") throw new Error("altblock_exchange_trade has no stage");
    const exchange = "exchange" in value && typeof value.exchange === "string" ? value.exchange : "";
    const route = "route" in value && Array.isArray(value.route) ? value.route.filter((item) => typeof item === "string") : [];
    const baselineBalances = numberRecord("baselineBalances" in value ? value.baselineBalances : null);
    const expectedIncreases = numberRecord("expectedIncreases" in value ? value.expectedIncreases : null);
    return { ...value, stage: value.stage, exchange, route, baselineBalances, expectedIncreases };
}

/** @param {unknown} value @returns {Record<string, number>} */
function numberRecord(value) {
    /** @type {Record<string, number>} */
    const record = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return record;
    for (const [key, amount] of Object.entries(value)) {
        record[key] = asFiniteNumber(amount, `Invalid stored balance for ${key}`);
    }
    return record;
}


/** @template T @param {T} value @returns {T} */
function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value */
function formatJson(value) {
    return JSON.stringify(value) ?? "null";
}

/** @param {unknown} value @param {string} message */
function asFiniteNumber(value, message) {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) throw new Error(message);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(message);
    return parsed;
}

/** @param {unknown} value @param {string} message @returns {boolean | null} */
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

/** @param {ExchangeApi | null} exchangeApi @param {string} exchange @param {string} symbol @returns {Promise<number>} */
async function getExchangeBalance(exchangeApi, exchange, symbol) {
    try {
        if (!exchangeApi) throw new Error("exchange API unavailable");
        return asFiniteNumber(await exchangeApi.get_balance(exchange, symbol), "Invalid exchange balance");
    } catch (error) {
        throw new Error(`Can't get ${  symbol  } balance on ${  exchange  }: ${  error instanceof Error ? error.message : String(error)}`);
    }
}

/** @param {ExchangeApi | null} exchangeApi @param {string} exchange @returns {Promise<boolean>} */
async function getActiveOrders(exchangeApi, exchange) {
    try {
        if (!exchangeApi) throw new Error("exchange API unavailable");
        const active = await exchangeApi.is_active_orders(exchange);
        if (active === null || typeof active === "undefined") throw new Error("active order state unavailable");
        return Boolean(active);
    } catch (error) {
        throw new Error(`Can't get active order state on ${  exchange  }: ${  error instanceof Error ? error.message : String(error)}`);
    }
}

/** @param {import("../script_utils.js").Cli} cli @param {string[]} balanceOptions @returns {ExchangeApi | null} */
function loadExchangeApiIfNeeded(cli, balanceOptions) {
    const hasExplicitBalance = balanceOptions.some(function hasOption(name) {
        return cli.get(name) !== null;
    });
    if (hasExplicitBalance && cli.get("active-orders") !== null) return null;
    try {
        return require("../lib2/exchanges.js")();
    } catch (error) {
        throw new Error(
            `Unable to load exchange API (${  (error instanceof Error ? error.message : String(error))
            }). Rerun with --current-balance=<balance> and --active-orders=false after confirming no open orders.`
        );
    }
}

/** @param {import("../script_utils.js").Cli} cli @param {TradeContext} tradeContext @param {ExchangeApi | null} exchangeApi @returns {Promise<boolean | null>} */
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
/** @param {(cli: import("../script_utils.js").Cli, database: import("../types/runtime").DatabaseRuntime) => Promise<import("./exchange_recovery_preview_common.js").FixPlan>} buildFixPlan */
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
            console.error((error instanceof Error ? error.message : String(error)));
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
    runFixMain,
    requireTradeContext
};
