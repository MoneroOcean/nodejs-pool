"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const createConstants = require("../../../lib/coins/constants.js");
const Coin = require("../../../lib/coins/index.js");
const helpers = require("../../../lib/coins/helpers.js");
const createPoolState = require("../../../lib/pool/state.js");
const createProtocolHandler = require("../../../lib/pool/protocol.js");
const createServerFactory = require("../../../lib/pool/servers.js");
const createTemplateManager = require("../../../lib/pool/templates.js");
const createShareProcessor = require("../../../lib/pool/shares.js");

function clearObject(target) {
    for (const key of Object.keys(target)) delete target[key];
}

async function captureConsole(run) {
    const originalError = console.error;
    const output = [];
    console.error = function captureError() {
        output.push(Array.from(arguments).join(" "));
    };
    try {
        await run();
    } finally {
        console.error = originalError;
    }
    return output;
}

test.describe("pool components: core", { concurrency: false }, () => {
test("xmr constants derive the expected coin and algo metadata", () => {
    const constants = createConstants({
        get_merged_mining_nonce_size() {
            return 4;
        }
    });

    assert.equal(constants.coin2port.XTM, 18144);
    assert.equal(constants.port2coin["18081"], "");
    assert.equal(constants.port2algo["8766"], "kawpow");
    assert.equal(constants.port2blob_num["18148"], 107);
    assert.equal(constants.pool_nonce_size, 17);
    assert.equal(constants.mm_nonce_size, 4);
    assert.equal(constants.extra_nonce_template_hex.length, 2 + 2 + constants.pool_nonce_size * 2);
    assert.equal(constants.extra_nonce_mm_template_hex.length, 2 + 2 + (constants.pool_nonce_size + constants.mm_nonce_size) * 2);
    assert.equal(constants.all_algos["rx/0"], 1);
    assert.equal(constants.all_algos.kawpow, 1);
});

test("xmr helpers keep bigint conversions stable and calculate rewards", () => {
    const value = BigInt("0x1234567890abcdef");
    const littleEndian = helpers.toBuffer(value, { endian: "little", size: 8 });

    assert.equal(helpers.fromBuffer(littleEndian, { endian: "little" }), value);
    assert.equal(helpers.toBigInt("1234"), 1234n);
    assert.equal(helpers.toBigInt("abcd", 16), 0xabcdn);
    assert.deepEqual(helpers.arr2hex({ data: [1, 16, 255] }), { data: "0110ff" });

    const ethReward = helpers.calcEthReward({
        transactions: [{ hash: "tx-a", gasPrice: "10" }],
        uncles: [],
        gasUsed: "2",
        baseFeePerGas: "3"
    }, [{ result: { gasUsed: "2", transactionHash: "tx-a" } }]);
    assert.equal(typeof ethReward, "number");
    assert.ok(Math.abs(ethReward - 2000000000000000000) <= 512);

    const ergReward = helpers.calcErgReward(100, [
        { outputs: [{}, { creationHeight: 100, value: 15000000001 }] },
        { outputs: [{ creationHeight: 100, value: 25 }] }
    ]);
    assert.equal(ergReward, 3000000026);
});

test("pool state thread names use short master and worker prefixes", () => {
    const originalConfig = global.config;
    const originalDatabase = global.database;
    const originalCoinFuncs = global.coinFuncs;
    const poolState = createPoolState();

    try {
        global.config = {
            daemon: {
                port: 39001
            },
            pool: {
                minerThrottleShareWindow: 10
            }
        };
        global.database = {};
        global.coinFuncs = {
            COIN2PORT(coin) {
                return coin === "" ? 39001 : 39002;
            },
            PORT2COIN(port) {
                return port === 39001 ? "" : "ALT";
            },
            PORT2COIN_FULL(port) {
                return port === 39001 ? "XMR" : "ALT";
            }
        };

        poolState.initThreadContext(true, undefined, { enableStats: false });
        assert.equal(poolState.state.threadName, "[M] ");
        assert.equal(global.database.thread_id, "[M] ");
        assert.equal(poolState.formatCoinPort("", 39001), "XMR/39001");
        assert.equal(poolState.formatCoinPort("ALT", 39002), "ALT/39002");
        assert.equal(poolState.formatCoinPort("ALT"), "ALT/39002");
        assert.equal(poolState.formatPoolEvent("Verify", { action: "wallet-add", wallet: "test-wallet" }), "Verify: action=wallet-add wallet=test-wallet");
        assert.equal("IMPORTANT: " + poolState.formatPoolEvent("Summary", { total: 10, trusted: "7(70.00%)" }), "IMPORTANT: Summary: total=10 trusted=\"7(70.00%)\"");

        poolState.resetRuntimeState();
        global.database = {};

        poolState.initThreadContext(false, 7, { enableShareWindowReset: false });
        assert.equal(poolState.state.threadName, `[S7:${process.pid}] `);
        assert.equal(global.database.thread_id, `[S7:${process.pid}] `);
    } finally {
        poolState.resetRuntimeState();
        global.config = originalConfig;
        global.database = originalDatabase;
        global.coinFuncs = originalCoinFuncs;
    }
});

test("cryptonote block-header reward lookup preserves suppress flags and wallet error detail", (t, done) => {
    const originalConfig = global.config;
    const originalSupport = global.support;
    const originalCoinFuncs = global.coinFuncs;
    const originalDatabase = global.database;

    try {
        global.config = {
            daemon: { port: 18081 },
            general: { testnet: false },
            pool: { address: "48A1PoolAddress" },
            pool_id: 1
        };
        global.database = {};
        global.support = {
            rpcPortDaemon(port, method, params, callback, suppressErrorLog) {
                assert.equal(port, 18081);
                assert.equal(method, "getblock");
                assert.equal(suppressErrorLog, true);
                callback({
                    result: {
                        miner_tx_hash: "abcd",
                        block_header: {
                            hash: "feed",
                            height: 100,
                            difficulty: 10,
                            reward: 0
                        },
                        json: JSON.stringify({
                            miner_tx: {
                                vout: [{ amount: 25 }]
                            }
                        })
                    }
                });
            },
            rpcPortWalletShort(port, method, params, callback, suppressErrorLog) {
                assert.equal(port, 18082);
                assert.equal(method, "get_transfer_by_txid");
                assert.deepEqual(params, { txid: "abcd" });
                assert.equal(suppressErrorLog, true);
                callback({ error: { code: -8, message: "Transaction not found." } });
            }
        };

        const coinFuncs = new Coin({});
        global.coinFuncs = coinFuncs;

        coinFuncs.getPortBlockHeaderByHash(18081, "deadbeef", function onHeader(err, header) {
            assert.equal(err, true);
            assert.equal(header.height, 100);
            assert.deepEqual(header.error, { code: -8, message: "Transaction not found." });
            done();
        }, true);
    } finally {
        global.config = originalConfig;
        global.support = originalSupport;
        global.coinFuncs = originalCoinFuncs;
        global.database = originalDatabase;
    }
});

test("invalid last block headers return errors without raw helper console noise", async () => {
    const originalConfig = global.config;
    const originalSupport = global.support;
    const originalCoinFuncs = global.coinFuncs;
    const originalDatabase = global.database;

    try {
        global.config = {
            daemon: { port: 18081 },
            general: { testnet: false },
            pool: { address: "48A1PoolAddress" },
            pool_id: 1
        };
        global.database = {};
        global.support = {
            rpcPortDaemon(port, method, params, callback, suppressErrorLog) {
                assert.equal(port, 18081);
                assert.equal(method, "getlastblockheader");
                assert.equal(suppressErrorLog, undefined);
                callback({ error: { message: "daemon still warming" } });
            }
        };

        const coinFuncs = new Coin({});
        global.coinFuncs = coinFuncs;

        const output = await captureConsole(async function runLookup() {
            await new Promise(function onDone(resolve) {
                coinFuncs.getLastBlockHeader(function onHeader(err, header) {
                    assert.equal(err, true);
                    assert.deepEqual(header, { error: { message: "daemon still warming" } });
                    resolve();
                });
            });
        });

        assert.equal(output.some(function match(line) { return line.includes("Last block header invalid"); }), false);
    } finally {
        global.config = originalConfig;
        global.support = originalSupport;
        global.coinFuncs = originalCoinFuncs;
        global.database = originalDatabase;
    }
});

test("template manager rotates templates and notifies miners through the right update path", () => {
    const activeMiners = new Map();
    const activeBlockTemplates = {};
    const pastBlockTemplates = {};
    const lastBlockHash = {};
    const lastBlockHeight = {};
    const lastBlockHashMM = {};
    const lastBlockHeightMM = {};
    const lastBlockTime = {};
    const lastBlockKeepTime = {};
    const lastBlockReward = {};
    const newCoinHashFactor = { "": 1, ALT: 2 };
    const lastCoinHashFactor = { "": 1, ALT: 2 };
    const lastCoinHashFactorMM = { "": 1, ALT: 2 };
    const anchorState = { current: 0, previous: 0 };
    const sendToWorkersCalls = [];
    const minerCalls = [];

    global.config = {
        daemon: { port: 39001 },
        pool: { trustedMiners: true }
    };
    global.support = {
        circularBuffer(limit) {
            const values = [];
            return {
                enq(value) {
                    values.unshift(value);
                    if (values.length > limit) values.pop();
                },
                get(index) {
                    return values[index];
                },
                toarray() {
                    return values.slice();
                }
            };
        }
    };
    function TestBlockTemplate(template) {
        Object.assign(this, template);
    }

    global.coinFuncs = {
        BlockTemplate: TestBlockTemplate,
        COIN2PORT(coin) {
            return coin === "" ? 39001 : 39002;
        },
        PORT2COIN(port) {
            return port === 39001 ? "" : "ALT";
        },
        PORT2COIN_FULL(port) {
            return port === 39001 ? "XMR" : "ALT";
        },
        getMM_PORTS() {
            return {};
        },
        getMM_CHILD_PORTS() {
            return {};
        },
        getAuxChainXTM() {
            return null;
        },
        algoShortTypeStr(port) {
            return port === 39001 ? "rx/0" : "kawpow";
        },
        isMinerSupportAlgo(algo, algos) {
            return algo in algos;
        }
    };

    activeMiners.set("best", {
        algos: { kawpow: 1 },
        trust: { check_height: 0 },
        sendBestCoinJob() {
            minerCalls.push("best");
        }
    });
    activeMiners.set("same", {
        algos: { kawpow: 1 },
        curr_coin: "ALT",
        trust: { check_height: 0 },
        sendBestCoinJob() {
            minerCalls.push("same-best");
        },
        sendCoinJob(coin, params) {
            minerCalls.push({ coin, params });
        }
    });

    const templateManager = createTemplateManager({
        cluster: { isMaster: false },
        debug() {},
        daemonPollMs: 500,
        coins: ["ALT"],
        activeMiners,
        activeBlockTemplates,
        pastBlockTemplates,
        lastBlockHash,
        lastBlockHeight,
        lastBlockHashMM,
        lastBlockHeightMM,
        lastBlockTime,
        lastBlockKeepTime,
        lastBlockReward,
        newCoinHashFactor,
        lastCoinHashFactor,
        lastCoinHashFactorMM,
        anchorState,
        sendToWorkers(message) {
            sendToWorkersCalls.push(message);
        },
        getThreadName() {
            return "(Test) ";
        },
        formatCoinPort(coin, port) {
            const resolvedPort = typeof port === "undefined" ? global.coinFuncs.COIN2PORT(coin) : port;
            return `${global.coinFuncs.PORT2COIN_FULL(resolvedPort)}/${resolvedPort}`;
        }
    });

    templateManager.setNewBlockTemplate({
        coin: "",
        port: 39001,
        idHash: "main-template",
        height: 101,
        difficulty: 100,
        coinHashFactor: 1,
        isHashFactorChange: false
    });
    templateManager.setNewBlockTemplate({
        coin: "ALT",
        port: 39002,
        idHash: "alt-template-1",
        height: 201,
        difficulty: 200,
        coinHashFactor: 2,
        isHashFactorChange: true
    });
    templateManager.setNewBlockTemplate({
        coin: "ALT",
        port: 39002,
        idHash: "alt-template-2",
        height: 202,
        difficulty: 210,
        coinHashFactor: 2,
        isHashFactorChange: false
    });

    assert.equal(anchorState.current, 101);
    assert.equal(activeBlockTemplates.ALT.idHash, "alt-template-2");
    assert.equal(pastBlockTemplates.ALT.toarray()[0].idHash, "alt-template-1");
    assert.deepEqual(minerCalls, [
        "best",
        "same-best",
        {
        coin: "ALT",
        params: {
            bt: activeBlockTemplates.ALT,
            coinHashFactor: 2,
            algo_name: "kawpow"
        }
        }
    ]);
    assert.deepEqual(sendToWorkersCalls, []);
});

test("server final replies honor explicit delay windows with random jitter", () => {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalMathRandom = Math.random;
    const timers = [];

    global.config = {
        pool: {
            socketAuthTimeout: 15,
            maxConnectionsPerIP: 256,
            maxConnectionsPerSubnet: 1024,
            protocolErrorLimit: 4
        }
    };
    global.setTimeout = function captureTimeout(callback, delay, ...args) {
        const timer = { callback, delay, args, cleared: false };
        timers.push(timer);
        return timer;
    };
    global.clearTimeout = function markCleared(timer) {
        if (timer) timer.cleared = true;
    };
    Math.random = function fixedRandom() {
        return 0.5;
    };

    const state = {
        threadName: "(Test) ",
        activeConnectionsByIP: {},
        activeConnectionsBySubnet: {},
        activeMiners: new Map(),
        activeMinerSockets: new Map(),
        freeEthExtranonces: []
    };
    const serverFactory = createServerFactory({
        debug() {},
        fs: require("node:fs"),
        net: require("node:net"),
        tls: require("node:tls"),
        state,
        handleMinerData(_socket, _id, _method, _params, _ip, _portData, _sendReply, sendReplyFinal) {
            sendReplyFinal("Delayed ban reply", 10);
        },
        removeMiner() {}
    });
    const socket = new EventEmitter();
    socket.remoteAddress = "127.0.0.2";
    socket.writable = true;
    socket.destroyed = false;
    socket.finalizing = false;
    socket.setKeepAlive = function setKeepAlive() {};
    socket.setEncoding = function setEncoding() {};
    socket.end = function end(payload) {
        socket.writable = false;
        socket.endedPayload = payload;
    };
    socket.destroy = function destroy() {
        socket.writable = false;
        socket.destroyed = true;
    };

    try {
        const handleSocket = serverFactory.createPoolSocketHandler({ port: 39001, portType: "pplns" });
        handleSocket(socket);
        socket.emit("data", `${JSON.stringify({ id: 1, method: "login", params: { login: "wallet" } })}\n`);

        const delayedTimer = timers.find(function findReplyTimer(timer) {
            return timer.delay === 5000 && timer.cleared === false;
        });

        assert.ok(delayedTimer);
        assert.equal(socket.endedPayload, undefined);

        delayedTimer.callback(...delayedTimer.args);

        assert.equal(typeof socket.endedPayload, "string");
        assert.equal(JSON.parse(socket.endedPayload).error.message, "Delayed ban reply");
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        Math.random = originalMathRandom;
    }
});

test("server startup ignores legacy non-pplns port rows", async () => {
    const listenCalls = [];
    const state = {
        threadName: "(Test) ",
        activeConnectionsByIP: {},
        activeConnectionsBySubnet: {},
        activeMiners: new Map(),
        activeMinerSockets: new Map(),
        freeEthExtranonces: []
    };

    global.config = {
        bind_ip: "127.0.0.1",
        pplns: { enable: true }
    };

    const netServers = [];
    const net = {
        createServer() {
            const server = {
                once() {},
                removeListener() {},
                on() {},
                listen(port, host, callback) {
                    listenCalls.push({ port, host });
                    callback();
                }
            };
            netServers.push(server);
            return server;
        }
    };
    const serverFactory = createServerFactory({
        debug() {},
        fs: require("node:fs"),
        net,
        tls: require("node:tls"),
        state,
        handleMinerData() {},
        removeMiner() {}
    });

    const servers = await serverFactory.startPortServers([
        { port: 39002, portType: "pplns", ssl: false },
        { port: 39003, portType: "solo", ssl: false }
    ]);

    assert.equal(servers.length, 1);
    assert.equal(netServers.length, 1);
    assert.deepEqual(listenCalls, [{ port: 39002, host: "127.0.0.1" }]);
});
});
