"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 25182,
    coin: "TUBE",
    blobType: 10,
    algo: "c29",
    blobTypeName: "cryptonote_tube",
    blob: blob.grin({ proofSize: 40 }),
    pool: pool.grin(),
    rpc: rpc.cryptonoteGetBlock({ headerRewardMode: "first-vout" }),
    pow: pow.c29b()
});
