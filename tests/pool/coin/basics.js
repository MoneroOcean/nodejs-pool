"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const test = require("node:test");

const loadRegistry = require("../../../lib/coins/core/registry.js");
const createMinerJobs = require("../../../lib/pool/jobs.js");
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
            idHash: `instance-id-${  poolId  }-${  pid}`,
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

test("fixDaemonIssue invokes fix_daemon with structured arguments", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const originalExecFile = childProcess.execFile;
    const calls = [];
    childProcess.execFile = function execFile(file, args, callback) {
        calls.push({ file, args });
        callback(null, "ok", "");
    };

    try {
        coinFuncs.fixDaemonIssue({
            reason: "xtm-lag",
            port: 18081,
            xmrHeight: 500,
            xtmHeight: 700,
            expectedXtmHeight: 706
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, "./fix_daemon.sh");
        assert.deepEqual(calls[0].args, [
            "xtm-lag",
            "--port", "18081",
            "--xmr-height", "500",
            "--xtm-height", "700",
            "--expected-xtm-height", "706"
        ]);
        assert.match(global.support.emails[0].subject, /xtm-lag/);
        assert.match(global.support.emails[0].body, /XMR height 500 expected unknown/);
        assert.match(global.support.emails[0].body, /XTM height 700 expected 706/);
    } finally {
        childProcess.execFile = originalExecFile;
    }
});

test("getPortLastBlockHeaderMM labels merged-mining header failures", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const mainPort = coinFuncs.COIN2PORT("");
    const mmPort = coinFuncs.COIN2PORT("XTM-T");
    const originalPort = global.config.daemon.port;
    const originalHeader = global.coinFuncs.getPortLastBlockHeader;
    global.config.daemon.port = mainPort;
    global.coinFuncs.getPortLastBlockHeader = function (port, callback) {
        if (port === mainPort) return callback(null, { height: 501 });
        if (port === mmPort) return callback(new Error("getlastblockheader timeout"));
        return callback(new Error(`unexpected port ${  port}`));
    };

    try {
        coinFuncs.getPortLastBlockHeaderMM(mainPort, function (error, body) {
            assert.match(error.message, /merged mining XTM-T/);
            assert.match(error.message, new RegExp(String(mmPort)));
            assert.match(error.message, /getlastblockheader timeout/);
            assert.deepEqual(body, { height: 501 });
        });
    } finally {
        global.config.daemon.port = originalPort;
        global.coinFuncs.getPortLastBlockHeader = originalHeader;
    }
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

test("BlockTemplate keeps XTM-T pool/proxy nonce inside RandomXT pow_data", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const blob = Buffer.concat([
        Buffer.alloc(3),
        Buffer.alloc(32, 0x11),
        Buffer.alloc(8),
        Buffer.from([0x02]),
        Buffer.alloc(32)
    ]);
    const blockTemplate = new coinFuncs.BlockTemplate({
        blocktemplate_blob: blob.toString("hex"),
        coin: "XTM-T",
        difficulty: 1,
        height: 302,
        port: 18146,
        reserved_offset: 44,
        reward: 1,
        seed_hash: "22".repeat(32),
        xtm_block: { header: { nonce: "0", pow: { pow_data: [] } } }
    });

    const nextBlob = Buffer.from(blockTemplate.nextBlobHex(), "hex");

    assert.equal(blockTemplate.extraNonce, 1);
    assert.equal(nextBlob.subarray(35, 43).equals(Buffer.alloc(8)), true);
    assert.equal(nextBlob[43], 0x02);
    assert.equal(nextBlob.readUInt32BE(44), 1);
    assert.equal(blockTemplate.disableProxyNonce, false);
    assert.equal(blockTemplate.clientPoolLocation, 52);
    assert.equal(blockTemplate.clientNonceLocation, 56);
});

