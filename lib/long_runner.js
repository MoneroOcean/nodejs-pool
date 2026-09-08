"use strict";
const { createConsoleLogger } = require("./common/logging.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const LMDB_BATCH_SIZE = 500;
const SQL_DELETE_BATCH_SIZE = 250;
const SCAN_CHUNK_SIZE = 2000;
const CACHE_PROGRESS_EVERY = 100000;
const ALTBLOCK_PROGRESS_EVERY = 50000;
const logger = createConsoleLogger(console, "");
/** @typedef {string | number | Buffer} DbKey */
/** @typedef {import("../types/runtime").LmdbCursor} LmdbCursor */
/** @typedef {import("../types/runtime").LmdbDbi} LmdbDbi */
/** @typedef {() => void | Promise<void>} CleanupTask */

/** @param {number} durationMs */
function formatDurationMs(durationMs) {
    if (durationMs < 1000) return `${durationMs  }ms`;
    return `${(durationMs / 1000).toFixed(3)  }s`;
}

/** @param {unknown} error */
function formatError(error) { return error instanceof Error ? error.message : String(error); }

/** @param {string} taskName @param {string} detail */
function logTaskProgress(taskName, detail) { logger.logInfo(taskName, { detail }); }

/** @param {string} data @param {string} key @returns {unknown} */
function parseJson(data, key) {
    try {
        return JSON.parse(data);
    } catch (_error) {
        logger.logError("Cache DB cleanup", { status: "bad-cache-data", key });
        return null;
    }
}

// Walk the database in bounded chunks instead of holding one read transaction open for the
// whole scan. A long-lived read transaction pins the snapshot it opened on, which stops every
// process sharing the environment from reusing pages freed after that point and grows the map
// toward MDB_MAP_FULL. Releasing the transaction between chunks lets page reclamation proceed,
// and the visit callback (which itself opens read transactions via getCache and writes via
// flush) now runs while no scan transaction is held. Each chunk re-seeks past the last key it
// processed, so deletes the visit performs do not cause entries to be revisited or skipped.
/**
 * @template T
 * @param {LmdbDbi} db
 * @param {(cursor: LmdbCursor, append: (key: DbKey, data: T) => void) => void} read
 * @param {boolean} reverse
 * @param {(key: DbKey, data: T) => void} visit
 */
function scanDb(db, read, reverse, visit) {
    const first = reverse ? "goToLast" : "goToFirst";
    const next = reverse ? "goToPrev" : "goToNext";
    const configuredChunkSize = global.__longRunnerScanChunkSize;
    const chunkSize = typeof configuredChunkSize === "number" && Number.isSafeInteger(configuredChunkSize) && configuredChunkSize > 0
        ? configuredChunkSize : SCAN_CHUNK_SIZE;
    /** @type {DbKey | null} */
    let resumeKey = null;
    let done = false;

    while (!done) {
        /** @type {[DbKey, T][]} */
        const chunk = [];
        const txn = global.database.env.beginTxn({ readOnly: true });
        /** @type {LmdbCursor | null} */
        let cursor = null;
        try {
            cursor = new global.database.lmdb.Cursor(txn, db);
            let found;
            if (resumeKey === null) {
                found = cursor[first]();
            } else if (reverse) {
                // Resume at the largest key strictly below the last one processed.
                const atOrAbove = cursor.goToRange(resumeKey);
                found = atOrAbove !== null ? cursor.goToPrev() : cursor.goToLast();
            } else {
                // Resume at the smallest key strictly above the last one processed.
                found = cursor.goToRange(resumeKey);
                if (found === resumeKey) found = cursor[next]();
            }
            let count = 0;
            while (found !== null && count < chunkSize) {
                read(cursor, (key, data) => chunk.push([key, data]));
                resumeKey = found;
                found = cursor[next]();
                ++count;
            }
            if (count < chunkSize) done = true;
        } finally {
            try {
                if (cursor) cursor.close();
            } finally {
                txn.abort();
            }
        }
        for (const [key, data] of chunk) visit(key, data);
    }
}

/** @param {unknown} error */
function isLmdbNotFound(error) {
    return (error !== null && typeof error === "object" && "code" in error && error.code === "MDB_NOTFOUND") || formatError(error).includes("MDB_NOTFOUND");
}

/** @param {LmdbDbi} db @param {DbKey[]} keys */
function flushDeletes(db, keys) {
    if (!keys.length) return 0;
    const txn = global.database.env.beginTxn();
    let count = 0;
    try {
        keys.forEach(function (key) {
            try {
                txn.del(db, key);
                ++count;
            } catch (error) {
                if (!isLmdbNotFound(error)) throw error;
            }
        });
        txn.commit();
        keys.length = 0;
        return count;
    } catch (error) {
        txn.abort();
        throw error;
    }
}

/** @param {LmdbDbi} db @param {[string, string][]} entries */
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

/** @param {unknown} stats */
function getLastHashMs(stats) {
    if (!stats || typeof stats !== "object" || !("lastHash" in stats)) return 0;
    const lastHash = Number(stats.lastHash);
    return Number.isFinite(lastHash) && lastHash > 0 ? lastHash : 0;
}

function cleanCacheDB() {
    const startedAt = Date.now();
    const cacheDb = global.database.cacheDB;
    const now = Date.now();
    const minKeyLength = global.config.pool.address.length;
    /** @type {DbKey[]} */
    const deletes = [];
    const scheduledDeletes = new Set();
    const deletedWorkerFamilies = new Set();
    const deletedAccountHistories = new Set();
    /** @type {[string, string][]} */
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
        scheduledDeletes.clear();
        deletedWorkerFamilies.clear();
        deletedAccountHistories.clear();
    }

    /** @param {string} key */
    function queueDelete(key) {
        if (scheduledDeletes.has(key)) return;
        scheduledDeletes.add(key);
        deletes.push(key);
        if (deletes.length + updates.length >= LMDB_BATCH_SIZE) flush();
    }

    /** @param {string} key @param {string} value */
    function queueUpdate(key, value) {
        updates.push([key, value]);
        if (deletes.length + updates.length >= LMDB_BATCH_SIZE) flush();
    }

    /** @param {string} baseKey */
    function queueWorkerFamilyDelete(baseKey) {
        if (!baseKey || deletedWorkerFamilies.has(baseKey)) return;
        deletedWorkerFamilies.add(baseKey);
        ++workerDeleteCount;
        queueDelete(baseKey);
        queueDelete(`history:${  baseKey}`);
        queueDelete(`stats:${  baseKey}`);
    }

    /** @param {string} baseKey */
    function queueAccountHistoryDelete(baseKey) {
        if (!baseKey || deletedAccountHistories.has(baseKey)) return;
        deletedAccountHistories.add(baseKey);
        ++accountHistoryDeleteCount;
        queueDelete(`history:${  baseKey}`);
    }

    /** @param {string} baseKey @param {unknown[]} identifiers */
    function liveIdentifiers(baseKey, identifiers) {
        const live = [];
        for (let i = 0; i < identifiers.length; ++i) {
            const identifier = identifiers[i];
            if (typeof identifier !== "string" || identifier.length === 0) continue;
            const stats = global.database.getCache(`stats:${  baseKey  }_${  identifier}`);
            if (stats && now - getLastHashMs(stats) <= DAY_MS) live.push(identifier);
        }
        return live;
    }

    /** @param {string} key @param {string} data */
    function processIdentifierKey(key, data) {
        const baseKey = key.slice("identifiers:".length);
        const identifiers = parseJson(data, key);
        if (!Array.isArray(identifiers)) return;
        const live = liveIdentifiers(baseKey, identifiers).sort();
        if (live.length === identifiers.length && live.every(function (identifier, index) { return identifier === identifiers[index]; })) return;
        ++identifierDeleteCount;
        if (live.length === 0) {
            queueDelete(key);
            return;
        }
        queueUpdate(key, JSON.stringify(live));
    }

    /** @param {string} key */
    function processHistoryKey(key) {
        const baseKey = key.slice("history:".length);
        if (!baseKey || baseKey.length < minKeyLength) return;
        const stats = global.database.getCache(`stats:${  baseKey}`);
        const lastHashMs = getLastHashMs(stats);
        if (baseKey.indexOf("_") === -1) {
            if (!stats || now - lastHashMs > MONTH_MS) queueAccountHistoryDelete(baseKey);
            return;
        }
        if (!global.database.getCache(baseKey) || !stats || now - lastHashMs > WEEK_MS) queueWorkerFamilyDelete(baseKey);
    }

    /** @param {string} key @param {string} data */
    function processStatsKey(key, data) {
        const baseKey = key.slice("stats:".length);
        if (baseKey.indexOf("_") === -1) {
            const statsData = parseJson(data, key);
            if (!statsData || typeof statsData !== "object" || Array.isArray(statsData)) return;
            if ((("hash" in statsData && statsData.hash) || ("hash2" in statsData && statsData.hash2)) && now - getLastHashMs(statsData) > DAY_MS) {
                Object.assign(statsData, {hash: 0, hash2: 0});
                ++accountResetCount;
                queueUpdate(key, JSON.stringify(statsData));
            }
            return;
        }
        if (!baseKey || baseKey.length < minKeyLength) return;
        const stats = global.database.getCache(key);
        const lastHashMs = getLastHashMs(stats);
        if (!global.database.getCache(baseKey) || !global.database.getCache(`history:${  baseKey}`) || !stats || now - lastHashMs > WEEK_MS) queueWorkerFamilyDelete(baseKey);
    }

    /** @param {string} key */
    function processWorkerKey(key) {
        const stats = global.database.getCache(`stats:${  key}`);
        if (!stats || !global.database.getCache(`history:${  key}`) || now - getLastHashMs(stats) > WEEK_MS) queueWorkerFamilyDelete(key);
    }

    scanDb(cacheDb, (cursor, append) => cursor.getCurrentString(append), false, /** @param {DbKey} key @param {string} data */ function (key, data) {
        if (typeof key !== "string") return;
        ++scannedCount;
        if (scannedCount % CACHE_PROGRESS_EVERY === 0) {
            logTaskProgress(
                "Cache DB cleanup",
                `scanned ${  scannedCount  } cache entries (${  deletedCount  } deletes, ${  updatedCount  } updates committed so far)`
            );
        }
        if (!key || key.length < minKeyLength) return;
        if (key.indexOf("identifiers:") === 0) {
            processIdentifierKey(key, data);
            return;
        }

        if (key.indexOf("history:") === 0) {
            processHistoryKey(key);
            return;
        }

        if (key.indexOf("stats:") === 0) {
            processStatsKey(key, data);
            return;
        }

        if (key.indexOf("_") === -1) return;
        processWorkerKey(key);
    });

    flush();
    logTaskProgress(
        "Cache DB cleanup",
        `finished in ${  formatDurationMs(Date.now() - startedAt) 
        } (scanned=${  scannedCount 
        }, deleted=${  deletedCount 
        }, updated=${  updatedCount 
        }, staleWorkers=${  workerDeleteCount 
        }, staleAccountHistories=${  accountHistoryDeleteCount 
        }, identifierDeletes=${  identifierDeleteCount 
        }, accountResets=${  accountResetCount  })`
    );
}

