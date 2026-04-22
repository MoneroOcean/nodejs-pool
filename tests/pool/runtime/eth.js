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

test.describe("pool runtime: eth submits", { concurrency: false }, () => {
test("accepted block submits with unresolved zero hashes are dropped before storage and alert admin", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-zero-hash-drop", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const client = new JsonLineClient(ETH_PORT);
    const ethPool = global.coinFuncs.getPoolSettings(ETH_PORT);
    const originalResolveSubmittedBlockHash = ethPool.resolveSubmittedBlockHash;

    try {
        await withCapturedConsoleError(async (errorLogs) => {
            ethPool.resolveSubmittedBlockHash = function resolveSubmittedBlockHash(_ctx, callback) {
                callback(ZERO_RESULT);
            };
            await client.connect();
            const { submitReply } = await submitEthBlockCandidateWithClient(client, "worker-block-zero-hash", {
                subscribeId: 204,
                authorizeId: 205,
                submitId: 206
            });

            await flushTimers();
            assert.equal(submitReply.error, null);
            assert.equal(submitReply.result, true);
            assert.equal(database.blocks.length, 0);
            assert.equal(database.altBlocks.length, 0);
            assert.equal(global.support.emails.length, 1);
            assert.match(global.support.emails[0].subject, /Dropped unresolved zero-hash block/);
            assert.match(global.support.emails[0].body, /Block hash unresolved/);
            assert.equal(errorLogs.some((line) => line.includes("Block hash unresolved")), true);
        });
    } finally {
        ethPool.resolveSubmittedBlockHash = originalResolveSubmittedBlockHash;
        await client.close();
        await runtime.stop();
    }
});

test("block-submit test mode still emails admin for unresolved zero hashes", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-zero-hash-test-mode", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const client = new JsonLineClient(ETH_PORT);
    const ethPool = global.coinFuncs.getPoolSettings(ETH_PORT);
    const originalResolveSubmittedBlockHash = ethPool.resolveSubmittedBlockHash;

    try {
        await withCapturedConsoleError(async (errorLogs) => {
            ethPool.resolveSubmittedBlockHash = function resolveSubmittedBlockHash(_ctx, callback) {
                callback(ZERO_RESULT);
            };

            await withBlockSubmitTestMode(async () => {
                await client.connect();
                const { submitReply } = await submitEthBlockCandidateWithClient(client, "worker-block-zero-hash-test-mode", {
                    subscribeId: 214,
                    authorizeId: 215,
                    submitId: 216
                });

                await flushTimers();
                assert.equal(submitReply.error, null);
                assert.equal(submitReply.result, true);
                assert.equal(database.blocks.length, 0);
                assert.equal(database.altBlocks.length, 0);
                assert.equal(global.support.emails.length, 1);
                assert.match(global.support.emails[0].subject, /Dropped unresolved zero-hash block/);
                assert.match(global.support.emails[0].body, /Block hash unresolved/);
                assert.equal(errorLogs.some((line) => line.includes("Block hash unresolved")), true);
            });
        });
    } finally {
        ethPool.resolveSubmittedBlockHash = originalResolveSubmittedBlockHash;
        await client.close();
        await runtime.stop();
    }
});

