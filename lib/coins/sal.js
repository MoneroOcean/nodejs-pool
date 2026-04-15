"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({
    port: 19081,
    coin: "SAL",
    blobType: 15,
    algo: "rx/0",
    blobTypeName: "cryptonote_sal",
    pow: pow.randomx()
});
