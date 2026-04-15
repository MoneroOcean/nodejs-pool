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
        let env2 = new lmdb.Env();
        env2.open({
            path: dir,
            maxDbs: 10,
            mapSize: size * 1024 * 1024 * 1024,
            useWritemap: true,
            maxReaders: 512
        });
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
            let txn = global.database.env.beginTxn({ readOnly: true });
            let txn2 = env2.beginTxn();
            let cursor = new global.database.lmdb.Cursor(txn, database.source);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                cursor.getCurrentBinary(function(key, data) {
                    txn2.putBinary(database.target, key, data);
                });
            }
            cursor.close();
            txn.commit();
            txn2.commit();
        });

        env2.close();
 	console.log("DONE");
	process.exit(0);
});
