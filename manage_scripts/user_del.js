"use strict";
const cli = require("../script_utils.js")();
const runUserDelete = require("./user_delete_common.js");
const user = cli.arg("user", "Please specify user address to delete");

cli.init(function() {
	runUserDelete(user, { requireStaleBalance: true });
});
