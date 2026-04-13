"use strict";

const { blob, btcTemplate, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 8766,
    coin: "RVN",
    blobType: 101,
    algo: "kawpow",
    blobTypeName: "raven",
    blob: blob.raven(),
    pool: pool.raven(),
    template: template.directReserve(),
    minerAlgoAliases: {
        kawpow: ["kawpow4"]
    },
    rpc: rpc.btc({
        createBlockTemplate: btcTemplate.raven,
        headerRewardMode: "sum-vout",
        rewardMultiplier: 100000000
    }),
    pow: pow.kawpow()
});
