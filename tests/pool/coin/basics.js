"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");

const loadRegistry = require("../../../lib/coins/core/registry.js");
const {
    MAIN_PORT,
    createBaseTemplate,
    installTestGlobals
} = require("../common/harness.js");

const REAL_ETH_STYLE_PORT = 8645;
const INSTANCE_ID_PID_MASK = (1 << 22) - 1;

function withPatchedPid(pid, fn) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", {
        configurable: true,
        value: pid
    });

    try {
        return fn();
    } finally {
        Object.defineProperty(process, "pid", originalDescriptor);
    }
}

function createInstanceIdWord(poolId, pid) {
    const Coin = require("../../../lib/coins/index.js");
    const previousPoolId = global.config.pool_id;
    const realMainPort = global.coinFuncs.__realCoinFuncs.COIN2PORT("");
    const template = {
        ...createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "instance-id-" + poolId + "-" + pid,
            height: 501
        }),
        port: realMainPort
    };

    try {
        global.config.pool_id = poolId;
        return withPatchedPid(pid, function buildInstanceIdWord() {
            const realCoinFuncs = new Coin({});
            const blockTemplate = new realCoinFuncs.BlockTemplate(template);
            return blockTemplate.buffer.readUInt32LE(blockTemplate.reserved_offset + 4);
        });
    } finally {
        global.config.pool_id = previousPoolId;
    }
}

test.describe("pool coin helpers: basics", { concurrency: false }, () => {
test.beforeEach(() => {
    installTestGlobals();
});

test("hasTemplateBlob distinguishes hash-only extra-nonce templates from missing standard blobs", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;

    assert.equal(
        coinFuncs.hasTemplateBlob({ hash: "34".repeat(32) }, REAL_ETH_STYLE_PORT),
        true
    );
    assert.equal(
        coinFuncs.hasTemplateBlob({ reserved_offset: 17 }, MAIN_PORT),
        false
    );
});

test("BlockTemplate keeps main-template nonce layout stable across nextBlobHex calls", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const template = createBaseTemplate({
        coin: "",
        port: MAIN_PORT,
        idHash: "coin-helper-main-template",
        height: 301
    });
    const blockTemplate = new coinFuncs.BlockTemplate(template);
    const initialBuffer = Buffer.from(blockTemplate.buffer);
    const expectedIdHash = crypto
        .createHash("md5")
        .update(template.blocktemplate_blob)
        .digest("hex");

    assert.equal(blockTemplate.idHash, expectedIdHash);
    assert.equal(blockTemplate.reserved_offset, template.reserved_offset);
    assert.equal(blockTemplate.clientPoolLocation, template.reserved_offset + 8);
    assert.equal(blockTemplate.clientNonceLocation, template.reserved_offset + 12);

    blockTemplate.nextBlobHex();
    const firstBuffer = Buffer.from(blockTemplate.buffer);
    blockTemplate.nextBlobHex();
    const secondBuffer = Buffer.from(blockTemplate.buffer);

    assert.equal(blockTemplate.extraNonce, 2);
    assert.equal(firstBuffer.readUInt32BE(blockTemplate.reserved_offset), 1);
    assert.equal(secondBuffer.readUInt32BE(blockTemplate.reserved_offset), 2);
    assert.equal(
        firstBuffer.subarray(blockTemplate.reserved_offset + 4, blockTemplate.reserved_offset + 8).equals(
            initialBuffer.subarray(blockTemplate.reserved_offset + 4, blockTemplate.reserved_offset + 8)
        ),
        true
    );
    assert.equal(
        secondBuffer.subarray(blockTemplate.clientPoolLocation, blockTemplate.clientPoolLocation + 4).equals(
            initialBuffer.subarray(blockTemplate.clientPoolLocation, blockTemplate.clientPoolLocation + 4)
        ),
        true
    );
});

test("BlockTemplate derives dual-main candidate difficulty from the lowest chain difficulty", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const originalGetAuxChainXTM = global.coinFuncs.getAuxChainXTM;
    const template = {
        ...createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "dual-main-min-difficulty",
            height: 302
        }),
        difficulty: 999,
        _aux: {
            base_difficulty: 100,
            chains: [{
                id: "xtr",
                difficulty: 25,
                height: 12
            }]
        }
    };

    try {
        global.coinFuncs.getAuxChainXTM = coinFuncs.getAuxChainXTM.bind(coinFuncs);
        const blockTemplate = new coinFuncs.BlockTemplate(template);

        assert.equal(blockTemplate.xmr_difficulty, 100);
        assert.equal(blockTemplate.xtm_difficulty, 25);
        assert.equal(blockTemplate.difficulty, 25);
    } finally {
        global.coinFuncs.getAuxChainXTM = originalGetAuxChainXTM;
    }
});

