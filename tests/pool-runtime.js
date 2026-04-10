"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ETH_WALLET,
    VALID_RESULT,
    JsonLineClient,
    openRawSocket,
    waitForSocketClose,
    assertNoSocketData,
    waitForSocketJson,
    startHarness,
    flushTimers,
    invokePoolMethod,
    createBaseTemplate,
    poolModule
} = require("./pool-harness.js");

const RX0_MAIN_SHARE_VECTORS = [
    {
        nonce: "00000019",
        expected: "38f638606c730dd6f271d037556b83988c71acc6980e22e25271b22389ecfce6",
        seed: "12345678901234567890123456789012",
        input: "This is a test"
    },
    {
        nonce: "0000001a",
        expected: "86cb0f6306d536f373650bd196a5205a0293fba2ead85003d7aee4006afee147",
        seed: "12345678901234567890123456789012",
        input: "Lorem ipsum dolor sit amet"
    },
    {
        nonce: "0000001c",
        expected: "375aa54e18029b6f04372dd51b7349f130810b1270e67a22f26c15dab6f93a65",
        seed: "12345678901234567890123456789012",
        input: "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua"
    }
];

function buildMainShareResult(runtime, socket, jobId, nonce) {
    const miner = runtime.getState().activeMiners.get(socket.miner_id);
    const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
    const blockTemplate = runtime.getState().activeBlockTemplates[""];
    const templateBuffer = Buffer.alloc(blockTemplate.buffer.length);

    blockTemplate.buffer.copy(templateBuffer);
    templateBuffer.writeUInt32BE(job.extraNonce, blockTemplate.reserved_offset);

    const blockData = global.coinFuncs.constructNewBlob(
        templateBuffer,
        { nonce, result: VALID_RESULT },
        MAIN_PORT
    );
    const convertedBlob = global.coinFuncs.convertBlob(blockData, MAIN_PORT);

    return global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate).toString("hex");
}

function createMainPowVectorMap(vectors = RX0_MAIN_SHARE_VECTORS) {
    return Object.fromEntries(vectors.map((vector) => [vector.nonce, vector]));
}

async function flushShareAccumulator(check, timeout = 200) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await flushTimers();
        if (!check || check()) return;
    }
    if (!check || check()) return;
    throw new Error("Timed out waiting for deferred share flush");
}

async function requestRawJson(socket, body) {
    socket.write(`${JSON.stringify(body)}\n`);
    return await waitForSocketJson(socket);
}

test.describe("pool runtime", { concurrency: false }, () => {
test("trusted miners can take the trusted-share fast path", async () => {
    const validVector = RX0_MAIN_SHARE_VECTORS[0];
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);

        const loginReply = invokePoolMethod({
            socket,
            id: 195,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-trusted"
            }
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        state.walletTrust[MAIN_WALLET] = 1000;
        miner.trust.trust = 1000;
        miner.trust.check_height = 0;

        const submitReply = invokePoolMethod({
            socket,
            id: 196,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: validVector.nonce,
                result: validVector.expected
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.trustedShares, 1);
        assert.equal(runtime.getState().shareStats.normalShares, 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        await runtime.stop();
    }
});

test("trust check_height forces verification instead of trusting the same-height share", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);

        const loginReply = invokePoolMethod({
            socket,
            id: 197,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-trust-check-height"
            }
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        state.walletTrust[MAIN_WALLET] = 1000;
        miner.trust.trust = 1000;
        miner.trust.check_height = job.height;

        const submitReply = invokePoolMethod({
            socket,
            id: 198,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000c",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        await runtime.stop();
    }
});

test("successful main-chain block candidates are stored as blocks", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-block-store", height: 101 }),
                difficulty: 1,
                xmr_difficulty: 1,
                xtm_difficulty: Number.MAX_SAFE_INTEGER
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 199,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-block-main"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 200,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: loginReply.replies[0].result.job.job_id,
                nonce: "0000000d",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(database.blocks.length, 1);
        assert.equal(database.blocks[0].height, 101);
        assert.equal(global.support.rpcPortDaemonCalls.length >= 1, true);
    } finally {
        await runtime.stop();
    }
});

test("main-chain block storage can use the real blob constructor and block-id calculation", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-block-real-id", height: 101 }),
                difficulty: 1,
                xmr_difficulty: 1,
                xtm_difficulty: Number.MAX_SAFE_INTEGER
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const socket = {};
    const originalConstructNewBlob = global.coinFuncs.constructNewBlob;
    const originalGetBlockID = global.coinFuncs.getBlockID;

    try {
        global.coinFuncs.constructNewBlob = global.coinFuncs.__realCoinFuncs.constructNewBlob.bind(global.coinFuncs);
        global.coinFuncs.getBlockID = global.coinFuncs.__realCoinFuncs.getBlockID.bind(global.coinFuncs);

        const loginReply = invokePoolMethod({
            socket,
            id: 1991,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-block-real-id"
            }
        });

        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const activeTemplate = runtime.getState().activeBlockTemplates[""];

        const expectedTemplateBuffer = Buffer.alloc(activeTemplate.buffer.length);
        activeTemplate.buffer.copy(expectedTemplateBuffer);
        expectedTemplateBuffer.writeUInt32BE(job.extraNonce, activeTemplate.reserved_offset);

        const expectedBlockData = global.coinFuncs.__realCoinFuncs.constructNewBlob.call(
            global.coinFuncs,
            expectedTemplateBuffer,
            { nonce: "00000017", result: VALID_RESULT },
            MAIN_PORT
        );
        const expectedBlockHash = global.coinFuncs.__realCoinFuncs
            .getBlockID.call(global.coinFuncs, expectedBlockData, MAIN_PORT)
            .toString("hex");

        const submitReply = invokePoolMethod({
            socket,
            id: 1992,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000017",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(database.blocks.length, 1);
        assert.equal(database.blocks[0].payload.hash, expectedBlockHash);
    } finally {
        global.coinFuncs.constructNewBlob = originalConstructNewBlob;
        global.coinFuncs.getBlockID = originalGetBlockID;
        await runtime.stop();
    }
});

test("main-algo shares are accepted when the submitted nonce matches the real RandomX hash", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime, database } = await startHarness({ realMainPow: true, mainPowVectors });
    const socket = {};
    const validVector = RX0_MAIN_SHARE_VECTORS[0];

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 1993,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-real-main-valid"
            }
        });

        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const blockTemplate = runtime.getState().activeBlockTemplates[""];
        const result = buildMainShareResult(runtime, socket, jobId, validVector.nonce);

        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        blockTemplate.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 1994,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: validVector.nonce,
                result
            }
        });

        await flushTimers();
        assert.equal(result, validVector.expected);
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await runtime.stop();
    }
});

