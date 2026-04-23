"use strict";

const accountUtils = require("../script_account_utils.js");

module.exports = async function runUserDelete(user, options) {
    const account = accountUtils.splitUserOrExit(user);
    const where = accountUtils.paymentWhere(account, true);
    const extraTables = (options.extraTables || []).map(function (name) {
        return { name, sql: accountUtils.sqlTable(name) };
    });
    const queryRows = function queryRows(table) {
        return global.mysql.query("SELECT * FROM " + table + " WHERE " + where.clause, where.params);
    };
    const deleteRows = function deleteRows(table) {
        return global.mysql.query("DELETE FROM " + table + " WHERE " + where.clause, where.params);
    };
    let rows2remove = 0;
    let rows;

    accountUtils.logUser("", account);
    console.log("Max payment to remove: " + global.config.payout.walletMin);

    rows = await global.mysql.query("SELECT * FROM users WHERE username = ?", [user]);
    if (rows.length > 1) {
        console.error("Too many users were selected!");
        process.exit(1);
    }
    console.log("Found rows in users table: " + rows.length);
    rows2remove += rows.length;

    rows = await queryRows("balance");
    if (rows.length > 1) {
        console.error("Too many users were selected!");
        process.exit(1);
    }
    if (rows.length === 1 && rows[0].amount >= global.support.decimalToCoin(global.config.payout.walletMin)) {
        console.error("Too big payment left: " + global.support.coinToDecimal(rows[0].amount));
        process.exit(1);
    }
    if (options.requireStaleBalance === true && rows.length) {
        console.log("Balance last update time: " + rows[0].last_edited);
        if (Date.now() / 1000 - global.support.formatDateFromSQL(rows[0].last_edited) < 12 * 60 * 60) {
            console.error("There was recent amount update. Refusing to continue!");
            process.exit(1);
        }
    }
    console.log("Found rows in balance table: " + rows.length);
    rows2remove += rows.length;

    rows = await queryRows("payments");
    console.log("Found rows in payments table: " + rows.length);
    rows2remove += rows.length;

    for (const table of extraTables) {
        rows = await queryRows(table.sql);
        console.log("Found rows in " + table.name + " table: " + rows.length);
        rows2remove += rows.length;
    }

    accountUtils.logCacheKeys(user);
    if (!rows2remove) {
        console.error("User was not found in SQL. Refusing to proceed to LMDB cache cleaning");
        process.exit(1);
    }

    await global.mysql.query("DELETE FROM users WHERE username = ?", [user]);
    console.log("DELETE FROM users WHERE username = " + user);
    await deleteRows("balance");
    console.log("DELETE FROM balance WHERE " + where.clause);
    await deleteRows("payments");
    console.log("DELETE FROM payments WHERE " + where.clause);

    for (const table of extraTables) {
        await deleteRows(table.sql);
        console.log("DELETE FROM " + table.name + " WHERE " + where.clause);
    }

    console.log("Deleting LMDB cache keys");
    accountUtils.deleteCacheKeys(user);
    console.log("DONE");
    process.exit(0);
};
