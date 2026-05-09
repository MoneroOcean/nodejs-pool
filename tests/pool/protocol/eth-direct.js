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

function patchEthProfile() {
    const originalPortBlobType = global.coinFuncs.portBlobType;
    global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
        if (port === ETH_PORT) return 102;
        return originalPortBlobType.call(this, port);
    };
    return function restoreEthProfile() {
        global.coinFuncs.portBlobType = originalPortBlobType;
    };
}

function setEasyEthShare(runtime, socket, header) {
    const state = runtime.getState();
    const miner = state.activeMiners.get(socket.miner_id);
    const jobId = miner.ethProxyWorkByHeader.get(String(header).replace(/^0x/, ""));
    const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
    job.difficulty = 1;
    job.rewarded_difficulty = 1;
    job.rewarded_difficulty2 = 1;
    job.norm_diff = 1;
    state.activeBlockTemplates.ETH.hash = "34".repeat(32);
    state.activeBlockTemplates.ETH.difficulty = 1000;
    return { miner, job };
}

function expectedEthProxyTarget(coinDiff) {
    const difficulty = Number(coinDiff);
    const max = (1n << 256n) - 1n;
    if (!Number.isFinite(difficulty) || difficulty <= 0) return "0x" + max.toString(16);
    const scale = 1000000n;
    const scaledDifficulty = BigInt(Math.max(1, Math.floor(difficulty * Number(scale))));
    const target = (max * scale) / scaledDifficulty;
    return "0x" + (target > max ? max : target).toString(16).padStart(64, "0");
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

test("eth-proxy login and getWork expose existing eth jobs without push protocol", async () => {
    const { runtime } = await startHarness();
    const restoreEthProfile = patchEthProfile();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 130,
            method: "eth_submitLogin",
            params: [ETH_WALLET, "ethproxy-worker"],
            portData: global.config.ports[1]
        });
        assert.deepEqual(loginReply.replies, [{ error: null, result: true }]);
        assert.equal(loginReply.pushes.length, 0);

        const getWorkReply = invokePoolMethod({
            socket,
            id: 131,
            method: "eth_getWork",
            params: [],
            portData: global.config.ports[1]
        });
        assert.equal(getWorkReply.replies[0].error, null);
        assert.equal(getWorkReply.replies[0].result.length, 3);
        assert.match(getWorkReply.replies[0].result[0], /^0x[0-9a-f]+$/);
        assert.match(getWorkReply.replies[0].result[1], /^0x[0-9a-f]+$/);
        assert.match(getWorkReply.replies[0].result[2], /^0x[0-9a-f]{64}$/);

        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = miner.ethProxyWorkByHeader.get(getWorkReply.replies[0].result[0].slice(2));
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        assert.equal(miner.protocol, "ethproxy");
        assert.equal(miner.agent, "[generic_eth_getwork]");
        assert.equal(miner.eth_extranonce, undefined);
        assert.equal(miner.ethProxyWorkByHeader.size, 1);
        assert.equal(getWorkReply.replies[0].result[2], expectedEthProxyTarget(job.difficulty));
        assert.equal(ETH_WALLET in runtime.getState().proxyMiners, false);

        runtime.setTemplate(createBaseTemplate({
            coin: "ETH",
            port: ETH_PORT,
            idHash: "eth-template-ethproxy-no-push",
            height: 260
        }));

        assert.equal(loginReply.pushes.length, 0);
    } finally {
        restoreEthProfile();
        await runtime.stop();
    }
});

test("eth-proxy getWork before login is rejected as unauthenticated", async () => {
    const { runtime } = await startHarness();
    const restoreEthProfile = patchEthProfile();

    try {
        const reply = invokePoolMethod({
            socket: {},
            id: 132,
            method: "eth_getWork",
            params: [],
            portData: global.config.ports[1]
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
    } finally {
        restoreEthProfile();
        await runtime.stop();
    }
});

test("eth-proxy submitWork with an unknown header is rejected before share validation", async () => {
    const { runtime, database } = await startHarness();
    const restoreEthProfile = patchEthProfile();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: 133,
            method: "eth_submitLogin",
            params: [ETH_WALLET, "ethproxy-worker"],
            portData: global.config.ports[1]
        });

        const reply = invokePoolMethod({
            socket,
            id: 134,
            method: "eth_submitWork",
            params: ["0x0000000000000001", `0x${"99".repeat(32)}`, `0x${"22".repeat(32)}`],
            portData: global.config.ports[1]
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);

        assert.deepEqual(reply.replies, [{ error: "Invalid job id", result: undefined }]);
        assert.equal(miner.invalidJobIdCount, 1);
        assert.equal(database.shares.length, 0);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        restoreEthProfile();
        await runtime.stop();
    }
});

