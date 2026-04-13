"use strict";

const { blob, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 8545,
    coin: null,
    displayCoin: "ETH",
    listed: false,
    blobType: 102,
    algo: "ethash",
    blobTypeName: "eth",
    blob: blob.identity(),
    pool: pool.eth(),
    template: template.hashOnly(),
    rpc: rpc.eth(),
    pow: pow.ethash()
});