test("proxy miners use standard jobs when proxy nonce layout is disabled", () => {
    const originalGetPoolProfile = global.coinFuncs.getPoolProfile;
    const calls = [];
    const validJobs = [];
    const poolSettings = {
        sharedTemplateNonces: false,
        disableProxyNonce: true,
        useEthJobId: false,
        buildJobPayload(ctx) {
            calls.push("standard");
            assert.equal(ctx.newJob.usesProxyNonce, false);
            return { blob: ctx.blobHex, job_id: ctx.newJob.id };
        },
        buildProxyJobPayload() {
            calls.push("proxy");
            return {};
        }
    };
    const miner = {
        proxy: true,
        jobLastBlockHash: null,
        newDiffToSet: null,
        newDiffRecommendation: null,
        difficulty: 50,
        curr_coin_min_diff: 1,
        cachedJob: null,
        validJobs: {
            enq(job) {
                validJobs.push(job);
            }
        }
    };
    let nextBlobCalls = 0;
    let childBlobCalls = 0;
    const blockTemplate = {
        idHash: "xtm-t-no-proxy",
        difficulty: 100,
        height: 302,
        seed_hash: "22".repeat(32),
        port: 18146,
        block_version: 0,
        extraNonce: 0,
        disableProxyNonce: true,
        clientPoolLocation: 43,
        clientNonceLocation: 47,
        nextBlobHex() {
            nextBlobCalls += 1;
            this.extraNonce += 1;
            return "aa";
        },
        nextBlobWithChildNonceHex() {
            childBlobCalls += 1;
            return "bb";
        }
    };

    try {
        global.coinFuncs.getPoolProfile = function getPoolProfile() {
            return { blobType: 106, pool: poolSettings };
        };
        createMinerJobs({})(miner, {
            protoVersion: 1,
            getCoinJobParams() {},
            getNewId() { return "job-1"; },
            getNewEthJobId() { return "eth-job-1"; },
            getTargetHex() { return "00".repeat(32); },
            getRavenTargetHex() { return "00".repeat(32); },
            toBigInt(value) { return BigInt(value); },
            divideBaseDiff() { return 1; }
        });

        const payload = miner.getCoinJob("XTM-T", { bt: blockTemplate, algo_name: "rx/0", coinHashFactor: 1 });

        assert.deepEqual(payload, { blob: "aa", job_id: "job-1" });
        assert.deepEqual(calls, ["standard"]);
        assert.equal(nextBlobCalls, 1);
        assert.equal(childBlobCalls, 0);
        assert.equal(validJobs.length, 1);
        assert.equal(validJobs[0].usesProxyNonce, false);
        assert.equal(validJobs[0].clientPoolLocation, undefined);
        assert.equal(validJobs[0].clientNonceLocation, undefined);
    } finally {
        global.coinFuncs.getPoolProfile = originalGetPoolProfile;
    }
});

test("BlockTemplate uses the SAL blob marker when daemon reserved offset is stale", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const marker = Buffer.concat([Buffer.from([0x02, 17]), Buffer.alloc(17, 0)]);
    const prefix = Buffer.alloc(42, 0x44);
    const suffix = Buffer.alloc(8, 0x55);
    const blob = Buffer.concat([prefix, marker, suffix]);
    const template = {
        blocktemplate_blob: blob.toString("hex"),
        coin: "SAL",
        difficulty: 1,
        height: 303,
        port: 19081,
        reserved_offset: 12,
        reward: 1
    };
    const blockTemplate = new coinFuncs.BlockTemplate(template);

    assert.equal(blockTemplate.reserved_offset, prefix.length + 2);
});

