"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const LMDB_BATCH_SIZE = 500;
const SQL_DELETE_BATCH_SIZE = 250;
const CACHE_PROGRESS_EVERY = 100000;
const ALTBLOCK_PROGRESS_EVERY = 50000;

function formatDurationMs(durationMs) {
    if (durationMs < 1000) return durationMs + "ms";
    return (durationMs / 1000).toFixed(3) + "s";
}

function logTaskProgress(taskName, message) {
    console.log(taskName + ": " + message);
}

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

function getLastHashMs(stats) {
    if (!stats || typeof stats !== "object") return 0;
    const lastHash = Number(stats.lastHash);
    return Number.isFinite(lastHash) && lastHash > 0 ? lastHash : 0;
}

function cleanCacheDB() {
    const startedAt = Date.now();
    const cacheDb = global.database.cacheDB;
    const now = Date.now();
    const minKeyLength = global.config.pool.address.length;
    const deletes = [];
    const scheduledDeletes = new Set();
    const deletedWorkerFamilies = new Set();
    const deletedAccountHistories = new Set();
    const updates = [];
    let scannedCount = 0;
    let deletedCount = 0;
    let updatedCount = 0;
    let workerDeleteCount = 0;
    let accountHistoryDeleteCount = 0;
    let identifierDeleteCount = 0;
    let accountResetCount = 0;

    function flush() {
        deletedCount += flushDeletes(cacheDb, deletes);
        updatedCount += flushStringPuts(cacheDb, updates);
    }

    function queueDelete(key) {
        if (scheduledDeletes.has(key)) return;
        scheduledDeletes.add(key);
        deletes.push(key);
        if (deletes.length + updates.length >= LMDB_BATCH_SIZE) flush();
    }

    function queueUpdate(key, value) {
        updates.push([key, value]);
        if (deletes.length + updates.length >= LMDB_BATCH_SIZE) flush();
    }

    function queueWorkerFamilyDelete(baseKey) {
        if (!baseKey || deletedWorkerFamilies.has(baseKey)) return;
        deletedWorkerFamilies.add(baseKey);
        ++workerDeleteCount;
        queueDelete(baseKey);
        queueDelete("history:" + baseKey);
        queueDelete("stats:" + baseKey);
    }

    function queueAccountHistoryDelete(baseKey) {
        if (!baseKey || deletedAccountHistories.has(baseKey)) return;
        deletedAccountHistories.add(baseKey);
        ++accountHistoryDeleteCount;
        queueDelete("history:" + baseKey);
    }

    scanDb(cacheDb, "getCurrentString", false, function (key, data) {
        ++scannedCount;
        if (scannedCount % CACHE_PROGRESS_EVERY === 0) {
            logTaskProgress(
                "Cache DB cleanup",
                "scanned " + scannedCount + " cache entries (" + deletedCount + " deletes, " + updatedCount + " updates committed so far)"
            );
        }
        if (!key || key.length < minKeyLength) return;
        if (key.indexOf("identifiers:") === 0) {
            const baseKey = key.slice("identifiers:".length);
            const identifiers = parseJson(data, key);
            if (!Array.isArray(identifiers)) return;
            if (identifiers.length === 0) {
                ++identifierDeleteCount;
                queueDelete(key);
                return;
            }

            let isAlive = false;
            for (let i = 0; i < identifiers.length; ++i) {
                const stats = global.database.getCache("stats:" + baseKey + "_" + identifiers[i]);
                if (stats && now - stats.lastHash <= DAY_MS) {
                    isAlive = true;
                    break;
                }
            }
            if (!isAlive) {
                ++identifierDeleteCount;
                queueDelete(key);
            }
            return;
        }

        if (key.indexOf("history:") === 0) {
            const baseKey = key.slice("history:".length);
            if (!baseKey || baseKey.length < minKeyLength) return;

            const stats = global.database.getCache("stats:" + baseKey);
            const lastHashMs = getLastHashMs(stats);

            if (baseKey.indexOf("_") === -1) {
                if (!stats || now - lastHashMs > MONTH_MS) queueAccountHistoryDelete(baseKey);
                return;
            }

            if (!global.database.getCache(baseKey) || !stats || now - lastHashMs > WEEK_MS) {
                queueWorkerFamilyDelete(baseKey);
            }
            return;
        }

        if (key.indexOf("stats:") === 0) {
            const baseKey = key.slice("stats:".length);
            if (baseKey.indexOf("_") === -1) {
                const statsData = parseJson(data, key);
                if (!statsData) return;
                if ((statsData.hash || statsData.hash2) && now - statsData.lastHash > DAY_MS) {
                    statsData.hash = 0;
                    statsData.hash2 = 0;
                    ++accountResetCount;
                    queueUpdate(key, JSON.stringify(statsData));
                }
                return;
            }

            if (!baseKey || baseKey.length < minKeyLength) return;
            const stats = global.database.getCache(key);
            const lastHashMs = getLastHashMs(stats);
            if (!global.database.getCache(baseKey) || !global.database.getCache("history:" + baseKey) || !stats || now - lastHashMs > WEEK_MS) {
                queueWorkerFamilyDelete(baseKey);
            }
            return;
        }

        if (key.indexOf("_") === -1) return;

        const lastHashMs = getLastHashMs(global.database.getCache("stats:" + key));
        if (!global.database.getCache("stats:" + key) || !global.database.getCache("history:" + key) || now - lastHashMs > WEEK_MS) {
            queueWorkerFamilyDelete(key);
        }
    });

    flush();
    logTaskProgress(
        "Cache DB cleanup",
        "finished in " + formatDurationMs(Date.now() - startedAt) +
        " (scanned=" + scannedCount +
        ", deleted=" + deletedCount +
        ", updated=" + updatedCount +
        ", staleWorkers=" + workerDeleteCount +
        ", staleAccountHistories=" + accountHistoryDeleteCount +
        ", identifierDeletes=" + identifierDeleteCount +
        ", accountResets=" + accountResetCount + ")"
    );
}

