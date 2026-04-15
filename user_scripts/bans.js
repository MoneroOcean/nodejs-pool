"use strict";

module.exports = function printBans(callback) {
    global.mysql.query("SELECT * FROM bans").then(function (rows) {
        for (const row of rows) {
            console.log(row.mining_address + ": " + row.reason);
        }
        callback();
    });
};
