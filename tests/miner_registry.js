"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const createMinerRegistry = require("../lib/pool/miner_registry.js");

const AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createState(bannedAddresses) {
    return {
        threadName: "",
        activeMiners: new Map(),
        activeMinersByPayout: new Map(),
        activeMinerSockets: new Map(),
        minerCount: {},
        proxyMiners: {},
        bannedBigTmpWallets: {},
        bannedAddresses: bannedAddresses || {},
        minerWallets: {}
    };
}

function createMiner(id, payout, payoutDiv) {
    return {
        id,
        payout,
        payout_div: typeof payoutDiv === "undefined" ? null : payoutDiv,
        fixed_diff: false,
        difficulty: 1,
        logString: id,
        port: 1,
        connectTime: Date.now(),
        hasSubmittedValidShare: true,
        lastProtocolActivity: Date.now(),
        lastValidShareTimeMs: Date.now(),
        lastContact: Date.now(),
        calcNewDiff() { return 1; },
        setNewDiff() { return false; },
        sendSameCoinJob() {}
    };
}

function createSocket(id) {
    return {
        miner_id: id,
        writable: true,
        destroyed: false,
        endCalls: 0,
        destroyCalls: 0,
        end() { ++this.endCalls; },
        destroy() {
            ++this.destroyCalls;
            this.destroyed = true;
        }
    };
}

function createTestRegistry(state) {
    return createMinerRegistry({
        cluster: {},
        state,
        debug() {},
        processSend() {},
        formatPoolEvent(label, fields) {
            return fields ? `${label} ${JSON.stringify(fields)}` : label;
        }
    });
}

function addMiner(registry, state, miner, socket) {
    registry.addActiveMiner(miner, socket);
}

function flushImmediate() {
    return new Promise((resolve) => setImmediate(resolve));
}

test("registry broadcasts tolerate worker slots removed during shutdown", () => {
    const sent = [];
    const registry = createMinerRegistry({
        cluster: {workers: {1: undefined, 2: {send(message) { sent.push(message); }}}},
        state: {}, debug() {}, processSend() {}
    });
    const message = {type: "test"};
    registry.sendToWorkers(message);
    assert.deepEqual(sent, [message]);
});

test("retarget counts stay numeric when a connected miner's port is absent from configuration", () => {
    const originalConfig = global.config;
    const originalWorkerId = process.env.WORKER_ID;
    const messages = [];
    const state = {
        threadName: "",
        activeMiners: new Map([["miner", {port: 1234, fixed_diff: false, calcNewDiff() { return 1; }, setNewDiff() { return false; }}]]),
        minerCount: {}
    };
    global.config = {ports: []};
    process.env.WORKER_ID = "1";
    try {
        const registry = createMinerRegistry({cluster: {}, state, debug() {}, processSend(message) { messages.push(message); }});
        registry.retargetMiners();
        assert.equal(state.minerCount[1234], 1);
        assert.equal(messages[0].data.worker_id, 1);
        assert.equal(messages[0].data.ports[1234], 1);
        registry.retargetMiners();
        assert.equal(state.minerCount[1234], 1);
    } finally {
        global.config = originalConfig;
        if (typeof originalWorkerId === "undefined") delete process.env.WORKER_ID;
        else process.env.WORKER_ID = originalWorkerId;
    }
});

test("cached ban audit evicts primary and split payouts with hard socket close", async () => {
    const originalConfig = global.config;
    const originalNow = Date.now;
    const originalLog = console.log;
    let now = 1000;
    const logs = [];
    const bannedAddresses = Object.create({ inheritedWallet: "inherited reason" });
    const state = createState(bannedAddresses);
    const registry = createTestRegistry(state);
    const primary = createMiner("primary", "primaryWallet");
    const split = createMiner("split", "mainWallet", { mainWallet: 50, splitWallet: 50 });
    const inherited = createMiner("inherited", "inheritedWallet");
    const inheritedSplit = Object.create({ inheritedWallet: 50 });
    const inheritedRecipient = createMiner("inherited-split", "safeWallet", inheritedSplit);
    const primarySocket = createSocket(primary.id);
    const splitSocket = createSocket(split.id);
    const inheritedSocket = createSocket(inherited.id);
    const inheritedRecipientSocket = createSocket(inheritedRecipient.id);
    primary.proxyMinerName = "primaryWallet";
    state.proxyMiners.primaryWallet = { connectTime: 1, count: 1, hashes: 0, submissionBudget: false };
    state.minerWallets.primaryWallet = { count: 1 };
    Date.now = () => now;
    global.config = {pool: {minerTimeout: 100000000}};
    console.log = function captureLog(message) { logs.push(String(message)); };

    try {
        addMiner(registry, state, primary, primarySocket);
        addMiner(registry, state, split, splitSocket);
        addMiner(registry, state, inherited, inheritedSocket);
        addMiner(registry, state, inheritedRecipient, inheritedRecipientSocket);

        registry.checkAliveMiners();
        await flushImmediate();
        assert.equal(state.activeMiners.size, 4);

        bannedAddresses.primaryWallet = "";
        bannedAddresses.splitWallet = "";
        now += AUDIT_INTERVAL_MS;
        primary.lastProtocolActivity = now;
        split.lastProtocolActivity = now;
        inherited.lastProtocolActivity = now;
        inheritedRecipient.lastProtocolActivity = now;
        registry.checkAliveMiners();
        await flushImmediate();

        assert.equal(state.activeMiners.has(primary.id), false);
        assert.equal(state.activeMiners.has(split.id), false);
        assert.equal(state.activeMiners.has(inherited.id), true);
        assert.equal(state.activeMiners.has(inheritedRecipient.id), true);
        assert.equal(primarySocket.destroyCalls, 1);
        assert.equal(primarySocket.endCalls, 0);
        assert.equal(primarySocket.destroyReason, "cached-ban");
        assert.equal(splitSocket.destroyCalls, 1);
        assert.equal(splitSocket.endCalls, 0);
        assert.equal(state.activeMinerSockets.has(primary.id), false);
        assert.equal(state.activeMinersByPayout.has(primary.payout), false);
        assert.equal(state.activeMinersByPayout.has(split.payout), false);
        assert.equal(state.minerWallets.primaryWallet, undefined);
        assert.equal(state.proxyMiners.primaryWallet, undefined);
        assert.equal(logs.filter((message) => message.includes("Cached ban audit")).length, 1);
        assert.equal(logs.some((message) => message.includes("primaryWallet") || message.includes("splitWallet")), false);
    } finally {
        console.log = originalLog;
        Date.now = originalNow;
        global.config = originalConfig;
    }
});

