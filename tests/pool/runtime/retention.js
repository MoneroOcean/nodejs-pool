"use strict";
const test = require("node:test");

const {
    assert,
    crypto,
    fs,
    fsp,
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ALT_WALLET,
    ETH_WALLET,
    VALID_RESULT,
    JsonLineClient,
    openRawSocket,
    waitForSocketClose,
    assertNoSocketData,
    waitForSocketJson,
    startHarness,
    flushTimers,
    invokePoolMethod,
    createBaseTemplate,
    poolModule,
    RX0_MAIN_SHARE_VECTORS,
    ZERO_RESULT,
    buildMainShareResult,
    createMainPowVectorMap,
    flushShareAccumulator,
    enableBlockSubmitTestMode,
    disableBlockSubmitTestMode,
    createBlockSubmitTemplates,
    createFrozenTime,
    setBlockSubmitTestMarker,
    withBlockSubmitTestMode,
    getLoginJobId,
    loginMainMiner,
    submitMainBlockCandidate,
    authorizeEthMiner,
    submitEthBlockCandidate,
    submitEthBlockCandidateWithClient,
    withCapturedConsoleError,
    requestRawJson
} = require("../common/runtime-helpers.js");

test.describe("pool runtime: retention", { concurrency: false }, () => {
test("invalid payout logins are throttled by payout instead of ip or agent", async () => {
    const { runtime } = await startHarness();
    const originalWorkerId = process.env.WORKER_ID;

    try {
        process.env.WORKER_ID = "1";

        invokePoolMethod({
            method: "login",
            params: {
                login: "bad-wallet-one",
                pass: "x",
                agent: "BadAgent/1"
            },
            ip: "10.0.0.91"
        });
        invokePoolMethod({
            method: "login",
            params: {
                login: "bad-wallet-one",
                pass: "x",
                agent: "BadAgent/2"
            },
            ip: "10.0.0.92"
        });

        const state = runtime.getState();
        assert.deepEqual(Object.keys(state.minerAgents), []);
        assert.deepEqual(Object.keys(state.lastMinerLogTime), ["bad-wallet-one"]);
    } finally {
        if (typeof originalWorkerId === "undefined") delete process.env.WORKER_ID;
        else process.env.WORKER_ID = originalWorkerId;
        await runtime.stop();
    }
});

test("banned payout logins are throttled by payout across IPs", async () => {
    const { runtime } = await startHarness();
    const originalConsoleLog = console.log;
    const loggedMessages = [];

    try {
        runtime.getState().bannedAddresses[MAIN_WALLET] = "manual blocklist";
        console.log = function patchedConsoleLog(message) {
            loggedMessages.push(message);
        };

        invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-one"
            },
            ip: "10.0.0.92"
        });
        invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-two"
            },
            ip: "10.0.0.93"
        });

        const state = runtime.getState();
        assert.deepEqual(Object.keys(state.lastMinerLogTime), [MAIN_WALLET]);
        assert.equal(loggedMessages.length, 1);
        assert.match(loggedMessages[0], /Permanently banned payment address/);
    } finally {
        console.log = originalConsoleLog;
        await runtime.stop();
    }
});

test("unsupported algo invalid miners are throttled by payout across worker names", async () => {
    const { runtime } = await startHarness();
    const originalConsoleLog = console.log;
    const loggedMessages = [];

    try {
        console.log = function patchedConsoleLog(message) {
            loggedMessages.push(message);
        };

        invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-one",
                algo: ["bad/algo"],
                "algo-perf": { "bad/algo": 1 }
            },
            ip: "10.0.0.91"
        });
        invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-two",
                algo: ["bad/algo"],
                "algo-perf": { "bad/algo": 1 }
            },
            ip: "10.0.0.92"
        });

        const state = runtime.getState();
        assert.deepEqual(Object.keys(state.lastMinerLogTime), [MAIN_WALLET]);
        assert.equal(loggedMessages.length, 1);
        assert.match(loggedMessages[0], /algo array must include at least one supported pool algo/);
    } finally {
        console.log = originalConsoleLog;
        await runtime.stop();
    }
});

