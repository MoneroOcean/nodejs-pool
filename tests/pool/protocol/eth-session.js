"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ETH_WALLET,
    VALID_RESULT,
    JsonLineClient,
    startHarness,
    flushTimers,
    invokePoolMethod,
    createBaseTemplate
} = require("../common/harness.js");

test.describe("pool protocol: eth session", { concurrency: false }, () => {
test("the same socket cannot login twice", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const first = invokePoolMethod({
            socket,
            id: 1,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-first"
            }
        });

        assert.equal(first.finals.length, 0);
        assert.equal(first.replies.length, 1);
        assert.equal(first.replies[0].error, null);
        assert.equal(first.replies[0].result.status, "OK");
        assert.ok(socket.miner_id);

        const second = invokePoolMethod({
            socket,
            id: 2,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-second"
            }
        });

        assert.equal(second.replies.length, 0);
        assert.deepEqual(second.finals, [{ error: "No double login is allowed", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("mining.authorize on a generic eth-style port falls back instead of crashing", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const authorizeReply = invokePoolMethod({
            socket,
            id: 9,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-generic-port~autolykos2"],
            portData: { port: 20001, difficulty: 1, portType: "pplns" }
        });

        assert.deepEqual(authorizeReply.replies, [{ error: null, result: true }]);
        assert.equal(authorizeReply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("malformed submit nonces are rejected and recorded as invalid shares", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 10,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-malformed"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 11,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "not-a-nonce",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(submitReply.finals.length, 0);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("authenticated submit without params is rejected before share handling", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: 12,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-submit-no-params"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 13,
            method: "submit",
            params: null
        });

        assert.equal(submitReply.replies.length, 0);
        assert.deepEqual(submitReply.finals, [{ error: "No params specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("authenticated submit with a missing job id is rejected", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: 14,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-submit-missing-job"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 15,
            method: "submit",
            params: {
                id: socket.miner_id,
                nonce: "0000000b",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Invalid job id", result: undefined }]);
        assert.equal(submitReply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("shares for jobs that have fallen out of the template history are rejected as expired", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 20,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-expired"
            }
        });
        const originalJobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const originalJob = miner.validJobs.toarray().find((job) => job.id === originalJobId);

        for (let height = 102; height <= 113; height += 1) {
            runtime.setTemplate(createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: `main-template-${height}`,
                height
            }));
        }

        miner.validJobs.enq(originalJob);

        const submitReply = invokePoolMethod({
            socket,
            id: 21,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: originalJobId,
                nonce: "00000005",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Block expired", result: undefined }]);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("eth subscribe and authorize fail cleanly when no extranonces are available", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [] });

    try {
        const subscribeReply = invokePoolMethod({
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        assert.equal(subscribeReply.replies.length, 0);
        assert.deepEqual(subscribeReply.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);

        const authorizeReply = invokePoolMethod({
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker"],
            portData: global.config.ports[1]
        });
        assert.equal(authorizeReply.replies.length, 0);
        assert.deepEqual(authorizeReply.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("extranonce exhaustion notifications are rate-limited", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [] });
    const originalNow = Date.now;
    const originalCooldown = global.config.pool.ethExtranonceOverflowNotifyCooldown;
    let fakeNow = 1000;

    try {
        Date.now = () => fakeNow;
        global.config.pool.ethExtranonceOverflowNotifyCooldown = 60;

        const firstAuthorize = invokePoolMethod({
            socket: {},
            id: 760,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-overflow-one"],
            portData: global.config.ports[1]
        });
        assert.deepEqual(firstAuthorize.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);
        assert.equal(global.support.emails.length, 1);

        fakeNow += 1000;
        const secondAuthorize = invokePoolMethod({
            socket: {},
            id: 761,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-overflow-two"],
            portData: global.config.ports[1]
        });
        assert.deepEqual(secondAuthorize.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);
        assert.equal(global.support.emails.length, 1);

        fakeNow += 60000;
        const thirdAuthorize = invokePoolMethod({
            socket: {},
            id: 762,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-overflow-three"],
            portData: global.config.ports[1]
        });
        assert.deepEqual(thirdAuthorize.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);
        assert.equal(global.support.emails.length, 2);
    } finally {
        Date.now = originalNow;
        global.config.pool.ethExtranonceOverflowNotifyCooldown = originalCooldown;
        await runtime.stop();
    }
});

test("eth submit sent before authorize is rejected as unauthenticated", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const subscribeReply = invokePoolMethod({
            socket,
            id: 52,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        assert.equal(subscribeReply.replies[0].error, null);
        assert.equal(subscribeReply.finals.length, 0);

        const submitReply = invokePoolMethod({
            socket,
            id: 53,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                "missing-job",
                "0x0000000000000001",
                `0x${"00".repeat(32)}`,
                `0x${"ab".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        assert.equal(submitReply.replies.length, 0);
        assert.deepEqual(submitReply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("eth sockets cannot authorize twice on the same connection", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const subscribeReply = invokePoolMethod({
            socket,
            id: 54,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        assert.equal(subscribeReply.replies[0].error, null);

        const firstAuthorize = invokePoolMethod({
            socket,
            id: 55,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker-one"],
            portData: global.config.ports[1]
        });
        assert.deepEqual(firstAuthorize.replies, [{ error: null, result: true }]);

        const secondAuthorize = invokePoolMethod({
            socket,
            id: 56,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker-two"],
            portData: global.config.ports[1]
        });

        assert.equal(secondAuthorize.replies.length, 0);
        assert.deepEqual(secondAuthorize.finals, [{ error: "No double login is allowed", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("closing an eth stratum socket releases its extranonce for reuse", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7] });
    const firstClient = new JsonLineClient(ETH_PORT);
    const secondClient = new JsonLineClient(ETH_PORT);

    try {
        await firstClient.connect();
        const firstSubscribe = await firstClient.request({
            id: 50,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(firstSubscribe.error, null);
        const extranonce = firstSubscribe.result[1];

        await firstClient.close();
        await flushTimers();

        await secondClient.connect();
        const secondSubscribe = await secondClient.request({
            id: 51,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(secondSubscribe.error, null);
        assert.equal(secondSubscribe.result[1], extranonce);
    } finally {
        await firstClient.close();
        await secondClient.close();
        await runtime.stop();
    }
});

test("eth subscribe reserves unique extranonces before authorize", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7, 8] });
    const victimSocket = {};
    const attackerSocket = {};

    try {
        const victimSubscribe = invokePoolMethod({
            socket: victimSocket,
            id: 57,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        const attackerSubscribe = invokePoolMethod({
            socket: attackerSocket,
            id: 58,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        assert.equal(victimSubscribe.replies[0].error, null);
        assert.equal(attackerSubscribe.replies[0].error, null);
        assert.notEqual(victimSubscribe.replies[0].result[1], attackerSubscribe.replies[0].result[1]);
        assert.equal(victimSubscribe.replies[0].result[1], "0008");
        assert.equal(attackerSubscribe.replies[0].result[1], "0007");
        assert.equal(victimSocket.eth_extranonce_preview_id, 8);
        assert.equal(attackerSocket.eth_extranonce_preview_id, 7);
        assert.equal(victimSocket.eth_extranonce_id, undefined);
        assert.equal(attackerSocket.eth_extranonce_id, undefined);

        const attackerAuthorize = invokePoolMethod({
            socket: attackerSocket,
            id: 59,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker-attacker"],
            portData: global.config.ports[1]
        });
        const victimAuthorize = invokePoolMethod({
            socket: victimSocket,
            id: 60,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker-victim"],
            portData: global.config.ports[1]
        });

        assert.deepEqual(attackerAuthorize.replies, [{ error: null, result: true }]);
        assert.deepEqual(victimAuthorize.replies, [{ error: null, result: true }]);
        assert.equal(attackerSocket.eth_extranonce_preview_id, undefined);
        assert.equal(victimSocket.eth_extranonce_preview_id, undefined);
        assert.equal(attackerSocket.eth_extranonce_id, 7);
        assert.equal(victimSocket.eth_extranonce_id, 8);
        assert.equal(runtime.getState().activeMiners.get(attackerSocket.miner_id).eth_extranonce, "0007");
        assert.equal(runtime.getState().activeMiners.get(victimSocket.miner_id).eth_extranonce, "0008");
    } finally {
        await runtime.stop();
    }
});
});
