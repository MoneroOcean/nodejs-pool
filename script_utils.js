"use strict";
const initMini = require("./init_mini.js");
const parseArgv = require("./parse_args.js");

/** @param {string} message @returns {never} */
function exitWithError(message) {
    console.error(message);
    process.exit(1);
}

/**
 * @template {Buffer | string} T
 * @param {import("./types/runtime").LmdbDbi} database
 * @param {(cursor: import("./types/runtime").LmdbCursor, iterator: (key: string | number | Buffer, data: T) => void) => void} read
 * @param {(key: string | number | Buffer, data: T) => void} iterator
 * @param {boolean} reverse
 *
 */
function forEachEntry(database, read, iterator, reverse) {
    const txn = global.database.env.beginTxn({ readOnly: true });
    let cursor;
    const startMethod = reverse === true ? "goToLast" : "goToFirst";
    const nextMethod = reverse === true ? "goToPrev" : "goToNext";

    try {
        cursor = new global.database.lmdb.Cursor(txn, database);
        // Cursor navigation returns null at the end; integer key 0 is a valid entry.
        for (let found = cursor[startMethod](); found !== null; found = cursor[nextMethod]()) {
            read(cursor, iterator);
        }
    } finally {
        // Release the cursor/read txn even if the iterator throws, so the slot is not held open.
        try {
            if (cursor) cursor.close();
        } finally {
            txn.abort();
        }
    }
}

/** @typedef {ReturnType<typeof createCli>} Cli */

/** @param {{"--"?: boolean}} [options] */
function createCli(options = {}) {
    const argv = parseArgv(process.argv.slice(2), options);

    /** @param {string} name @param {string} errorMessage */
    function arg(name, errorMessage) {
        const value = argv[name];
        if (typeof value !== "string" || value.length === 0) exitWithError(errorMessage);
        return value;
    }

    /** @param {string} name @param {string} errorMessage @param {number} [min] @param {number} [max] */
    function numberArg(name, errorMessage, min = -Infinity, max = Infinity) {
        const text = arg(name, errorMessage).trim();
        if (!text) exitWithError(errorMessage);
        const value = Number(text);
        if (!Number.isFinite(value) || value < min || value > max) exitWithError(errorMessage);
        return value;
    }

    return {
        argv,
        arg,
        numberArg,
        /** @param {string} name @param {string} errorMessage @param {number} [min] @param {number} [max] */
        integerArg(name, errorMessage, min = 0, max = Number.MAX_SAFE_INTEGER) {
            const value = numberArg(name, errorMessage, min, max);
            if (!Number.isSafeInteger(value)) exitWithError(errorMessage);
            return value;
        },
        init: initMini.init,
        /**
         * @template [T=null]
         * @param {string} name
         * @param {T | null} [fallback]
         * @returns {string | boolean | T | null}
         */
        get(name, fallback = null) {
            const value = argv[name];
            // Arrays belong to positional metadata, never scalar CLI options.
            return typeof value === "string" || typeof value === "boolean" ? value : fallback;
        },
        /** @param {import("./types/runtime").LmdbDbi} database @param {(key: string | number | Buffer, data: Buffer) => void} iterator @param {{reverse?: boolean}} [iterOptions] */
        forEachBinaryEntry(database, iterator, iterOptions = {}) {
            forEachEntry(database, (cursor, onEntry) => cursor.getCurrentBinary(onEntry), iterator, iterOptions.reverse === true);
        },
        /** @param {import("./types/runtime").LmdbDbi} database @param {(key: string | number | Buffer, data: string) => void} iterator @param {{reverse?: boolean}} [iterOptions] */
        forEachStringEntry(database, iterator, iterOptions = {}) {
            forEachEntry(database, (cursor, onEntry) => cursor.getCurrentString(onEntry), iterator, iterOptions.reverse === true);
        },
        /** @param {string} name @param {string} missingMessage @param {string} invalidPrefix @returns {unknown} */
        jsonArg(name, missingMessage, invalidPrefix) {
            const value = arg(name, missingMessage);
            try {
                return JSON.parse(value);
            } catch (_error) {
                exitWithError(invalidPrefix + value);
            }
        }
    };
}

createCli.init = initMini.init;

module.exports = createCli;
