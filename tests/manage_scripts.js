"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const accountUtils = require("../script_account_utils.js");
const moveBalance = require("../user_scripts/user_balance_move_common.js");
const unblockCatalog = require("../manage_scripts/exchange_recovery_help.js");
const unblockDeposit = require("../manage_scripts/exchange_recovery_deposit_clear.js");
const unblockWallet = require("../manage_scripts/exchange_recovery_wallet_clear.js");
const cacheFindUnused = require("../manage_scripts/cache_unused_find.js");
const fixHighBridgeCredit = require("../manage_scripts/exchange_recovery_bridge_credit_fix.js");
const fixLowXmrCredit = require("../manage_scripts/exchange_recovery_low_xmr_credit_fix.js");
const fixExchangeXmrBalance = require("../manage_scripts/exchange_recovery_xmr_balance_fix.js");
const runUserDelete = require("../manage_scripts/user_delete_common.js");
const INIT_MINI_PATH = require.resolve("../init_mini.js");

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
    test("altblock_exchange unblock helpers use canonical exports", function testUnblockExports() {
        assert.equal(typeof unblockCatalog.main, "function");
        assert.ok(unblockCatalog.HELP.some(function hasDepositCommand(line) {
            return line.includes("exchange_recovery_deposit_clear.js --port <port> --clear --confirm-reviewed-deposit=true");
        }));
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
                                throw new Error("unexpected read: " + fileName);
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
});
