"use strict";
const { calcEtcBaseReward } = require("./helpers.js");
const { pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.identityHashOnly({ port: 8645, coin: "ETC", blobType: 102, algo: "etchash", blobTypeName: "eth",
    pool: pool.eth(),
    minerAlgoAliases: { etchash: ["ethash"] },
    rpc: rpc.eth({
        baseReward: calcEtcBaseReward,
        // Since era 2, ETC uncle miners receive 1/32 of the current era's base reward.
        fixedUncleReward: true
    }),
    pow: pow.etchash(),
    perf: { aliases: ["etchash", "ethash"] }
});
