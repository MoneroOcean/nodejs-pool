"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ALT_WALLET,
    ETH_WALLET,
    VALID_RESULT,
    JsonLineClient,
    startHarness,
    flushTimers,
    invokePoolMethod,
    createBaseTemplate,
    poolModule
} = require("../common/harness.js");

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

function assertLoginAccepted(reply) {
    assert.equal(reply.replies[0].error, null);
    assert.equal(reply.replies[0].result.status, "OK");
}

async function withLoggedInMiner(id, params, callback) {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const reply = invokePoolMethod({
            socket,
            id,
            method: "login",
            params
        });
        assertLoginAccepted(reply);
        await callback(runtime.getState().activeMiners.get(socket.miner_id));
    } finally {
        await runtime.stop();
    }
}

test.describe("pool protocol: jobs", { concurrency: false }, () => {
test("kawpow submit accepts hex nonce and mixhash values containing alphabetic digits", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        const subscribeReply = await client.request({
            id: 43,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 44,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-alpha-hex"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        const targetPush = await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");
        assert.equal(typeof targetPush.params[0], "string");

        const submitReply = await client.request({
            id: 45,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0xaddc3acbd4759f17",
                `0x${notifyPush.params[1]}`,
                "0x137e5e485557b954e7d4eb1ff2e3915c8f41d7e8f4bdef069432a23d48cbcaf2"
            ]
        });

        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("kawpow submit verifies the recomputed mixhash before crediting shares", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);
    const computedMixhash = "cd".repeat(32);

    try {
        global.coinFuncs.__testKawpowComputedMixhash = computedMixhash;
        await client.connect();

        const subscribeReply = await client.request({
            id: 4501,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 4502,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-kawpow-mixhash-check"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const validSubmitReply = await client.request({
            id: 4503,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000021",
                `0x${notifyPush.params[1]}`,
                `0x${computedMixhash}`
            ]
        });
        await flushShareAccumulator(() => database.shares.length === 1);

        const forgedSubmitReply = await client.request({
            id: 4504,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000022",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });
        await flushShareAccumulator(() => runtime.getState().shareStats.invalidShares === 1);

        assert.equal(validSubmitReply.error, null);
        assert.equal(validSubmitReply.result, true);
        assert.equal(forgedSubmitReply.error.message, "Low difficulty share");
        assert.equal(forgedSubmitReply.result, undefined);
        assert.equal(database.shares.length, 1);
        const expectedRawShares = global.coinFuncs.getPoolHashesPerDifficulty(ETH_PORT) * 0.01;
        assert.ok(Math.abs(database.shares[0].payload.raw_shares - expectedRawShares) < 512);
        assert.equal(Number(database.shares[0].payload.shares2), Math.floor(expectedRawShares));
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
    } finally {
        delete global.coinFuncs.__testKawpowComputedMixhash;
        await client.close();
        await runtime.stop();
    }
});

test("kawpow submit rejects low-difficulty finalizer results before full mixhash verification", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    let slowHashAsyncCalls = 0;

    try {
        global.coinFuncs.__testKawpowQuickResult = "ff".repeat(32);
        global.coinFuncs.slowHashAsync = function countedSlowHashAsync(...args) {
            slowHashAsyncCalls += 1;
            return originalSlowHashAsync.apply(this, args);
        };

        await client.connect();

        const subscribeReply = await client.request({
            id: 4511,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 4512,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-kawpow-lowdiff-prefilter"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const submitReply = await client.request({
            id: 4513,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000023",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });
        await flushShareAccumulator(() => runtime.getState().shareStats.invalidShares === 1);

        assert.equal(submitReply.error.message, "Low difficulty share");
        assert.equal(submitReply.result, undefined);
        assert.equal(database.shares.length, 0);
        assert.equal(slowHashAsyncCalls, 0);
    } finally {
        delete global.coinFuncs.__testKawpowQuickResult;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await client.close();
        await runtime.stop();
    }
});

test("kawpow submit does not invalidate shares dropped by verifier queue timeout", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    let slowHashAsyncCalls = 0;

    try {
        global.coinFuncs.slowHashAsync = function queueTimeoutSlowHash(_buffer, _blockTemplate, _wallet, callback) {
            slowHashAsyncCalls += 1;
            callback(null, "verify-queue-timeout");
        };

        await client.connect();

        const subscribeReply = await client.request({
            id: 4514,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 4515,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-kawpow-queue-timeout"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const submitReply = await client.request({
            id: 4516,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000024",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });

        assert.equal(submitReply.error.message, "Throttled down share submission (please increase difficulty)");
        assert.equal(submitReply.result, undefined);
        assert.equal(database.shares.length, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(slowHashAsyncCalls, 1);
    } finally {
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await client.close();
        await runtime.stop();
    }
});

test("kawpow submit retries verifier host errors without local fallback", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    const originalVerifyRetryConfig = global.config.pool.verifyShareRetry;
    const originalSetTimeout = global.setTimeout;
    let slowHashAsyncCalls = 0;

    try {
        global.config.pool.verifyShareRetry = { maxRetries: 3, retryDelayMs: 7 };
        global.setTimeout = function drainVerifierRetry(callback, delay, ...args) {
            if (delay === 7) {
                callback(...args);
                return 0;
            }
            return originalSetTimeout(callback, delay, ...args);
        };
        global.coinFuncs.slowHashAsync = function hostErrorThenValidHash(...args) {
            slowHashAsyncCalls += 1;
            const callback = args[3];
            if (slowHashAsyncCalls < 4) return callback(false, "verify-host-error");
            return originalSlowHashAsync.apply(this, args);
        };

        await client.connect();

        const subscribeReply = await client.request({
            id: 4517,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 4518,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-kawpow-host-retry"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const submitReply = await client.request({
            id: 4519,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000025",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });
        await flushShareAccumulator(() => database.shares.length === 1);

        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
        assert.equal(slowHashAsyncCalls, 4);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
    } finally {
        global.config.pool.verifyShareRetry = originalVerifyRetryConfig;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        global.setTimeout = originalSetTimeout;
        await client.close();
        await runtime.stop();
    }
});

test("trusted kawpow submit uses the same trusted-share fast path as other algos", async () => {
    const coinHashFactor = 1 / global.coinFuncs.getPoolHashesPerDifficulty(ETH_PORT);
    const { runtime, database } = await startHarness({
        coinHashFactors: { ETH: coinHashFactor },
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 }),
                coinHashFactor
            }
        ]
    });
    const client = new JsonLineClient(ETH_PORT);
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;
    let slowHashAsyncCalls = 0;

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);
        global.coinFuncs.slowHashAsync = function countedSlowHashAsync(...args) {
            slowHashAsyncCalls += 1;
            return originalSlowHashAsync.apply(this, args);
        };

        await client.connect();

        const subscribeReply = await client.request({
            id: 4521,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 4522,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-kawpow-trusted-fast"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        const state = runtime.getState();
        const miner = Array.from(state.activeMiners.values())[0];
        miner.trust.trust = 1000;
        miner.trust.check_height = 0;

        await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const submitReply = await client.request({
            id: 4523,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000024",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });
        await flushShareAccumulator(() => database.shares.length === 1);

        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
        assert.equal(runtime.getState().shareStats.trustedShares, 1);
        assert.equal(slowHashAsyncCalls, 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await client.close();
        await runtime.stop();
    }
});

test("kawpow submit rejects shares whose header hash does not match the converted blob", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        const subscribeReply = await client.request({
            id: 451,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(subscribeReply.error, null);

        const authorizeReply = await client.request({
            id: 452,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-wrong-header-hash"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");
        const submitReply = await client.request({
            id: 453,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000011",
                `0x${"00".repeat(32)}`,
                `0x${"ab".repeat(32)}`
            ]
        });

        assert.equal(submitReply.error.message, "Low difficulty share");
        assert.equal(submitReply.result, undefined);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
        assert.equal(database.shares.length, 0);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("getjob can switch a miner from default jobs to kawpow-style jobs when algo perf changes", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 46,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-switch-coin"
            }
        });

        assert.equal(loginReply.replies[0].error, null);
        assert.equal(typeof loginReply.replies[0].result.job, "object");
        assert.equal(Array.isArray(loginReply.replies[0].result.job), false);
        assert.equal(loginReply.replies[0].result.job.job_id !== undefined, true);

        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        miner.curr_coin = undefined;
        miner.curr_coin_time = 0;
        poolModule.setTestCoinHashFactor("ETH", 5 / global.coinFuncs.getPoolHashesPerDifficulty(ETH_PORT));

        const getjobReply = invokePoolMethod({
            socket,
            id: 47,
            method: "getjob",
            params: {
                id: socket.miner_id,
                algo: ["rx/0", "kawpow"],
                "algo-perf": {
                    "rx/0": 1,
                    kawpow: 2
                },
                "algo-min-time": 0
            }
        });

        assert.equal(getjobReply.replies[0].error, null);
        assert.equal(Array.isArray(getjobReply.replies[0].result), true);
        assert.equal(getjobReply.replies[0].result.length, 7);
        assert.equal(runtime.getState().activeMiners.get(socket.miner_id).curr_coin, "ETH");
    } finally {
        await runtime.stop();
    }
});

test("main-coin jobs stay valid when only the kawpow template rotates", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 48,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-main-template-isolation"
            }
        });

        const jobId = loginReply.replies[0].result.job.job_id;

        runtime.setTemplate(createBaseTemplate({
            coin: "ETH",
            port: ETH_PORT,
            idHash: "eth-template-rotated",
            height: 202
        }));

        const submitReply = invokePoolMethod({
            socket,
            id: 49,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000010",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await runtime.stop();
    }
});

