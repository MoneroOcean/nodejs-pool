"use strict";

// This harness intentionally uses only built-in Node facilities for the test
// flow itself: `node:test`, `assert`, and raw TCP sockets. The pool module
// still loads its normal dependencies, but all external services are replaced
// here with in-memory fakes so the suite can run fully offline.

const net = require("node:net");
const Module = require("node:module");

const MAIN_PORT = 39001;
const ETH_PORT = 39002;
const MAIN_WALLET = "4".repeat(95);
const ETH_WALLET = "5".repeat(95);
const ALT_WALLET = "6".repeat(95);
const THIRD_WALLET = "7".repeat(95);
const VALID_RESULT = "f".repeat(64);
const VALID_RESULT_BUFFER = Buffer.from(VALID_RESULT, "hex");
const RAVEN_RESULT_BUFFER = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([10])]);

function installRequireStubs() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === "wallet-address-validator") return { validate: () => true };
        return originalLoad(request, parent, isMain);
    };
}

function createCircularBuffer() {
    const values = [];
    return {
        enq(value) {
            values.push(value);
            if (values.length > 10) values.shift();
        },
        deq() {
            return values.shift();
        },
        get(index) {
            return values[index];
        },
        size() {
            return values.length;
        },
        toarray() {
            return values.slice();
        }
    };
}

function createSupportStub() {
    return {
        emails: [],
        rpcPortDaemonCalls: [],
        rpcPortDaemon2Calls: [],
        circularBuffer: createCircularBuffer,
        sendEmail(to, subject, body) {
            this.emails.push({ to, subject, body });
        },
        formatDate() {
            return "2026-04-06 00:00:00";
        },
        getCoinHashFactor(_coin, callback) {
            callback(1);
        },
        rpcPortDaemon(_port, _method, _params, callback) {
            this.rpcPortDaemonCalls.push({ port: _port, method: _method, params: _params });
            callback({ result: { status: "OK", block_hash: "11".repeat(32) } }, 200);
        },
        rpcPortDaemon2(_port, _method, _params, callback) {
            this.rpcPortDaemon2Calls.push({ port: _port, method: _method, params: _params });
            callback({ result: true }, 200);
        }
    };
}

function createMysqlStub() {
    return {
        queries: [],
        query(sql, params) {
            this.queries.push({ sql, params });

            if (sql.includes("FROM bans")) return Promise.resolve([]);
            if (sql.includes("FROM notifications")) return Promise.resolve([]);
            if (sql.includes("FROM users")) return Promise.resolve([]);
            if (sql.includes("FROM pool_workers")) return Promise.resolve([{ id: 1 }]);
            if (sql.includes("MAX(id) as maxId")) return Promise.resolve([{ maxId: 1 }]);

            return Promise.resolve([]);
        }
    };
}

function createDatabaseStub() {
    return {
        thread_id: "",
        shares: [],
        invalidShares: [],
        blocks: [],
        altBlocks: [],
        sendQueue: [],
        initEnv() {},
        storeShare(height, payload) {
            this.shares.push({ height, payload });
        },
        storeInvalidShare(payload) {
            this.invalidShares.push(payload);
        },
        storeBlock(height, payload) {
            this.blocks.push({ height, payload });
        },
        storeAltBlock(height, payload) {
            this.altBlocks.push({ height, payload });
        }
    };
}

function createProtoStub() {
    const passthrough = { encode(value) { return value; } };
    return {
        POOLTYPE: { PPLNS: 0, PPS: 1, SOLO: 2, PROP: 3 },
        InvalidShare: passthrough,
        Share: passthrough,
        Block: passthrough,
        AltBlock: passthrough
    };
}

