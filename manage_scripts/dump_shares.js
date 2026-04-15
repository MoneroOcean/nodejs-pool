"use strict";

const cli = require("../script_utils.js")();
const user = cli.arg("user", "Please specify user address to dump");
const paymentid = cli.get("paymentid");
const worker = cli.get("worker");
const depth = cli.get("depth", 10);
const dumpShares = require("./dump_shares_common.js");

console.log("Dumping shares for " + user + " user");
if (paymentid) console.log("Dumping shares for " + paymentid + " paymentid");
if (worker)    console.log("Dumping shares for " + worker + " worker");

cli.init(function() {
        dumpShares(depth, function (shareData) {
                return shareData.paymentAddress === user &&
                    (!paymentid || shareData.paymentID === paymentid) &&
                    (!worker || shareData.identifier === worker);
        });
});
