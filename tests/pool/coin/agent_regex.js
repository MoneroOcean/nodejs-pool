"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

// Build the real exported agent regexes (createConstants only needs the merged-mining
// nonce size from the block template).
const createConstants = require("../../../lib/coins/constants.js");
const constants = createConstants({ get_merged_mining_nonce_size: () => 0 });

function version(re, agent) {
    const match = re.exec(agent);
    return match ? `${match[1]  }.${  match[2]  }.${  match[3]}` : null;
}

test.describe("coin agent regexes", { concurrency: false }, function agentRegexSuite() {
    test("xmr-stak agent regexes still match real miner agent strings", () => {
        assert.equal(version(constants.reXMRSTAK, "xmr-stak/2.10.8"), "2.10.8");
        assert.equal(version(constants.reXMRSTAK, "xmr-stak-cpu/1.3.0"), "1.3.0");
        assert.equal(version(constants.reXMRSTAK, "xmr-stak-amd/2.4.7"), "2.4.7");
        assert.equal(version(constants.reXMRSTAKRX, "xmr-stak-rx/1.0.5"), "1.0.5");
        // A non-stak agent must not match the stak rule.
        assert.equal(version(constants.reXMRSTAK, "XMRig/6.21.0"), null);
    });

    test("the bounded prefix stays match-equivalent to the unbounded form, even for long prefixes", () => {
        // A run of word characters longer than the {1,64} bound immediately before
        // "-stak" still matches, because the engine anchors the bounded run on the
        // characters right before "-stak". So no real agent loses its version match.
        assert.equal(version(constants.reXMRSTAK, `${"x".repeat(100)  }-stak/9.9.9`), "9.9.9");
        assert.equal(version(constants.reXMRSTAKRX, `${"y".repeat(300)  }-stak-rx/1.2.3`), "1.2.3");
    });

    test("an oversized login agent cannot stall the event loop (ReDoS bound)", () => {
        // A pure word-char agent near the stratum per-line byte cap. With the bounded
        // {1,64} quantifier this resolves in a few milliseconds; the previous unbounded
        // \w+ form took several seconds of O(N^2) backtracking and wedged the event loop.
        const hostile = "a".repeat(102000);
        const startedAt = process.hrtime.bigint();
        assert.equal(constants.reXMRSTAK.exec(hostile), null);
        assert.equal(constants.reXMRSTAKRX.exec(hostile), null);
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        assert.ok(
            elapsedMs < 1000,
            `agent regexes on a 102KB agent took ${  elapsedMs.toFixed(0) 
            }ms (expected well under 1000ms; unbounded backtracking would be thousands of ms)`
        );
    });
});