function cleanAltBlockDB() {
    const startedAt = Date.now();
    const altblockDb = global.database.altblockDB;
    const now = Date.now();
    /** @type {Record<number, number>} */
    const perPortCount = Object.create(null);
    /** @type {DbKey[]} */
    const deletes = [];
    let scannedCount = 0;
    let deletedCount = 0;
    let lockedCount = 0;
    let expiredCount = 0;
    let overflowCount = 0;

    // Scan newest-first (reverse) so the per-port cap below keeps the 10000 most recent blocks and prunes the oldest.
    scanDb(altblockDb, (cursor, append) => cursor.getCurrentBinary((key, data) => append(key, Buffer.isBuffer(data) ? Buffer.from(data) : data)), true, /** @param {DbKey} key @param {Buffer} data */ function (key, data) {
        ++scannedCount;
        if (scannedCount % ALTBLOCK_PROGRESS_EVERY === 0) {
            logTaskProgress(
                "Alt block DB cleanup",
                `scanned ${  scannedCount  } altblocks (${  deletedCount  } deletes committed so far)`
            );
        }
        const block = global.protos.AltBlock.decode(data);
        const port = block.port;
        const portCount = (perPortCount[port] || 0) + 1;
        perPortCount[port] = portCount;
        if (!block.unlocked) {
            ++lockedCount;
            return;
        }
        if (portCount <= 10000 && now - block.timestamp <= YEAR_MS) return;

        if (now - block.timestamp > YEAR_MS) ++expiredCount;
        else ++overflowCount;
        deletes.push(key);
        if (deletes.length >= LMDB_BATCH_SIZE) deletedCount += flushDeletes(altblockDb, deletes);
    });

    deletedCount += flushDeletes(altblockDb, deletes);
    logTaskProgress(
        "Alt block DB cleanup",
        `finished in ${  formatDurationMs(Date.now() - startedAt) 
        } (scanned=${  scannedCount 
        }, deleted=${  deletedCount 
        }, locked=${  lockedCount 
        }, expired=${  expiredCount 
        }, overflow=${  overflowCount 
        }, ports=${  Object.keys(perPortCount).length  })`
    );
}

