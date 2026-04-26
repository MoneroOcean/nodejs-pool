"use strict";
const { blob, btcTemplate, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.btcSubmitReserve({ port: 5110, coin: "KCN", blobType: 105, algo: "flex", blobTypeName: "raptoreum_kcn",
    blob: blob.kcn(),
    rpc: rpc.btc({
        createBlockTemplate: btcTemplate.rtm,
        rewardMultiplier: 100000000,
        difficultyMultiplier: 0xFFFFFFFF
    }),
    pow: pow.cryptonight({ variant: 19 })
});
