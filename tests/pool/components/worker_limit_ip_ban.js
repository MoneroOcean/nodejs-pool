"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const createPoolState = require("../../../lib/pool/state.js");
const createProtocolHandler = require("../../../lib/pool/protocol.js");
const createMessageHandler = require("../../../lib/pool/messages.js");

const ADDRESS = "198.51.100.22";

function attemptLogin(mode, whitelisted = false, ip = ADDRESS) {
    const { state, retention, touchTimedEntry } = createPoolState();
    const messages = [];
    const finals = [];
    const limited = ["existing-wallet-limit", "ordinary-cap", "proxy-cap"].includes(mode);
    const miner = {
        id: "miner-1", payout: "example-wallet", valid_miner: ["ordinary-cap", "proxy-cap", "no-template"].includes(mode),
        workerLimitLogin: mode === "existing-wallet-limit", delay_reply: limited || mode === "invalid-wallet" ? 30 : undefined,
        error: limited ? "Worker limit reached" : mode === "invalid-wallet" ? "Invalid payment address provided" : "Please use the supported username format",
        invalidLogKey: "test", algos: {}, connectTime: Date.now(),
        selectBestCoin() { return false; }, sendBestCoinJob() {}
    };
    if (mode === "ordinary-cap") state.minerWallets[miner.payout] = { count: 20 };
    if (mode === "proxy-cap") state.proxyMiners[miner.payout] = { count: 20 };
    if (whitelisted) state.ipWhitelist[ip] = 1;
    const handler = createProtocolHandler({
        debug() {}, state, retention, touchTimedEntry,
        utils: { getNewId() { return miner.id; } }, createMiner() { return miner; },
        addActiveMiner(value) { state.activeMiners.set(value.id, value); },
        addProxyMiner() { return mode !== "proxy-cap"; }, adjustMinerDiff() {},
        shareProcessor: {}, removeMiner() {}, processSend(message) { messages.push(message); }, getCoinJobParams() {}
    });
    handler({}, 1, "login", { login: "example-wallet", pass: "worker" }, ip,
        { port: 39001, portType: "pplns", difficulty: 1 }, () => {},
        (error, timeout) => finals.push({ error, timeout }), () => {});
    return { messages, finals, state };
}

function withLoginGlobals(run) {
    const originalConfig = global.config;
    const originalCoinFuncs = global.coinFuncs;
    try {
        global.config = { pool: { workerMax: 20, minerFirstShareTimeout: 0 } };
        global.coinFuncs = { algoMainCheck() { return true; } };
        run();
    } finally {
        global.config = originalConfig;
        global.coinFuncs = originalCoinFuncs;
    }
}

test("all worker-limit login paths request the existing cluster IP ban and retain delayed replies", () => {
    withLoginGlobals(() => {
        for (const mode of ["existing-wallet-limit", "ordinary-cap", "proxy-cap"]) {
            const result = attemptLogin(mode);
            assert.deepEqual(result.messages, [{ type: "banIP", data: ADDRESS }], mode);
            assert.equal(result.finals.length, 1, mode);
            assert.equal(result.finals[0].timeout, 30, mode);
            assert.equal(result.state.activeMiners.size, 0, "rejected clients never become active miners");
        }
    });
});

test("ordinary invalid-wallet, malformed-username and missing-template errors do not request IP bans", () => {
    withLoginGlobals(() => {
        for (const mode of ["invalid-wallet", "malformed-username", "no-template"]) {
            const result = attemptLogin(mode);
            assert.deepEqual(result.messages, [], mode);
            assert.equal(result.finals.length, 1, mode);
        }
    });
});

test("whitelisted and local IPs do not receive worker-limit IP bans", () => {
    withLoginGlobals(() => {
        for (const mode of ["existing-wallet-limit", "ordinary-cap", "proxy-cap"]) {
            const result = attemptLogin(mode, true);
            assert.deepEqual(result.messages, [], mode);
            assert.equal(result.finals[0].timeout, 30, "wallet rejection still uses the existing delay");
            for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
                assert.deepEqual(attemptLogin(mode, false, ip).messages, [], ip);
            }
        }
    });
});

test("the existing banIP receiver broadcasts to workers and records their temporary IP bans", () => {
    const master = createPoolState().state;
    const workers = [createPoolState().state, createPoolState().state];
    const received = [];
    function receiver(state, isMaster, sendToWorkers = () => {}) {
        return createMessageHandler({
            cluster: { isMaster }, debug() {}, state, sendToWorkers,
            setNewBlockTemplate() {}, setNewCoinHashFactor() {}, formatCoinPort() { return ""; }
        });
    }
    const workerReceivers = workers.map(state => receiver(state, false));
    const masterReceiver = receiver(master, true, message => {
        received.push(message);
        for (const receive of workerReceivers) receive(message);
    });
    const message = { type: "banIP", data: ADDRESS };
    masterReceiver(message);
    assert.deepEqual(received, [message]);
    for (const worker of workers) assert.equal(worker.bannedTmpIPs[ADDRESS], 1);
    master.ipWhitelist["198.51.100.23"] = 1;
    masterReceiver({ type: "banIP", data: "198.51.100.23" });
    assert.deepEqual(received, [message], "master whitelist prevents ban propagation");
    workers[0].ipWhitelist["198.51.100.24"] = 1;
    workerReceivers[0]({ type: "banIP", data: "198.51.100.24" });
    assert.equal(workers[0].bannedTmpIPs["198.51.100.24"], undefined, "workers independently honor their whitelist");
});
