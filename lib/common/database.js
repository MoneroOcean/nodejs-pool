"use strict";

/** @typedef {import("../../types/runtime").DatabaseRuntime} DatabaseRuntime */
/** @typedef {import("../../types/runtime").DatabaseCandidate} DatabaseCandidate */
/** @typedef {import("../../types/runtime").LocalDatabaseRuntime} LocalDatabaseRuntime */

/** @param {DatabaseRuntime} value @returns {LocalDatabaseRuntime} */
function getLocalDatabase(value) {
    if (value.role !== "local") throw new Error("Local database runtime is required");
    return value;
}

/** @param {DatabaseRuntime} value @returns {import("../../types/runtime").RemoteDatabaseRuntime} */
function getRemoteDatabase(value) {
    if (value.role !== "remote") throw new Error("Remote database uplink is not initialized");
    return value;
}

/** @param {DatabaseCandidate | undefined} value @returns {value is LocalDatabaseRuntime} */
function isInitializedLocalDatabase(value) {
    return value !== undefined && value.role === "local" &&
        value.env !== null && typeof value.env !== "undefined" &&
        value.shareDB !== null && typeof value.shareDB !== "undefined" &&
        value.blockDB !== null && typeof value.blockDB !== "undefined" &&
        value.altblockDB !== null && typeof value.altblockDB !== "undefined" &&
        value.cacheDB !== null && typeof value.cacheDB !== "undefined";
}

/**
 * Validate the local resources once, immediately after initEnv.  Callers after
 * startup use getLocalDatabase, which only selects the role and does not repeat
 * this resource check on every cache or LMDB operation.
 * @param {DatabaseCandidate | undefined} value
 * @returns {LocalDatabaseRuntime}
 */
function getInitializedLocalDatabase(value) {
    if (!isInitializedLocalDatabase(value)) {
        if (!value || value.role !== "local") throw new Error("Local database runtime is required");
        throw new Error("Local database is not initialized");
    }
    return value;
}

module.exports = {
    getInitializedLocalDatabase,
    getLocalDatabase,
    getRemoteDatabase
};
