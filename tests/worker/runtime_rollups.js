"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const WORKER_PATH = require.resolve("../../lib/worker.js");
const WORKER_HISTORY_PATH = require.resolve("../../lib/common/worker_history.js");

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

function runUpdate(runtime, height) {
    return new Promise(function (resolve) {
        runtime.updateShareStats2(height, resolve);
    });
}

function toStoredTimestamp(value) {
    return Math.round(value / 1000) * 1000;
}

test.describe("worker", { concurrency: false }, () => {
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

    test("worker exact rescan includes older recent shares without bucket cache", async () => {
        const now = 1710002401234;
        Date.now = function () { return now; };
        const address = "4".repeat(95);
        const workerName = "rigExact";
        const recentShare = createShare({
            paymentAddress: address,
            identifier: workerName,
            rawShares: 1200,
            shares2: 900,
            timestamp: now - 30 * 1000
        });
        const olderHashShare = createShare({
            paymentAddress: address,
            identifier: workerName,
            rawShares: 600,
            shares2: 300,
            timestamp: now - 9 * 60 * 1000
        });
        const identifierOnlyShare = createShare({
            paymentAddress: address,
            identifier: "rigOld",
            rawShares: 200,
            shares2: 0,
            timestamp: now - 15 * 60 * 1000
        });
        const stopShare = createShare({
            paymentAddress: address,
            identifier: "ancient",
            rawShares: 1,
            shares2: 0,
            timestamp: now - 3 * 60 * 60 * 1000
        });

        const state = createFakeEnvironment({
            shares: [
                { height: 2, share: recentShare },
                { height: 1, share: olderHashShare },
                { height: 1, share: identifierOnlyShare },
                { height: 0, share: stopShare }
            ]
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 2);

        const workerStats = JSON.parse(state.cacheStore.get("stats:" + address + "_" + workerName));
        const addressStats = JSON.parse(state.cacheStore.get("stats:" + address));
        const identifiers = JSON.parse(state.cacheStore.get("identifiers:" + address));

        assert.equal(workerStats.hash, (600 + 1200) / (10 * 60));
        assert.equal(workerStats.hash2, (300 + 900) / (10 * 60));
        assert.equal(addressStats.hash, (600 + 1200) / (10 * 60));
        assert.equal(addressStats.hash2, (300 + 900) / (10 * 60));
        assert.deepEqual(identifiers, [workerName, "rigOld"]);
    });

    test("worker skips unchanged LMDB writes between identical non-history cycles", async () => {
        const now = 1710000000000;
        let fakeNow = now;
        const logs = [];
        Date.now = function () { return fakeNow; };
        console.log = function (message) {
            logs.push(message);
        };
        const address = "4".repeat(95);
        const workerName = "rigStable";
        const state = createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: workerName,
                        rawShares: 900,
                        shares2: 450,
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
            ]
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        const writeCommitsAfterFirstRun = state.env.writeCommits;
        const commitsAfterFirstRun = state.env.commits.length;

        fakeNow += 20 * 1000;
        await runUpdate(runtime, 1);

        assert.equal(state.env.writeCommits, writeCommitsAfterFirstRun);
        assert.equal(state.env.commits.length, commitsAfterFirstRun);
        const processedLog = logs.filter(function (message) {
            return message.indexOf("Worker cycle: ") === 0 && message.indexOf("status=done") !== -1;
        }).pop();
        const skippedMatch = processedLog && processedLog.match(/skipped_mb=([0-9.]+) compared_mb=([0-9.]+) hashrate=/);
        assert.notEqual(skippedMatch, null);
        assert.ok(Number(skippedMatch[1]) >= 0);
        assert.ok(Number(skippedMatch[2]) >= Number(skippedMatch[1]));
    });

    test("worker recreates externally removed cache rows on the next identical cycle", async () => {
        const now = 1710000000000;
        let fakeNow = now;
        Date.now = function () { return fakeNow; };
        const address = "4".repeat(95);
        const workerName = "rigRecover";
        const workerStatsKey = "stats:" + address + "_" + workerName;
        const globalStatsKey = "global_stats";
        const state = createFakeEnvironment({
            shares: [
                {
                    height: 1,
                    share: createShare({
                        paymentAddress: address,
                        identifier: workerName,
                        rawShares: 900,
                        shares2: 450,
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
            ]
        });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        const writeCommitsAfterFirstRun = state.env.writeCommits;

        state.cacheStore.delete(workerStatsKey);
        state.cacheStore.delete(globalStatsKey);

        fakeNow += 20 * 1000;
        await runUpdate(runtime, 1);

        assert.equal(state.cacheStore.has(workerStatsKey), true);
        assert.equal(state.cacheStore.has(globalStatsKey), true);
        assert.ok(state.env.writeCommits > writeCommitsAfterFirstRun);
    });

    test("worker cache writes flush in batches for large history updates", async () => {
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

        const state = createFakeEnvironment({ shares: shares, statsBufferLength: 27, statsBufferHours: 4 });
        const worker = loadWorker();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);

        assert.ok(state.env.writeCommits >= 2);
        assert.equal(state.cacheStore.has("stats:" + address + "_rig0"), true);
        assert.equal(state.cacheStore.has("history:" + address + "_rig0"), true);
    });

});
