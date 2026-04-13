"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 16000,
    coin: "CCX",
    blobType: 0,
    algo: "cn/gpu",
    blobTypeName: "cryptonote",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteHeader(),
    pow: pow.cryptonight({ variant: 11 })
});
