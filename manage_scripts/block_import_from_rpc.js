"use strict";
const cli = require("../script_utils.js")();
const height = cli.arg("height", "Please specify block height");

cli.init(function() {
        global.coinFuncs.getBlockHeaderByID(height, function (err, body) {
                if (err) {
                        console.error("Can't get block header");
                        process.exit(1);
                }
                // 18081 is the XMR main-chain daemon RPC port.
                global.coinFuncs.getPortAnyBlockHeaderByHash(18081, body.hash, true, function (innerErr, innerBody) {
                        if (innerErr) {
                                console.error("Can't get block header");
                                process.exit(1);
                        }
                        const body2 = {
                                "hash":       innerBody.hash,
                                "difficulty": innerBody.difficulty,
                                "shares":     0,
                                "timestamp":  innerBody.timestamp * 1000,
                                "poolType":   0,
                                "unlocked":   false,
                                "valid":      true,
                                "value":      innerBody.reward
                        };
                        const body3 = global.protos.Block.encode(body2);
                        const blockHeight = parseInt(height, 10);
                        const txn = global.database.env.beginTxn();
                        const blockProto = txn.getBinary(global.database.blockDB, blockHeight);
                        if (blockProto === null) {
                                txn.putBinary(global.database.blockDB, blockHeight, body3);
                                console.log(`Block with ${  height  } height added! Exiting!`);
                        } else {
                                console.log(`Block with ${  height  } height already exists! Exiting!`);
                        }
                        txn.commit();
                        process.exit(0);
                });
        });
});