function createCoinFuncsStub() {
    const portToCoin = {
        [MAIN_PORT]: "",
        [ETH_PORT]: "ETH"
    };
    const coinToPort = {
        "": MAIN_PORT,
        ETH: ETH_PORT
    };
    const portToAlgo = {
        [MAIN_PORT]: "rx/0",
        [ETH_PORT]: "kawpow"
    };
    const portToBlob = {
        [MAIN_PORT]: 0,
        [ETH_PORT]: 101
    };

    class MockBlockTemplate {
        constructor(template) {
            Object.assign(this, template);
            this.buffer = Buffer.isBuffer(template.buffer) ? Buffer.from(template.buffer) : Buffer.from(template.buffer, "hex");
            this.extraNonce = template.extraNonce || 0;
            this.reserved_offset = template.reserved_offset ?? 16;
            this.clientPoolLocation = template.clientPoolLocation ?? 24;
            this.clientNonceLocation = template.clientNonceLocation ?? 28;
        }

        nextBlobHex() {
            return Buffer.from(this.buffer).toString("hex");
        }

        nextBlobWithChildNonceHex() {
            return this.nextBlobHex();
        }
    }

    return {
        uniqueWorkerId: 0,
        uniqueWorkerIdBits: 0,
        blockedAddresses: [],
        exchangeAddresses: [],
        niceHashDiff: 1000,
        baseDiff() {
            return BigInt("0x" + "f".repeat(64));
        },
        baseRavenDiff() {
            return 100;
        },
        getCOINS() {
            return ["ETH"];
        },
        getMM_PORTS() {
            return {};
        },
        getMM_CHILD_PORTS() {
            return {};
        },
        COIN2PORT(coin) {
            return coinToPort[coin];
        },
        PORT2COIN(port) {
            return portToCoin[port];
        },
        getAuxChainXTM() {
            return null;
        },
        getPortLastBlockHeader(_port, callback) {
            callback(null, { height: 0 });
        },
        BlockTemplate: MockBlockTemplate,
        validatePlainAddress(address) {
            return typeof address === "string" && address.length === 95;
        },
        validateAddress(address) {
            return typeof address === "string" && address.length === 95;
        },
        algoShortTypeStr(port) {
            return portToAlgo[port];
        },
        algoCheck() {
            return true;
        },
        algoMainCheck(algos) {
            return "rx/0" in algos;
        },
        algoPrevMainCheck() {
            return false;
        },
        getDefaultAlgos() {
            return ["rx/0"];
        },
        getDefaultAlgosPerf() {
            return { "rx/0": 1 };
        },
        getPrevAlgosPerf() {
            return { "rx/0": 1 };
        },
        convertAlgosToCoinPerf(algosPerf) {
            const coinPerf = {};
            if ("rx/0" in algosPerf) coinPerf[""] = algosPerf["rx/0"];
            if ("kawpow" in algosPerf) coinPerf.ETH = algosPerf.kawpow;
            return coinPerf;
        },
        get_miner_agent_not_supported_algo() {
            return false;
        },
        get_miner_agent_warning_notification() {
            return false;
        },
        is_miner_agent_no_haven_support() {
            return false;
        },
        isMinerSupportAlgo(algo, algos) {
            return algo in algos;
        },
        portBlobType(port) {
            return portToBlob[port];
        },
        blobTypeGrin(blobType) {
            return blobType === 8 || blobType === 9 || blobType === 10 || blobType === 12 || blobType === 107;
        },
        blobTypeRvn() {
            return arguments[0] === 101;
        },
        blobTypeEth(blobType) {
            return blobType === 102;
        },
        blobTypeErg() {
            return false;
        },
        blobTypeDero() {
            return false;
        },
        blobTypeRtm() {
            return false;
        },
        blobTypeKcn() {
            return false;
        },
        blobTypeXTM_T() {
            return false;
        },
        blobTypeXTM_C() {
            return false;
        },
        nonceSize(blobType) {
            return blobType === 101 || blobType === 102 ? 8 : 4;
        },
        c29ProofSize() {
            return 32;
        },
        blobTypeStr(port) {
            return this.portBlobType(port).toString();
        },
        convertBlob(blobBuffer) {
            return Buffer.from(blobBuffer);
        },
        constructNewBlob(blockTemplateBuffer, params, port) {
            const next = Buffer.from(blockTemplateBuffer);
            if (port === ETH_PORT) return next;
            if (typeof params.nonce === "string") {
                const nonceBytes = Buffer.from(params.nonce, "hex");
                nonceBytes.copy(next, 4);
            }
            return next;
        },
        slowHashBuff(_buffer, blockTemplate) {
            if (blockTemplate.port === ETH_PORT) {
                return RAVEN_RESULT_BUFFER;
            }
            return Buffer.from(VALID_RESULT_BUFFER);
        },
        slowHashAsync(_buffer, _blockTemplate, _wallet, callback) {
            callback(VALID_RESULT);
        },
        getBlockID() {
            return Buffer.from("aa".repeat(32), "hex");
        }
    };
}

