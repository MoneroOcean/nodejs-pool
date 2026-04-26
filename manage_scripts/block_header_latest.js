"use strict";

const cli = require("../script_utils.js")();

cli.init(function() {
  global.coinFuncs.getLastBlockHeader(function (err_header, body_header) {
    console.log("err:"  + JSON.stringify(err_header));
    console.log("body:" + JSON.stringify(body_header));
    process.exit(err_header ? 1 : 0);
  });
});
