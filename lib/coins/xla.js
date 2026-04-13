"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 11812,
    coin: "XLA",
    blobType: 14,
    algo: "panthera",
    blobTypeName: "cryptonote_xla",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.randomx({ variant: 3 })
});
