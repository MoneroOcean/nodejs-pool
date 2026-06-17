"use strict";

// Lists or clears altblock_exchange_wallet entries.
// Use this when a wallet RPC submit was ambiguous and altblock_exchange is
// waiting for wallet-balance evidence before retrying or requiring review.
// This is not for exchange-posted deposits; use
// exchange_recovery_deposit_clear.js for deposit-guard waits.

const cli = require("../script_utils.js")();
const coinDefs = require("../lib2/coins.js")().COINS;
const {
    formatCoin,
    normalizePendingCache,
    runPendingCacheCli
} = require("./exchange_recovery_cache_common.js");

function formatWalletBalance(entry, port) {
    const balance = Number(entry && entry.walletBalance);
    if (!Number.isFinite(balance)) return "unknown";
    const coinDef = coinDefs[String(port)];
    if (!coinDef || !coinDef.divisor) return String(balance);
    return (balance / coinDef.divisor).toFixed(8);
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
        `coin=${  summary.coin 
        } port=${  summary.port 
        } blocks=${  summary.blocks 
        } created_at=${  summary.created_at 
        } wallet_balance=${  summary.wallet_balance 
        }${summary.first_height !== null ? ` first_height=${  summary.first_height}` : "" 
        }${summary.last_height !== null ? ` last_height=${  summary.last_height}` : ""}`
    );
}

function main() {
    runPendingCacheCli({
        cli,
        cacheKey: "altblock_exchange_wallet",
        entryLabel: "altblock_exchange wallet",
        confirmOption: "confirm-reviewed-wallet",
        confirmInstruction: "Rerun with --confirm-reviewed-wallet=true after confirming the ambiguous wallet send state is safe to clear.",
        clearedHeading: "Cleared altblock_exchange wallet pending entry:",
        emptyMessage: "No altblock_exchange wallet pending entries found",
        summarizeEntry,
        printSummary,
        afterClear: ["Running altblock_exchange will pick this up on the next cycle."]
    });
}

if (require.main === module) main();

module.exports = {
    main,
    normalizePendingCache,
    summarizeEntry
};
