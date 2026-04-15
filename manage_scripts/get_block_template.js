"use strict";

const cli = require("../script_utils.js")();
const port = cli.arg("port", "Please specify port");

cli.init(function() {
  global.coinFuncs.getPortBlockTemplate(port, function (body_header) {
    console.log("body:" + JSON.stringify(body_header));
    process.exit(0);
  });
});
