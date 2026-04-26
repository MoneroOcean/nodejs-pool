"use strict";
const cli = require("../script_utils.js")();
const port = cli.arg("port", "Please specify port to dump");
const depth = cli.get("depth", 10);
const dumpShares = require("./share_dump_common.js");
const parsedPort = Number(port);

if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        console.error("Port must be a positive integer");
        process.exit(1);
}

console.log("Dumping shares for " + port + " port");

cli.init(function() {
        dumpShares(depth, function (shareData) {
                return Number(shareData.port) === parsedPort;
        });
});
