"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 19734,
    coin: "SUMO",
    blobType: 0,
    algo: "cn/r",
    blobTypeName: "cryptonote",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.cryptonight({ variant: 13, useHeight: true }),
    perf: {
        prevMainAlgo: true,
        prevDefaultPerf: 1
    }
});
