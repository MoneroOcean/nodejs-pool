"use strict";
const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({ port: 19994, coin: "ARQ", blobType: 16, algo: "rx/arq", blobTypeName: "cryptonote_arq",
    pow: pow.randomx({ variant: 2 })
});
