"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const cli = require("../script_utils.js")();

cli.init(function() {
    const localDatabase = getLocalDatabase(global.database);
    console.log("Cleaning up the alt block DB. Searching for items to delete");
        /** @type {Array<string | number | Buffer>} */
        const deleted = [];
        /** @type {Record<number, number>} */
        const block_count = Object.create(null);
    cli.forEachBinaryEntry(localDatabase.altblockDB, function (key, data) {
        const blockData = global.protos.AltBlock.decode(data);
                const count = (block_count[blockData.port] ?? 0) + 1;
                block_count[blockData.port] = count;
                // Prune unlocked blocks past a per-port cap of 20000 (reverse scan keeps newest) or older than 3 years.
                if (blockData.unlocked && (count > 20000 || Date.now() - blockData.timestamp > 3*365*24*60*60*1000)) {
                   deleted.push(key);
                }
    }, { reverse: true });

    console.log(`Deleting altblock items: ${  deleted.length}`);

        let chunkSize = 0;
        let txn = localDatabase.env.beginTxn();
        try {
            deleted.forEach(function(key) {
                ++ chunkSize;
                txn.del(localDatabase.altblockDB, key);
                if (chunkSize > 500) {
                    txn.commit();
                    txn = localDatabase.env.beginTxn();
                    chunkSize = 0;
                }
            });
            txn.commit();
        } catch (error) {
            // Abort the open write txn so the env's single writer lock is released immediately.
            try { txn.abort(); } catch (_error) { /* best-effort txn abort; ignore if already aborted */ }
            throw error;
        }
    process.exit(0);
});
