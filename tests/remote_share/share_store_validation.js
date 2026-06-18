"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const createShareStore = require("../../lib/remote_share/share_store.js");

// Emulate node-lmdb's keyIsUint32 share DB: putBinary throws synchronously for any key
// that is not an unsigned 32-bit integer (the exact condition that, before the fix,
// propagated uncaught out of the share-flush timer and killed the master uplink).
function makeFakeDatabase(putBinaryKeys) {
    const txn = {
        getString() { return null; },
        putString() {},
        putBinary(_db, key) {
            if (!Number.isInteger(key) || key < 0 || key > 0xffffffff) {
                throw new Error("Invalid key. Should be an unsigned 32-bit integer.");
            }
            putBinaryKeys.push(key);
        },
        commit() {},
        abort() {}
    };
    return { env: { beginTxn() { return txn; } }, cacheDB: {}, shareDB: {} };
}

function withGlobals(run) {
    const saved = { config: global.config, coinFuncs: global.coinFuncs, protos: global.protos };
    global.config = { daemon: { port: 18081 } };
    global.coinFuncs = { getPoolProfile() { return null; }, COIN2PORT() { return 18081; } };
    global.protos = {
        POOLTYPE: { PPLNS: 0 },
        Share: { encode(shareData) { return Buffer.from(JSON.stringify(shareData)); } }
    };
    try {
        return run();
    } finally {
        global.config = saved.config;
        global.coinFuncs = saved.coinFuncs;
        global.protos = saved.protos;
    }
}

function share(overrides) {
    return Object.assign({
        paymentAddress: "44address",
        identifier: "rig01",
        poolType: 0,
        port: 18081,
        raw_shares: 10,
        blockHeight: 100
    }, overrides);
}

test.describe("remote share store validation", { concurrency: false }, function shareStoreValidationSuite() {
    test("storeShares drops shares whose blockHeight is not a uint32 and keeps the valid ones", () => {
        withGlobals(() => {
            const putBinaryKeys = [];
            const store = createShareStore({ database: makeFakeDatabase(putBinaryKeys) });
            const result = store.storeShares([
                share({ blockHeight: -1 }),              // signed int32 underflow
                share({ blockHeight: 0x1_0000_0000 }),   // above uint32 max
                share({ blockHeight: 1.5 }),             // non-integer
                share({ blockHeight: 100 })              // valid -> must be stored
            ]);
            assert.equal(result, true);
            assert.deepEqual(putBinaryKeys, [100]);
        });
    });

    test("a single poison blockHeight frame cannot crash storeShares", () => {
        withGlobals(() => {
            const putBinaryKeys = [];
            const store = createShareStore({ database: makeFakeDatabase(putBinaryKeys) });
            assert.doesNotThrow(function flushPoisonFrame() {
                store.storeShares([share({ blockHeight: -1 })]);
            });
            assert.deepEqual(putBinaryKeys, []);
        });
    });

    test("storeShares drops shares whose raw_shares is non-finite (NaN/Infinity) and keeps the valid ones", () => {
        withGlobals(() => {
            const putBinaryKeys = [];
            const cacheWrites = [];
            const database = makeFakeDatabase(putBinaryKeys);
            // Capture cache merges so a poison frame can be shown not to enter the accumulators.
            database.env.beginTxn().putString = function captureWrite(_db, key, value) {
                cacheWrites.push({ key, value });
            };
            const store = createShareStore({ database });
            const result = store.storeShares([
                share({ raw_shares: NaN }),        // wire NaN -> typeof "number" but not finite
                share({ raw_shares: Infinity }),   // wire Infinity -> likewise
                share({ raw_shares: 10 })          // valid -> must be stored
            ]);
            assert.equal(result, true);
            assert.deepEqual(putBinaryKeys, [100]);
            // No accumulated stat may be NaN/Infinity once the poison frames are dropped.
            for (const write of cacheWrites) {
                for (const value of Object.values(JSON.parse(write.value))) {
                    if (typeof value === "number") assert.equal(Number.isFinite(value), true, `non-finite stat written for ${write.key}`);
                }
            }
        });
    });
});
