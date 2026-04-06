"use strict";

// This harness intentionally uses only built-in Node facilities for the test
// flow itself: `node:test`, `assert`, and raw TCP sockets.  The pool module
// still loads its normal dependencies, but all external services are replaced
// here with in-memory fakes so the suite can run fully offline.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const Module = require("node:module");
const test = require("node:test");

const MAIN_PORT = 39001;
const ETH_PORT = 39002;
const MAIN_WALLET = "4".repeat(95);
const ETH_WALLET = "5".repeat(95);
const VALID_RESULT = "f".repeat(64);
const VALID_RESULT_BUFFER = Buffer.from(VALID_RESULT, "hex");
const RAVEN_RESULT_BUFFER = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([10])]);

function createBignumShim() {
    // The real project depends on the native `bignum` package.  The harness
    // only needs a very small subset of its API, so this BigInt-backed shim is
    // enough to let `lib/pool.js` execute in environments without native addons.
    class BigNumShim {
        constructor(value, base = 10) {
            if (value instanceof BigNumShim) {
                this.value = value.value;
            } else if (typeof value === "bigint") {
                this.value = value;
            } else if (Buffer.isBuffer(value)) {
                this.value = BigNumShim.fromBuffer(value).value;
            } else if (typeof value === "number") {
                this.value = BigInt(Math.trunc(value));
            } else if (typeof value === "string") {
                this.value = base === 16 ? BigInt(`0x${value}`) : BigInt(value);
            } else {
                this.value = BigInt(value || 0);
            }
        }

        div(other) {
            return new BigNumShim(this.value / toBigInt(other));
        }

        ge(other) {
            return this.value >= toBigInt(other);
        }

        lt(other) {
            return this.value < toBigInt(other);
        }

        toNumber() {
            return Number(this.value);
        }

        toString(base = 10) {
            return this.value.toString(base);
        }

        toBuffer(options = {}) {
            const endian = options.endian || "big";
            const size = options.size || Math.max(1, Math.ceil(this.value.toString(16).length / 2));
            let hex = this.value.toString(16);
            if (hex.length % 2) hex = `0${hex}`;
            let buffer = Buffer.from(hex, "hex");
            if (buffer.length < size) {
                buffer = Buffer.concat([Buffer.alloc(size - buffer.length), buffer]);
            } else if (buffer.length > size) {
                buffer = buffer.slice(buffer.length - size);
            }
            if (endian === "little") buffer = Buffer.from(buffer).reverse();
            return buffer;
        }

        static fromBuffer(buffer, options = {}) {
            const endian = options.endian || "big";
            const normalized = endian === "little" ? Buffer.from(buffer).reverse() : Buffer.from(buffer);
            const hex = normalized.toString("hex") || "00";
            return new BigNumShim(BigInt(`0x${hex}`));
        }
    }

    function toBigInt(value) {
        return value instanceof BigNumShim ? value.value : BigInt(value);
    }

    function bignum(value, base) {
        return new BigNumShim(value, base);
    }

    bignum.fromBuffer = BigNumShim.fromBuffer;
    return bignum;
}

const bignum = createBignumShim();

function installRequireStubs() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === "bignum") return bignum;
        if (request === "debug") return () => () => {};
        if (request === "wallet-address-validator") return { validate: () => true };
        if (request === "async") {
            return {
                each(list, iteratee, done) {
                    Promise.all((list || []).map((item) => Promise.resolve(iteratee(item)))).then(() => done && done());
                },
                eachSeries(list, iteratee, done) {
                    (async () => {
                        for (const item of list || []) {
                            const result = await new Promise((resolve) => iteratee(item, resolve));
                            if (result) return done && done(result);
                        }
                        return done && done();
                    })();
                }
            };
        }
        return originalLoad(request, parent, isMain);
    };
}

