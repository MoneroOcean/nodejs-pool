"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const createTemplateManager = require("../../../lib/pool/templates.js");

test("master broadcasts one base Pearl template for local worker derivation", () => {
    const saved = { config: global.config, support: global.support, coinFuncs: global.coinFuncs };
    const sent = [];
    const activeBlockTemplates = {};
    const pastBlockTemplates = {};
    try {
        global.config = { daemon: { port: 18081 }, pool: { trustedMiners: false } };
        global.support = { circularBuffer() { return { enq() {} }; } };
        global.coinFuncs = {
            BlockTemplate: class BlockTemplate {
                constructor(template) {
                    if (template.hash === "bad") throw new Error("invalid template");
                    Object.assign(this, template, { idHash: template.hash, nextBlobHex() { return ""; } });
                }
            },
            COIN2PORT() { return 44109; },
            algoShortTypeStr() { return "pearlhash"; },
            getPoolHashesPerDifficulty() { return 1; },
            getPoolProfile() { return { rpc: { headerProvidesTemplate: true } }; },
            getMM_PORTS() { return {}; },
            getMM_CHILD_PORTS() { return {}; },
            getAuxChainXTM() { return null; }
        };
        const manager = createTemplateManager({
            cluster: { isMaster: true },
            debug() {},
            daemonPollMs: 1000,
            activeMiners: new Map(),
            activeBlockTemplates,
            pastBlockTemplates,
            lastBlockHash: {},
            lastBlockHeight: {},
            lastBlockHashMM: {},
            lastBlockHeightMM: {},
            lastBlockTime: {},
            lastBlockKeepTime: {},
            lastBlockReward: {},
            newCoinHashFactor: { PRL: 1 },
            lastCoinHashFactor: { PRL: 1 },
            lastCoinHashFactorMM: { PRL: 1 },
            anchorState: { current: 0, previous: 0 },
            sendToWorkers(message) { sent.push(message); },
            getThreadName() { return ""; },
            formatCoinPort() { return "PRL"; },
            formatPoolEvent(label) { return label; }
        });
        const base = { height: 100, difficulty: 2, hash: "base", expected_reward: 4 };
        manager.templateUpdate2("PRL", 44109, true, false, 1, false, base);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].type, "newBlockTemplate");
        assert.equal(sent[0].data.hash, "base");
        assert.equal(sent[0].data.coin, "PRL");
        assert.equal(sent[0].data.coinHashFactor, 1);
        const live = activeBlockTemplates.PRL;
        const originalError = console.error;
        console.error = function ignoreExpectedInvalidTemplate() {};
        try {
            manager.setNewBlockTemplate({ ...sent[0].data, hash: "bad" });
        } finally {
            console.error = originalError;
        }
        assert.equal(activeBlockTemplates.PRL, live);
        assert.equal(pastBlockTemplates.PRL, undefined);
    } finally {
        global.config = saved.config;
        global.support = saved.support;
        global.coinFuncs = saved.coinFuncs;
    }
});
