"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MAIN_PORT,
    ETH_PORT,
    startHarness,
    installTestGlobals,
    poolModule
} = require("./pool/common/harness.js");

test.describe("pool runtime", { concurrency: false }, function poolRuntimeSuite() {
    test("pool test API exposes the expected runtime entry points", () => {
        assert.equal(typeof poolModule.startTestRuntime, "function");
        assert.equal(typeof poolModule.handleMinerData, "function");
        assert.equal(typeof poolModule.messageHandler, "function");
        assert.equal(typeof poolModule.registerPool, "function");
        assert.equal(typeof poolModule.retargetMiners, "function");
        assert.equal(typeof poolModule.checkAliveMiners, "function");
        assert.equal(typeof poolModule.getBlockSubmitTestModeState, "function");
        assert.equal(typeof poolModule.refreshBlockSubmitTestMode, "function");
    });

    test("pool harness installs stable default globals for both pool ports", () => {
        installTestGlobals();

        assert.equal(global.__poolTestMode, true);
        assert.equal(global.config.daemon.port, MAIN_PORT);
        assert.deepEqual(
            global.config.ports.map(function mapPort(entry) { return entry.port; }),
            [MAIN_PORT, ETH_PORT]
        );
        assert.equal(global.coinFuncs.COIN2PORT(""), MAIN_PORT);
        assert.equal(global.coinFuncs.COIN2PORT("ETH"), ETH_PORT);
    });

    test("startHarness boots the default pool runtime with main and eth templates", async () => {
        const { runtime } = await startHarness();

        try {
            const state = runtime.getState();
            assert.ok(state.activeBlockTemplates[""]);
            assert.ok(state.activeBlockTemplates.ETH);
            assert.equal(typeof runtime.setTemplate, "function");
        } finally {
            await runtime.stop();
        }
    });

    require("./pool/components/core.js");
    require("./pool/components/runtime.js");
    require("./pool/coin/basics.js");
    require("./pool/coin/submitters.js");
    require("./pool/protocol/stratum.js");
    require("./pool/protocol/jobs.js");
    require("./pool/protocol/eth-session.js");
    require("./pool/protocol/login.js");
    require("./pool/protocol/routing.js");
    require("./pool/protocol/eth-direct.js");
    require("./pool/validation/core.js");
    require("./pool/validation/login.js");
    require("./pool/validation/rate-limits.js");
    require("./pool/runtime/trust.js");
    require("./pool/runtime/block-submit.js");
    require("./pool/runtime/daemons.js");
    require("./pool/runtime/eth.js");
    require("./pool/runtime/sockets.js");
    require("./pool/runtime/retention.js");
    require("./pool/runtime/submissions.js");
    require("./pool/runtime/bans.js");
    require("./pool/runtime/timeouts.js");
    require("./pool/remote-uplink.js");
});