function createCircularBuffer() {
    // The production pool relies on a small circular buffer helper.  The tests
    // only need the tiny subset used by `lib/pool.js`, so this simplified
    // version keeps the harness readable.
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
        circularBuffer: createCircularBuffer,
        sendEmail() {},
        formatDate() {
            return "2026-04-06 00:00:00";
        },
        getCoinHashFactor(_coin, callback) {
            callback(1);
        },
        rpcPortDaemon(_port, _method, _params, callback) {
            callback({ result: { status: "OK", block_hash: "11".repeat(32) } }, 200);
        },
        rpcPortDaemon2(_port, _method, _params, callback) {
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
    // Encoding is irrelevant to the harness assertions.  Returning the input
    // object directly keeps the stored records easy to inspect in failures.
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
            return bignum("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 16);
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
        slowHashBuff(buffer, blockTemplate, nonce) {
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
    // The pool speaks JSON-RPC over a plain newline-delimited TCP stream.
    // Exercising the real wire protocol catches more regressions than calling
    // internal handlers directly.
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
        await new Promise((resolve) => {
            this.socket.end(resolve);
        });
    }
}

async function startHarness(extra = {}) {
    // Each test gets fresh in-memory service state.  The pool module itself is
    // reused, but its internal runtime state is reset by `startTestRuntime`.
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

test("default stratum miner can login, keepalive, and submit a valid share", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 1,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-a"
            }
        });

        assert.equal(loginReply.error, null);
        assert.equal(loginReply.result.status, "OK");

        const keepaliveReply = await client.request({
            id: 2,
            method: "keepalive",
            params: {
                id: loginReply.result.id
            }
        });

        assert.equal(keepaliveReply.result.status, "KEEPALIVED");

        const shareReply = await client.request({
            id: 3,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000001",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.equal(shareReply.error, null);
        assert.deepEqual(shareReply.result, { status: "OK" });
        assert.equal(runtime.getState().shareStats.normalShares, 1);
        assert.equal(database.invalidShares.length, 0);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("stale shares from the immediately previous template are still accepted and counted as outdated", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 10,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-b"
            }
        });

        runtime.setTemplate(createBaseTemplate({
            coin: "",
            port: MAIN_PORT,
            idHash: "main-template-2",
            height: 102
        }));

        const shareReply = await client.request({
            id: 11,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000002",
                result: VALID_RESULT
            }
        });

        await flushTimers();
        assert.equal(shareReply.error, null);
        assert.deepEqual(shareReply.result, { status: "OK" });
        assert.equal(runtime.getState().shareStats.outdatedShares, 1);
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("duplicate default shares are rejected and recorded as invalid submissions", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 20,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-c"
            }
        });

        const submitParams = {
            id: loginReply.result.id,
            job_id: loginReply.result.job.job_id,
            nonce: "00000003",
            result: VALID_RESULT
        };

        const firstReply = await client.request({ id: 21, method: "submit", params: submitParams });
        const duplicateReply = await client.request({ id: 22, method: "submit", params: submitParams });

        assert.equal(firstReply.error, null);
        assert.equal(duplicateReply.error.message, "Duplicate share");
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("proxy miner path accepts worker and pool nonces", async () => {
    const { runtime, database } = await startHarness();
    const client = new JsonLineClient(MAIN_PORT);

    try {
        await client.connect();

        const loginReply = await client.request({
            id: 30,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "proxy-worker",
                agent: "xmr-node-proxy/0.0.1"
            }
        });

        assert.equal(loginReply.error, null);
        assert.ok(loginReply.result.job.blocktemplate_blob);

        const shareReply = await client.request({
            id: 31,
            method: "submit",
            params: {
                id: loginReply.result.id,
                job_id: loginReply.result.job.job_id,
                nonce: "00000004",
                result: VALID_RESULT,
                poolNonce: 7,
                workerNonce: 9
            }
        });

        await flushTimers();
        assert.equal(shareReply.error, null);
        assert.deepEqual(shareReply.result, { status: "OK" });
        assert.equal(runtime.getState().shareStats.normalShares, 1);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("kawpow-style subscribe/authorize/submit flow works over the stratum wire format", async () => {
    const { runtime } = await startHarness();
    const client = new JsonLineClient(ETH_PORT);

    try {
        await client.connect();

        const subscribeReply = await client.request({
            id: 40,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });

        assert.equal(subscribeReply.error, null);
        assert.equal(subscribeReply.result.length, 3);

        const authorizeReply = await client.request({
            id: 41,
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker"]
        });

        assert.equal(authorizeReply.error, null);
        assert.equal(authorizeReply.result, true);

        const targetPush = await client.waitFor((message) => message.method === "mining.set_target");
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify");

        assert.equal(typeof targetPush.params[0], "string");
        assert.ok(targetPush.params[0].length > 0);
        assert.equal(typeof notifyPush.params[0], "string");

        const submitReply = await client.request({
            id: 42,
            method: "mining.submit",
            params: [
                ETH_WALLET,
                notifyPush.params[0],
                "0x0000000000000001",
                `0x${notifyPush.params[1]}`,
                `0x${"ab".repeat(32)}`
            ]
        });

        assert.equal(submitReply.error, null);
        assert.equal(submitReply.result, true);
    } finally {
        await client.close();
        await runtime.stop();
    }
});

test("malformed login requests without params are rejected", async () => {
    const { runtime } = await startHarness();

    try {
        const first = invokePoolMethod({
            method: "login",
            params: null,
            ip: "10.0.0.55"
        });

        assert.equal(first.replies.length, 0);
        assert.deepEqual(first.finals, [{ error: "No params specified", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("unauthenticated getjob, submit, and keepalive requests are rejected", async () => {
    const { runtime } = await startHarness();

    try {
        for (const method of ["getjob", "submit", "keepalive"]) {
            const params = method === "submit" ? { id: "missing", job_id: "1", nonce: "00000001", result: VALID_RESULT } : { id: "missing" };
            const reply = invokePoolMethod({ method, params });
            assert.equal(reply.replies.length, 0, `${method} should not produce a non-final reply`);
            assert.deepEqual(reply.finals, [{ error: "Unauthenticated", timeout: undefined }]);
        }
    } finally {
        await runtime.stop();
    }
});

test("the same socket cannot login twice", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const first = invokePoolMethod({
            socket,
            id: 1,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-first"
            }
        });

        assert.equal(first.finals.length, 0);
        assert.equal(first.replies.length, 1);
        assert.equal(first.replies[0].error, null);
        assert.equal(first.replies[0].result.status, "OK");
        assert.ok(socket.miner_id);

        const second = invokePoolMethod({
            socket,
            id: 2,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-second"
            }
        });

        assert.equal(second.replies.length, 0);
        assert.deepEqual(second.finals, [{ error: "No double login is allowed", timeout: undefined }]);
    } finally {
        await runtime.stop();
    }
});

test("malformed submit nonces are rejected and recorded as invalid shares", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 10,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-malformed"
            }
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 11,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "not-a-nonce",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(submitReply.finals.length, 0);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("shares for jobs that have fallen out of the template history are rejected as expired", async () => {
    const { runtime, database } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 20,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-expired"
            }
        });
        const originalJobId = loginReply.replies[0].result.job.job_id;
        const miner = runtime.getState().activeMiners.get(socket.miner_id);
        const originalJob = miner.validJobs.toarray().find((job) => job.id === originalJobId);

        for (let height = 102; height <= 113; height += 1) {
            runtime.setTemplate(createBaseTemplate({
                coin: "",
                port: MAIN_PORT,
                idHash: `main-template-${height}`,
                height
            }));
        }

        miner.validJobs.enq(originalJob);

        const submitReply = invokePoolMethod({
            socket,
            id: 21,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: originalJobId,
                nonce: "00000005",
                result: VALID_RESULT
            }
        });

        assert.deepEqual(submitReply.replies, [{ error: "Block expired", result: undefined }]);
        assert.equal(database.invalidShares.length, 1);
    } finally {
        await runtime.stop();
    }
});

