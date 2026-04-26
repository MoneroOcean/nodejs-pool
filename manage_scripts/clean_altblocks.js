"use strict";
const cli = require("../script_utils.js")();

cli.init(function() {
	console.log("Cleaning up the alt block DB. Searching for items to delete");
        let deleted = [];
        let block_count = {};
	cli.forEachBinaryEntry(global.database.altblockDB, function (key, data) {
		let blockData = global.protos.AltBlock.decode(data);
                if (!(blockData.port in block_count)) block_count[blockData.port] = 0;
                ++ block_count[blockData.port];
                if (blockData.unlocked && (block_count[blockData.port] > 20000 || Date.now() - blockData.timestamp > 3*365*24*60*60*1000)) {
                   deleted.push(key);
                }
	}, { reverse: true });

	console.log("Deleting altblock items: " + deleted.length);

        let chunkSize = 0;
        let txn = global.database.env.beginTxn();
        deleted.forEach(function(key) {
            ++ chunkSize;
            txn.del(global.database.altblockDB, key);
      	    if (chunkSize > 500) {
	        txn.commit();
		txn = global.database.env.beginTxn();
                chunkSize = 0;
	    }
        });
        txn.commit();
	process.exit(0);
});
