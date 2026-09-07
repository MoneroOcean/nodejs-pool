"use strict";
const cli = require("../script_utils.js")();
const port = cli.integerArg("port", "Please specify port", 1, 65535);
const height = cli.integerArg("height", "Please specify height", 0, 0xffffffff);

cli.init(function() {
  global.coinFuncs.getPortBlockHeaderByID(port, height, function (err_header, body_header) {
    console.log(`err:${   JSON.stringify(err_header)}`);
    console.log(`body:${  JSON.stringify(body_header)}`);
    process.exit(0);
  });
});
