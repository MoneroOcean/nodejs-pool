"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();
const height = cli.integerArg("height", "Please specify block height to lock again (to pay it again)", 0, 0xffffffff);

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    // blockDB is opened with keyIsUint32, so the height key must be a Number for
    // both read and write; a String key throws on a keyIsUint32 dbi.
    const blockHeight = height;
    const txn = localDatabase.env.beginTxn();
    const blockProto = txn.getBinary(localDatabase.blockDB, blockHeight);
    if (blockProto === null) {
        txn.commit();
        console.log(`Block on ${  height  } height not found! Exiting!`);
        process.exit(1);
    }
    const blockData = global.protos.Block.decode(blockProto);
    blockData.unlocked = false;
    txn.putBinary(localDatabase.blockDB, blockHeight, global.protos.Block.encode(blockData));
    txn.commit();
    console.log(`Block on ${  height  } height re-locked! Exiting!`);
    process.exit(0);
});
