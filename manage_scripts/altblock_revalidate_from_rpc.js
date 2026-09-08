"use strict";
const cli = require("../script_utils.js")();
const updateFromRpc = require("./altblock_rpc_update.js");
const hash = cli.arg("hash", "Please specify altblock hash");

cli.init(function onInit() {
    updateFromRpc(cli, hash, function selectMutation(error, header) {
        // An unavailable or incomplete RPC response cannot prove invalidity.
        if (error !== null || !header || typeof header.reward !== "number" || !Number.isFinite(header.reward) || header.reward <= 0) {
            console.error(`Unable to validate altblock ${hash}`);
            return null;
        }
        return function revalidate(block) {
            block.valid = true;
            block.unlocked = false;
        };
    });
});
