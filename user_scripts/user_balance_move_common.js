"use strict";

const accountUtils = require("../script_account_utils.js");
const createTransactionRunner = require("../lib/common/mysql_transaction.js");

/** @typedef {{force?: boolean, confirmForceMove?: boolean, requireStaleBalance?: boolean, delayMs?: number}} MoveOptions */
/** @typedef {{amount: number | string, last_edited: string, pending_batch_id?: number | string | null}} BalanceRow */
/** @typedef {Awaited<ReturnType<typeof buildBalanceMovePlan>>} MovePlan */


/** @param {MoveOptions} options */
function requireForceConfirmation(options) {
    if (!options || options.force !== true) return;
    if (options.confirmForceMove === true) return;
    console.error("Rerun with --confirm-force-move after reviewing the source and destination balances.");
    process.exit(1);
}

/** @param {BalanceRow} row */
function assertNotPendingPayment(row) {
    if (row && row.pending_batch_id !== null && typeof row.pending_batch_id !== "undefined") {
        console.error(`Source balance is reserved by pending payment batch ${  row.pending_batch_id  }. Refusing to move reserved balance.`);
        process.exit(1);
    }
}

/** @param {MovePlan} plan @param {MoveOptions} options */
function printPreview(plan, options) {
    if (options && options.force === true) {
        console.log("In 10 seconds FORCE balance move will transfer:");
    }
    console.log(`Source balance before move: ${  global.support.coinToDecimal(plan.oldAmount)}`);
    console.log(`Source balance last update time: ${  plan.oldRow.last_edited}`);
    console.log(`Destination balance before move: ${  global.support.coinToDecimal(plan.newRow.amount)}`);
}

/** @param {string} oldUser @param {string} newUser @param {MoveOptions} [options] */
async function buildBalanceMovePlan(oldUser, newUser, options) {
    const opts = options || {};
    if (oldUser === newUser) {
        console.error("Old and new user must be different");
        process.exit(1);
    }

    const oldAccount = accountUtils.splitUserOrExit(oldUser);
    const newAccount = accountUtils.splitUserOrExit(newUser);
    const oldWhere = accountUtils.paymentWhere(oldAccount, false);
    const newWhere = accountUtils.paymentWhere(newAccount, false);
    /** @param {import("../script_account_utils.js").PaymentWhere} where @returns {Promise<BalanceRow[]>} */
    const selectBalance = function selectBalance(where) {
        return global.mysql.query(`SELECT * FROM balance WHERE ${  where.clause}`, where.params);
    };

    accountUtils.logUser("Source ", oldAccount);
    accountUtils.logUser("Destination ", newAccount);

    let rows = await selectBalance(oldWhere);
    if (rows.length !== 1 || !rows[0]) {
        console.error("Can't find source balance row");
        process.exit(1);
    }
    const oldRow = rows[0];
    const oldAmount = Number(oldRow.amount);
    if (!Number.isSafeInteger(oldAmount) || oldAmount < 0) {
        console.error("Source user has invalid balance amount");
        process.exit(1);
    }
    // A balance reserved by an in-flight payment batch must never be moved: the
    // batch may already have sent (or be about to send) to the original address,
    // so relocating the funds here would let the same money be paid twice. This
    // check is unconditional; the non-force tool used to skip it.
    assertNotPendingPayment(oldRow);
    if (opts.requireStaleBalance === true && Date.now() / 1000 - global.support.formatDateFromSQL(oldRow.last_edited) < 24 * 60 * 60) {
        console.error("There was recent amount update. Refusing to continue!");
        process.exit(1);
    }

    rows = await selectBalance(newWhere);
    if (rows.length !== 1 || !rows[0]) {
        console.error("Can't find destination balance row");
        process.exit(1);
    }
    const newRow = rows[0];

    return { oldUser, newUser, oldWhere, newWhere, oldRow, newRow, oldAmount, selectBalance };
}

/** @param {MovePlan} plan @returns {Promise<void>} */
async function applyBalanceMovePlan(plan) {
    const withTransaction = createTransactionRunner(global.mysql, "Balance moves require a transactional MySQL connection");
    await withTransaction(async function moveLockedBalances(connection) {
        /** @type {BalanceRow[]} */
        const sourceRows = await connection.query(`SELECT * FROM balance WHERE ${plan.oldWhere.clause} FOR UPDATE`, plan.oldWhere.params);
        /** @type {BalanceRow[]} */
        const destinationRows = await connection.query(`SELECT * FROM balance WHERE ${plan.newWhere.clause} FOR UPDATE`, plan.newWhere.params);
        const source = sourceRows[0];
        const destination = destinationRows[0];
        if (sourceRows.length !== 1 || destinationRows.length !== 1 || !source || !destination) {
            throw new Error("Balance rows changed since preview; refusing to move funds");
        }
        if (source.pending_batch_id != null || destination.pending_batch_id != null) {
            throw new Error("A balance is reserved by a pending payment batch; refusing to move funds");
        }
        const sourceAmount = Number(source.amount);
        const destinationAmount = Number(destination.amount);
        if (!Number.isSafeInteger(sourceAmount) || sourceAmount < 0 ||
            !Number.isSafeInteger(destinationAmount) || destinationAmount < 0 ||
            !Number.isSafeInteger(sourceAmount + destinationAmount) ||
            sourceAmount !== plan.oldAmount || destinationAmount !== Number(plan.newRow.amount)) {
            throw new Error("Balance amounts changed or are invalid; create a fresh move preview");
        }
        // Both updates use the same locked connection: a failed credit must never
        // leave the source cleared, and a payout cannot reserve either row mid-move.
        /** @type {{affectedRows: number}} */
        const debit = await connection.query(`UPDATE balance SET amount = 0 WHERE ${plan.oldWhere.clause}`, plan.oldWhere.params);
        /** @type {{affectedRows: number}} */
        const credit = await connection.query(`UPDATE balance SET amount = amount + ? WHERE ${plan.newWhere.clause}`, [sourceAmount, ...plan.newWhere.params]);
        if (debit.affectedRows !== 1 || credit.affectedRows !== 1) throw new Error("Balance update did not match exactly one account");
    });

    const [sourceRow] = await plan.selectBalance(plan.oldWhere);
    const [destinationRow] = await plan.selectBalance(plan.newWhere);
    if (!sourceRow || !destinationRow) throw new Error("Balance row disappeared after move");
    console.log(`Source balance after move: ${  global.support.coinToDecimal(sourceRow.amount)}`);
    console.log(`Destination balance after move: ${  global.support.coinToDecimal(destinationRow.amount)}`);
    console.log("Done.");
}

/** @param {string} oldUser @param {string} newUser @param {MoveOptions} [options] @returns {Promise<never>} */
async function moveBalance(oldUser, newUser, options) {
    const opts = options || {};
    requireForceConfirmation(opts);
    const plan = await buildBalanceMovePlan(oldUser, newUser, opts);
    printPreview(plan, opts);
    const delayMs = Number(opts.delayMs) || 0;
    if (delayMs > 0) {
        await new Promise(function wait(resolve) {
            setTimeout(resolve, delayMs);
        });
    }
    await applyBalanceMovePlan(plan);
    process.exit(0);
}

moveBalance.buildBalanceMovePlan = buildBalanceMovePlan;
moveBalance.applyBalanceMovePlan = applyBalanceMovePlan;
moveBalance.printPreview = printPreview;

module.exports = moveBalance;
