"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MAIN_PORT,
    MAIN_WALLET,
    ALT_WALLET,
    THIRD_WALLET,
    VALID_RESULT,
    startHarness,
    invokePoolMethod,
    createBaseTemplate,
    poolModule
} = require("./pool-harness.js");

test.describe("pool validation", { concurrency: false }, () => {
test("login fails cleanly when there is no active block template", async () => {
    const { runtime } = await startHarness({ templates: [] });

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-no-template"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error: "No active block template", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("getjob returns miner.setAlgos status errors when algo updates are rejected", async () => {
    const { runtime } = await startHarness();
    const originalAlgoCheck = global.coinFuncs.algoCheck;
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 120,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-bad-algo"
            }
        });

        global.coinFuncs.algoCheck = function patchedAlgoCheck(algos) {
            if ("bad/algo" in algos) return "Algo not supported";
            return originalAlgoCheck.call(this, algos);
        };

        const getjobReply = invokePoolMethod({
            socket,
            id: 121,
            method: "getjob",
            params: {
                id: loginReply.replies[0].result.id,
                algo: ["bad/algo"],
                "algo-perf": { "bad/algo": 1 }
            }
        });

        assert.deepEqual(getjobReply.replies, [{ error: "Algo not supported", result: undefined }]);
        assert.equal(getjobReply.finals.length, 0);
    } finally {
        global.coinFuncs.algoCheck = originalAlgoCheck;
        await runtime.stop();
    }
});

test("throttled shares return the explicit increase-difficulty message", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        global.config.pool.minerThrottleSharePerSec = 0;

        const loginReply = invokePoolMethod({
            socket,
            id: 130,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-throttle"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 131,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000008",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{
            error: "Throttled down share submission (please increase difficulty)",
            result: undefined
        }]);
        assert.equal(runtime.getState().shareStats.throttledShares, 1);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        global.config.pool.minerThrottleSharePerSec = 1000;
        await runtime.stop();
    }
});

test("submit accepts shares when the verifier returns the hash in reverse byte order", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};
    const originalSlowHashBuff = global.coinFuncs.slowHashBuff;
    const originalSlowHashAsync = global.coinFuncs.slowHashAsync;

    try {
        const reversedResult = Buffer.from(VALID_RESULT, "hex").reverse();

        global.coinFuncs.slowHashBuff = function reversedSlowHashBuff() {
            return Buffer.from(reversedResult);
        };
        global.coinFuncs.slowHashAsync = function reversedSlowHashAsync(_buffer, _blockTemplate, _wallet, callback) {
            callback(reversedResult.toString("hex"));
        };

        const loginReply = invokePoolMethod({
            socket,
            id: 132,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-reversed-hash"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 133,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000b",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(runtime.getState().shareStats.invalidShares, 0);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        global.coinFuncs.slowHashBuff = originalSlowHashBuff;
        global.coinFuncs.slowHashAsync = originalSlowHashAsync;
        await runtime.stop();
    }
});

