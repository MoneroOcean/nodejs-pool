"use strict";
// LMDB's MDB_MAP_FULL errno: the database hit its configured mapsize limit.
const LMDB_MAP_FULL_CODE = -30792;

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatLmdbError(error) {
    if (!error) return "unknown LMDB error";
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message.trim()) {
        return error.message.trim();
    }
    if (typeof error === "string" && error.trim()) return error.trim();
    return String(error);
}

/**
 * @param {unknown} error
 * @param {string} pattern
 * @returns {boolean}
 */
function hasLmdbMessage(error, pattern) { return formatLmdbError(error).toLowerCase().includes(pattern); }

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isLmdbMapFull(error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return Number(code) === LMDB_MAP_FULL_CODE ||
        hasLmdbMessage(error, "mdb_map_full") ||
        hasLmdbMessage(error, "mapsize limit reached");
}

module.exports = {
    formatLmdbError,
    isLmdbMapFull,
    LMDB_MAP_FULL_CODE
};
