"use strict";
const cli = require("../script_utils.js")();
const depth = cli.get("depth", 10);
const dumpShares = require("./share_dump_common.js");

console.log("Dumping shares");

cli.init(function() {
        dumpShares(depth, function () {
                return true;
        });
});
