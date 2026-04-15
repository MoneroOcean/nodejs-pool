"use strict";

const cli = require("../script_utils.js")();
const port = cli.arg("port", "Please specify port");
const height = cli.arg("height", "Please specify height");

cli.init(function() {
  global.coinFuncs.getPortBlockHeaderByID(port, height, function (err_header, body_header) {
    console.log("err:"  + JSON.stringify(err_header));
    console.log("body:" + JSON.stringify(body_header));
    process.exit(0);
  });
});
