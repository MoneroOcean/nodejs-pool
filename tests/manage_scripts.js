"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const accountUtils = require("../script_account_utils.js");
const moveBalance = require("../user_scripts/user_balance_move_common.js");
const insertBan = require("../user_scripts/user_ban_common.js");
const unblockCatalog = require("../manage_scripts/exchange_recovery_help.js");
const cacheFindUnused = require("../manage_scripts/cache_unused_find.js");
const fixHighBridgeCredit = require("../manage_scripts/exchange_recovery_bridge_credit_fix.js");
const fixLowXmrCredit = require("../manage_scripts/exchange_recovery_low_xmr_credit_fix.js");
const fixExchangeXmrBalance = require("../manage_scripts/exchange_recovery_xmr_balance_fix.js");
const runUserDelete = require("../manage_scripts/user_delete_common.js");
const INIT_MINI_PATH = require.resolve("../init_mini.js");
const LIB2_COINS_PATH = path.join(__dirname, "..", "lib2", "coins.js");
const HAS_LIB2_COINS = fs.existsSync(LIB2_COINS_PATH);

function captureConsole(method, fn) {
    const original = console[method];
    const output = [];
    console[method] = function captureLine(line) {
        output.push(line);
    };
    try {
        fn(output);
    } finally {
        console[method] = original;
    }
    return output;
}

async function withCapturedConsole(fn) {
    const originals = {
        error: console.error,
        log: console.log
    };
    console.error = function noop() {};
    console.log = function noop() {};
    try {
        return await fn();
    } finally {
        console.error = originals.error;
        console.log = originals.log;
    }
}

function withExitTrap(fn) {
    const originalExit = process.exit;
    process.exit = function trapExit(code) {
        const error = new Error("process.exit");
        error.code = code;
        throw error;
    };
    return Promise.resolve().then(fn).finally(function restoreExit() {
        process.exit = originalExit;
    });
}

function runFixDaemonForTest(args, response, waitResponse = response) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fix-daemon-test-"));
    const bin = path.join(root, "bin");
    const callsPath = path.join(root, "calls");
    const curlCallsPath = path.join(root, "curl-calls");
    fs.mkdirSync(bin);
    const writeExecutable = (name, source) => {
        const filePath = path.join(bin, name);
        fs.writeFileSync(filePath, `${source}\n`, { mode: 0o755 });
        return filePath;
    };
    writeExecutable("systemctl", `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$FIX_DAEMON_TEST_CALLS"
case "\${1:-}" in
  cat|is-enabled) exit 0 ;;
  is-active) exit 1 ;;
  *) exit 0 ;;
esac`);
    writeExecutable("sudo", `#!/bin/sh
if [ "\${1:-}" = "-n" ]; then shift; fi
exec "$@"`);
    writeExecutable("curl", `#!/bin/sh
count=0
if [ -f "$FIX_DAEMON_TEST_CURL_CALLS" ]; then count="$(cat "$FIX_DAEMON_TEST_CURL_CALLS")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FIX_DAEMON_TEST_CURL_CALLS"
case "$*" in
  *18146*) printf '%s\\n' '{"result":{}}' ;;
  *) if [ "$count" -eq 1 ]; then printf '%s\\n' "$FIX_DAEMON_TEST_RESPONSE"; else printf '%s\\n' "$FIX_DAEMON_TEST_WAIT_RESPONSE"; fi ;;
esac`);
    writeExecutable("logger", "#!/bin/sh\nexit 0");
    const result = spawnSync(path.join(__dirname, "..", "fix_daemon.sh"), args, {
        encoding: "utf8",
        env: {
            ...process.env,
            FIX_DAEMON_LOCK: path.join(root, "lock"),
            FIX_DAEMON_TEST_CALLS: callsPath,
            FIX_DAEMON_TEST_CURL_CALLS: curlCallsPath,
            FIX_DAEMON_TEST_RESPONSE: response,
            FIX_DAEMON_TEST_WAIT_RESPONSE: waitResponse,
            PATH: `${bin}:${process.env.PATH}`
        }
    });
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "";
    fs.rmSync(root, { recursive: true, force: true });
    return { ...result, calls };
}

