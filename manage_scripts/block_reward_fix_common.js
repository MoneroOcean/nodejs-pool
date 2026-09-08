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
        const reader = global.database.env.beginTxn({ readOnly: true });
        /** @type {import("node-lmdb").Cursor<number> | null} */
        let cursor = null;
        /** @type {{key: number, block: T} | null} */
        let match = null;
        try {
            cursor = new global.database.lmdb.Cursor(reader, database);
            for (let found = cursor.goToFirst(); found !== null && match === null; found = cursor.goToNext()) {
                cursor.getCurrentBinary(function onBlock(key, data) {
                    const block = proto.decode(data);
                    if (block.hash === hash) {
                        if (typeof key !== "number") throw new Error("Invalid block database key");
                        match = { key, block };
                    }
                });
            }
        } finally {
            try {
                if (cursor) cursor.close();
            } finally {
                reader.abort();
            }
        }
        // RPC can take arbitrarily long. Never hold an LMDB transaction while waiting.
        const selected = /** @type {{key: number, block: T} | null} */ (match);
        if (!selected) {
            console.log(`Not found ${label} with ${hash} hash`);
            process.exit(1);
        }
        global.coinFuncs.getPortAnyBlockHeaderByHash(getPort(selected.block), hash, false, function onHeader(error, body) {
            const reward = body && body.reward;
            if (error || typeof reward !== "number" || !Number.isSafeInteger(reward) || reward < 0) {
                console.error("Can't get a valid block reward");
                process.exit(1);
            }
            const txn = global.database.env.beginTxn();
            let committed = false;
            try {
                // Re-read after RPC so a concurrent unlock or repair is preserved.
                const current = txn.getBinary(database, selected.key);
                if (current === null) throw new Error("Block disappeared during reward lookup");
                const block = proto.decode(current);
                if (block.hash !== hash) throw new Error("Block changed during reward lookup");
                console.log(`Changing raw block reward from ${block.value} to ${reward}`);
                block.value = reward;
                txn.putBinary(database, selected.key, proto.encode(block));
                txn.commit();
                committed = true;
            } finally {
                if (!committed) txn.abort();
            }
            console.log(`Changed ${label}`);
            process.exit(0);
        });
    });
}

module.exports = fixBlockRewardFromRpc;
