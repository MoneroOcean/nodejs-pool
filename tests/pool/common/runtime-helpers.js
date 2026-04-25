"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const test = require("node:test");

const {
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
    poolModule
} = require("./harness.js");

const RX0_MAIN_SHARE_VECTORS = [
    {
        nonce: "00000019",
        expected: "38f638606c730dd6f271d037556b83988c71acc6980e22e25271b22389ecfce6",
        seed: "12345678901234567890123456789012",
        input: "This is a test"
    },
    {
        nonce: "0000001a",
        expected: "86cb0f6306d536f373650bd196a5205a0293fba2ead85003d7aee4006afee147",
        seed: "12345678901234567890123456789012",
        input: "Lorem ipsum dolor sit amet"
    },
    {
        nonce: "0000001c",
        expected: "375aa54e18029b6f04372dd51b7349f130810b1270e67a22f26c15dab6f93a65",
        seed: "12345678901234567890123456789012",
        input: "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua"
    }
];
const ZERO_RESULT = "00".repeat(32);

function buildMainShareResult(runtime, socket, jobId, nonce) {
    const miner = runtime.getState().activeMiners.get(socket.miner_id);
    const job = miner.validJobs.toarray().find((entry) => entry.id === jobId);
    const blockTemplate = runtime.getState().activeBlockTemplates[""];
    const templateBuffer = Buffer.alloc(blockTemplate.buffer.length);

    blockTemplate.buffer.copy(templateBuffer);
    templateBuffer.writeUInt32BE(job.extraNonce, blockTemplate.reserved_offset);

    const blockData = global.coinFuncs.constructNewBlob(
        templateBuffer,
        { nonce, result: VALID_RESULT },
        MAIN_PORT
    );
    const convertedBlob = global.coinFuncs.convertBlob(blockData, MAIN_PORT);

    return global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate).toString("hex");
}

function createMainPowVectorMap(vectors = RX0_MAIN_SHARE_VECTORS) {
    return Object.fromEntries(vectors.map((vector) => [vector.nonce, vector]));
}

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

async function enableBlockSubmitTestMode() {
    const markerPath = poolModule.getBlockSubmitTestModeState().markerPath;
    await fsp.writeFile(markerPath, "test\n");
    poolModule.refreshBlockSubmitTestMode();
    return markerPath;
}

async function disableBlockSubmitTestMode(markerPath) {
    await fsp.rm(markerPath, { force: true });
}

function createBlockSubmitTemplates(idHash) {
    return [
        {
            ...createBaseTemplate({ coin: "", port: MAIN_PORT, idHash, height: 101 }),
            difficulty: 1
        },
        createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
    ];
}

function createFrozenTime(startAt) {
    const originalNow = Date.now;
    let now = startAt;
    Date.now = () => now;
    return {
        advance(ms) {
            now += ms;
        },
        restore() {
            Date.now = originalNow;
        }
    };
}

async function setBlockSubmitTestMarker(markerPath, enabled) {
    if (enabled) {
        await fsp.writeFile(markerPath, "enabled\n");
        return;
    }
    await disableBlockSubmitTestMode(markerPath);
}

async function withBlockSubmitTestMode(fn) {
    const markerPath = await enableBlockSubmitTestMode();
    try {
        return await fn(markerPath);
    } finally {
        await disableBlockSubmitTestMode(markerPath);
        poolModule.refreshBlockSubmitTestMode();
    }
}

function getLoginJobId(loginReply) {
    return loginReply.replies[0].result.job.job_id;
}

function loginMainMiner(socket, id, pass, options) {
    const { ip, login = MAIN_WALLET } = options || {};
    return invokePoolMethod({
        socket,
        id,
        method: "login",
        ip,
        params: { login, pass }
    });
}

function submitMainBlockCandidate(socket, id, jobId, options) {
    const {
        ip,
        nonce = "0000002a",
        result = ZERO_RESULT,
        extraParams = {}
    } = options || {};
    return invokePoolMethod({
        socket,
        id,
        method: "submit",
        ip,
        params: {
            id: socket.miner_id,
            job_id: jobId,
            nonce,
            result,
            ...extraParams
        }
    });
}

function authorizeEthMiner(socket, authorizeId, pass) {
    const subscribeReply = invokePoolMethod({
        socket,
        id: authorizeId - 1,
        method: "mining.subscribe",
        params: ["HarnessEthMiner/1.0"],
        portData: global.config.ports[1]
    });
    assert.equal(subscribeReply.replies[0].error, null);

    const authorizeReply = invokePoolMethod({
        socket,
        id: authorizeId,
        method: "mining.authorize",
        params: [ETH_WALLET, pass],
        portData: global.config.ports[1]
    });
    assert.deepEqual(authorizeReply.replies, [{ error: null, result: true }]);
    const notifyPush = authorizeReply.pushes.find((message) => message.method === "mining.notify");
    assert.ok(notifyPush);
    notifyPush.extraNonce = subscribeReply.replies[0].result[1];
    return notifyPush;
}

function buildEthSubmitNonce(extraNonce, suffix) {
    const isSharedNonceProfile = global.coinFuncs.portBlobType(ETH_PORT) === 102;
    const nonceLength = isSharedNonceProfile ? 16 - extraNonce.length : 16;
    return "0x" + suffix.padStart(nonceLength, "0");
}

function submitEthBlockCandidate(socket, id, notifyPush, result = ZERO_RESULT) {
    return invokePoolMethod({
        socket,
        id,
        method: "mining.submit",
        params: [
            ETH_WALLET,
            notifyPush.params[0],
            buildEthSubmitNonce(notifyPush.extraNonce, "2a"),
            `0x${notifyPush.params[1]}`,
            `0x${"11".repeat(32)}`,
            `0x${result}`
        ],
        portData: global.config.ports[1]
    });
}

async function submitEthBlockCandidateWithClient(client, worker, requestIds) {
    const subscribeId = requestIds && requestIds.subscribeId ? requestIds.subscribeId : 1;
    const authorizeId = requestIds && requestIds.authorizeId ? requestIds.authorizeId : subscribeId + 1;
    const submitId = requestIds && requestIds.submitId ? requestIds.submitId : authorizeId + 1;

    const subscribeReply = await client.request({
        id: subscribeId,
        method: "mining.subscribe",
        params: ["HarnessEthMiner/1.0"]
    });

    const authorizeReply = await client.request({
        id: authorizeId,
        method: "mining.authorize",
        params: [ETH_WALLET, worker]
    });
    assert.equal(authorizeReply.error, null);

    const notifyPush = await client.waitFor((message) => message.method === "mining.notify");
    const submitReply = await client.request({
        id: submitId,
        method: "mining.submit",
        params: [
            ETH_WALLET,
            notifyPush.params[0],
            buildEthSubmitNonce(subscribeReply.result[1], "2"),
            `0x${notifyPush.params[1]}`,
            `0x${"ab".repeat(32)}`
        ]
    });

    return { authorizeReply, notifyPush, submitReply };
}

async function withCapturedConsoleError(callback) {
    const errorLogs = [];
    const originalConsoleError = console.error;

    try {
        console.error = function captureError(message) {
            errorLogs.push(String(message));
        };
        return await callback(errorLogs);
    } finally {
        console.error = originalConsoleError;
    }
}

async function requestRawJson(socket, body) {
    socket.write(`${JSON.stringify(body)}\n`);
    return await waitForSocketJson(socket);
}

module.exports = {
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
};
