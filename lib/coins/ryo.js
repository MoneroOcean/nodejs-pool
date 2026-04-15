"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({
    port: 12211,
    coin: "RYO",
    blobType: 4,
    algo: "cn/gpu",
    blobTypeName: "cryptonote_ryo",
    pow: pow.cryptonight({ variant: 11 })
});
