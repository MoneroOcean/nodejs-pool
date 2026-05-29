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
const XTM_T_MINING_HASH_OFFSET = 3;
const XTM_T_MINING_HASH_SIZE = 32;
const XTM_T_NONCE_OFFSET = XTM_T_MINING_HASH_OFFSET + XTM_T_MINING_HASH_SIZE;
const XTM_T_NONCE_SIZE = 8;
const XTM_T_MINER_NONCE_OFFSET = XTM_T_NONCE_OFFSET + 4;
const XTM_T_POW_ALGO_OFFSET = XTM_T_NONCE_OFFSET + XTM_T_NONCE_SIZE;
const XTM_T_POW_DATA_OFFSET = XTM_T_POW_ALGO_OFFSET + 1;
const XTM_T_POW_DATA_SIZE = 32;
const XTM_T_RANDOMXT_POW_ALGO = 2;
const XTM_T_POOL_RESERVED_OFFSET = XTM_T_POW_DATA_OFFSET;
const TARI_SOURCE_CANDIDATES = [
    process.env.POOL_TEST_TARI_SOURCE_DIR,
    process.env.TARI_SOURCE_DIR,
    "/usr/local/src/tari",
    "/usr/local/src/tari-src",
    process.env.HOME ? path.join(process.env.HOME, "tari") : ""
].filter(Boolean);

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

function createXtmTMiningBlob(miningHash, nonce, powData) {
    const powBytes = Buffer.alloc(XTM_T_POW_DATA_SIZE);
    if (powData) Buffer.from(powData).copy(powBytes, 0, 0, XTM_T_POW_DATA_SIZE);
    const blob = Buffer.concat([
        Buffer.alloc(XTM_T_MINING_HASH_OFFSET),
        miningHash,
        Buffer.alloc(XTM_T_NONCE_SIZE),
        Buffer.from([XTM_T_RANDOMXT_POW_ALGO]),
        powBytes
    ]);

    blob.writeBigUInt64BE(BigInt(nonce), XTM_T_NONCE_OFFSET);
    return blob;
}

function reconstructXtmTMiningBlob(miningHash, submittedBlock) {
    const powData = submittedBlock.header.pow && submittedBlock.header.pow.pow_data
        ? submittedBlock.header.pow.pow_data
        : [];
    return createXtmTMiningBlob(miningHash, BigInt(submittedBlock.header.nonce), powData);
}

