"use strict";
process.chdir(__dirname);

const argv = require("../parse_args")(process.argv.slice(2));

const EXACT_ACTIVE_KEYS = new Set([
    "active_ports",
    "altblock_exchange_trade",
    "base_balance",
    "btc_balance",
    "coin_comment",
    "coin_xmr_profit",
    "global_stats",
    "lastPaymentCycle",
    "minerSet",
    "min_block_rewards",
    "networkBlockInfo",
    "news",
    "poolPorts",
    "poolServers",
    "pool_stats_global",
    "pool_stats_pplns",
    "portMinerCount",
    "port_hash",
    "pplns_port_shares",
    "pplns_stats",
    "pplns_window_time",
    "stats_pplns",
    "usdt_balance",
    "xmr_balance",
    "xmr_profit"
]);

const ACTIVE_KEY_PATTERNS = [
    /^(global|pplns|legacy)_stats2(?:_\d+)?$/
];

const PROGRESS_EVERY = 100000;
const DELETE_BATCH_SIZE = 500;

function hasKey(txn, key) {
    if (!key) return false;

    try {
        return txn.getString(global.database.cacheDB, key) !== null;
    } catch (_error) {
        return false;
    }
}

function hasRelatedCache(txn, baseKey) {
    return hasKey(txn, baseKey) ||
        hasKey(txn, "stats:" + baseKey) ||
        hasKey(txn, "history:" + baseKey) ||
        hasKey(txn, "identifiers:" + baseKey);
}

function isRuntimeActiveKey(txn, key) {
    if (EXACT_ACTIVE_KEYS.has(key)) return true;
    if (ACTIVE_KEY_PATTERNS.some(function (pattern) { return pattern.test(key); })) return true;

    if (key.indexOf("identifiers:") === 0) {
        const baseKey = key.slice("identifiers:".length);
        return hasKey(txn, baseKey) ||
            hasKey(txn, "stats:" + baseKey) ||
            hasKey(txn, "history:" + baseKey);
    }

    if (key.indexOf("stats:") === 0) {
        const baseKey = key.slice("stats:".length);
        return hasKey(txn, baseKey) || hasKey(txn, "identifiers:" + baseKey);
    }

    if (key.indexOf("history:") === 0) {
        const baseKey = key.slice("history:".length);
        return hasKey(txn, baseKey) ||
            hasKey(txn, "stats:" + baseKey) ||
            hasKey(txn, "identifiers:" + baseKey);
    }

    return hasRelatedCache(txn, key);
}

function isLongRunnerManagedKey(txn, key, minKeyLength) {
    if (!key || key.length < minKeyLength) return false;

    if (key.indexOf("identifiers:") === 0) return true;
    if (key.indexOf("stats:") === 0) {
        if (key.indexOf("_") === -1) return true;
        return hasKey(txn, key.slice("stats:".length));
    }
    if (key.indexOf("history:") === 0) {
        return hasKey(txn, key.slice("history:".length));
    }

    return key.indexOf("_") >= 0;
}

function classifyReason(txn, key, minKeyLength) {
    if (key.indexOf("history:") === 0) return hasKey(txn, key.slice("history:".length)) ? "managed-history" : "orphan-history";
    if (key.indexOf("stats:") === 0) return hasKey(txn, key.slice("stats:".length)) ? "managed-stats" : "orphan-stats";
    if (key.indexOf("identifiers:") === 0) return "orphan-identifiers";
    if (key.length < minKeyLength) return "short-unknown";
    if (key.indexOf("_") >= 0) return "worker-like";
    return "unknown";
}

function flushDeletes(keys) {
    if (keys.length === 0) return 0;

    const txn = global.database.env.beginTxn();
    const count = keys.length;
    try {
        keys.forEach(function (key) {
            txn.del(global.database.cacheDB, key);
        });
        txn.commit();
        keys.length = 0;
        return count;
    } catch (error) {
        txn.abort();
        throw error;
    }
}

require("../init_mini.js").init(function () {
    const txn = global.database.env.beginTxn({ readOnly: true });
    const cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);
    const minKeyLength = global.config.pool.address.length;
    const pendingDeletes = [];
    let scannedCount = 0;
    let foundCount = 0;
    let deletedCount = 0;
    let wroteJsonRow = false;

    if (argv.json) {
        process.stdout.write("[\n");
    }

    try {
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentString(function (key, data) {  // jshint ignore:line
                key = String(key);
                ++scannedCount;

                if (scannedCount % PROGRESS_EVERY === 0) {
                    console.error("Scanned " + scannedCount + " cache keys, found " + foundCount + " unused");
                }

                if (isRuntimeActiveKey(txn, key)) return;
                if (isLongRunnerManagedKey(txn, key, minKeyLength)) return;

                const row = {
                    key: key,
                    reason: classifyReason(txn, key, minKeyLength)
                };

                if (argv.value) row.value = String(data);
                ++foundCount;

                if (argv.delete) {
                    pendingDeletes.push(row.key);
                    if (pendingDeletes.length >= DELETE_BATCH_SIZE) {
                        deletedCount += flushDeletes(pendingDeletes);
                    }
                }

                if (argv.json) {
                    if (wroteJsonRow) process.stdout.write(",\n");
                    process.stdout.write(JSON.stringify(row));
                    wroteJsonRow = true;
                    return;
                }

                if (argv.value) {
                    console.log(row.reason + "\t" + row.key + "\t" + row.value);
                } else {
                    console.log(row.reason + "\t" + row.key);
                }
            });
        }
    } finally {
        cursor.close();
        txn.abort();
    }

    if (argv.delete) {
        deletedCount += flushDeletes(pendingDeletes);
    }

    if (argv.json) {
        if (wroteJsonRow) process.stdout.write("\n");
        process.stdout.write("]\n");
    } else {
        console.error("Found " + foundCount + " cache keys outside runtime usage and long_runner cleanup");
    }

    if (argv.delete) {
        console.error("Deleted " + deletedCount + " cache keys");
    }
    console.error("Scanned " + scannedCount + " cache keys total");
    process.exit(0);
});
