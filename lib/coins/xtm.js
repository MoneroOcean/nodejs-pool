"use strict";
const { pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.cryptonote({ port: 18144, coin: "XTM", blobType: 0, algo: "rx/0", blobTypeName: "cryptonote",
    rpc: rpc.xtmMain({ addressCoin: "XTM-T" }),
    pow: pow.randomx(),
    perf: { aliases: [], hashFactorDisabled: true }
});
