"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 9231,
    coin: "XEQ",
    blobType: 5,
    algo: "rx/xeq",
    blobTypeName: "cryptonote_loki",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.randomx({ variant: 22 })
});
