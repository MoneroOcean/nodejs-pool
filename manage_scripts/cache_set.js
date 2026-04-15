"use strict";

const cli = require("../script_utils.js")();
const key = cli.arg("key", "Please specify key");
const value = cli.jsonArg("value", "Please specify value", "Can't parse your value: ");

cli.init(function() {
	global.database.setCache(key, value);
	process.exit(0);
});
