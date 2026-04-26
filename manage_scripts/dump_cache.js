"use strict";
const cli = require("../script_utils.js")();
const user = cli.get("user");

cli.init(function() {
	cli.forEachStringEntry(global.database.cacheDB, function (key, data) {
		if (!user || key.includes(user)) console.log(key + ": " + data);
	});
	process.exit(0);
});