test("main-algo shares are rejected when the submitted nonce does not match the real RandomX hash", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime, database } = await startHarness({ realMainPow: true, mainPowVectors });
    const socket = {};
    const mismatchedVector = RX0_MAIN_SHARE_VECTORS[1];

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 1995,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-real-main-invalid"
            }
        });

        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const blockTemplate = runtime.getState().activeBlockTemplates[""];
        const result = buildMainShareResult(runtime, socket, jobId, mismatchedVector.nonce);

        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        blockTemplate.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 1996,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000001b",
                result
            }
        });

        await flushTimers();
        assert.equal(result, mismatchedVector.expected);
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(database.shares.length, 0);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
    } finally {
        await runtime.stop();
    }
});

test("main-chain candidates that only satisfy the XMR threshold submit only to the XMR daemon", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-xmr-only", height: 101 }),
                difficulty: 1
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const socket = {};

    try {
        const activeTemplate = runtime.getState().activeBlockTemplates[""];
        activeTemplate.difficulty = 1;
        activeTemplate.xmr_difficulty = 1;
        activeTemplate.xtm_difficulty = Number.MAX_SAFE_INTEGER;

        const loginReply = invokePoolMethod({
            socket,
            id: 200,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-block-xmr-only"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 201,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: loginReply.replies[0].result.job.job_id,
                nonce: "00000012",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.deepEqual(global.support.rpcPortDaemonCalls.map((entry) => entry.port), [MAIN_PORT + 2]);
        assert.equal(database.blocks.length, 1);
        assert.equal(database.altBlocks.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("main-chain candidates that satisfy both thresholds submit to both XMR and XTM daemons", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-dual-submit", height: 101 }),
                difficulty: 1
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const socket = {};

    try {
        const activeTemplate = runtime.getState().activeBlockTemplates[""];
        activeTemplate.difficulty = 1;
        activeTemplate.xmr_difficulty = 1;
        activeTemplate.xtm_difficulty = 1;
        activeTemplate.xtm_height = 701;

        const loginReply = invokePoolMethod({
            socket,
            id: 202,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-block-dual-submit"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 203,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: loginReply.replies[0].result.job.job_id,
                nonce: "00000013",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.deepEqual(global.support.rpcPortDaemonCalls.map((entry) => entry.port), [MAIN_PORT + 2, MAIN_PORT]);
        assert.equal(database.blocks.length, 1);
        assert.equal(database.altBlocks.length, 1);
        assert.equal(database.altBlocks[0].payload.port, 18144);
        assert.equal(database.altBlocks[0].payload.height, 701);
    } finally {
        await runtime.stop();
    }
});

test("low-diff main-port block candidates still submit to both daemons and notify admin", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-low-diff-submit", height: 101 }),
                difficulty: 1
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const socket = {};

    try {
        const activeTemplate = runtime.getState().activeBlockTemplates[""];
        activeTemplate.difficulty = 1;
        activeTemplate.xmr_difficulty = 2;
        activeTemplate.xtm_difficulty = 2;
        activeTemplate.xtm_height = 702;

        const loginReply = invokePoolMethod({
            socket,
            id: 204,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-block-low-diff-fallback"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 205,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: loginReply.replies[0].result.job.job_id,
                nonce: "00000014",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.deepEqual(global.support.rpcPortDaemonCalls.map((entry) => entry.port), [MAIN_PORT + 2, MAIN_PORT]);
        assert.equal(global.support.emails.some((entry) => entry.subject.includes("low diff block")), true);
        assert.equal(database.blocks.length, 1);
        assert.equal(database.altBlocks.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("successful alt-chain block candidates are stored as alt blocks", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-alt-block-store", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        await client.request({
            id: 201,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });

        const authorizeReply = await client.request({
            id: 202,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-block-alt"]
        });
        assert.equal(authorizeReply.error, null);

        const targetPush = await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const submitReply = await client.request({
            id: 203,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000002",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });

        assert.equal(typeof targetPush.params[0], "string");
        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
        assert.equal(database.altBlocks.length, 1);
        assert.equal(database.altBlocks[0].payload.port, ETH_PORT);
        assert.equal(global.support.rpcPortDaemon2Calls.length >= 1, true);
        assert.equal(global.support.rpcPortDaemonCalls.length, 0);
        assert.equal(global.support.rpcPortDaemon2Calls[0].method, "");
        assert.equal(global.support.rpcPortDaemon2Calls[0].params.method, "submitblock");
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("block submission failures reset wallet trust even when the share stays accepted", async () => {
    const { runtime } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-trust-reset", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalRpcPortDaemon2 = global.support.rpcPortDaemon2;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);
        global.support.rpcPortDaemon2 = function rpcPortDaemon2Failure(port, method, params, callback) {
            this.rpcPortDaemon2Calls.push({ port, method, params });
            callback({ result: "high-hash" }, 200);
        };

        invokePoolMethod({
            socket,
            id: 204,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 205,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-trust-reset"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");
        state.walletTrust[ETH_WALLET] = 1000;
        miner.trust.trust = 1000;
        miner.trust.check_height = 0;

        const submitReply = invokePoolMethod({
            socket,
            id: 206,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000003",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(miner.trust.trust, 1);
        assert.equal(state.walletTrust[ETH_WALLET], 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        await runtime.stop();
    }
});

test("eth-style shares are accepted through the eth hash path and persisted", async () => {
    const { runtime, database } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        invokePoolMethod({
            socket,
            id: 2061,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 2062,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-eth-hash-valid"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 2063,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "000000000018",
                notifyPush.params[1],
                "00".repeat(32)
            ],
            portData: global.config.ports[1]
        });

        await flushShareAccumulator(() => database.shares.length === 1);
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(database.shares.length, 1);
        assert.equal(database.shares[0].payload.paymentAddress, ETH_WALLET);
        assert.equal(database.shares[0].payload.port, ETH_PORT);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});

test("eth-style shares reject low difficulty hashes from the eth verify path", async () => {
    const { runtime, database } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT && this.portBlobType(blockTemplate.port, blockTemplate.block_version) === 102) {
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("ee".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        invokePoolMethod({
            socket,
            id: 2064,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 2065,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-eth-hash-low-diff"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 2066,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "000000000019",
                notifyPush.params[1],
                "00".repeat(32)
            ],
            portData: global.config.ports[1]
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(runtime.getState().shareStats.normalShares, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
        assert.equal(database.shares.length, 0);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});

test("socket parser closes connections on malformed JSON input", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write('{"id":1,"method":"login","params":{"login":"oops"}\n');
        await waitForSocketClose(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser ignores requests missing an RPC id", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write(`${JSON.stringify({ method: "login", params: { login: MAIN_WALLET, pass: "missing-id" } })}\n`);
        await assertNoSocketData(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser ignores requests missing an RPC method", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write(`${JSON.stringify({ id: 180, params: { login: MAIN_WALLET, pass: "missing-method" } })}\n`);
        await assertNoSocketData(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser destroys connections that exceed the maximum packet size", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write("a".repeat(102401));
        await waitForSocketClose(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser handles JSON requests split across multiple TCP chunks", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);
    const request = JSON.stringify({
        id: 181,
        method: "login",
        params: {
            login: MAIN_WALLET,
            pass: "split-packet"
        }
    });

    try {
        socket.write(request.slice(0, 30));
        await assertNoSocketData(socket);

        socket.write(`${request.slice(30)}\n`);
        const reply = await waitForSocketJson(socket);

        assert.equal(reply.id, 181);
        assert.equal(reply.error, null);
        assert.equal(reply.result.status, "OK");
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("unauthenticated sockets are closed after socketAuthTimeout", async () => {
    const { runtime } = await startHarness();
    const originalSocketAuthTimeout = global.config.pool.socketAuthTimeout;
    let socket;

    try {
        global.config.pool.socketAuthTimeout = 1;
        socket = await openRawSocket(MAIN_PORT);
        await waitForSocketClose(socket, 2000);
    } finally {
        global.config.pool.socketAuthTimeout = originalSocketAuthTimeout;
        if (socket) socket.destroy();
        await runtime.stop();
    }
});

test("fatal protocol replies close the socket immediately", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        const reply = await requestRawJson(socket, {
            id: 1811,
            method: "keepalive",
            params: { id: "missing-miner" }
        });

        assert.equal(reply.error.message, "Unauthenticated");
        await waitForSocketClose(socket, 500);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("repeated protocol-shape errors close the socket after the configured threshold", async () => {
    const { runtime } = await startHarness();
    const originalProtocolErrorLimit = global.config.pool.protocolErrorLimit;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.protocolErrorLimit = 3;

        socket.write(`${JSON.stringify({ method: "login", params: { login: MAIN_WALLET } })}\n`);
        await assertNoSocketData(socket);

        socket.write(`${JSON.stringify({ id: 1812, params: { login: MAIN_WALLET } })}\n`);
        await assertNoSocketData(socket);

        socket.write(`${JSON.stringify({ params: { login: MAIN_WALLET } })}\n`);
        await waitForSocketClose(socket, 1000);
    } finally {
        global.config.pool.protocolErrorLimit = originalProtocolErrorLimit;
        socket.destroy();
        await runtime.stop();
    }
});

test("unknown RPC methods close pre-share sockets immediately", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        const loginReply = await requestRawJson(socket, {
            id: 1813,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "unknown-method-pre-share"
            }
        });
        assert.equal(loginReply.error, null);

        const reply = await requestRawJson(socket, {
            id: 1814,
            method: "mining.mystery",
            params: { id: loginReply.result.id }
        });

        assert.equal(reply.error.message, "Unknown RPC method");
        await waitForSocketClose(socket, 1000);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("unknown RPC methods count toward the protocol error limit after a valid share", async () => {
    const { runtime } = await startHarness();
    const originalProtocolErrorLimit = global.config.pool.protocolErrorLimit;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.protocolErrorLimit = 2;

        const loginReply = await requestRawJson(socket, {
            id: 1815,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "unknown-method-post-share"
            }
        });
        const shareReply = await requestRawJson(socket, {
            id: 1816,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000014",
                result: VALID_RESULT
            }
        });
        assert.equal(shareReply.error, null);

        const firstUnknownReply = await requestRawJson(socket, {
            id: 1817,
            method: "mining.mystery",
            params: { id: loginReply.result.id }
        });
        assert.equal(firstUnknownReply.error.message, "Unknown RPC method");
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(socket.destroyed, false);

        const secondUnknownReply = await requestRawJson(socket, {
            id: 1818,
            method: "mining.mystery",
            params: { id: loginReply.result.id }
        });
        assert.equal(secondUnknownReply.error.message, "Unknown RPC method");
        await waitForSocketClose(socket, 1000);
    } finally {
        global.config.pool.protocolErrorLimit = originalProtocolErrorLimit;
        socket.destroy();
        await runtime.stop();
    }
});

test("per-IP connection limits close excess sockets without touching the existing connection", async () => {
    const { runtime } = await startHarness();
    const originalMaxConnectionsPerIP = global.config.pool.maxConnectionsPerIP;
    const first = await openRawSocket(MAIN_PORT);
    let second;

    try {
        global.config.pool.maxConnectionsPerIP = 1;
        second = await openRawSocket(MAIN_PORT);
        await waitForSocketClose(second, 1000);
        await assertNoSocketData(first);
    } finally {
        global.config.pool.maxConnectionsPerIP = originalMaxConnectionsPerIP;
        first.destroy();
        if (second) second.destroy();
        await runtime.stop();
    }
});

test("per-subnet connection limits close excess sockets independently from the per-IP limit", async () => {
    const { runtime } = await startHarness();
    const originalMaxConnectionsPerIP = global.config.pool.maxConnectionsPerIP;
    const originalMaxConnectionsPerSubnet = global.config.pool.maxConnectionsPerSubnet;
    const first = await openRawSocket(MAIN_PORT);
    let second;

    try {
        global.config.pool.maxConnectionsPerIP = 10;
        global.config.pool.maxConnectionsPerSubnet = 1;
        second = await openRawSocket(MAIN_PORT);
        await waitForSocketClose(second, 1000);
        await assertNoSocketData(first);
    } finally {
        global.config.pool.maxConnectionsPerIP = originalMaxConnectionsPerIP;
        global.config.pool.maxConnectionsPerSubnet = originalMaxConnectionsPerSubnet;
        first.destroy();
        if (second) second.destroy();
        await runtime.stop();
    }
});

test("closing a miner socket removes it from the active miner map", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 182,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "close-removes-miner"
            }
        });

        assert.equal(loginReply.error, null);
        assert.equal(runtime.getState().activeMiners.size, 1);

        await client.close();
        await flushTimers();

        assert.equal(runtime.getState().activeMiners.size, 0);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("invalid logins are throttled by login value instead of ip or agent", async () => {
    const { runtime } = await startHarness();
    const originalWorkerId = process.env.WORKER_ID;

    try {
        process.env.WORKER_ID = "1";

        invokePoolMethod({
            method: "login",
            params: {
                login: "bad-wallet-one",
                pass: "x",
                agent: "BadAgent/1"
            },
            ip: "10.0.0.91"
        });
        invokePoolMethod({
            method: "login",
            params: {
                login: "bad-wallet-one",
                pass: "x",
                agent: "BadAgent/2"
            },
            ip: "10.0.0.92"
        });

        const state = runtime.getState();
        assert.deepEqual(Object.keys(state.minerAgents), []);
        assert.deepEqual(Object.keys(state.lastMinerLogTime), ["invalid-address-login:bad-wallet-one"]);
        assert.equal("bad-wallet-one" in state.lastMinerLogTime, false);
        assert.equal("invalid-login:10.0.0.91" in state.lastMinerLogTime, false);
        assert.equal("invalid-login:10.0.0.92" in state.lastMinerLogTime, false);
    } finally {
        if (typeof originalWorkerId === "undefined") delete process.env.WORKER_ID;
        else process.env.WORKER_ID = originalWorkerId;
        await runtime.stop();
    }
});

test("banned payout logins are throttled by payout across IPs", async () => {
    const { runtime } = await startHarness();
    const originalConsoleLog = console.log;
    const loggedMessages = [];

    try {
        runtime.getState().bannedAddresses[MAIN_WALLET] = "manual blocklist";
        console.log = function patchedConsoleLog(message) {
            loggedMessages.push(message);
        };

        invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-one"
            },
            ip: "10.0.0.92"
        });
        invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-two"
            },
            ip: "10.0.0.93"
        });

        const state = runtime.getState();
        assert.deepEqual(Object.keys(state.lastMinerLogTime), ["banned-login:" + MAIN_WALLET]);
        assert.equal("invalid-login:10.0.0.92" in state.lastMinerLogTime, false);
        assert.equal("invalid-login:10.0.0.93" in state.lastMinerLogTime, false);
        assert.equal(loggedMessages.length, 1);
        assert.match(loggedMessages[0], /Permanently banned payment address/);
    } finally {
        console.log = originalConsoleLog;
        await runtime.stop();
    }
});

test("share-path log updates do not clear existing invalid login throttle keys", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            method: "login",
            params: {
                login: "999",
                pass: "999orr"
            },
            ip: "10.0.0.91"
        });

        const loginReply = invokePoolMethod({
            socket,
            id: 1190,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-low-diff-log"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;

        const submitReply = invokePoolMethod({
            socket,
            id: 1191,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000a",
                result: "ff".repeat(32)
            }
        });

        assert.equal(submitReply.replies[0].error, "Low difficulty share");
        assert.equal("invalid-address-login:999" in runtime.getState().lastMinerLogTime, true);
        assert.equal(MAIN_WALLET in runtime.getState().lastMinerLogTime, true);
    } finally {
        await runtime.stop();
    }
});

test("trust state is created only after an accepted share", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;

        const loginReply = invokePoolMethod({
            socket,
            id: 191,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-trust-lazy-init"
            }
        });

        const stateAfterLogin = runtime.getState();
        const jobId = loginReply.replies[0].result.job.job_id;
        assert.equal(MAIN_WALLET in stateAfterLogin.walletTrust, false);
        assert.equal(MAIN_WALLET in stateAfterLogin.walletLastSeeTime, false);

        const submitReply = invokePoolMethod({
            socket,
            id: 192,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000001d",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(MAIN_WALLET in runtime.getState().walletTrust, true);
        assert.equal(MAIN_WALLET in runtime.getState().walletLastSeeTime, true);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        await runtime.stop();
    }
});

test("login bookkeeping prunes stale notification timestamps", async () => {
    const { runtime } = await startHarness();

    try {
        const staleTime = Date.now() - 48 * 60 * 60 * 1000;
        const state = runtime.getState();
        state.lastMinerNotifyTime["stale-wallet"] = staleTime;
        state.notifyAddresses[MAIN_WALLET] = "Update required";

        const loginReply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker:miner@example.com"
            }
        });

        assert.deepEqual(loginReply.finals, [{
            error: "Update required (miner will connect after several attempts)",
            timeout: undefined
        }]);
        assert.equal("stale-wallet" in runtime.getState().lastMinerNotifyTime, false);
        assert.equal(MAIN_WALLET in runtime.getState().lastMinerNotifyTime, true);
    } finally {
        await runtime.stop();
    }
});

test("email user records are created only after the first accepted share", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime, mysql } = await startHarness({ realMainPow: true, mainPowVectors });
    const socket = {};
    const validVector = RX0_MAIN_SHARE_VECTORS[0];

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 1988,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker:miner@example.com"
            }
        });

        const loginUserQueries = mysql.queries.filter((entry) => entry.sql.includes("FROM users") || entry.sql.includes("INSERT INTO users"));
        assert.equal(loginUserQueries.length, 0);

        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const blockTemplate = runtime.getState().activeBlockTemplates[""];
        const result = buildMainShareResult(runtime, socket, jobId, validVector.nonce);

        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        blockTemplate.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 1989,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: validVector.nonce,
                result
            }
        });

        await flushTimers();
        await flushTimers();

        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        const userQueries = mysql.queries.filter((entry) => entry.sql.includes("FROM users") || entry.sql.includes("INSERT INTO users"));
        assert.equal(userQueries.filter((entry) => entry.sql.includes("FROM users")).length, 1);
        assert.equal(userQueries.filter((entry) => entry.sql.includes("INSERT INTO users")).length, 1);
        assert.equal(MAIN_WALLET in runtime.getState().walletLastCheckTime, true);
    } finally {
        await runtime.stop();
    }
});

