"use strict";
const { pool, pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({ port: 11898, coin: "TRTL", blobType: 2, algo: "cn-pico/trtl", blobTypeName: "forknote2",
    pool: pool.standard({
        acceptSubmittedBlock: pool.submitAccept.accepted202String,
        submitBlockRpc: pool.blockSubmit.httpBlockBody
    }),
    minerAlgoAliases: { "cn-pico/trtl": ["cn-pico"] },
    pow: pow.cryptonightPico(),
    perf: { aliases: ["cn-pico", "cn-pico/trtl"] }
});
