"use strict";
const cli = require("../script_utils.js")();
const argv = cli.argv;
const port = cli.integerArg("port", "Please specify port", 1, 65535);
const hash = cli.arg("hash", "Please specify hash");

cli.init(function() {
  global.coinFuncs.getLastBlockHeader(function (err, last_block_body) {
    if (err !== null || !last_block_body){
      console.error("Can't get last block info");
      process.exit(1);
    }
    global.coinFuncs.getPortBlockHeaderByHash(port, hash, function (err_header, body_header) {
      if (err_header || !body_header) {
        console.error("Can't get block info");
        console.error(`err:${   JSON.stringify(err_header)}`);
        console.error(`body:${  JSON.stringify(body_header)}`);
        process.exit(1);
      }
      const rawTimestamp = Number(body_header.timestamp || body_header.time || body_header.mediantime);
      // RPCs use seconds or milliseconds; normalize once before building the record.
      const timestamp = Math.trunc(rawTimestamp > Date.now() / 1000 ? rawTimestamp / 1000 : rawTimestamp);
      const difficulty = Math.trunc(Number(body_header.difficulty || argv["diff"]));
      const height = Number(body_header.height);
      const reward = Number(body_header.reward || body_header["value"]);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0 ||
          !Number.isFinite(difficulty) || difficulty <= 0 ||
          !Number.isSafeInteger(height) || height <= 0 ||
          !Number.isFinite(reward) || reward <= 0) {
        console.error("Block header has invalid timestamp, difficulty, height or reward");
        process.exit(1);
      }
      const body = global.protos.AltBlock.encode({
        hash,
        difficulty,
        shares:        0,
        timestamp:     timestamp * 1000,
        poolType:      global.protos.POOLTYPE.PPLNS,
        unlocked:      false,
        valid:         true,
        port,
        height,
        anchor_height: last_block_body.height,
        value:         reward
      });
      const txn = global.database.env.beginTxn();
      let committed = false;
      try {
        txn.putBinary(global.database.altblockDB, timestamp, body);
        txn.commit();
        committed = true;
      } finally {
        if (!committed) txn.abort();
      }
      console.log(`Block with ${  port  } port and ${  hash  } stored`);
      process.exit(0);
    });
  });
});