test("throttled shares do not retain duplicate nonce entries", async () => {
    const { runtime } = await startHarness();
    const originalThrottlePerSec = global.config.pool.minerThrottleSharePerSec;
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const socket = {};

    try {
        global.config.pool.minerThrottleSharePerSec = 0;
        global.config.pool.trustedMiners = false;

        const loginReply = invokePoolMethod({
            socket,
            id: 193,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-throttle-nonce-cache"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);

        const firstReply = invokePoolMethod({
            socket,
            id: 194,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000020",
                result: VALID_RESULT
            }
        });

        const secondReply = invokePoolMethod({
            socket,
            id: 195,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000020",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(firstReply.replies, [{
            error: "Throttled down share submission (please increase difficulty)",
            result: undefined
        }]);
        assert.deepEqual(secondReply.replies, [{
            error: "Throttled down share submission (please increase difficulty)",
            result: undefined
        }]);
        assert.equal(job.submissions.size, 0);
    } finally {
        global.config.pool.minerThrottleSharePerSec = originalThrottlePerSec;
        global.config.pool.trustedMiners = originalTrustedMiners;
        await runtime.stop();
    }
});

test("expired shares do not retain unique nonce entries", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 196,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-expired-nonce-cache"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const originalJob = miner.validJobs.toarray().find((job) => job.id === jobId);

        for (let height = 102; height <= 113; height += 1) {
            runtime.setTemplate(createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: `main-expired-nonce-${height}`,
                height
            }));
        }

        miner.validJobs.enq(originalJob);

        const firstReply = invokePoolMethod({
            socket,
            id: 197,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000021",
                result: VALID_RESULT
            }
        });

        const secondReply = invokePoolMethod({
            socket,
            id: 198,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000022",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(firstReply.replies, [{ error: "Block expired", result: undefined }]);
        assert.deepEqual(secondReply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
        assert.equal(originalJob.submissions.size, 0);
    } finally {
        await runtime.stop();
    }
});

