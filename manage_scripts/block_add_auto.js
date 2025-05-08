"use strict";

const argv = require('minimist')(process.argv.slice(2));

if (!argv.height) {
        console.error("Please specify block height");
        process.exit(1);
}
const height = argv.height;

require("../init_mini.js").init(function() {
        global.coinFuncs.getBlockHeaderByID(height, function (err, body) {
                if (err) {
                        console.error("Can't get block header");
                        process.exit(1);
                }
                global.coinFuncs.getPortAnyBlockHeaderByHash(18081, body.hash, true, function (err, body) {
                        if (err) {
                                console.error("Can't get block header");
                                process.exit(1);
                        }
                        const body2 = {
                                "hash":       body.hash,
                                "difficulty": body.difficulty,
                                "shares":     0,
                                "timestamp":  body.timestamp * 1000,
                                "poolType":   0,
                                "unlocked":   false,
                                "valid":      true,
                                "value":      body.reward
                        };
                        const body3 = global.protos.Block.encode(body2);
                        let txn = global.database.env.beginTxn();
                        let blockProto = txn.getBinary(global.database.blockDB, parseInt(height));
                        if (blockProto === null) {
                                txn.putBinary(global.database.blockDB, height, body3);
                                console.log("Block with " + height + " height added! Exiting!");
                        } else {
                                console.log("Block with " + height + " height already exists! Exiting!");
                        }
                        txn.commit();
                        process.exit(0);
                });
        });
});
