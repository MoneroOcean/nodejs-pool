"use strict";

const { blob, btcTemplate, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 10225,
    coin: "BTRM",
    blobType: 104,
    algo: "ghostrider",
    blobTypeName: "raptoreum",
    blob: blob.rtm(),
    pool: pool.standard({
        submitBlockRpc: pool.blockSubmit.btc
    }),
    template: template.directReserve(),
    rpc: rpc.btc({
        createBlockTemplate: btcTemplate.rtm,
        rewardMultiplier: 100000000,
        difficultyMultiplier: 0xFFFFFFFF
    }),
    pow: pow.cryptonight({ variant: 18 })
});