function createBaseTemplate({ coin, port, idHash, height }) {
    const buffer = Buffer.alloc(port === ETH_PORT ? 32 : 48, 0);
    buffer.writeUInt32BE(height, 0);
    return {
        coin,
        idHash,
        height,
        difficulty: 100,
        block_version: 1,
        port,
        coinHashFactor: 1,
        isHashFactorChange: false,
        seed_hash: "12".repeat(32),
        hash: "34".repeat(32),
        bits: "1d00ffff",
        buffer,
        reserved_offset: 16,
        clientPoolLocation: 24,
        clientNonceLocation: 28
    };
}

function installTestGlobals() {
    global.config = {
        bind_ip: "127.0.0.1",
        hostname: "pool-harness",
        pool_id: 1,
        worker_num: 1,
        eth_pool_support: false,
        general: {
            adminEmail: "admin@example.com",
            allowStuckPoolKill: false
        },
        daemon: {
            port: MAIN_PORT,
            enableAlgoSwitching: true,
            pollInterval: 50
        },
        pool: {
            address: MAIN_WALLET,
            minDifficulty: 1,
            maxDifficulty: 1000000,
            targetTime: 30,
            retargetTime: 30,
            shareAccTime: 0,
            minerThrottleShareWindow: 10,
            minerThrottleSharePerSec: 1000,
            minerTimeout: 60,
            trustThreshold: 1,
            trustMin: 0,
            trustedMiners: false,
            workerMax: 20,
            banEnabled: true,
            banThreshold: 5,
            banPercent: 50
        },
        pplns: { enable: true },
        pps: { enable: true },
        solo: { enable: true },
        prop: { enable: true },
        ports: [
            { port: MAIN_PORT, difficulty: 1, portType: "pplns", desc: "main", hidden: false },
            { port: ETH_PORT, difficulty: 1, portType: "pplns", desc: "eth", hidden: false }
        ]
    };

    global.support = createSupportStub();
    global.mysql = createMysqlStub();
    global.database = createDatabaseStub();
    global.protos = createProtoStub();
    global.coinFuncs = createCoinFuncsStub();
    global.argv = {};
    global.__poolTestMode = true;
}

installTestGlobals();
installRequireStubs();
const poolModule = require("../lib/pool.js");

class JsonLineClient {
    constructor(port) {
        this.port = port;
        this.socket = null;
        this.buffer = "";
        this.messages = [];
        this.waiters = [];
    }

