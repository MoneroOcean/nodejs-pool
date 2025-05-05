"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.height) {
	console.error("Please specify block height");
	process.exit(1);
}
const height = argv.height;

require("../init_mini.js").init(function() {
        let txn = global.database.env.beginTxn();
	txn.del(global.database.blockDB, height);
        txn.commit();
	console.log("Block with " + height + " height removed! Exiting!");
	process.exit(0);
});
