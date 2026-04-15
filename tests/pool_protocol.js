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
} = require("./pool_harness.js");

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

test.describe("pool protocol", { concurrency: false }, () => {
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

test("subscribe previews do not consume extranonces before authorize", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7] });
    const firstClient = new JsonLineClient(ETH_PORT);
    const secondClient = new JsonLineClient(ETH_PORT);

    try {
        await firstClient.connect();
        const firstSubscribe = await firstClient.request({
            id: 57,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(firstSubscribe.error, null);
        const previewExtranonce = firstSubscribe.result[1];

        await secondClient.connect();
        const secondSubscribe = await secondClient.request({
            id: 58,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(secondSubscribe.error, null);
        assert.equal(secondSubscribe.result[1], previewExtranonce);

        const authorizeReply = await secondClient.request({
            id: 59,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker-preview"]
        });
        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);
    } finally {
        await firstClient.close();
        await secondClient.close();
        await runtime.stop();
    }
});

test("login without a login field is rejected", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: { pass: "worker-no-login" },
            ip: "10.0.0.66"
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "No login specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("login without a pass falls back to the default x worker name", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const reply = invokePoolMethod({
            socket,
            id: 59,
            method: "login",
            params: {
                login: MAIN_WALLET
            }
        });

        assert.equal(reply.replies[0].error, null);
        assert.equal(reply.replies[0].result.status, "OK");

        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        assert.equal(miner.identifier, "x");
        assert.equal(miner.email, "");
    } finally {
        await runtime.stop();
    }
});

test("email-only passwords use the shorthand worker and store the email address", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const reply = invokePoolMethod({
            socket,
            id: 60,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "miner@example.com"
            }
        });

        assert.equal(reply.replies[0].error, null);
        assert.equal(reply.replies[0].result.status, "OK");

        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        assert.equal(miner.identifier, "email");
        assert.equal(miner.email, "miner@example.com");
    } finally {
        await runtime.stop();
    }
});

test("getjob without params is rejected", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({ method: "getjob", params: null });
        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "No params specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("getjobtemplate before login is rejected as unauthenticated", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({ method: "getjobtemplate", params: {} });
        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("authenticated getjob returns null when no fresh job is available", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 60,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-getjob"
            }
        });

        const minerId = loginReply.replies[0].result.id;
        const getjobReply = invokePoolMethod({
            socket,
            id: 61,
            method: "getjob",
            params: { id: minerId }
        });

        assert.equal(getjobReply.finals.length, 0);
        assert.equal(getjobReply.replies.length, 1);
        assert.equal(getjobReply.replies[0].error, null);
        assert.equal(getjobReply.replies[0].result, null);
    } finally {
        await runtime.stop();
    }
});

test("authenticated getjobtemplate returns a job for grin-style callers", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: "Stratum",
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-template"
            }
        });

        const reply = invokePoolMethod({
            socket,
            id: 62,
            method: "getjobtemplate",
            params: {}
        });

        assert.equal(reply.finals.length, 0);
        assert.equal(reply.replies.length, 1);
        assert.equal(reply.replies[0].error, null);
        assert.ok(reply.replies[0].result.job_id);
    } finally {
        await runtime.stop();
    }
});

test("mining.authorize rejects non-array params", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "mining.authorize",
            params: { login: ETH_WALLET },
            portData: global.config.ports[1]
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "No array params specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("mining.extranonce.subscribe acknowledges successfully", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "mining.extranonce.subscribe",
            params: [],
            portData: global.config.ports[1]
        });

        assert.deepEqual(reply.replies, [{ error: null, result: true }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("mining.submit rejects missing array params", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "mining.submit",
            params: null,
            portData: global.config.ports[1]
        });

        assert.deepEqual(reply.replies, [{ error: "No array params specified", result: undefined }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("mining.submit rejects non-string array params", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "mining.submit",
            params: [ETH_WALLET, "job-1", 7],
            portData: global.config.ports[1]
        });

        assert.deepEqual(reply.replies, [{ error: "Not correct params specified", result: undefined }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("mining.submit rejects arrays that are too short", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "mining.submit",
            params: [ETH_WALLET, "job-1"],
            portData: global.config.ports[1]
        });

        assert.deepEqual(reply.replies, [{ error: "Not correct params specified", result: undefined }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

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

test("grin protocol miners receive pushed getjobtemplate updates", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: "Stratum",
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-push-grin"
            }
        });

        assert.deepEqual(loginReply.replies, [{ error: null, result: "ok" }]);

        runtime.setTemplate(createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "main-template-push-grin-2",
            height: 151
        }));

        assert.equal(loginReply.pushes.length, 1);
        assert.equal(loginReply.pushes[0].method, "getjobtemplate");
        assert.ok(loginReply.pushes[0].result.job_id);
    } finally {
        await runtime.stop();
    }
});

