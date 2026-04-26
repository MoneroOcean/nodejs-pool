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

test.describe("pool protocol: routing", { concurrency: false }, () => {
test("mining.authorize with an empty params array is rejected as malformed", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "mining.authorize",
            params: [],
            portData: global.config.ports[1]
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "No login specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("mining.submit rejects incompatible job formats for non-eth jobs", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 70,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-main-submit"
            }
        });

        const reply = invokePoolMethod({
            socket,
            id: 71,
            method: "mining.submit",
            params: [
                MAIN_WALLET,
                loginReply.replies[0].result.job.job_id,
                "0x0000000000000001"
            ],
            portData: global.config.ports[0]
        });

        assert.deepEqual(reply.replies, [{ error: "Invalid job params", result: undefined }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("low difficulty shares are rejected and stored as invalid", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 80,
            method: "login",
            params: {
                login: `${MAIN_WALLET}+100`,
                pass: "worker-low-diff"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 81,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000006",
                result: "ff".repeat(32)
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
    } finally {
        await runtime.stop();
    }
});

test("exceeding workerMax for one wallet triggers the connection ban path", async () => {
    const { runtime } = await startHarness();

    try {
        global.config.pool.workerMax = 1;

        const first = invokePoolMethod({
            socket: {},
            id: 90,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-one"
            }
        });
        assert.equal(first.replies[0].error, null);

        const second = invokePoolMethod({
            socket: {},
            id: 91,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-two"
            }
        });

        assert.equal(second.replies.length, 0);
        assert.deepEqual(second.finals, [{
            error: "Temporary (one hour max) ban on new miner connections since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)",
            timeout: 600
        }]);
    } finally {
        global.config.pool.workerMax = 20;
        await runtime.stop();
    }
});

test("default protocol miners receive a pushed job when the active template changes", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 100,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-push-default"
            }
        });

        const initialJobId = loginReply.replies[0].result.job.job_id;
        runtime.setTemplate(createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "main-template-push-default-2",
            height: 150
        }));

        assert.equal(loginReply.pushes.length, 1);
        assert.equal(loginReply.pushes[0].method, "job");
        assert.ok(loginReply.pushes[0].params.job_id);
        assert.notEqual(loginReply.pushes[0].params.job_id, initialJobId);
    } finally {
        await runtime.stop();
    }
});

test("payment split shares are persisted to each payout target with proportional rewards", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const reply = invokePoolMethod({
            socket,
            id: 101,
            method: "login",
            params: {
                login: `${MAIN_WALLET}%25%${ALT_WALLET}`,
                pass: "worker-split-accounting"
            }
        });

        const jobId = reply.replies[0].result.job.job_id;
        const submitReply = invokePoolMethod({
            socket,
            id: 102,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000016",
                result: VALID_RESULT
            }
        });

        await flushShareAccumulator(() => database.shares.length === 2);
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(database.shares.length, 2);

        const sharesByAddress = new Map(database.shares.map((entry) => [entry.payload.paymentAddress, entry.payload]));
        assert.equal(sharesByAddress.get(MAIN_WALLET).raw_shares, 0.75);
        assert.equal(sharesByAddress.get(ALT_WALLET).raw_shares, 0.25);
        assert.equal(sharesByAddress.get(MAIN_WALLET).share_num, 1);
        assert.equal(sharesByAddress.get(ALT_WALLET).share_num, 1);
    } finally {
        await runtime.stop();
    }
});

test("alt-port shares are stored against the current anchor height", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        await client.request({
            id: 120,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });

        const authorizeReply = await client.request({
            id: 121,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-alt-anchor"]
        });
        assert.equal(authorizeReply.error, null);

        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");
        const submitReply = await client.request({
            id: 122,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000017",
                `0x${notifyPush.params[1]}`,
                `0x${"ef".repeat(32)}`
            ]
        });

        assert.equal(submitReply.error, null);
        await flushShareAccumulator(() => database.shares.length === 1);
        assert.equal(database.shares.length, 1);
        assert.equal(database.shares[0].payload.paymentAddress, ETH_WALLET);
        assert.equal(database.shares[0].payload.port, ETH_PORT);
        assert.equal(database.shares[0].payload.blockHeight, 101);
    } finally {
        await client.close();
        await runtime.stop();
    }
});
});
