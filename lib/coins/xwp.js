"use strict";
const { pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.grinGetBlock({ port: 19950, coin: "XWP", blobType: 8, algo: "c29", blobTypeName: "cuckaroo",
    pool: pool.grin({ jobAlgo: "cuckaroo", edgeBits: 29 }),
    rpc: rpc.cryptonoteGetBlock({ walletRewardLookup: false }),
    pow: pow.c29s(),
    perf: { aliases: ["c29", "c29s"] }
});
