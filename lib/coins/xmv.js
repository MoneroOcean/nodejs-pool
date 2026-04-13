"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 19281,
    coin: "XMV",
    blobType: 8,
    algo: "c29",
    blobTypeName: "cuckaroo",
    blob: blob.grin(),
    pool: pool.grin({
        jobAlgo: "cuckaroo",
        edgeBits: 29
    }),
    rpc: rpc.cryptonoteGetBlock(),
    pow: pow.c29v(),
    perf: {
        aliases: ["c29", "c29v"]
    }
});
