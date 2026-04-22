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

test.describe("pool runtime: trust", { concurrency: false }, () => {
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

test("invalid shares clear local trust for same-wallet active miners when wallet trust drops", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const socketA = {};
    const socketB = {};

    try {
        global.config.pool.trustedMiners = true;

        const loginReplyA = invokePoolMethod({
            socket: socketA,
            id: 1961,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-clear-a"
            }
        });
        invokePoolMethod({
            socket: socketB,
            id: 1962,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-clear-b"
            }
        });

        const state = runtime.getState();
        const minerA = state.activeMiners.get(socketA.miner_id);
        const minerB = state.activeMiners.get(socketB.miner_id);
        const payoutMiners = state.activeMinersByPayout.get(MAIN_WALLET);
        const jobId = loginReplyA.replies[0].result.job.job_id;
        const job = minerA.validJobs.toarray().find((entry) => entry.id === jobId);

        assert.equal(payoutMiners.size, 2);
        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        state.walletTrust[MAIN_WALLET] = 1000;
        minerA.trust.trust = 500;
        minerB.trust.trust = 700;

        const submitReply = invokePoolMethod({
            socket: socketA,
            id: 1963,
            method: "submit",
            params: {
                id: socketA.miner_id,
                job_id: jobId,
                nonce: "0000000a",
                result: "ff".repeat(32)
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(state.walletTrust[MAIN_WALLET], 0);
        assert.equal(minerA.trust.trust, 0);
        assert.equal(minerB.trust.trust, 0);
        assert.equal(state.activeMiners.has(socketB.miner_id), true);
        assert.equal(state.activeMinersByPayout.get(MAIN_WALLET).has(socketB.miner_id), true);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        await runtime.stop();
    }
});

test("same-wallet peer trust stays untouched when wallet trust is already zero", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const socketA = {};
    const socketB = {};

    try {
        global.config.pool.trustedMiners = true;

        const loginReplyA = invokePoolMethod({
            socket: socketA,
            id: 1964,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-zero-a"
            }
        });
        invokePoolMethod({
            socket: socketB,
            id: 1965,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-zero-b"
            }
        });

        const state = runtime.getState();
        const minerA = state.activeMiners.get(socketA.miner_id);
        const minerB = state.activeMiners.get(socketB.miner_id);
        const jobId = loginReplyA.replies[0].result.job.job_id;
        const job = minerA.validJobs.toarray().find((entry) => entry.id === jobId);

        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        state.walletTrust[MAIN_WALLET] = 0;
        minerA.trust.trust = 0;
        minerB.trust.trust = 700;

        const submitReply = invokePoolMethod({
            socket: socketA,
            id: 1966,
            method: "submit",
            params: {
                id: socketA.miner_id,
                job_id: jobId,
                nonce: "0000000b",
                result: "ee".repeat(32)
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(state.walletTrust[MAIN_WALLET], 0);
        assert.equal(minerA.trust.trust, 0);
        assert.equal(minerB.trust.trust, 700);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
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
