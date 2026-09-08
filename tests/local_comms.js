"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const Database = require("../lib/common/local_comms.js");

test.describe("local_comms", { concurrency: false }, () => {
    test("cleanup rejects missing difficulty before opening a database scan and can retry", async () => {
        const original = { coinFuncs: global.coinFuncs, config: global.config, error: console.error };
        const db = new Database();
        db.getOldestLockedBlockHeight = () => null;
        global.config = { general: {}, pplns: { shareMulti: 2 } };
        console.error = () => {};
        let calls = 0;
        global.coinFuncs = { getLastBlockHeader(callback) {
            calls += 1;
            callback(null, { height: 42 });
        } };
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const error = await new Promise(resolve => db.cleanShareDB(resolve));
                assert.match(error.message, /Invalid current block difficulty/);
            }
            assert.equal(calls, 2);
        } finally {
            global.coinFuncs = original.coinFuncs;
            global.config = original.config;
            console.error = original.error;
        }
    });

    test("cleanup warning explains the retained payout safety window", async () => {
        const original = {
            coinFuncs: global.coinFuncs,
            config: global.config,
            support: global.support
        };
        const db = new Database();
        db.getOldestLockedBlockHeight = () => 100;
        db.env = {
            beginTxn() {
                return { abort() {} };
            }
        };
        db.shareDB = {};
        db.lmdb = {
            Cursor: class EmptyCursor {
                goToRange() { return null; }
                close() {}
            }
        };
        const emails = [];
        const templates = [];
        global.config = {
            general: {
                adminEmail: "ops@example.com",
                blockCleanWarning: 10,
                blockCleaner: false
            },
            pplns: { shareMulti: 2 }
        };
        global.support = {
            renderEmailTemplate(item, values, fallback) {
                templates.push({ item, values, fallback });
                return String(fallback).replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
                    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
                });
            },
            sendEmail(...args) {
                emails.push(args);
            }
        };
        global.coinFuncs = {
            getBlockHeaderByID(_height, callback) {
                callback(null, { difficulty: 5 });
            },
            getLastBlockHeader(callback) {
                callback(null, { height: 125, difficulty: 5 });
            }
        };

        try {
            const result = await new Promise(resolve => db.cleanShareDB(resolve));
            assert.equal(result, null);
            assert.equal(emails.length, 1);
            assert.equal(emails[0][1], "long_runner share history retention warning");
            assert.match(emails[0][2], /retaining share history spanning 25 block heights/);
            assert.match(emails[0][2], /Oldest locked height: 100/);
            assert.match(emails[0][2], /current height: 125/);
            const bodyTemplate = templates.find(template => template.item === "longRunnerCleanBody");
            assert.deepEqual(bodyTemplate && bodyTemplate.values, {
                blocks: 25,
                oldest_locked_height: 100,
                current_height: 125
            });
        } finally {
            global.coinFuncs = original.coinFuncs;
            global.config = original.config;
            global.support = original.support;
        }
    });

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
