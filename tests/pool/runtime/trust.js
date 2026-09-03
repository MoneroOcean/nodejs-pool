"use strict";
const test = require("node:test");

const {
    assert,
    crypto,
    ALT_WALLET,
    MAIN_WALLET,
    VALID_RESULT,
    startHarness,
    flushTimers,
    invokePoolMethod,
    RX0_MAIN_SHARE_VECTORS,
    ZERO_RESULT
} = require("../common/runtime-helpers.js");

const OK_REPLY = [{ error: null, result: { status: "OK" } }];
const THIRD_WALLET = "7".repeat(95);
const THROTTLED_REPLY = [{
    error: "Throttled down share submission (please increase difficulty)",
    result: undefined
}];

function submitShare(socket, id, jobId, nonce, result = VALID_RESULT) {
    return invokePoolMethod({
        socket,
        id,
        method: "submit",
        params: { id: socket.miner_id, job_id: jobId, nonce, result }
    });
}

function getRewardedDifficulty2(job) {
    return job.rewarded_difficulty * (job.hashesPerDifficulty || 1) * job.coinHashFactor;
}

function loginTrustedMiner(runtime, socket, id, worker) {
    const loginReply = invokePoolMethod({
        socket,
        id,
        method: "login",
        params: { login: MAIN_WALLET, pass: worker }
    });
    const state = runtime.getState();
    const miner = state.activeMiners.get(socket.miner_id);
    const jobId = loginReply.replies[0].result.job.job_id;
    state.walletTrust[MAIN_WALLET] = 1000;
    miner.trust.trust = 1000;
    miner.trust.check_height = 0;
    return {
        state,
        miner,
        jobId,
        trackedJob: miner.validJobs.toarray().find((entry) => entry.id === jobId)
    };
}

function selectVerificationThenTrust() {
    let randomCall = 0;
    // isSafeToTrust now draws a single random byte per trust decision (the old code drew one byte per
    // OR-branch, which multiplied the trust probability). The first decision fails (draw 0 -> verify),
    // every subsequent decision succeeds (draw 255 -> trusted).
    crypto.randomBytes = () => Buffer.from([++randomCall <= 1 ? 0 : 255]);
}

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
        assert.equal(miner.trust_key, MAIN_WALLET);
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

