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

function toStoredTimestamp(value) { return Math.round(value / 1000) * 1000; }

test.describe("worker history imports", { concurrency: false }, () => {
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

    test("v2 histories are reimported when the configured tier layout changes", () => {
        const workerHistory = loadWorkerHistory();
        const now = Date.now();
        const oldLayout = workerHistory.buildTierLayout(9, 1);
        const newLayout = workerHistory.buildTierLayout(12, 4);
        const oldPointTs = now - 8 * 60 * 1000;
        const newerPointTs = now - 4 * 60 * 1000;
        const appendedTs = now;

        assert.notDeepEqual(oldLayout.capacities, newLayout.capacities);
        let storedHistory = workerHistory.appendHistorySample(null, oldLayout, {
            ts: oldPointTs,
            hs: 11,
            hs2: 5
        });
        storedHistory = workerHistory.appendHistorySample(storedHistory, oldLayout, {
            ts: newerPointTs,
            hs: 13,
            hs2: 6
        });
        storedHistory = workerHistory.appendHistorySample(storedHistory, newLayout, {
            ts: appendedTs,
            hs: 17,
            hs2: 8
        });

        assert.equal(storedHistory.encoding, workerHistory.HISTORY_ENCODING);
        assert.deepEqual(storedHistory.capacities, newLayout.capacities);
        assert.equal(typeof storedHistory.tiers[0].data, "string");

        const decoded = workerHistory.toHashHistory(storedHistory);
        assert.equal(decoded.length, 3);
        assert.equal(decoded[0].ts, toStoredTimestamp(appendedTs));
        assert.equal(decoded[1].ts, toStoredTimestamp(newerPointTs));
        assert.equal(decoded[2].ts, toStoredTimestamp(oldPointTs));
    });

    test("worker histories are written on each history cycle without the old ten minute gate", async () => {
        const now = 1710000000000;
        let fakeNow = now;
        Date.now = function () { return fakeNow; };
        const address = "4".repeat(95);
        const workerName = "rigB";
        const workerKey = address + "_" + workerName;
        const historyKey = "history:" + workerKey;
        const shares = [
            {
                height: 1,
                share: createShare({
                    paymentAddress: address,
                    identifier: workerName,
                    rawShares: 600,
                    shares2: 300,
                    timestamp: now - 30 * 1000
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
        ];
        createFakeEnvironment({ shares: shares });
        const worker = loadWorker();
        const workerHistory = loadWorkerHistory();
        const runtime = worker.createWorkerRuntime();

        await runUpdate(runtime, 1);
        let decoded = workerHistory.toHashHistory(JSON.parse(global.database.env.beginTxn({ readOnly: true }).getString(global.database.cacheDB, historyKey)));
        assert.equal(decoded.length, 1);

        fakeNow = now + 60 * 1000;
        shares[0].share.raw_shares = 1200;
        shares[0].share.shares2 = 900;
        shares[0].share.timestamp = fakeNow - 10 * 1000;
        await runUpdate(runtime, 1);
        decoded = workerHistory.toHashHistory(JSON.parse(global.database.env.beginTxn({ readOnly: true }).getString(global.database.cacheDB, historyKey)));
        assert.equal(decoded.length, 1);

        fakeNow = now + 120 * 1000;
        shares[0].share.raw_shares = 1800;
        shares[0].share.shares2 = 1200;
        shares[0].share.timestamp = fakeNow - 10 * 1000;
        await runUpdate(runtime, 1);

        decoded = workerHistory.toHashHistory(JSON.parse(global.database.env.beginTxn({ readOnly: true }).getString(global.database.cacheDB, historyKey)));
        assert.equal(decoded.length, 2);
        assert.ok(decoded[0].hs > decoded[1].hs);
    });

});
