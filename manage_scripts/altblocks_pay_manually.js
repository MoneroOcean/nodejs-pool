"use strict";
const cli = require("../script_utils.js")({ "--": true });

let hashes = {};
for (const h of cli.argv["--"]) {
  hashes[h] = 1;
}

const pay = cli.arg("pay", "Please specify pay value in main currency");

cli.init(function() {
        let changed = 0;
        let txn = global.database.env.beginTxn();
        let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.hash in hashes) {
                                console.log("Found altblock with " + blockData.hash + " hash");
                                blockData.pay_value = global.support.decimalToCoin(pay);
                                blockData.unlocked = false;
                                console.log("Put " + blockData.pay_value + " pay_value to block");
                                txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(blockData));
                                console.log("Changed altblock");
                                changed += 1;
                        }
                });
        }
        cursor.close();
        txn.commit();
        if (!changed) console.log("Not found altblocks with specified hashes");
        else console.log("Changed " + changed + " blocks");
        process.exit(0);
});
