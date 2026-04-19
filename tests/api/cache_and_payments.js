"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const jwt = require("jsonwebtoken");

global.__apiAutostart = false;
const createApiRuntime = require("../../lib/api.js").createApiRuntime;
delete global.__apiAutostart;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await wait(10);
    }
    throw new Error("Condition not met within " + timeoutMs + "ms");
}

async function waitForListening(runtime) {
    for (let attempts = 0; attempts < 50; attempts += 1) {
        const address = runtime.address();
        if (address && address.port) return address;
        await wait(10);
    }
    throw new Error("API runtime did not start listening");
}

function request(port, options) {
    const body = options.body || "";
    const headers = Object.assign({}, options.headers);
    if (body && !headers["Content-Length"]) headers["Content-Length"] = Buffer.byteLength(body);

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1",
            port: port,
            method: options.method || "GET",
            path: options.path,
            headers: headers
        }, (res) => {
            const chunks = [];
            res.setEncoding("utf8");
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = chunks.join("");
                let json = null;
                try {
                    json = text ? JSON.parse(text) : null;
                } catch (_error) {}
                resolve({ statusCode: res.statusCode, headers: res.headers, text: text, json: json });
            });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

function requestJson(port, method, path, payload) {
    const body = JSON.stringify(payload);
    return request(port, {
        method: method,
        path: path,
        body: body,
        headers: { "Content-Type": "application/json" }
    });
}

function createConfig() {
    return {
        api: {
            secKey: "secret-key"
        },
        payout: {
            pplnsFee: 0.6,
            walletMin: 0.1,
            exchangeMin: 0.2,
            devDonation: 3,
            poolDevDonation: 3,
            blocksRequired: 30,
            denom: 0.01,
            defaultPay: 0.5
        },
        general: {
            sigDivisor: 100,
            coinCode: "XMR"
        },
        pool: {
            address: "pool-address"
        },
        pplns: {
            enable: true
        }
    };
}

function createSupport() {
    return {
        decimalToCoin(amount) {
            return Math.round(Number(amount) * 100);
        },
        coinToDecimal(amount) {
            return Number(amount) / 100;
        },
        tsCompare(left, right) {
            if (left.ts < right.ts) return 1;
            if (left.ts > right.ts) return -1;
            return 0;
        }
    };
}

function createCnUtil() {
    return {
        address_decode(buffer) {
            const value = buffer.toString();
            if (value === "pool-address" || value === "valid-address") return 12345;
            throw new Error("invalid address");
        }
    };
}

function createDatabase(options) {
    const caches = new Map(Object.entries(options.caches || {}));
    const state = {
        altBlockListCalls: [],
        blockListCalls: [],
        cacheGets: []
    };

    return {
        state: state,
        thread_id: "",
        getCache(key) {
            state.cacheGets.push(key);
            return caches.has(key) ? caches.get(key) : false;
        },
        getBlockList(poolType, start, end) {
            state.blockListCalls.push({ poolType: poolType, start: start, end: end });
            if (typeof options.getBlockList === "function") return options.getBlockList(poolType, start, end);
            return [{ poolType: poolType, start: start, end: end }];
        },
        getAltBlockList(poolType, coinPort, start, end) {
            state.altBlockListCalls.push({ poolType: poolType, coinPort: coinPort, start: start, end: end });
            if (typeof options.getAltBlockList === "function") return options.getAltBlockList(poolType, coinPort, start, end);
            return [{ poolType: poolType, coinPort: coinPort, start: start, end: end }];
        }
    };
}

function createMysql(handler) {
    const calls = [];
    return {
        calls: calls,
        async query(sql, params) {
            calls.push({ sql: sql, params: params });
            return handler(sql, params, calls);
        }
    };
}

async function withRuntime(options, run) {
    const runtime = createApiRuntime(Object.assign({
        clusterEnabled: false,
        host: "127.0.0.1",
        port: 0
    }, options));
    runtime.start();
    try {
        const address = await waitForListening(runtime);
        return await run(address.port, runtime);
    } finally {
        await runtime.stop();
    }
}

