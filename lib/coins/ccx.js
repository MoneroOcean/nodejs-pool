"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({
    port: 16000,
    coin: "CCX",
    blobType: 0,
    algo: "cn/gpu",
    blobTypeName: "cryptonote",
    pow: pow.cryptonight({ variant: 11 })
});
