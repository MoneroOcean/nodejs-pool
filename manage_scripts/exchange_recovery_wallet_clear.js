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

/** @param {unknown} entry @param {string | number} port */
function formatWalletBalance(entry, port) {
    const balance = Number(normalizePendingCache(entry)["walletBalance"]);
    if (!Number.isFinite(balance)) return "unknown";
    const coinDef = coinDefs[String(port)];
    if (!coinDef || !coinDef.divisor) return String(balance);
    return (balance / coinDef.divisor).toFixed(8);
}

/** @param {string | number} port @param {unknown} entry @param {Map<number, import("../types/runtime").AltBlockMessage>} blockLookup */
function summarizeEntry(port, entry, blockLookup) {
    const pending = normalizePendingCache(entry);
    const blockIds = pending["blockIds"];
    const ids = Array.isArray(blockIds) ? blockIds.map(Number).filter(Number.isFinite) : [];
    const blocks = ids.map(function mapId(id) { return blockLookup.get(id); }).filter((block) => block !== undefined);
    const heights = blocks.map(function mapBlock(block) { return Number(block.height); }).filter(Number.isFinite).sort(function sort(a, b) { return a - b; });
    const firstHeight = heights[0] ?? null;
    const lastHeight = heights.at(-1) ?? null;
    return {
        port: String(port),
        coin: formatCoin(port),
        blocks: ids.length,
        created_at: Number(pending["createdAt"]) ? new Date(Number(pending["createdAt"])).toISOString() : "unknown",
        wallet_balance: formatWalletBalance(entry, port),
        first_height: firstHeight,
        last_height: lastHeight
    };
}

/** @param {ReturnType<typeof summarizeEntry>} summary */
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