test("eth subscribe and authorize fail cleanly when no extranonces are available", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [] });

    try {
        const subscribeReply = invokePoolMethod({
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"],
            portData: global.config.ports[1]
        });
        assert.equal(subscribeReply.replies.length, 0);
        assert.deepEqual(subscribeReply.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);

        const authorizeReply = invokePoolMethod({
            method: "mining.authorize",
            params: [ETH_WALLET, "eth-worker"],
            portData: global.config.ports[1]
        });
        assert.equal(authorizeReply.replies.length, 0);
        assert.deepEqual(authorizeReply.finals, [{
            error: "Not enough extranoces. Switch to other pool node.",
            timeout: undefined
        }]);
    } finally {
        await runtime.stop();
    }
});

test("closing an eth stratum socket releases its extranonce for reuse", async () => {
    const { runtime } = await startHarness({ freeEthExtranonces: [7] });
    const firstClient = new JsonLineClient(ETH_PORT);
    const secondClient = new JsonLineClient(ETH_PORT);

    try {
        await firstClient.connect();
        const firstSubscribe = await firstClient.request({
            id: 50,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(firstSubscribe.error, null);
        const extranonce = firstSubscribe.result[1];

        await firstClient.close();
        await flushTimers();

        await secondClient.connect();
        const secondSubscribe = await secondClient.request({
            id: 51,
            method: "mining.subscribe",
            params: ["HarnessEthMiner/1.0"]
        });
        assert.equal(secondSubscribe.error, null);
        assert.equal(secondSubscribe.result[1], extranonce);
    } finally {
        await firstClient.close();
        await secondClient.close();
        await runtime.stop();
    }
});
