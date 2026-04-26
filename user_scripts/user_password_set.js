"use strict";
const cli = require("../script_utils.js")();
const userDb = require("./user_common.js");
const user = cli.arg("user", "Please specify user address to set");
const pass = cli.arg("pass", "Please specify user pass to set");

cli.init(function() {
	userDb.requireMissingUser(user, "Your password is already set, so can not set it again", { logRowsOnFailure: true }).then(function () {
		return userDb.runLoggedQuery("INSERT INTO users (username, email, enable_email) VALUES (?, ?, 0)", [user, pass], "INSERT INTO users (username, email, enable_email) VALUES (" + user + ", <redacted>, 0)");
	}).then(function () {
		userDb.finish("Done.");
	});
});
