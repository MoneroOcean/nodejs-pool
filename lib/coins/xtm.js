"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 18144,
    coin: "XTM",
    blobType: 0,
    algo: "rx/0",
    blobTypeName: "cryptonote",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.xtmMain({ addressCoin: "XTM-T" }),
    pow: pow.randomx(),
    perf: {
        aliases: [],
        hashFactorDisabled: true
    }
});
