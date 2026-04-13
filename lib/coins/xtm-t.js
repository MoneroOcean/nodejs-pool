"use strict";

const { blob, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 18146,
    coin: "XTM-T",
    blobType: 106,
    algo: "rx/0",
    blobTypeName: "xtm-t",
    blob: blob.xtmT(),
    pool: pool.standard({
        resolveSubmittedBlockHash: pool.blockHash.xtmRpcHash,
        submitBlockRpc: pool.blockSubmit.xtmRx
    }),
    template: template.directReserve(),
    rpc: rpc.xtmT(),
    pow: pow.randomx()
});
