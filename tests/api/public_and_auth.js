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

function createBlockTemplate() {
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
    test("authentication preserves legacy login behavior and authed routes still accept query, body, and header tokens", async () => {
        const config = createConfig();
        const secureHash = crypto.createHmac("sha256", config.api.secKey).update("secretpass").digest("hex");
        const mysql = createMysql(async function handler(sql, params) {
            if (sql.startsWith("SELECT id, pass, email FROM users WHERE username = ?")) {
                if (params[0] === "legacy") return [{ id: 1, pass: null, email: "mailpass" }];
                if (params[0] === "secure") return [{ id: 2, pass: secureHash, email: "user@example.com" }];
                return [];
            }
            if (sql.startsWith("SELECT payout_threshold, enable_email, email FROM users WHERE id = ?")) {
                return [{ payout_threshold: 10, enable_email: 1, email: "user@example.com" }];
            }
            if (sql.startsWith("UPDATE users SET email = ? WHERE id = ?")) {
                return { affectedRows: 1 };
            }
            throw new Error("Unexpected SQL: " + sql + " params=" + JSON.stringify(params));
        });

        await withRuntime({
            blockTemplate: createBlockTemplate(),
            config: config,
            database: createDatabase({ caches: {} }),
            jwt: jwt,
            mysql: mysql,
            support: createSupport()
        }, async (port) => {
            const legacyLogin = await requestJson(port, "POST", "/authenticate", { username: "legacy", password: "mailpass" });
            assert.equal(legacyLogin.statusCode, 200);
            assert.equal(legacyLogin.json.success, true);

            const secureLogin = await requestJson(port, "POST", "/authenticate", { username: "secure", password: "secretpass" });
            assert.equal(secureLogin.statusCode, 200);
            assert.equal(secureLogin.json.success, true);

            const headerAuthed = await request(port, {
                path: "/authed/",
                headers: { "x-access-token": legacyLogin.json.msg }
            });
            assert.equal(headerAuthed.statusCode, 200);
            assert.equal(headerAuthed.json.msg.email, "user@example.com");

            const queryAuthed = await request(port, {
                path: "/authed/?token=" + encodeURIComponent(secureLogin.json.msg)
            });
            assert.equal(queryAuthed.statusCode, 200);
            assert.equal(queryAuthed.json.msg.payout_threshold, 10);

            const bodyAuthed = await requestJson(port, "POST", "/authed/changeEmail", {
                token: secureLogin.json.msg,
                email: "changed@example.com"
            });
            assert.equal(bodyAuthed.statusCode, 200);
            assert.equal(bodyAuthed.json.msg, "Updated email was set to: changed@example.com");
        });
    });

    test("public threshold updates still work and missing worker cache rows fail safely", async () => {
        const mysql = createMysql(async function handler(sql) {
            if (sql.startsWith("SELECT id FROM users WHERE username = ? AND payout_threshold_lock = '1'")) return [];
            if (sql.startsWith("INSERT INTO users (username, payout_threshold)")) return { affectedRows: 1 };
            throw new Error("Unexpected SQL: " + sql);
        });

        await withRuntime({
            blockTemplate: createBlockTemplate(),
            config: createConfig(),
            database: createDatabase({ caches: { wallet: { seen: true } } }),
            mysql: mysql,
            support: createSupport()
        }, async (port) => {
            const threshold = await requestJson(port, "POST", "/user/updateThreshold", { username: "wallet", threshold: 0 });
            assert.equal(threshold.statusCode, 401);
            assert.equal(threshold.json.success, false);

            const validThreshold = await requestJson(port, "POST", "/user/updateThreshold", { username: "wallet", threshold: "0.05" });
            assert.equal(validThreshold.statusCode, 200);
            assert.equal(validThreshold.json.msg, "Threshold updated, set to: 0.1");

            const workerStats = await request(port, { path: "/miner/missing/stats/rig01" });
            assert.equal(workerStats.statusCode, 200);
            assert.deepEqual(workerStats.json, {
                lts: false,
                identifer: "rig01",
                hash: false,
                hash2: false,
                totalHash: false,
                validShares: false,
                invalidShares: false
            });
        });
    });

    test("GUI-facing public routes keep nested stats, field names, and timestamp units", async () => {
        const mysql = createMysql(async function handler(sql, params) {
            if (sql.startsWith("SELECT * FROM transactions ORDER BY id DESC")) {
                return [
                    { id: 44, transaction_hash: "pool-tx", mixin: 11, payees: 3, fees: 15, xmr_amt: 345, submitted_time: "2024-01-02T03:04:05Z" }
                ];
            }
            if (sql.startsWith("SELECT amount as amt, pool_type, transaction_id")) {
                return [
                    { amt: 250, pool_type: "pplns", transaction_id: 55, ts: 1704164645 }
                ];
            }
            if (sql.startsWith("SELECT id, transaction_hash, mixin FROM transactions WHERE id IN")) {
                return [
                    { id: 55, transaction_hash: "miner-tx", mixin: 7 }
                ];
            }
            if (sql.startsWith("SELECT * FROM paid_blocks")) {
                return [
                    { id: 8, paid_time: "2024-01-03T00:00:00Z", found_time: "2024-01-02T00:00:00Z", port: 18081, hex: "block-hex", amount: 400 }
                ];
            }
            if (sql.startsWith("SELECT hex, amount FROM block_balance")) {
                return [
                    { hex: "block-hex", amount: 0.25 }
                ];
            }
            if (sql.startsWith("SELECT payout_threshold, enable_email FROM users WHERE username = ? LIMIT 1")) {
                assert.equal(params[0], "wallet");
                return [{ payout_threshold: 250, enable_email: 1 }];
            }
            throw new Error("Unexpected SQL: " + sql + " params=" + JSON.stringify(params));
        });
        const database = createDatabase({
            caches: {
                pool_stats_global: {
                    totalBlocksFound: 12,
                    altBlocksFound: {},
                    miners: 5,
                    minerHistory: [{ ts: 1, miners: 5 }],
                    hashHistory: [{ ts: 1, hs: 9 }]
                }
            }
        });

        await withRuntime({
            blockTemplate: createBlockTemplate(),
            config: createConfig(),
            database: database,
            mysql: mysql,
            support: createSupport()
        }, async (port) => {
            const poolStats = await request(port, { path: "/pool/stats" });
            assert.equal(poolStats.statusCode, 200);
            assert.equal("pool_statistics" in poolStats.json, true);
            assert.equal(poolStats.json.pool_statistics.totalBlocksFound, 12);
            assert.equal("minerHistory" in poolStats.json.pool_statistics, false);
            assert.equal("hashHistory" in poolStats.json.pool_statistics, false);

            const poolPayments = await request(port, { path: "/pool/payments?limit=1&page=0" });
            assert.equal(poolPayments.statusCode, 200);
            assert.equal(poolPayments.json[0].hash, "pool-tx");
            assert.equal(poolPayments.json[0].ts, Date.parse("2024-01-02T03:04:05Z"));
            assert.equal(poolPayments.json[0].value, 345);
            assert.equal(poolPayments.json[0].fee, 15);

            const minerPayments = await request(port, { path: "/miner/wallet/payments?limit=1&page=0" });
            assert.equal(minerPayments.statusCode, 200);
            assert.equal(minerPayments.json[0].txnHash, "miner-tx");
            assert.equal(minerPayments.json[0].ts, 1704164645);
            assert.equal(minerPayments.json[0].amount, 250);

            const blockPayments = await request(port, { path: "/miner/wallet/block_payments?limit=1&page=0" });
            assert.equal(blockPayments.statusCode, 200);
            assert.equal(blockPayments.json[0].ts, 1704240000);
            assert.equal(blockPayments.json[0].ts_found, 1704153600);
            assert.equal(blockPayments.json[0].value_percent, 25);
            assert.equal(blockPayments.json[0].value, 1);

            const user = await request(port, { path: "/user/wallet" });
            assert.equal(user.statusCode, 200);
            assert.deepEqual(user.json, { payout_threshold: 250, email_enabled: 1 });
        });
    });

    test("GUI-surfaced email subscription errors keep their legacy error payloads", async () => {
        const mysql = createMysql(async function handler(sql, params) {
            if (sql.startsWith("UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND email = ?")) {
                assert.equal(params[2], "wallet");
                return { affectedRows: 0 };
            }
            if (sql.startsWith("UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND (email IS NULL OR email = '')")) {
                assert.equal(params[2], "wallet");
                return { affectedRows: 0 };
            }
            if (sql.startsWith("INSERT INTO users (username, enable_email, email) VALUES (?, ?, ?)")) {
                throw new Error("duplicate email");
            }
            throw new Error("Unexpected SQL: " + sql + " params=" + JSON.stringify(params));
        });

        await withRuntime({
            blockTemplate: createBlockTemplate(),
            config: createConfig(),
            database: createDatabase({ caches: { wallet: { seen: true } } }),
            mysql: mysql,
            support: createSupport()
        }, async (port) => {
            const fromMismatch = await requestJson(port, "POST", "/user/subscribeEmail", {
                username: "wallet",
                enabled: 1,
                from: "old@example.com",
                to: "new@example.com"
            });
            assert.equal(fromMismatch.statusCode, 401);
            assert.deepEqual(fromMismatch.json, { error: "FROM email does not match" });

            const invalidFrom = await requestJson(port, "POST", "/user/subscribeEmail", {
                username: "wallet",
                enabled: 1,
                from: "",
                to: "new@example.com"
            });
            assert.equal(invalidFrom.statusCode, 401);
            assert.deepEqual(invalidFrom.json, { error: "Please specify valid FROM email" });
        });
    });

    test("summary logging stays compact and only emits when there was activity", async () => {
        const captured = await captureConsole(async function run(output) {
            await withRuntime({
                blockTemplate: createBlockTemplate(),
                config: createConfig(),
                database: createDatabase({ caches: {} }),
                mysql: createMysql(async () => []),
                summaryIntervalMs: 25,
                support: createSupport()
            }, async (port) => {
                await request(port, { path: "/config" });
                await request(port, { path: "/config" });
                await waitForCondition(() => output.logs.some((line) => line.includes("API summary:")), 250);
                const firstSummaryCount = output.logs.filter((line) => line.includes("API summary:")).length;
                await wait(60);
                const secondSummaryCount = output.logs.filter((line) => line.includes("API summary:")).length;
                assert.equal(firstSummaryCount, 1);
                assert.equal(secondSummaryCount, 1);
            });
        });

        const summaryLine = captured.logs.find((line) => line.includes("API summary:"));
        assert.match(summaryLine, /req=2/);
        assert.match(summaryLine, /cache=1\/1/);
        assert.match(summaryLine, /db=0q\/0err/);
        assert.match(summaryLine, /avg=\d+ms/);
        assert.ok(captured.logs.some((line) => line.includes("listening for API requests")));
    });
});
