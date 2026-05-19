"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MAIN_PORT,
    MAIN_WALLET,
    ALT_WALLET,
    THIRD_WALLET,
    VALID_RESULT,
    startHarness,
    invokePoolMethod,
    createBaseTemplate,
    poolModule
} = require("../common/harness.js");

async function expectLoginFinalError(params, error, options = {}) {
    const { prepare, timeout } = options;
    const { runtime } = await startHarness();

    try {
        if (prepare) await prepare(runtime);
        const reply = invokePoolMethod({ method: "login", params });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error, timeout }]);
    } finally {
        await runtime.stop();
    }
}

test.describe("pool validation: core", { concurrency: false }, () => {
test("login fails cleanly when there is no active block template", async () => {
    const { runtime } = await startHarness({ templates: [] });

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-no-template"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "No active block template", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("getjob returns miner.setAlgos status errors when algo updates are rejected", async () => {
    const { runtime } = await startHarness();
    const originalAlgoCheck = global.coinFuncs.algoCheck;
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 120,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-bad-algo"
            }
        });

        global.coinFuncs.algoCheck = function patchedAlgoCheck(algos) {
            if ("bad/algo" in algos) return "Algo not supported";
            return originalAlgoCheck.call(this, algos);
        };

        const getjobReply = invokePoolMethod({
            socket,
            id: 121,
            method: "getjob",
            params: {
                id: loginReply.replies[0].result.id,
                algo: ["bad/algo"],
                "algo-perf": { "bad/algo": 1 }
            }
        });

        assert.deepEqual(getjobReply.replies, [{ error: "Algo not supported", result: undefined }]);
        assert.equal(getjobReply.finals.length, 0);
    } finally {
        global.coinFuncs.algoCheck = originalAlgoCheck;
        await runtime.stop();
    }
});

test("throttled shares return the explicit increase-difficulty message", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        global.config.pool.minerThrottleSharePerSec = 0;

        const loginReply = invokePoolMethod({
            socket,
            id: 130,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-throttle"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 131,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000008",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{
            error: "Throttled down share submission (please increase difficulty)",
            result: undefined
        }]);
        assert.equal(runtime.getState().shareStats.throttledShares, 1);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        global.config.pool.minerThrottleSharePerSec = 1000;
        await runtime.stop();
    }
});

test("submit accepts shares when the verifier returns the hash in reverse byte order", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;

    try {
        const reversedResult = Buffer.from(VALID_RESULT, "hex").reverse();

        global.coinFuncs.slowHashBuff = function reversedSlowHashBuff() {
            return Buffer.from(reversedResult);
        };
        global.coinFuncs.slowHashAsync = function reversedSlowHashAsync(_buffer, _blockTemplate, _wallet, callback) {
            callback(reversedResult.toString("hex"));
        };

        const loginReply = invokePoolMethod({
            socket,
            id: 132,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-reversed-hash"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 133,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000b",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("wallet bans propagated through messageHandler reject later logins", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = false;
        poolModule.messageHandler({
            type: "banIP",
            data: "127.0.0.1",
            wallet: MAIN_WALLET
        });

        const reply = invokePoolMethod({
            socket: {},
            id: 140,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-banned-wallet"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: `Temporary (10 minutes max) banned payment address ${MAIN_WALLET}`,
            timeout: undefined
        }]);
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("submitting on a long-disabled coin returns the daemon-issues final error", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 150,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-disabled-coin"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;
        const state = runtime.getState();
        const activeTemplate = state.activeBlockTemplates[""];

        runtime.setTemplate({
            ...createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: activeTemplate.idHash,
                height: activeTemplate.height
            }),
            idHash: activeTemplate.idHash,
            coinHashFactor: 0
        });
        state.activeBlockTemplates[""].timeCreated = Date.now() - (60 * 60 * 1000 + 1000);

        const submitReply = invokePoolMethod({
            socket,
            id: 151,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000009",
                result: VALID_RESULT
            }
        });

        assert.equal(submitReply.replies.length, 0);
        assert.deepEqual(submitReply.finals, [{
            error: "This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("proxy submits without worker and pool nonces are rejected as invalid shares", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 160,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "proxy-missing-nonces",
                agent: "xmr-node-proxy/0.0.1"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 161,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000a",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("xmrig-proxy connections are not banned by the proxy worker limit path", async () => {
    const { runtime } = await startHarness();

    try {
        global.config.pool.workerMax = 1;

        const first = invokePoolMethod({
            socket: {},
            id: 170,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "xmrig-proxy-one",
                agent: "xmrig-proxy/6.0.0"
            }
        });
        const second = invokePoolMethod({
            socket: {},
            id: 171,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "xmrig-proxy-two",
                agent: "xmrig-proxy/6.0.0"
            }
        });

        assert.equal(first.finals.length, 0);
        assert.equal(second.finals.length, 0);
        assert.equal(first.replies[0].error, null);
        assert.equal(second.replies[0].error, null);
    } finally {
        global.config.pool.workerMax = 20;
        await runtime.stop();
    }
});
});
