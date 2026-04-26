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

test.describe("pool runtime: sockets", { concurrency: false }, () => {
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

test("unauthenticated sockets are closed after socketAuthTimeout", async () => {
    const { runtime } = await startHarness();
    const originalSocketAuthTimeout = global.config.pool.socketAuthTimeout;
    let socket;

    try {
        global.config.pool.socketAuthTimeout = 1;
        socket = await openRawSocket(MAIN_PORT);
        await waitForSocketClose(socket, 2000);
    } finally {
        global.config.pool.socketAuthTimeout = originalSocketAuthTimeout;
        if (socket) socket.destroy();
        await runtime.stop();
    }
});

test("fatal protocol replies close the socket immediately", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        const reply = await requestRawJson(socket, {
            id: 1811,
            method: "keepalive",
            params: { id: "missing-miner" }
        });

        assert.equal(reply.error.message, "Unauthenticated");
        await waitForSocketClose(socket, 500);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("repeated protocol-shape errors close the socket after the configured threshold", async () => {
    const { runtime } = await startHarness();
    const originalProtocolErrorLimit = global.config.pool.protocolErrorLimit;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.protocolErrorLimit = 3;

        socket.write(`${JSON.stringify({ method: "login", params: { login: MAIN_WALLET } })}\n`);
        await assertNoSocketData(socket);

        socket.write(`${JSON.stringify({ id: 1812, params: { login: MAIN_WALLET } })}\n`);
        await assertNoSocketData(socket);

        socket.write(`${JSON.stringify({ params: { login: MAIN_WALLET } })}\n`);
        await waitForSocketClose(socket, 1000);
    } finally {
        global.config.pool.protocolErrorLimit = originalProtocolErrorLimit;
        socket.destroy();
        await runtime.stop();
    }
});

test("unknown RPC methods close pre-share sockets immediately", async () => {
    const { runtime } = await startHarness();
    const socket = await openRawSocket(MAIN_PORT);

    try {
        const loginReply = await requestRawJson(socket, {
            id: 1813,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "unknown-method-pre-share"
            }
        });
        assert.equal(loginReply.error, null);

        const reply = await requestRawJson(socket, {
            id: 1814,
            method: "mining.mystery",
            params: { id: loginReply.result.id }
        });

        assert.equal(reply.error.message, "Unknown RPC method");
        await waitForSocketClose(socket, 1000);
    } finally {
        socket.destroy();
        await runtime.stop();
    }
});

test("unknown RPC methods count toward the protocol error limit after a valid share", async () => {
    const { runtime } = await startHarness();
    const originalProtocolErrorLimit = global.config.pool.protocolErrorLimit;
    const socket = await openRawSocket(MAIN_PORT);

    try {
        global.config.pool.protocolErrorLimit = 2;

        const loginReply = await requestRawJson(socket, {
            id: 1815,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "unknown-method-post-share"
            }
        });
        const shareReply = await requestRawJson(socket, {
            id: 1816,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000014",
                result: VALID_RESULT
            }
        });
        assert.equal(shareReply.error, null);

        const firstUnknownReply = await requestRawJson(socket, {
            id: 1817,
            method: "mining.mystery",
            params: { id: loginReply.result.id }
        });
        assert.equal(firstUnknownReply.error.message, "Unknown RPC method");
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(socket.destroyed, false);

        const secondUnknownReply = await requestRawJson(socket, {
            id: 1818,
            method: "mining.mystery",
            params: { id: loginReply.result.id }
        });
        assert.equal(secondUnknownReply.error.message, "Unknown RPC method");
        await waitForSocketClose(socket, 1000);
    } finally {
        global.config.pool.protocolErrorLimit = originalProtocolErrorLimit;
        socket.destroy();
        await runtime.stop();
    }
});

test("per-IP connection limits close excess sockets without touching the existing connection", async () => {
    const { runtime } = await startHarness();
    const originalMaxConnectionsPerIP = global.config.pool.maxConnectionsPerIP;
    const first = await openRawSocket(MAIN_PORT);
    let second;

    try {
        global.config.pool.maxConnectionsPerIP = 1;
        second = await openRawSocket(MAIN_PORT);
        await waitForSocketClose(second, 1000);
        await assertNoSocketData(first);
    } finally {
        global.config.pool.maxConnectionsPerIP = originalMaxConnectionsPerIP;
        first.destroy();
        if (second) second.destroy();
        await runtime.stop();
    }
});

test("per-subnet connection limits close excess sockets independently from the per-IP limit", async () => {
    const { runtime } = await startHarness();
    const originalMaxConnectionsPerIP = global.config.pool.maxConnectionsPerIP;
    const originalMaxConnectionsPerSubnet = global.config.pool.maxConnectionsPerSubnet;
    const first = await openRawSocket(MAIN_PORT);
    let second;

    try {
        global.config.pool.maxConnectionsPerIP = 10;
        global.config.pool.maxConnectionsPerSubnet = 1;
        second = await openRawSocket(MAIN_PORT);
        await waitForSocketClose(second, 1000);
        await assertNoSocketData(first);
    } finally {
        global.config.pool.maxConnectionsPerIP = originalMaxConnectionsPerIP;
        global.config.pool.maxConnectionsPerSubnet = originalMaxConnectionsPerSubnet;
        first.destroy();
        if (second) second.destroy();
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
});
