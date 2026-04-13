"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 12211,
    coin: "RYO",
    blobType: 4,
    algo: "cn/gpu",
    blobTypeName: "cryptonote_ryo",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.cryptonight({ variant: 11 })
});
