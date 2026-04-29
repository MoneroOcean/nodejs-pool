"use strict";
const cli = require("../script_utils.js")();
const userDb = require("./user_common.js");
const user = cli.arg("user", "Please specify user address to set");

cli.init(function() {
	userDb.requireExistingUser(user, "User settings row does not exist").then(function () {
		return userDb.runLoggedQuery("UPDATE users SET payout_threshold_lock = '1' WHERE username = ?", [user], "UPDATE users SET payout_threshold_lock = '1' WHERE username = " + user);
	}).then(function () {
		userDb.finish("Done.");
	});
});
