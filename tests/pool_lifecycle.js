"use strict";
const assert = require("node:assert/strict");
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
            minerRegistry: {registerPool() {}}, templateManager: {templateUpdate() {}}, messageHandler() {}
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