function collectLockedBlockHashes() {
    /** @type {Set<string>} */
    const keepHexes = new Set();
    [global.database.getValidLockedBlocks(), global.database.getValidLockedAltBlocks()].forEach(function (blocks) {
        blocks.forEach(function (block) {
            keepHexes.add(Buffer.isBuffer(block.hash) ? block.hash.toString("hex") : block.hash);
        });
    });
    return keepHexes;
}

/** @param {string[]} hexes */
async function deleteBlockBalanceBatch(hexes) {
    if (!hexes.length) return 0;
    try {
        const result = await global.mysql.query("DELETE FROM block_balance WHERE hex IN (?)", [hexes]);
        return result && typeof result.affectedRows === "number" ? result.affectedRows : 0;
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
        return 0;
    }
}

async function cleanBlockBalanceTable() {
    const startedAt = Date.now();
    try {
        logTaskProgress("Block balance cleanup", "collecting locked block hashes");
        const keepHexes = collectLockedBlockHashes();
        const lockedHexCount = keepHexes.size;
        logTaskProgress("Block balance cleanup", `locked block hashes=${  lockedHexCount}`);

        logTaskProgress("Block balance cleanup", "querying recent paid blocks");
        const recentRows = await global.mysql.query("SELECT hex FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 2 DAY)");
        logTaskProgress("Block balance cleanup", `recent paid blocks=${  recentRows.length}`);
        recentRows.forEach(function (row) {
            if (typeof row["hex"] === "string") keepHexes.add(row["hex"]);
        });

        logTaskProgress("Block balance cleanup", "querying distinct block_balance hashes");
        const rows = await global.mysql.query("SELECT DISTINCT hex FROM block_balance");
        logTaskProgress("Block balance cleanup", `distinct block_balance hashes=${  rows.length}`);

        const batch = [];
        let deletedHexCount = 0;
        let deletedRowCount = 0;
        let batchCount = 0;
        logTaskProgress("Block balance cleanup", `deleting stale hashes in batches of ${  SQL_DELETE_BATCH_SIZE}`);
        for (const row of rows) {
            const hex = row["hex"];
            if (typeof hex !== "string" || keepHexes.has(hex)) continue;
            batch.push(hex);
            ++deletedHexCount;
            if (batch.length < SQL_DELETE_BATCH_SIZE) continue;
            deletedRowCount += await deleteBlockBalanceBatch(batch);
            ++batchCount;
            logTaskProgress(
                "Block balance cleanup",
                `processed delete batch ${  batchCount 
                } (${  deletedHexCount  } stale hashes queued, ${  deletedRowCount  } rows deleted)`
            );
            batch.length = 0;
        }

        if (batch.length > 0) {
            deletedRowCount += await deleteBlockBalanceBatch(batch);
            ++batchCount;
            logTaskProgress(
                "Block balance cleanup",
                `processed delete batch ${  batchCount 
                } (${  deletedHexCount  } stale hashes queued, ${  deletedRowCount  } rows deleted)`
            );
        }
        logTaskProgress(
            "Block balance cleanup",
            `finished in ${  formatDurationMs(Date.now() - startedAt) 
            } (locked=${  lockedHexCount 
            }, recent=${  recentRows.length 
            }, staleHashes=${  deletedHexCount 
            }, deletedRows=${  deletedRowCount 
            }, batches=${  batchCount  })`
        );
    } catch (error) {
        logger.logError("SQL", { status: "query-failed", detail: formatError(error) });
    }
}