test("eth-style direct miners receive mining.set_difficulty and mining.notify pushes", async () => {
    const { runtime } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        runtime.getState().activeBlockTemplates.ETH.hash = "34".repeat(32);

        const subscribeReply = invokePoolMethod({
            socket,
            id: 110,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        assert.equal(subscribeReply.replies[0].error, null);

        const authorizeReply = invokePoolMethod({
            socket,
            id: 111,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-style-worker"],
            portData: global.config.ports[1]
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);

        assert.deepEqual(authorizeReply.replies, [{ error: null, result: true }]);
        assert.equal(authorizeReply.pushes.length, 2);
        assert.equal(authorizeReply.pushes[0].method, "mining.set_difficulty");
        assert.equal(typeof authorizeReply.pushes[0].params[0], "number");
        assert.equal(authorizeReply.pushes[1].method, "mining.notify");
        assert.equal(Array.isArray(authorizeReply.pushes[1].params), true);
        assert.equal(miner.algos.ethash, 1);
        assert.equal("kawpow" in miner.algos, false);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        await runtime.stop();
    }
});

test("eth-style keepalived requests stay bound to the authenticated socket", async () => {
    const { runtime } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };

        invokePoolMethod({
            socket,
            id: 112,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        invokePoolMethod({
            socket,
            id: 113,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-style-keepalived"],
            portData: global.config.ports[1]
        });

        const keepaliveReply = invokePoolMethod({
            socket,
            id: 114,
            method: "keepalived",
            params: { id: "eth.nicehash.connection" },
            portData: global.config.ports[1]
        });

        assert.deepEqual(keepaliveReply.replies, [{ error: null, result: { status: "KEEPALIVED" } }]);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        await runtime.stop();
    }
});

test("eth-style direct miners accept submits with a full nonce that already includes the assigned extranonce", async () => {
    const { runtime, database } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};
    let observedNonce = null;

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                observedNonce = nonce;
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        const subscribeReply = invokePoolMethod({
            socket,
            id: 114,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        const extraNonce = subscribeReply.replies[0].result[1];

        const authorizeReply = invokePoolMethod({
            socket,
            id: 115,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-style-full-nonce"],
            portData: global.config.ports[1]
        });
        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((message) => message.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 116,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                `0x${extraNonce}000000000001`,
                `0x${"11".repeat(32)}`,
                `0x${"22".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        await flushShareAccumulator(() => database.shares.length === 1);
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(observedNonce, `${extraNonce}000000000001`);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(database.shares.length, 1);
        assert.equal(database.shares[0].payload.paymentAddress, ETH_WALLET);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});

test("eth-style direct miners still accept submits that provide only the nonce suffix", async () => {
    const { runtime, database } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};
    let observedNonce = null;

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                observedNonce = nonce;
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        const subscribeReply = invokePoolMethod({
            socket,
            id: 117,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        const extraNonce = subscribeReply.replies[0].result[1];

        const authorizeReply = invokePoolMethod({
            socket,
            id: 118,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-style-suffix-nonce"],
            portData: global.config.ports[1]
        });
        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((message) => message.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 119,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x000000000001",
                `0x${"11".repeat(32)}`,
                `0x${"22".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        await flushShareAccumulator(() => database.shares.length === 1);
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(observedNonce, `${extraNonce}000000000001`);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(database.shares.length, 1);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});

test("eth-style direct miners accept full nonces that do not start with the subscribe extranonce", async () => {
    const { runtime, database } = await startHarness({ freeEthExtranonces: [0xff7e] });
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};
    let observedNonce = null;

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                observedNonce = nonce;
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        const subscribeReply = invokePoolMethod({
            socket,
            id: 120,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        const extraNonce = subscribeReply.replies[0].result[1];
        assert.equal(extraNonce, "ff7e");

        const authorizeReply = invokePoolMethod({
            socket,
            id: 121,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-style-live-full-nonce"],
            portData: global.config.ports[1]
        });
        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((message) => message.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        // Captured from SRBMiner 3.2.5 against sg.moneroocean.stream:10001.
        const liveCapturedNonce = "0f34211f05a0f09a";
        assert.equal(liveCapturedNonce.startsWith(extraNonce), false);

        const submitReply = invokePoolMethod({
            socket,
            id: 122,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                `0x${liveCapturedNonce}`,
                `0x${"11".repeat(32)}`,
                `0x${"22".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        await flushShareAccumulator(() => database.shares.length === 1);
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(database.invalidShares.length, 0);
        assert.equal(database.shares.length, 1);
        assert.equal(observedNonce, liveCapturedNonce);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});

test("eth-style template refresh sends mining.notify without repeating mining.set_difficulty when diff is unchanged", async () => {
    const { runtime } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };

        invokePoolMethod({
            socket,
            id: 112,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 113,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-style-refresh"],
            portData: global.config.ports[1]
        });

        assert.equal(authorizeReply.pushes.length, 2);

        runtime.setTemplate(createBaseTemplate({
            coin: "ETH",
            port: ETH_PORT,
            idHash: "eth-template-push-2",
            height: 250
        }));

        assert.equal(authorizeReply.pushes.length, 3);
        assert.equal(authorizeReply.pushes[2].method, "mining.notify");
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        await runtime.stop();
    }
});
});
