"use strict";

// This harness intentionally uses only built-in Node facilities for the test
// flow itself: `node:test`, `assert`, and raw TCP sockets. The pool module
// still loads its normal dependencies, but all external services are replaced
// here with in-memory fakes so the suite can run fully offline.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const protobuf = require("protocol-buffers");
const cnUtil = require("cryptoforknote-util");
const multiHashing = require("cryptonight-hashing");

const supportFactory = require("../lib/support.js");

const MAIN_PORT = 39001;
const ETH_PORT = 39002;
const MAIN_WALLET = "4".repeat(95);
const ETH_WALLET = "5".repeat(95);
const ALT_WALLET = "6".repeat(95);
const THIRD_WALLET = "7".repeat(95);
const VALID_RESULT = "f".repeat(64);
const VALID_RESULT_BUFFER = Buffer.from(VALID_RESULT, "hex");
const RAVEN_RESULT_BUFFER = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([10])]);
const ETH_RESULT_BUFFER = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([16])]);
const ETH_MIXHASH_BUFFER = Buffer.from("cd".repeat(32), "hex");
const REAL_PROTOS = protobuf(fs.readFileSync(path.join(__dirname, "..", "lib", "data.proto")));
const TEST_RAVEN_ADDRESS = "16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf";

function encodeVarint(value) {
    let current = BigInt(value);
    const bytes = [];
    do {
        let byte = Number(current & 0x7fn);
        current >>= 7n;
        if (current > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (current > 0n);
    return Buffer.from(bytes);
}

function createCryptonoteFixture(height) {
    const extra = Buffer.concat([
        Buffer.from([0x01]),
        Buffer.alloc(32, 0x33),
        Buffer.from([0x02, 17]),
        Buffer.alloc(17, 0)
    ]);

    const blob = Buffer.concat([
        encodeVarint(1),
        encodeVarint(1),
        encodeVarint(0),
        Buffer.alloc(32, 0x11),
        Buffer.alloc(4, 0),
        encodeVarint(1),
        encodeVarint(0),
        encodeVarint(1),
        Buffer.from([0xff]),
        encodeVarint(height),
        encodeVarint(1),
        encodeVarint(0),
        Buffer.from([0x02]),
        Buffer.alloc(32, 0x22),
        encodeVarint(extra.length),
        extra,
        encodeVarint(0)
    ]);

    const reserveTag = Buffer.concat([Buffer.from([0x02, 17]), Buffer.alloc(17, 0)]);
    const reserveTagOffset = blob.indexOf(reserveTag);
    const reservedOffset = reserveTagOffset + 2;

    return {
        blocktemplate_blob: blob.toString("hex"),
        reserved_offset: reservedOffset,
        clientPoolLocation: reservedOffset + 8,
        clientNonceLocation: reservedOffset + 12
    };
}

function createSupportHarness() {
    const support = supportFactory();
    support.emails = [];
    support.rpcPortDaemonCalls = [];
    support.rpcPortDaemon2Calls = [];

    support.sendEmail = function sendEmail(to, subject, body) {
        this.emails.push({ to, subject, body });
    };
    support.rpcPortDaemon = function rpcPortDaemon(port, method, params, callback) {
        this.rpcPortDaemonCalls.push({ port, method, params });
        callback({ result: { status: "OK", block_hash: "11".repeat(32) } }, 200);
    };
    support.rpcPortDaemon2 = function rpcPortDaemon2(port, method, params, callback) {
        this.rpcPortDaemon2Calls.push({ port, method, params });
        callback({ result: true }, 200);
    };

    return support;
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
            if (sql.includes("coinHashFactor")) return Promise.resolve([{ item_value: "1" }]);

            return Promise.resolve([]);
        }
    };
}

function decodePayload(type, payload) {
    if (!Buffer.isBuffer(payload)) return payload;
    try {
        return global.protos[type].decode(payload);
    } catch (_error) {
        return payload;
    }
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
            this.shares.push({ height, payload: decodePayload("Share", payload) });
        },
        storeInvalidShare(payload) {
            this.invalidShares.push(decodePayload("InvalidShare", payload));
        },
        storeBlock(height, payload) {
            this.blocks.push({ height, payload: decodePayload("Block", payload) });
        },
        storeAltBlock(height, payload) {
            this.altBlocks.push({ height, payload: decodePayload("AltBlock", payload) });
        }
    };
}

