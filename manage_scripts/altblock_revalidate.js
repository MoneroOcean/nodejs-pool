"use strict";
const cli = require("../script_utils.js")();
const hash = cli.arg("hash", "Please specify altblock hash");

cli.init(function() {
	let txn = global.database.env.beginTxn();
	let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
	let is_found = true;
	for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			let blockData = global.protos.AltBlock.decode(data);
			if (blockData.hash === hash) {
			        is_found = true;
				global.coinFuncs.getPortBlockHeaderByHash(blockData.port, hash, (err, body) => {
					if (err !== null || !body.reward) {
						if (blockData.valid) {
							blockData.valid = false;
							blockData.unlocked = true;
							txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(blockData));
							console.log("Altblock with " + hash + " hash became invalid for " + blockData.port + " port! Exiting!");
						} else {
		        				console.log("Altblock with " + hash + " hash still has invalid hash for " + blockData.port + " port! Exiting!");
						}
						cursor.close();
						txn.commit();
						process.exit(1);
					}
					blockData.valid = true;
					blockData.unlocked = false;
		                        //if (blockData.value != body.reward) console.log("Changing alt-block value from " + blockData.value + " to " + body.reward);
                                        //blockData.value = body.reward;
					txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(blockData));
					cursor.close();
					txn.commit();
					console.log("Altblock with " + hash + " hash was validated! Exiting!");
					process.exit(0);
				});
			}
		});
        }
        if (!is_found) {
	        cursor.close();
	        txn.commit();
		console.log("Not found altblock with " + hash + " hash");
		process.exit(1);
	}
});
