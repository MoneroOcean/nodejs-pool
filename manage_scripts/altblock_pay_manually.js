"use strict";
const cli = require("../script_utils.js")();
const hash = cli.arg("hash", "Please specify altblock hash");
const pay = cli.arg("pay", "Please specify pay value in main currency");

cli.init(function() {
	let txn = global.database.env.beginTxn();
        let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        	cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
			let blockData = global.protos.AltBlock.decode(data);
			if (blockData.hash === hash) {
				console.log("Found altblock with " + blockData.hash + " hash");
				blockData.pay_value = global.support.decimalToCoin(pay);
				blockData.unlocked = false;
				console.log("Put " + blockData.pay_value + " pay_value to block");
				txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(blockData));
				txn.commit();
				cursor.close();
				console.log("Changed altblock");
				process.exit(0);
			}
		});
        }
        cursor.close();
        txn.commit();
	console.log("Not found altblock with " + hash + " hash");
	process.exit(1);
});
