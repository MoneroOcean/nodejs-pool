"use strict";

const { blob, pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.directReserve({
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
    rpc: rpc.xtmT(),
    pow: pow.randomx()
});
