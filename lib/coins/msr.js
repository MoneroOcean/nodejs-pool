"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 38081,
    coin: "MSR",
    blobType: 6,
    algo: "cn/half",
    blobTypeName: "cryptonote3",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock({ walletZeroRewardAllowed: true }),
    pow: pow.cryptonight({ variant: 9 }),
    perf: {
        aliases: ["cn/fast2", "cn/half"],
        prevDefaultPerf: 1.9
    }
});
