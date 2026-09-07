"use strict";
/** @param {string} user @returns {Promise<Array<{username: string}>>} */
function queryUsers(user) { return global.mysql.query("SELECT * FROM users WHERE username = ?", [user]); }

/** @param {string} user @param {string} errorMessage @param {{logFound?: boolean}} [options] @returns {Promise<void>} */
function requireExistingUser(user, errorMessage, options = {}) {
    return queryUsers(user).then(function (rows) {
        if (rows.length !== 1) {
            console.error(errorMessage);
            process.exit(1);
        }
        if (options.logFound === true) console.log(`Found rows in users table: ${  rows.length}`);
    });
}

/** @param {string} sql @param {Array<string | number | null>} params @param {string} [logMessage] @returns {Promise<void>} */
function runLoggedQuery(sql, params, logMessage) {
    return global.mysql.query(sql, params).then(function () {
        if (logMessage) console.log(logMessage);
    });
}

/** @param {string} message @returns {never} */
function finish(message) {
    console.log(message);
    process.exit(0);
}

module.exports = {
    finish,
    requireExistingUser,
    runLoggedQuery
};
