"use strict";
const { blob, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 20206,
    coin: null,
    displayCoin: "DERO",
    listed: false,
    blobType: 100,
    algo: "astrobwt/v2",
    blobTypeName: "cryptonote_dero",
    blob: blob.dero(),
    pool: pool.standard({
        resolveSubmittedBlockHash: pool.blockHash.deroBlid,
        submitBlockRpc: pool.blockSubmit.dero
    }),
    template: template.dero(),
    rpc: rpc.dero(),
    pow: pow.astrobwt({ variant: 1 }),
    perf: {
        aliases: []
    }
});
