"use strict";

// The main-chain and alt-chain repair scripts differ only in storage and port
// selection. Keeping the transaction lifecycle here prevents those copies from
// drifting when LMDB handling changes.
/**
 * @template {import("../types/runtime").BlockMessage} T
 * @param {{cli: import("../script_utils.js").Cli, hash: string, databaseName: "blockDB" | "altblockDB", getCodec: () => import("../types/runtime").ProtoCodec<T>, label: string, getPort: (block: T) => number}} options
 */
function fixBlockRewardFromRpc(options) {
    const {
        cli,
        hash,
        databaseName,
        getCodec,
        label,
        getPort
    } = options;

    cli.init(function onInit() {
        const database = global.database[databaseName];
        const proto = getCodec();
        const txn = global.database.env.beginTxn();
        const cursor = new global.database.lmdb.Cursor(txn, database);
        let foundBlock = false;

        for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function onBlock(key, data) {
                const block = proto.decode(data);
                if (foundBlock || block.hash !== hash) return;
                foundBlock = true;
                console.log(`Found ${  label  } with ${  block.hash  } hash`);
                global.coinFuncs.getPortAnyBlockHeaderByHash(getPort(block), hash, false, function onHeader(error, body) {
                    if (error || !body) {
                        cursor.close();
                        txn.commit();
                        console.error("Can't get block header");
                        process.exit(1);
                    }
                    console.log(`Changing raw block reward from ${  block.value  } to ${  body.reward}`);
                    block.value = body.reward;
                    txn.putBinary(database, key, proto.encode(block));
                    cursor.close();
                    txn.commit();
                    console.log(`Changed ${  label}`);
                    process.exit(0);
                });
            });
        }

        if (!foundBlock) {
            cursor.close();
            txn.commit();
            console.log(`Not found ${  label  } with ${  hash  } hash`);
            process.exit(1);
        }
    });
}

module.exports = fixBlockRewardFromRpc;
