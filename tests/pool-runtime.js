"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
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
    poolModule
} = require("./pool-harness.js");

test.describe("pool runtime", { concurrency: false }, () => {
test("trusted miners can take the trusted-share fast path", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);

        const loginReply = invokePoolMethod({
            socket,
            id: 195,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-trusted"
            }
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        state.walletTrust[MAIN_WALLET] = 1000;
        miner.trust.trust = 1000;
        miner.trust.check_height = 0;

        const submitReply = invokePoolMethod({
            socket,
            id: 196,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000b",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.trustedShares, 1);
        assert.equal(runtime.getState().shareStats.normalShares, 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        await runtime.stop();
    }
});

test("trust check_height forces verification instead of trusting the same-height share", async () => {
    const { runtime } = await startHarness();
    const originalTrustedMiners = global.config.pool.trustedMiners;
    const originalRandomBytes = crypto.randomBytes;
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);

        const loginReply = invokePoolMethod({
            socket,
            id: 197,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-trust-check-height"
            }
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const jobId = loginReply.replies[0].result.job.job_id;
        const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
        state.walletTrust[MAIN_WALLET] = 1000;
        miner.trust.trust = 1000;
        miner.trust.check_height = job.height;

        const submitReply = invokePoolMethod({
            socket,
            id: 198,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000c",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.trustedShares, 0);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        await runtime.stop();
    }
});

test("successful main-chain block candidates are stored as blocks", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            {
                ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-block-store", height: 101 }),
                difficulty: 1,
                xmr_difficulty: 1,
                xtm_difficulty: Number.MAX_SAFE_INTEGER
            },
            createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
        ]
    });
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 199,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-block-main"
            }
        });

        const submitReply = invokePoolMethod({
            socket,
            id: 200,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: loginReply.replies[0].result.job.job_id,
                nonce: "0000000d",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(database.blocks.length, 1);
        assert.equal(database.blocks[0].height, 101);
        assert.equal(global.support.rpcPortDaemonCalls.length >= 1, true);
    } finally {
        await runtime.stop();
    }
});

test("successful alt-chain block candidates are stored as alt blocks", async () => {
    const { runtime, database } = await startHarness({
        templates: [
            createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
            {
                ...createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-alt-block-store", height: 201 }),
                difficulty: 5
            }
        ]
    });
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        await client.request({
            id: 201,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });

        const authorizeReply = await client.request({
            id: 202,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-block-alt"]
        });
        assert.equal(authorizeReply.error, null);

        const targetPush = await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        const submitReply = await client.request({
            id: 203,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000002",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });

        assert.equal(typeof targetPush.params[0], "string");
        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
        assert.equal(database.altBlocks.length, 1);
        assert.equal(database.altBlocks[0].payload.port, ETH_PORT);
        assert.equal(global.support.rpcPortDaemon2Calls.length >= 1, true);
    } finally {
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
    const socket = {};

    try {
        global.config.pool.trustedMiners = true;
        crypto.randomBytes = () => Buffer.from([255]);
        global.support.rpcPortDaemon2 = function rpcPortDaemon2Failure(port, method, params, callback) {
            this.rpcPortDaemon2Calls.push({ port, method, params });
            callback({ result: "high-hash" }, 200);
        };

        invokePoolMethod({
            socket,
            id: 204,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });

        const authorizeReply = invokePoolMethod({
            socket,
            id: 205,
            method: "mining.authorize",
            params: [ETH_WALLET, "worker-trust-reset"],
            portData: global.config.ports[1]
        });

        const state = runtime.getState();
        const miner = state.activeMiners.get(socket.miner_id);
        const notifyPush = authorizeReply.pushes.find((entry) => entry.method === "mining.notify");
        state.walletTrust[ETH_WALLET] = 1000;
        miner.trust.trust = 1000;
        miner.trust.check_height = 0;

        const submitReply = invokePoolMethod({
            socket,
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
        assert.equal(miner.trust.trust, 1);
        assert.equal(state.walletTrust[ETH_WALLET], 0);
    } finally {
        global.config.pool.trustedMiners = originalTrustedMiners;
        crypto.randomBytes = originalRandomBytes;
        global.support.rpcPortDaemon2 = originalRpcPortDaemon2;
        await runtime.stop();
    }
});

test("socket parser closes connections on malformed JSON input", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write('{"id":1,"method":"login","params":{"login":"oops"}\n');
        await waitForSocketClose(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser ignores requests missing an RPC id", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write(`${JSON.stringify({ method: "login", params: { login: MAIN_WALLET, pass: "missing-id" } })}\n`);
        await assertNoSocketData(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser ignores requests missing an RPC method", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write(`${JSON.stringify({ id: 180, params: { login: MAIN_WALLET, pass: "missing-method" } })}\n`);
        await assertNoSocketData(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser destroys connections that exceed the maximum packet size", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        socket.write("a".repeat(102401));
        await waitForSocketClose(socket);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("socket parser handles JSON requests split across multiple TCP chunks", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);
    const request = JSON.stringify({
        id: 181,
        method: "login",
        params: {
            login: MAIN_WALLET,
            pass: "split-packet"
        }
    });

    try {
        socket.write(request.slice(0, 30));
        await assertNoSocketData(socket);

        socket.write(`${request.slice(30)}\n`);
        const reply = await waitForSocketJson(socket);

        assert.equal(reply.id, 181);
        assert.equal(reply.error, null);
        assert.equal(reply.result.status, "OK");
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("closing a miner socket removes it from the active miner map", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 182,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "close-removes-miner"
            }
        });

        assert.equal(loginReply.error, null);
        assert.equal(runtime.getState().activeMiners.size, 1);

        await client.close();
        await flushTimers();

        assert.equal(runtime.getState().activeMiners.size, 0);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

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

test("messageHandler sendRemote queues the payload in master mode", async () => {
    const { runtime, database } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = true;
        poolModule.messageHandler({ type: "sendRemote", body: "abcd" });

        assert.equal(database.sendQueue.length, 1);
        assert.equal(database.sendQueue[0].body.equals(Buffer.from("abcd", "hex")), true);
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

        assert.deepEqual(runtime.getState().minerCount[7], { [MAIN_PORT]: 2, [ETH_PORT]: 1 });
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

test("checkAliveMiners removes miners that exceed the timeout", async () => {
    const { runtime } = await startHarness();
    const originalMinerTimeout = global.config.pool.minerTimeout;
    const socket = {};

    try {
        global.config.pool.minerTimeout = 1;

        invokePoolMethod({
            socket,
            id: 194,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "timeout-removal"
            }
        });
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        miner.lastContact = Date.now() - 5000;

        poolModule.checkAliveMiners();

        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), false);
    } finally {
        global.config.pool.minerTimeout = originalMinerTimeout;
        await runtime.stop();
    }
});
});
