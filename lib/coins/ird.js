"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({
    port: 13007,
    coin: "IRD",
    blobType: 2,
    algo: "cn-pico/trtl",
    blobTypeName: "forknote2",
    minerAlgoAliases: {
        "cn-pico/trtl": ["cn-pico"]
    },
    pow: pow.cryptonightPico(),
    perf: {
        aliases: ["cn-pico", "cn-pico/trtl"]
    }
});
