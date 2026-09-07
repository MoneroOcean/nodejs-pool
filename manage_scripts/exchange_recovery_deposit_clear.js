"use strict";

// Lists or clears altblock_exchange_deposit entries.
// Use this when a confirmed wallet->exchange send is stuck in the deposit guard
// even though the exchange deposit has been reviewed and credited/posted.
// This does not change block pay values or trade context; it only stops
// altblock_exchange from waiting for that port's exchange-balance delta.

const cli = require("../script_utils.js")();
const coinDefs = require("../lib2/coins.js")().COINS;
const {
    formatCoin,
    normalizePendingCache,
    runPendingCacheCli
} = require("./exchange_recovery_cache_common.js");

/** @param {unknown} amount @param {string | number} port */
function formatAmount(amount, port) {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed)) return "unknown";
    const coinDef = coinDefs[String(port)];
    const decimals = Number(coinDef && coinDef.exchange_deposit_decimals_dynamic);
    // Clamp at 12 to cap display precision and keep toFixed within its valid range for malformed config.
    if (Number.isFinite(decimals) && decimals > 0) return parsed.toFixed(Math.min(Math.trunc(decimals), 12));
    return parsed.toFixed(8);
}

/** @typedef {{amount: number, blockIds: number[], createdAt: number, txHash: string}} DepositBatch */

/** @param {unknown} entry @returns {DepositBatch[]} */
function normalizeBatches(entry) {
    const pending = normalizePendingCache(entry);
    const batches = pending["batches"];
    if (!Array.isArray(batches)) return [];
    return batches.map(function normalizeBatch(value) {
        const batch = normalizePendingCache(value);
        const ids = batch["blockIds"];
        const txHash = batch["txHash"];
        return {
            amount: Math.max(0, Number(batch["amount"]) || 0),
            blockIds: Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [],
            createdAt: Number(batch["createdAt"]) || 0,
            txHash: typeof txHash === "string" ? txHash : ""
        };
    }).filter((batch) => batch.amount > 0);
}

/** @param {string | number} port @param {unknown} entry @param {Map<number, import("../types/runtime").AltBlockMessage>} blockLookup */
function summarizeEntry(port, entry, blockLookup) {
    const batches = normalizeBatches(entry);
    const blockIds = batches.flatMap((batch) => batch.blockIds);
    const blocks = blockIds.map(function mapId(id) { return blockLookup.get(id); }).filter((block) => block !== undefined);
    const heights = blocks.map(function mapBlock(block) { return Number(block.height); }).filter(Number.isFinite).sort(function sort(a, b) { return a - b; });
    const firstCreatedAt = batches.reduce(/** @param {number | null} current @param {DepositBatch} batch */ function oldest(current, batch) {
        if (!batch.createdAt) return current;
        return current === null || batch.createdAt < current ? batch.createdAt : current;
    }, null);
    const totalAmount = batches.reduce(function sum(total, batch) {
        return total + batch.amount;
    }, 0);
    const txHashes = batches.map(function mapTx(batch) {
        return batch.txHash;
    }).filter(Boolean);
    return {
        port: String(port),
        coin: formatCoin(port),
        batches: batches.length,
        blocks: blockIds.length,
        amount: formatAmount(totalAmount, port),
        baseline: formatAmount(Number(normalizePendingCache(entry)["balanceBaseline"]) || 0, port),
        created_at: firstCreatedAt ? new Date(firstCreatedAt).toISOString() : "unknown",
        first_height: heights[0] ?? null,
        last_height: heights.at(-1) ?? null,
        txs: txHashes.join(",")
    };
}

/** @param {ReturnType<typeof summarizeEntry>} summary */
function printSummary(summary) {
    console.log(
        `coin=${  summary.coin 
        } port=${  summary.port 
        } batches=${  summary.batches 
        } blocks=${  summary.blocks 
        } amount=${  summary.amount 
        } baseline=${  summary.baseline 
        } created_at=${  summary.created_at 
        }${summary.txs ? ` txs=${  summary.txs}` : "" 
        }${summary.first_height !== null ? ` first_height=${  summary.first_height}` : "" 
        }${summary.last_height !== null ? ` last_height=${  summary.last_height}` : ""}`
    );
}

function main() {
    runPendingCacheCli({
        cli,
        cacheKey: "altblock_exchange_deposit",
        entryLabel: "altblock_exchange deposit",
        confirmOption: "confirm-reviewed-deposit",
        confirmInstruction: "Rerun with --confirm-reviewed-deposit=true after confirming the exchange deposit is posted/credited.",
        clearedHeading: "Cleared altblock_exchange deposit pending entry:",
        emptyMessage: "No altblock_exchange deposit pending entries found",
        summarizeEntry,
        printSummary,
        afterClear: [
            "Only do this after confirming the exchange deposit is posted/credited.",
            "Running altblock_exchange will pick this up on the next cycle."
        ]
    });
}

if (require.main === module) main();

module.exports = {
    main,
    normalizePendingCache,
    summarizeEntry
};
