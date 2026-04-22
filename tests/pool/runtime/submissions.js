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

test.describe("pool runtime: submissions", { concurrency: false }, () => {
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

test("malformed zero-trust submits reply before the socket closes", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 1983,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-malformed-close"
            }
        });

        const submitReply = await client.request({
            id: 1984,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "not-a-nonce",
                result: VALID_RESULT
            }
        });

        assert.equal(submitReply.error.message, "Duplicate share");
        await waitForSocketClose(client.socket, 1000);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("zero-hash zero-trust submits reply before the socket closes", async () => {
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        global.config.pool.trustedMiners = false;
        await client.connect();

        const loginReply = await client.request({
            id: 1985,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-zero-hash-close"
            }
        });
        runtime.getState().activeBlockTemplates[""].difficulty = BigInt(global.coinFuncs.baseDiff().toString()) + 1n;

        const submitReply = await client.request({
            id: 1986,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000000",
                result: "00".repeat(32)
            }
        });

        assert.equal(submitReply.error.message, "Low difficulty share");
        await waitForSocketClose(client.socket, 1000);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
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
});
