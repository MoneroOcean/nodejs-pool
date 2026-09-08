"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();
const user = cli.get("user");

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    cli.forEachStringEntry(localDatabase.cacheDB, function (key, data) {
        if (!user || (typeof user === "string" && String(key).includes(user))) console.log(`${key  }: ${  data}`);
    });
    process.exit(0);
});
