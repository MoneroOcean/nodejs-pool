"use strict";
const { blob, btcTemplate, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.btcSubmitReserve({ port: 9998, coin: "RTM", blobType: 104, algo: "ghostrider", blobTypeName: "raptoreum",
    blob: blob.rtm(),
    rpc: rpc.btc({
        createBlockTemplate: btcTemplate.rtm,
        rewardMultiplier: 100000000,
        difficultyMultiplier: 0xFFFFFFFF
    }),
    pow: pow.cryptonight({ variant: 18 })
});
