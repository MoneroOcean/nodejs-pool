"use strict";
const cli = require("../script_utils.js")({ "--": true });
const updateAltBlocks = require("./altblock_update_common.js");
const pay = cli.numberArg("pay", "Please specify a non-negative pay value in main currency", 0);

cli.init(function onInit() {
    const changed = updateAltBlocks(cli.argv["--"] ?? [], function setPayValue(block) {
        block.pay_value = global.support.decimalToCoin(pay);
        block.unlocked = false;
        console.log(`Put ${  block.pay_value  } pay_value to block`);
    });
    if (!changed) console.log("Not found altblocks with specified hashes");
    else console.log(`Changed ${  changed  } blocks`);
    process.exit(0);
});
