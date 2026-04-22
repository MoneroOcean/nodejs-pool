"use strict";

const initMini = require("./init_mini.js");
const parseArgv = require("./parse_args.js");

function exitWithError(message) {
    console.error(message);
    process.exit(1);
}

function forEachEntry(database, reader, iterator, reverse) {
    const txn = global.database.env.beginTxn({ readOnly: true });
    const cursor = new global.database.lmdb.Cursor(txn, database);
    const startMethod = reverse === true ? "goToLast" : "goToFirst";
    const nextMethod = reverse === true ? "goToPrev" : "goToNext";

    for (let found = cursor[startMethod](); found; found = cursor[nextMethod]()) {
        cursor[reader](function onEntry(key, data) {
            iterator(key, data);
        }); // jshint ignore:line
    }

    cursor.close();
    txn.commit();
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
        forEachBinaryEntry(database, iterator, options = {}) {
            forEachEntry(database, "getCurrentBinary", iterator, options.reverse);
        },
        forEachStringEntry(database, iterator, options = {}) {
            forEachEntry(database, "getCurrentString", iterator, options.reverse);
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
