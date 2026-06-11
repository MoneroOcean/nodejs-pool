"use strict";
const { preset } = require("./core/factories.js");

module.exports = preset.raptoreum({ port: 10225, coin: "BTRM" });
