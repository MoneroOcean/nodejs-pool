"use strict";
const { pool, pow, preset, rpc } = require("./core/factories.js");

module.exports = preset.identityHashOnly({ port: 9053, coin: "ERG", blobType: 103, algo: "autolykos2", blobTypeName: "erg",
    pool: pool.erg(),
    rpc: rpc.erg(),
    pow: pow.autolykos2()
});
