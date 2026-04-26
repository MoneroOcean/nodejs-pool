"use strict";
const accountUtils = require("../script_account_utils.js");

function requireForceConfirmation(options) {
    if (!options || options.force !== true) return;
    if (options.confirmForceDelete === true) return;
    console.error("Rerun with --confirm-force-delete=true after reviewing the rows and cache keys that will be deleted.");
    process.exit(1);
}

function printPreview(plan, options) {
    const prefix = options && options.force === true ? "FORCE " : "";
    if (options && options.force === true) {
        console.log("In 10 seconds " + prefix + "user delete will remove:");
    }
    console.log("Rows in users table: " + plan.userRows.length);
    console.log("Rows in balance table: " + plan.balanceRows.length);
    console.log("Rows in payments table: " + plan.paymentRows.length);
    plan.extraRows.forEach(function printTable(table) {
        console.log("Rows in " + table.name + " table: " + table.rows.length);
    });
    accountUtils.logCacheKeys(plan.user);
}

async function buildUserDeletePlan(user, options) {
    options = options || {};
    const account = accountUtils.splitUserOrExit(user);
    const where = accountUtils.paymentWhere(account, true);
    const extraTables = (options.extraTables || []).map(function (name) {
        return { name, sql: accountUtils.sqlTable(name) };
    });
    const queryRows = function queryRows(table) {
        return global.mysql.query("SELECT * FROM " + table + " WHERE " + where.clause, where.params);
    };
    let rows2remove = 0;

    accountUtils.logUser("Target ", account);
    console.log("Maximum allowed remaining payment: " + global.config.payout.walletMin);

    const userRows = await global.mysql.query("SELECT * FROM users WHERE username = ?", [user]);
    if (userRows.length > 1) {
        console.error("Too many users were selected!");
        process.exit(1);
    }
    rows2remove += userRows.length;

    const balanceRows = await queryRows("balance");
    if (balanceRows.length > 1) {
        console.error("Too many users were selected!");
        process.exit(1);
    }
    if (!options.force && balanceRows.length === 1 && balanceRows[0].amount >= global.support.decimalToCoin(global.config.payout.walletMin)) {
        console.error("Remaining payment is too large: " + global.support.coinToDecimal(balanceRows[0].amount));
        process.exit(1);
    }
    if (options.requireStaleBalance === true && balanceRows.length) {
        console.log("Balance last update time: " + balanceRows[0].last_edited);
        if (Date.now() / 1000 - global.support.formatDateFromSQL(balanceRows[0].last_edited) < 12 * 60 * 60) {
            console.error("There was recent amount update. Refusing to continue!");
            process.exit(1);
        }
    }
    rows2remove += balanceRows.length;

    const paymentRows = await queryRows("payments");
    rows2remove += paymentRows.length;

    const extraRows = [];
    for (const table of extraTables) {
        const rows = await queryRows(table.sql);
        extraRows.push({ name: table.name, sql: table.sql, rows });
        rows2remove += rows.length;
    }

    if (!rows2remove) {
        console.error("No matching SQL rows found. Refusing to proceed to LMDB cache cleaning");
        process.exit(1);
    }

    return { account, user, where, userRows, balanceRows, paymentRows, extraRows };
}

async function applyUserDeletePlan(plan) {
    const deleteRows = function deleteRows(table) {
        return global.mysql.query("DELETE FROM " + table + " WHERE " + plan.where.clause, plan.where.params);
    };

    const user = plan.user;
    await global.mysql.query("DELETE FROM users WHERE username = ?", [user]);
    console.log("Executed SQL: DELETE FROM users WHERE username = " + user);
    await deleteRows("balance");
    console.log("Executed SQL: DELETE FROM balance WHERE " + plan.where.clause);
    await deleteRows("payments");
    console.log("Executed SQL: DELETE FROM payments WHERE " + plan.where.clause);

    for (const table of plan.extraRows) {
        await deleteRows(table.sql);
        console.log("Executed SQL: DELETE FROM " + table.name + " WHERE " + plan.where.clause);
    }

    console.log("Deleting LMDB cache keys...");
    accountUtils.deleteCacheKeys(user);
    console.log("Done.");
}

async function runUserDelete(user, options) {
    options = options || {};
    requireForceConfirmation(options);
    const plan = await buildUserDeletePlan(user, options);
    printPreview(plan, options);
    const delayMs = Number(options.delayMs) || 0;
    if (delayMs > 0) {
        await new Promise(function wait(resolve) {
            setTimeout(resolve, delayMs);
        });
    }
    await applyUserDeletePlan(plan);
    process.exit(0);
}

runUserDelete.buildUserDeletePlan = buildUserDeletePlan;
runUserDelete.applyUserDeletePlan = applyUserDeletePlan;
runUserDelete.printPreview = printPreview;

module.exports = runUserDelete;
