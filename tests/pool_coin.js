"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");

const loadRegistry = require("../lib/coins/core/registry.js");
const {
    MAIN_PORT,
    createBaseTemplate,
    installTestGlobals
} = require("./pool_harness.js");

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
    const Coin = require("../lib/coins/index.js");
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

test.describe("pool coin helpers", { concurrency: false }, () => {
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
    assert.equal(perf["IRD"], 200);
    assert.equal(perf["XTM-C"], 300);
    assert.equal(perf["XNA"], 400);
    assert.equal(perf["CLORE"], 400);
    assert.equal(perf["ETC"], 500);
});

test("shared blob types no longer collapse to the last loaded coin profile", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;

    assert.equal(coinFuncs.getProfilesByBlobType(0).some((profile) => profile.coin === "SUMO"), true);
    assert.equal(coinFuncs.getProfilesByBlobType(0).some((profile) => profile.coin === "XTM"), true);
    assert.deepEqual(
        coinFuncs.getProfilesByBlobType(101).map((profile) => profile.coin).sort(),
        ["CLORE", "RVN", "XNA"]
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
    const helperPath = path.resolve(__dirname, "../lib/coins/__registry-helper.test.js");

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
                async: require("async"),
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
                    async: require("async"),
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

test("raven block submit handlers preserve the pre-refactor btc submit and result-hash flow", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ravenPool = coinFuncs.getPoolSettings("RVN");
    const resultBuff = Buffer.from("ab".repeat(32), "hex");
    const calls = [];
    let resolvedHash = null;

    ravenPool.resolveSubmittedBlockHash({ resultBuff }, function onHash(hash) {
        resolvedHash = hash;
    });

    ravenPool.submitBlockRpc.call(ravenPool, {
        blockData: Buffer.from("feedbeef", "hex"),
        blockTemplate: { port: 8766 },
        replyFn() {},
        support: {
            rpcPortDaemon2(port, method, params) {
                calls.push({ port, method, params });
            }
        }
    });

    assert.equal(resolvedHash, resultBuff.toString("hex"));
    assert.deepEqual(calls, [{
        port: 8766,
        method: "",
        params: {
            method: "submitblock",
            params: ["feedbeef"]
        }
    }]);
});

test("turtle block submit handlers preserve the pre-refactor http body submit and 202 acceptance", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const turtlePool = coinFuncs.getPoolSettings("TRTL");
    const calls = [];

    assert.equal(turtlePool.acceptSubmittedBlock({ rpcResult: "accepted", rpcStatus: 202 }), true);
    assert.equal(turtlePool.acceptSubmittedBlock({ rpcResult: "accepted", rpcStatus: 200 }), false);

    turtlePool.submitBlockRpc.call(turtlePool, {
        blockData: Buffer.from("c0ffee", "hex"),
        blockTemplate: { port: 11898 },
        replyFn() {},
        support: {
            rpcPortDaemon2(port, method, params) {
                calls.push({ port, method, params });
            }
        }
    });

    assert.deepEqual(calls, [{
        port: 11898,
        method: "block",
        params: "c0ffee"
    }]);
});

test("dero block submit handlers preserve the pre-refactor payload and blid resolution", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const deroPool = coinFuncs.getPoolSettings(20206);
    const calls = [];
    let resolvedHash = null;

    deroPool.resolveSubmittedBlockHash({
        rpcResult: {
            result: {
                blid: "dero-blid"
            }
        }
    }, function onHash(hash) {
        resolvedHash = hash;
    });

    deroPool.submitBlockRpc.call(deroPool, {
        blockData: Buffer.from("bada55", "hex"),
        blockTemplate: {
            port: 20206,
            blocktemplate_blob: "template-blob"
        },
        replyFn() {},
        support: {
            rpcPortDaemon(port, method, params) {
                calls.push({ port, method, params });
            }
        }
    });

    assert.equal(resolvedHash, "dero-blid");
    assert.deepEqual(calls, [{
        port: 20206,
        method: "submitblock",
        params: ["template-blob", "bada55"]
    }]);
});

