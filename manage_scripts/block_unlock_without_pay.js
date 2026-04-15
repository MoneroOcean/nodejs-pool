"use strict";

const cli = require("../script_utils.js")();
const hash = cli.arg("hash", "Please specify block hash to unlock it (and avoid payment)");

cli.init(function() {
	global.database.unlockBlock(hash);
	console.log("Block on " + hash + " height un-locked! Exiting!");
	process.exit(0);
});
