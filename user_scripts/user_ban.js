"use strict";
const cli = require("../script_utils.js")();
const printBans = require("./user_bans_common.js");
const user = cli.arg("user", "Please specify user address to ban");
const reason = cli.arg("reason", "Please specify reason to ban");

cli.init(function() {
	global.mysql.query('INSERT INTO bans (mining_address, reason) VALUES (?, ?)', [user, reason]).then(function () {
		printBans(function () {
			console.log("Done. User was banned.");
			process.exit(0);
		});
	});
});
