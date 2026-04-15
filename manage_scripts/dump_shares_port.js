"use strict";

const cli = require("../script_utils.js")();
const port = cli.arg("port", "Please specify port to dump");
const depth = cli.get("depth", 10);
const dumpShares = require("./dump_shares_common.js");

console.log("Dumping shares for " + port + " port");

cli.init(function() {
        dumpShares(depth, function (shareData) {
                return shareData.port === port;
        });
});
