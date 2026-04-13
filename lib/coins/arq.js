"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 19994,
    coin: "ARQ",
    blobType: 16,
    algo: "rx/arq",
    blobTypeName: "cryptonote_arq",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.randomx({ variant: 2 })
});
