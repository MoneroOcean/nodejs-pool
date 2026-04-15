"use strict";

const { blob, pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.directReserve({
    port: 18148,
    coin: "XTM-C",
    blobType: 107,
    algo: "c29",
    blobTypeName: "xtm-c",
    blob: blob.identity({ proofSize: 42 }),
    pool: pool.xtmC(),
    rpc: rpc.xtmC({ addressCoin: "XTM-T" }),
    pow: pow.c29()
});
