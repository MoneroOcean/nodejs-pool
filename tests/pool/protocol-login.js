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

test.describe("pool protocol: login parsing", { concurrency: false }, () => {
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
    await withLoggedInMiner(59, { login: MAIN_WALLET }, async (miner) => {
        assert.equal(miner.identifier, "x");
        assert.equal(miner.email, "");
    });
});

test("email-only passwords use the shorthand worker and store the email address", async () => {
    await withLoggedInMiner(60, {
        login: MAIN_WALLET,
        pass: "miner@example.com"
    }, async (miner) => {
        assert.equal(miner.identifier, "email");
        assert.equal(miner.email, "miner@example.com");
    });
});

test("dotted login suffix becomes the worker name when the password defaults to x", async () => {
    await withLoggedInMiner(61, {
        login: `${MAIN_WALLET}.dot-worker`
    }, async (miner) => {
        assert.equal(miner.identifier, "dot-worker");
        assert.equal(miner.email, "");
        assert.equal(miner.address, MAIN_WALLET);
        assert.equal(miner.payout, MAIN_WALLET);
        assert.equal(miner.paymentID, null);
    });
});

test("dotted login suffix is ignored when the password provides a worker name", async () => {
    await withLoggedInMiner(62, {
        login: `${MAIN_WALLET}.dot-worker`,
        pass: "worker-pass"
    }, async (miner) => {
        assert.equal(miner.identifier, "worker-pass");
        assert.equal(miner.address, MAIN_WALLET);
        assert.equal(miner.payout, MAIN_WALLET);
        assert.equal(miner.paymentID, null);
    });
});

test("worker and email password segments are parsed directly", async () => {
    await withLoggedInMiner(63, {
        login: MAIN_WALLET,
        pass: "worker-mail:miner@example.com"
    }, async (miner) => {
        assert.equal(miner.identifier, "worker-mail");
        assert.equal(miner.email, "miner@example.com");
        assert.equal(miner.address, MAIN_WALLET);
        assert.equal(miner.payout, MAIN_WALLET);
    });
});

test("password payout overrides replace the login wallet", async () => {
    await withLoggedInMiner(64, {
        login: MAIN_WALLET,
        pass: `worker-override:miner@example.com:${ALT_WALLET}`
    }, async (miner) => {
        assert.equal(miner.identifier, "worker-override");
        assert.equal(miner.email, "miner@example.com");
        assert.equal(miner.address, ALT_WALLET);
        assert.equal(miner.payout, ALT_WALLET);
    });
});

test("rigid takes precedence over password and dotted login worker names", async () => {
    await withLoggedInMiner(65, {
        login: `${MAIN_WALLET}.dot-worker`,
        pass: "worker-pass",
        rigid: "rigid-worker"
    }, async (miner) => {
        assert.equal(miner.identifier, "rigid-worker");
        assert.equal(miner.address, MAIN_WALLET);
        assert.equal(miner.payout, MAIN_WALLET);
    });
});

test("MinerGate agents force the MinerGate worker identifier", async () => {
    await withLoggedInMiner(66, {
        login: `${MAIN_WALLET}.dot-worker`,
        pass: "worker-pass",
        rigid: "rigid-worker",
        agent: "MinerGate/1.0"
    }, async (miner) => {
        assert.equal(miner.identifier, "MinerGate");
        assert.equal(miner.address, MAIN_WALLET);
        assert.equal(miner.payout, MAIN_WALLET);
    });
});

test("password algo suffix overrides the initial algo set", async () => {
    await withLoggedInMiner(67, {
        login: MAIN_WALLET,
        pass: "worker-algo~rx/0"
    }, async (miner) => {
        assert.equal(miner.identifier, "worker-algo");
        assert.equal(miner.algos["rx/0"], 1);
        assert.equal(Object.keys(miner.algos).length, 1);
        assert.equal(miner.algo_min_time, 60);
    });
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
});
