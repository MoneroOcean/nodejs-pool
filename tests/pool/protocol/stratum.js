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

test.describe("pool protocol: stratum", { concurrency: false }, () => {
test("default stratum miner can login, keepalive, and submit a valid share", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 1,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-a"
            }
        });

        assert.equal(loginReply.error, null);
        assert.equal(loginReply.result.status, "OK");

        const keepaliveReply = await client.request({
            id: 2,
            method: "keepalive",
            params: {
                id: loginReply.result.id
            }
        });

        assert.equal(keepaliveReply.result.status, "KEEPALIVED");

        const shareReply = await client.request({
            id: 3,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000001",
                result: VALID_RESULT
            }
        });

        await flushShareAccumulator(() => database.shares.length === 1);
        assert.equal(shareReply.error, null);
        assert.deepEqual(shareReply.result, { status: "OK" });
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(database.shares.length, 1);
        assert.equal(database.shares[0].payload.paymentAddress, MAIN_WALLET);
        assert.equal(database.shares[0].payload.identifier, "worker-a");
        assert.equal(database.shares[0].payload.share_num, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("stale shares from the immediately previous template are still accepted and counted as outdated", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 10,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-b"
            }
        });

        runtime.setTemplate(createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "main-template-2",
            height: 102
        }));

        const shareReply = await client.request({
            id: 11,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000002",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.equal(shareReply.error, null);
        assert.deepEqual(shareReply.result, { status: "OK" });
        assert.equal(runtime.getState().shareStats.outdatedShares, 1);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("duplicate default shares are rejected and recorded as invalid submissions", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 20,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-c"
            }
        });

        const submitParams = {
            id: loginReply.result.id,
            job_id: loginReply.result.job.job_id,
            nonce: "00000003",
            result: VALID_RESULT
        };

        const firstReply = await client.request({ id: 21, method: "submit", params: submitParams });
        const duplicateReply = await client.request({ id: 22, method: "submit", params: submitParams });

        assert.equal(firstReply.error, null);
        assert.equal(duplicateReply.error.message, "Duplicate share");
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("proxy miner path accepts worker and pool nonces", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 30,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "proxy-worker",
                agent: "xmr-node-proxy/0.0.1"
            }
        });

        assert.equal(loginReply.error, null);
        assert.ok(loginReply.result.job.blocktemplate_blob);

        const shareReply = await client.request({
            id: 31,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000004",
                result: VALID_RESULT,
                poolNonce: 7,
                workerNonce: 9
            }
        });

        await flushTimers();
        assert.equal(shareReply.error, null);
        assert.deepEqual(shareReply.result, { status: "OK" });
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("kawpow-style subscribe/authorize/submit flow works over the stratum wire format", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        const subscribeReply = await client.request({
            id: 40,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });

        assert.equal(subscribeReply.error, null);
        assert.equal(subscribeReply.result.length, 3);

        const authorizeReply = await client.request({
            id: 41,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker"]
        });

        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        const targetPush = await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        assert.equal(typeof targetPush.params[0], "string");
        assert.ok(targetPush.params[0].length > 0);
        assert.equal(typeof notifyPush.params[0], "string");

        const submitReply = await client.request({
            id: 42,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000001",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });

        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("fixed-difficulty logins expose the expected 4-byte target hex", async () => {
    const { runtime } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-fixed-target", height: 101 }),
                difficulty: 100000
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 42,
            method: "login",
            params: {
                login: `${MAIN_WALLET}+10000`,
                pass: "worker-fixed-target"
            }
        });

        assert.equal(loginReply.error, null);
        assert.equal(loginReply.result.status, "OK");
        assert.equal(loginReply.result.job.target, "b88d0600");
    } finally {
        await client.close();
        await runtime.stop();
    }
});
});