test("cached ban audit does not look up bans between deadlines", async () => {
    const originalConfig = global.config;
    const originalNow = Date.now;
    let now = 1000;
    let ownPropertyLookups = 0;
    const bannedTarget = {};
    const bannedAddresses = new Proxy(bannedTarget, {
        getOwnPropertyDescriptor(target, property) {
            ++ownPropertyLookups;
            return Object.getOwnPropertyDescriptor(target, property);
        }
    });
    const state = createState(bannedAddresses);
    const registry = createTestRegistry(state);
    const miner = createMiner("healthy", "healthyWallet");
    Date.now = () => now;
    global.config = {pool: {minerTimeout: 100000000}};

    try {
        addMiner(registry, state, miner, createSocket(miner.id));
        registry.checkAliveMiners();
        await flushImmediate();
        const firstAuditLookups = ownPropertyLookups;
        assert.equal(firstAuditLookups, 1);

        now += 60 * 1000;
        miner.lastProtocolActivity = now;
        registry.checkAliveMiners();
        await flushImmediate();
        assert.equal(ownPropertyLookups, firstAuditLookups);

        now += AUDIT_INTERVAL_MS;
        miner.lastProtocolActivity = now;
        registry.checkAliveMiners();
        await flushImmediate();
        assert.equal(ownPropertyLookups, firstAuditLookups + 1);
    } finally {
        Date.now = originalNow;
        global.config = originalConfig;
    }
});

test("cached ban audit batches live miners and honors an unban before queued work", () => {
    const originalConfig = global.config;
    const originalNow = Date.now;
    const originalSetImmediate = global.setImmediate;
    const originalLog = console.log;
    const now = 1000;
    const queued = [];
    let unrefCalls = 0;
    const logs = [];
    const bannedAddresses = {};
    const state = createState(bannedAddresses);
    const registry = createTestRegistry(state);
    Date.now = () => now;
    global.config = {pool: {minerTimeout: 100000000}};
    global.setImmediate = function queueImmediate(callback) {
        queued.push(callback);
        return {unref() { ++unrefCalls; }};
    };
    console.log = function captureLog(message) { logs.push(String(message)); };

    try {
        for (let index = 0; index < 201; ++index) {
            const payout = `wallet-${index}`;
            bannedAddresses[payout] = "";
            const miner = createMiner(`miner-${index}`, payout);
            addMiner(registry, state, miner, createSocket(miner.id));
        }

        registry.checkAliveMiners();
        registry.checkAliveMiners();
        assert.equal(queued.length, 1);
        assert.equal(unrefCalls, 1);

        queued.shift()();
        assert.equal(state.activeMiners.size, 101);
        assert.equal(queued.length, 1);
        assert.equal(unrefCalls, 2);

        delete bannedAddresses["wallet-100"];
        queued.shift()();
        assert.equal(state.activeMiners.has("miner-100"), true);
        assert.equal(queued.length, 1);

        queued.shift()();
        assert.equal(state.activeMiners.size, 1);
        assert.equal(queued.length, 0);
        assert.equal(logs.filter((message) => message.includes("Cached ban audit")).length, 1);
        assert.equal(logs.some((message) => message.includes("wallet-")), false);
    } finally {
        console.log = originalLog;
        global.setImmediate = originalSetImmediate;
        Date.now = originalNow;
        global.config = originalConfig;
    }
});