test("wallet bans propagated through messageHandler reject later logins", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = false;
        poolModule.messageHandler({
            type: "banIP",
            data: "127.0.0.1",
            wallet: MAIN_WALLET
        });

        const reply = invokePoolMethod({
            socket: {},
            id: 140,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-banned-wallet"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: `Temporary (10 minutes max) banned payment address ${MAIN_WALLET}`,
            timeout: undefined
        }]);
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("submitting on a long-disabled coin returns the daemon-issues final error", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 150,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-disabled-coin"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;
        const state = runtime.getState();
        const activeTemplate = state.activeBlockTemplates[""];

        runtime.setTemplate({
            ...createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: activeTemplate.idHash,
                height: activeTemplate.height
            }),
            idHash: activeTemplate.idHash,
            coinHashFactor: 0
        });
        state.activeBlockTemplates[""].timeCreated = Date.now() - (60 * 60 * 1000 + 1000);

        const submitReply = invokePoolMethod({
            socket,
            id: 151,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000009",
                result: VALID_RESULT
            }
        });

        assert.equal(submitReply.replies.length, 0);
        assert.deepEqual(submitReply.finals, [{
            error: "This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("proxy submits without worker and pool nonces are rejected as invalid shares", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 160,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "proxy-missing-nonces",
                agent: "xmr-node-proxy/0.0.1"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 161,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "0000000a",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("xmrig-proxy connections are not banned by the proxy worker limit path", async () => {
    const { runtime } = await startHarness();

    try {
        global.config.pool.workerMax = 1;

        const first = invokePoolMethod({
            socket: {},
            id: 170,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "xmrig-proxy-one",
                agent: "xmrig-proxy/6.0.0"
            }
        });
        const second = invokePoolMethod({
            socket: {},
            id: 171,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "xmrig-proxy-two",
                agent: "xmrig-proxy/6.0.0"
            }
        });

        assert.equal(first.finals.length, 0);
        assert.equal(second.finals.length, 0);
        assert.equal(first.replies[0].error, null);
        assert.equal(second.replies[0].error, null);
    } finally {
        global.config.pool.workerMax = 20;
        await runtime.stop();
    }
});

test("payment split logins reject percentages below the minimum", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%0.05%${ALT_WALLET}`,
                pass: "worker-split-too-small"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: "Your payment divide split 0.05 is below 0.1% and can't be processed",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("login rejects malformed username formats with too many difficulty separators", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}+100+200`,
                pass: "worker-bad-login-format"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: "Please use monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number] login/user format",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("login rejects malformed username formats with unpaired payment split markers", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%1`,
                pass: "worker-bad-split-format"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: "Please use monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number] login/user format",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("login rejects malformed password formats with too many separators", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker:email@example.com:wallet:extra"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: "Please use worker_name[:email_or_pass[:monero_address]][~algo_name] password format",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("payment split logins reject duplicate split addresses", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%1%${ALT_WALLET}%2%${ALT_WALLET}`,
                pass: "worker-split-duplicate"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: `You can't repeat payment split address ${ALT_WALLET}`,
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("payment split logins reject temporarily banned payout targets", async () => {
    const { runtime } = await startHarness();

    try {
        runtime.getState().bannedTmpWallets[ALT_WALLET] = 1;

        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%1%${ALT_WALLET}`,
                pass: "worker-split-banned"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: `Temporary (10 minutes max) banned payment address ${ALT_WALLET}`,
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("payment split logins reject one-hour banned payout targets", async () => {
    const { runtime } = await startHarness();

    try {
        runtime.getState().bannedBigTmpWallets[ALT_WALLET] = 1;

        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%1%${ALT_WALLET}`,
                pass: "worker-split-long-ban"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: "Temporary (one hour max) ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)",
            timeout: 600
        }]);
    } finally {
        await runtime.stop();
    }
});

test("exchange addresses require a payment id", async () => {
    const { runtime } = await startHarness();
    const originalExchangeAddresses = global.coinFuncs.exchangeAddresses.slice();

    try {
        global.coinFuncs.exchangeAddresses = [MAIN_WALLET];

        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-exchange"
            }
        });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{
            error: "Exchange addresses need 64 hex character long payment IDs. Please specify it after your wallet address as follows after dot: Wallet.PaymentID",
            timeout: undefined
        }]);
    } finally {
        global.coinFuncs.exchangeAddresses = originalExchangeAddresses;
        await runtime.stop();
    }
});

