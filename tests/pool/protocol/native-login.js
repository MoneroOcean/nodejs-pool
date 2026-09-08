"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const blockTemplate = require("node-blocktemplate");

const { ERG_PORT, MAIN_WALLET, startHarness, invokePoolMethod } = require("../common/harness.js");

for (const includeErg of [true, false]) {
    test(`initial native Ergo login with ${includeErg ? "available" : "missing"} template`, async () => {
        const { runtime } = await startHarness();
        try {
            if (includeErg) {
                const normalized = blockTemplate.ErgBlockTemplate({
                    b: (blockTemplate.baseDiff() / 1000000n).toString(),
                    msg: "ab".repeat(32),
                    pk: `02${  "cd".repeat(32)}`,
                    h: "302"
                });
                runtime.setTemplate({
                    ...normalized,
                    coin: "ERG",
                    port: ERG_PORT,
                    coinHashFactor: 1,
                    isHashFactorChange: false
                });
                const activeTemplate = runtime.getState().activeBlockTemplates.ERG;
                assert.ok(activeTemplate, "the production template setter must publish the Erg template");
                assert.equal(activeTemplate.nextBlobWithChildNonceHex, undefined, "hash-only templates must not get a fake child-nonce helper");
            }

            const reply = invokePoolMethod({
                socket: {},
                id: 1,
                method: "login",
                params: {
                    login: MAIN_WALLET,
                    pass: "native-ergo-login",
                    algo: ["autolykos2"],
                    "algo-perf": { autolykos2: 1 },
                    extensions: ["mo-native", "submit-result"]
                }
            });
            if (!includeErg) {
                assert.deepEqual(reply.finals, [{
                    error: "No block template yet. Please wait.", timeout: undefined
                }]);
                assert.equal(reply.replies.length, 0);
                assert.equal(reply.pushes.length, 0, "must not assign unsupported fallback work");
                return;
            }

            assert.equal(reply.finals.length, 0);
            assert.equal(reply.replies.length, 1);
            const response = reply.replies[0];
            assert.equal(response.error, null);
            assert.equal(response.result.algo, "autolykos2");
            assert.deepEqual(response.result.extensions, ["mo-native", "submit-result"]);
            assert.match(response.result.extra_nonce, /^[0-9a-f]{4}$/i);
            assert.deepEqual(reply.pushes.map(message => message.method), [
                "mining.set_extranonce", "mining.set_difficulty", "mining.notify"
            ]);
            assert.deepEqual(reply.pushes[0].params, [response.result.extra_nonce, 6]);
            for (const message of reply.pushes) assert.equal(message.algo, "autolykos2");
            assert.equal(reply.pushes[2].params.length, 9);
        } finally {
            await runtime.stop();
        }
    });
}
