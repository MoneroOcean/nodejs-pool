"use strict";

/** @param {string} user @param {string} reason @returns {Promise<unknown>} */
module.exports = function insertBan(user, reason) {
    return global.mysql.query(
        "INSERT INTO bans (mining_address, reason) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=id",
        [user, reason]
    );
};
