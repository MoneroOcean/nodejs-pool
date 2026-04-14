"use strict";

function getCacheUpdateMarkerCount(txn, cacheDB, markerKey) {
    const value = txn.getString(cacheDB, markerKey);
    if (value === null) return 0;

    const count = Math.floor(Number(value));
    return Number.isFinite(count) && count > 0 ? count : 1;
}

function acquireCacheUpdateMarker(txn, cacheDB, markerKey) {
    const nextCount = getCacheUpdateMarkerCount(txn, cacheDB, markerKey) + 1;
    txn.putString(cacheDB, markerKey, String(nextCount));
    return nextCount;
}

function releaseCacheUpdateMarker(txn, cacheDB, markerKey) {
    const count = getCacheUpdateMarkerCount(txn, cacheDB, markerKey);
    if (count <= 0) return 0;

    if (count === 1) {
        txn.del(cacheDB, markerKey);
        return 0;
    }

    const nextCount = count - 1;
    txn.putString(cacheDB, markerKey, String(nextCount));
    return nextCount;
}

module.exports = {
    acquireCacheUpdateMarker,
    getCacheUpdateMarkerCount,
    releaseCacheUpdateMarker
};