test("block submission failures reset wallet trust even when the share stays accepted", async () => {
    const { runtime } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-trust-reset", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const originalRpcPortDaemon2 = global.support.rpcPortDaemon2;
    const socketA = {};
    const socketB = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);
        global.support.rpcPortDaemon2 = function rpcPortDaemon2Failure(port, method, params, callback) {
            this.rpcPortDaemon2Calls.push({ port, method, params });
            callback({ result: "high-hash" }, 200);
        };

        invokePoolMethod({
            socket: socketA,
            id: 204,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        invokePoolMethod({
            socket: socketB,
            id: 2041,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReplyA = invokePoolMethod({
            socket: socketA,
            id: 205,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-trust-reset"],
            portData: global.config.ports[1]
        });
        invokePoolMethod({
            socket: socketB,
            id: 2051,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-trust-reset-peer"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const minerA = state.activeMiners.get(socketA.miner_id);
        const minerB = state.activeMiners.get(socketB.miner_id);
        const notifyPush = authorizeReplyA.pushes.find((entry) => entry.method === "mining.notify");
        state.walletTrust[ETH_WALLET] = 1000;
        minerA.trust.trust = 1000;
        minerA.trust.check_height = 0;
        minerB.trust.trust = 1000;
        minerB.trust.check_height = 0;

        const submitReply = invokePoolMethod({
            socket: socketA,
            id: 206,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000003",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ],
            portData: global.config.ports[1]
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(minerA.trust.trust, 1);
        assert.equal(minerB.trust.trust, 0);
        assert.equal(state.walletTrust[ETH_WALLET], 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        await runtime.stop();
    }
});

test("eth-style false submit results are treated as direct failures without retrying", async () => {
    const { runtime } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-false-submit-result", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const socket = {};
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalRpcPortDaemon2 = global.support.rpcPortDaemon2;

    try {
        await withCapturedConsoleError(async (errorLogs) => {
            global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
                if (port === ETH_PORT) return 102;
                return originalPortBlobType.call(this, port);
            };
            global.support.rpcPortDaemon2 = function rpcPortDaemonFalseResult(port, method, params, callback) {
                this.rpcPortDaemon2Calls.push({ port, method, params });
                callback({ jsonrpc: "2.0", id: 0, result: false }, 200);
            };

            await withBlockSubmitTestMode(async () => {
                runtime.getState().activeBlockTemplates.ETH.hash = "34".repeat(32);
                const notifyPush = authorizeEthMiner(socket, 225, "worker-block-false-result");
                const submitReply = submitEthBlockCandidate(socket, 226, notifyPush);

                await flushTimers();
                assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
                assert.equal(global.support.rpcPortDaemon2Calls.length, 1);
                assert.equal(errorLogs.some((line) => line.includes("Block submit failed")), true);
                assert.equal(errorLogs.some((line) => line.includes("Block submit unknown")), false);
                assert.equal(errorLogs.some((line) => line.includes("Block submit rpc-error")), false);
            });
        });
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        await runtime.stop();
    }
});

test("eth-style shares are accepted through the eth hash path and persisted", async () => {
    const { runtime, database } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT) {
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("cd".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        invokePoolMethod({
            socket,
            id: 2061,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 2062,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-eth-hash-valid"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 1;
        job.rewarded_difficulty = 1;
        job.rewarded_difficulty2 = 1;
        job.norm_diff = 1;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 2063,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "000000000018",
                notifyPush.params[1],
                "00".repeat(32)
            ],
            portData: global.config.ports[1]
        });

        await flushShareAccumulator(() => database.shares.length === 1);
        assert.deepEqual(submitReply.replies, [{ error: null, result: true }]);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(database.shares.length, 1);
        assert.equal(database.shares[0].payload.paymentAddress, ETH_WALLET);
        assert.equal(database.shares[0].payload.port, ETH_PORT);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});

test("eth-style shares reject low difficulty hashes from the eth verify path", async () => {
    const { runtime, database } = await startHarness();
    const originalPortBlobType = global.coinFuncs.portBlobType;
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const socket = {};

    try {
        global.coinFuncs.portBlobType = function patchedPortBlobType(port) {
            if (port === ETH_PORT) return 102;
            return originalPortBlobType.call(this, port);
        };
        global.coinFuncs.slowHashBuff = function patchedSlowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (blockTemplate.port === ETH_PORT && this.portBlobType(blockTemplate.port, blockTemplate.block_version) === 102) {
                return [Buffer.from("ff".repeat(32), "hex"), Buffer.from("ee".repeat(32), "hex")];
            }
            return originalSlowHashBuff.call(this, buffer, blockTemplate, nonce, mixhash);
        };

        invokePoolMethod({
            socket,
            id: 2064,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 2065,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-eth-hash-low-diff"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");
        const job = miner.validJobs.toarray().find((entry) => entry.id === notifyPush.params[0]);
        job.difficulty = 2;
        job.rewarded_difficulty = 2;
        job.rewarded_difficulty2 = 2;
        job.norm_diff = 2;
        state.activeBlockTemplates.ETH.hash = "34".repeat(32);
        state.activeBlockTemplates.ETH.difficulty = 1000;

        const submitReply = invokePoolMethod({
            socket,
            id: 2066,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "000000000019",
                notifyPush.params[1],
                "00".repeat(32)
            ],
            portData: global.config.ports[1]
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: "Low difficulty share", result: undefined }]);
        assert.equal(runtime.getState().shareStats.normalShares, 0);
        assert.equal(runtime.getState().shareStats.invalidShares, 1);
        assert.equal(database.shares.length, 0);
    } finally {
        global.coinFuncs.portBlobType = originalPortBlobType;
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        await runtime.stop();
    }
});
});
