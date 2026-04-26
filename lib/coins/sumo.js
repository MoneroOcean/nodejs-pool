"use strict";
const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteGetBlock({ port: 19734, coin: "SUMO", blobType: 0, algo: "cn/r", blobTypeName: "cryptonote",
    pow: pow.cryptonight({ variant: 13, useHeight: true }),
    perf: { prevMainAlgo: true, prevDefaultPerf: 1 }
});
