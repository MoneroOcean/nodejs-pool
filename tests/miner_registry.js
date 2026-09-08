"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const createMinerRegistry = require("../lib/pool/miner_registry.js");

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
    const messages = [];
    const state = {
        threadName: "",
        activeMiners: new Map([["miner", {port: 1234, fixed_diff: false, calcNewDiff() { return 1; }, setNewDiff() { return false; }}]]),
        minerCount: {}
    };
    global.config = {ports: []};
    try {
        const registry = createMinerRegistry({cluster: {}, state, debug() {}, processSend(message) { messages.push(message); }});
        registry.retargetMiners();
        assert.equal(state.minerCount[1234], 1);
        assert.equal(messages[0].data.ports[1234], 1);
        registry.retargetMiners();
        assert.equal(state.minerCount[1234], 1);
    } finally {
        global.config = originalConfig;
    }
});