test("kawpow jobs stay valid when only the main template rotates", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: 50,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 51,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-eth-template-isolation"],
            portData: global.config.ports[1]
        });

        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");

        runtime.setTemplate(createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "main-template-rotated",
            height: 102
        }));

        const submitReply = invokePoolMethod({
            socket,
            id: 52,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000011",
                `0x${notifyPush.params[1]}`,
                `0x${"cd".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await runtime.stop();
    }
});

test("malformed login requests without params are rejected", async () => {
    const { runtime } = await startHarness();

    try {
        const first = invokePoolMethod({
            method: "login",
            params: null,
            ip: "10.0.0.55"
        });

        assert.equal(first.replies.length, 0);
        assert.deepEqual(first.finals, [{ error: "No params specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("unauthenticated getjob, submit, and keepalive requests are rejected", async () => {
    const { runtime } = await startHarness();

    try {
        for (const method of ["getjob", "submit", "keepalive"]) {
            const params = method === "submit" ? { id: "missing", job_id: "1", nonce: "00000001", result: VALID_RESULT } : { id: "missing" };
            const reply = invokePoolMethod({ method, params });
            assert.equal(reply.replies.length, 0, `${method} should not produce a non-final reply`);
            assert.deepEqual(reply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
        }
    } finally {
        await runtime.stop();
    }
});

test("legacy submit charges invalid job ids to the authenticated socket miner", async () => {
    const { runtime } = await startHarness();
    const victimSocket = {};
    const attackerSocket = {};

    try {
        invokePoolMethod({
            socket: victimSocket,
            id: 321,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        invokePoolMethod({
            socket: victimSocket,
            id: 322,
            method: "mining.authorize",
            params: [ETH_WALLET, "victim-eth-worker"],
            portData: global.config.ports[1]
        });
        invokePoolMethod({
            socket: attackerSocket,
            id: 323,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        invokePoolMethod({
            socket: attackerSocket,
            id: 324,
            method: "mining.authorize",
            params: [ETH_WALLET, "attacker-eth-worker"],
            portData: global.config.ports[1]
        });

        const victim = runtime.getState().activeMiners.get(victimSocket.miner_id);
        const attacker = runtime.getState().activeMiners.get(attackerSocket.miner_id);
        const submitReply = invokePoolMethod({
            socket: attackerSocket,
            id: 325,
            method: "submit",
            params: {
                id: victimSocket.miner_id,
                job_id: "missing-job",
                nonce: "000000000001",
                result: VALID_RESULT
            },
            portData: global.config.ports[1]
        });

        assert.deepEqual(submitReply.replies, [{ error: "Invalid job id", result: undefined }]);
        assert.equal(victim.invalidJobIdCount, 0);
        assert.equal(attacker.invalidJobIdCount, 1);
        assert.equal(runtime.getState().activeMiners.has(victimSocket.miner_id), true);
    } finally {
        await runtime.stop();
    }
});

test("getjob applies forged params ids to the authenticated socket miner only", async () => {
    const { runtime } = await startHarness();
    const victimSocket = {};
    const attackerSocket = {};

    try {
        invokePoolMethod({
            socket: victimSocket,
            id: 331,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "victim-getjob"
            }
        });
        invokePoolMethod({
            socket: attackerSocket,
            id: 332,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "attacker-getjob"
            }
        });

        const victim = runtime.getState().activeMiners.get(victimSocket.miner_id);
        const attacker = runtime.getState().activeMiners.get(attackerSocket.miner_id);
        victim.curr_coin = undefined;
        victim.curr_coin_time = 0;
        attacker.curr_coin = undefined;
        attacker.curr_coin_time = 0;
        poolModule.setTestCoinHashFactor("ETH", 5 / global.coinFuncs.getPoolHashesPerDifficulty(ETH_PORT));

        const getjobReply = invokePoolMethod({
            socket: attackerSocket,
            id: 333,
            method: "getjob",
            params: {
                id: victimSocket.miner_id,
                algo: ["rx/0", "kawpow"],
                "algo-perf": {
                    "rx/0": 1,
                    kawpow: 2
                },
                "algo-min-time": 0
            }
        });

        assert.equal(getjobReply.replies[0].error, null);
        assert.equal(Array.isArray(getjobReply.replies[0].result), true);
        assert.equal(attacker.curr_coin, "ETH");
        assert.notEqual(victim.curr_coin, "ETH");
    } finally {
        await runtime.stop();
    }
});

test("unauthenticated keepalive cannot refresh another miner by params id", async () => {
    const { runtime } = await startHarness();
    const victimSocket = {};

    try {
        invokePoolMethod({
            socket: victimSocket,
            id: 341,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "victim-keepalive"
            }
        });
        const victim = runtime.getState().activeMiners.get(victimSocket.miner_id);
        victim.lastProtocolActivity = 123;

        const keepaliveReply = invokePoolMethod({
            socket: {},
            id: 342,
            method: "keepalive",
            params: { id: victimSocket.miner_id }
        });

        assert.equal(keepaliveReply.replies.length, 0);
        assert.deepEqual(keepaliveReply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
        assert.equal(victim.lastProtocolActivity, 123);
    } finally {
        await runtime.stop();
    }
});
});