function createCoinFuncsStub() {
    const Coin = require("../lib/coins/index.js");
    const realCoinFuncs = new Coin({});
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

    return {
        ...realCoinFuncs,
        __realCoinFuncs: realCoinFuncs,
        __testUseRealMainPow: false,
        __testMainPowVectors: null,
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
        BlockTemplate: function TestBlockTemplate(template) {
            const blockTemplate = new realCoinFuncs.BlockTemplate(template);
            if (template.idHash) blockTemplate.idHash = template.idHash;
            if (template.clientPoolLocation !== undefined) blockTemplate.clientPoolLocation = template.clientPoolLocation;
            if (template.clientNonceLocation !== undefined) blockTemplate.clientNonceLocation = template.clientNonceLocation;
            return blockTemplate;
        },
        validatePlainAddress(address) {
            return typeof address === "string" && address.length === 95;
        },
        validateAddress(address) {
            return typeof address === "string" && address.length === 95;
        },
        algoShortTypeStr(port) {
            return portToAlgo[port];
        },
        algoCheck: realCoinFuncs.algoCheck,
        algoMainCheck: realCoinFuncs.algoMainCheck,
        algoPrevMainCheck: realCoinFuncs.algoPrevMainCheck,
        getDefaultAlgos: realCoinFuncs.getDefaultAlgos,
        getDefaultAlgosPerf: realCoinFuncs.getDefaultAlgosPerf,
        getPrevAlgosPerf: realCoinFuncs.getPrevAlgosPerf,
        convertAlgosToCoinPerf(algosPerf) {
            const coinPerf = {};
            if ("rx/0" in algosPerf) coinPerf[""] = algosPerf["rx/0"];
            if ("kawpow" in algosPerf) coinPerf.ETH = algosPerf.kawpow;
            return coinPerf;
        },
        get_miner_agent_not_supported_algo: realCoinFuncs.get_miner_agent_not_supported_algo,
        get_miner_agent_warning_notification: realCoinFuncs.get_miner_agent_warning_notification,
        is_miner_agent_no_haven_support: realCoinFuncs.is_miner_agent_no_haven_support,
        isMinerSupportAlgo: realCoinFuncs.isMinerSupportAlgo,
        portBlobType(port) {
            return portToBlob[port];
        },
        blobTypeGrin: realCoinFuncs.blobTypeGrin,
        blobTypeRvn: realCoinFuncs.blobTypeRvn,
        blobTypeEth: realCoinFuncs.blobTypeEth,
        blobTypeErg: realCoinFuncs.blobTypeErg,
        blobTypeDero: realCoinFuncs.blobTypeDero,
        blobTypeRtm: realCoinFuncs.blobTypeRtm,
        blobTypeKcn: realCoinFuncs.blobTypeKcn,
        blobTypeXTM_T: realCoinFuncs.blobTypeXTM_T,
        blobTypeXTM_C: realCoinFuncs.blobTypeXTM_C,
        nonceSize: realCoinFuncs.nonceSize,
        c29ProofSize: realCoinFuncs.c29ProofSize,
        blobTypeStr(port) {
            return this.portBlobType(port).toString();
        },
        convertBlob(blobBuffer, port) {
            const blobType = this.portBlobType(port, blobBuffer[0]);
            if (!(port === ETH_PORT && blobType === 102)) {
                try {
                    return realCoinFuncs.convertBlob.call(this, blobBuffer, port);
                } catch (_error) {
                }
            }
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
        slowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (this.__testUseRealMainPow && blockTemplate.port === MAIN_PORT) {
                const powVectorMap = this.__testMainPowVectors || {};
                const vectorNonce = Buffer.from(buffer.subarray(4, 8)).toString("hex");
                if (vectorNonce in powVectorMap) {
                    const vector = powVectorMap[vectorNonce];
                    return multiHashing.randomx(
                        Buffer.from(vector.input, vector.inputEncoding || "utf8"),
                        Buffer.from(vector.seed, vector.seedEncoding || "utf8"),
                        0
                    );
                }
                return realCoinFuncs.slowHashBuff.call(this, buffer, { ...blockTemplate, port: 18081 }, nonce, mixhash);
            }
            if (blockTemplate.port === ETH_PORT) {
                if (this.portBlobType(blockTemplate.port, blockTemplate.block_version) === 102) {
                    return [ETH_RESULT_BUFFER, ETH_MIXHASH_BUFFER];
                }
                return RAVEN_RESULT_BUFFER;
            }
            return Buffer.from(VALID_RESULT_BUFFER);
        },
        slowHashAsync(buffer, blockTemplate, _wallet, callback) {
            if (this.__testUseRealMainPow && blockTemplate.port === MAIN_PORT) {
                callback(this.slowHashBuff(buffer, blockTemplate).toString("hex"));
                return;
            }
            callback(VALID_RESULT);
        },
        getBlockID() {
            return Buffer.from("aa".repeat(32), "hex");
        }
    };
}