test("perf login suffixes set fixed and dynamic difficulty modes correctly", async () => {
    const { runtime } = await startHarness();

    try {
        const fixedSocket = {};
        invokePoolMethod({
            socket: fixedSocket,
            id: 190,
            method: "login",
            params: {
                login: `${MAIN_WALLET}+perf`,
                pass: "worker-perf-fixed",
                algo: ["rx/0"],
                "algo-perf": { "rx/0": 3 }
            }
        });
        const fixedMiner = runtime.getState().activeMiners.get(fixedSocket.miner_id);
        assert.equal(fixedMiner.fixed_diff, true);
        assert.equal(fixedMiner.difficulty, 90);

        const autoSocket = {};
        invokePoolMethod({
            socket: autoSocket,
            id: 191,
            method: "login",
            params: {
                login: `${MAIN_WALLET}+perfauto`,
                pass: "worker-perf-auto",
                algo: ["rx/0"],
                "algo-perf": { "rx/0": 3 }
            }
        });
        const autoMiner = runtime.getState().activeMiners.get(autoSocket.miner_id);
        assert.equal(autoMiner.fixed_diff, false);
        assert.equal(autoMiner.difficulty, 90);
    } finally {
        await runtime.stop();
    }
});

test("nicehash miners are clamped to the NiceHash minimum difficulty", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        invokePoolMethod({
            socket,
            id: 192,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-nicehash",
                agent: "NiceHash/1.0.0"
            }
        });

        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        assert.equal(miner.fixed_diff, true);
        assert.equal(miner.difficulty, global.coinFuncs.niceHashDiff);
    } finally {
        await runtime.stop();
    }
});

test("a malformed login bans the IP for later connections in worker mode", async () => {
    const { runtime } = await startHarness();
    const cluster = require("cluster");
    const originalIsMaster = cluster.isMaster;

    try {
        cluster.isMaster = false;

        const first = invokePoolMethod({
            method: "login",
            params: null,
            ip: "10.0.0.77"
        });
        assert.deepEqual(first.finals, [{ error: "No params specified", timeout: undefined }]);

        const second = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-after-ban"
            },
            ip: "10.0.0.77"
        });
        assert.deepEqual(second.finals, [{
            error: "New connections from this IP address are temporarily suspended from mining (10 minutes max)",
            timeout: undefined
        }]);
    } finally {
        cluster.isMaster = originalIsMaster;
        await runtime.stop();
    }
});

test("keepalived alias returns the same response as keepalive", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 193,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-keepalived"
            }
        });

        const reply = invokePoolMethod({
            socket,
            id: 194,
            method: "keepalived",
            params: {
                id: loginReply.replies[0].result.id
            }
        });

        assert.deepEqual(reply.replies, [{ error: null, result: { status: "KEEPALIVED" } }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("login requests are rejected when the per-IP login rate limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalLoginRateLimitPerSecond = global.config.pool.loginRateLimitPerSecond;
    const originalLoginRateLimitBurst = global.config.pool.loginRateLimitBurst;
    const ip = "10.0.0.77";

    try {
        global.config.pool.loginRateLimitPerSecond = 1;
        global.config.pool.loginRateLimitBurst = 1;

        const first = invokePoolMethod({
            socket: {},
            id: 1941,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-login-first"
            },
            ip
        });
        const second = invokePoolMethod({
            socket: {},
            id: 1942,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-login-second"
            },
            ip
        });

        assert.equal(first.replies[0].error, null);
        assert.deepEqual(second.finals, [{
            error: "Rate limit exceeded for login requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.loginRateLimitPerSecond = originalLoginRateLimitPerSecond;
        global.config.pool.loginRateLimitBurst = originalLoginRateLimitBurst;
        await runtime.stop();
    }
});

test("submit requests are rejected when the per-IP submit rate limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalSubmitRateLimitPerSecond = global.config.pool.submitRateLimitPerSecond;
    const originalSubmitRateLimitBurst = global.config.pool.submitRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.78";

    try {
        global.config.pool.submitRateLimitPerSecond = 1;
        global.config.pool.submitRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1943,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-submit"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const firstSubmit = invokePoolMethod({
            socket,
            id: 1944,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000011",
                result: VALID_RESULT
            },
            ip
        });
        const secondSubmit = invokePoolMethod({
            socket,
            id: 1945,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000012",
                result: VALID_RESULT
            },
            ip
        });

        assert.deepEqual(firstSubmit.replies, [{ error: null, result: { status: "OK" } }]);
        assert.deepEqual(secondSubmit.finals, [{
            error: "Rate limit exceeded for submit requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.submitRateLimitPerSecond = originalSubmitRateLimitPerSecond;
        global.config.pool.submitRateLimitBurst = originalSubmitRateLimitBurst;
        await runtime.stop();
    }
});

