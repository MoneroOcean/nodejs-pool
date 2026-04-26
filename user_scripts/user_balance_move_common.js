"use strict";

const accountUtils = require("../script_account_utils.js");

function requireForceConfirmation(options) {
    if (!options || options.force !== true) return;
    if (options.confirmForceMove === true) return;
    console.error("Rerun with --confirm-force-move=true after reviewing the source and destination balances.");
    process.exit(1);
}

function assertNotPendingPayment(row) {
    if (row && row.pending_batch_id !== null && typeof row.pending_batch_id !== "undefined") {
        console.error("Source balance is reserved by pending payment batch " + row.pending_batch_id + ". Refusing force move.");
        process.exit(1);
    }
}

function printPreview(plan, options) {
    if (options && options.force === true) {
        console.log("In 10 seconds FORCE balance move will transfer:");
    }
    console.log("Source balance before move: " + global.support.coinToDecimal(plan.oldAmount));
    console.log("Source balance last update time: " + plan.oldRow.last_edited);
    console.log("Destination balance before move: " + global.support.coinToDecimal(plan.newRow.amount));
}

async function buildBalanceMovePlan(oldUser, newUser, options) {
    options = options || {};
    if (oldUser === newUser) {
        console.error("Old and new user must be different");
        process.exit(1);
    }

    const oldAccount = accountUtils.splitUserOrExit(oldUser);
    const newAccount = accountUtils.splitUserOrExit(newUser);
    const oldWhere = accountUtils.paymentWhere(oldAccount, false);
    const newWhere = accountUtils.paymentWhere(newAccount, false);
    const selectBalance = function selectBalance(where) {
        return global.mysql.query("SELECT * FROM balance WHERE " + where.clause, where.params);
    };
    let oldAmount;

    accountUtils.logUser("Source ", oldAccount);
    accountUtils.logUser("Destination ", newAccount);

    let rows = await selectBalance(oldWhere);
    if (rows.length != 1) {
        console.error("Can't find source balance row");
        process.exit(1);
    }
    const oldRow = rows[0];
    oldAmount = Number(rows[0].amount);
    if (!Number.isFinite(oldAmount) || oldAmount < 0) {
        console.error("Source user has invalid balance amount");
        process.exit(1);
    }
    if (options.force === true) assertNotPendingPayment(oldRow);
    if (options.requireStaleBalance === true && Date.now() / 1000 - global.support.formatDateFromSQL(rows[0].last_edited) < 24 * 60 * 60) {
        console.error("There was recent amount update. Refusing to continue!");
        process.exit(1);
    }

    rows = await selectBalance(newWhere);
    if (rows.length != 1) {
        console.error("Can't find destination balance row");
        process.exit(1);
    }
    const newRow = rows[0];

    return { oldUser, newUser, oldWhere, newWhere, oldRow, newRow, oldAmount, selectBalance };
}

async function applyBalanceMovePlan(plan) {
    await global.mysql.query("UPDATE balance SET amount = 0 WHERE " + plan.oldWhere.clause, plan.oldWhere.params);
    console.log("Executed SQL: UPDATE balance SET amount = 0 WHERE " + plan.oldWhere.clause);
    await global.mysql.query("UPDATE balance SET amount = amount + ? WHERE " + plan.newWhere.clause, [plan.oldAmount].concat(plan.newWhere.params));
    console.log("Executed SQL: UPDATE balance SET amount = amount + ? WHERE " + plan.newWhere.clause);

    let rows = await plan.selectBalance(plan.oldWhere);
    console.log("Source balance after move: " + global.support.coinToDecimal(rows[0].amount));
    rows = await plan.selectBalance(plan.newWhere);
    console.log("Destination balance after move: " + global.support.coinToDecimal(rows[0].amount));
    console.log("Done.");
}

async function moveBalance(oldUser, newUser, options) {
    options = options || {};
    requireForceConfirmation(options);
    const plan = await buildBalanceMovePlan(oldUser, newUser, options);
    printPreview(plan, options);
    const delayMs = Number(options.delayMs) || 0;
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
