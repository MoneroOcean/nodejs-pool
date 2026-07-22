"use strict";
const { blob, pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.directReserve({ port: 18148, coin: "XTM-C", blobType: 107, algo: "c29", blobTypeName: "xtm-c",
    blob: blob.identity({ proofSize: 42 }),
    pool: pool.xtmC(),
    // Miner c29 speeds are cycles/s. Convert them to Tari's 42-edge hashrate
    // unit so the matching per-hash profit factor remains reward-neutral.
    perf: { aliases: ["c29"], legacyDifficultyAliases: ["c29"] },
    rpc: rpc.xtmC({ addressCoin: "XTM-T" }),
    pow: pow.c29()
});