test("eth-proxy submitWork routes through existing share validation and duplicate checks", async () => {
    const { runtime, database } = await startHarness();
    const restoreEthProfile = patchEthProfile();
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};
    let observedNonce = null;

    try {
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                observedNonce = nonce;
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        invokePoolMethod({
            socket,
            id: 135,
            method: "eth_submitLogin",
            params: [ETH_WALLET, "ethproxy-worker"],
            portData: global.config.ports[1]
        });
        const getWorkReply = invokePoolMethod({
            socket,
            id: 136,
            method: "eth_getWork",
            params: [],
            portData: global.config.ports[1]
        });
        const header = getWorkReply.replies[0].result[0];
        setEasyEthShare(runtime, socket, header);
        const nonce = "0x0f34211f05a0f09a";

        const first = invokePoolMethod({
            socket,
            id: 137,
            method: "eth_submitWork",
            params: [nonce, header, `0x${"22".repeat(32)}`],
            portData: global.config.ports[1]
        });
        await flushShareAccumulator(() => database.shares.length === 1);

        const second = invokePoolMethod({
            socket,
            id: 138,
            method: "eth_submitWork",
            params: [nonce, header, `0x${"22".repeat(32)}`],
            portData: global.config.ports[1]
        });

        assert.deepEqual(first.replies, [{ error: null, result: true }]);
        assert.deepEqual(second.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(observedNonce, nonce.slice(2));
        assert.equal(database.shares.length, 1);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        restoreEthProfile();
        await runtime.stop();
    }
});

test("eth-proxy submitWork rejects malformed nonces before hashing", async () => {
    const { runtime, database } = await startHarness({ freeEthExtranonces: [0xff7e] });
    const restoreEthProfile = patchEthProfile();
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};
    let observedNonce = null;

    try {
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                observedNonce = nonce;
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        invokePoolMethod({
            socket,
            id: 139,
            method: "eth_submitLogin",
            params: [ETH_WALLET, "ethproxy-worker"],
            portData: global.config.ports[1]
        });
        const getWorkReply = invokePoolMethod({
            socket,
            id: 140,
            method: "eth_getWork",
            params: [],
            portData: global.config.ports[1]
        });
        const header = getWorkReply.replies[0].result[0];
        setEasyEthShare(runtime, socket, header);

        const reply = invokePoolMethod({
            socket,
            id: 141,
            method: "eth_submitWork",
            params: ["0x000000000001", header, `0x${"22".repeat(32)}`],
            portData: global.config.ports[1]
        });

        assert.deepEqual(reply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(database.shares.length, 0);
        assert.equal(database.invalidShares.length, 1);
        assert.equal(observedNonce, null);
    } finally {
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        restoreEthProfile();
        await runtime.stop();
    }
});

test("eth-proxy telemetry methods are acknowledged without creating shares", async () => {
    const { runtime, database } = await startHarness();
    const restoreEthProfile = patchEthProfile();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: 142,
            method: "eth_submitLogin",
            params: [ETH_WALLET, "ethproxy-worker"],
            portData: global.config.ports[1]
        });
        const hashRateReply = invokePoolMethod({
            socket,
            id: 143,
            method: "eth_submitHashrate",
            params: ["0x0", "worker"],
            portData: global.config.ports[1]
        });
        const miningReply = invokePoolMethod({
            socket,
            id: 144,
            method: "eth_mining",
            params: [],
            portData: global.config.ports[1]
        });

        assert.deepEqual(hashRateReply.replies, [{ error: null, result: true }]);
        assert.deepEqual(miningReply.replies, [{ error: null, result: true }]);
        assert.equal(database.shares.length, 0);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        restoreEthProfile();
        await runtime.stop();
    }
});

test("eth-proxy telemetry before login is rejected as unauthenticated", async () => {
    const { runtime } = await startHarness();
    const restoreEthProfile = patchEthProfile();

    try {
        const reply = invokePoolMethod({
            socket: {},
            id: 145,
            method: "eth_submitHashrate",
            params: ["0x0", "worker"],
            portData: global.config.ports[1]
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
    } finally {
        restoreEthProfile();
        await runtime.stop();
    }
});
});
