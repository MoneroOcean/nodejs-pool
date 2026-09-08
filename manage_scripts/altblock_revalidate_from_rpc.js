"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();
const hash = cli.arg("hash", "Please specify altblock hash");

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    const txn = localDatabase.env.beginTxn();
    const cursor = new localDatabase.lmdb.Cursor(txn, localDatabase.altblockDB);
    let is_found = false;
    for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
        cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
            const blockData = global.protos.AltBlock.decode(data);
            if (blockData.hash === hash) {
                is_found = true;
                global.coinFuncs.getPortBlockHeaderByHash(blockData.port, hash, (err, body) => {
                    if (err !== null || !body || !body.reward) {
                        if (blockData.valid) {
                            blockData.valid = false;
                            blockData.unlocked = true;
                            txn.putBinary(localDatabase.altblockDB, key, global.protos.AltBlock.encode(blockData));
                            console.log(`Altblock with ${  hash  } hash became invalid for ${  blockData.port  } port! Exiting!`);
                        } else {
                            console.log(`Altblock with ${  hash  } hash still has invalid hash for ${  blockData.port  } port! Exiting!`);
                        }
                        cursor.close();
                        txn.commit();
                        process.exit(1);
                    }
                    blockData.valid = true;
                    blockData.unlocked = false;
                    txn.putBinary(localDatabase.altblockDB, key, global.protos.AltBlock.encode(blockData));
                    cursor.close();
                    txn.commit();
                    console.log(`Altblock with ${  hash  } hash was validated! Exiting!`);
                    process.exit(0);
                });
            }
        });
    }
    if (!is_found) {
        cursor.close();
        txn.commit();
        console.log(`Not found altblock with ${  hash  } hash`);
        process.exit(1);
    }
});
