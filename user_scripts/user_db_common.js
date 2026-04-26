"use strict";
function queryUsers(user) { return global.mysql.query("SELECT * FROM users WHERE username = ?", [user]); }

function requireExistingUser(user, errorMessage, options = {}) {
    return queryUsers(user).then(function (rows) {
        if (rows.length != 1) {
            console.error(errorMessage);
            process.exit(1);
        }
        if (options.logFound === true) console.log("Found rows in users table: " + rows.length);
    });
}

function requireMissingUser(user, errorMessage, options = {}) {
    return queryUsers(user).then(function (rows) {
        if (rows.length == 1) {
            console.error(errorMessage);
            if (options.logRowsOnFailure === true) console.log("Found rows in users table: " + rows.length);
            process.exit(1);
        }
    });
}

function runLoggedQuery(sql, params, logMessage) {
    return global.mysql.query(sql, params).then(function () {
        if (logMessage) console.log(logMessage);
    });
}

function finish(message) {
    console.log(message);
    process.exit(0);
}

module.exports = {
    finish,
    queryUsers,
    requireExistingUser,
    requireMissingUser,
    runLoggedQuery
};