test("BlockTemplate instanceId encodes pool_id and pid into separate bit ranges", () => {
    const poolId = 513;
    const pid = 0x2abcde;
    const instanceIdWord = createInstanceIdWord(poolId, pid);

    assert.equal(instanceIdWord >>> 22, poolId);
    assert.equal(instanceIdWord & INSTANCE_ID_PID_MASK, pid);
});

test("BlockTemplate instanceId stays unique across pool nodes and cluster threads within supported bit ranges", () => {
    const pairs = [
        [1, 1001],
        [1, 1002],
        [2, 1001],
        [1023, INSTANCE_ID_PID_MASK]
    ];
    const instanceIds = pairs.map(function buildInstanceId(pair) {
        return createInstanceIdWord(pair[0], pair[1]);
    });

    assert.equal(new Set(instanceIds).size, instanceIds.length);
});

test("BlockTemplate uses hash-only fast path for extra-nonce templates without a blob payload", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const hash = "56".repeat(32);
    const blockTemplate = new coinFuncs.BlockTemplate({
        coin: "ETH",
        port: REAL_ETH_STYLE_PORT,
        height: 401,
        difficulty: 100,
        seed_hash: "78".repeat(32),
        hash,
        hash2: "9a".repeat(32)
    });

    assert.equal(blockTemplate.idHash, hash);
    assert.equal(blockTemplate.block_version, 0);
    assert.equal(blockTemplate.nextBlobHex(), hash);
});

test("convertAlgosToCoinPerf preserves the expected per-coin algo aliases", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const perf = coinFuncs.convertAlgosToCoinPerf({
        "rx/0": 100,
        "cn-pico/trtl": 200,
        c29: 300,
        kawpow4: 400,
        etchash: 500
    });

    assert.equal(perf[""], 100);
    assert.equal(perf["SAL"], 100);
    assert.equal(perf["XTM-C"], 300);
    assert.equal(perf["XNA"], 400);
    assert.equal(perf["ETC"], 500);
});

test("shared blob types no longer collapse to the last loaded coin profile", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;

    assert.equal(coinFuncs.getProfilesByBlobType(0).some((profile) => profile.coin === "SUMO"), true);
    assert.equal(coinFuncs.getProfilesByBlobType(0).some((profile) => profile.coin === "XTM"), true);
    assert.deepEqual(
        coinFuncs.getProfilesByBlobType(101).map((profile) => profile.coin).sort(),
        ["RVN", "XNA"]
    );
    assert.equal(coinFuncs.getJobProfile({ coin: "SUMO", blob_type_num: 0 }).coin, "SUMO");
    assert.equal(coinFuncs.getJobProfile({ coin: "XTM", blob_type_num: 0 }).coin, "XTM");
});

test("pool profiles expose direct handlers instead of mode labels", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ravenPool = coinFuncs.getPoolSettings("RVN");
    const mainPool = coinFuncs.getPoolSettings("");
    const turtlePool = coinFuncs.getPoolSettings("TRTL");

    assert.equal(typeof ravenPool.buildJobPayload, "function");
    assert.equal(typeof ravenPool.pushJob, "function");
    assert.equal(typeof ravenPool.parseMiningSubmitParams, "function");
    assert.equal(typeof turtlePool.acceptSubmittedBlock, "function");
    assert.equal(typeof mainPool.submitBlockRpc, "function");
    assert.equal("jobFormat" in ravenPool, false);
    assert.equal("submitFormat" in ravenPool, false);
    assert.equal("blockSubmitMode" in turtlePool, false);
    assert.equal("blockHashMode" in mainPool, false);
});

test("registry ignores untagged top-level helper modules in lib/coins", () => {
    const helperPath = path.resolve(__dirname, "../../../lib/coins/__registry-helper.test.js");

    try {
        fs.writeFileSync(helperPath, "\"use strict\";\nmodule.exports = { port: 1, coin: \"__HELPER__\" };\n");
        const registry = loadRegistry();

        assert.equal(registry.profiles.some((profile) => profile.coin === "__HELPER__"), false);
    } finally {
        delete require.cache[helperPath];
        if (fs.existsSync(helperPath)) fs.unlinkSync(helperPath);
    }
});

test("wallet reward selectors stay on the coin profiles for asset-aware chains", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xhvSelector = coinFuncs.getRpcSettings("XHV").selectWalletTransferReward;
    const zephSelector = coinFuncs.getRpcSettings("ZEPH").selectWalletTransferReward;

    assert.equal(xhvSelector({
        transfer: { amount: 5 },
        transfers: [
            { asset_type: "XUSD", amount: 100 },
            { asset_type: "XHV", amount: 17 }
        ]
    }), 17);
    assert.equal(xhvSelector({ transfer: { amount: 5 }, transfers: [] }), 5);

    assert.equal(zephSelector({
        transfer: { amount: 7 },
        transfers: [
            { asset_type: "ZEPH", amounts: [19] }
        ]
    }), 19);
    assert.equal(zephSelector({
        transfer: { amount: 7 },
        transfers: [
            { asset_type: "ZEPH", amounts: [] }
        ]
    }), 7);
});

