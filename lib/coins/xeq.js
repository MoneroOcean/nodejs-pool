"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({
    port: 9231,
    coin: "XEQ",
    blobType: 5,
    algo: "rx/xeq",
    blobTypeName: "cryptonote_loki",
    pow: pow.randomx({ variant: 22 })
});
