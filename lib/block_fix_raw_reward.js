"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.hash) {
        console.error("Please specify block hash");
        process.exit(1);
}
const hash = argv.hash;

require("../init_mini.js").init(function() {
        let txn = global.database.env.beginTxn();
        let cursor = new global.database.lmdb.Cursor(txn, global.database.blockDB);
        let is_found = 0;
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.Block.decode(data);
                        if (!is_found && blockData.hash === hash) {
                                console.log("Found block with " + blockData.hash + " hash");
                                is_found = 1;
                                global.coinFuncs.getPortAnyBlockHeaderByHash(18081, argv.hash, false, function (err, body) {
                                        if (err) {
                                                cursor.close();
                                                txn.commit();
                                                console.error("Can't get block header");
                                                process.exit(1);
                                        }
                                        console.log("Changing raw block reward from " + blockData.value + " to " + body.reward);
                                        blockData.value = body.reward;
                                        txn.putBinary(global.database.blockDB, key, global.protos.Block.encode(blockData));
                                        txn.commit();
                                        cursor.close();
                                        console.log("Changed block");
                                        process.exit(0);
                                });
                        }
                });
        }
        if (!is_found) {
                cursor.close();
                txn.commit();
                console.log("Not found block with " + hash + " hash");
                process.exit(1);
        }
});
