"use strict";
const cli = require("../script_utils.js")();
const userDb = require("./user_common.js");
const user = cli.arg("user", "Please specify user address to reset");

cli.init(function() {
	userDb.requireExistingUser(user, "User settings row does not exist").then(function () {
		return userDb.runLoggedQuery("UPDATE users SET email = NULL, pass = NULL WHERE username = ?", [user], `UPDATE users SET email = NULL, pass = NULL WHERE username = ${  user}`);
	}).then(function () {
		userDb.finish("Done. Please restart the miner or wait for it to reconnect and submit a valid share to set email/password again.");
	});
});