test("erg handlers preserve the pre-refactor autolykos share verification and submit flow", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ergPool = coinFuncs.getPoolSettings("ERG");
    const verifyResult = Buffer.from("34".repeat(32), "hex");
    const submitCalls = [];
    let verifyArgs = null;
    const originalSetTimeout = global.setTimeout;

    try {
        global.setTimeout = function runImmediately(fn, _delay, ...args) {
            fn(...args);
            return 0;
        };

        assert.equal(ergPool.verifySpecialShare({
            blockTemplate: {
                hash: "12".repeat(32),
                port: 9053
            },
            coinFuncs: {
                slowHashBuff(buffer) {
                    assert.equal(buffer.toString("hex"), "12".repeat(32) + "56".repeat(8));
                    return [Buffer.alloc(32, 0xaa), verifyResult];
                }
            },
            hashEthBuffDiff(buffer) {
                assert.equal(buffer.equals(verifyResult), true);
                return 123n;
            },
            params: {
                nonce: "56".repeat(8)
            },
            shareThrottled() {
                return false;
            },
            verifyShareCB(...args) {
                verifyArgs = args;
            }
        }), true);

        assert.deepEqual(verifyArgs, [123n, null, "56".repeat(8), false, true]);
        assert.equal(ergPool.acceptSubmittedBlock({ rpcResult: { response: "accepted" } }), true);
        assert.equal(ergPool.acceptSubmittedBlock({ rpcResult: { response: "rejected" } }), false);

        ergPool.submitBlockRpc.call(ergPool, {
            blockData: "deadbeef",
            blockTemplate: { port: 9053 },
            replyFn() {},
            support: {
                rpcPortDaemon2(port, method, params) {
                    submitCalls.push({ port, method, params });
                }
            }
        });

        let matchedHash = null;
        ergPool.resolveSubmittedBlockHash({
            blockTemplate: {
                port: 9053,
                height: 77,
                hash2: "expected-pk"
            },
            coinFuncs: {
                getPortBlockHeaderByID(_port, _height, callback) {
                    callback(null, {
                        powSolutions: { pk: "expected-pk" },
                        id: "erg-block-id"
                    });
                }
            }
        }, function onHash(hash) {
            matchedHash = hash;
        });

        let mismatchedHash = null;
        ergPool.resolveSubmittedBlockHash({
            blockTemplate: {
                port: 9053,
                height: 78,
                hash2: "expected-pk"
            },
            coinFuncs: {
                getPortBlockHeaderByID(_port, _height, callback) {
                    callback(null, {
                        powSolutions: { pk: "different-pk" },
                        id: "erg-block-id"
                    });
                }
            }
        }, function onHash(hash) {
            mismatchedHash = hash;
        });

        assert.deepEqual(submitCalls, [{
            port: 9053,
            method: "mining/solution",
            params: { n: "deadbeef" }
        }]);
        assert.equal(matchedHash, "erg-block-id");
        assert.equal(mismatchedHash, "0".repeat(64));
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test("xtm submit and verify handlers preserve the pre-refactor special-case tari semantics", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xtmTPool = coinFuncs.getPoolSettings("XTM-T");
    const xtmCPool = coinFuncs.getPoolSettings("XTM-C");
    const blockDataRx = Buffer.alloc(48, 0);
    const blockDataC29 = Buffer.alloc(8, 0);
    const xtmRxCalls = [];
    const xtmC29Calls = [];
    let resolvedRxHash = null;
    let resolvedC29Hash = null;
    let verifyArgs = null;
    const c29Hash = Buffer.from("11".repeat(32), "hex");
    const expectedHeader = Buffer.concat([
        Buffer.from("000000000000000f", "hex"),
        Buffer.from("aabbccdd", "hex")
    ]);
    const job = { blob_type_num: 107 };

    blockDataRx.writeUInt32BE(1234, 3 + 32 + 4);
    Buffer.from([9, 8, 7, 6]).copy(blockDataRx, 3 + 32 + 8 + 1);
    blockDataC29.writeBigUInt64BE(15n, 0);

    xtmTPool.resolveSubmittedBlockHash({
        rpcResult: {
            result: {
                block_hash: [0, 1, 2, 255]
            }
        }
    }, function onHash(hash) {
        resolvedRxHash = hash;
    });

    xtmTPool.submitBlockRpc.call(xtmTPool, {
        blockData: blockDataRx,
        blockTemplate: {
            port: 18146,
            xtm_block: {
                header: {
                    nonce: "",
                    pow: { pow_data: [] }
                }
            }
        },
        replyFn() {},
        support: {
            rpcPortDaemon(port, method, params) {
                xtmRxCalls.push({ port, method, params });
            }
        }
    });

    assert.equal(xtmCPool.verifySpecialShare({
        bigIntToBuffer(value, options) {
            assert.equal(options.endian, "big");
            assert.equal(options.size, 8);
            const buffer = Buffer.alloc(8);
            buffer.writeBigUInt64BE(value);
            return buffer;
        },
        blockTemplate: {
            buffer: Buffer.from("aabbccdd", "hex"),
            port: 18148
        },
        coinFuncs: {
            c29(header, pow, port) {
                assert.equal(header.equals(expectedHeader), true);
                assert.deepEqual(pow, [1, 2, 3]);
                assert.equal(port, 18148);
                return false;
            },
            c29_packed_edges(pow, blobTypeNum) {
                assert.deepEqual(pow, [1, 2, 3]);
                assert.equal(blobTypeNum, 107);
                return "abcd";
            },
            c29_cycle_hash(packedEdges) {
                assert.equal(packedEdges, "abcd");
                return c29Hash;
            }
        },
        hashBuffDiff(buffer) {
            assert.equal(buffer.equals(c29Hash), true);
            return 77n;
        },
        invalidShare() {
            throw new Error("XTM-C verify path should not reject a valid proof");
        },
        job,
        miner: {},
        params: {
            nonce: "000000000000000f",
            pow: [1, 2, 3]
        },
        processShareCB() {
            throw new Error("XTM-C verify path should not terminate share processing");
        },
        reportMinerShare() {
            throw new Error("XTM-C verify path should not report an invalid share");
        },
        shareThrottled() {
            throw new Error("XTM-C verify path should not use throttling");
        },
        verifyShareCB(...args) {
            verifyArgs = args;
        }
    }), true);

    xtmCPool.resolveSubmittedBlockHash({
        rpcResult: {
            result: {
                block_hash: [1, 2, 3]
            }
        }
    }, function onHash(hash) {
        resolvedC29Hash = hash;
    });

    xtmCPool.submitBlockRpc.call(xtmCPool, {
        blockData: blockDataC29,
        blockTemplate: {
            port: 18148,
            xtm_block: {
                header: {
                    nonce: "",
                    pow: { pow_data: [] }
                }
            }
        },
        job,
        replyFn() {},
        support: {
            rpcPortDaemon(port, method, params) {
                xtmC29Calls.push({ port, method, params });
            }
        }
    });

    assert.equal(resolvedRxHash, "000102ff");
    assert.equal(xtmRxCalls.length, 1);
    assert.equal(xtmRxCalls[0].port, 18146);
    assert.equal(xtmRxCalls[0].method, "SubmitBlock");
    assert.equal(xtmRxCalls[0].params.header.nonce, "1234");
    assert.deepEqual(xtmRxCalls[0].params.header.pow.pow_data, [9, 8, 7, 6]);

    assert.deepEqual(job.c29_packed_edges, [0xab, 0xcd]);
    assert.equal(verifyArgs[0], 77n);
    assert.equal(verifyArgs[1].equals(c29Hash), true);
    assert.equal(verifyArgs[2].equals(expectedHeader), true);
    assert.deepEqual(verifyArgs.slice(3), [false, true]);

    assert.equal(resolvedC29Hash, "010203");
    assert.equal(xtmC29Calls.length, 1);
    assert.equal(xtmC29Calls[0].port, 18148);
    assert.equal(xtmC29Calls[0].method, "SubmitBlock");
    assert.equal(xtmC29Calls[0].params.header.nonce, "15");
    assert.deepEqual(xtmC29Calls[0].params.header.pow.pow_data, [0xab, 0xcd]);
});
});
