"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 19950,
    coin: "XWP",
    blobType: 8,
    algo: "c29",
    blobTypeName: "cuckaroo",
    blob: blob.grin(),
    pool: pool.grin({
        jobAlgo: "cuckaroo",
        edgeBits: 29
    }),
    rpc: rpc.cryptonoteGetBlock({ walletRewardLookup: false }),
    pow: pow.c29s(),
    perf: {
        aliases: ["c29", "c29s"]
    }
});
