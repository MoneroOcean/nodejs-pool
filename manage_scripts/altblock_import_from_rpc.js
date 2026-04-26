"use strict";
const cli = require("../script_utils.js")();
const argv = cli.argv;
const port = cli.arg("port", "Please specify port");
const hash = cli.arg("hash", "Please specify hash");

cli.init(function() {
  global.coinFuncs.getLastBlockHeader(function (err, last_block_body) {
    if (err !== null){
      console.error("Can't get last block info");
      process.exit(1);
    }
    global.coinFuncs.getPortBlockHeaderByHash(port, hash, function (err_header, body_header) {
      if (err_header) {
        console.error("Can't get block info");
        console.error("err:"  + JSON.stringify(err_header));
        console.error("body:" + JSON.stringify(body_header));
        process.exit(1);
      }
      if (!body_header.timestamp) body_header.timestamp = body_header.time;
      if (!body_header.timestamp) body_header.timestamp = body_header.mediantime;
      if (!body_header.timestamp) {
        console.error("Can't get block timestamp: " + JSON.stringify(body_header));
        process.exit(1);
      }
      if ((Date.now() / 1000) < body_header.timestamp) body_header.timestamp = parseInt(body_header.timestamp / 1000);
      if (!body_header.difficulty) body_header.difficulty = argv.diff;
      if (!body_header.difficulty) {
        console.error("Can't get block difficilty: " + JSON.stringify(body_header));
        process.exit(1);
      }
      if (!body_header.height) {
        console.error("Can't get block height: " + JSON.stringify(body_header));
        process.exit(1);
      }
      if (!body_header.reward && !body_header.value) {
        console.error("Can't get block reward: " + JSON.stringify(body_header));
        process.exit(1);
      }
      body_header.difficulty = parseInt(body_header.difficulty);
      body_header.timestamp = parseInt(body_header.timestamp);
      const body = global.protos.AltBlock.encode({
        hash:          hash,
        difficulty:    body_header.difficulty,
        shares:        0,
        timestamp:     body_header.timestamp * 1000,
        poolType:      global.protos.POOLTYPE.PPLNS,
        unlocked:      false,
        valid:         true,
        port:          port,
        height:        body_header.height,
        anchor_height: last_block_body.height,
        value:         body_header.reward || body_header.value
      });
      const txn = global.database.env.beginTxn();
      txn.putBinary(global.database.altblockDB, body_header.timestamp, body);
      txn.commit();
      console.log("Block with " + port + " port and " + hash + " stored");
      process.exit(0);
    });
  });
});
