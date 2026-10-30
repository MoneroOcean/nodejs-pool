"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { rpc } = require("../lib/coins/core/factories.js");

function validReply() {
    return { result: {
        block: { header: { height: "42", nonce: "0" } },
        miner_data: { target_difficulty: "100", reward: "25" },
        merge_mining_hash: Array(32).fill(17), vm_key: Array(32).fill(34)
    } };
}

function createPoller(profile, powAlgo) {
    const counts = { rpc: 0, callbacks: 0, retries: 0, depth: 0, maxDepth: 0 };
    function poll(reply) {
        return new Promise(resolve => {
            profile.getBlockTemplate({
                port: 39001, profile: {}, noErrorReport: true,
                runtime: {
                    getPoolAddress() { return "example-address"; },
                    support: { rpcPortDaemon(_port, method, params, callback, noErrorReport) {
                        ++counts.rpc;
                        assert.equal(method, "GetNewBlockTemplateWithCoinbases");
                        assert.equal(params.algo.pow_algo, powAlgo);
                        assert.equal(noErrorReport, true);
                        setImmediate(() => {
                            ++counts.depth;
                            counts.maxDepth = Math.max(counts.maxDepth, counts.depth);
                            try { callback(reply); } finally { --counts.depth; }
                        });
                    } },
                    coinFuncs: { getPortBlockTemplate(_port, callback) {
                        ++counts.retries;
                        // Fail a regression promptly rather than starting an unbounded retry chain.
                        setImmediate(() => callback(null, "Unexpected internal template retry"));
                    } }
                },
                callback(template, error) { ++counts.callbacks; resolve({ template, error }); }
            });
        });
    }
    return { poll, counts };
}

for (const [name, profile, powAlgo, fallback] of [
    ["RandomXT", rpc.xtmT(), 2, "Invalid Tari RandomXT block template"],
    ["Cuckaroo", rpc.xtmC(), 3, "Invalid Tari Cuckaroo block template"]
]) {
    test(`${name} malformed template replies complete once without internal retries`, async () => {
        const invalidHash = validReply();
        invalidHash.result.merge_mining_hash = [256];
        const invalidHeight = validReply();
        invalidHeight.result.block.header.height = "invalid";
        const replies = [undefined, null, {}, { result: null }, { result: {} }, invalidHash, invalidHeight];
        if (powAlgo === 2) {
            const invalidSeed = validReply();
            invalidSeed.result.vm_key = "not-a-byte-array";
            replies.push(invalidSeed);
        }
        const { poll, counts } = createPoller(profile, powAlgo);
        for (const reply of replies) {
            const before = counts.rpc;
            assert.deepEqual(await poll(reply), { template: null, error: fallback });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(counts.rpc, before + 1);
            assert.equal(counts.callbacks, counts.rpc);
            assert.equal(counts.retries, 0);
        }
    });

    test(`${name} preserves RPC errors and recovers on a separate normal poll`, async () => {
        const { poll, counts } = createPoller(profile, powAlgo);
        for (const error of [{ code: -1, message: "Template temporarily unavailable" }, "Daemon unavailable"]) {
            const result = await poll({ error });
            assert.equal(result.template, null);
            assert.equal(result.error, error);
            assert.equal(counts.retries, 0);
        }
        const result = await poll(validReply());
        assert.equal(result.error, null);
        assert.equal(result.template.height, 42);
        assert.equal(result.template.difficulty, 100);
        assert.equal(result.template.reward, 25);
        assert.equal(result.template.blocktemplate_blob.length, powAlgo === 2 ? 152 : 64);
        if (powAlgo === 2) assert.equal(result.template.seed_hash, "22".repeat(32));
        assert.equal(counts.rpc, 3);
        assert.equal(counts.callbacks, 3);
        assert.equal(counts.retries, 0);
    });

    test(`${name} thousands of failed caller-controlled polls keep bounded callback depth`, async () => {
        const { poll, counts } = createPoller(profile, powAlgo);
        for (let index = 0; index < 8000; ++index) {
            assert.deepEqual(await poll({ result: null }), { template: null, error: fallback });
        }
        const result = await poll(validReply());
        assert.equal(result.error, null);
        assert.equal(counts.rpc, 8001);
        assert.equal(counts.callbacks, 8001);
        assert.equal(counts.retries, 0);
        assert.equal(counts.maxDepth, 1);
        assert.equal(counts.depth, 0);
    });
}
