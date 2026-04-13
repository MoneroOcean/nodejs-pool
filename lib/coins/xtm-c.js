"use strict";

const { blob, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 18148,
    coin: "XTM-C",
    blobType: 107,
    algo: "c29",
    blobTypeName: "xtm-c",
    blob: blob.identity({ proofSize: 42 }),
    pool: pool.xtmC(),
    template: template.directReserve(),
    rpc: rpc.xtmC({ addressCoin: "XTM-T" }),
    pow: pow.c29()
});
