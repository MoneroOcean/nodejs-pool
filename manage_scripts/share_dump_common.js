"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
/** @param {unknown} depth @param {(share: import("../types/runtime").Share) => boolean} shouldPrint */
module.exports = function dumpShares(depth, shouldPrint) {
    const numericDepth = Number(depth);
    if (!Number.isInteger(numericDepth) || numericDepth <= 0) {
        console.error("Depth must be a positive integer");
        process.exit(1);
    }
    global.coinFuncs.getLastBlockHeader(function (error, body) {
        if (error !== null || !body) {
            console.error("Invalid block header");
            process.exit(1);
        }

        const lastBlock = body.height + 1;
        const txn = getLocalDatabase(global.database).env.beginTxn({ readOnly: true });
        /** @type {import("node-lmdb").Cursor<number> | undefined} */
        let cursor;

        try {
            cursor = new (getLocalDatabase(global.database).lmdb.Cursor)(txn, getLocalDatabase(global.database).shareDB);
            for (let blockID = lastBlock; blockID > lastBlock - numericDepth; --blockID) {
                // shareDB keys are block heights with duplicate values; only walk dups when an exact key match exists.
                for (let found = cursor.goToRange(blockID) === blockID; found; found = cursor.goToNextDup() !== null) {
                    cursor.getCurrentBinary(function (_key, data) {
                        const shareData = global.protos.Share.decode(data);
                        if (!shouldPrint(shareData)) return;
                        const date = new Date(shareData.timestamp);
                        console.log(`${date.toString()  }: ${  JSON.stringify(shareData)}`);
                    }); // jshint ignore:line
                }
            }
        } finally {
            // Decoding or printing a damaged share must not retain a read snapshot.
            try {
                if (cursor) cursor.close();
            } finally {
                txn.abort();
            }
        }
        process.exit(0);
    });
};