function installAccountGlobals(options) {
    const opts = options || {};
    const originalGlobals = {
        config: global.config,
        database: global.database,
        mysql: global.mysql,
        support: global.support
    };
    const rows = opts.rows || {};
    const cache = new Set(opts.cacheKeys || []);
    const queries = [];
    global.config = { payout: { walletMin: 0.003 } };
    global.support = {
        // 1e12 mirrors the real support module's config.coin.sigDigits (XMR atomic units per coin).
        coinToDecimal(value) {
            return Number(value) / 1000000000000;
        },
        decimalToCoin(value) {
            return Math.round(Number(value) * 1000000000000);
        },
        formatDateFromSQL() {
            return 0;
        }
    };
    global.database = {
        cacheDB: {},
        env: {
            beginTxn() {
                return {
                    commit() {},
                    del(_db, key) {
                        cache.delete(key);
                    }
                };
            }
        },
        getCache(key) {
            return cache.has(key) ? {} : false;
        }
    };
    global.mysql = {
        query(sql, params) {
            queries.push({ sql, params });
            if (sql === "SELECT * FROM users WHERE username = ?") return Promise.resolve(rows.users || []);
            if (sql.indexOf("SELECT * FROM balance WHERE ") === 0) {
                const address = params[0];
                return Promise.resolve((rows.balance || []).filter(function match(row) {
                    if (row.payment_address !== address) return false;
                    if (params.length > 1) return row.payment_id === params[1];
                    return row.payment_id === null || row.payment_id === "";
                }));
            }
            if (sql.indexOf("SELECT * FROM payments WHERE ") === 0) return Promise.resolve(rows.payments || []);
            if (sql.indexOf("SELECT * FROM `block_balance` WHERE ") === 0) return Promise.resolve(rows.block_balance || []);
            return Promise.resolve({ affectedRows: 1 });
        }
    };
    return {
        queries,
        restore() {
            Object.entries(originalGlobals).forEach(function restore(entry) {
                if (typeof entry[1] === "undefined") delete global[entry[0]];
                else global[entry[0]] = entry[1];
            });
        }
    };
}

