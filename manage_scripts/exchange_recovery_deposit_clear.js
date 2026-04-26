"use strict";

// Lists or clears altblock_exchange_deposit entries.
// Use this when a confirmed wallet->exchange send is stuck in the deposit guard
// even though the exchange deposit has been reviewed and credited/posted.
// This does not change block pay values or trade context; it only stops
// altblock_exchange from waiting for that port's exchange-balance delta.

const cli = require("../script_utils.js")();
const coinDefs = require("../lib2/coins.js")().COINS;

const CACHE_KEY = "altblock_exchange_deposit";
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

function formatAmount(amount, port) {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed)) return "unknown";
    const coinDef = coinDefs[String(port)];
    const decimals = Number(coinDef && coinDef.exchange_deposit_decimals_dynamic);
    if (Number.isFinite(decimals) && decimals > 0) return parsed.toFixed(Math.min(Math.trunc(decimals), 12));
    return parsed.toFixed(8);
}

function buildBlockLookup() {
    const lookup = new Map();
    cli.forEachBinaryEntry(global.database.altblockDB, function onEntry(_key, data) {
        const block = global.protos.AltBlock.decode(data);
        lookup.set(Number(block.id), block);
    });
    return lookup;
}

function normalizeBatches(entry) {
    return Array.isArray(entry && entry.batches)
        ? entry.batches.map(function normalizeBatch(batch) {
            return {
                amount: Math.max(0, Number(batch && batch.amount) || 0),
                blockIds: Array.isArray(batch && batch.blockIds)
                    ? batch.blockIds.map(function normalizeId(blockId) { return Number(blockId); }).filter(Number.isFinite)
                    : [],
                createdAt: Number(batch && batch.createdAt) || 0
            };
        }).filter(function keepBatch(batch) {
            return batch.amount > 0;
        })
        : [];
}

function summarizeEntry(port, entry, blockLookup) {
    const batches = normalizeBatches(entry);
    const blockIds = [];
    batches.forEach(function addIds(batch) {
        batch.blockIds.forEach(function addId(blockId) {
            blockIds.push(blockId);
        });
    });
    const blocks = blockIds.map(function mapId(id) { return blockLookup.get(id); }).filter(Boolean);
    const heights = blocks.map(function mapBlock(block) { return Number(block.height); }).filter(Number.isFinite).sort(function sort(a, b) { return a - b; });
    const firstCreatedAt = batches.reduce(function oldest(current, batch) {
        if (!batch.createdAt) return current;
        return current === null || batch.createdAt < current ? batch.createdAt : current;
    }, null);
    const totalAmount = batches.reduce(function sum(total, batch) {
        return total + batch.amount;
    }, 0);
    return {
        port: String(port),
        coin: formatCoin(port),
        batches: batches.length,
        blocks: blockIds.length,
        amount: formatAmount(totalAmount, port),
        baseline: formatAmount(Number(entry && entry.balanceBaseline) || 0, port),
        created_at: firstCreatedAt ? new Date(firstCreatedAt).toISOString() : "unknown",
        first_height: heights.length ? heights[0] : null,
        last_height: heights.length ? heights[heights.length - 1] : null
    };
}

function printSummary(summary) {
    console.log(
        "coin=" + summary.coin +
        " port=" + summary.port +
        " batches=" + summary.batches +
        " blocks=" + summary.blocks +
        " amount=" + summary.amount +
        " baseline=" + summary.baseline +
        " created_at=" + summary.created_at +
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
                console.error("No pending altblock_exchange deposit entry for port " + targetPort);
                process.exit(1);
            }
            if (!parseBooleanOption(cli.get("confirm-reviewed-deposit"))) {
                console.error("Rerun with --confirm-reviewed-deposit=true after confirming the exchange deposit is posted/credited.");
                process.exit(1);
            }
            const summary = summarizeEntry(targetPort, entry, blockLookup);
            delete pending[targetPort];
            global.database.setCache(CACHE_KEY, pending);
            console.log("Cleared altblock_exchange deposit pending entry:");
            printSummary(summary);
            console.log("Only do this after confirming the exchange deposit is posted/credited.");
            console.log("Running altblock_exchange will pick this up on the next cycle.");
            process.exit(0);
        }

        if (targetPort) {
            const entry = pending[targetPort];
            if (!entry) {
                console.error("No pending altblock_exchange deposit entry for port " + targetPort);
                process.exit(1);
            }
            printSummary(summarizeEntry(targetPort, entry, blockLookup));
            process.exit(0);
        }

        const ports = Object.keys(pending).sort(function sortPorts(left, right) {
            return Number(left) - Number(right);
        });
        if (ports.length === 0) {
            console.log("No altblock_exchange deposit pending entries found");
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
