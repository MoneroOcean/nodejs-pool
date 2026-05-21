"use strict";
const { pool, pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({ port: 11898, coin: "TRTL", blobType: 2, algo: "argon2/chukwav2", blobTypeName: "forknote2",
    pool: pool.standard({
        acceptSubmittedBlock: pool.submitAccept.accepted202String,
        submitBlockRpc: pool.blockSubmit.httpBlockBody
    }),
    pow: pow.argon2({ variant: 2 }),
    perf: { aliases: ["argon2/chukwav2", "chukwav2"] }
});
