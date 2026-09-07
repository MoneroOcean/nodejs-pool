"use strict";
/** @param {() => void} callback */
module.exports = function printBans(callback) {
    /** @type {Promise<Array<{mining_address: string, reason: string}>>} */
    const result = global.mysql.query("SELECT * FROM bans");
    result.then(function (rows) {
        for (const row of rows) {
            console.log(`${row.mining_address  }: ${  row.reason}`);
        }
        callback();
    });
};
