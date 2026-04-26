"use strict";
const { blob, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.grinGetBlock({ port: 25182, coin: "TUBE", blobType: 10, algo: "c29", blobTypeName: "cryptonote_tube",
    blob: blob.grin({ proofSize: 40 }),
    rpc: rpc.cryptonoteGetBlock({ headerRewardMode: "first-vout" }),
    pow: pow.c29b()
});
