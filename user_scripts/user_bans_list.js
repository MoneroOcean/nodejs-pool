"use strict";
const printBans = require("./user_bans_common.js");
const cli = require("../script_utils.js");

cli.init(function() {
	printBans(function () {
			console.log("Done.");
			process.exit(0);
	});
});
