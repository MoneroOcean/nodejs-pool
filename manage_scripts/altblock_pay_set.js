"use strict";
const updateAltBlocks = require("./altblock_update_common.js");
const cli = require("../script_utils.js")();
const hash = cli.arg("hash", "Please specify altblock hash");
const pay = cli.numberArg("pay", "Please specify a non-negative pay value in main currency", 0);

cli.init(function onInit() {
    const changed = updateAltBlocks([hash], function setPayValue(block) {
        block.pay_value = global.support.decimalToCoin(pay);
        block.unlocked = false;
        console.log(`Put ${block.pay_value} pay_value to block`);
    });
    if (!changed) console.log(`Not found altblock with ${hash} hash`);
    process.exit(changed ? 0 : 1);
});
