"use strict";
const cli = require("../script_utils.js")();
const moveBalance = require("./user_balance_move_common.js");
const old_user = cli.arg("old_user", "Please specify old_user address to move balance from");
const new_user = cli.arg("new_user", "Please specify new_user address to move balance to");

cli.init(function() {
	moveBalance(old_user, new_user, {
		confirmForceMove: cli.get("confirm-force-move") === true,
		delayMs: 10 * 1000,
		force: true
	});
});
