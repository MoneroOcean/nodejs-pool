"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const createLifecycle = require("../lib/pool/lifecycle.js");

test("worker startup rejects invalid database IDs and exhausted extranonce capacity", async () => {
    const originalConfig = global.config;
    const originalMysql = global.mysql;
    const originalExit = process.exit;
    const originalError = console.error;
    try {
        for (const [id, maxId, capacity] of [[0, 1, 0], [null, 1, 0], ["bad", 1, 0], [2, 1, 0], [1, 65537, 0], [1, 1, 65537], [1, 1, 1.5]]) {
            const exits = [];
            global.config = {pool_id: 1, max_pool_worker_num: capacity};
            global.mysql = {query(sql) { return Promise.resolve(sql.includes("MAX(id)") ? [{maxId}] : [{id}]); }};
            process.exit = code => { exits.push(code); };
            console.error = () => {};
            createLifecycle({state: {threadName: ""}}).startWorker();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(exits, [1], JSON.stringify({id, maxId, capacity}));
        }
    } finally {
        global.config = originalConfig;
        global.mysql = originalMysql;
        process.exit = originalExit;
        console.error = originalError;
    }
});

test("worker startup loads the IP whitelist before starting port servers", () => {
    const saved = {
        config: global.config, mysql: global.mysql, coinFuncs: global.coinFuncs,
        setInterval, setTimeout, exit: process.exit, log: console.log, error: console.error
    };
    const expectedWhitelist = {"proxy-one": 1, "proxy-two": 1};
    const syncReads = [];
    const exits = [];
    const state = {
        threadName: "", ipWhitelist: {}, walletLastCheckTime: {}, lastMinerLogTime: {},
        lastMinerNotifyTime: {}, minerAgents: {}, bannedAddresses: {}, notifyAddresses: {},
        walletTrust: {}, walletLastSeeTime: {}, walletDebug: {}, bannedTmpIPs: {},
        bannedTmpWallets: {}, bannedBigTmpWallets: {}, freeEthExtranonces: 0,
        newCoinHashFactor: {}, lastCoinHashFactor: {}, lastCoinHashFactorMM: {}
    };
    const fakeFs = Object.create(fs);
    fakeFs.readFileSync = (fileName, encoding) => {
        syncReads.push({fileName, encoding});
        return fileName === "ip_whitelist.txt" ? "proxy-one\nproxy-two\n" : "";
    };
    const missingFile = Object.assign(new Error("missing test file"), {code: "ENOENT"});
    fakeFs.readFile = (_fileName, _encoding, callback) => queueMicrotask(() => callback(missingFile));
    fakeFs.access = (_fileName, _mode, callback) => callback(missingFile);
    fakeFs.writeFile = (_fileName, _contents, callback) => callback(null);
    let portServersStarted = false;
    try {
        global.config = {
            pool_id: 1, max_pool_worker_num: 10, worker_num: 1,
            pool: {retargetTime: 30}, ports: [{}], daemon: {enableAlgoSwitching: false},
            general: {adminEmail: ""}, bind_ip: "", hostname: ""
        };
        global.mysql = {
            query(sql) {
                const rows = sql.includes("MAX(id)") ? [{maxId: 1}] : sql.startsWith("SELECT id") ? [{id: 1}] : [];
                return {
                    then(callback) {
                        callback(rows);
                        return {catch() {}};
                    }
                };
            }
        };
        global.coinFuncs = {uniqueWorkerIdBits: 0};
        global.setInterval = () => null;
        global.setTimeout = () => null;
        process.exit = code => { exits.push(code); };
        console.log = () => {};
        console.error = () => {};
        createLifecycle({
            cluster: {worker: {id: 1}},
            fs: fakeFs,
            os: {cpus: () => []},
            pruneTimedEntries() {},
            retention: {walletCheck: 0, minerLog: 0, minerNotify: 0, minerAgents: 0},
            state,
            minerRegistry: {checkAliveMiners() {}, retargetMiners() {}},
            shareProcessor: {replaceExtraWalletVerify() {}, drainExtraVerifyWalletHashes() { return []; }},
            templateManager: {templateUpdate() {}, anchorBlockUpdate() {}},
            messageHandler() {},
            startPortServers() {
                assert.deepEqual(syncReads, [{fileName: "ip_whitelist.txt", encoding: "utf8"}]);
                assert.deepEqual(state.ipWhitelist, expectedWhitelist);
                portServersStarted = true;
                return Promise.resolve();
            }
        }).startWorker();
        assert.deepEqual(exits, []);
        assert.equal(portServersStarted, true);
    } finally {
        global.config = saved.config;
        global.mysql = saved.mysql;
        global.coinFuncs = saved.coinFuncs;
        global.setInterval = saved.setInterval;
        global.setTimeout = saved.setTimeout;
        process.exit = saved.exit;
        console.log = saved.log;
        console.error = saved.error;
    }
});

test("replacement workers retain their logical ID when cluster IDs differ", () => {
    const saved = {config: global.config, support: global.support, setInterval, setTimeout, log: console.log, error: console.error};
    const workers = [];
    const listeners = {};
    const forkEnvironments = [];
    const cluster = {
        fork(env) {
            forkEnvironments.push(env);
            const worker = {id: 10 + workers.length, process: {pid: 100 + workers.length}, on() {}};
            workers.push(worker);
            return worker;
        },
        on(event, listener) { listeners[event] = listener; }
    };
    try {
        global.config = {ports: [], worker_num: 1, daemon: {}, general: {adminEmail: "ops@example.com"}, bind_ip: "127.0.0.1", hostname: "test"};
        global.support = {sendEmail() {}, sendAdminFyi() {}};
        global.setInterval = () => null;
        global.setTimeout = () => null;
        console.log = () => {};
        console.error = () => {};
        const lifecycle = createLifecycle({
            cluster, os: {cpus: () => [{}]}, net: {createServer: () => ({listen() {}})},
            state: {threadName: "", minerCount: [], workerMinerCounts: {}, newCoinHashFactor: {}, lastCoinHashFactor: {}, lastCoinHashFactorMM: {}},
            minerRegistry: {registerPool() {}}, templateManager: {templateUpdate() {}, unregisterWorkerTemplate() {}}, messageHandler() {}
        });
        lifecycle.startMaster();
        listeners.exit(workers[0], 1, "");
        assert.deepEqual(forkEnvironments, [{WORKER_ID: 1}, {WORKER_ID: 1}]);
    } finally {
        global.config = saved.config;
        global.support = saved.support;
        global.setInterval = saved.setInterval;
        global.setTimeout = saved.setTimeout;
        console.log = saved.log;
        console.error = saved.error;
    }
});
