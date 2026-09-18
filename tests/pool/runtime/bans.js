"use strict";
const test = require("node:test");
const createTemplateManager = require("../../../lib/pool/templates.js");

const {
    assert,
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    VALID_RESULT,
    startHarness,
    invokePoolMethod,
    createBaseTemplate,
    poolModule
} = require("../common/runtime-helpers.js");

function createTemplateHarness(factors) {
    const state = {
        activeBlockTemplates: {},
        daemonFailureSince: {},
        lastBlockHash: {},
        lastBlockHeight: {},
        lastBlockHashMM: {},
        lastBlockHeightMM: {},
        lastBlockTime: {},
        lastBlockKeepTime: {},
        lastBlockReward: {},
        newCoinHashFactor: { ...factors },
        lastCoinHashFactor: { ...factors },
        lastCoinHashFactorMM: { ...factors }
    };
    const manager = createTemplateManager({
        cluster: { isMaster: false },
        debug() {},
        daemonPollMs: 500,
        activeMiners: new Map(),
        activeBlockTemplates: state.activeBlockTemplates,
        pastBlockTemplates: {},
        lastBlockHash: state.lastBlockHash,
        lastBlockHeight: state.lastBlockHeight,
        lastBlockHashMM: state.lastBlockHashMM,
        lastBlockHeightMM: state.lastBlockHeightMM,
        lastBlockTime: state.lastBlockTime,
        lastBlockKeepTime: state.lastBlockKeepTime,
        lastBlockReward: state.lastBlockReward,
        newCoinHashFactor: state.newCoinHashFactor,
        lastCoinHashFactor: state.lastCoinHashFactor,
        lastCoinHashFactorMM: state.lastCoinHashFactorMM,
        daemonFailureSince: state.daemonFailureSince,
        anchorState: {},
        sendToWorkers() {},
        getThreadName() { return ""; },
        formatCoinPort(coin, port) { return `${coin  }/${  port}`; }
    });
    return { manager, state };
}

test.describe("pool runtime: bans and updates", { concurrency: false }, () => {
test("ban threshold removes miners that cross the invalid share percentage", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;
    const originalBanThreshold = global.config.pool.banThreshold;
    const originalBanPercent = global.config.pool.banPercent;
    const socket = {};
    const ip = "10.0.0.88";

    try {
        cluster.isMaster = false;
        global.config.pool.banThreshold = 3;
        global.config.pool.banPercent = 50;

        const loginReply = invokePoolMethod({
            socket,
            id: 183,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "ban-threshold"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        invokePoolMethod({
            socket,
            id: 184,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000e",
                result: VALID_RESULT
            },
            ip
        });

        invokePoolMethod({
            socket,
            id: 185,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "not-a-nonce",
                result: VALID_RESULT
            },
            ip
        });

        const secondBadShare = invokePoolMethod({
            socket,
            id: 186,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "still-not-a-nonce",
                result: VALID_RESULT
            },
            ip
        });

        assert.deepEqual(secondBadShare.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), false);
        assert.equal(runtime.getState().bannedTmpIPs[ip], 1);

        const reloginReply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "ban-threshold-retry"
            },
            ip
        });
        assert.deepEqual(reloginReply.finals, [{
            error: "New connections from this IP address are temporarily suspended from mining (10 minutes max)",
            timeout: undefined
        }]);
    } finally {
        cluster.isMaster = originalIsMaster;
        global.config.pool.banThreshold = originalBanThreshold;
        global.config.pool.banPercent = originalBanPercent;
        await runtime.stop();
    }
});

test("ban counters reset instead of banning when invalid share percentage stays below the threshold", async () => {
    const { runtime } = await startHarness();
    const originalBanThreshold = global.config.pool.banThreshold;
    const originalBanPercent = global.config.pool.banPercent;
    const socket = {};

    try {
        global.config.pool.banThreshold = 2;
        global.config.pool.banPercent = 60;

        const loginReply = invokePoolMethod({
            socket,
            id: 187,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "ban-reset"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;

        invokePoolMethod({
            socket,
            id: 188,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000f",
                result: VALID_RESULT
            }
        });

        invokePoolMethod({
            socket,
            id: 189,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "bad-reset-nonce",
                result: VALID_RESULT
            }
        });

        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), true);
        assert.equal(miner.validShares, 0);
        assert.equal(miner.invalidShares, 0);
    } finally {
        global.config.pool.banThreshold = originalBanThreshold;
        global.config.pool.banPercent = originalBanPercent;
        await runtime.stop();
    }
});

