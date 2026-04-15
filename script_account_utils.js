"use strict";

function splitUser(user) {
    const parts = user.split(".");
    return {
        address: parts.length === 1 ? user : parts[0],
        paymentId: parts.length === 2 ? parts[1] : null
    };
}

function paymentWhere(account, allowEmptyPaymentId) {
    if (account.paymentId !== null) {
        return "payment_address = '" + account.address + "' AND payment_id = '" + account.paymentId + "'";
    }
    return allowEmptyPaymentId === true ?
        "payment_address = '" + account.address + "' AND (payment_id IS NULL OR payment_id = '')" :
        "payment_address = '" + account.address + "' AND payment_id IS NULL";
}

function logUser(label, account) {
    console.log(label + "Address: " + account.address);
    console.log(label + "PaymentID: " + account.paymentId);
}

function cacheKeys(user) {
    return [user, "stats:" + user, "history:" + user, "identifiers:" + user];
}

function logCacheKeys(user) {
    cacheKeys(user).forEach(function (key) {
        if (global.database.getCache(key) != false) console.log("Cache key is not empty: " + key);
    });
}

function deleteCacheKeys(user) {
    const txn = global.database.env.beginTxn();
    cacheKeys(user).forEach(function (key) {
        if (global.database.getCache(key)) txn.del(global.database.cacheDB, key);
    });
    txn.commit();
}

module.exports = {
    cacheKeys,
    deleteCacheKeys,
    logCacheKeys,
    logUser,
    paymentWhere,
    splitUser
};