test("expired shares close zero-trust miners before any valid share is submitted", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 1981,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-expired-close"
            }
        });
        const minerId = loginReply.result.id;
        const miner = runtime.getState().activeMiners.get(minerId);
        const jobId = loginReply.result.job.job_id;
        const originalJob = miner.validJobs.toarray().find((job) => job.id === jobId);

        for (let height = 102; height <= 113; height += 1) {
            runtime.setTemplate(createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: `main-expired-close-${height}`,
                height
            }));
        }

        miner.validJobs.enq(originalJob);

        const submitReply = await client.request({
            id: 1982,
            method: "submit",
            params: {
                id: minerId,
                job_id: jobId,
                nonce: "00000023",
                result: VALID_RESULT
            }
        });

        assert.equal(submitReply.error.message, "Block expired");
        await waitForSocketClose(client.socket, 1000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("jobs reject new nonces after reaching the tracked submission cap without evicting old ones", async () => {
    const { runtime } = await startHarness();
    const originalThrottlePerSec = global.config.pool.minerThrottleSharePerSec;
    const originalThrottleWindow = global.config.pool.minerThrottleShareWindow;
    const socket = {};

    try {
        global.config.pool.minerThrottleSharePerSec = 2;
        global.config.pool.minerThrottleShareWindow = 5;

        const loginReply = invokePoolMethod({
            socket,
            id: 199,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-submission-cap"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const trackedSubmissionLimit = global.config.pool.minerThrottleShareWindow * global.config.pool.minerThrottleSharePerSec * 100;
        job.submissions = new Map();
        for (let index = 0; index < trackedSubmissionLimit; ++index) {
            job.submissions.set(index.toString(16).padStart(8, "0"), 1);
        }

        const submitReply = invokePoolMethod({
            socket,
            id: 200,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "fffffff0",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{
            error: "Too many share submissions for the current job. Wait for a new job.",
            result: undefined
        }]);
        assert.equal(job.submissions.size, trackedSubmissionLimit);
        assert.equal(job.submissions.has("00000000"), true);
        assert.equal(job.submissions.has("fffffff0"), false);
    } finally {
        global.config.pool.minerThrottleSharePerSec = originalThrottlePerSec;
        global.config.pool.minerThrottleShareWindow = originalThrottleWindow;
        await runtime.stop();
    }
});

test("proxy-tracked jobs use the larger tracked submission cap", async () => {
    const { runtime } = await startHarness();
    const originalThrottlePerSec = global.config.pool.minerThrottleSharePerSec;
    const originalThrottleWindow = global.config.pool.minerThrottleShareWindow;
    const socket = {};

    try {
        global.config.pool.minerThrottleSharePerSec = 2;
        global.config.pool.minerThrottleShareWindow = 5;

        const loginReply = invokePoolMethod({
            socket,
            id: 201,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "proxy-submission-cap",
                agent: "xmrig-proxy/6.0.0"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const trackedSubmissionLimit = global.config.pool.minerThrottleShareWindow * global.config.pool.minerThrottleSharePerSec * 1000;

        assert.equal(miner.proxyMinerName, MAIN_WALLET);
        assert.equal(MAIN_WALLET in runtime.getState().proxyMiners, true);

        job.submissions = new Map();
        for (let index = 0; index < trackedSubmissionLimit - 1; ++index) {
            job.submissions.set(index.toString(16).padStart(8, "0"), 1);
        }

        const submitReply = invokePoolMethod({
            socket,
            id: 202,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "fffffff0",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{
            error: null,
            result: { status: "OK" }
        }]);
        assert.equal(job.submissions.size, trackedSubmissionLimit);
        assert.equal(job.submissions.has("fffffff0"), true);

        const cappedReply = invokePoolMethod({
            socket,
            id: 203,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "fffffff1",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(cappedReply.replies, [{
            error: "Too many share submissions for the current job. Wait for a new job.",
            result: undefined
        }]);
        assert.equal(job.submissions.has("fffffff1"), false);
    } finally {
        global.config.pool.minerThrottleSharePerSec = originalThrottlePerSec;
        global.config.pool.minerThrottleShareWindow = originalThrottleWindow;
        await runtime.stop();
    }
});

test("successful logins prune stale tracked agents and cap stored agent length", async () => {
    const { runtime } = await startHarness();
    const originalWorkerId = process.env.WORKER_ID;

    try {
        process.env.WORKER_ID = "1";
        runtime.getState().minerAgents["stale-agent"] = Date.now() - 48 * 60 * 60 * 1000;

        const longAgent = "Agent/" + "x".repeat(400);
        const loginReply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "agent-track",
                agent: longAgent
            }
        });

        assert.equal(loginReply.replies[0].error, null);
        assert.equal(runtime.getState().activeMiners.size, 1);
        assert.deepEqual(Object.keys(runtime.getState().minerAgents), [longAgent.substring(0, 255)]);
    } finally {
        if (typeof originalWorkerId === "undefined") delete process.env.WORKER_ID;
        else process.env.WORKER_ID = originalWorkerId;
        await runtime.stop();
    }
});

test("ban threshold removes miners that cross the invalid share percentage", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;
    const originalBanThreshold = global.config.pool.banThreshold;
    const originalBanPercent = global.config.pool.banPercent;
    const socket = {};
    const ip = "10.0.0.88";

    try {
        cluster.isMaster = false;
        global.config.pool.banThreshold = 3;
        global.config.pool.banPercent = 50;

        const loginReply = invokePoolMethod({
            socket,
            id: 183,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "ban-threshold"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        invokePoolMethod({
            socket,
            id: 184,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000e",
                result: VALID_RESULT
            },
            ip
        });

        invokePoolMethod({
            socket,
            id: 185,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "not-a-nonce",
                result: VALID_RESULT
            },
            ip
        });

        const secondBadShare = invokePoolMethod({
            socket,
            id: 186,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "still-not-a-nonce",
                result: VALID_RESULT
            },
            ip
        });

        assert.deepEqual(secondBadShare.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), false);
        assert.equal(runtime.getState().bannedTmpIPs[ip], 1);

        const reloginReply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "ban-threshold-retry"
            },
            ip
        });
        assert.deepEqual(reloginReply.finals, [{
            error: "New connections from this IP address are temporarily suspended from mining (10 minutes max)",
            timeout: undefined
        }]);
    } finally {
        cluster.isMaster = originalIsMaster;
        global.config.pool.banThreshold = originalBanThreshold;
        global.config.pool.banPercent = originalBanPercent;
        await runtime.stop();
    }
});

