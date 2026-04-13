"use strict";

const { blob, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 8645,
    coin: "ETC",
    blobType: 102,
    algo: "etchash",
    blobTypeName: "eth",
    blob: blob.identity(),
    pool: pool.eth(),
    template: template.hashOnly(),
    minerAlgoAliases: {
        etchash: ["ethash"]
    },
    rpc: rpc.eth(),
    pow: pow.etchash(),
    perf: {
        aliases: ["etchash", "ethash"]
    }
});
