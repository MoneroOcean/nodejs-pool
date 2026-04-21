"use strict";

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
    if (currentBalance < 0) throw new Error("Current exchange XMR balance is invalid: " + currentBalance);
    if (currentOptions.activeOrders === true) {
        throw new Error("altblock_exchange_trade still has active exchange orders; refusing to rewrite XMR baseline");
    }
    if (currentBalance > baseline) {
        throw new Error(
            "Current exchange XMR balance " + currentBalance.toFixed(8) +
            " is above stored baseline " + baseline.toFixed(8) +
            "; this script is only for manual withdrawal/backward-balance cases"
        );
    }
    if (currentBalance === baseline && currentOptions.manualWithdrawalConfirmed !== true) {
        throw new Error(
            "Current exchange XMR balance matches the stored baseline; rerun with --confirm-manual-withdrawal=true if you already moved XMR off exchange"
        );
    }

    const nextTradeContext = clone(tradeContext);
    if (!nextTradeContext.baselineBalances || typeof nextTradeContext.baselineBalances !== "object") {
        nextTradeContext.baselineBalances = {};
    }
    nextTradeContext.baselineBalances.XMR = currentBalance - expectedIncrease;

    return {
        cacheKey: "altblock_exchange_trade",
        currentValue: clone(tradeContext),
        nextValue: nextTradeContext,
        summary: "refactored altblock_exchange_trade path with current XMR balance " + currentBalance.toFixed(8)
    };
}

function getExchangeBalance(exchangeApi, exchange, symbol) {
    return new Promise(function onBalance(resolve, reject) {
        exchangeApi.get_balance(exchange, symbol, function onSuccess(balance) {
            resolve(Number(balance) || 0);
        }, function onError(error) {
            reject(new Error("Can't get " + symbol + " balance on " + exchange + ": " + (error ? JSON.stringify(error) : "unknown error")));
        });
    });
}

function getActiveOrders(exchangeApi, exchange) {
    return new Promise(function onOrders(resolve, reject) {
        exchangeApi.is_active_orders(exchange, function onResult(active) {
            if (active === null || typeof active === "undefined") {
                return reject(new Error("Can't get active order state on " + exchange));
            }
            resolve(Boolean(active));
        });
    });
}

function loadExchangeApi() {
    try {
        return require("../lib2/exchanges.js")();
    } catch (error) {
        throw new Error(error.message || String(error));
    }
}

async function resolveCurrentXmrBalance(cli, tradeContext, exchangeApi) {
    const explicit = cli.get("current-xmr-balance");
    if (explicit !== null) return asFiniteNumber(explicit, "Invalid --current-xmr-balance value");
    const exchange = String((tradeContext && tradeContext.exchange) || "");
    if (!exchange) throw new Error("altblock_exchange_trade is missing exchange name; rerun with --current-xmr-balance");
    return await getExchangeBalance(exchangeApi, exchange, "XMR");
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
    if (tradeContext !== false) {
        const needsExchangeApi = cli.get("current-xmr-balance") === null || cli.get("active-orders") === null;
        let exchangeApi = null;
        if (needsExchangeApi) {
            try {
                exchangeApi = loadExchangeApi();
            } catch (error) {
                throw new Error(
                    "Unable to load exchange API (" + error.message +
                    "). Rerun with --current-xmr-balance=<balance> and --active-orders=false after confirming no open orders."
                );
            }
        }
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

async function main() {
    const cli = require("../script_utils.js")();
    cli.init(async function run() {
        try {
            const fixPlan = await buildFixPlan(cli, global.database);
            console.log(
                "In 10 seconds is going to change " + fixPlan.cacheKey +
                " from " + formatJson(fixPlan.currentValue) +
                " into " + formatJson(fixPlan.nextValue) +
                " (" + fixPlan.summary + ")"
            );
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
    buildTradeContextFix
};