test("ban counters reset instead of banning when invalid share percentage stays below the threshold", async () => {
    const { runtime } = await startHarness();
    const originalBanThreshold = global.config.pool.banThreshold;
    const originalBanPercent = global.config.pool.banPercent;
    const socket = {};

    try {
        global.config.pool.banThreshold = 2;
        global.config.pool.banPercent = 60;

        const loginReply = invokePoolMethod({
            socket,
            id: 187,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "ban-reset"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;

        invokePoolMethod({
            socket,
            id: 188,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000f",
                result: VALID_RESULT
            }
        });

        invokePoolMethod({
            socket,
            id: 189,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "bad-reset-nonce",
                result: VALID_RESULT
            }
        });

        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), true);
        assert.equal(miner.validShares, 0);
        assert.equal(miner.invalidShares, 0);
    } finally {
        global.config.pool.banThreshold = originalBanThreshold;
        global.config.pool.banPercent = originalBanPercent;
        await runtime.stop();
    }
});

test("whitelisted miners are not banned for invalid shares", async () => {
    const { runtime } = await startHarness();
    const socket = {};
    const ip = "10.0.0.90";

    try {
        runtime.getState().ip_whitelist[ip] = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 190,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "whitelist-bypass"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const badShareReply = invokePoolMethod({
            socket,
            id: 191,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "not-whitelisted-nonce",
                result: VALID_RESULT
            },
            ip
        });

        assert.deepEqual(badShareReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), true);
        assert.equal(runtime.getState().bannedTmpIPs[ip], undefined);
    } finally {
        await runtime.stop();
    }
});