test("keepalive requests are rejected when the per-IP keepalive rate limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalKeepaliveRateLimitPerSecond = global.config.pool.keepaliveRateLimitPerSecond;
    const originalKeepaliveRateLimitBurst = global.config.pool.keepaliveRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.79";

    try {
        global.config.pool.keepaliveRateLimitPerSecond = 1;
        global.config.pool.keepaliveRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1946,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-keepalive"
            },
            ip
        });
        const minerId = loginReply.replies[0].result.id;

        const firstKeepalive = invokePoolMethod({
            socket,
            id: 1947,
            method: "keepalive",
            params: { id: minerId },
            ip
        });
        const secondKeepalive = invokePoolMethod({
            socket,
            id: 1948,
            method: "keepalive",
            params: { id: minerId },
            ip
        });

        assert.deepEqual(firstKeepalive.replies, [{ error: null, result: { status: "KEEPALIVED" } }]);
        assert.deepEqual(secondKeepalive.finals, [{
            error: "Rate limit exceeded for keepalive requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.keepaliveRateLimitPerSecond = originalKeepaliveRateLimitPerSecond;
        global.config.pool.keepaliveRateLimitBurst = originalKeepaliveRateLimitBurst;
        await runtime.stop();
    }
});

test("getjob requests are rejected when the pre-share job request limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalJobRequestRateLimitPerSecond = global.config.pool.jobRequestRateLimitPerSecond;
    const originalJobRequestRateLimitBurst = global.config.pool.jobRequestRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.80";

    try {
        global.config.pool.jobRequestRateLimitPerSecond = 1;
        global.config.pool.jobRequestRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1949,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-getjob"
            },
            ip
        });
        const minerId = loginReply.replies[0].result.id;

        const firstGetJob = invokePoolMethod({
            socket,
            id: 1950,
            method: "getjob",
            params: { id: minerId },
            ip
        });
        const secondGetJob = invokePoolMethod({
            socket,
            id: 1951,
            method: "getjob",
            params: { id: minerId },
            ip
        });

        assert.equal(firstGetJob.replies[0].error, null);
        assert.deepEqual(secondGetJob.finals, [{
            error: "Rate limit exceeded for job requests before first valid share",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.jobRequestRateLimitPerSecond = originalJobRequestRateLimitPerSecond;
        global.config.pool.jobRequestRateLimitBurst = originalJobRequestRateLimitBurst;
        await runtime.stop();
    }
});

