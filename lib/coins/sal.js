"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 19081,
    coin: "SAL",
    blobType: 15,
    algo: "rx/0",
    blobTypeName: "cryptonote_sal",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.randomx()
});
