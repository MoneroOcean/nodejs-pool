"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const createTemplateManager = require("../../../lib/pool/templates.js");

test("master delivers distinct worker templates and ignores late variants", () => {
    const saved = { config: global.config, support: global.support, coinFuncs: global.coinFuncs };
    const sent = { 1: [], 2: [] };
    const pending = [];
    try {
        global.config = { daemon: { port: 18081 }, pool: { trustedMiners: false } };
        global.support = { circularBuffer() { return { enq() {} }; } };
        global.coinFuncs = {
            BlockTemplate: class BlockTemplate {
                constructor(template) {
                    Object.assign(this, template, { idHash: template.hash, nextBlobHex() { return ""; } });
                }
            },
            COIN2PORT() { return 44109; },
            algoShortTypeStr() { return "pearlhash"; },
            getPoolHashesPerDifficulty() { return 1; },
            getPoolProfile() { return { rpc: {
                headerProvidesTemplate: true,
                getWorkerBlockTemplate(ctx) {
                    if (ctx.workerId === 0) ctx.callback(ctx.baseTemplate, null);
                    else pending.push(ctx);
                }
            } }; },
            getMM_PORTS() { return {}; },
            getMM_CHILD_PORTS() { return {}; },
            getAuxChainXTM() { return null; },
            getPortBlockTemplate() { assert.fail("worker variant used normal template path"); }
        };
        const cluster = {
            isMaster: true,
            workers: {
                1: { send(message) { sent[1].push(message); } },
                2: { send(message) { sent[2].push(message); } }
            }
        };
        const manager = createTemplateManager({
            cluster,
            debug() {},
            daemonPollMs: 1000,
            activeMiners: new Map(),
            activeBlockTemplates: {},
            pastBlockTemplates: {},
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
            sendToWorkers() { assert.fail("shared template broadcast"); },
            getThreadName() { return ""; },
            formatCoinPort() { return "PRL"; },
            formatPoolEvent(label) { return label; }
        });
        const base = { height: 100, difficulty: 2, hash: "base", worker_template_group: "tip1", target: "10", cert_version: 3, expected_reward: 4 };
        manager.registerWorkerTemplate(1, 0);
        manager.registerWorkerTemplate(2, 1);
        manager.templateUpdate2("PRL", 44109, true, false, 1, false, base);
        assert.equal(sent[1][0].data.hash, "base");
        assert.equal(pending[0].workerId, 1);
        assert.equal(sent[2].length, 0);

        pending.shift().callback({ ...base, hash: "variant1" }, null);
        assert.equal(sent[2][0].data.hash, "variant1");

        manager.registerWorkerTemplate(2, 1);
        const oldRequest = pending.shift();
        const next = { ...base, height: 101, hash: "base2", worker_template_group: "tip2" };
        manager.templateUpdate2("PRL", 44109, true, false, 1, false, next);
        assert.equal(sent[1][1].data.hash, "base2");
        oldRequest.callback({ ...base, hash: "late" }, null);
        assert.equal(sent[2].length, 1);
        pending.shift().callback({ ...next, hash: "variant2" }, null);
        assert.equal(sent[2][1].data.hash, "variant2");
    } finally {
        global.config = saved.config;
        global.support = saved.support;
        global.coinFuncs = saved.coinFuncs;
    }
});