test("registerPool stores the pool row and all configured ports", async () => {
    const { runtime, mysql } = await startHarness();

    try {
        poolModule.registerPool();
        await flushTimers();
        await flushTimers();

        assert.equal(mysql.queries[0].sql.includes("INSERT INTO pools"), true);
        assert.equal(mysql.queries[1].sql.includes("DELETE FROM ports"), true);
        assert.equal(mysql.queries.filter((entry) => entry.sql.includes("INSERT INTO ports")).length, 2);
    } finally {
        await runtime.stop();
    }
});

test("messageHandler sendRemote queues the payload in master mode", async () => {
    const { runtime, database } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = true;
        poolModule.messageHandler({ type: "sendRemote", body: "abcd" });

        assert.equal(database.sendQueue.length, 1);
        assert.equal(database.sendQueue[0].body.equals(Buffer.from("abcd", "hex")), true);
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("messageHandler newBlockTemplate updates the active template", async () => {
    const { runtime } = await startHarness();

    try {
        poolModule.messageHandler({
            type: "newBlockTemplate",
            data: createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: "main-template-message-handler",
                height: 333
            })
        });

        assert.equal(runtime.getState().activeBlockTemplates[""].height, 333);
    } finally {
        await runtime.stop();
    }
});

test("templateUpdate2 rejects blobless CCX templates before they reach BlockTemplate", async () => {
    const { runtime } = await startHarness();
    const originalGetPortBlockTemplate = global.coinFuncs.getPortBlockTemplate;
    const originalSetTimeout = global.setTimeout;
    const ccxPort = 16000;
    let requestCount = 0;

    try {
        poolModule.setTestCoinHashFactor("CCX", 1);

        global.coinFuncs.getPortBlockTemplate = function getPortBlockTemplate(_port, callback) {
            requestCount += 1;
            callback({
                block_header: {
                    height: 2046248,
                    major_version: 8,
                    minor_version: 0,
                    nonce: 3221306306,
                    hash: "80397cb2f994510668ae5489ab17f2e6a21c838f35eb02db40dec799b008c0ab",
                    prev_hash: "2dda11c301cf640a502e0d9722df6ee35e9b246e654d6cb32b212ef9c8b5a3d6",
                    timestamp: 1775567137,
                    difficulty: 43600000,
                    reward: 6000000
                },
                status: "OK"
            });
        };
        global.setTimeout = function immediateTimeout(fn, _delay, ...args) {
            fn(...args);
            return 0;
        };

        poolModule.templateUpdate2(
            "CCX",
            ccxPort,
            true,
            false,
            1,
            false,
            { height: 2046248, hash: "80397cb2f994510668ae5489ab17f2e6a21c838f35eb02db40dec799b008c0ab" }
        );

        assert.equal(requestCount, 3);
        assert.equal(runtime.getState().activeBlockTemplates.CCX, undefined);
    } finally {
        global.coinFuncs.getPortBlockTemplate = originalGetPortBlockTemplate;
        global.setTimeout = originalSetTimeout;
        await runtime.stop();
    }
});