function cleanAltBlockDB() {
    const startedAt = Date.now();
    const altblockDb = global.database.altblockDB;
    const now = Date.now();
    const perPortCount = Object.create(null);
    const deletes = [];
    let scannedCount = 0;
    let deletedCount = 0;
    let lockedCount = 0;
    let expiredCount = 0;
    let overflowCount = 0;

    scanDb(altblockDb, "getCurrentBinary", true, function (key, data) {
        ++scannedCount;
        if (scannedCount % ALTBLOCK_PROGRESS_EVERY === 0) {
            logTaskProgress(
                "Alt block DB cleanup",
                "scanned " + scannedCount + " altblocks (" + deletedCount + " deletes committed so far)"
            );
        }
        const block = global.protos.AltBlock.decode(data);
        const port = block.port;
        perPortCount[port] = (perPortCount[port] || 0) + 1;
        if (!block.unlocked) {
            ++lockedCount;
            return;
        }
        if (perPortCount[port] <= 10000 && now - block.timestamp <= YEAR_MS) return;

        if (now - block.timestamp > YEAR_MS) ++expiredCount;
        else ++overflowCount;
        deletes.push(key);
        if (deletes.length >= LMDB_BATCH_SIZE) deletedCount += flushDeletes(altblockDb, deletes);
    });

    deletedCount += flushDeletes(altblockDb, deletes);
    logTaskProgress(
        "Alt block DB cleanup",
        "finished in " + formatDurationMs(Date.now() - startedAt) +
        " (scanned=" + scannedCount +
        ", deleted=" + deletedCount +
        ", locked=" + lockedCount +
        ", expired=" + expiredCount +
        ", overflow=" + overflowCount +
        ", ports=" + Object.keys(perPortCount).length + ")"
    );
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
    const startedAt = Date.now();
    try {
        logTaskProgress("Block balance cleanup", "collecting locked block hashes");
        const keepHexes = collectLockedBlockHashes();
        const lockedHexCount = keepHexes.size;
        logTaskProgress("Block balance cleanup", "locked block hashes=" + lockedHexCount);

        logTaskProgress("Block balance cleanup", "querying recent paid blocks");
        const recentRows = await global.mysql.query("SELECT hex FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 2 DAY)");
        logTaskProgress("Block balance cleanup", "recent paid blocks=" + recentRows.length);
        recentRows.forEach(function (row) {
            keepHexes.add(row.hex);
        });

        logTaskProgress("Block balance cleanup", "querying distinct block_balance hashes");
        const rows = await global.mysql.query("SELECT DISTINCT hex FROM block_balance");
        logTaskProgress("Block balance cleanup", "distinct block_balance hashes=" + rows.length);

        const batch = [];
        let deletedHexCount = 0;
        let deletedRowCount = 0;
        let batchCount = 0;
        logTaskProgress("Block balance cleanup", "deleting stale hashes in batches of " + SQL_DELETE_BATCH_SIZE);
        for (let i = 0; i < rows.length; ++i) {
            if (keepHexes.has(rows[i].hex)) continue;
            batch.push(rows[i].hex);
            ++deletedHexCount;
            if (batch.length < SQL_DELETE_BATCH_SIZE) continue;
            deletedRowCount += await deleteBlockBalanceBatch(batch);
            ++batchCount;
            logTaskProgress(
                "Block balance cleanup",
                "processed delete batch " + batchCount +
                " (" + deletedHexCount + " stale hashes queued, " + deletedRowCount + " rows deleted)"
            );
            batch.length = 0;
        }

        if (batch.length > 0) {
            deletedRowCount += await deleteBlockBalanceBatch(batch);
            ++batchCount;
            logTaskProgress(
                "Block balance cleanup",
                "processed delete batch " + batchCount +
                " (" + deletedHexCount + " stale hashes queued, " + deletedRowCount + " rows deleted)"
            );
        }
        logTaskProgress(
            "Block balance cleanup",
            "finished in " + formatDurationMs(Date.now() - startedAt) +
            " (locked=" + lockedHexCount +
            ", recent=" + recentRows.length +
            ", staleHashes=" + deletedHexCount +
            ", deletedRows=" + deletedRowCount +
            ", batches=" + batchCount + ")"
        );
    } catch (error) {
        console.error("SQL query failed: " + error);
    }
}