test("split-payout miners earn and reuse trust for the same canonical distribution", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socketA = {};
    const socketB = {};
    let verifierCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);
        global.coinFuncs.slowHashAsync = function countSlowVerification(_buffer, _template, _wallet, callback) {
            verifierCalls += 1;
            callback(VALID_RESULT);
        };

        const loginReplyA = invokePoolMethod({
            socket: socketA,
            id: 1960,
            method: "login",
            params: {
                login: `${MAIN_WALLET}%0.1%${ALT_WALLET}%35.9%${THIRD_WALLET}`,
                pass: "worker-trusted-split-a"
            }
        });
        const loginReplyB = invokePoolMethod({
            socket: socketB,
            id: 1961,
            method: "login",
            params: {
                login: `${MAIN_WALLET}%35.9%${THIRD_WALLET}%0.1%${ALT_WALLET}`,
                pass: "worker-trusted-split-b"
            }
        });
        const state = runtime.getState();
        const minerA = state.activeMiners.get(socketA.miner_id);
        const minerB = state.activeMiners.get(socketB.miner_id);
        const jobIdA = loginReplyA.replies[0].result.job.job_id;
        const jobIdB = loginReplyB.replies[0].result.job.job_id;

        assert.equal(minerA.trust_key, minerB.trust_key);
        assert.notEqual(minerA.trust_key, MAIN_WALLET);
        assert.equal(/[\t\r\n]/.test(minerA.trust_key), false);
        assert.notEqual(minerA.wallet_key, minerB.wallet_key);
        assert.notEqual(minerA.payout_div[MAIN_WALLET], minerB.payout_div[MAIN_WALLET]);
        assert.equal(MAIN_WALLET in state.walletTrust, false);

        const verifiedReply = submitShare(socketA, 1962, jobIdA, "0000001e");
        await flushTimers();

        assert.deepEqual(verifiedReply.replies, OK_REPLY);
        assert.equal(verifierCalls, 1);
        assert.equal(state.walletTrust[minerA.trust_key] > 0, true);
        assert.equal(MAIN_WALLET in state.walletTrust, false);

        state.walletTrust[minerA.trust_key] = 1000;
        minerB.trust.trust = 1000;
        minerB.trust.check_height = 0;

        const trustedReply = submitShare(socketB, 1963, jobIdB, "0000001f");

        await flushTimers();
        assert.deepEqual(trustedReply.replies, OK_REPLY);
        assert.equal(verifierCalls, 1);
        assert.equal(runtime.getState().shareStats.trustedShares, 1);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("split-payout miners cannot borrow primary-only or differently split trust", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socketA = {};
    const socketB = {};
    let verifierCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);
        global.coinFuncs.slowHashAsync = function countSlowVerification(_buffer, _template, _wallet, callback) {
            verifierCalls += 1;
            callback(VALID_RESULT);
        };

        const loginReplyA = invokePoolMethod({
            socket: socketA,
            id: 1964,
            method: "login",
            params: { login: `${MAIN_WALLET}%25%${ALT_WALLET}`, pass: "worker-split-primary-isolation" }
        });
        const loginReplyB = invokePoolMethod({
            socket: socketB,
            id: 1965,
            method: "login",
            params: { login: `${MAIN_WALLET}%30%${ALT_WALLET}`, pass: "worker-split-distribution-isolation" }
        });
        const state = runtime.getState();
        const minerA = state.activeMiners.get(socketA.miner_id);
        const minerB = state.activeMiners.get(socketB.miner_id);
        const jobIdA = loginReplyA.replies[0].result.job.job_id;
        const jobIdB = loginReplyB.replies[0].result.job.job_id;
        const jobA = minerA.validJobs.toarray().find((entry) => entry.id === jobIdA);
        const jobB = minerB.validJobs.toarray().find((entry) => entry.id === jobIdB);

        state.walletTrust[MAIN_WALLET] = 1e9;
        minerA.trust.trust = getRewardedDifficulty2(jobA) * global.config.pool.trustThreshold;
        minerA.trust.check_height = 0;
        const primaryIsolationReply = submitShare(socketA, 1966, jobIdA, "00000020");
        await flushTimers();

        assert.deepEqual(primaryIsolationReply.replies, OK_REPLY);
        assert.equal(verifierCalls, 1);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);

        state.walletTrust[minerA.trust_key] = 1e9;
        minerB.trust.trust = getRewardedDifficulty2(jobB) * global.config.pool.trustThreshold;
        minerB.trust.check_height = 0;
        const distributionIsolationReply = submitShare(socketB, 1967, jobIdB, "00000021");
        await flushTimers();

        assert.deepEqual(distributionIsolationReply.replies, OK_REPLY);
        assert.equal(verifierCalls, 2);
        assert.notEqual(minerA.trust_key, minerB.trust_key);
        assert.equal(state.walletTrust[MAIN_WALLET], 1e9);
        assert.equal(state.walletTrust[minerA.trust_key], 1e9);
        assert.equal(runtime.getState().shareStats.normalShares, 2);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("trusted miners cannot credit all-zero result hashes", async () => {
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
                pass: "worker-trusted-zero-hash"
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
            id: 198,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000a",
                result: ZERO_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
        assert.equal(runtime.getState().shareStats.normalShares, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
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

test("invalid split verification clears only the matching distribution trust and sessions", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalBanEnabled = global.config.pool.banEnabled;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const sockets = [{}, {}, {}, {}];

    try {
        global.config.pool.trustedMiners = true;
        global.config.pool.banEnabled = false;
        crypto.randomBytes = () => Buffer.from([0]);
        global.coinFuncs.slowHashAsync = function returnInvalidVerification(_buffer, _template, _wallet, callback) {
            callback("ab".repeat(32));
        };

        const logins = [
            `${MAIN_WALLET}%25%${ALT_WALLET}`,
            `${MAIN_WALLET}%25%${ALT_WALLET}`,
            `${MAIN_WALLET}%30%${ALT_WALLET}`,
            MAIN_WALLET
        ];
        const loginReplies = logins.map(function loginResetMiner(login, index) {
            return invokePoolMethod({
                socket: sockets[index],
                id: 1970 + index,
                method: "login",
                params: { login, pass: `worker-reset-scope-${  index}` }
            });
        });
        const state = runtime.getState();
        const miners = sockets.map((socket) => state.activeMiners.get(socket.miner_id));
        const matchingTrustKey = miners[0].trust_key;
        const otherSplitTrustKey = miners[2].trust_key;
        const jobId = loginReplies[0].replies[0].result.job.job_id;

        assert.equal(miners[1].trust_key, matchingTrustKey);
        assert.notEqual(otherSplitTrustKey, matchingTrustKey);
        assert.equal(state.activeMinersByPayout.get(MAIN_WALLET).size, 4);

        state.walletTrust[matchingTrustKey] = 1000;
        state.walletTrust[otherSplitTrustKey] = 2000;
        state.walletTrust[MAIN_WALLET] = 3000;
        miners.forEach(function seedSessionTrust(miner, index) {
            miner.trust.trust = 500 + index;
            miner.trust.check_height = 0;
        });

        const submitReply = submitShare(sockets[0], 1974, jobId, "00000022");
        await flushTimers();

        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(state.walletTrust[matchingTrustKey], 0);
        assert.equal(miners[0].trust.trust, 0);
        assert.equal(miners[1].trust.trust, 0);
        assert.equal(state.walletTrust[otherSplitTrustKey], 2000);
        assert.equal(miners[2].trust.trust, 502);
        assert.equal(state.walletTrust[MAIN_WALLET], 3000);
        assert.equal(miners[3].trust.trust, 503);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        global.config.pool.banEnabled = originalBanEnabled;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("zero global trust still clears only same-distribution session trust", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const sockets = [{}, {}, {}];

    try {
        global.config.pool.trustedMiners = true;

        const logins = [
            `${MAIN_WALLET}%25%${ALT_WALLET}`,
            `${MAIN_WALLET}%25%${ALT_WALLET}`,
            `${MAIN_WALLET}%30%${ALT_WALLET}`
        ];
        const loginReplies = logins.map(function loginZeroTrustMiner(login, index) {
            return invokePoolMethod({
                socket: sockets[index],
                id: 1980 + index,
                method: "login",
                params: { login, pass: `worker-zero-${  index}` }
            });
        });

        const state = runtime.getState();
        const miners = sockets.map((socket) => state.activeMiners.get(socket.miner_id));
        const matchingTrustKey = miners[0].trust_key;
        const otherSplitTrustKey = miners[2].trust_key;
        const jobId = loginReplies[0].replies[0].result.job.job_id;
        const job = miners[0].validJobs.toarray().find((entry) => entry.id === jobId);

        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        state.walletTrust[matchingTrustKey] = 0;
        state.walletTrust[otherSplitTrustKey] = 0;
        miners[0].trust.trust = 0;
        miners[1].trust.trust = 700;
        miners[2].trust.trust = 800;

        const submitReply = invokePoolMethod({
            socket: sockets[0],
            id: 1983,
            method: "submit",
            params: {
                id: sockets[0].miner_id,
                job_id: jobId,
                nonce: "0000000b",
                result: "ee".repeat(32)
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(state.walletTrust[matchingTrustKey], 0);
        assert.equal(miners[0].trust.trust, 0);
        assert.equal(miners[1].trust.trust, 0);
        assert.equal(state.walletTrust[otherSplitTrustKey], 0);
        assert.equal(miners[2].trust.trust, 800);
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

test("trusted shares wait for pending wallet verification and rerun the trust decision", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socket = {};
    const verifierCallbacks = [];
    let verifierCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        global.coinFuncs.slowHashAsync = function holdWalletVerification(_buffer, _blockTemplate, _wallet, callback) {
            verifierCalls += 1;
            verifierCallbacks.push(callback);
        };

        const { jobId } = loginTrustedMiner(runtime, socket, 2100, "worker-trusted-queue-rerun");
        selectVerificationThenTrust();

        const verifyingReply = submitShare(socket, 2101, jobId, "00000030");
        const queuedReply = submitShare(socket, 2102, jobId, "00000031");

        assert.equal(verifierCalls, 1);
        assert.deepEqual(verifyingReply.replies, []);
        assert.deepEqual(queuedReply.replies, []);

        crypto.randomBytes = () => Buffer.from([0]);
        verifierCallbacks.shift()(VALID_RESULT);
        await flushTimers();

        assert.equal(verifierCalls, 2);
        assert.deepEqual(verifyingReply.replies, OK_REPLY);
        assert.deepEqual(queuedReply.replies, []);

        verifierCallbacks.shift()(VALID_RESULT);
        await flushTimers();

        assert.deepEqual(queuedReply.replies, OK_REPLY);
        assert.equal(runtime.getState().shareStats.normalShares, 2);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("pending verification queues are isolated by payout distribution", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socketA = {};
    const socketB = {};
    const verifierCallbacks = [];
    let randomCall = 0;
    let verifierCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([++randomCall === 1 ? 0 : 255]);
        global.coinFuncs.slowHashAsync = function holdDistributionVerification(_buffer, _blockTemplate, _wallet, callback) {
            verifierCalls += 1;
            verifierCallbacks.push(callback);
        };

        const loginReplyA = invokePoolMethod({
            socket: socketA,
            id: 2103,
            method: "login",
            params: { login: `${MAIN_WALLET}%25%${ALT_WALLET}`, pass: "worker-queue-split-a" }
        });
        const loginReplyB = invokePoolMethod({
            socket: socketB,
            id: 2104,
            method: "login",
            params: { login: `${MAIN_WALLET}%30%${ALT_WALLET}`, pass: "worker-queue-split-b" }
        });
        const state = runtime.getState();
        const minerA = state.activeMiners.get(socketA.miner_id);
        const minerB = state.activeMiners.get(socketB.miner_id);
        const jobIdA = loginReplyA.replies[0].result.job.job_id;
        const jobIdB = loginReplyB.replies[0].result.job.job_id;

        state.walletTrust[minerA.trust_key] = 1000;
        state.walletTrust[minerB.trust_key] = 1000;
        minerA.trust.trust = 1000;
        minerA.trust.check_height = 0;
        minerB.trust.trust = 1000;
        minerB.trust.check_height = 0;

        const verifyingReply = submitShare(socketA, 2105, jobIdA, "00000023");
        const independentReply = submitShare(socketB, 2106, jobIdB, "00000024");

        assert.equal(verifierCalls, 1);
        assert.deepEqual(verifyingReply.replies, []);
        assert.deepEqual(independentReply.replies, OK_REPLY);

        verifierCallbacks.shift()(VALID_RESULT);
        await flushTimers();

        assert.deepEqual(verifyingReply.replies, OK_REPLY);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(runtime.getState().shareStats.trustedShares, 1);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("failed wallet verification forces the queued generation through verification", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalBanEnabled = global.config.pool.banEnabled;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socket = {};
    const verifierCallbacks = [];
    let verifierCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        global.config.pool.banEnabled = false;
        global.coinFuncs.slowHashAsync = function holdWalletVerification(_buffer, _blockTemplate, _wallet, callback) {
            verifierCalls += 1;
            verifierCallbacks.push(callback);
        };

        const { state, miner, jobId } = loginTrustedMiner(runtime, socket, 2110, "worker-trusted-queue-failed");
        selectVerificationThenTrust();

        const failedReply = submitShare(socket, 2111, jobId, "00000032");
        const queuedReplies = ["00000033", "00000034", "00000035"].map(function submitQueuedShare(nonce, index) {
            return submitShare(socket, 2112 + index, jobId, nonce);
        });

        assert.equal(verifierCalls, 1);
        verifierCallbacks.shift()("ab".repeat(32));

        state.walletTrust[MAIN_WALLET] = 1000;
        miner.trust.trust = 1000;
        crypto.randomBytes = () => Buffer.from([255]);

        for (let index = 0; index < queuedReplies.length; ++index) {
            await flushTimers();
            assert.equal(verifierCalls, index + 2);
            verifierCallbacks.shift()(VALID_RESULT);
        }
        await flushTimers();

        assert.deepEqual(failedReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        for (const queuedReply of queuedReplies) {
            assert.deepEqual(queuedReply.replies, OK_REPLY);
        }
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
        assert.equal(runtime.getState().shareStats.normalShares, 3);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        global.config.pool.banEnabled = originalBanEnabled;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("submission throttle drops trusted shares while verification is in flight", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalThrottlePerSec = global.config.pool.minerThrottleSharePerSec;
    const originalThrottleWindow = global.config.pool.minerThrottleShareWindow;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socket = {};
    const verifierCallbacks = [];

    try {
        global.config.pool.trustedMiners = true;
        global.config.pool.minerThrottleSharePerSec = 1;
        global.config.pool.minerThrottleShareWindow = 1;
        global.coinFuncs.slowHashAsync = function holdWalletVerification(_buffer, _blockTemplate, _wallet, callback) {
            verifierCallbacks.push(callback);
        };

        const { state, jobId, trackedJob } = loginTrustedMiner(runtime, socket, 2115, "worker-trusted-queue-limit");
        selectVerificationThenTrust();

        const verifyingReply = submitShare(socket, 2116, jobId, "00000038");
        const queuedReply = submitShare(socket, 2117, jobId, "00000039");
        const overflowReply = submitShare(socket, 2118, jobId, "0000003a");

        assert.deepEqual(queuedReply.replies, THROTTLED_REPLY);
        assert.deepEqual(overflowReply.replies, THROTTLED_REPLY);
        assert.equal(trackedJob.submissions.has("00000039"), false);
        assert.equal(trackedJob.submissions.has("0000003a"), false);
        assert.equal(verifierCallbacks.length, 1);
        assert.equal(state.minerWallets[MAIN_WALLET].last_ver_shares, 3);

        verifierCallbacks.shift()(VALID_RESULT);
        await flushTimers();

        assert.deepEqual(verifyingReply.replies, OK_REPLY);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
        assert.equal(runtime.getState().shareStats.throttledShares, 2);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        global.config.pool.minerThrottleSharePerSec = originalThrottlePerSec;
        global.config.pool.minerThrottleShareWindow = originalThrottleWindow;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("wallet bans discard active and pending trusted queue entries", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socket = {};
    const verifierCallbacks = [];

    try {
        global.config.pool.trustedMiners = true;
        global.coinFuncs.slowHashAsync = function holdWalletVerification(_buffer, _blockTemplate, _wallet, callback) {
            verifierCallbacks.push(callback);
        };

        const { state, miner, jobId, trackedJob } = loginTrustedMiner(runtime, socket, 2119, "worker-trusted-queue-ban");
        selectVerificationThenTrust();

        const verifyingReply = submitShare(socket, 2120, jobId, "0000003b");
        const queuedReply = submitShare(socket, 2121, jobId, "0000003c");
        const pendingReply = submitShare(socket, 2122, jobId, "0000003d");

        assert.deepEqual(queuedReply.replies, []);
        verifierCallbacks.shift()(VALID_RESULT);
        miner.lastSlowHashAsyncDelay = 0;
        state.bannedTmpWallets[MAIN_WALLET] = 1;
        await flushTimers();

        assert.deepEqual(verifyingReply.replies, OK_REPLY);
        assert.deepEqual(queuedReply.replies, THROTTLED_REPLY);
        assert.deepEqual(pendingReply.replies, THROTTLED_REPLY);
        assert.equal(trackedJob.submissions.has("0000003c"), false);
        assert.equal(trackedJob.submissions.has("0000003d"), false);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("ordinary same-wallet verification remains parallel", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const socket = {};
    const verifierCallbacks = [];
    let verifierCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([0]);
        global.coinFuncs.slowHashAsync = function holdParallelVerification(_buffer, _blockTemplate, _wallet, callback) {
            verifierCalls += 1;
            verifierCallbacks.push(callback);
        };

        const { jobId } = loginTrustedMiner(runtime, socket, 2120, "worker-parallel-verification");

        const replies = ["00000036", "00000037"].map(function submitVerifiedShare(nonce, index) {
            return submitShare(socket, 2121 + index, jobId, nonce);
        });

        assert.equal(verifierCalls, 2);
        verifierCallbacks.shift()(VALID_RESULT);
        verifierCallbacks.shift()(VALID_RESULT);
        await flushTimers();

        for (const reply of replies) {
            assert.deepEqual(reply.replies, OK_REPLY);
        }
        assert.equal(runtime.getState().shareStats.normalShares, 2);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});
});
