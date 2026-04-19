"use strict";

const assert = require("node:assert/strict");
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
} = require("./harness.js");

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
        poolModule.setTestCoinHashFactor("ETH", 5);

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
});
