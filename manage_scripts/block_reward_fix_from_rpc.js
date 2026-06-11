"use strict";
const cli = require("../script_utils.js")();
const fixBlockRewardFromRpc = require("./block_reward_fix_common.js");
const hash = cli.arg("hash", "Please specify block hash");

fixBlockRewardFromRpc({
    cli,
    hash,
    databaseName: "blockDB",
    protoName: "Block",
    label: "block",
    getPort: function getMainPort() { return 18081; }
});
