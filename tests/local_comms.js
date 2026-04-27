"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const Database = require("../lib/common/local_comms.js");

test.describe("local_comms", { concurrency: false }, () => {
    test("cleanShareDB falls back to daemon body when err cannot be stringified", async () => {
        const original = {
            coinFuncs: global.coinFuncs,
            config: global.config,
            consoleError: console.error,
            setTimeout: global.setTimeout,
            support: global.support
        };
        const db = new Database();
        const circularErr = {};
        const errors = [];
        let headerAttempts = 0;
        circularErr.self = circularErr;

        db.getOldestLockedBlockHeight = function getOldestLockedBlockHeight() { return 42; };
        global.config = {
            general: { adminEmail: "ops@example.com" },
            pplns: { shareMulti: 2 }
        };
        global.support = { sendEmail() {} };
        global.coinFuncs = {
            getBlockHeaderByID(_height, callback) {
                headerAttempts += 1;
                callback(circularErr, "daemon body fallback");
            }
        };
        console.error = function captureError(message) {
            errors.push(String(message));
        };
        global.setTimeout = function immediateTimeout(fn) {
            setImmediate(fn);
            return { unref() {} };
        };

        try {
            const result = await new Promise((resolve) => {
                db.cleanShareDB(function onDone(error) {
                    resolve(error);
                });
            });

            assert.equal(result instanceof Error, true);
            assert.equal(headerAttempts, 3);
            assert.equal(errors.filter((entry) => entry.includes("daemon body fallback")).length, 3);
            assert.equal(errors.some((entry) => entry.includes("unknown error")), false);
        } finally {
            global.coinFuncs = original.coinFuncs;
            global.config = original.config;
            global.support = original.support;
            global.setTimeout = original.setTimeout;
            console.error = original.consoleError;
        }
    });
});
