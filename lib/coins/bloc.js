"use strict";

const { pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({
    port: 2086,
    coin: "BLOC",
    blobType: 1,
    algo: "cn-heavy/xhv",
    blobTypeName: "forknote1",
    minerAlgoAliases: {
        "cn-heavy/0": ["cn-heavy"]
    },
    pow: pow.cryptonightHeavy({ variant: 1 })
});
