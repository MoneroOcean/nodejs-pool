"use strict";

const { pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.identityHashOnly({
    port: 8645,
    coin: "ETC",
    blobType: 102,
    algo: "etchash",
    blobTypeName: "eth",
    pool: pool.eth(),
    minerAlgoAliases: {
        etchash: ["ethash"]
    },
    rpc: rpc.eth(),
    pow: pow.etchash(),
    perf: {
        aliases: ["etchash", "ethash"]
    }
});
