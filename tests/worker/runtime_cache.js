"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");

const WORKER_PATH = require.resolve("../../lib/worker.js");
const WORKER_HISTORY_PATH = require.resolve("../../lib/common/worker_history.js");
const supportFactory = require("../../lib/common/support.js");

function loadWorker() {
    const previousAutostart = global.__workerAutostart;
    global.__workerAutostart = false;
    delete require.cache[WORKER_PATH];

    try {
        return require(WORKER_PATH);
    } finally {
        if (typeof previousAutostart === "undefined") delete global.__workerAutostart;
        else global.__workerAutostart = previousAutostart;
    }
}

function loadWorkerHistory() {
    delete require.cache[WORKER_HISTORY_PATH];
    return require(WORKER_HISTORY_PATH);
}

function createFakeEnvironment(options) {
    options = options || {};

    const cacheDB = { name: "cache" };
    const shareDB = { name: "share" };
    const cacheStore = new Map(options.cacheEntries || []);
    const shareStore = new Map();
    const emails = [];

    (options.shares || []).forEach(function (entry) {
        const bucket = shareStore.get(entry.height) || [];
        bucket.push(entry.share);
        shareStore.set(entry.height, bucket);
    });

    class Cursor {
        constructor(_txn, db) {
            this.db = db;
            this.key = null;
            this.index = -1;
        }

        goToRange(key) {
            if (this.db !== shareDB || !shareStore.has(key)) {
                this.key = null;
                this.index = -1;
                return null;
            }

            this.key = key;
            this.index = 0;
            return key;
        }

        goToNextDup() {
            if (this.db !== shareDB || this.key === null) return null;
            const entries = shareStore.get(this.key) || [];
            if (this.index + 1 >= entries.length) {
                this.index = -1;
                return null;
            }

            this.index += 1;
            return this.key;
        }

        getCurrentBinary(callback) {
            callback(this.key, shareStore.get(this.key)[this.index]);
        }

        close() {}
    }

    const env = {
        writeCommits: 0,
        commits: [],
        beginTxn(txnOptions) {
            const operations = [];
            const readOnly = !!(txnOptions && txnOptions.readOnly);

            return {
                getString(db, key) {
                    if (db !== cacheDB) return null;
                    return cacheStore.has(key) ? cacheStore.get(key) : null;
                },
                putString(db, key, value) {
                    operations.push(["putString", db, key, value]);
                },
                del(db, key) {
                    operations.push(["del", db, key]);
                },
                commit() {
                    if (readOnly) return;
                    operations.forEach(function (entry) {
                        if (entry[0] === "putString") {
                            cacheStore.set(entry[2], entry[3]);
                            return;
                        }
                        cacheStore.delete(entry[2]);
                    });
                    env.commits.push(operations.slice());
                    env.writeCommits += 1;
                },
                abort() {}
            };
        }
    };

    global.config = {
        api: {
            secKey: "worker-test-secret"
        },
        daemon: {
            port: 18081
        },
        general: {
            adminEmail: "admin@example.com",
            emailSig: "sig",
            statsBufferHours: options.statsBufferHours || 1,
            statsBufferLength: options.statsBufferLength || 9
        },
        email: {
            workerNotHashingBody: "stopped",
            workerNotHashingSubject: "stopped-subject",
            workerStartHashingBody: "started",
            workerStartHashingSubject: "started-subject"
        }
    };
    global.database = {
        cacheDB: cacheDB,
        env: env,
        lmdb: { Cursor: Cursor },
        shareDB: shareDB
    };
    global.mysql = {
        query() {
            return Promise.resolve([]);
        }
    };
    global.protos = {
        POOLTYPE: {
            PPLNS: 0
        },
        Share: {
            decode(value) {
                return value;
            }
        }
    };
    global.support = {
        formatDate(value) {
            return String(value);
        },
        formatTemplate(template, values) {
            return template.replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
                return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
            });
        },
        sendEmail() {
            emails.push(Array.from(arguments));
        }
    };

    return {
        cacheStore: cacheStore,
        emails: emails,
        env: env
    };
}

function createShare(share) {
    return {
        identifier: share.identifier,
        paymentAddress: share.paymentAddress,
        paymentID: share.paymentID,
        poolType: 0,
        port: share.port || 18081,
        raw_shares: share.rawShares,
        shares2: share.shares2,
        timestamp: share.timestamp
    };
}

function createResponse() {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.setEncoding = function setEncoding() {};
    return response;
}

function createRequest() {
    const request = new EventEmitter();
    request.write = function write() {};
    request.end = function end() {};
    request.setTimeout = function setTimeout() {};
    request.destroy = function destroy(error) {
        this.emit("error", error);
    };
    return request;
}