    async connect() {
        await new Promise((resolve, reject) => {
            this.socket = net.createConnection({ host: "127.0.0.1", port: this.port }, resolve);
            this.socket.setEncoding("utf8");
            this.socket.on("data", (chunk) => this.#onData(chunk));
            this.socket.on("error", reject);
        });
    }

    #onData(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            this.messages.push(message);
            this.#flushWaiters();
        }
    }

    #flushWaiters() {
        for (let index = 0; index < this.waiters.length; ) {
            const waiter = this.waiters[index];
            const matchIndex = this.messages.findIndex(waiter.predicate);
            if (matchIndex === -1) {
                index += 1;
                continue;
            }
            const [message] = this.messages.splice(matchIndex, 1);
            clearTimeout(waiter.timer);
            this.waiters.splice(index, 1);
            waiter.resolve(message);
        }
    }

    waitFor(predicate, timeout = 2000) {
        const existingIndex = this.messages.findIndex(predicate);
        if (existingIndex !== -1) {
            const [message] = this.messages.splice(existingIndex, 1);
            return Promise.resolve(message);
        }

        return new Promise((resolve, reject) => {
            const waiter = {
                predicate,
                resolve,
                timer: setTimeout(() => {
                    this.waiters = this.waiters.filter((entry) => entry !== waiter);
                    reject(new Error(`Timed out waiting for message on port ${this.port}`));
                }, timeout)
            };
            this.waiters.push(waiter);
        });
    }

    request(body) {
        this.socket.write(`${JSON.stringify(body)}\n`);
        return this.waitFor((message) => message.id === body.id);
    }

    async close() {
        if (!this.socket) return;
        const socket = this.socket;
        this.socket = null;
        if (socket.destroyed) return;
        await new Promise((resolve) => {
            socket.once("close", resolve);
            socket.end();
        });
    }
}

async function openRawSocket(port) {
    return await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
        socket.setEncoding("utf8");
        socket.once("error", reject);
    });
}

function waitForSocketClose(socket, timeout = 1000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for socket close")), timeout);
        socket.once("close", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function assertNoSocketData(socket, timeout = 150) {
    return new Promise((resolve, reject) => {
        const onData = (chunk) => {
            clearTimeout(timer);
            socket.off("data", onData);
            reject(new Error(`Expected no socket data but received: ${chunk}`));
        };
        const timer = setTimeout(() => {
            socket.off("data", onData);
            resolve();
        }, timeout);
        socket.on("data", onData);
    });
}

function waitForSocketJson(socket, timeout = 1000) {
    return new Promise((resolve, reject) => {
        let buffer = "";
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("close", onClose);
        };
        const onData = (chunk) => {
            buffer += chunk;
            if (!buffer.includes("\n")) return;
            cleanup();
            const [line] = buffer.split("\n");
            resolve(JSON.parse(line));
        };
        const onClose = () => {
            cleanup();
            reject(new Error("Socket closed before a JSON line was received"));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for JSON line"));
        }, timeout);
        socket.on("data", onData);
        socket.on("close", onClose);
    });
}

async function startHarness(extra = {}) {
    global.support = createSupportStub();
    global.mysql = createMysqlStub();
    global.database = createDatabaseStub();

    const templates = [
        createBaseTemplate({ coin: "", port: MAIN_PORT, idHash: "main-template-1", height: 101 }),
        createBaseTemplate({ coin: "ETH", port: ETH_PORT, idHash: "eth-template-1", height: 201 })
    ];

    const runtime = await poolModule.startTestRuntime({
        ports: global.config.ports,
        templates,
        coinHashFactors: { ETH: 1 },
        ...extra
    });

    return {
        runtime,
        mysql: global.mysql,
        database: global.database
    };
}

function flushTimers() {
    return new Promise((resolve) => setImmediate(resolve));
}

function invokePoolMethod({
    socket = {},
    id = 1,
    method,
    params,
    ip = "127.0.0.2",
    portData = global.config.ports[0]
}) {
    const replies = [];
    const finals = [];
    const pushes = [];

    poolModule.handleMinerData(
        socket,
        id,
        method,
        params,
        ip,
        portData,
        (error, result) => {
            replies.push({ error, result });
        },
        (error, timeout) => {
            finals.push({ error, timeout });
        },
        (body) => {
            pushes.push(body);
        }
    );

    return { replies, finals, pushes, socket };
}

module.exports = {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ETH_WALLET,
    ALT_WALLET,
    THIRD_WALLET,
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
};
