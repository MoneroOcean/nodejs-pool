"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();
const key = cli.arg("key", "Please specify key");

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    const value = localDatabase.getCache(key);
    if (value !== false) {
        console.log(JSON.stringify(value));
        process.exit(0);
    } else {
        console.error("Key is not found");
        process.exit(1);
    }
});
