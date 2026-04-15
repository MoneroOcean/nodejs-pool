"use strict";

const cli = require("../script_utils.js")({ "--": true });
const hashes = cli.argv["--"];

cli.init(function() {
        hashes.forEach(function(hash) {
          global.database.unlockAltBlock(hash);
    	  console.log("Altblock with " + hash + " hash un-locked!");
        })
	process.exit(0);
});