test("getjobtemplate and getjob share the same pre-share job request bucket", async () => {
    const { runtime } = await startHarness();
    const originalJobRequestRateLimitPerSecond = global.config.pool.jobRequestRateLimitPerSecond;
    const originalJobRequestRateLimitBurst = global.config.pool.jobRequestRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.81";

    try {
        global.config.pool.jobRequestRateLimitPerSecond = 1;
        global.config.pool.jobRequestRateLimitBurst = 1;

        invokePoolMethod({
            socket,
            id: 1952,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-getjobtemplate"
            },
            ip
        });

        const firstTemplate = invokePoolMethod({
            socket,
            id: 1953,
            method: "getjobtemplate",
            params: {},
            ip
        });
        const secondGetJob = invokePoolMethod({
            socket,
            id: 1954,
            method: "getjob",
            params: { id: socket.miner_id },
            ip
        });

        assert.equal(firstTemplate.replies[0].error, null);
        assert.deepEqual(secondGetJob.finals, [{
            error: "Rate limit exceeded for job requests before first valid share",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.jobRequestRateLimitPerSecond = originalJobRequestRateLimitPerSecond;
        global.config.pool.jobRequestRateLimitBurst = originalJobRequestRateLimitBurst;
        await runtime.stop();
    }
});

test("pre-share job request limits stop applying after the first accepted share", async () => {
    const { runtime } = await startHarness();
    const originalJobRequestRateLimitPerSecond = global.config.pool.jobRequestRateLimitPerSecond;
    const originalJobRequestRateLimitBurst = global.config.pool.jobRequestRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.82";

    try {
        global.config.pool.jobRequestRateLimitPerSecond = 1;
        global.config.pool.jobRequestRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1955,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-getjob-after-share"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 1956,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000013",
                result: VALID_RESULT
            },
            ip
        });
        const getTemplateReply = invokePoolMethod({
            socket,
            id: 1957,
            method: "getjobtemplate",
            params: {},
            ip
        });
        const getJobReply = invokePoolMethod({
            socket,
            id: 1958,
            method: "getjob",
            params: { id: socket.miner_id },
            ip
        });

        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(getTemplateReply.replies[0].error, null);
        assert.equal(getTemplateReply.finals.length, 0);
        assert.equal(getJobReply.replies[0].error, null);
        assert.equal(getJobReply.finals.length, 0);
    } finally {
        global.config.pool.jobRequestRateLimitPerSecond = originalJobRequestRateLimitPerSecond;
        global.config.pool.jobRequestRateLimitBurst = originalJobRequestRateLimitBurst;
        await runtime.stop();
    }
});

test("wallet notifications reject login and are rate limited", async () => {
    const { runtime } = await startHarness();
    const notification = "Upgrade required";

    try {
        runtime.getState().notifyAddresses[MAIN_WALLET] = notification;

        const first = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-notify-first"
            }
        });
        assert.deepEqual(first.finals, [{
            error: `${notification} (miner will connect after several attempts)`,
            timeout: undefined
        }]);

        const second = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-notify-second"
            }
        });
        assert.equal(second.replies[0].error, null);
        assert.equal(second.replies[0].result.status, "OK");
    } finally {
        await runtime.stop();
    }
});

test("payment split logins reject percentages above the maximum", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%99.95%${ALT_WALLET}`,
                pass: "worker-split-too-large"
            }
        });

        assert.deepEqual(reply.finals, [{
            error: "Your payment divide split 99.95 is above 99.9% and can't be processed",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("payment split logins reject total percentages that exceed the maximum", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%60%${ALT_WALLET}%40%${THIRD_WALLET}`,
                pass: "worker-split-over-total"
            }
        });

        assert.deepEqual(reply.finals, [{
            error: "Your summary payment divide split exceeds 99.9% and can't be processed",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("payment split logins reject invalid destination addresses", async () => {
    const { runtime } = await startHarness();

    try {
        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: `${MAIN_WALLET}%1%not-a-wallet`,
                pass: "worker-split-invalid-address"
            }
        });

        assert.deepEqual(reply.finals, [{
            error: "Invalid payment address provided: not-a-wallet. Please use 95_char_long_monero_wallet_address format",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("primary payout logins reject permanently banned addresses", async () => {
    const { runtime } = await startHarness();

    try {
        runtime.getState().bannedAddresses[MAIN_WALLET] = "manual blocklist";

        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-primary-banned"
            }
        });

        assert.deepEqual(reply.finals, [{
            error: `Permanently banned payment address ${MAIN_WALLET} provided: manual blocklist`,
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("primary payout logins reject one-hour worker-limit bans", async () => {
    const { runtime } = await startHarness();

    try {
        runtime.getState().bannedBigTmpWallets[MAIN_WALLET] = 1;

        const reply = invokePoolMethod({
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-primary-long-ban"
            }
        });

        assert.deepEqual(reply.finals, [{
            error: "Temporary (one hour max) ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)",
            timeout: 600
        }]);
    } finally {
        await runtime.stop();
    }
});
});
