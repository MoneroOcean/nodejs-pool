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
} = require("../common/runtime-helpers.js");

test.describe("pool runtime: daemon submits", { concurrency: false }, () => {
test("block-submit test mode stops daemon-first submits once the marker is removed", async () => {
    const { runtime } = await startHarness({
        templates: createBlockSubmitTemplates("main-block-submit-test-mode-off")
    });
    const socketEnabled = {};
    const socketDisabled = {};
    const clock = createFrozenTime(1700000100000);
    const originalRpcPortDaemon = global.support.rpcPortDaemon;
    const markerPath = poolModule.getBlockSubmitTestModeState().markerPath;

    try {
        global.support.rpcPortDaemon = function rpcPortDaemonFailure(port, method, params, callback) {
            this.rpcPortDaemonCalls.push({ port, method, params });
            callback({ result: "high-hash" }, 200);
        };

        await setBlockSubmitTestMarker(markerPath, true);
        clock.advance(5001);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), true);

        const enabledLoginReply = loginMainMiner(socketEnabled, 3003, "worker-block-submit-enabled");
        const enabledSubmitReply = submitMainBlockCandidate(socketEnabled, 3006, getLoginJobId(enabledLoginReply), { nonce: "0000002b" });

        await flushTimers();
        assert.deepEqual(enabledSubmitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(global.support.rpcPortDaemonCalls.length, 1);

        await setBlockSubmitTestMarker(markerPath, false);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), true);
        clock.advance(5001);
        assert.equal(poolModule.refreshBlockSubmitTestMode(), false);

        const disabledLoginReply = loginMainMiner(socketDisabled, 3005, "worker-block-submit-disabled", { login: ALT_WALLET });
        const disabledSubmitReply = submitMainBlockCandidate(socketDisabled, 3007, getLoginJobId(disabledLoginReply), { nonce: "0000002c" });

        await flushTimers();
        assert.deepEqual(disabledSubmitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(global.support.rpcPortDaemonCalls.length, 1);
    } finally {
        clock.restore();
        global.support.rpcPortDaemon = originalRpcPortDaemon;
        await disableBlockSubmitTestMode(markerPath);
        await runtime.stop();
    }
});

test("wallet trust enables daemon-first block submit for a new same-wallet session", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime } = await startHarness({ realMainPow: true, mainPowVectors });
    const acceptedSocket = {};
    const candidateSocket = {};
    const validVector = RX0_MAIN_SHARE_VECTORS[0];
    const mismatchedVector = RX0_MAIN_SHARE_VECTORS[1];

    try {
        const acceptedLoginReply = invokePoolMethod({
            socket: acceptedSocket,
            id: 1999,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-wallet-trust-seed"
            }
        });

        const acceptedJobId = acceptedLoginReply.replies[0].result.job.job_id;
        const acceptedMiner = runtime.getState().activeMiners.get(acceptedSocket.miner_id);
        const acceptedJob = acceptedMiner.validJobs.toarray().find((entry) => entry.id === acceptedJobId);
        const acceptedBlockTemplate = runtime.getState().activeBlockTemplates[""];
        const acceptedResult = buildMainShareResult(runtime, acceptedSocket, acceptedJobId, validVector.nonce);

        acceptedJob.difficulty = 1;
        acceptedJob.rewarded_difficulty = 1;
        acceptedJob.rewarded_difficulty2 = 1;
        acceptedJob.norm_diff = 1;
        acceptedBlockTemplate.difficulty = 1000;

        const acceptedSubmitReply = invokePoolMethod({
            socket: acceptedSocket,
            id: 2000,
            method: "submit",
            params: {
                id: acceptedSocket.miner_id,
                job_id: acceptedJobId,
                nonce: validVector.nonce,
                result: acceptedResult
            }
        });

        await flushTimers();
        assert.deepEqual(acceptedSubmitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().walletTrust[MAIN_WALLET] > 0, true);
        assert.equal(global.support.rpcPortDaemonCalls.length, 0);

        const candidateLoginReply = invokePoolMethod({
            socket: candidateSocket,
            id: 2001,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-wallet-trust-candidate"
            }
        });

        const candidateJobId = candidateLoginReply.replies[0].result.job.job_id;
        const candidateMiner = runtime.getState().activeMiners.get(candidateSocket.miner_id);
        const candidateJob = candidateMiner.validJobs.toarray().find((entry) => entry.id === candidateJobId);
        const candidateBlockTemplate = runtime.getState().activeBlockTemplates[""];
        const candidateResult = buildMainShareResult(runtime, candidateSocket, candidateJobId, mismatchedVector.nonce);

        candidateJob.difficulty = 2;
        candidateJob.rewarded_difficulty = 2;
        candidateJob.rewarded_difficulty2 = 2;
        candidateJob.norm_diff = 2;
        candidateBlockTemplate.difficulty = 1;
        candidateBlockTemplate.xmr_difficulty = 1;
        candidateBlockTemplate.xtm_difficulty = Number.MAX_SAFE_INTEGER;

        const candidateSubmitReply = invokePoolMethod({
            socket: candidateSocket,
            id: 2002,
            method: "submit",
            params: {
                id: candidateSocket.miner_id,
                job_id: candidateJobId,
                nonce: "0000001b",
                result: candidateResult
            }
        });

        await flushTimers();
        assert.deepEqual(candidateSubmitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(global.support.rpcPortDaemonCalls.length, 1);
        assert.equal(global.support.rpcPortDaemonCalls[0].port, MAIN_PORT + 2);
    } finally {
        await runtime.stop();
    }
});

test("daemon-first failure email includes local block difficulty context", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime } = await startHarness({ realMainPow: true, mainPowVectors });
    const socket = {};
    const mismatchedVector = RX0_MAIN_SHARE_VECTORS[1];
    const originalRpcPortDaemon = global.support.rpcPortDaemon;

    try {
        global.support.rpcPortDaemon = function rpcPortDaemonFailure(port, method, params, callback) {
            this.rpcPortDaemonCalls.push({ port, method, params });
            callback(null, 500);
        };

        const loginReply = invokePoolMethod({
            socket,
            id: 2003,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-wallet-trust-email"
            }
        });

        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const blockTemplate = runtime.getState().activeBlockTemplates[""];
        const result = buildMainShareResult(runtime, socket, jobId, mismatchedVector.nonce);

        miner.validShares = 1;
        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        blockTemplate.difficulty = 1;
        blockTemplate.xmr_difficulty = 3;
        blockTemplate.xtm_difficulty = Number.MAX_SAFE_INTEGER;

        invokePoolMethod({
            socket,
            id: 2004,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000001b",
                result
            }
        });

        await flushTimers();
        await new Promise((resolve) => setTimeout(resolve, 550));
        await flushTimers();
        assert.equal(global.support.rpcPortDaemonCalls.length >= 1, true);
        assert.equal(global.support.emails.length, 1);
        assert.match(global.support.emails[0].body, /Submitted share difficulty:/);
        assert.match(global.support.emails[0].body, /Required block difficulty: 3/);
        assert.match(global.support.emails[0].body, /Locally verified difficulty:/);
        assert.match(global.support.emails[0].body, /not block level; no action is needed/);
    } finally {
        global.support.rpcPortDaemon = originalRpcPortDaemon;
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
});
