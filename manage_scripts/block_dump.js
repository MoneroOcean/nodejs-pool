"use strict";
const cli = require("../script_utils.js")();

cli.init(function() {
	cli.forEachBinaryEntry(global.database.blockDB, function (key, data) {
		console.log(key + ": " + JSON.stringify(global.protos.Block.decode(data)));
	});
	process.exit(0);
});
