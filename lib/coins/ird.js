"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 13007,
    coin: "IRD",
    blobType: 2,
    algo: "cn-pico/trtl",
    blobTypeName: "forknote2",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    minerAlgoAliases: {
        "cn-pico/trtl": ["cn-pico"]
    },
    rpc: rpc.cryptonoteHeader(),
    pow: pow.cryptonightPico(),
    perf: {
        aliases: ["cn-pico", "cn-pico/trtl"]
    }
});