async function captureConsole(run) {
    const originalLog = console.log;
    const originalError = console.error;
    const logs = [];
    const errors = [];
    console.log = function captureLog(...args) { logs.push(args.map(String).join(" ")); };
    console.error = function captureError(...args) { errors.push(args.map(String).join(" ")); };
    try {
        await run({ logs: logs, errors: errors });
        return { logs: logs, errors: errors };
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
}

test.describe("api", { concurrency: false }, () => {
    test("cached GETs normalize keys and pool stats responses do not mutate cached objects", async () => {
        const poolStats = {
            minerHistory: [{ ts: 1, miners: 2 }],
            hashHistory: [{ ts: 1, hs: 3 }],
            miners: 4
        };
        const database = createDatabase({
            caches: {
                pool_stats_global: poolStats,
                lastPaymentCycle: 99
            }
        });

        await withRuntime({
            cnUtil: createCnUtil(),
            config: createConfig(),
            database: database,
            mysql: createMysql(async () => []),
            support: createSupport()
        }, async (port) => {
            const stats = await request(port, { path: "/pool/stats" });
            assert.equal(stats.statusCode, 200);
            assert.equal(stats.json.pool_statistics.miners, 4);
            assert.equal("hashHistory" in stats.json.pool_statistics, false);
            assert.equal("minerHistory" in stats.json.pool_statistics, false);
            assert.deepEqual(poolStats.hashHistory, [{ ts: 1, hs: 3 }]);
            assert.deepEqual(poolStats.minerHistory, [{ ts: 1, miners: 2 }]);

            const first = await request(port, { path: "/pool/blocks?limit=25&page=0&noise=one" });
            const second = await request(port, { path: "/pool/blocks?page=0&limit=25&noise=two" });
            assert.equal(first.statusCode, 200);
            assert.equal(second.statusCode, 200);
            assert.deepEqual(first.json, second.json);
            assert.equal(database.state.blockListCalls.length, 1);
        });
    });

    test("response cache honors TTL expiry and entry caps", async () => {
        let nowValue = 0;
        const config = createConfig();
        const database = createDatabase({ caches: {} });

        await withRuntime({
            cnUtil: createCnUtil(),
            config: config,
            database: database,
            mysql: createMysql(async () => []),
            now: () => nowValue,
            responseCacheMaxEntries: 1,
            support: createSupport()
        }, async (port) => {
            const initial = await request(port, { path: "/config" });
            assert.equal(initial.json.coin_code, "XMR");
            config.general.coinCode = "WOW";

            const cached = await request(port, { path: "/config" });
            assert.equal(cached.json.coin_code, "XMR");

            nowValue += 5 * 60 * 1000 + 1;
            const refreshed = await request(port, { path: "/config" });
            assert.equal(refreshed.json.coin_code, "WOW");

            await request(port, { path: "/pool/blocks?page=0" });
            await request(port, { path: "/pool/blocks?page=1" });
            await request(port, { path: "/pool/blocks?page=0" });
            assert.equal(database.state.blockListCalls.length, 3);
        });
    });

    test("request parsers reject malformed and oversized JSON bodies", async () => {
        await withRuntime({
            cnUtil: createCnUtil(),
            config: createConfig(),
            database: createDatabase({ caches: {} }),
            mysql: createMysql(async () => []),
            support: createSupport()
        }, async (port) => {
            const malformed = await request(port, {
                method: "POST",
                path: "/authenticate",
                body: "{\"username\":",
                headers: { "Content-Type": "application/json" }
            });
            assert.equal(malformed.statusCode, 400);
            assert.deepEqual(malformed.json, { error: "Invalid request body" });

            const hugePassword = "a".repeat(40 * 1024);
            const oversized = await request(port, {
                method: "POST",
                path: "/authenticate",
                body: JSON.stringify({ username: "wallet", password: hugePassword }),
                headers: { "Content-Type": "application/json" }
            });
            assert.equal(oversized.statusCode, 413);
            assert.deepEqual(oversized.json, { error: "Request body too large" });
        });
    });

    test("pool and miner payment routes batch transaction lookups instead of issuing N+1 queries", async () => {
        const config = createConfig();
        config.pplns.enable = false;
        const mysql = createMysql(async function handler(sql, params, calls) {
            if (sql.startsWith("SELECT * FROM transactions ORDER BY id DESC")) {
                return [
                    { id: 11, transaction_hash: "hash11", mixin: 12, payees: 1, fees: 2, xmr_amt: 3, submitted_time: "2024-01-02T00:00:00Z" },
                    { id: 10, transaction_hash: "hash10", mixin: 11, payees: 2, fees: 3, xmr_amt: 4, submitted_time: "2024-01-01T00:00:00Z" }
                ];
            }
            if (sql.startsWith("SELECT transaction_id, MIN(pool_type) AS pool_type")) {
                return [
                    { transaction_id: 11, pool_type: "pplns" },
                    { transaction_id: 10, pool_type: "legacy" }
                ];
            }
            if (sql.startsWith("SELECT amount as amt, pool_type, transaction_id")) {
                return [
                    { amt: 100, pool_type: "pplns", transaction_id: 20, ts: 1000 },
                    { amt: 200, pool_type: "legacy", transaction_id: 21, ts: 2000 }
                ];
            }
            if (sql.startsWith("SELECT id, transaction_hash, mixin FROM transactions WHERE id IN")) {
                return [
                    { id: 20, transaction_hash: "tx20", mixin: 4 },
                    { id: 21, transaction_hash: "tx21", mixin: 5 }
                ];
            }
            throw new Error("Unexpected SQL: " + sql + " calls=" + calls.length + " params=" + JSON.stringify(params));
        });

        await withRuntime({
            cnUtil: createCnUtil(),
            config: config,
            database: createDatabase({ caches: {} }),
            mysql: mysql,
            support: createSupport()
        }, async (port) => {
            const poolPayments = await request(port, { path: "/pool/payments?limit=2&page=0" });
            assert.equal(poolPayments.statusCode, 200);
            assert.equal(poolPayments.json.length, 2);
            assert.equal(poolPayments.json[0].pool_type, "pplns");
            assert.equal(poolPayments.json[1].pool_type, "legacy");
            assert.equal(mysql.calls.length, 2);

            const minerPayments = await request(port, { path: "/miner/wallet/payments?limit=2&page=0" });
            assert.equal(minerPayments.statusCode, 200);
            assert.equal(minerPayments.json.length, 2);
            assert.equal(minerPayments.json[0].txnHash, "tx21");
            assert.equal(minerPayments.json[1].txnHash, "tx20");
            assert.equal(mysql.calls.length, 4);
        });
    });

    test("block payment lookups stay parameterized when the wallet path contains injection text", async () => {
        const mysql = createMysql(async function handler(sql) {
            if (sql.startsWith("SELECT * FROM paid_blocks")) {
                return [
                    { id: 1, paid_time: "2024-01-02T00:00:00Z", found_time: "2024-01-01T00:00:00Z", port: 18081, hex: "hex1", amount: 1000 },
                    { id: 2, paid_time: "2024-01-03T00:00:00Z", found_time: "2024-01-02T00:00:00Z", port: 18081, hex: "hex2", amount: 2000 }
                ];
            }
            if (sql.startsWith("SELECT hex, amount FROM block_balance")) return [];
            throw new Error("Unexpected SQL: " + sql);
        });
        const attack = "wallet' OR 1=1 -- ";

        await withRuntime({
            cnUtil: createCnUtil(),
            config: createConfig(),
            database: createDatabase({ caches: {} }),
            mysql: mysql,
            support: createSupport()
        }, async (port) => {
            const response = await request(port, { path: "/miner/" + encodeURIComponent(attack) + "/block_payments" });
            assert.equal(response.statusCode, 200);
            assert.equal(mysql.calls.length, 2);
            assert.match(mysql.calls[1].sql, /payment_address = \?/);
            assert.doesNotMatch(mysql.calls[1].sql, /OR 1=1/);
            assert.equal(mysql.calls[1].params[0], attack);
            assert.equal(mysql.calls[1].params[1], "hex1");
            assert.equal(mysql.calls[1].params[2], "hex2");
        });
    });

});
