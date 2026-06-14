"use strict";
const lmdb = require('node-lmdb');
const fs   = require('fs');
const cli = require("../script_utils.js")();
const dir = cli.arg("dir", "Please specify output lmdb dir");
const size = cli.arg("size", "Please specify output lmdb size in GB");

if (fs.existsSync(dir + "/data.mdb")) {
    console.error("Please specify empty output lmdb dir");
    process.exit(1);
}

cli.init(function() {
    // Each DB is copied under a single source read txn so the copy is a consistent snapshot.
    // That snapshot is held for the whole copy, which pins source pages and blocks reuse - run
    // this with the pool stopped, otherwise a large copy can drive a live source DB to map-full.
    console.log("Note: copying holds a read snapshot of the source DB; run with the pool stopped.");

    let env2 = new lmdb.Env();
    env2.open({
        path: dir,
        maxDbs: 10,
        mapSize: size * 1024 * 1024 * 1024,
        useWritemap: true,
        maxReaders: 512
    });
    // env2 is a second env not covered by the init_mini exit handler, so it is closed in a
    // finally below and each per-DB copy ends its txns/cursor on every path.
    try {
        const databases = [
            {
                label: "blocks",
                source: global.database.blockDB,
                target: env2.openDbi({ name: "blocks", create: true, integerKey: true, keyIsUint32: true })
            },
            {
                label: "altblocks",
                source: global.database.altblockDB,
                target: env2.openDbi({ name: "altblocks", create: true, integerKey: true, keyIsUint32: true })
            },
            {
                label: "shares",
                source: global.database.shareDB,
                target: env2.openDbi({
                    name: "shares",
                    create: true,
                    dupSort: true,
                    dupFixed: false,
                    integerDup: true,
                    integerKey: true,
                    keyIsUint32: true
                })
            },
            {
                label: "cache",
                source: global.database.cacheDB,
                target: env2.openDbi({ name: "cache", create: true })
            }
        ];

        databases.forEach(function copyDb(database) {
            console.log("Copying " + database.label);
            const txn = global.database.env.beginTxn({ readOnly: true });
            const cursor = new global.database.lmdb.Cursor(txn, database.source);
            const txn2 = env2.beginTxn();
            try {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data) {
                        txn2.putBinary(database.target, key, data);
                    });
                }
                txn2.commit();
            } catch (error) {
                txn2.abort();
                throw error;
            } finally {
                cursor.close();
                txn.abort();
            }
        });
    } finally {
        env2.close();
    }

    console.log("DONE");
    process.exit(0);
});
