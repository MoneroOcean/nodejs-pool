"use strict";
const net = require("node:net");

const {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    REAL_PROTOS,
    createSupportHarness,
    createMysqlStub,
    createDatabaseStub,
    createCoinFuncsStub,
    createBaseTemplate
} = require("./harness-core.js");

function installTestGlobals() {
    global.config = {
        bind_ip: "127.0.0.1",
        hostname: "pool-harness",
        pool_id: 1,
        worker_num: 1,
        eth_pool_support: false,
        payout: {},
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
const poolModule = require("../../../lib/pool.js");

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

function flushTimers() { return new Promise((resolve) => setImmediate(resolve)); }

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
