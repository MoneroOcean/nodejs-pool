"use strict";

// Lists or clears altblock_exchange_wallet entries.
// Use this when a wallet RPC submit was ambiguous and altblock_exchange is
// waiting for wallet-balance evidence before retrying or requiring review.
// This is not for exchange-posted deposits; use
// exchange_recovery_deposit_clear.js for deposit-guard waits.

const cli = require("../script_utils.js")();
const coinDefs = require("../lib2/coins.js")().COINS;

const CACHE_KEY = "altblock_exchange_wallet";
const portArg = cli.get("port", null);
const clear = cli.get("clear", false) === true;

function parseBooleanOption(value) {
    if (value === null || typeof value === "undefined") return false;
    switch (String(value).toLowerCase()) {
        case "1":
        case "true":
        case "yes":
            return true;
        default:
            return false;
    }
}

function formatCoin(port) {
    if (global.coinFuncs && typeof global.coinFuncs.PORT2COIN_FULL === "function") {
        return global.coinFuncs.PORT2COIN_FULL(Number(port));
    }
    return String(port);
}

function normalizePendingCache(value) {
    return value && typeof value === "object" ? Object.assign(Object.create(null), value) : Object.create(null);
}

function formatWalletBalance(entry, port) {
    const balance = Number(entry && entry.walletBalance);
    if (!Number.isFinite(balance)) return "unknown";
    const coinDef = coinDefs[String(port)];
    if (!coinDef || !coinDef.divisor) return String(balance);
    return (balance / coinDef.divisor).toFixed(8);
}

function buildBlockLookup() {
    const lookup = new Map();
    cli.forEachBinaryEntry(global.database.altblockDB, function onEntry(_key, data) {
        const block = global.protos.AltBlock.decode(data);
        lookup.set(Number(block.id), block);
    });
    return lookup;
}

function summarizeEntry(port, entry, blockLookup) {
    const ids = Array.isArray(entry && entry.blockIds) ? entry.blockIds.map(Number).filter(Number.isFinite) : [];
    const blocks = ids.map(function mapId(id) { return blockLookup.get(id); }).filter(Boolean);
    const heights = blocks.map(function mapBlock(block) { return Number(block.height); }).filter(Number.isFinite).sort(function sort(a, b) { return a - b; });
    const firstHeight = heights.length ? heights[0] : null;
    const lastHeight = heights.length ? heights[heights.length - 1] : null;
    return {
        port: String(port),
        coin: formatCoin(port),
        blocks: ids.length,
        created_at: Number(entry && entry.createdAt) ? new Date(Number(entry.createdAt)).toISOString() : "unknown",
        wallet_balance: formatWalletBalance(entry, port),
        first_height: firstHeight,
        last_height: lastHeight
    };
}

function printSummary(summary) {
    console.log(
        "coin=" + summary.coin +
        " port=" + summary.port +
        " blocks=" + summary.blocks +
        " created_at=" + summary.created_at +
        " wallet_balance=" + summary.wallet_balance +
        (summary.first_height !== null ? " first_height=" + summary.first_height : "") +
        (summary.last_height !== null ? " last_height=" + summary.last_height : "")
    );
}

function main() {
    cli.init(function onInit() {
        const pending = normalizePendingCache(global.database.getCache(CACHE_KEY));
        const blockLookup = buildBlockLookup();
        const targetPort = portArg ? String(portArg) : null;

        if (clear) {
            if (!targetPort) {
                console.error("Please specify --port when using --clear");
                process.exit(1);
            }
            const entry = pending[targetPort];
            if (!entry) {
                console.error("No pending altblock_exchange wallet entry for port " + targetPort);
                process.exit(1);
            }
            if (!parseBooleanOption(cli.get("confirm-reviewed-wallet"))) {
                console.error("Rerun with --confirm-reviewed-wallet=true after confirming the ambiguous wallet send state is safe to clear.");
                process.exit(1);
            }
            const summary = summarizeEntry(targetPort, entry, blockLookup);
            delete pending[targetPort];
            global.database.setCache(CACHE_KEY, pending);
            console.log("Cleared altblock_exchange wallet pending entry:");
            printSummary(summary);
            console.log("Running altblock_exchange will pick this up on the next cycle.");
            process.exit(0);
        }

        if (targetPort) {
            const entry = pending[targetPort];
            if (!entry) {
                console.error("No pending altblock_exchange wallet entry for port " + targetPort);
                process.exit(1);
            }
            printSummary(summarizeEntry(targetPort, entry, blockLookup));
            process.exit(0);
        }

        const ports = Object.keys(pending).sort(function sortPorts(left, right) {
            return Number(left) - Number(right);
        });
        if (ports.length === 0) {
            console.log("No altblock_exchange wallet pending entries found");
            process.exit(0);
        }
        ports.forEach(function printPort(port) {
            printSummary(summarizeEntry(port, pending[port], blockLookup));
        });
        process.exit(0);
    });
}

if (require.main === module) main();

module.exports = {
    main,
    normalizePendingCache,
    summarizeEntry
};
