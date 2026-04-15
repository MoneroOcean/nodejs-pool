"use strict";
const cli = require("../script_utils.js")();
const userDb = require("./user_db_common.js");
const user = cli.arg("user", "Please specify user address to delete");

cli.init(function() {
	userDb.requireExistingUser(user, "Your password is not yet set. To do that you need to set password field in your miner to \"<your miner name>:<password>\", where <your miner name> is any name (without : character) and <password> is your password (depending on miner password can be in in command line, config.json or config.txt files). Optionally you can use your email as your password if you want notifications about miner downtimes from the pool. You need to make sure you restart your miner and your miner submits at least one valid share for password to be set.", { logFound: true }).then(function () {
		return userDb.runLoggedQuery("DELETE FROM users WHERE username = ?", [user], "DELETE FROM users WHERE username = " + user);
	}).then(function () {
		userDb.finish("Done. Please do not forget to restart your miner to apply new password and set payment threshold since it was reset as well");
	});
});
