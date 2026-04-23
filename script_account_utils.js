"use strict";

const SAFE_SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitUser(user) {
    if (typeof user !== "string" || user.length === 0) throw new Error("User must be a non-empty string");
    const parts = user.split(".");
    const address = parts[0];
    const paymentId = parts[1];
    if (!address || parts.length > 2 || paymentId === "") {
        throw new Error("User must be in <address> or <address>.<paymentId> format");
    }
    return {
        address,
        paymentId: paymentId || null
    };
}

function splitUserOrExit(user) {
    try {
        return splitUser(user);
    } catch (error) {
        console.error(error.message || String(error));
        process.exit(1);
    }
}

function paymentWhere(account, allowEmptyPaymentId) {
    if (account.paymentId !== null) {
        return {
            clause: "payment_address = ? AND payment_id = ?",
            params: [account.address, account.paymentId]
        };
    }
    return {
        clause: allowEmptyPaymentId === true
            ? "payment_address = ? AND (payment_id IS NULL OR payment_id = '')"
            : "payment_address = ? AND payment_id IS NULL",
        params: [account.address]
    };
}

function sqlTable(name) {
    if (!SAFE_SQL_NAME.test(name)) throw new Error("Unsafe SQL table name: " + name);
    return "`" + name + "`";
}

function logUser(label, account) {
    console.log(label + "Address: " + account.address);
    console.log(label + "PaymentID: " + account.paymentId);
}

function forEachCacheKey(user, iterator) {
    [user, "stats:" + user, "history:" + user, "identifiers:" + user].forEach(iterator);
}

function logCacheKeys(user) {
    forEachCacheKey(user, function (key) {
        if (global.database.getCache(key) !== false) console.log("Cache key is not empty: " + key);
    });
}

function deleteCacheKeys(user) {
    const txn = global.database.env.beginTxn();
    forEachCacheKey(user, function (key) {
        if (global.database.getCache(key) !== false) txn.del(global.database.cacheDB, key);
    });
    txn.commit();
}

module.exports = {
    deleteCacheKeys,
    logCacheKeys,
    logUser,
    paymentWhere,
    sqlTable,
    splitUserOrExit,
    splitUser
};
