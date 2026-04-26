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

test.describe("pool protocol: eth direct", { concurrency: false }, () => {
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
        assert.equal(subscribeReply.replies[0].result.length, 3);
        assert.equal(subscribeReply.replies[0].result[0][2], "EthereumStratum/1.0.0");
        assert.equal(/^[0-9a-f]+$/.test(subscribeReply.replies[0].result[1]), true);
        assert.equal(subscribeReply.replies[0].result[2], 6);

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

test("ethereum-stratum subscribe omits nonce suffix size for nicehash-style clients", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const subscribeReply = invokePoolMethod({
            socket,
            id: 109,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0", "EthereumStratum/1.0.0"],
            portData: global.config.ports[1]
        });

        assert.equal(subscribeReply.replies[0].error, null);
        assert.equal(subscribeReply.replies[0].result.length, 2);
        assert.equal(subscribeReply.replies[0].result[0][2], "EthereumStratum/1.0.0");
        assert.equal(/^[0-9a-f]+$/.test(subscribeReply.replies[0].result[1]), true);
    } finally {
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

test("eth-style direct miners reject full nonces that do not start with the subscribe extranonce", async () => {
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

        await flushShareAccumulator(() => database.invalidShares.length === 1);
        assert.deepEqual(submitReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(database.invalidShares.length, 1);
        assert.equal(database.shares.length, 0);
        assert.equal(observedNonce, null);
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
