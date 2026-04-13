"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 2086,
    coin: "BLOC",
    blobType: 1,
    algo: "cn-heavy/xhv",
    blobTypeName: "forknote1",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    minerAlgoAliases: {
        "cn-heavy/0": ["cn-heavy"]
    },
    rpc: rpc.cryptonoteHeader(),
    pow: pow.cryptonightHeavy({ variant: 1 })
});
