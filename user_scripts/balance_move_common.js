"use strict";

const accountUtils = require("../script_account_utils.js");

module.exports = async function moveBalance(oldUser, newUser, options) {
    const oldAccount = accountUtils.splitUser(oldUser);
    const newAccount = accountUtils.splitUser(newUser);
    const oldWhereStr = accountUtils.paymentWhere(oldAccount, false);
    const newWhereStr = accountUtils.paymentWhere(newAccount, false);
    let oldAmount;
    let rows;

    accountUtils.logUser("Old ", oldAccount);
    accountUtils.logUser("New ", newAccount);

    rows = await global.mysql.query("SELECT * FROM balance WHERE " + oldWhereStr);
    if (rows.length != 1) {
        console.error("Can't find old_user!");
        process.exit(1);
    }
    oldAmount = rows[0].amount;
    console.log("Old address amount: " + global.support.coinToDecimal(oldAmount));
    console.log("Old address last update time: " + rows[0].last_edited);
    if (options.requireStaleBalance === true && Date.now() / 1000 - global.support.formatDateFromSQL(rows[0].last_edited) < 24 * 60 * 60) {
        console.error("There was recent amount update. Refusing to continue!");
        process.exit(1);
    }

    rows = await global.mysql.query("SELECT * FROM balance WHERE " + newWhereStr);
    if (rows.length != 1) {
        console.error("Can't find new_user!");
        process.exit(1);
    }
    console.log("New address amount: " + global.support.coinToDecimal(rows[0].amount));

    await global.mysql.query("UPDATE balance SET amount = '0' WHERE " + oldWhereStr);
    console.log("UPDATE balance SET amount = '0' WHERE " + oldWhereStr);
    await global.mysql.query("UPDATE balance SET amount = amount + " + oldAmount + " WHERE " + newWhereStr);
    console.log("UPDATE balance SET amount = amount + " + oldAmount + " WHERE " + newWhereStr);

    rows = await global.mysql.query("SELECT * FROM balance WHERE " + oldWhereStr);
    console.log("New old address amount: " + global.support.coinToDecimal(rows[0].amount));
    rows = await global.mysql.query("SELECT * FROM balance WHERE " + newWhereStr);
    console.log("New new address amount: " + global.support.coinToDecimal(rows[0].amount));
    console.log("DONE");
    process.exit(0);
};
