"use strict";
// Regression tests for the share-trust hardening:
//   1. isSafeToTrust must draw exactly ONE random byte per decision (the old code drew one per
//      OR-branch and OR'd them, which multiplied the trust probability / shrank the catch rate).
//   2. ETH/ERG special verifiers must FAIL OPEN on verifier-unavailable (drop the share with no
//      credit and no penalty) instead of resetting trust / counting it as an invalid share.
const assert = require("node:assert/strict");
const test = require("node:test");

const createShareBlockHelpers = require("../../../lib/pool/share_blocks.js");
const factories = require("../../../lib/coins/core/factories.js");

function makeHelpers(walletTrust, byteValue, counter) {
    return createShareBlockHelpers({
        crypto: {
            randomBytes() {
                counter.count += 1;
                return Buffer.from([byteValue]);
            }
        },
        walletTrust
    });
}

test.describe("pool runtime: trust gate regression", { concurrency: false }, () => {

test("isSafeToTrust draws exactly one random byte per decision (no double draw)", () => {
    const prevConfig = global.config;
    try {
        global.config = { pool: { trustThreshold: 30, trustMin: 20, trustChange: 1 } };
        const counter = { count: 0 };
        // Both branches eligible (large walletTrust AND large session trust). A failed decision used to
        // consume two draws; it must now consume exactly one.
        const helpers = makeHelpers({ WALLET: 1e9 }, 0, counter);
        assert.equal(helpers.isSafeToTrust(10000, "WALLET", 1e9), false); // 0 > 20 is false
        assert.equal(counter.count, 1);
    } finally {
        global.config = prevConfig;
    }
});

test("wallet-trusted gate boundary is exactly trustMin", () => {
    const prevConfig = global.config;
    try {
        global.config = { pool: { trustThreshold: 30, trustMin: 20, trustChange: 1 } };
        let counter = { count: 0 };
        assert.equal(makeHelpers({ WALLET: 1e9 }, 20, counter).isSafeToTrust(10000, "WALLET", 1e9), false); // == trustMin -> verify
        assert.equal(counter.count, 1);
        counter = { count: 0 };
        assert.equal(makeHelpers({ WALLET: 1e9 }, 21, counter).isSafeToTrust(10000, "WALLET", 1e9), true); // > trustMin -> trust
        assert.equal(counter.count, 1);
    } finally {
        global.config = prevConfig;
    }
});

test("isSafeToTrust short-circuits with no draw when the miner is not trust-eligible", () => {
    const prevConfig = global.config;
    try {
        global.config = { pool: { trustThreshold: 30, trustMin: 20, trustChange: 1 } };
        const counter = { count: 0 };
        // minerTrust 0 and no wallet trust -> neither branch eligible -> no random draw.
        assert.equal(makeHelpers({}, 255, counter).isSafeToTrust(10000, "WALLET", 0), false);
        assert.equal(counter.count, 0);
    } finally {
        global.config = prevConfig;
    }
});

test("trustChange slows the session-branch ramp (stricter gate while rebuilding)", () => {
    const prevConfig = global.config;
    try {
        // Session-only branch (no wallet trust). rewardDiff=10000, minerTrust=1e6 -> minerTrust/rewardDiff = 100.
        // gate = max(256 - 100/(2*trustChange), trustMin):  trustChange=1 -> 206 ; trustChange=2 -> 231.
        const rewardDiff = 10000;
        const trust = 1e6;
        global.config = { pool: { trustThreshold: 30, trustMin: 20, trustChange: 1 } };
        assert.equal(makeHelpers({}, 220, { count: 0 }).isSafeToTrust(rewardDiff, "WALLET", trust), true);  // 220 > 206
        global.config = { pool: { trustThreshold: 30, trustMin: 20, trustChange: 2 } };
        assert.equal(makeHelpers({}, 220, { count: 0 }).isSafeToTrust(rewardDiff, "WALLET", trust), false); // 220 < 231
    } finally {
        global.config = prevConfig;
    }
});

function makeShareCtx(slowHashResult, errorKind, spies) {
    return {
        shareThrottled: () => false,
        getBlockSubmitTestResultBuffer: () => null,
        blockTemplate: { hash: "00".repeat(32), port: 8545 },
        params: { nonce: "00000000" },
        miner: { payout: "WALLET", logString: "w" },
        coinFuncs: {
            slowHashBuffAsync(_blob, _bt, _payout, cb) {
                cb(slowHashResult, errorKind);
            }
        },
        hashEthBuffDiff: () => 1,
        ge: (a, b) => a >= b,
        processShareCB: (...a) => { spies.processShareCB.push(a); },
        invalidShare: (...a) => { spies.invalidShare.push(a); return false; },
        reportMinerShare: (...a) => { spies.reportMinerShare.push(a); },
        verifyShareCB: (...a) => { spies.verifyShareCB.push(a); }
    };
}

const FAIL_OPEN_CASES = [
    { label: "null (timeout/queue drop)", result: null, errorKind: undefined },
    { label: "false + verify-host-error (socket/bad-JSON)", result: false, errorKind: "verify-host-error" }
];

for (const verifier of ["eth", "erg"]) {
    for (const testCase of FAIL_OPEN_CASES) {
        test(`verify${verifier === "eth" ? "Eth" : "Erg"}Share fails open on verifier-unavailable: ${testCase.label}`, () => {
            const verifySpecialShare = factories.pool[verifier]({}).verifySpecialShare;
            const spies = { processShareCB: [], invalidShare: [], reportMinerShare: [], verifyShareCB: [] };
            verifySpecialShare(makeShareCtx(testCase.result, testCase.errorKind, spies));
            assert.deepEqual(spies.processShareCB, [[null]]); // dropped with null
            assert.equal(spies.invalidShare.length, 0);       // NOT penalized
            assert.equal(spies.reportMinerShare.length, 0);   // NOT reported as bad
            assert.equal(spies.verifyShareCB.length, 0);      // NOT credited
        });
    }

    test(`verify${verifier === "eth" ? "Eth" : "Erg"}Share still verifies a real (buffer) result`, () => {
        const verifySpecialShare = factories.pool[verifier]({}).verifySpecialShare;
        const spies = { processShareCB: [], invalidShare: [], reportMinerShare: [], verifyShareCB: [] };
        const buf = Buffer.alloc(32);
        verifySpecialShare(makeShareCtx([buf, buf], undefined, spies));
        assert.equal(spies.verifyShareCB.length, 1);   // normal verify path intact
        assert.equal(spies.processShareCB.length, 0);  // not dropped
        assert.equal(spies.invalidShare.length, 0);    // not penalized
    });
}

});
