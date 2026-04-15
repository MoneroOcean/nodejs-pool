"use strict";

const { blob, btcTemplate, pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.directReserve({
    port: 9766,
    coin: "CLORE",
    blobType: 101,
    algo: "kawpow",
    blobTypeName: "raven",
    blob: blob.raven(),
    pool: pool.raven(),
    minerAlgoAliases: {
        kawpow: ["kawpow4"]
    },
    rpc: rpc.btc({
        createBlockTemplate: btcTemplate.raven,
        headerRewardMode: "sum-vout",
        rewardMultiplier: 100000000,
        rewardIgnoreAddress: "AePr762UcuQrGoa3TRQpGMX6byRjuXw97A"
    }),
    pow: pow.kawpow(),
    perf: {
        aliases: ["kawpow4", "kawpow"]
    }
});
