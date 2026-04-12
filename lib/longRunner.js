"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const LMDB_BATCH_SIZE = 500;
const SQL_DELETE_BATCH_SIZE = 250;

function parseJson(data, key) {
    try {
        return JSON.parse(data);
    } catch (_error) {
        console.error("Bad cache data with " + key + " key");
        return null;
    }
}

function scanDb(db, reader, reverse, visit) {
    const txn = global.database.env.beginTxn({ readOnly: true });
    const cursor = new global.database.lmdb.Cursor(txn, db);
    const first = reverse ? "goToLast" : "goToFirst";
    const next = reverse ? "goToPrev" : "goToNext";
    try {
        for (let found = cursor[first](); found; found = cursor[next]()) {
            cursor[reader](function (key, data) {
                visit(key, data);
            });
        }
    } finally {
        cursor.close();
        txn.abort();
    }
}

function flushDeletes(db, keys) {
    if (!keys.length) return 0;
    const txn = global.database.env.beginTxn();
    const count = keys.length;
    try {
        keys.forEach(function (key) {
            txn.del(db, key);
        });
        txn.commit();
        keys.length = 0;
        return count;
    } catch (error) {
        txn.abort();
        throw error;
    }
}

function flushStringPuts(db, entries) {
    if (!entries.length) return 0;
    const txn = global.database.env.beginTxn();
    const count = entries.length;
    try {
        entries.forEach(function (entry) {
            txn.putString(db, entry[0], entry[1]);
        });
        txn.commit();
        entries.length = 0;
        return count;
    } catch (error) {
        txn.abort();
        throw error;
    }
}

function cleanCacheDB() {
    console.log("Cleaning up the cache DB. Searching for items to delete/update");
    const cacheDb = global.database.cacheDB;
    const now = Date.now();
    const minKeyLength = global.config.pool.address.length;
    const deletes = [];
    const updates = [];
    let deletedCount = 0;
    let updatedCount = 0;

    function flush() {
        deletedCount += flushDeletes(cacheDb, deletes);
        updatedCount += flushStringPuts(cacheDb, updates);
    }

    function queueDelete(key) {
        deletes.push(key);
        if (deletes.length + updates.length >= LMDB_BATCH_SIZE) flush();
    }

    function queueUpdate(key, value) {
        updates.push([key, value]);
        if (deletes.length + updates.length >= LMDB_BATCH_SIZE) flush();
    }

    scanDb(cacheDb, "getCurrentString", false, function (key, data) {
        if (!key || key.length < minKeyLength) return;
        if (key.indexOf("identifiers:") === 0) {
            const baseKey = key.slice("identifiers:".length);
            const identifiers = parseJson(data, key);
            if (!Array.isArray(identifiers) || identifiers.length === 0) return;

            let isAlive = false;
            for (let i = 0; i < identifiers.length; ++i) {
                const stats = global.database.getCache("stats:" + baseKey + "_" + identifiers[i]);
                if (stats && now - stats.lastHash <= DAY_MS) {
                    isAlive = true;
                    break;
                }
            }
            if (!isAlive) queueUpdate(key, "[]");
            return;
        }

        if (key.indexOf("stats:") === 0 && key.indexOf("_") === -1) {
            const statsData = parseJson(data, key);
            if (!statsData) return;
            if ((statsData.hash || statsData.hash2) && now - statsData.lastHash > DAY_MS) {
                statsData.hash = 0;
                statsData.hash2 = 0;
                queueUpdate(key, JSON.stringify(statsData));
            }
            return;
        }

        if (key.indexOf("_") === -1 || key.indexOf("history:") === 0 || key.indexOf("stats:") === 0) return;

        const statsKey = "stats:" + key;
        const historyKey = "history:" + key;
        const stats = global.database.getCache(statsKey);
        const history = global.database.getCache(historyKey);
        if (!stats || !history || now - stats.lastHash > WEEK_MS) {
            queueDelete(key);
            if (history) queueDelete(historyKey);
            if (stats) queueDelete(statsKey);
        }
    });

    flush();
    console.log("Deleted cache items: " + deletedCount);
    console.log("Updated cache items: " + updatedCount);
}

