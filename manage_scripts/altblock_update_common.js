"use strict";

// Applies a synchronous mutation while the LMDB cursor owns the decoded
// record. Callers retain their operation-specific logging and validation.
function updateAltBlocks(hashes, mutate) {
    const targetHashes = new Set(hashes);
    const txn = global.database.env.beginTxn();
    let cursor;
    let changed = 0;

    try {
        try {
            cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
            for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
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
        } finally {
            if (cursor) cursor.close();
        }
        txn.commit();
    } catch (error) {
        // Roll back the entire edit if decoding or a caller's mutation fails.
        txn.abort();
        throw error;
    }
    return changed;
}

module.exports = updateAltBlocks;
