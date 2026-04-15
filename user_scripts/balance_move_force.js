"use strict";
const cli = require("../script_utils.js")();
const moveBalance = require("./balance_move_common.js");
const old_user = cli.arg("old_user", "Please specify old_user address to move balance from");
const new_user = cli.arg("new_user", "Please specify new_user address to move balance to");

cli.init(function() {
	moveBalance(old_user, new_user, {});
});