test("setNewCoinHashFactor marks matching miners for extra verification on hash-factor changes", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        invokePoolMethod({
            socket,
            id: 192,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "coin-hash-factor-refresh"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);

        poolModule.setNewCoinHashFactor(true, "", 2, 777);

        assert.equal(miner.trust.check_height, 777);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        await runtime.stop();
    }
});

test("messageHandler minerPortCount stores the reported per-port counts in master mode", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = true;
        poolModule.messageHandler({
            type: "minerPortCount",
            data: {
                worker_id: 7,
                ports: { [MAIN_PORT]: 2, [ETH_PORT]: 1 }
            }
        });

        assert.deepEqual(runtime.getState().minerCount[7], { [MAIN_PORT]: 2, [ETH_PORT]: 1 });
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("retargetMiners updates miner counts and pushes a new job when difficulty changes", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 193,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "retarget"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);

        loginReply.pushes.length = 0;
        miner.calcNewDiff = () => miner.difficulty + 10;

        poolModule.retargetMiners();

        assert.equal(loginReply.pushes.length, 1);
        assert.equal(loginReply.pushes[0].method, "job");
        assert.equal(runtime.getState().minerCount[MAIN_PORT], 1);
    } finally {
        await runtime.stop();
    }
});

test("checkAliveMiners removes miners that exceed the timeout", async () => {
    const { runtime } = await startHarness();
    const originalMinerTimeout = global.config.pool.minerTimeout;
    const socket = {};

    try {
        global.config.pool.minerTimeout = 1;

        invokePoolMethod({
            socket,
            id: 194,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "timeout-removal"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        miner.hasSubmittedValidShare = true;
        miner.lastProtocolActivity = Date.now() - 5000;
        miner.lastValidShareTimeMs = Date.now() - 5000;
        miner.lastContact = Date.now() - 5000;

        poolModule.checkAliveMiners();

        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), false);
    } finally {
        global.config.pool.minerTimeout = originalMinerTimeout;
        await runtime.stop();
    }
});

