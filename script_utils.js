"use strict";
const initMini = require("./init_mini.js");
const parseArgv = require("./parse_args.js");

function exitWithError(message) {
    console.error(message);
    process.exit(1);
}

function forEachEntry(database, reader, iterator, reverse) {
    const txn = global.database.env.beginTxn({ readOnly: true });
    let cursor;
    const startMethod = reverse === true ? "goToLast" : "goToFirst";
    const nextMethod = reverse === true ? "goToPrev" : "goToNext";

    try {
        cursor = new global.database.lmdb.Cursor(txn, database);
        // Cursor navigation returns null at the end; integer key 0 is a valid entry.
        for (let found = cursor[startMethod](); found !== null; found = cursor[nextMethod]()) {
            cursor[reader](iterator);
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

function createCli(options) {
    const argv = parseArgv(process.argv.slice(2), options);

    function arg(name, errorMessage) {
        const value = argv[name];
        if (!value) exitWithError(errorMessage);
        return value;
    }

    return {
        argv,
        arg,
        init: initMini.init,
        get(name, fallback = null) {
            return typeof argv[name] === "undefined" ? fallback : argv[name];
        },
        forEachBinaryEntry(database, iterator, iterOptions = {}) {
            forEachEntry(database, "getCurrentBinary", iterator, iterOptions.reverse);
        },
        forEachStringEntry(database, iterator, iterOptions = {}) {
            forEachEntry(database, "getCurrentString", iterator, iterOptions.reverse);
        },
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
