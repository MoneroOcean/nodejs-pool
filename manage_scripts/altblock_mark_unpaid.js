"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")({ "--": true });
const hashes = cli.argv["--"] ?? [];

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    hashes.forEach(function(hash) {
        localDatabase.unlockAltBlock(hash);
        console.log(`Altblock with ${  hash  } hash un-locked!`);
    });
    process.exit(0);
});