test("BTC-style block rewards only credit coinbase outputs paid to the pool address", async () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const cases = [
        { coin: "RTM", port: 9998, addressKey: "address_9998", multiplier: 0xFFFFFFFF },
        { coin: "BTRM", port: 10225, addressKey: "address_10225", multiplier: 0xFFFFFFFF },
        { coin: "RVN", port: 8766, addressKey: "address_8766" },
        { coin: "XNA", port: 19001, addressKey: "address_19001" }
    ];
    const originalRpcPortDaemon2 = global.support.rpcPortDaemon2;

    try {
        for (const entry of cases) {
            const poolAddress = `POOL_${  entry.coin  }_ADDRESS`;
            global.config.pool[entry.addressKey] = poolAddress;
            global.support.rpcPortDaemon2 = function rpcPortDaemon2(port, method, params, callback) {
                assert.equal(port, entry.port);
                assert.equal(method, "");
                assert.deepEqual(params, { method: "getblock", params: [`${entry.coin.toLowerCase()  }-block`, 2] });
                callback({
                    result: {
                        difficulty: 2,
                        tx: [{
                            vout: [
                                { n: 0, value: 12.5, scriptPubKey: { addresses: [poolAddress] } },
                                { n: 1, value: 1.25, scriptPubKey: { addresses: ["NON_POOL_REWARD"] } },
                                { n: 2, value: 3, scriptPubKey: { address: poolAddress } },
                                { n: 3, value: 100, scriptPubKey: { addresses: ["GOVERNANCE_ADDRESS"] } }
                            ]
                        }]
                    }
                });
            };

            try {
                const header = await new Promise((resolve, reject) => {
                    coinFuncs.getPortAnyBlockHeaderByHash(entry.port, `${entry.coin.toLowerCase()  }-block`, true, (err, body) => {
                        if (err) return reject(new Error(`unexpected ${  entry.coin  } block header error`));
                        return resolve(body);
                    });
                });

                assert.equal(header.reward, 1550000000);
                if (entry.multiplier) assert.equal(header.difficulty, 2 * entry.multiplier);
            } finally {
                delete global.config.pool[entry.addressKey];
            }
        }
    } finally {
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        cases.forEach(function clearAddress(entry) {
            delete global.config.pool[entry.addressKey];
        });
    }
});

test("BTC-style network tip rewards fall back to max coinbase output for history sampling", async () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const cases = [
        { coin: "RVN", port: 8766, addressKey: "address_8766" },
        { coin: "XNA", port: 19001, addressKey: "address_19001" }
    ];
    const originalRpcPortDaemon2 = global.support.rpcPortDaemon2;

    try {
        for (const entry of cases) {
            const poolAddress = `POOL_${  entry.coin  }_ADDRESS`;
            global.config.pool[entry.addressKey] = poolAddress;
            global.support.rpcPortDaemon2 = function rpcPortDaemon2(port, method, params, callback) {
                assert.equal(port, entry.port);
                assert.equal(method, "");
                assert.deepEqual(params, { method: "getblock", params: [`${entry.coin.toLowerCase()  }-tip`, 2] });
                callback({
                    result: {
                        difficulty: 2,
                        tx: [{
                            vout: [
                                { n: 0, value: 12.5, scriptPubKey: { addresses: ["OTHER_MINER"] } },
                                { n: 1, value: 3, scriptPubKey: { address: poolAddress } },
                                { n: 2, value: 1.25, scriptPubKey: { addresses: ["GOVERNANCE_ADDRESS"] } }
                            ]
                        }]
                    }
                });
            };

            try {
                const header = await new Promise((resolve, reject) => {
                    coinFuncs.getPortAnyBlockHeaderByHash(entry.port, `${entry.coin.toLowerCase()  }-tip`, false, (err, body) => {
                        if (err) return reject(new Error(`unexpected ${  entry.coin  } network tip header error`));
                        return resolve(body);
                    });
                });

                assert.equal(header.reward, 1250000000);
            } finally {
                delete global.config.pool[entry.addressKey];
            }
        }
    } finally {
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        cases.forEach(function clearAddress(entry) {
            delete global.config.pool[entry.addressKey];
        });
    }
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
    const hashesPerDifficulty = coinFuncs.getPoolHashesPerDifficulty(19001);
    const legacyPerf = coinFuncs.convertAlgosToCoinPerf({
        "rx/0": 100,
        "argon2/chukwav2": 200,
        c29: 300,
        kawpow4: 400,
        etchash: 500
    });
    const rawPerf = coinFuncs.convertAlgosToCoinPerf({ kawpow1: 400 });
    const equivalentRawPerf = coinFuncs.convertAlgosToCoinPerf({ kawpow1: 400 * hashesPerDifficulty });
    const legacyFactor = 12345;
    const perHashFactor = legacyFactor / hashesPerDifficulty;

    assert.ok(hashesPerDifficulty > 0x100000000);
    assert.equal(legacyPerf[""], 100);
    assert.equal(legacyPerf.TRTL, 200);
    assert.equal(legacyPerf.LTHN, 200);
    assert.equal(legacyPerf["SAL"], 100);
    assert.equal(legacyPerf["XTM-C"], 300);
    assert.equal(legacyPerf.RVN, 400 * hashesPerDifficulty);
    assert.equal(legacyPerf.XNA, 400 * hashesPerDifficulty);
    assert.equal(legacyPerf["ETC"], 500);
    assert.equal(rawPerf.RVN, 400);
    assert.equal(rawPerf.XNA, 400);
    assert.equal(legacyPerf.RVN * perHashFactor, equivalentRawPerf.RVN * perHashFactor);
    assert.ok(Math.abs(2 * hashesPerDifficulty * perHashFactor - 2 * legacyFactor) < 1e-9);
    assert.equal(coinFuncs.normalizeMinerAlgos({ kawpow1: 1 }).kawpow, 1);
});