test.describe("manage_scripts", { concurrency: false }, function suite() {
    test("CLI parser preserves positional arrays and rejects reserved option names", function testCliMetadata() {
        const parseArgv = require("../parse_args.js");
        assert.deepEqual(parseArgv(["--depth", "10", "--", "block"], { "--": true }), {
            _: [], "--": ["block"], depth: "10"
        });
        assert.deepEqual(parseArgv(["--clear"]), { _: [], clear: true });
        assert.throws(() => parseArgv(["--_=value"]), /Reserved option name/);
    });

    test("share dumps release readers when decoding fails", function testShareDumpCleanup() {
        const dumpShares = require("../manage_scripts/share_dump_common.js");
        const originals = { database: global.database, coinFuncs: global.coinFuncs, protos: global.protos };
        const events = [];
        global.coinFuncs = { getLastBlockHeader(callback) { callback(null, { height: 1 }); } };
        global.database = {
            env: { beginTxn() { return { abort() { events.push("abort"); } }; } },
            lmdb: { Cursor: class {
                goToRange(key) { return key; }
                getCurrentBinary(iterator) { iterator(2, {}); }
                close() { events.push("close"); }
            } }
        };
        global.protos = { Share: { decode() { throw new Error("decode failed"); } } };
        try {
            assert.throws(() => dumpShares(1, () => true), /decode failed/);
            assert.deepEqual(events, ["close", "abort"]);
        } finally {
            Object.assign(global, originals);
        }
    });

    test("altblock edits close the cursor before committing or aborting", function testAltblockEditCleanup() {
        const updateAltBlocks = require("../manage_scripts/altblock_update_common.js");
        const originalDatabase = global.database;
        const originalProtos = global.protos;
        for (const fail of [false, true]) {
            const events = [];
            global.database = {
                env: { beginTxn() { return {
                    putBinary() { events.push("write"); },
                    commit() { events.push("commit"); },
                    abort() { events.push("abort"); }
                }; } },
                lmdb: { Cursor: class {
                    goToFirst() { return 0; }
                    goToNext() { return null; }
                    getCurrentBinary(iterator) { iterator(0, {}); }
                    close() { events.push("close"); }
                } }
            };
            global.protos = { AltBlock: { decode() { return { hash: "block" }; }, encode(block) { return block; } } };
            try {
                captureConsole("log", () => {
                    const run = () => updateAltBlocks(["block"], () => {
                        if (fail) throw new Error("mutation failed");
                    });
                    if (fail) assert.throws(run, /mutation failed/);
                    else assert.equal(run(), 1);
                });
                assert.deepEqual(events, fail ? ["close", "abort"] : ["write", "close", "commit"]);
            } finally {
                global.database = originalDatabase;
                global.protos = originalProtos;
            }
        }
    });

    test("CLI iterators include key zero and release readers on failures", function testCliReaderCleanup() {
        const cli = require("../script_utils.js")();
        const originalDatabase = global.database;
        for (const failure of [null, "construct", "iterate", "close"]) {
            const events = [];
            global.database = {
                env: { beginTxn() { return { abort() { events.push("abort"); } }; } },
                lmdb: { Cursor: class {
                    constructor() { if (failure === "construct") throw new Error(failure); }
                    goToFirst() { return 0; }
                    goToNext() { return null; }
                    getCurrentBinary(iterator) { iterator(0, "data"); }
                    close() {
                        events.push("close");
                        if (failure === "close") throw new Error(failure);
                    }
                } }
            };
            try {
                const run = () => cli.forEachBinaryEntry({}, (key, value) => {
                    assert.equal(key, 0);
                    assert.equal(value, "data");
                    events.push("entry");
                    if (failure === "iterate") throw new Error(failure);
                });
                if (failure) assert.throws(run, new RegExp(failure));
                else run();
                assert.deepEqual(events, failure === "construct" ? ["abort"] : ["entry", "close", "abort"]);
            } finally {
                global.database = originalDatabase;
            }
        }
    });

    test("cache deletion aborts its transaction on failure", function testCacheDeleteCleanup() {
        const originalDatabase = global.database;
        const events = [];
        global.database = {
            env: { beginTxn() { return {
                del() { throw new Error("delete failed"); },
                commit() { events.push("commit"); },
                abort() { events.push("abort"); }
            }; } },
            getCache() { return {}; }
        };
        try {
            assert.throws(() => accountUtils.deleteCacheKeys("user"), /delete failed/);
            assert.deepEqual(events, ["abort"]);
        } finally {
            global.database = originalDatabase;
        }
    });

    test("altblock_exchange unblock catalog lists canonical commands", function testUnblockCatalog() {
        assert.equal(typeof unblockCatalog.main, "function");
        assert.ok(unblockCatalog.HELP.some(function hasDepositCommand(line) {
            return line.includes("exchange_recovery_deposit_clear.js --port <port> --clear --confirm-reviewed-deposit=true");
        }));
    });

    test("lib2-dependent altblock_exchange unblock helpers use canonical exports", function testUnblockExports(t) {
        if (!HAS_LIB2_COINS) {
            t.skip("lib2-dependent recovery helper scripts require lib2/coins.js");
            return;
        }
        const unblockDeposit = require("../manage_scripts/exchange_recovery_deposit_clear.js");
        const unblockWallet = require("../manage_scripts/exchange_recovery_wallet_clear.js");
        assert.equal(typeof unblockDeposit.summarizeEntry, "function");
        assert.equal(typeof unblockWallet.summarizeEntry, "function");
    });

    test("cache unused scanner keeps current altblock_exchange recovery keys", function testCurrentExchangeCacheKeys() {
        assert.equal(cacheFindUnused.EXACT_ACTIVE_KEYS.has("altblock_exchange_trade"), true);
        assert.equal(cacheFindUnused.EXACT_ACTIVE_KEYS.has("altblock_exchange_wallet"), true);
        assert.equal(cacheFindUnused.EXACT_ACTIVE_KEYS.has("altblock_exchange_deposit"), true);
    });

    test("account utils build parameterized payment clauses", function testPaymentWhere() {
        assert.deepEqual(accountUtils.paymentWhere({ address: "addr", paymentId: "pid" }, false), {
            clause: "payment_address = ? AND payment_id = ?",
            params: ["addr", "pid"]
        });
        assert.deepEqual(accountUtils.paymentWhere({ address: "addr", paymentId: null }, true), {
            clause: "payment_address = ? AND (payment_id IS NULL OR payment_id = '')",
            params: ["addr"]
        });
    });

    test("account utils reject malformed user strings", function testSplitUserValidation() {
        assert.throws(function onMalformedUser() {
            accountUtils.splitUser("addr.pid.extra");
        }, /address>\.<paymentId>/);
        assert.throws(function onEmptyPaymentId() {
            accountUtils.splitUser("addr.");
        }, /address>\.<paymentId>/);
    });

    test("manual bans discard a later reason for an existing mining address", async function testDuplicateBan() {
        const originalMysql = global.mysql;
        const address = "wallet-address";
        const bans = [];
        const calls = [];
        global.mysql = {
            query(sql, params) {
                calls.push({ sql, params });
                const duplicate = bans.some(function hasAddress(row) {
                    return row.mining_address === params[0];
                });
                if (!duplicate) bans.push({ mining_address: params[0], reason: params[1] });
                return Promise.resolve({ affectedRows: duplicate ? 0 : 1 });
            }
        };

        try {
            await insertBan(address, "first reason");
            await insertBan(address, "later reason");
            assert.deepEqual(bans, [{ mining_address: address, reason: "first reason" }]);
            assert.equal(calls.length, 2);
            assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE id=id$/);
            assert.deepEqual(calls[1].params, [address, "later reason"]);
        } finally {
            if (typeof originalMysql === "undefined") delete global.mysql;
            else global.mysql = originalMysql;
        }
    });

    test("refactored trade-context fix aligns XMR baseline to the current exchange balance", function testTradeContextFix() {
        const plan = fixExchangeXmrBalance.buildTradeContextFix({
            blockId: 12,
            exchange: "nonkyc",
            stage: "Exchange XMR trade",
            baselineBalances: { XMR: 4.5 },
            expectedIncreases: { XMR: 0.75 }
        }, 0, { activeOrders: false });

        assert.equal(plan.cacheKey, "altblock_exchange_trade");
        assert.equal(plan.nextValue.baselineBalances.XMR, -0.75);
        assert.equal(plan.nextValue.expectedIncreases.XMR, 0.75);
    });

    test("refactored trade-context fix refuses non-XMR trade stages", function testWrongStage() {
        assert.throws(function onWrongStage() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange BTC trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 0, { activeOrders: false });
        }, /Exchange XMR trade stage/);
    });

    test("refactored trade-context fix refuses while exchange orders are still active", function testActiveOrders() {
        assert.throws(function onActiveOrders() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 0, { activeOrders: true });
        }, /active exchange orders/);
    });

    test("refactored trade-context fix refuses balances above the stored baseline", function testHigherBalance() {
        assert.throws(function onHigherBalance() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 1.2, { activeOrders: false });
        }, /above stored baseline/);
    });

    test("refactored trade-context fix requires confirmation when balance matches stored baseline", function testSameBalanceNeedsConfirmation() {
        assert.throws(function onSameBalance() {
            fixExchangeXmrBalance.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 0 },
                expectedIncreases: { XMR: 0.5 }
            }, 0, { activeOrders: false });
        }, /confirm-manual-withdrawal/);
    });

    test("refactored trade-context fix allows confirmed zero-balance withdrawal recovery", function testConfirmedSameBalance() {
        const plan = fixExchangeXmrBalance.buildTradeContextFix({
            stage: "Exchange XMR trade",
            baselineBalances: { XMR: 0 },
            expectedIncreases: { XMR: 0.5 }
        }, 0, {
            activeOrders: false,
            manualWithdrawalConfirmed: true
        });

        assert.equal(plan.nextValue.baselineBalances.XMR, -0.5);
    });

    test("bridge-credit fix aligns expected bridge increase to the reviewed credited balance", function testBridgeCreditFix() {
        const plan = fixHighBridgeCredit.buildTradeContextFix({
            blockId: 12,
            exchange: "nonkyc",
            stage: "Exchange USDT trade",
            baselineBalances: { USDT: 1.5 },
            expectedIncreases: { USDT: 10 }
        }, 18.75, {
            activeOrders: false,
            reviewedCredit: true
        });

        assert.equal(plan.cacheKey, "altblock_exchange_trade");
        assert.equal(plan.nextValue.expectedIncreases.USDT, 17.25);
    });

    test("bridge-credit fix refuses to rewrite while exchange orders are still active", function testBridgeCreditActiveOrders() {
        assert.throws(function onActiveOrders() {
            fixHighBridgeCredit.buildTradeContextFix({
                stage: "Exchange BTC trade",
                baselineBalances: { BTC: 0.1 },
                expectedIncreases: { BTC: 0.2 }
            }, 0.4, {
                activeOrders: true,
                reviewedCredit: true
            });
        }, /active exchange orders/);
    });

    test("bridge-credit fix requires explicit operator confirmation", function testBridgeCreditConfirmation() {
        assert.throws(function onMissingConfirmation() {
            fixHighBridgeCredit.buildTradeContextFix({
                stage: "Exchange BTC trade",
                baselineBalances: { BTC: 0.1 },
                expectedIncreases: { BTC: 0.2 }
            }, 0.4, {
                activeOrders: false
            });
        }, /confirm-reviewed-credit/);
    });

    test("low XMR credit fix aligns expected XMR increase to the observed credited balance", function testLowXmrCreditFix() {
        const plan = fixLowXmrCredit.buildTradeContextFix({
            blockId: 12,
            exchange: "nonkyc",
            stage: "Exchange XMR trade",
            baselineBalances: { XMR: 3.4218 },
            expectedIncreases: { XMR: 0.003857 }
        }, 3.4248, {
            activeOrders: false,
            reviewedCredit: true
        });

        assert.equal(plan.cacheKey, "altblock_exchange_trade");
        assert.equal(plan.nextValue.expectedIncreases.XMR, 0.003);
        assert.equal(plan.nextValue.baselineBalances.XMR, 3.4218);
    });

    test("low XMR credit fix refuses while exchange orders are still active", function testLowXmrCreditActiveOrders() {
        assert.throws(function onActiveOrders() {
            fixLowXmrCredit.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 1.2, {
                activeOrders: true,
                reviewedCredit: true
            });
        }, /active exchange orders/);
    });

    test("low XMR credit fix requires explicit operator confirmation", function testLowXmrCreditConfirmation() {
        assert.throws(function onMissingConfirmation() {
            fixLowXmrCredit.buildTradeContextFix({
                stage: "Exchange XMR trade",
                baselineBalances: { XMR: 1 },
                expectedIncreases: { XMR: 0.5 }
            }, 1.2, {
                activeOrders: false
            });
        }, /confirm-reviewed-credit/);
    });

    test("low XMR credit fix preview formats from/to on separate lines", function testLowXmrCreditPreview() {
        const preview = fixLowXmrCredit.formatFixPlanPreview({
            cacheKey: "altblock_exchange_trade",
            currentValue: { expectedIncreases: { XMR: 0.003857 } },
            nextValue: { expectedIncreases: { XMR: 0.003 } },
            summary: "rewrote expected XMR increase from 0.00385700 to 0.00300000"
        });

        assert.match(preview, /^In 10 seconds is going to change altblock_exchange_trade\nFrom:\n/s);
        assert.match(preview, /\nTo:\n/s);
        assert.match(preview, /\nSummary: rewrote expected XMR increase from 0\.00385700 to 0\.00300000$/);
    });

    test("bridge-credit fix preview formats from/to on separate lines", function testBridgeCreditPreview() {
        const preview = fixHighBridgeCredit.formatFixPlanPreview({
            cacheKey: "altblock_exchange_trade",
            currentValue: { expectedIncreases: { USDT: 10 } },
            nextValue: { expectedIncreases: { USDT: 17.25 } },
            summary: "updated expected USDT bridge credit to 17.25000000"
        });

        assert.match(preview, /^In 10 seconds is going to change altblock_exchange_trade\nFrom:\n/s);
        assert.match(preview, /\nTo:\n/s);
        assert.match(preview, /\nSummary: updated expected USDT bridge credit to 17\.25000000$/);
    });

    test("negative XMR balance fix preview formats from/to on separate lines", function testNegativeXmrBalancePreview() {
        const preview = fixExchangeXmrBalance.formatFixPlanPreview({
            cacheKey: "altblock_exchange_trade",
            currentValue: { baselineBalances: { XMR: 4.5 } },
            nextValue: { baselineBalances: { XMR: -0.75 } },
            summary: "refactored altblock_exchange_trade path with current XMR balance 0.00000000"
        });

        assert.match(preview, /^In 10 seconds is going to change altblock_exchange_trade\nFrom:\n/s);
        assert.match(preview, /\nTo:\n/s);
        assert.match(preview, /\nSummary: refactored altblock_exchange_trade path with current XMR balance 0\.00000000$/);
    });

    test("account utils logUser prints explicit empty payment id", function testLogUserFormatting() {
        const output = captureConsole("log", function runLog() {
            accountUtils.logUser("Target ", {
                address: "wallet-address",
                paymentId: null
            });
        });

        assert.deepEqual(output, [
            "Target Address: wallet-address",
            "Target Payment ID: (none)"
        ]);
    });

    test("account utils logCacheKeys labels existing LMDB cache keys", function testLogCacheKeysFormatting() {
        const originalDatabase = global.database;
        global.database = {
            getCache(key) {
                return key === "stats:wallet-address" ? { some: "value" } : false;
            }
        };

        try {
            const output = captureConsole("log", function runLog() {
                accountUtils.logCacheKeys("wallet-address");
            });
            assert.deepEqual(output, [
                "Existing LMDB cache key: stats:wallet-address"
            ]);
        } finally {
            if (typeof originalDatabase === "undefined") delete global.database;
            else global.database = originalDatabase;
        }
    });

    test("force user delete plan includes block_balance rows after confirmation path", async function testForceDeletePlan() {
        const globals = installAccountGlobals({
            rows: {
                users: [{ username: "addr" }],
                balance: [{ payment_address: "addr", payment_id: null, amount: 5000000000000 }],
                payments: [{ payment_address: "addr", payment_id: null }],
                block_balance: [{ payment_address: "addr", payment_id: null }]
            },
            cacheKeys: ["stats:addr"]
        });
        try {
            const plan = await withCapturedConsole(function runPlan() {
                return runUserDelete.buildUserDeletePlan("addr", {
                    extraTables: ["block_balance"],
                    force: true
                });
            });
            assert.equal(plan.userRows.length, 1);
            assert.equal(plan.balanceRows.length, 1);
            assert.equal(plan.paymentRows.length, 1);
            assert.equal(plan.extraRows[0].name, "block_balance");
            assert.equal(plan.extraRows[0].rows.length, 1);
        } finally {
            globals.restore();
        }
    });

    test("force balance move refuses source rows reserved by payment batch", async function testForceMovePendingBatch() {
        const globals = installAccountGlobals({
            rows: {
                balance: [
                    { payment_address: "old", payment_id: null, amount: 1, last_edited: "2026-01-01 00:00:00", pending_batch_id: 7 },
                    { payment_address: "new", payment_id: null, amount: 2, last_edited: "2026-01-01 00:00:00", pending_batch_id: null }
                ]
            }
        });
        try {
            await withCapturedConsole(function runCaptured() {
                return assert.rejects(
                    withExitTrap(function runPlan() {
                        return moveBalance.buildBalanceMovePlan("old", "new", { force: true });
                    }),
                    function matchExit(error) {
                        return error && error.message === "process.exit" && error.code === 1;
                    }
                );
            });
        } finally {
            globals.restore();
        }
    });

    test("non-force balance move refuses source rows reserved by payment batch", async function testNonForceMovePendingBatch() {
        const globals = installAccountGlobals({
            rows: {
                balance: [
                    { payment_address: "old", payment_id: null, amount: 1, last_edited: "2026-01-01 00:00:00", pending_batch_id: 7 },
                    { payment_address: "new", payment_id: null, amount: 2, last_edited: "2026-01-01 00:00:00", pending_batch_id: null }
                ]
            }
        });
        try {
            await withCapturedConsole(function runCaptured() {
                return assert.rejects(
                    withExitTrap(function runPlan() {
                        return moveBalance.buildBalanceMovePlan("old", "new", {});
                    }),
                    function matchExit(error) {
                        return error && error.message === "process.exit" && error.code === 1;
                    }
                );
            });
        } finally {
            globals.restore();
        }
    });

    test("user delete refuses a balance row reserved by a payment batch", async function testUserDeletePendingBatch() {
        const globals = installAccountGlobals({
            rows: {
                users: [{ username: "addr" }],
                balance: [{ payment_address: "addr", payment_id: null, amount: 1, last_edited: "2026-01-01 00:00:00", pending_batch_id: 7 }],
                payments: []
            }
        });
        try {
            await withCapturedConsole(function runCaptured() {
                return assert.rejects(
                    withExitTrap(function runPlan() {
                        return runUserDelete.buildUserDeletePlan("addr", { force: true });
                    }),
                    function matchExit(error) {
                        return error && error.message === "process.exit" && error.code === 1;
                    }
                );
            });
        } finally {
            globals.restore();
        }
    });

    test("init_mini resolves repo files independently of cwd", async function testInitMiniPaths() {
        const originalLoad = Module._load;
        const originalCwd = process.cwd();
        const originalGlobals = {
            support: global.support,
            config: global.config,
            mysql: global.mysql,
            protos: global.protos,
            coinFuncs: global.coinFuncs,
            database: global.database
        };
        const repoRoot = path.resolve(__dirname, "..");
        const configPath = path.join(repoRoot, "config.json");
        const coinConfigPath = path.join(repoRoot, "coinConfig.json");
        const dataProtoPath = path.join(repoRoot, "lib/common/data.proto");
        const readPaths = [];

        delete require.cache[INIT_MINI_PATH];
        try {
            process.chdir(os.tmpdir());
            Module._load = function mockLoad(request, parent, isMain) {
                if (parent && parent.filename === INIT_MINI_PATH) {
                    if (request === "fs") {
                        return {
                            readFileSync(fileName) {
                                readPaths.push(fileName);
                                if (fileName === configPath) return JSON.stringify({ mysql: {}, coin: "test" });
                                if (fileName === coinConfigPath) return JSON.stringify({ test: { funcFile: "./fake_coin.js" } });
                                if (fileName === dataProtoPath) return "message Test {}";
                                throw new Error(`unexpected read: ${  fileName}`);
                            }
                        };
                    }
                    if (request === "promise-mysql") {
                        return {
                            createPool() {
                                return {
                                    query() {
                                        return Promise.resolve([]);
                                    }
                                };
                            }
                        };
                    }
                    if (request === "protocol-buffers") {
                        return function mockProto() { return {}; };
                    }
                    if (request === "./lib/common/config_rows.js") {
                        return function applyConfigRows() {};
                    }
                    if (request === "./lib/common/support.js") {
                        return function createSupport() { return {}; };
                    }
                    if (request === "./lib/common/local_comms") {
                        return function LocalComms() {
                            this.initEnv = function initEnv() {};
                        };
                    }
                    if (request === "./fake_coin.js") {
                        return function FakeCoin() {};
                    }
                }
                return originalLoad(request, parent, isMain);
            };

            const initMini = require(INIT_MINI_PATH);
            await new Promise(function runInit(resolve, reject) {
                const timeout = setTimeout(function onTimeout() {
                    reject(new Error("init_mini test timed out"));
                }, 1000);
                initMini.init(function onReady() {
                    clearTimeout(timeout);
                    resolve();
                });
            });

            assert.deepEqual(readPaths, [configPath, coinConfigPath, dataProtoPath]);
        } finally {
            Module._load = originalLoad;
            delete require.cache[INIT_MINI_PATH];
            process.chdir(originalCwd);
            for (const [key, value] of Object.entries(originalGlobals)) {
                if (typeof value === "undefined") delete global[key];
                else global[key] = value;
            }
        }
    });

    test("init delays a non-zero exit after startup failure", function testInitStartupFailureExit() {
        const source = fs.readFileSync(path.join(__dirname, "..", "init.js"), "utf8");
        assert.match(source, /STARTUP_FAILURE_RESTART_DELAY_MS = 60 \* 1000/);
        assert.match(source, /\.catch\(function onStartupError\(error\)/);
        assert.match(source, /setTimeout\(function exitAfterStartupFailure\(\) \{\s*process\.exit\(1\);/);
        assert.doesNotMatch(source, /exitAfterStartupFailure[\s\S]{0,120}\.unref\(\)/);
    });

    test("daemon recovery never leaves xtm_mm explicitly stopped", function testXtmMmRecovery() {
        const source = fs.readFileSync(path.join(__dirname, "..", "fix_daemon.sh"), "utf8");
        assert.doesNotMatch(source, /run_optional_service stop xtm_mm\.service/);
        assert.doesNotMatch(source, /systemctl(?:_cmd)? stop xtm_mm\.service/);
        assert.match(source, /restart_xtm_mm_service\(\) \{\s*run_optional_service restart xtm_mm\.service/);
        assert.equal(source.match(/^\s*restart_xtm_mm_service$/gm).length, 3);
    });

    test("daemon recovery preserves a healthy direct monerod", function testHealthyMonerodGuard() {
        const healthy = JSON.stringify({
            jsonrpc: "2.0",
            result: { status: "OK", synchronized: true, busy_syncing: false, height: 123 }
        });
        for (const args of [
            ["proxy-unhealthy", "--expected-xmr-height", "123"],
            ["template-stuck", "--expected-xmr-height", "123"],
            ["xmr-lag", "--expected-xmr-height", "123"]
        ]) {
            const result = runFixDaemonForTest(args, healthy);
            assert.equal(result.status, 0, result.stderr);
            assert.doesNotMatch(result.calls, /systemctl restart monero\.service/);
        }

        const missingExpected = runFixDaemonForTest(["xmr-lag"], healthy);
        assert.equal(missingExpected.status, 0, missingExpected.stderr);
        assert.match(missingExpected.calls, /systemctl restart monero\.service/);

        const unhealthy = runFixDaemonForTest(
            ["proxy-unhealthy", "--expected-xmr-height", "123"],
            JSON.stringify({
                jsonrpc: "2.0",
                result: { status: "OK", synchronized: false, busy_syncing: true, height: 123 }
            })
        );
        assert.equal(unhealthy.status, 0, unhealthy.stderr);
        assert.match(unhealthy.calls, /systemctl restart monero\.service/);

        const malformed = runFixDaemonForTest(
            ["proxy-unhealthy", "--expected-xmr-height", "123"],
            "not-json",
            healthy
        );
        assert.equal(malformed.status, 0, malformed.stderr);
        assert.match(malformed.calls, /systemctl restart monero\.service/);
        const malformedWithoutHeight = runFixDaemonForTest(["proxy-unhealthy"], "not-json", healthy);
        assert.equal(malformedWithoutHeight.status, 0, malformedWithoutHeight.stderr);
        assert.match(malformedWithoutHeight.calls, /systemctl restart monero\.service/);
    });

    test("leaf deployment opens public pool ports as TCP only", function testLeafPoolProtocols() {
        const script = fs.readFileSync(path.join(__dirname, "..", "deployment", "leaf.bash"), "utf8");
        assert.ok(script.includes('ufw allow "$rule/tcp"'));
        assert.ok(!script.includes('ufw allow "$rule"\n'));
    });
});
