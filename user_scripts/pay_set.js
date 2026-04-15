"use strict";
const cli = require("../script_utils.js")();
const userDb = require("./user_db_common.js");
const user = cli.arg("user", "Please specify user address to set");

cli.init(function() {
        const pay = global.support.decimalToCoin(cli.get("pay", 0.003));
	userDb.runLoggedQuery("UPDATE users SET payout_threshold=? WHERE username=?", [pay, user], "UPDATE users SET payout_threshold=" + pay + " WHERE username=" + user).then(function () {
		userDb.finish("Done.");
	});
});