test("whitelisted miners are not banned for invalid shares", async () => {
    const { runtime } = await startHarness();
    const socket = {};
    const ip = "10.0.0.90";

    try {
        runtime.getState().ip_whitelist[ip] = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 190,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "whitelist-bypass"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const badShareReply = invokePoolMethod({
            socket,
            id: 191,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "not-whitelisted-nonce",
                result: VALID_RESULT
            },
            ip
        });

        assert.deepEqual(badShareReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), true);
        assert.equal(runtime.getState().bannedTmpIPs[ip], undefined);
    } finally {
        await runtime.stop();
    }
});

test("messageHandler sendRemote queues the payload in master mode", async () => {
    const { runtime, database } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = true;
        poolModule.messageHandler({ type: "sendRemote", body: "abcd" });

        assert.equal(database.sendQueue.length(), 1);
        assert.equal(database.sentFrames[0].body.equals(Buffer.from("abcd", "hex")), true);
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("messageHandler newBlockTemplate updates the active template", async () => {
    const { runtime } = await startHarness();

    try {
        poolModule.messageHandler({
            type: "newBlockTemplate",
            data: createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: "main-template-message-handler",
                height: 333
            })
        });

        assert.equal(runtime.getState().activeBlockTemplates[""].height, 333);
    } finally {
        await runtime.stop();
    }
});

test("templateUpdate2 rejects blobless CCX templates before they reach BlockTemplate", async () => {
    const { runtime } = await startHarness();
    const originalGetPortBlockTemplate = global.coinFuncs.getPortBlockTemplate;
    const originalSetTimeout = global.setTimeout;
    const ccxPort = 16000;
    let requestCount = 0;

    try {
        poolModule.setTestCoinHashFactor("CCX", 1);

        global.coinFuncs.getPortBlockTemplate = function getPortBlockTemplate(_port, callback) {
            requestCount += 1;
            callback({
                block_header: {
                    height: 2046248,
                    major_version: 8,
                    minor_version: 0,
                    nonce: 3221306306,
                    hash: "80397cb2f994510668ae5489ab17f2e6a21c838f35eb02db40dec799b008c0ab",
                    prev_hash: "2dda11c301cf640a502e0d9722df6ee35e9b246e654d6cb32b212ef9c8b5a3d6",
                    timestamp: 1775567137,
                    difficulty: 43600000,
                    reward: 6000000
                },
                status: "OK"
            });
        };
        global.setTimeout = function immediateTimeout(fn, _delay, ...args) {
            fn(...args);
            return 0;
        };

        poolModule.templateUpdate2(
            "CCX",
            ccxPort,
            true,
            false,
            1,
            false,
            { height: 2046248, hash: "80397cb2f994510668ae5489ab17f2e6a21c838f35eb02db40dec799b008c0ab" }
        );

        assert.equal(requestCount, 3);
        assert.equal(runtime.getState().activeBlockTemplates.CCX, undefined);
    } finally {
        global.coinFuncs.getPortBlockTemplate = originalGetPortBlockTemplate;
        global.setTimeout = originalSetTimeout;
        await runtime.stop();
    }
});

