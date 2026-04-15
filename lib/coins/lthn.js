"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({
    port: 48782,
    coin: "LTHN",
    blobType: 0,
    algo: "argon2/chukwav2",
    blobTypeName: "cryptonote",
    pow: pow.argon2({ variant: 2 }),
    perf: {
        aliases: ["argon2/chukwav2", "chukwav2"]
    }
});
