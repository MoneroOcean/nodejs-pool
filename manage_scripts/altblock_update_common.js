"use strict";

// Applies a synchronous mutation while the LMDB cursor owns the decoded
// record. Callers retain their operation-specific logging and validation.
function updateAltBlocks(hashes, mutate) {
    const targetHashes = new Set(hashes);
    const txn = global.database.env.beginTxn();
    const cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
    let changed = 0;

    for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        cursor.getCurrentBinary(function onBlock(key, data) {
            const block = global.protos.AltBlock.decode(data);
            if (!targetHashes.has(block.hash)) return;
            console.log(`Found altblock with ${  block.hash  } hash`);
            mutate(block);
            txn.putBinary(global.database.altblockDB, key, global.protos.AltBlock.encode(block));
            console.log("Changed altblock");
            changed += 1;
        });
    }
    cursor.close();
    txn.commit();
    return changed;
}

module.exports = updateAltBlocks;
