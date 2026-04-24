"use strict";

const LMDB_MAP_FULL_CODE = -30792;

function formatLmdbError(error) {
    if (!error) return "unknown LMDB error";
    if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
    if (typeof error === "string" && error.trim()) return error.trim();
    return String(error);
}

function hasLmdbMessage(error, pattern) {
    return formatLmdbError(error).toLowerCase().includes(pattern);
}

function isLmdbMapFull(error) {
    return Number(error && error.code) === LMDB_MAP_FULL_CODE ||
        hasLmdbMessage(error, "mdb_map_full") ||
        hasLmdbMessage(error, "mapsize limit reached");
}

module.exports = {
    formatLmdbError,
    isLmdbMapFull,
    LMDB_MAP_FULL_CODE
};