function cleanShareDB() {
    logTaskProgress("Share DB cleanup", "starting database cleaner");
    return new Promise(function (resolve, reject) {
        global.database.cleanShareDB(function (error) {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function runTask(name, task) {
    const startedAt = Date.now();
    console.log(name + ": start");
    try {
        await task();
        console.log(name + ": done in " + formatDurationMs(Date.now() - startedAt));
    } catch (error) {
        console.error(name + " failed after " + formatDurationMs(Date.now() - startedAt) + ": " + (error && error.stack ? error.stack : error));
    }
}

function scheduleTask(name, intervalMs, task) {
    let running = false;
    setInterval(function () {
        if (running) {
            console.error(name + " is still running. Skipping this cycle.");
            return;
        }
        running = true;
        runTask(name, task).then(function () {
            running = false;
        });
    }, intervalMs);
}

const TASKS = [
    ["Share DB cleanup", 4 * 60 * 60 * 1000, cleanShareDB],
    ["Cache DB cleanup", DAY_MS, cleanCacheDB],
    ["Alt block DB cleanup", 7 * DAY_MS, cleanAltBlockDB],
    ["Block balance cleanup", DAY_MS, cleanBlockBalanceTable]
];

async function startLongRunner() {
    for (let i = 0; i < TASKS.length; ++i) {
        await runTask(TASKS[i][0], TASKS[i][2]);
    }
    console.log("Scheduler: installed " + TASKS.length + " recurring tasks");
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