test("eth-style hash lookups preserve hex block heights when deriving canonical headers", async () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const etcRpc = coinFuncs.getRpcSettings("ETC");
    const seenHeights = [];
    let callbackArgs = null;

    await new Promise((resolve) => {
        etcRpc.getAnyBlockHeaderByHash({
            blockHash: "9c571133e4a54f922fd497d1b80bf0e964dd799faa5dd1f24926359b57a62dea",
            callback(err, body) {
                callbackArgs = { err, body };
                resolve();
            },
            isOurBlock: true,
            noErrorReport: true,
            port: REAL_ETH_STYLE_PORT,
            runtime: {
                coinFuncs: {
                    getPortBlockHeaderByID(_port, blockHeight, callback) {
                        seenHeights.push(blockHeight);
                        callback(true, null);
                    }
                },
                support: {
                    rpcPortDaemon2(_port, _method, _params, callback) {
                        callback({
                            jsonrpc: "2.0",
                            id: 1,
                            result: {
                                number: "0x1403059",
                                hash: "0x9c571133e4a54f922fd497d1b80bf0e964dd799faa5dd1f24926359b57a62dea",
                                transactions: [],
                                uncles: []
                            }
                        });
                    }
                }
            }
        });
    });

    assert.deepEqual(seenHeights, [20983897]);
    assert.equal(callbackArgs.err, true);
    assert.equal(callbackArgs.body.result.number, "0x1403059");
});

test("eth-style block submit acceptance requires an explicit true result", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const etcPool = coinFuncs.getPoolSettings("ETC");

    assert.equal(etcPool.acceptSubmittedBlock({ rpcResult: { result: true } }), true);
    assert.equal(etcPool.acceptSubmittedBlock({ rpcResult: { result: false } }), false);
    assert.equal(etcPool.acceptSubmittedBlock({ rpcResult: { result: "true" } }), false);
    assert.equal(etcPool.acceptSubmittedBlock({ rpcResult: {} }), false);
});

test("eth-style hash lookups propagate nested callback stalls as errors", async () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const etcRpc = coinFuncs.getRpcSettings("ETC");
    const originalSetTimeout = global.setTimeout;

    try {
        global.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
            return originalSetTimeout(fn, delay === 30 * 1000 ? 10 : delay, ...args);
        };

        const result = await new Promise((resolve) => {
            etcRpc.getAnyBlockHeaderByHash({
                blockHash: "9c571133e4a54f922fd497d1b80bf0e964dd799faa5dd1f24926359b57a62dea",
                callback(err, body) {
                    resolve({ err, body });
                },
                isOurBlock: true,
                noErrorReport: true,
                port: REAL_ETH_STYLE_PORT,
                runtime: {
                    coinFuncs: {
                        getPortBlockHeaderByID() {}
                    },
                    support: {
                        rpcPortDaemon2(_port, _method, _params, callback) {
                            callback({
                                jsonrpc: "2.0",
                                id: 1,
                                result: {
                                    number: "0x1403059",
                                    hash: "0x9c571133e4a54f922fd497d1b80bf0e964dd799faa5dd1f24926359b57a62dea",
                                    transactions: [],
                                    uncles: []
                                }
                            });
                        }
                    }
                }
            });
        });

        assert.equal(result.err, true);
        assert.match(result.body.error.message, /timed out/);
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test("blob helpers preserve special nonce sizes, proof sizes, and wire names for pool families", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;

    assert.equal(coinFuncs.nonceSize(coinFuncs.portBlobType(18081)), 4);
    assert.equal(coinFuncs.nonceSize(coinFuncs.portBlobType(8645)), 8);
    assert.equal(coinFuncs.nonceSize(coinFuncs.portBlobType(18148)), 8);

    assert.equal(coinFuncs.c29ProofSize(coinFuncs.portBlobType(19281)), 32);
    assert.equal(coinFuncs.c29ProofSize(coinFuncs.portBlobType(25182)), 40);
    assert.equal(coinFuncs.c29ProofSize(coinFuncs.portBlobType(18148)), 42);

    assert.equal(coinFuncs.blobTypeStr(8766), "raven");
    assert.equal(coinFuncs.blobTypeStr(8645), "eth");
    assert.equal(coinFuncs.blobTypeStr(9053), "erg");
    assert.equal(coinFuncs.blobTypeStr(18148), "xtm-c");

    assert.equal(coinFuncs.algoShortTypeStr(8766), "kawpow");
    assert.equal(coinFuncs.algoShortTypeStr(9053), "autolykos2");
    assert.equal(coinFuncs.algoShortTypeStr(18146), "rx/0");
});
});