test("checkAliveMiners closes the underlying socket for timed-out miners", async () => {
    const { runtime } = await startHarness();
    const originalMinerTimeout = global.config.pool.minerTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1941,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "timeout-socket-close"
            }
        });
        const miner = runtime.getState().activeMiners.get(loginReply.result.id);
        miner.hasSubmittedValidShare = true;
        miner.lastProtocolActivity = Date.now() - 5000;
        miner.lastValidShareTimeMs = Date.now() - 5000;
        miner.lastContact = Date.now() - 5000;

        poolModule.checkAliveMiners();

        await waitForSocketClose(socket, 1000);
        assert.equal(runtime.getState().activeMiners.has(loginReply.result.id), false);
    } finally {
        global.config.pool.minerTimeout = originalMinerTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("first-share timeout closes authenticated miners that never submit a valid share", async () => {
    const { runtime } = await startHarness();
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1942,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "no-share-timeout"
            }
        });

        assert.equal(loginReply.error, null);
        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.has(loginReply.result.id), false);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("claimed extranonce sessions use the shorter first-share timeout", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7] });
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const originalClaimedExtranonceFirstShareTimeout = global.config.pool.claimedExtranonceFirstShareTimeout;
    const socket = await openRawSocket(ETH_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 60;
        global.config.pool.claimedExtranonceFirstShareTimeout = 1;
        const authorizeReply = await requestRawJson(socket, {
            id: 19425,
            method: "mining.authorize",
            params: [ETH_WALLET, "claimed-extranonce-timeout"]
        });

        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);
        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.size, 0);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        global.config.pool.claimedExtranonceFirstShareTimeout = originalClaimedExtranonceFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("keepalive traffic does not bypass the first-share timeout", async () => {
    const { runtime } = await startHarness();
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1943,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "keepalive-only"
            }
        });
        const minerId = loginReply.result.id;

        await new Promise((resolve) => setTimeout(resolve, 250));
        const firstKeepalive = await requestRawJson(socket, {
            id: 1944,
            method: "keepalive",
            params: { id: minerId }
        });
        assert.equal(firstKeepalive.result.status, "KEEPALIVED");

        await new Promise((resolve) => setTimeout(resolve, 250));
        const secondKeepalive = await requestRawJson(socket, {
            id: 1945,
            method: "keepalive",
            params: { id: minerId }
        });
        assert.equal(secondKeepalive.result.status, "KEEPALIVED");

        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("invalid job id spam does not keep an authenticated miner alive", async () => {
    const { runtime } = await startHarness();
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1946,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "bad-job-id-spam"
            }
        });
        const minerId = loginReply.result.id;

        await new Promise((resolve) => setTimeout(resolve, 250));
        const firstSubmit = await requestRawJson(socket, {
            id: 1947,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-1",
                nonce: "00000001",
                result: VALID_RESULT
            }
        });
        assert.equal(firstSubmit.error.message, "Invalid job id");

        await new Promise((resolve) => setTimeout(resolve, 250));
        const secondSubmit = await requestRawJson(socket, {
            id: 1948,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-2",
                nonce: "00000002",
                result: VALID_RESULT
            }
        });
        assert.equal(secondSubmit.error.message, "Invalid job id");

        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("repeated invalid job ids close the socket before the first valid share", async () => {
    const { runtime } = await startHarness();
    const originalInvalidJobIdLimitBeforeShare = global.config.pool.invalidJobIdLimitBeforeShare;
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.invalidJobIdLimitBeforeShare = 2;
        global.config.pool.minerFirstShareTimeout = 60;

        const loginReply = await requestRawJson(socket, {
            id: 1949,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "bad-job-id-limit"
            }
        });
        const minerId = loginReply.result.id;

        const firstSubmit = await requestRawJson(socket, {
            id: 1950,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-1",
                nonce: "00000001",
                result: VALID_RESULT
            }
        });
        assert.equal(firstSubmit.error.message, "Invalid job id");

        const secondSubmit = await requestRawJson(socket, {
            id: 1951,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-2",
                nonce: "00000002",
                result: VALID_RESULT
            }
        });
        assert.equal(secondSubmit.error.message, "Invalid job id");

        await waitForSocketClose(socket, 1000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        global.config.pool.invalidJobIdLimitBeforeShare = originalInvalidJobIdLimitBeforeShare;
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("deferred share flush preserves trustedShare=false for verified shares", async () => {
    const { runtime, database } = await startHarness();
    const originalShareAccTime = global.config.pool.shareAccTime;
    const socket = {};

    try {
        global.config.pool.shareAccTime = 0.001;

        const loginReply = invokePoolMethod({
            socket,
            id: 1950,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-deferred-share-flush"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 1951,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: loginReply.replies[0].result.job.job_id,
                nonce: "00000018",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);

        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushTimers();

        assert.equal(database.shares.length, 1);
        assert.equal(database.shares[0].payload.trustedShare, false);
    } finally {
        global.config.pool.shareAccTime = originalShareAccTime;
        await runtime.stop();
    }
});
});
