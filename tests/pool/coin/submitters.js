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

test.describe("pool coin helpers: submitters", { concurrency: false }, () => {
test.beforeEach(() => {
    installTestGlobals();
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

test("eth and erg require full submitted nonces to include extranonce", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ethPool = coinFuncs.getPoolSettings("ETH");
    const ergPool = coinFuncs.getPoolSettings("ERG");
    const observed = [];
    const baseContext = {
        coinFuncs: {
            nonceSize() {
                return 8;
            }
        },
        job: {
            blob_type_num: 102,
            extraNonce: "abcd"
        },
        normalizeExtraNonceSubmitNonce(nonce, extraNonce, options) {
            observed.push({ extraNonce, options });
            return nonce;
        },
        params: {
            nonce: "0011223344556677"
        },
        state: {
            nonceCheck64: /^[0-9a-f]{16}$/,
            hashCheck32: /^[0-9a-f]{64}$/
        }
    };

    assert.equal(ethPool.validateSubmitParams({ ...baseContext, params: { nonce: "0011223344556677" } }), true);
    assert.equal(ergPool.validateSubmitParams({ ...baseContext, params: { nonce: "0011223344556677" } }), true);
    assert.deepEqual(observed, [
        { extraNonce: "abcd", options: { requireFullNonceExtraNoncePrefix: true } },
        { extraNonce: "abcd", options: { requireFullNonceExtraNoncePrefix: true } }
    ]);
});

test("erg mining.submit parser uses the nonce field even when SRBMiner includes a full nonce field", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ergPool = coinFuncs.getPoolSettings("ERG");
    const params = {
        raw_params: [
            "erg-wallet",
            "21108",
            "5b3ec51d640c",
            "undefined",
            "f0c25b3ec51d640c"
        ]
    };

    assert.equal(ergPool.parseMiningSubmitParams({ params }), true);
    assert.equal(params.nonce, "5b3ec51d640c");
});

test("erg mining.submit parser falls back to nonce suffix for standard submits", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ergPool = coinFuncs.getPoolSettings("ERG");
    const params = {
        raw_params: [
            "erg-wallet",
            "21108",
            "5b3ec51d640c"
        ]
    };

    assert.equal(ergPool.parseMiningSubmitParams({ params }), true);
    assert.equal(params.nonce, "5b3ec51d640c");
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