function findTariSourceFile(relativePath) {
    for (const root of TARI_SOURCE_CANDIDATES) {
        const candidate = path.join(root, relativePath);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function readRustIntegerConst(source, name) {
    const match = source.match(new RegExp("\\bconst\\s+" + name + "\\s*:\\s*[^=]+\\s*=\\s*(\\d+)\\s*;"));
    assert.notEqual(match, null, "missing Tari source const " + name);
    return Number(match[1]);
}

function readRustMatchArm(source, currentArm, nextArm) {
    const match = source.match(new RegExp(currentArm + "\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\},\\n\\s*" + nextArm));
    assert.notEqual(match, null, "missing Tari source match arm " + currentArm);
    return match[1];
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

    assert.equal(deroPool.acceptSubmittedBlock({ rpcResult: { result: { status: "FAILED", message: "rejected" } } }), false);
    assert.equal(deroPool.acceptSubmittedBlock({ rpcResult: { result: { status: "OK" } } }), true);
    assert.equal(deroPool.acceptSubmittedBlock({ rpcResult: { result: { block_id: "submitted-block" } } }), true);

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
    const timerReceiver = { timer: true };

    try {
        global.setTimeout = function runImmediately(fn, _delay, ...args) {
            fn.call(timerReceiver, ...args);
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
        const matchedCoinFuncs = {
            getPortBlockHeaderByID(_port, _height, callback) {
                assert.equal(this, matchedCoinFuncs);
                callback(null, {
                    powSolutions: { pk: "expected-pk" },
                    id: "erg-block-id"
                });
            }
        };
        ergPool.resolveSubmittedBlockHash({
            blockTemplate: {
                port: 9053,
                height: 77,
                hash2: "expected-pk"
            },
            coinFuncs: matchedCoinFuncs
        }, function onHash(hash) {
            matchedHash = hash;
        });

        let mismatchedHash = null;
        const mismatchedCoinFuncs = {
            getPortBlockHeaderByID(_port, _height, callback) {
                assert.equal(this, mismatchedCoinFuncs);
                callback(null, {
                    powSolutions: { pk: "different-pk" },
                    id: "erg-block-id"
                });
            }
        };
        ergPool.resolveSubmittedBlockHash({
            blockTemplate: {
                port: 9053,
                height: 78,
                hash2: "expected-pk"
            },
            coinFuncs: mismatchedCoinFuncs
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

test("eth submitted block hash lookup preserves coinFuncs receiver when delayed", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const ethPool = coinFuncs.getPoolSettings("ETH");
    const originalSetTimeout = global.setTimeout;
    const timerReceiver = { timer: true };
    let resolvedHash = null;
    const delayedCoinFuncs = {
        ethBlockFind(port, nonce, callback) {
            assert.equal(this, delayedCoinFuncs);
            assert.equal(port, 8645);
            assert.equal(nonce, "0xnonce");
            callback("0x" + "ab".repeat(32));
        }
    };

    try {
        global.setTimeout = function runImmediately(fn, _delay, ...args) {
            fn.call(timerReceiver, ...args);
            return 0;
        };

        ethPool.resolveSubmittedBlockHash({
            blockData: ["0xnonce"],
            blockTemplate: {
                port: 8645
            },
            coinFuncs: delayedCoinFuncs
        }, function onHash(hash) {
            resolvedHash = hash;
        });

        assert.equal(resolvedHash, "ab".repeat(32));
    } finally {
        global.setTimeout = originalSetTimeout;
    }
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

test("xtm-t SubmitBlock payload roundtrips the miner's Tari RandomXT blob", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xtmTPool = coinFuncs.getPoolSettings("XTM-T");
    assert.equal(xtmTPool.disableProxyNonce, false);
    const miningHash = Buffer.from("31".repeat(XTM_T_MINING_HASH_SIZE), "hex");
    const xtmBlock = {
        header: {
            nonce: "0",
            pow: { pow_data: [7, 7, 7] }
        }
    };
    const blockTemplate = new coinFuncs.BlockTemplate({
        blocktemplate_blob: createXtmTMiningBlob(miningHash, 0n).toString("hex"),
        coin: "XTM-T",
        difficulty: 1,
        height: 271620,
        port: 18146,
        reserved_offset: XTM_T_POOL_RESERVED_OFFSET,
        reward: 1,
        seed_hash: "22".repeat(32),
        xtm_block: xtmBlock
    });
    const calls = [];
    const minerBlob = Buffer.from(blockTemplate.nextBlobHex(), "hex");

    minerBlob.writeUInt32BE(0x01020304, XTM_T_MINER_NONCE_OFFSET);
    minerBlob.writeUInt32BE(0xaabbccdd, blockTemplate.clientPoolLocation);
    minerBlob.writeUInt32BE(0xeeff0011, blockTemplate.clientNonceLocation);

    xtmTPool.submitBlockRpc.call(xtmTPool, {
        blockData: minerBlob,
        blockTemplate,
        replyFn() {},
        support: {
            rpcPortDaemon(port, method, params) {
                calls.push({ port, method, params });
            }
        }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].port, 18146);
    assert.equal(calls[0].method, "SubmitBlock");
    assert.equal(calls[0].params.header.nonce, minerBlob.readBigUInt64BE(XTM_T_NONCE_OFFSET).toString(10));
    assert.equal(minerBlob[XTM_T_POW_ALGO_OFFSET], XTM_T_RANDOMXT_POW_ALGO);
    assert.deepEqual(calls[0].params.header.pow.pow_data, [...minerBlob.subarray(XTM_T_POW_DATA_OFFSET)]);
    assert.equal(reconstructXtmTMiningBlob(miningHash, calls[0].params).equals(minerBlob), true);
    assert.notStrictEqual(calls[0].params, xtmBlock);
    assert.equal(xtmBlock.header.nonce, "0");
    assert.deepEqual(xtmBlock.header.pow.pow_data, [7, 7, 7]);
});

test("xtm-t legacy nonce submit uses backing bytes when Buffer uint32 reads are unsafe", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xtmTPool = coinFuncs.getPoolSettings("XTM-T");
    const miningHash = Buffer.from("31".repeat(XTM_T_MINING_HASH_SIZE), "hex");
    const blockData = createXtmTMiningBlob(miningHash, 0n, [4, 5, 6]);
    const calls = [];
    const originalConsoleWarn = console.warn;
    const warnings = [];
    const emails = global.support.emails;
    const spoofedBlockData = new Proxy(blockData, {
        get(target, prop) {
            if (prop === "slice") return target.slice.bind(target);
            if (prop === String(XTM_T_MINER_NONCE_OFFSET)) return 130.99999999999991;
            return Reflect.get(target, prop, target);
        }
    });

    Buffer.from("83304400", "hex").copy(blockData, XTM_T_MINER_NONCE_OFFSET);
    assert.equal(Buffer.isBuffer(spoofedBlockData), true);
    assert.equal(Number.isInteger(spoofedBlockData.readUInt32BE(XTM_T_MINER_NONCE_OFFSET)), false);
    console.warn = function captureWarn(message) {
        warnings.push(message);
    };

    try {
        xtmTPool.submitBlockRpc.call(xtmTPool, {
            blockData: spoofedBlockData,
            blockTemplate: {
                port: 18146,
                reserved_offset: XTM_T_POOL_RESERVED_OFFSET,
                xtm_block: { header: { nonce: "0", pow: { pow_data: [] } } }
            },
            replyFn() {},
            support: {
                rpcPortDaemon(port, method, params) {
                    calls.push({ port, method, params });
                }
            }
        });
    } finally {
        console.warn = originalConsoleWarn;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].port, 18146);
    assert.equal(calls[0].method, "SubmitBlock");
    assert.equal(calls[0].params.header.nonce, blockData.readBigUInt64BE(XTM_T_NONCE_OFFSET).toString(10));
    assert.deepEqual(calls[0].params.header.pow.pow_data, [...blockData.subarray(XTM_T_POW_DATA_OFFSET)]);
    assert.match(warnings.join("\n"), /isProxy:true/);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].key, "coins:xtm-legacy-nonce-read:XTM legacy nonce read XTM-T");
    assert.equal(emails[0].subject, "FYI: XTM legacy nonce read mismatch");
    assert.match(emails[0].body, /isProxy:true/);
    assert.match(emails[0].body, /legacyLo1=2200978431\.9999986/);
    assert.match(emails[0].body, /legacyLo2=2200978431\.9999986/);
    assert.match(emails[0].body, /indexedCalcLo:2200978431\.9999986/);
});

test("xtm-t legacy nonce submit does not depend on Buffer readUInt32BE", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xtmTPool = coinFuncs.getPoolSettings("XTM-T");
    const miningHash = Buffer.from("31".repeat(XTM_T_MINING_HASH_SIZE), "hex");
    const blockData = createXtmTMiningBlob(miningHash, 0n, [4, 5, 6]);
    const originalReadUInt32BE = Buffer.prototype.readUInt32BE;
    const originalConsoleWarn = console.warn;
    const calls = [];
    const warnings = [];
    const emails = global.support.emails;
    let returnedBadNonceRead = false;

    Buffer.from("83304400", "hex").copy(blockData, XTM_T_MINER_NONCE_OFFSET);
    Buffer.prototype.readUInt32BE = function patchedReadUInt32BE(offset, ...args) {
        if (this === blockData && offset === XTM_T_MINER_NONCE_OFFSET && !returnedBadNonceRead) {
            returnedBadNonceRead = true;
            return 2200978431.9999986;
        }
        return originalReadUInt32BE.call(this, offset, ...args);
    };
    console.warn = function captureWarn(message) {
        warnings.push(message);
    };

    try {
        xtmTPool.submitBlockRpc.call(xtmTPool, {
            blockData,
            blockTemplate: {
                port: 18146,
                reserved_offset: XTM_T_POOL_RESERVED_OFFSET,
                xtm_block: { header: { nonce: "0", pow: { pow_data: [] } } }
            },
            replyFn() {},
            support: {
                rpcPortDaemon(port, method, params) {
                    calls.push({ port, method, params });
                }
            }
        });
    } finally {
        Buffer.prototype.readUInt32BE = originalReadUInt32BE;
        console.warn = originalConsoleWarn;
    }

    assert.equal(calls.length, 1);
    assert.equal(returnedBadNonceRead, true);
    assert.equal(calls[0].params.header.nonce, blockData.readBigUInt64BE(XTM_T_NONCE_OFFSET).toString(10));
    assert.equal(calls[0].params.header.nonce, "2200978432");
    assert.match(warnings.join("\n"), /isProxy:false/);
    assert.match(warnings.join("\n"), /indexed=\[35:number:0:integer=true/);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].key, "coins:xtm-legacy-nonce-read:XTM legacy nonce read XTM-T");
    assert.equal(emails[0].subject, "FYI: XTM legacy nonce read mismatch");
    assert.match(emails[0].body, /legacyLo1=2200978431\.9999986/);
    assert.match(emails[0].body, /legacyLo2=2200978432/);
    assert.match(emails[0].body, /isProxy:false/);
    assert.match(emails[0].body, /indexed=\[35:number:0:integer=true/);
    assert.match(emails[0].body, /indexedCalcLo:2200978432/);
    assert.match(emails[0].body, /readUInt32BEIsOriginal:false/);
});

test("xtm-t SubmitBlock rejects a blob with a corrupted pow_algo byte", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xtmTPool = coinFuncs.getPoolSettings("XTM-T");
    const miningHash = Buffer.from("31".repeat(XTM_T_MINING_HASH_SIZE), "hex");
    const blockData = createXtmTMiningBlob(miningHash, 1n);
    let reply = null;

    blockData[XTM_T_POW_ALGO_OFFSET] = 0xaa;

    xtmTPool.submitBlockRpc.call(xtmTPool, {
        blockData,
        blockTemplate: {
            port: 18146,
            xtm_block: { header: { nonce: "0", pow: { pow_data: [] } } }
        },
        replyFn(rpcResult, rpcStatus) {
            reply = { rpcResult, rpcStatus };
        },
        support: {
            rpcPortDaemon() {
                throw new Error("corrupted XTM-T pow_algo must not be submitted");
            }
        }
    });

    assert.equal(reply.rpcStatus, 0);
    assert.equal(reply.rpcResult.error.code, -1);
    assert.match(reply.rpcResult.error.message, /Invalid XTM-T pow_algo byte 170; expected 2/);
});

test("xtm-t layout keeps pool reserve clear of Tari nonce and pow_algo", (t) => {
    const innerPath = findTariSourceFile(path.join("applications", "minotari_node", "src", "xmrig_proxy", "inner.rs"));
    if (!innerPath) {
        t.skip("Tari source tree not available; set POOL_TEST_TARI_SOURCE_DIR to enable this contract check.");
        return;
    }

    const innerSource = fs.readFileSync(innerPath, "utf8");
    assert.equal(readRustIntegerConst(innerSource, "TARI_BLOB_RESERVED_OFFSET"), XTM_T_NONCE_OFFSET);
    assert.equal(readRustIntegerConst(innerSource, "TARI_MINING_BLOB_SIZE"), XTM_T_POW_DATA_OFFSET + XTM_T_POW_DATA_SIZE);
    assert.equal(readRustIntegerConst(innerSource, "POW_ALGO_RANDOMXT"), XTM_T_RANDOMXT_POW_ALGO);
    assert.equal(XTM_T_POOL_RESERVED_OFFSET, XTM_T_POW_DATA_OFFSET);
    assert.equal(XTM_T_POOL_RESERVED_OFFSET >= XTM_T_POW_ALGO_OFFSET + 1, true);
    assert.equal(XTM_T_POOL_RESERVED_OFFSET + 16 <= XTM_T_POW_DATA_OFFSET + XTM_T_POW_DATA_SIZE, true);

    const helpersPath = findTariSourceFile(path.join("base_layer", "core", "src", "proof_of_work", "monero_rx", "helpers.rs"));
    if (!helpersPath) return;
    const helpersSource = fs.readFileSync(helpersPath, "utf8");
    assert.match(helpersSource, /nonce\.to_be_bytes\(\)/);
    assert.match(helpersSource, /pow\.to_bytes\(\)/);

    const validatorPath = findTariSourceFile(path.join("base_layer", "core", "src", "validation", "header", "header_full_validator.rs"));
    if (!validatorPath) return;
    const validatorSource = fs.readFileSync(validatorPath, "utf8");
    const randomXtArm = readRustMatchArm(validatorSource, "PowAlgorithm::RandomXT", "PowAlgorithm::Sha3x");
    assert.match(randomXtArm, /pow\.pow_data\.len\(\)\s*>\s*32/);
    assert.doesNotMatch(randomXtArm, /is_empty/);
});

test("xtm submit and verify handlers preserve the pre-refactor special-case tari semantics", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const xtmTPool = coinFuncs.getPoolSettings("XTM-T");
    const xtmCPool = coinFuncs.getPoolSettings("XTM-C");
    const blockDataRx = Buffer.alloc(76, 0);
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
    const xtmRxBlock = {
        header: {
            nonce: "",
            pow: { pow_data: [99] }
        }
    };
    const xtmC29Block = {
        header: {
            nonce: "",
            pow: { pow_data: [88] }
        }
    };

    blockDataRx.writeUInt32BE(7, XTM_T_NONCE_OFFSET);
    blockDataRx.writeUInt32BE(1234, XTM_T_MINER_NONCE_OFFSET);
    blockDataRx[XTM_T_POW_ALGO_OFFSET] = XTM_T_RANDOMXT_POW_ALGO;
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
            xtm_block: xtmRxBlock
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
            xtm_block: xtmC29Block
        },
        job,
        replyFn() {},
        support: {
            rpcPortDaemon(port, method, params) {
                xtmC29Calls.push({ port, method, params });
            }
        }
    });

    assert.equal(xtmTPool.acceptSubmittedBlock({ rpcResult: { result: { block_hash: [0, 1, 2, 255] } } }), true);
    assert.equal(xtmTPool.acceptSubmittedBlock({ rpcResult: { result: { block_hash: "11".repeat(32) } } }), true);
    assert.equal(xtmTPool.acceptSubmittedBlock({ rpcResult: { result: { status: "OK" } } }), false);
    assert.equal(xtmTPool.acceptSubmittedBlock({ rpcResult: { result: { status: "FAILED" } } }), false);
    assert.equal(xtmTPool.submissionKey({
        job: { usesProxyNonce: false },
        miner: { proxy: true },
        params: { nonce: "01020304", poolNonce: 5, workerNonce: 6 }
    }), "01020304");
    assert.equal(xtmTPool.submissionKey({
        job: { usesProxyNonce: true },
        miner: { proxy: true },
        params: { nonce: "01020304", poolNonce: 5, workerNonce: 6 }
    }), "01020304_5_6");
    assert.equal(xtmCPool.acceptSubmittedBlock({ rpcResult: { result: { block_hash: [1, 2, 3] } } }), true);
    assert.equal(xtmCPool.acceptSubmittedBlock({ rpcResult: { result: { status: "OK" } } }), false);

    assert.equal(resolvedRxHash, "000102ff");
    assert.equal(xtmRxCalls.length, 1);
    assert.equal(xtmRxCalls[0].port, 18146);
    assert.equal(xtmRxCalls[0].method, "SubmitBlock");
    assert.equal(xtmRxCalls[0].params.header.nonce, ((7n << 32n) | 1234n).toString(10));
    assert.deepEqual(xtmRxCalls[0].params.header.pow.pow_data, []);
    assert.notStrictEqual(xtmRxCalls[0].params, xtmRxBlock);
    assert.equal(xtmRxBlock.header.nonce, "");
    assert.deepEqual(xtmRxBlock.header.pow.pow_data, [99]);

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
    assert.notStrictEqual(xtmC29Calls[0].params, xtmC29Block);
    assert.equal(xtmC29Block.header.nonce, "");
    assert.deepEqual(xtmC29Block.header.pow.pow_data, [88]);
});
});