test("share-path log updates do not clear existing invalid miner throttle keys", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            method: "login",
            params: {
                login: "999",
                pass: "999orr"
            },
            ip: "10.0.0.91"
        });

        const loginReply = invokePoolMethod({
            socket,
            id: 1190,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-low-diff-log"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;

        const submitReply = invokePoolMethod({
            socket,
            id: 1191,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000a",
                result: "ff".repeat(32)
            }
        });

        assert.equal(submitReply.replies[0].error, "Low difficulty share");
        assert.equal("999" in runtime.getState().lastMinerLogTime, true);
        assert.equal(MAIN_WALLET in runtime.getState().lastMinerLogTime, true);
    } finally {
        await runtime.stop();
    }
});

test("login bookkeeping prunes stale notification timestamps", async () => {
    const { runtime } = await startHarness();

    try {
        const staleTime = Date.now() - 48 * 60 * 60 * 1000;
        const state = runtime.getState();
        state.lastMinerNotifyTime["stale-wallet"] = staleTime;
        state.notifyAddresses[MAIN_WALLET] = "Update required";

        const loginReply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker:miner@example.com"
            }
        });

        assert.deepEqual(loginReply.finals, [{
            error: "Update required (miner will connect after several attempts)",
            timeout: undefined
        }]);
        assert.equal("stale-wallet" in runtime.getState().lastMinerNotifyTime, false);
        assert.equal(MAIN_WALLET in runtime.getState().lastMinerNotifyTime, true);
    } finally {
        await runtime.stop();
    }
});

test("email user records are created only after the first accepted share", async () => {
    const mainPowVectors = createMainPowVectorMap();
    const { runtime, mysql } = await startHarness({ realMainPow: true, mainPowVectors });
    const socket = {};
    const validVector = RX0_MAIN_SHARE_VECTORS[0];

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 1988,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker:miner@example.com"
            }
        });

        const loginUserQueries = mysql.queries.filter((entry) => entry.sql.includes("FROM users") || entry.sql.includes("INSERT INTO users"));
        assert.equal(loginUserQueries.length, 0);

        const jobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        const blockTemplate = runtime.getState().activeBlockTemplates[""];
        const result = buildMainShareResult(runtime, socket, jobId, validVector.nonce);

        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        blockTemplate.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 1989,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: validVector.nonce,
                result
            }
        });

        await flushTimers();
        await flushTimers();

        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        const userQueries = mysql.queries.filter((entry) => entry.sql.includes("FROM users") || entry.sql.includes("INSERT INTO users"));
        assert.equal(userQueries.filter((entry) => entry.sql.includes("FROM users")).length, 1);
        assert.equal(userQueries.filter((entry) => entry.sql.includes("INSERT INTO users")).length, 1);
        assert.equal(MAIN_WALLET in runtime.getState().walletLastCheckTime, true);
    } finally {
        await runtime.stop();
    }
});

test("successful logins prune stale tracked agents and cap stored agent length", async () => {
    const { runtime } = await startHarness();
    const originalWorkerId = process.env.WORKER_ID;

    try {
        process.env.WORKER_ID = "1";
        runtime.getState().minerAgents["stale-agent"] = Date.now() - 48 * 60 * 60 * 1000;

        const longAgent = "Agent/" + "x".repeat(400);
        const loginReply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "agent-track",
                agent: longAgent
            }
        });

        assert.equal(loginReply.replies[0].error, null);
        assert.equal(runtime.getState().activeMiners.size, 1);
        assert.deepEqual(Object.keys(runtime.getState().minerAgents), [longAgent.substring(0, 255)]);
    } finally {
        if (typeof originalWorkerId === "undefined") delete process.env.WORKER_ID;
        else process.env.WORKER_ID = originalWorkerId;
        await runtime.stop();
    }
});

test("registerPool stores the pool row and all configured ports", async () => {
    const { runtime, mysql } = await startHarness();

    try {
        poolModule.registerPool();
        await flushTimers();
        await flushTimers();

        assert.equal(mysql.queries[0].sql.includes("INSERT INTO pools"), true);
        assert.equal(mysql.queries[1].sql.includes("DELETE FROM ports"), true);
        assert.equal(mysql.queries.filter((entry) => entry.sql.includes("INSERT INTO ports")).length, 2);
    } finally {
        await runtime.stop();
    }
});
});
