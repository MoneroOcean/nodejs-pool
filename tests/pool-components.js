"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const createConstants = require("../lib/coins/constants.js");
const helpers = require("../lib/coins/helpers.js");
const createTemplateManager = require("../lib/pool/templates.js");
const createShareProcessor = require("../lib/pool/shares.js");

function clearObject(target) {
    for (const key of Object.keys(target)) delete target[key];
}

test.describe("pool components", { concurrency: false }, () => {
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

test("share processor records accepted shares through the common verification path", async () => {
    const messages = [];
    const databaseShares = [];
    const walletTrust = { wallet: 0 };
    const walletLastSeeTime = {};
    const activeBlockTemplates = {
        "": { idHash: "active-template" }
    };
    const minerWallets = {
        wallet: {
            connectTime: Date.now(),
            count: 1,
            hashes: 0,
            last_ver_shares: 0
        }
    };
    const lastMinerLogTime = {};

    global.config = {
        pool: {
            shareAccTime: 60,
            targetTime: 30,
            trustThreshold: 1,
            trustMin: 0,
            trustedMiners: false,
            minerThrottleSharePerSec: 1000,
            minerThrottleShareWindow: 10
        },
        daemon: {
            port: 39001
        },
        pool_id: 7,
        general: {
            adminEmail: "admin@example.invalid"
        }
    };
    global.protos = {
        Share: {
            encode(payload) {
                return payload;
            }
        }
    };
    global.database = {
        storeShare(height, payload) {
            databaseShares.push({ height, payload });
        }
    };
    global.support = {
        sendEmail() {}
    };
    global.coinFuncs = {
        constructNewBlob() {
            return Buffer.from("feedbeef", "hex");
        },
        convertBlob(buffer) {
            return Buffer.from(buffer);
        },
        slowHashBuff() {
            return Buffer.from("f".repeat(64), "hex");
        },
        slowHashAsync(_buffer, _blockTemplate, _wallet, callback) {
            callback("f".repeat(64));
        },
        constructMMChildBlockBlob() {
            throw new Error("MM path should not be used in this test");
        },
        blobTypeXTM_C() { return false; },
        blobTypeGrin() { return false; },
        blobTypeRvn() { return false; },
        blobTypeEth() { return false; },
        blobTypeErg() { return false; },
        blobTypeDero() { return false; },
        blobTypeXTM_T() { return false; },
        blobTypeRtm() { return false; },
        blobTypeKcn() { return false; }
    };

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = function unrefTimeout(callback, delay, ...args) {
        const timer = originalSetTimeout(callback, delay, ...args);
        if (timer && typeof timer.unref === "function") timer.unref();
        return timer;
    };

    const shareProcessor = createShareProcessor({
        crypto: require("node:crypto"),
        debug() {},
        divideBaseDiff() {
            return 10n;
        },
        bigIntFromBuffer() {
            return 1n;
        },
        bigIntToBuffer(value, options) {
            let hex = BigInt(value).toString(16);
            if (hex.length % 2) hex = `0${hex}`;
            if (options && options.size) hex = hex.padStart(options.size * 2, "0");
            const buffer = Buffer.from(hex, "hex");
            return options && options.endian === "little" ? Buffer.from(buffer).reverse() : buffer;
        },
        toBigInt(value) {
            return BigInt(value);
        },
        baseRavenDiff: 1,
        anchorState: { current: 101 },
        activeBlockTemplates,
        proxyMiners: {},
        minerWallets,
        walletTrust,
        walletLastSeeTime,
        processSend(message) {
            messages.push(message.type);
        },
        addProxyMiner() {
            return true;
        },
        adjustMinerDiff() {
            return false;
        },
        getThreadName() {
            return "(Test) ";
        },
        getLastMinerLogTime() {
            return lastMinerLogTime;
        },
        setLastMinerLogTime(nextValue) {
            clearObject(lastMinerLogTime);
            Object.assign(lastMinerLogTime, nextValue);
        }
    });

    try {
        const accepted = await new Promise((resolve) => {
            shareProcessor.processShare({
                payout: "wallet",
                address: "wallet",
                paymentID: null,
                wallet_key: "wallet-key ",
                poolTypeEnum: 0,
                identifier: "worker-a",
                logString: "wallet:worker-a",
                proxy: false,
                hashes: 0,
                sendSameCoinJob() {
                    throw new Error("sendSameCoinJob should not be called for a valid share");
                }
            }, {
                blob_type_num: 0,
                difficulty: 10,
                rewarded_difficulty: 10,
                rewarded_difficulty2: 10,
                norm_diff: 10,
                coinHashFactor: 1,
                extraNonce: 0,
                height: 101,
                coin: ""
            }, {
                port: 39001,
                coin: "",
                idHash: "active-template",
                buffer: Buffer.alloc(32),
                reserved_offset: 0,
                height: 101,
                difficulty: 1000
            }, {
                nonce: "00000001",
                result: "f".repeat(64)
            }, resolve);
        });

        assert.equal(accepted, true);
        assert.deepEqual(messages, ["normalShare"]);
        assert.equal(databaseShares.length, 0);
    } finally {
        shareProcessor.resetShareState();
        global.setTimeout = originalSetTimeout;
    }
});
});
