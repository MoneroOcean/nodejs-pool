"use strict";
const { getLocalDatabase } = require("./lib/common/database.js");
const SAFE_SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @typedef {{address: string, paymentId: string | null}} Account */
/** @typedef {{clause: string, params: string[]}} PaymentWhere */

/**
 * Validate the CLI account once; internal accounts always have a definite
 * address and use null for the absence of a payment ID.
 * @param {unknown} user
 * @returns {Account}
 */
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

/** @param {unknown} user @returns {Account} */
function splitUserOrExit(user) {
    try {
        return splitUser(user);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

/** @param {Account} account @param {boolean} allowEmptyPaymentId @returns {PaymentWhere} */
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

/** @param {string} name */
function sqlTable(name) {
    if (!SAFE_SQL_NAME.test(name)) throw new Error(`Unsafe SQL table name: ${  name}`);
    return `\`${  name  }\``;
}

/** @param {string | null} paymentId */
function formatPaymentId(paymentId) { return paymentId === null ? "(none)" : paymentId; }

/** @param {string} label @param {Account} account */
function logUser(label, account) {
    console.log(`${label  }Address: ${  account.address}`);
    console.log(`${label  }Payment ID: ${  formatPaymentId(account.paymentId)}`);
}

/** @param {string} user @param {(key: string) => void} iterator */
function forEachCacheKey(user, iterator) {
    [user, `stats:${  user}`, `history:${  user}`, `identifiers:${  user}`].forEach(iterator);
}

/** @param {string} user */
function logCacheKeys(user) {
    forEachCacheKey(user, function (key) {
        if (getLocalDatabase(global.database).getCache(key) !== false) console.log(`Existing LMDB cache key: ${  key}`);
    });
}

/** @param {string} user */
function deleteCacheKeys(user) {
    const txn = getLocalDatabase(global.database).env.beginTxn();
    try {
        forEachCacheKey(user, function (key) {
            if (getLocalDatabase(global.database).getCache(key) !== false) txn.del(getLocalDatabase(global.database).cacheDB, key);
        });
        txn.commit();
    } catch (error) {
        // A failed cache deletion must release the writer and roll back the batch.
        txn.abort();
        throw error;
    }
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