function runUpdate(runtime, height) {
    return new Promise(function (resolve) {
        runtime.updateShareStats2(height, resolve);
    });
}

function toStoredTimestamp(value) { return Math.round(value / 1000) * 1000; }

test.describe("worker runtime cache", { concurrency: false }, () => {
    let originalConfig;
    let originalDatabase;
    let originalMysql;
    let originalProtos;
    let originalSupport;
    let originalConsoleError;
    let originalConsoleLog;
    let originalDateNow;

    test.beforeEach(() => {
        delete require.cache[WORKER_PATH];
        delete require.cache[WORKER_HISTORY_PATH];
        originalConfig = global.config;
        originalDatabase = global.database;
        originalMysql = global.mysql;
        originalProtos = global.protos;
        originalSupport = global.support;
        originalConsoleError = console.error;
        originalConsoleLog = console.log;
        originalDateNow = Date.now;
        console.error = function () {};
        console.log = function () {};
    });

    test.afterEach(() => {
        global.config = originalConfig;
        global.database = originalDatabase;
        global.mysql = originalMysql;
        global.protos = originalProtos;
        global.support = originalSupport;
        console.error = originalConsoleError;
        console.log = originalConsoleLog;
        Date.now = originalDateNow;
        delete global.__workerAutostart;
        delete require.cache[WORKER_PATH];
        delete require.cache[WORKER_HISTORY_PATH];
    });

    test("worker ignores an existing cacheUpdate marker while flushing batches", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        const shares = [];

        for (let index = 0; index < 260; ++index) {
            shares.push({
                height: 1,
                share: createShare({
                    paymentAddress: address,
                    identifier: "rig" + index,
                    rawShares: 600 + index,
                    shares2: 300 + index,
                    timestamp: now - 30 * 1000
                })
            });
        }

        shares.push({
            height: 0,
            share: createShare({
                paymentAddress: address,
                identifier: "old",
                rawShares: 1,
                shares2: 0,
                timestamp: now - 3 * 60 * 60 * 1000
            })
        });

        const state = createFakeEnvironment({
            cacheEntries: [["cacheUpdate", "1"]],
            shares: shares,
            statsBufferLength: 27,
            statsBufferHours: 4
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        assert.equal(state.cacheStore.get("cacheUpdate"), "1");
        const flattenedOps = state.env.commits.flat();
        const markerOps = flattenedOps.filter(function (entry) {
            return entry[2] === "cacheUpdate";
        });

        assert.deepEqual(markerOps, []);
    });

    test("worker runtime reuses cached history layout when config is unchanged", async () => {
        const now = Date.now();
        const address = "4".repeat(95);
        createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "rigA",
                        rawShares: 800,
                        shares2: 400,
                        timestamp: now - 15 * 1000
                    })
                },
                {
                    height: 0,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "old",
                        rawShares: 1,
                        shares2: 0,
                        timestamp: now - 3 * 60 * 60 * 1000
                    })
                }
            ],
            statsBufferLength: 27,
            statsBufferHours: 4
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        const firstLayout = runtime.state.historyLayoutCache.layout;

        await runUpdate(runtime, 1);

        assert.strictEqual(runtime.state.historyLayoutCache.layout, firstLayout);
    });

    test("worker logs history layout once and keeps cycle start logs clean", async () => {
        const now = 1710000000000;
        let fakeNow = now;
        const logs = [];
        Date.now = function () { return fakeNow; };
        console.log = function (message) {
            logs.push(message);
        };

        const address = "4".repeat(95);
        createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "rigA",
                        rawShares: 800,
                        shares2: 400,
                        timestamp: now - 15 * 1000
                    })
                },
                {
                    height: 0,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "old",
                        rawShares: 1,
                        shares2: 0,
                        timestamp: now - 3 * 60 * 60 * 1000
                    })
                }
            ],
            statsBufferLength: 27,
            statsBufferHours: 4
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        fakeNow += 20 * 1000;
        await runUpdate(runtime, 1);

        const cycleLogs = logs.filter(function (message) {
            return message.indexOf("Worker cycle: ") === 0;
        });
        const layoutLogs = logs.filter(function (message) {
            return message.indexOf("Worker config: ") === 0;
        });

        assert.equal(cycleLogs.length, 0);
        assert.deepEqual(layoutLogs, ["Worker config: history_tiers=7/7/7/6 history_intervals=2m/6m/18m/54m"]);
    });

    test("worker history tier layout honors both statsBufferLength and statsBufferHours", () => {
        const workerHistory = loadWorkerHistory();
        const layout = workerHistory.buildTierLayout(1001, 72);
        const coverage = layout.capacities.reduce(function (sum, capacity, index) {
            return sum + capacity * layout.intervalsSec[index];
        }, 0);

        assert.equal(layout.maxPoints, 1001);
        assert.ok(coverage >= 72 * 60 * 60);
        assert.equal(layout.capacities.reduce(function (sum, capacity) { return sum + capacity; }, 0), 1001);
    });

    test("worker enters fail-stop and emails the admin when LMDB is full", async () => {
        const now = 1710000000000;
        Date.now = function () { return now; };
        const address = "4".repeat(95);
        const envState = createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: "rigMapFull",
                        rawShares: 800,
                        shares2: 400,
                        timestamp: now - 15 * 1000
                    })
                }
            ]
        });
        const originalBeginTxn = global.database.env.beginTxn;
        global.database.env.beginTxn = function beginTxnWithMapFull(options) {
            const txn = originalBeginTxn.call(this, options);
            if (options && options.readOnly) return txn;
            txn.commit = function commitMapFull() {
                const error = new Error("MDB_MAP_FULL: Environment mapsize limit reached");
                error.code = -30792;
                throw error;
            };
            return txn;
        };

        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        assert.equal(runtime.state.lmdbFailStop, true);
        assert.equal(runtime.state.started, false);
        assert.deepEqual(envState.emails[0], [
            "admin@example.com",
            "Worker module paused due to LMDB full",
            "worker paused after LMDB reported map full while writing worker cache: MDB_MAP_FULL: Environment mapsize limit reached."
        ]);
    });

    test("worker stopped email uses SQL templates with masked wallet, UTC time, and pool signature", async () => {
        const originalRequest = http.request;
        const originalSetTimeout = global.setTimeout;
        let capturedPayload = null;
        const currentTime = Date.UTC(2026, 3, 25, 21, 22, 0);
        const address = "48abcd" + "e".repeat(85) + "7xYz";

        createFakeEnvironment();
        global.config.hostname = "us.moneroocean.stream";
        global.config.bind_ip = "203.0.113.7";
        global.config.rpc = { https: false };
        global.config.daemon.address = "127.0.0.1";
        global.config.wallet = { address: "127.0.0.1", port: 18081 };
        global.config.general.emailBrand = "MoneroOcean";
        global.config.general.emailSig = "MoneroOcean Admin Team";
        global.config.general.emailFrom = "pool@example.com";
        global.config.general.mailgunURL = "http://127.0.0.1/send";
        global.config.email.workerNotHashingSubject = "Worker stopped hashing: %(worker)s";
        global.config.email.workerNotHashingBody = [
            "Worker status changed",
            "",
            "Pool: %(pool)s",
            "Status: stopped",
            "Worker: %(worker)s",
            "Wallet: %(wallet)s",
            "Time (UTC): %(timestamp)s",
            "Notice delay: %(notice_delay)s",
            "",
            "No action is required if this was expected."
        ].join("\n");
        global.mysql.query = function query(sql, params) {
            assert.equal(sql, "SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1");
            assert.deepEqual(params, [address]);
            return Promise.resolve([{ email: "miner@example.com" }]);
        };
        global.support = supportFactory();
        global.support._resetEmailState();

        http.request = function fakeRequest(_options, onResponse) {
            const request = createRequest();
            let requestBody = "";
            request.write = function write(chunk) {
                requestBody += chunk;
            };
            request.end = function end() {
                capturedPayload = JSON.parse(requestBody);
                const response = createResponse();
                setImmediate(function respond() {
                    onResponse(response);
                    response.emit("data", "{}");
                    response.emit("end");
                });
            };
            return request;
        };
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            if (delay === 5 * 60 * 1000 || delay === 30 * 60 * 1000 || delay === 1000) {
                return setImmediate(fn, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            const worker = loadWorker();
            const runtime = worker.createWorkerRuntime();
            runtime.delayedSendWorkerStoppedHashingEmail(address + "_rig01", currentTime);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            assert.equal(capturedPayload.subject, "MoneroOcean: Workers stopped hashing");
            assert.match(capturedPayload.text, /^Hello,\n\nWorker status changed\n\nPool: MoneroOcean\nStatus: stopped\nWorker: rig01\nWallet: 48abcd\.\.\.7xYz\nTime \(UTC\): 2026-04-25 21:22:00\nNotice delay: 10 minutes without submitted hashes/);
            assert.match(capturedPayload.text, /\n\nUnsubscribe: https:\/\/api\.moneroocean\.stream\/user\/unsubscribeEmail\/[A-Za-z0-9_-]+\n\nThank you,/);
            assert.match(capturedPayload.text, /Thank you,\nMoneroOcean Admin Team$/);
            assert.equal(capturedPayload.text.includes(address), false);
            assert.equal(capturedPayload.text.includes("Pool node:"), false);
        } finally {
            http.request = originalRequest;
            global.setTimeout = originalSetTimeout;
        }
    });
});
