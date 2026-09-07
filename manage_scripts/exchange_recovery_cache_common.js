"use strict";

/** @param {unknown} value */
function parseBooleanOption(value) {
    if (value === null || typeof value === "undefined") return false;
    return ["1", "true", "yes"].includes(String(value).toLowerCase());
}

/** @param {string | number} port */
function formatCoin(port) {
    if (global.coinFuncs && typeof global.coinFuncs.PORT2COIN_FULL === "function") {
        return global.coinFuncs.PORT2COIN_FULL(Number(port));
    }
    return String(port);
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function normalizePendingCache(value) {
    return value && typeof value === "object"
        ? Object.assign(Object.create(null), value)
        : Object.create(null);
}

/** @param {import("../script_utils.js").Cli} cli @returns {Map<number, import("../types/runtime").AltBlockMessage>} */
function buildBlockLookup(cli) {
    const lookup = new Map();
    cli.forEachBinaryEntry(global.database.altblockDB, function onEntry(_key, data) {
        const block = global.protos.AltBlock.decode(data);
        lookup.set(Number(_key), block);
    });
    return lookup;
}

// Recovery cache scripts intentionally share one CLI flow so their safety
// checks and list/clear behavior cannot drift apart.
/**
 * @template T
 * @param {{cli: import("../script_utils.js").Cli, cacheKey: string, entryLabel: string, confirmOption: string, confirmInstruction: string, clearedHeading: string, emptyMessage: string, summarizeEntry: (port: string, entry: unknown, blocks: Map<number, import("../types/runtime").AltBlockMessage>) => T, printSummary: (summary: T) => void, afterClear?: string[]}} options
 *
 */
function runPendingCacheCli(options) {
    const {
        cli,
        cacheKey,
        entryLabel,
        confirmOption,
        confirmInstruction,
        clearedHeading,
        emptyMessage,
        summarizeEntry,
        printSummary,
        afterClear = []
    } = options;
    const portArg = cli.get("port", null);
    const clear = cli.get("clear", false) === true;

    cli.init(function onInit() {
        const pending = normalizePendingCache(global.database.getCache(cacheKey));
        const blockLookup = buildBlockLookup(cli);
        const targetPort = portArg ? String(portArg) : null;

        if (clear) {
            if (!targetPort) {
                console.error("Please specify --port when using --clear");
                process.exit(1);
            }
            const entry = pending[targetPort];
            if (!entry) {
                console.error(`No pending ${  entryLabel  } entry for port ${  targetPort}`);
                process.exit(1);
            }
            if (!parseBooleanOption(cli.get(confirmOption))) {
                console.error(confirmInstruction);
                process.exit(1);
            }
            const summary = summarizeEntry(targetPort, entry, blockLookup);
            delete pending[targetPort];
            global.database.setCache(cacheKey, pending);
            console.log(clearedHeading);
            printSummary(summary);
            afterClear.forEach(function printLine(line) { console.log(line); });
            process.exit(0);
        }

        if (targetPort) {
            const entry = pending[targetPort];
            if (!entry) {
                console.error(`No pending ${  entryLabel  } entry for port ${  targetPort}`);
                process.exit(1);
            }
            printSummary(summarizeEntry(targetPort, entry, blockLookup));
            process.exit(0);
        }

        const ports = Object.keys(pending).sort(function sortPorts(left, right) {
            return Number(left) - Number(right);
        });
        if (ports.length === 0) {
            console.log(emptyMessage);
            process.exit(0);
        }
        ports.forEach(function printPort(port) {
            printSummary(summarizeEntry(port, pending[port], blockLookup));
        });
        process.exit(0);
    });
}

module.exports = {
    formatCoin,
    normalizePendingCache,
    runPendingCacheCli
};
