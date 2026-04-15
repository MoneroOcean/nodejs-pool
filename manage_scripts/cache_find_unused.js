"use strict";

process.chdir(__dirname);

const argv = require("../parse_args")(process.argv.slice(2));

const EXACT_ACTIVE_KEYS = new Set([
    "active_ports",
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

function hasRelatedCache(cacheEntries, baseKey) {
    return cacheEntries.has(baseKey) ||
        cacheEntries.has("stats:" + baseKey) ||
        cacheEntries.has("history:" + baseKey) ||
        cacheEntries.has("identifiers:" + baseKey);
}

function isRuntimeActiveKey(key, cacheEntries) {
    if (EXACT_ACTIVE_KEYS.has(key)) return true;
    if (ACTIVE_KEY_PATTERNS.some(function (pattern) { return pattern.test(key); })) return true;

    if (key.indexOf("identifiers:") === 0) {
        const baseKey = key.slice("identifiers:".length);
        return cacheEntries.has(baseKey) ||
            cacheEntries.has("stats:" + baseKey) ||
            cacheEntries.has("history:" + baseKey);
    }

    if (key.indexOf("stats:") === 0) {
        const baseKey = key.slice("stats:".length);
        return cacheEntries.has(baseKey) || cacheEntries.has("identifiers:" + baseKey);
    }

    if (key.indexOf("history:") === 0) {
        const baseKey = key.slice("history:".length);
        return cacheEntries.has(baseKey) ||
            cacheEntries.has("stats:" + baseKey) ||
            cacheEntries.has("identifiers:" + baseKey);
    }

    return hasRelatedCache(cacheEntries, key);
}

function isLongRunnerManagedKey(key, cacheEntries, minKeyLength) {
    if (!key || key.length < minKeyLength) return false;

    if (key.indexOf("identifiers:") === 0) return true;
    if (key.indexOf("stats:") === 0) {
        if (key.indexOf("_") === -1) return true;
        return cacheEntries.has(key.slice("stats:".length));
    }
    if (key.indexOf("history:") === 0) {
        return cacheEntries.has(key.slice("history:".length));
    }

    return key.indexOf("_") >= 0;
}

function classifyReason(key, cacheEntries, minKeyLength) {
    if (key.indexOf("history:") === 0) return cacheEntries.has(key.slice("history:".length)) ? "managed-history" : "orphan-history";
    if (key.indexOf("stats:") === 0) return cacheEntries.has(key.slice("stats:".length)) ? "managed-stats" : "orphan-stats";
    if (key.indexOf("identifiers:") === 0) return "orphan-identifiers";
    if (key.length < minKeyLength) return "short-unknown";
    if (key.indexOf("_") >= 0) return "worker-like";
    return "unknown";
}

require("../init_mini.js").init(function () {
    const cacheEntries = new Map();
    const txn = global.database.env.beginTxn({ readOnly: true });
    const cursor = new global.database.lmdb.Cursor(txn, global.database.cacheDB);

    for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
        cursor.getCurrentString(function (key, data) {  // jshint ignore:line
            cacheEntries.set(String(key), String(data));
        });
    }

    cursor.close();
    txn.abort();

    const minKeyLength = global.config.pool.address.length;
    const rows = [];

    cacheEntries.forEach(function (data, key) {
        if (isRuntimeActiveKey(key, cacheEntries)) return;
        if (isLongRunnerManagedKey(key, cacheEntries, minKeyLength)) return;

        rows.push({
            key: key,
            reason: classifyReason(key, cacheEntries, minKeyLength),
            value: data
        });
    });

    rows.sort(function (left, right) {
        return left.key.localeCompare(right.key);
    });

    if (argv.json) {
        console.log(JSON.stringify(rows, null, 2));
    } else {
        rows.forEach(function (row) {
            if (argv.value) {
                console.log(row.reason + "\t" + row.key + "\t" + row.value);
            } else {
                console.log(row.reason + "\t" + row.key);
            }
        });
        console.error("Found " + rows.length + " cache keys outside runtime usage and longRunner cleanup");
    }

    process.exit(0);
});