function createBaseTemplate({ coin, port, idHash, height }) {
    if (port === ETH_PORT) {
        const template = cnUtil.RavenBlockTemplate({
            height,
            bits: "1d00ffff",
            curtime: 1234567890,
            previousblockhash: "11".repeat(32),
            version: 1,
            transactions: [],
            coinbasevalue: 5000000000,
            target: "00000000ff000000000000000000000000000000000000000000000000000000"
        }, TEST_RAVEN_ADDRESS);

        return {
            coin,
            idHash,
            height: template.height,
            difficulty: 100,
            block_version: 1,
            port,
            coinHashFactor: 1,
            isHashFactorChange: false,
            seed_hash: template.seed_hash,
            hash: "34".repeat(32),
            bits: template.bits,
            blocktemplate_blob: template.blocktemplate_blob,
            reserved_offset: template.reserved_offset,
            clientPoolLocation: template.reserved_offset + 8,
            clientNonceLocation: template.reserved_offset + 12
        };
    }

    const fixture = createCryptonoteFixture(height);
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
        blocktemplate_blob: fixture.blocktemplate_blob,
        reserved_offset: fixture.reserved_offset,
        clientPoolLocation: fixture.clientPoolLocation,
        clientNonceLocation: fixture.clientNonceLocation
    };
}

function installTestGlobals() {
    global.config = {
        bind_ip: "127.0.0.1",
        hostname: "pool-harness",
        pool_id: 1,
        worker_num: 1,
        eth_pool_support: false,
        payout: {
            bestExchange: "test"
        },
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
            socketAuthTimeout: 15,
            minerFirstShareTimeout: 180,
            claimedExtranonceFirstShareTimeout: 30,
            ethExtranonceOverflowNotifyCooldown: 600,
            trustThreshold: 1,
            trustMin: 0,
            trustedMiners: false,
            workerMax: 20,
            maxConnectionsPerIP: 256,
            maxConnectionsPerSubnet: 1024,
            loginRateLimitPerSecond: 5,
            loginRateLimitBurst: 100,
            submitRateLimitPerSecond: 250,
            submitRateLimitBurst: 5000,
            keepaliveRateLimitPerSecond: 2,
            keepaliveRateLimitBurst: 20,
            jobRequestRateLimitPerSecond: 5,
            jobRequestRateLimitBurst: 20,
            rpcRateLimitBucketIdle: 600,
            rpcRateLimitBucketMaxEntries: 20000,
            protocolErrorLimit: 4,
            invalidJobIdLimitBeforeShare: 4,
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

    global.support = createSupportHarness();
    global.mysql = createMysqlStub();
    global.database = createDatabaseStub();
    global.protos = REAL_PROTOS;
    global.coinFuncs = createCoinFuncsStub();
    global.argv = {};
    global.__poolTestMode = true;
}

installTestGlobals();
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
        if (socket.destroyed) {
            resolve();
            return;
        }
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
    installTestGlobals();
    global.coinFuncs.__testUseRealMainPow = !!extra.realMainPow;
    global.coinFuncs.__testMainPowVectors = extra.mainPowVectors || null;

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
    installTestGlobals,
    poolModule
};
