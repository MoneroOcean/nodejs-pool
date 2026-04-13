"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 48782,
    coin: "LTHN",
    blobType: 0,
    algo: "argon2/chukwav2",
    blobTypeName: "cryptonote",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteHeader(),
    pow: pow.argon2({ variant: 2 }),
    perf: {
        aliases: ["argon2/chukwav2", "chukwav2"]
    }
});
