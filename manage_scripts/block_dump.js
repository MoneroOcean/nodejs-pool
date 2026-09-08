"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    cli.forEachBinaryEntry(localDatabase.blockDB, function (key, data) {
        console.log(`${key  }: ${  JSON.stringify(global.protos.Block.decode(data))}`);
    });
    process.exit(0);
});
