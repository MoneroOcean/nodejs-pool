"use strict";
const { pool, pow, preset } = require("./core/factories.js");

module.exports = preset.grinGetBlock({ port: 19281, coin: "XMV", blobType: 8, algo: "c29", blobTypeName: "cuckaroo",
    pool: pool.grin({ jobAlgo: "cuckaroo", edgeBits: 29 }),
    pow: pow.c29v(),
    perf: { aliases: ["c29", "c29v"] }
});
