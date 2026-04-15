"use strict";

const cli = require("../script_utils.js")();
const height = cli.arg("height", "Please specify block height");

cli.init(function() {
        let txn = global.database.env.beginTxn();
	txn.del(global.database.blockDB, height);
        txn.commit();
	console.log("Block with " + height + " height removed! Exiting!");
	process.exit(0);
});
