"use strict";

const { blob, btcTemplate, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 5110,
    coin: "KCN",
    blobType: 105,
    algo: "flex",
    blobTypeName: "raptoreum_kcn",
    blob: blob.kcn(),
    pool: pool.standard({
        submitBlockRpc: pool.blockSubmit.btc
    }),
    template: template.directReserve(),
    rpc: rpc.btc({
        createBlockTemplate: btcTemplate.rtm,
        rewardMultiplier: 100000000,
        difficultyMultiplier: 0xFFFFFFFF
    }),
    pow: pow.cryptonight({ variant: 19 })
});
