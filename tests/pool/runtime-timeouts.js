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
} = require("./runtime-helpers.js");

test.describe("pool runtime: timeouts", { concurrency: false }, () => {
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
        miner.hasSubmittedValidShare = true;
        miner.lastProtocolActivity = Date.now() - 5000;
        miner.lastValidShareTimeMs = Date.now() - 5000;
        miner.lastContact = Date.now() - 5000;

        poolModule.checkAliveMiners();

        assert.equal(runtime.getState().activeMiners.has(socket.miner_id), false);
    } finally {
        global.config.pool.minerTimeout = originalMinerTimeout;
        await runtime.stop();
    }
});

test("checkAliveMiners closes the underlying socket for timed-out miners", async () => {
    const { runtime } = await startHarness();
    const originalMinerTimeout = global.config.pool.minerTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1941,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "timeout-socket-close"
            }
        });
        const miner = runtime.getState().activeMiners.get(loginReply.result.id);
        miner.hasSubmittedValidShare = true;
        miner.lastProtocolActivity = Date.now() - 5000;
        miner.lastValidShareTimeMs = Date.now() - 5000;
        miner.lastContact = Date.now() - 5000;

        poolModule.checkAliveMiners();

        await waitForSocketClose(socket, 1000);
        assert.equal(runtime.getState().activeMiners.has(loginReply.result.id), false);
    } finally {
        global.config.pool.minerTimeout = originalMinerTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("first-share timeout closes authenticated miners that never submit a valid share", async () => {
    const { runtime } = await startHarness();
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1942,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "no-share-timeout"
            }
        });

        assert.equal(loginReply.error, null);
        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.has(loginReply.result.id), false);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("claimed extranonce sessions use the regular first-share timeout", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7] });
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(ETH_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const authorizeReply = await requestRawJson(socket, {
            id: 19425,
            method: "mining.authorize",
            params: [ETH_WALLET, "claimed-extranonce-timeout"]
        });

        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);
        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.size, 0);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("claimed extranonce sessions keep the regular first-share timeout regardless of algo", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7, 8, 9, 10] });
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const cases = [
        "claimed-extranonce-timeout",
        "claimed-extranonce-timeout~autolykos2",
        "claimed-extranonce-timeout~c29",
        "claimed-extranonce-timeout~etchash"
    ];

    try {
        global.config.pool.minerFirstShareTimeout = 60;

        for (const pass of cases) {
            const socket = await openRawSocket(ETH_PORT);
            try {
                const authorizeReply = await requestRawJson(socket, {
                    id: 19426,
                    method: "mining.authorize",
                    params: [ETH_WALLET, pass]
                });

                assert.equal(authorizeReply.error, null);
                assert.equal(authorizeReply.result, true);
                await assert.rejects(waitForSocketClose(socket, 2000), /Timed out waiting for socket close/);
                assert.equal(runtime.getState().activeMiners.size, 1);
            } finally {
                socket.destroy();
                await waitForSocketClose(socket, 1000).catch(() => {});
            }
        }
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        await runtime.stop();
    }
});

test("keepalive traffic does not bypass the first-share timeout", async () => {
    const { runtime } = await startHarness();
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1943,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "keepalive-only"
            }
        });
        const minerId = loginReply.result.id;

        await new Promise((resolve) => setTimeout(resolve, 250));
        const firstKeepalive = await requestRawJson(socket, {
            id: 1944,
            method: "keepalive",
            params: { id: minerId }
        });
        assert.equal(firstKeepalive.result.status, "KEEPALIVED");

        await new Promise((resolve) => setTimeout(resolve, 250));
        const secondKeepalive = await requestRawJson(socket, {
            id: 1945,
            method: "keepalive",
            params: { id: minerId }
        });
        assert.equal(secondKeepalive.result.status, "KEEPALIVED");

        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("invalid job id spam does not keep an authenticated miner alive", async () => {
    const { runtime } = await startHarness();
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.minerFirstShareTimeout = 1;
        const loginReply = await requestRawJson(socket, {
            id: 1946,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "bad-job-id-spam"
            }
        });
        const minerId = loginReply.result.id;

        await new Promise((resolve) => setTimeout(resolve, 250));
        const firstSubmit = await requestRawJson(socket, {
            id: 1947,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-1",
                nonce: "00000001",
                result: VALID_RESULT
            }
        });
        assert.equal(firstSubmit.error.message, "Invalid job id");

        await new Promise((resolve) => setTimeout(resolve, 250));
        const secondSubmit = await requestRawJson(socket, {
            id: 1948,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-2",
                nonce: "00000002",
                result: VALID_RESULT
            }
        });
        assert.equal(secondSubmit.error.message, "Invalid job id");

        await waitForSocketClose(socket, 2000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});

test("repeated invalid job ids close the socket before the first valid share", async () => {
    const { runtime } = await startHarness();
    const originalInvalidJobIdLimitBeforeShare = global.config.pool.invalidJobIdLimitBeforeShare;
    const originalFirstShareTimeout = global.config.pool.minerFirstShareTimeout;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.invalidJobIdLimitBeforeShare = 2;
        global.config.pool.minerFirstShareTimeout = 60;

        const loginReply = await requestRawJson(socket, {
            id: 1949,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "bad-job-id-limit"
            }
        });
        const minerId = loginReply.result.id;

        const firstSubmit = await requestRawJson(socket, {
            id: 1950,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-1",
                nonce: "00000001",
                result: VALID_RESULT
            }
        });
        assert.equal(firstSubmit.error.message, "Invalid job id");

        const secondSubmit = await requestRawJson(socket, {
            id: 1951,
            method: "submit",
            params: {
                id: minerId,
                job_id: "missing-job-2",
                nonce: "00000002",
                result: VALID_RESULT
            }
        });
        assert.equal(secondSubmit.error.message, "Invalid job id");

        await waitForSocketClose(socket, 1000);
        assert.equal(runtime.getState().activeMiners.has(minerId), false);
    } finally {
        global.config.pool.invalidJobIdLimitBeforeShare = originalInvalidJobIdLimitBeforeShare;
        global.config.pool.minerFirstShareTimeout = originalFirstShareTimeout;
        socket.destroy();
        await runtime.stop();
    }
});
});
