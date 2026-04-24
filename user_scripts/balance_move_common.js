"use strict";

const accountUtils = require("../script_account_utils.js");

module.exports = async function moveBalance(oldUser, newUser, options) {
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
    let rows;

    accountUtils.logUser("Source ", oldAccount);
    accountUtils.logUser("Destination ", newAccount);

    rows = await selectBalance(oldWhere);
    if (rows.length != 1) {
        console.error("Can't find source balance row");
        process.exit(1);
    }
    oldAmount = Number(rows[0].amount);
    if (!Number.isFinite(oldAmount) || oldAmount < 0) {
        console.error("Source user has invalid balance amount");
        process.exit(1);
    }
    console.log("Source balance before move: " + global.support.coinToDecimal(oldAmount));
    console.log("Source balance last update time: " + rows[0].last_edited);
    if (options.requireStaleBalance === true && Date.now() / 1000 - global.support.formatDateFromSQL(rows[0].last_edited) < 24 * 60 * 60) {
        console.error("There was recent amount update. Refusing to continue!");
        process.exit(1);
    }

    rows = await selectBalance(newWhere);
    if (rows.length != 1) {
        console.error("Can't find destination balance row");
        process.exit(1);
    }
    console.log("Destination balance before move: " + global.support.coinToDecimal(rows[0].amount));

    await global.mysql.query("UPDATE balance SET amount = 0 WHERE " + oldWhere.clause, oldWhere.params);
    console.log("Executed SQL: UPDATE balance SET amount = 0 WHERE " + oldWhere.clause);
    await global.mysql.query("UPDATE balance SET amount = amount + ? WHERE " + newWhere.clause, [oldAmount].concat(newWhere.params));
    console.log("Executed SQL: UPDATE balance SET amount = amount + ? WHERE " + newWhere.clause);

    rows = await selectBalance(oldWhere);
    console.log("Source balance after move: " + global.support.coinToDecimal(rows[0].amount));
    rows = await selectBalance(newWhere);
    console.log("Destination balance after move: " + global.support.coinToDecimal(rows[0].amount));
    console.log("Done.");
    process.exit(0);
};
