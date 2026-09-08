"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");

// Applies a synchronous mutation while the LMDB cursor owns the decoded
// record. Callers retain their operation-specific logging and validation.
/** @param {string[]} hashes @param {(block: import("../types/runtime").AltBlockMessage) => void} mutate */
function updateAltBlocks(hashes, mutate) {
    const targetHashes = new Set(hashes);
    const txn = getLocalDatabase(global.database).env.beginTxn();
    let cursor;
    let changed = 0;

    try {
        try {
            cursor = new (getLocalDatabase(global.database).lmdb.Cursor)(txn, getLocalDatabase(global.database).altblockDB);
            for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
                cursor.getCurrentBinary(function onBlock(key, data) {
                    const block = global.protos.AltBlock.decode(data);
                    if (!targetHashes.has(block.hash)) return;
                    console.log(`Found altblock with ${  block.hash  } hash`);
                    mutate(block);
                    txn.putBinary(getLocalDatabase(global.database).altblockDB, key, global.protos.AltBlock.encode(block));
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
