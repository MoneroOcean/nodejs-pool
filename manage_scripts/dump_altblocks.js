"use strict";

const cli = require("../script_utils.js")();

cli.init(function() {
	cli.forEachBinaryEntry(global.database.altblockDB, function (key, data) {
		console.log(key + ": " + JSON.stringify(global.protos.AltBlock.decode(data)));
	});
	process.exit(0);
});
