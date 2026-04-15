"use strict";

const { pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({
    port: 38081,
    coin: "MSR",
    blobType: 6,
    algo: "cn/half",
    blobTypeName: "cryptonote3",
    rpc: rpc.cryptonoteGetBlock({ walletZeroRewardAllowed: true }),
    pow: pow.cryptonight({ variant: 9 }),
    perf: {
        aliases: ["cn/fast2", "cn/half"],
        prevDefaultPerf: 1.9
    }
});