test("header polling records stale health until a fresh header succeeds", async () => {
    const originalConfig = global.config;
    const originalCoinFuncs = global.coinFuncs;
    const originalNow = Date.now;
    const now = 20_000_000;
    let header = {
        height: 400,
        hash: "stale-header",
        timestamp: now / 1000 - 10801
    };
    let templateManager;

    try {
        global.config = { daemon: { port: MAIN_PORT, maxBlockAgeSeconds: 10800 } };
        Date.now = function () { return now; };
        global.coinFuncs = {
            COIN2PORT() { return MAIN_PORT; },
            getPortLastBlockHeaderMM(_port, callback) { callback(null, header); }
        };
        const harness = createTemplateHarness({ "": 1 });
        templateManager = harness.manager;
        harness.state.lastBlockHash[""] = header.hash;
        harness.state.lastBlockTime[""] = now;

        templateManager.templateUpdate("", false);
        assert.equal(harness.state.daemonFailureSince[`xmr:${  MAIN_PORT}`], now);

        header = {
            height: 400,
            hash: "fresh-header",
            timestamp: now / 1000
        };
        harness.state.lastBlockHash[""] = header.hash;
        templateManager.templateUpdate("", false);
        assert.equal(harness.state.daemonFailureSince[`xmr:${  MAIN_PORT}`], undefined);
    } finally {
        global.config = originalConfig;
        global.coinFuncs = originalCoinFuncs;
        Date.now = originalNow;
    }
});

