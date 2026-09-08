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

