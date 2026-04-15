"use strict";

const { pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.identityHashOnly({
    port: 8545,
    coin: null,
    displayCoin: "ETH",
    listed: false,
    blobType: 102,
    algo: "ethash",
    blobTypeName: "eth",
    pool: pool.eth(),
    rpc: rpc.eth(),
    pow: pow.ethash()
});
