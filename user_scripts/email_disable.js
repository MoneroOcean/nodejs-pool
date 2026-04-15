"use strict";
const cli = require("../script_utils.js")();
const userDb = require("./user_db_common.js");
const user = cli.arg("user", "Please specify user address to set");

cli.init(function() {
	userDb.requireExistingUser(user, "User password and thus email is not yet set").then(function () {
		return userDb.runLoggedQuery("UPDATE users SET enable_email = '0' WHERE username = ?", [user], "UPDATE users SET enable_email = '0' WHERE username = " + user);
	}).then(function () {
		userDb.finish("Done.");
	});
});
