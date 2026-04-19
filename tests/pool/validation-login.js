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
} = require("./harness.js");

async function expectLoginFinalError(params, error, options = {}) {
    const { prepare, timeout } = options;
    const { runtime } = await startHarness();

    try {
        if (prepare) await prepare(runtime);
        const reply = invokePoolMethod({ method: "login", params });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error, timeout }]);
    } finally {
        await runtime.stop();
    }
}

test.describe("pool validation: login rules", { concurrency: false }, () => {
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
    await expectLoginFinalError({
        login: `${MAIN_WALLET}+100+200`,
        pass: "worker-bad-login-format"
    }, "Please use monero_address[(%N%monero_address_95char)+][+difficulty_number] login/user format");
});

test("login rejects malformed username formats with unpaired payment split markers", async () => {
    await expectLoginFinalError({
        login: `${MAIN_WALLET}%1`,
        pass: "worker-bad-split-format"
    }, "Please use monero_address[(%N%monero_address_95char)+][+difficulty_number] login/user format");
});

test("login rejects malformed username formats with too many payment split segments", async () => {
    await expectLoginFinalError({
        login: `${MAIN_WALLET}%1%${ALT_WALLET}%2%${THIRD_WALLET}%3%${MAIN_WALLET}`,
        pass: "worker-too-many-splits"
    }, "Please use monero_address[(%N%monero_address_95char)+][+difficulty_number] login/user format");
});

test("legacy Wallet.PaymentID logins are rejected", async () => {
    const legacyPaymentId = "a".repeat(64);
    await expectLoginFinalError({
        login: `${MAIN_WALLET}.${legacyPaymentId}`,
        pass: "x"
    }, "Legacy Wallet.PaymentID logins are no longer supported. Please use a wallet address, subaddress, or integrated address directly.");
});

test("login rejects malformed password formats with too many separators", async () => {
    await expectLoginFinalError({
        login: MAIN_WALLET,
        pass: "worker:email@example.com:wallet:extra"
    }, "Please use worker_name[:email_or_pass[:monero_address]][~algo_name] password format");
});

test("payment split logins reject duplicate split addresses", async () => {
    await expectLoginFinalError({
        login: `${MAIN_WALLET}%1%${ALT_WALLET}%2%${ALT_WALLET}`,
        pass: "worker-split-duplicate"
    }, `You can't repeat payment split address ${ALT_WALLET}`);
});

test("payment split logins reject temporarily banned payout targets", async () => {
    await expectLoginFinalError({
        login: `${MAIN_WALLET}%1%${ALT_WALLET}`,
        pass: "worker-split-banned"
    }, `Temporary (10 minutes max) banned payment address ${ALT_WALLET}`, {
        prepare(runtime) {
            runtime.getState().bannedTmpWallets[ALT_WALLET] = 1;
        }
    });
});

test("payment split logins reject one-hour banned payout targets", async () => {
    await expectLoginFinalError({
        login: `${MAIN_WALLET}%1%${ALT_WALLET}`,
        pass: "worker-split-long-ban"
    }, "Temporary (one hour max) ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", {
        prepare(runtime) {
            runtime.getState().bannedBigTmpWallets[ALT_WALLET] = 1;
        },
        timeout: 600
    });
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