/** @returns {Promise<void>} */
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

/** @param {string} name @param {CleanupTask} task */
async function runTask(name, task) {
    const startedAt = Date.now();
    logger.logInfo(name, { status: "start" });
    try {
        await task();
        logger.logInfo(name, { status: "done", elapsed: formatDurationMs(Date.now() - startedAt) });
    } catch (error) {
        logger.logError(name, {
            status: "failed",
            elapsed: formatDurationMs(Date.now() - startedAt),
            detail: formatError(error)
        });
    }
}

/** @param {string} name @param {number} intervalMs @param {CleanupTask} task */
function scheduleTask(name, intervalMs, task) {
    let running = false;
    setInterval(function () {
        if (running) {
            logger.logError(name, { status: "still-running", detail: "skipping cycle" });
            return;
        }
        running = true;
        runTask(name, task).then(function () {
            running = false;
        });
    }, intervalMs);
}

/** @type {[string, number, CleanupTask][]} */
const TASKS = [
    ["Share DB cleanup", 4 * 60 * 60 * 1000, cleanShareDB],
    ["Cache DB cleanup", DAY_MS, cleanCacheDB],
    ["Alt block DB cleanup", 7 * DAY_MS, cleanAltBlockDB],
    ["Block balance cleanup", DAY_MS, cleanBlockBalanceTable]
];

async function startLongRunner() {
    for (const [name, , task] of TASKS) await runTask(name, task);
    logger.logInfo("Scheduler", { status: "installed", recurring_tasks: TASKS.length });
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
