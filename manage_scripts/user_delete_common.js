"use strict";
const accountUtils = require("../script_account_utils.js");
const createTransactionRunner = require("../lib/common/mysql_transaction.js");

/** @typedef {{force?: boolean, confirmForceDelete?: boolean, requireStaleBalance?: boolean, delayMs?: number, extraTables?: string[]}} DeleteOptions */
/** @typedef {Awaited<ReturnType<typeof buildUserDeletePlan>>} DeletePlan */


/** @param {DeleteOptions} options */
function requireForceConfirmation(options) {
    if (!options || options.force !== true) return;
    if (options.confirmForceDelete === true) return;
    console.error("Rerun with --confirm-force-delete after reviewing the rows and cache keys that will be deleted.");
    process.exit(1);
}

/** @param {DeletePlan} plan @param {DeleteOptions} options */
function printPreview(plan, options) {
    const prefix = options && options.force === true ? "FORCE " : "";
    if (options && options.force === true) {
        console.log(`In 10 seconds ${  prefix  }user delete will remove:`);
    }
    console.log(`Rows in users table: ${  plan.userRows.length}`);
    console.log(`Rows in balance table: ${  plan.balanceRows.length}`);
    console.log(`Rows in payments table: ${  plan.paymentRows.length}`);
    plan.extraRows.forEach(function printTable(table) {
        console.log(`Rows in ${  table.name  } table: ${  table.rows.length}`);
    });
    accountUtils.logCacheKeys(plan.user);
}

/** @param {string} user @param {DeleteOptions} [options] */
async function buildUserDeletePlan(user, options) {
    const opts = options || {};
    const account = accountUtils.splitUserOrExit(user);
    const where = accountUtils.paymentWhere(account, true);
    const extraTables = (opts.extraTables || []).map(function toExtraTable(name) {
        return { name, sql: accountUtils.sqlTable(name) };
    });
    /** @template {import("../types/runtime").SqlRow} [T=import("../types/runtime").SqlRow] @param {string} table @returns {Promise<T[]>} */
    const queryRows = function queryRows(table) {
        return global.mysql.query(`SELECT * FROM ${  table  } WHERE ${  where.clause}`, where.params);
    };
    let rows2remove = 0;

    accountUtils.logUser("Target ", account);
    console.log(`Maximum allowed remaining payment: ${  global.config.payout.walletMin}`);

    const userRows = await global.mysql.query("SELECT * FROM users WHERE username = ?", [user]);
    if (userRows.length > 1) {
        console.error("Too many users were selected!");
        process.exit(1);
    }
    rows2remove += userRows.length;

    /** @type {import("../user_scripts/user_balance_move_common.js").BalanceRow[]} */
    const balanceRows = await queryRows("balance");
    const balance = balanceRows[0] ?? null;
    if (balanceRows.length > 1) {
        console.error("Too many users were selected!");
        process.exit(1);
    }
    // Refuse (even under --force) to delete a balance row reserved by an in-flight payment batch:
    // removing a row whose pending_batch_id is set would make the payment finalizer's reserved-row
    // update mismatch and wedge payout recovery. Mirrors the same guard in user_balance_move.
    if (balance && balance.pending_batch_id !== null && balance.pending_batch_id !== undefined) {
        console.error(`Balance row is reserved by in-flight payment batch ${  balance.pending_batch_id 
            }; refusing to delete. Wait for the batch to settle (or clear its pending_batch_id) and retry.`);
        process.exit(1);
    }
    if (!opts.force && balance && Number(balance.amount) >= global.support.decimalToCoin(global.config.payout.walletMin)) {
        console.error(`Remaining payment is too large: ${  global.support.coinToDecimal(balance.amount)}`);
        process.exit(1);
    }
    if (opts.requireStaleBalance === true && balance) {
        console.log(`Balance last update time: ${  balance.last_edited}`);
        if (Date.now() / 1000 - global.support.formatDateFromSQL(balance.last_edited) < 12 * 60 * 60) {
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

/** @param {DeletePlan} plan @returns {Promise<void>} */
async function applyUserDeletePlan(plan) {
    const withTransaction = createTransactionRunner(global.mysql, "User deletion requires a transactional MySQL connection");
    await withTransaction(async function deleteLockedAccount(connection) {
        /** @type {import("../user_scripts/user_balance_move_common.js").BalanceRow[]} */
        const balances = await connection.query(`SELECT * FROM balance WHERE ${plan.where.clause} FOR UPDATE`, plan.where.params);
        const current = balances[0] ?? null;
        const preview = plan.balanceRows[0] ?? null;
        if (balances.length !== plan.balanceRows.length ||
            (current && (current.pending_batch_id != null || !preview || Number(current.amount) !== Number(preview.amount)))) {
            throw new Error("Balance changed or became reserved since preview; refusing to delete user");
        }
        await connection.query("DELETE FROM users WHERE username = ?", [plan.user]);
        /** @type {{affectedRows: number}} */
        const deletedBalance = await connection.query(`DELETE FROM balance WHERE ${plan.where.clause}`, plan.where.params);
        if (deletedBalance.affectedRows !== balances.length) throw new Error("Balance rows changed during user deletion");
        for (const table of ["payments", ...plan.extraRows.map((entry) => entry.sql)]) {
            await connection.query(`DELETE FROM ${table} WHERE ${plan.where.clause}`, plan.where.params);
        }
    });
    console.log(`Deleted SQL rows for ${plan.user}`);

    // LMDB is a separate store: clean its derived cache only after SQL commits.
    console.log("Deleting LMDB cache keys...");
    accountUtils.deleteCacheKeys(plan.user);
    console.log("Done.");
}

/** @param {string} user @param {DeleteOptions} [options] @returns {Promise<never>} */
async function runUserDelete(user, options) {
    const opts = options || {};
    requireForceConfirmation(opts);
    const plan = await buildUserDeletePlan(user, opts);
    printPreview(plan, opts);
    const delayMs = Number(opts.delayMs) || 0;
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
