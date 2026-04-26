"use strict";
const cli = require("../script_utils.js")();
const printBans = require("./user_bans_common.js");
const user = cli.arg("user", "Please specify user address to unban");

cli.init(function() {
	global.mysql.query('DELETE FROM bans WHERE mining_address = ?', [user]).then(function () {
		printBans(function () {
			console.log("Done. User was unbanned.");
			process.exit(0);
		});
	});
});
