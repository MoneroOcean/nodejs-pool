"use strict";
const cli = require("../script_utils.js")({ "--": true });
const updateAltBlocks = require("./altblock_update_common.js");
const stage = cli.arg("stage", "Please specify new stage value");

cli.init(function onInit() {
    const changed = updateAltBlocks(cli.argv["--"], function setStage(block) {
        block.pay_stage = stage;
        console.log(`Put "${  block.pay_stage  }" stage to block`);
    });
    if (!changed) console.log("Not found altblocks with specified hashes");
    process.exit(0);
});
