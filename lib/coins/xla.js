"use strict";
const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({ port: 11812, coin: "XLA", blobType: 14, algo: "panthera", blobTypeName: "cryptonote_xla",
    pow: pow.randomx({ variant: 3 })
});
