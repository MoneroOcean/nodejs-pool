"use strict";
const cli = require("../script_utils.js")();
const timestamp = cli.arg("timestamp", "Please specify altblock time");

cli.init(function() {
        let txn = global.database.env.beginTxn();
	txn.del(global.database.altblockDB, timestamp);
        txn.commit();
	console.log("Altblock with " + timestamp + " timestamp removed! Exiting!");
	process.exit(0);
});