test("TRTL profile verifies shares with Argon2/Chukwa variant 2", () => {
    const profile = loadRegistry().profilesByPort[11898];
    const calls = [];
    const runtime = {
        powHash: {
            argon2(buffer, variant) {
                calls.push({ algorithm: "argon2", buffer: Buffer.from(buffer), variant });
                return Buffer.from("11".repeat(32), "hex");
            },
            cryptonight_pico() {
                throw new Error("TRTL must not verify shares with cryptonight_pico");
            }
        }
    };

    assert.equal(profile.algo, "argon2/chukwav2");
    assert.equal(profile.pow.variant, 2);
    assert.deepEqual(profile.perf.aliases, ["argon2/chukwav2", "chukwav2"]);

    const convertedBlob = Buffer.from("aabbccdd", "hex");
    const hash = profile.pow.hashBuff({ convertedBlob, runtime });

    assert.equal(hash.toString("hex"), "11".repeat(32));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].algorithm, "argon2");
    assert.equal(calls[0].variant, 2);
    assert.deepEqual(calls[0].buffer, convertedBlob);
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

test("cryptonote wallet reward lookup errors keep wallet source markers", async () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const rpc = coinFuncs.getRpcSettings("");
    const profile = coinFuncs.getPoolProfile("");
    const calls = [];

    const result = await new Promise((resolve) => {
        rpc.getAnyBlockHeaderByHash({
            blockHash: "aa".repeat(32),
            callback(err, header) {
                resolve({ err, header });
            },
            isOurBlock: true,
            noErrorReport: true,
            port: MAIN_PORT,
            profile,
            runtime: {
                support: {
                    rpcPortDaemon(port, method, params, callback, suppressErrorLog) {
                        calls.push({ port, method, params, suppressErrorLog });
                        callback({
                            result: {
                                miner_tx_hash: "bb".repeat(32),
                                block_header: {
                                    hash: "aa".repeat(32),
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
                        calls.push({ port, method, params, suppressErrorLog });
                        callback({ error: { code: -8, message: "Transaction not found." } });
                    }
                }
            }
        });
    });

    assert.equal(result.err, true);
    assert.equal(result.header.errorSource, "wallet_reward_lookup");
    assert.deepEqual(result.header.error, { code: -8, message: "Transaction not found." });
    assert.deepEqual(calls, [
        {
            port: MAIN_PORT,
            method: "get_block",
            params: { hash: "aa".repeat(32) },
            suppressErrorLog: true
        },
        {
            port: MAIN_PORT + 1,
            method: "get_transfer_by_txid",
            params: { txid: "bb".repeat(32) },
            suppressErrorLog: true
        }
    ]);
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
