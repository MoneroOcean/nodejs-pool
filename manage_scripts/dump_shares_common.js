"use strict";
module.exports = function dumpShares(depth, shouldPrint) {
    global.coinFuncs.getLastBlockHeader(function (err, body) {
        if (err !== null) {
            console.error("Invalid block header");
            process.exit(1);
        }

        const lastBlock = body.height + 1;
        const txn = global.database.env.beginTxn({ readOnly: true });
        const cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);

        for (let blockID = lastBlock; blockID > lastBlock - depth; --blockID) {
            for (let found = cursor.goToRange(parseInt(blockID)) === blockID; found; found = cursor.goToNextDup()) {
                cursor.getCurrentBinary(function (_key, data) {
                    const shareData = global.protos.Share.decode(data);
                    if (!shouldPrint(shareData)) return;
                    const d = new Date(shareData.timestamp);
                    console.log(d.toString() + ": " + JSON.stringify(shareData));
                }); // jshint ignore:line
            }
        }

        cursor.close();
        txn.commit();
        process.exit(0);
    });
};
