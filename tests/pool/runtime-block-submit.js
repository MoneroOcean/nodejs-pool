"use strict";

const test = require("node:test");

const {
    assert,
    crypto,
    fs,
    fsp,
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ALT_WALLET,
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
    poolModule,
    RX0_MAIN_SHARE_VECTORS,
    ZERO_RESULT,
    buildMainShareResult,
    createMainPowVectorMap,
    flushShareAccumulator,
    enableBlockSubmitTestMode,
    disableBlockSubmitTestMode,
    createBlockSubmitTemplates,
    createFrozenTime,
    setBlockSubmitTestMarker,
    withBlockSubmitTestMode,
    getLoginJobId,
    loginMainMiner,
    submitMainBlockCandidate,
    authorizeEthMiner,
    submitEthBlockCandidate,
    submitEthBlockCandidateWithClient,
    withCapturedConsoleError,
    requestRawJson
} = require("./runtime-helpers.js");

test.describe("pool runtime: block submit", { concurrency: false }, () => {
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

test("first-share bogus block candidates are verified locally before any daemon submit", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime, database } = await startHarness({ realMainPow: true, mainPowVectors });
    const socket = {};
    const mismatchedVector = RX0_MAIN_SHARE_VECTORS[1];

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 1997,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-first-block-candidate-check"
            }
        });

        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const blockTemplate = runtime.getState().activeBlockTemplates[""];
        const result = buildMainShareResult(runtime, socket, jobId, mismatchedVector.nonce);

        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        blockTemplate.difficulty = 1;
        blockTemplate.xmr_difficulty = 1;
        blockTemplate.xtm_difficulty = Number.MAX_SAFE_INTEGER;

        const submitReply = invokePoolMethod({
            socket,
            id: 1998,
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
        assert.equal(global.support.rpcPortDaemonCalls.length, 0);
        assert.equal(global.support.rpcPortDaemon2Calls.length, 0);
        assert.equal(global.support.emails.length, 0);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
    } finally {
        await runtime.stop();
    }
});

test("block-submit test mode caches marker changes for five seconds", async () => {
    const { runtime } = await startHarness();
    const markerPath = poolModule.getBlockSubmitTestModeState().markerPath;
    const clock = createFrozenTime(1700000000000);

    try {
        await disableBlockSubmitTestMode(markerPath);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), false);
        await setBlockSubmitTestMarker(markerPath, true);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), false);
        clock.advance(5001);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), true);
        await setBlockSubmitTestMarker(markerPath, false);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), true);
        clock.advance(5001);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), false);
    } finally {
        clock.restore();
        await disableBlockSubmitTestMode(markerPath);
        await runtime.stop();
    }
});

test("startTestRuntime removes a stale block-submit marker file on startup", async () => {
    const markerPath = poolModule.getBlockSubmitTestModeState().markerPath;
    const clock = createFrozenTime(1700000205000);
    let runtime;

    try {
        await setBlockSubmitTestMarker(markerPath, true);
        clock.advance(5001);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), true);
        ({ runtime } = await startHarness());
        assert.equal(fs.existsSync(markerPath), false);
        const modeState = poolModule.getBlockSubmitTestModeState();
        assert.equal(modeState.enabled, false);
        assert.equal(modeState.lastCheckAt, 0);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), false);
    } finally {
        clock.restore();
        await disableBlockSubmitTestMode(markerPath);
        if (runtime) await runtime.stop();
    }
});

test("block-submit test mode lets a fresh wallet reach daemon submit without sending failure email", async () => {
    const { runtime, database } = await startHarness({
        templates: createBlockSubmitTemplates("main-block-submit-test-mode")
    });
    const socket = {};
    const originalRpcPortDaemon = global.support.rpcPortDaemon;

    try {
        await withBlockSubmitTestMode(async () => {
            global.support.rpcPortDaemon = function rpcPortDaemonFailure(port, method, params, callback) {
                this.rpcPortDaemonCalls.push({ port, method, params });
                callback({ result: "high-hash" }, 200);
            };

            const loginReply = loginMainMiner(socket, 3001, "worker-block-submit-test-mode");
            const submitReply = submitMainBlockCandidate(socket, 3002, getLoginJobId(loginReply));

            await flushTimers();
            assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
            assert.equal(global.support.rpcPortDaemonCalls.length, 1);
            assert.equal(global.support.rpcPortDaemonCalls[0].method, "submitblock");
            assert.equal(global.support.emails.length, 0);
            assert.equal(database.blocks.length, 0);
            assert.equal(database.altBlocks.length, 0);
            assert.equal(database.shares.length, 0);
            assert.equal(MAIN_WALLET in runtime.getState().walletTrust, false);
        });
    } finally {
        global.support.rpcPortDaemon = originalRpcPortDaemon;
        await runtime.stop();
    }
});

test("block-submit test mode lets eth-style submits reach daemon with an appended synthetic result", async () => {
    const { runtime } = await startHarness();
    const socket = {};
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalRpcPortDaemon2 = global.support.rpcPortDaemon2;

    try {
        await withBlockSubmitTestMode(async () => {
            global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
                if (port === ETH_PORT) return 102;
                return originalPortBlobType.call(this, port);
            };
            runtime.getState().activeBlockTemplates.ETH.hash = "34".repeat(32);
            global.support.rpcPortDaemon2 = function rpcPortDaemonFailure(port, method, params, callback) {
                this.rpcPortDaemon2Calls.push({ port, method, params });
                callback({ error: "test-fail" }, 200);
            };

            const notifyPush = authorizeEthMiner(socket, 3004, "worker-block-submit-eth");
            const submitReply = submitEthBlockCandidate(socket, 3005, notifyPush);

            await flushTimers();
            assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
            assert.equal(global.support.rpcPortDaemon2Calls.length, 1);
            assert.equal(global.support.rpcPortDaemon2Calls[0].params.method, "eth_submitWork");
            assert.equal(global.support.emails.length, 0);
        });
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        await runtime.stop();
    }
});

test("block-submit test mode ignores synthetic-result bypass requests from non-loopback miners", async () => {
    const { runtime } = await startHarness({
        templates: createBlockSubmitTemplates("main-block-submit-test-non-loopback")
    });
    const socket = {};

    try {
        await withBlockSubmitTestMode(async () => {
            const loginReply = loginMainMiner(socket, 30055, "worker-block-submit-remote", { ip: "10.9.8.7" });
            const submitReply = submitMainBlockCandidate(socket, 30056, getLoginJobId(loginReply), {
                ip: "10.9.8.7",
                nonce: "0000002d",
                extraParams: { block_submit_test_result: ZERO_RESULT }
            });

            await flushTimers();
            assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
            assert.equal(global.support.rpcPortDaemonCalls.length, 0);
            assert.equal(global.support.emails.length, 0);
        });
    } finally {
        await runtime.stop();
    }
});
});
