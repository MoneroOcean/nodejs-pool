"use strict";

const { blob, createProfile, pool, pow, rpc, template } = require("./core/factories.js");

module.exports = createProfile({
    port: 9053,
    coin: "ERG",
    blobType: 103,
    algo: "autolykos2",
    blobTypeName: "erg",
    blob: blob.identity(),
    pool: pool.erg(),
    template: template.hashOnly(),
    rpc: rpc.erg(),
    pow: pow.autolykos2()
});