test("header and template RPC failure grace remain independent", async () => {
    const originalConfig = global.config;
    const originalCoinFuncs = global.coinFuncs;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const altPort = ETH_PORT;
    const altCoin = "ETH";
    const graceTimers = [];
    let headerError = null;
    let header = { height: 1, hash: "alt-header" };
    let templateResult = null;
    let templateError = new Error("coin daemon restarting");
    let templateManager;

    try {
        global.config = { daemon: { port: MAIN_PORT, pollInterval: 500 }, pool: { trustedMiners: false } };
        global.setTimeout = function captureTimeout(fn, delay, ...args) {
            if (delay === 500) {
                fn(...args);
                return { unref() {} };
            }
            const timer = { fn, delay, cleared: false, unref() {} };
            graceTimers.push(timer);
            return timer;
        };
        global.clearTimeout = function clearCapturedTimeout(timer) { timer.cleared = true; };
        global.coinFuncs = {
            COIN2PORT() { return altPort; },
            getPoolProfile() { return {}; },
            getPortLastBlockHeaderMM(_port, callback) { callback(headerError, header); },
            getPortBlockTemplate(_port, callback) { callback(templateResult, templateError); },
            getAuxChainXTM() { return null; },
            hasTemplateBlob() { return true; },
            getMM_PORTS() { return {}; }
        };
        const harness = createTemplateHarness({ ETH: 2 });
        templateManager = harness.manager;
        const state = harness.state;

        templateManager.templateUpdate(altCoin, false);
        assert.equal(state.newCoinHashFactor[altCoin], 2);
        assert.equal(state.daemonFailureSince[`factor:${  altCoin  }:${  altPort}`], undefined);
        assert.equal(graceTimers.length, 1);
        assert.equal(graceTimers[0].delay, 60 * 1000);

        templateManager.templateUpdate(altCoin, false);
        assert.equal(state.newCoinHashFactor[altCoin], 2);
        assert.equal(graceTimers.length, 1);

        graceTimers[0].fn();
        assert.equal(state.newCoinHashFactor[altCoin], 0);

        state.newCoinHashFactor[altCoin] = state.lastCoinHashFactor[altCoin] = state.lastCoinHashFactorMM[altCoin] = 2;
        headerError = new Error("header RPC unavailable");
        header = undefined;
        templateManager.templateUpdate(altCoin, false);
        assert.equal(graceTimers.length, 2);

        templateResult = { height: 2, difficulty: 100, blocktemplate_blob: "00" };
        templateError = null;
        state.lastBlockKeepTime[altCoin] = Date.now();
        templateManager.templateUpdate2(altCoin, altPort, false, false, 2, false, { height: 2, hash: "new-header" });

        assert.equal(graceTimers[1].cleared, false);
        graceTimers[1].fn();
        assert.equal(state.newCoinHashFactor[altCoin], 0);
    } finally {
        global.config = originalConfig;
        global.coinFuncs = originalCoinFuncs;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test("successful template RPC clears daemon-error factor grace", async () => {
    const { runtime } = await startHarness();
    const originalTemplateRpc = global.coinFuncs.getPortBlockTemplate;
    const originalHasTemplateBlob = global.coinFuncs.hasTemplateBlob;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const altPort = 16000;
    const graceTimers = [];

    try {
        poolModule.setTestCoinHashFactor("CCX", 2);
        global.setTimeout = function captureTimeout(fn, delay, ...args) {
            if (delay === 500) {
                fn(...args);
                return { unref() {} };
            }
            const timer = { fn, delay, cleared: false, unref() {} };
            graceTimers.push(timer);
            return timer;
        };
        global.clearTimeout = function clearCapturedTimeout(timer) { timer.cleared = true; };
        global.coinFuncs.getPortBlockTemplate = function getTemplate(_port, callback) {
            callback(null, new Error("coin daemon restarting"));
        };
        poolModule.templateUpdate2("CCX", altPort, true, false, 2, false, { height: 2, hash: "alt-header-1" });
        assert.equal(graceTimers.length, 1);

        global.coinFuncs.getPortBlockTemplate = function getTemplate(_port, callback) {
            callback(createBaseTemplate({ coin: "CCX", port: altPort, idHash: "alt-template", height: 2 }), null);
        };
        global.coinFuncs.hasTemplateBlob = function hasTemplateBlob() { return true; };
        poolModule.templateUpdate2("CCX", altPort, true, false, 2, false, { height: 2, hash: "alt-header-2" });

        assert.equal(graceTimers[0].cleared, true);
        graceTimers[0].fn();
        assert.equal(runtime.getState().newCoinHashFactor.CCX, 2);
    } finally {
        global.coinFuncs.getPortBlockTemplate = originalTemplateRpc;
        global.coinFuncs.hasTemplateBlob = originalHasTemplateBlob;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        await runtime.stop();
    }
});

test("setNewCoinHashFactor marks matching miners for extra verification on hash-factor changes", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        invokePoolMethod({
            socket,
            id: 192,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "coin-hash-factor-refresh"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);

        poolModule.setNewCoinHashFactor(true, "", 2, 777);

        assert.equal(miner.trust.check_height, 777);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        await runtime.stop();
    }
});

test("messageHandler minerPortCount stores the reported per-port counts in master mode", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = true;
        poolModule.messageHandler({
            type: "minerPortCount",
            data: {
                worker_id: 7,
                ports: { [MAIN_PORT]: 2, [ETH_PORT]: 1 }
            }
        });

        assert.deepEqual(runtime.getState().workerMinerCounts[7], { [MAIN_PORT]: 2, [ETH_PORT]: 1 });
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("retargetMiners updates miner counts and pushes a new job when difficulty changes", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 193,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "retarget"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);

        loginReply.pushes.length = 0;
        miner.calcNewDiff = () => miner.difficulty + 10;

        poolModule.retargetMiners();

        assert.equal(loginReply.pushes.length, 1);
        assert.equal(loginReply.pushes[0].method, "job");
        assert.equal(runtime.getState().minerCount[MAIN_PORT], 1);
    } finally {
        await runtime.stop();
    }
});

test("templateUpdate2 publishes valid templates without expected_reward", async () => {
    const { runtime } = await startHarness();
    const originalTemplateRpc = global.coinFuncs.getPortBlockTemplate;
    const originalHasTemplateBlob = global.coinFuncs.hasTemplateBlob;
    const template = createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-no-expected-reward", height: 450 });

    try {
        global.coinFuncs.getPortBlockTemplate = function getTemplate(_port, callback) { callback(template); };
        global.coinFuncs.hasTemplateBlob = function hasTemplateBlob() { return true; };

        poolModule.templateUpdate2("", MAIN_PORT, true, false, 1, false, {
            height: 450,
            hash: "main-no-expected-reward-header"
        });

        assert.equal(runtime.getState().activeBlockTemplates[""].idHash, "main-no-expected-reward");
    } finally {
        global.coinFuncs.getPortBlockTemplate = originalTemplateRpc;
        global.coinFuncs.hasTemplateBlob = originalHasTemplateBlob;
        await runtime.stop();
    }
});
});
