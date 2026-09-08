"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();
const height = cli.integerArg("height", "Please specify block height", 0, 0xffffffff);

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
        global.coinFuncs.getBlockHeaderByID(height, function (err, body) {
                if (err || !body) {
                        console.error("Can't get block header");
                        process.exit(1);
                }
                // 18081 is the XMR main-chain daemon RPC port.
                global.coinFuncs.getPortAnyBlockHeaderByHash(18081, body.hash, true, function (innerErr, innerBody) {
                        if (innerErr || !innerBody) {
                                console.error("Can't get block header");
                                process.exit(1);
                        }
                        const { timestamp, difficulty, reward } = innerBody;
                        if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
                            typeof difficulty !== "number" || !Number.isFinite(difficulty) || difficulty <= 0 ||
                            typeof reward !== "number" || !Number.isSafeInteger(reward) || reward < 0) {
                                console.error("Invalid block header values");
                                process.exit(1);
                        }
                        const body2 = {
                                "hash":       innerBody.hash,
                                difficulty,
                                "shares":     0,
                                "timestamp":  timestamp * 1000,
                                "poolType":   0,
                                "unlocked":   false,
                                "valid":      true,
                                "value":      reward
                        };
                        const body3 = global.protos.Block.encode(body2);
                        const blockHeight = height;
                        const txn = localDatabase.env.beginTxn();
                        let committed = false;
                        try {
                                const blockProto = txn.getBinary(localDatabase.blockDB, blockHeight);
                                if (blockProto === null) {
                                        txn.putBinary(localDatabase.blockDB, blockHeight, body3);
                                        console.log(`Block with ${height} height added! Exiting!`);
                                } else {
                                        console.log(`Block with ${height} height already exists! Exiting!`);
                                }
                                txn.commit();
                                committed = true;
                        } finally {
                                if (!committed) txn.abort();
                        }
                        process.exit(0);
                });
        });
});
