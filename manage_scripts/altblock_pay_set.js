"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();
const hash = cli.arg("hash", "Please specify altblock hash");
const pay = cli.numberArg("pay", "Please specify a non-negative pay value in main currency", 0);

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    const txn = localDatabase.env.beginTxn();
    const cursor = new localDatabase.lmdb.Cursor(txn, localDatabase.altblockDB);
    for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
        cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
            const blockData = global.protos.AltBlock.decode(data);
            if (blockData.hash === hash) {
                console.log(`Found altblock with ${  blockData.hash  } hash`);
                blockData.pay_value = global.support.decimalToCoin(pay);
                blockData.unlocked = false;
                console.log(`Put ${  blockData.pay_value  } pay_value to block`);
                txn.putBinary(localDatabase.altblockDB, key, global.protos.AltBlock.encode(blockData));
                txn.commit();
                cursor.close();
                console.log("Changed altblock");
                process.exit(0);
            }
        });
    }
    cursor.close();
    txn.commit();
    console.log(`Not found altblock with ${  hash  } hash`);
    process.exit(1);
});
