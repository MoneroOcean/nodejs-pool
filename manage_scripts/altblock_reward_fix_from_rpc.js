"use strict";
const cli = require("../script_utils.js")();
const fixBlockRewardFromRpc = require("./block_reward_fix_common.js");
const hash = cli.arg("hash", "Please specify altblock hash");

fixBlockRewardFromRpc({
    cli,
    hash,
    databaseName: "altblockDB",
    protoName: "AltBlock",
    label: "altblock",
    getPort: function getAltPort(block) { return block.port; }
});
