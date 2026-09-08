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

