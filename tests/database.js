"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    getInitializedLocalDatabase,
    getLocalDatabase,
    getRemoteDatabase
} = require("../lib/common/database.js");

test.describe("database role boundaries", { concurrency: false }, () => {
    test("selects a local runtime by role without pretending pending resources are ready", () => {
        const pending = { role: "local", env: null, shareDB: null, blockDB: null, altblockDB: null, cacheDB: null };
        assert.equal(getLocalDatabase(pending), pending);
        assert.throws(() => getInitializedLocalDatabase(pending), /Local database is not initialized/);
    });

    test("accepts an initialized local runtime only after every LMDB handle exists", () => {
        const initialized = { role: "local", env: {}, shareDB: {}, blockDB: {}, altblockDB: {}, cacheDB: {} };
        assert.equal(getInitializedLocalDatabase(initialized), initialized);
    });

    test("rejects a remote runtime at local call sites", () => {
        const remote = { role: "remote" };
        assert.throws(() => getLocalDatabase(remote), /Local database runtime is required/);
        assert.equal(getRemoteDatabase(remote), remote);
    });
});