function cleanAltBlockDB() {
    console.log("Cleaning up the alt block DB. Searching for items to delete");
    const altblockDb = global.database.altblockDB;
    const now = Date.now();
    const perPortCount = Object.create(null);
    const deletes = [];
    let deletedCount = 0;

    scanDb(altblockDb, "getCurrentBinary", true, function (key, data) {
        const block = global.protos.AltBlock.decode(data);
        const port = block.port;
        perPortCount[port] = (perPortCount[port] || 0) + 1;
        if (!block.unlocked) return;
        if (perPortCount[port] <= 10000 && now - block.timestamp <= YEAR_MS) return;

        deletes.push(key);
        if (deletes.length >= LMDB_BATCH_SIZE) deletedCount += flushDeletes(altblockDb, deletes);
    });

    deletedCount += flushDeletes(altblockDb, deletes);
    console.log("Deleted altblock items: " + deletedCount);
}

function collectLockedBlockHashes() {
    const keepHexes = new Set();
    [global.database.getValidLockedBlocks(), global.database.getValidLockedAltBlocks()].forEach(function (blocks) {
        blocks.forEach(function (block) {
            keepHexes.add(block.hash);
        });
    });
    return keepHexes;
}

async function deleteBlockBalanceBatch(hexes) {
    if (!hexes.length) return 0;
    try {
        const result = await global.mysql.query("DELETE FROM block_balance WHERE hex IN (?)", [hexes]);
        return result && typeof result.affectedRows === "number" ? result.affectedRows : 0;
    } catch (error) {
        console.error("SQL query failed: " + error);
        return 0;
    }
}

async function cleanBlockBalanceTable() {
    console.log("Cleaning up the block balance table");
    try {
        const keepHexes = collectLockedBlockHashes();
        console.log("Starting cleaning the block balance table. Found " + keepHexes.size + " locked blocks");

        const recentRows = await global.mysql.query("SELECT hex FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 2 DAY)");
        console.log("Got " + recentRows.length + " recent blocks");
        recentRows.forEach(function (row) {
            keepHexes.add(row.hex);
        });

        const rows = await global.mysql.query("SELECT DISTINCT hex FROM block_balance");
        console.log("Got " + rows.length + " block balance blocks");

        const batch = [];
        let deletedHexCount = 0;
        let deletedRowCount = 0;
        for (let i = 0; i < rows.length; ++i) {
            if (keepHexes.has(rows[i].hex)) continue;
            batch.push(rows[i].hex);
            ++deletedHexCount;
            if (batch.length < SQL_DELETE_BATCH_SIZE) continue;
            deletedRowCount += await deleteBlockBalanceBatch(batch);
            batch.length = 0;
        }

        deletedRowCount += await deleteBlockBalanceBatch(batch);
        console.log(
            "Finished preparing the block balance table. Removing " +
            deletedHexCount +
            " block balance hashes (" +
            keepHexes.size +
            " locked, " +
            deletedRowCount +
            " rows deleted)."
        );
    } catch (error) {
        console.error("SQL query failed: " + error);
    }
}

function cleanShareDB() {
    console.log("Cleaning up the share DB");
    global.database.cleanShareDB();
}

async function runTask(name, task) {
    try {
        await task();
    } catch (error) {
        console.error("LongRunner " + name + " failed: " + (error && error.stack ? error.stack : error));
    }
}

function scheduleTask(name, intervalMs, task) {
    let running = false;
    setInterval(function () {
        if (running) {
            console.error("LongRunner " + name + " is still running. Skipping this cycle.");
            return;
        }
        running = true;
        runTask(name, task).then(function () {
            running = false;
        });
    }, intervalMs);
}

const TASKS = [
    ["share DB cleanup", 4 * 60 * 60 * 1000, cleanShareDB],
    ["cache DB cleanup", DAY_MS, cleanCacheDB],
    ["alt block DB cleanup", 7 * DAY_MS, cleanAltBlockDB],
    ["block balance cleanup", DAY_MS, cleanBlockBalanceTable]
];

async function startLongRunner() {
    for (let i = 0; i < TASKS.length; ++i) {
        await runTask(TASKS[i][0], TASKS[i][2]);
    }
    TASKS.forEach(function (entry) {
        scheduleTask(entry[0], entry[1], entry[2]);
    });
}

module.exports = {
    DAY_MS,
    WEEK_MS,
    YEAR_MS,
    LMDB_BATCH_SIZE,
    SQL_DELETE_BATCH_SIZE,
    cleanCacheDB,
    cleanAltBlockDB,
    cleanBlockBalanceTable,
    cleanShareDB,
    collectLockedBlockHashes,
    deleteBlockBalanceBatch,
    runTask,
    scheduleTask,
    startLongRunner
};

if (global.__longRunnerAutostart !== false) {
    startLongRunner();
}
