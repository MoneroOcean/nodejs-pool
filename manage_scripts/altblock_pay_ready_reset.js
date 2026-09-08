"use strict";
const cli = require("../script_utils.js")();
const updateFromRpc = require("./altblock_rpc_update.js");
const hash = cli.arg("hash", "Please specify altblock hash");

cli.init(function onInit() {
    updateFromRpc(cli, hash, function selectMutation(error, header) {
        if (error !== null || !header) {
            console.error(`Unable to validate altblock ${hash}`);
            return null;
        }
        return function resetPayReady(block) {
            console.log(`Changing alt-block pay_ready from ${block.pay_ready} to false`);
            block.pay_ready = false;
        };
    });
});
