"use strict";
const { getLocalDatabase } = require("../lib/common/database.js");
const updateAltBlocks = require("./altblock_update_common.js");

/**
 * Read the RPC port with a short-lived reader, then mutate the latest record
 * after the RPC finishes. No database transaction spans the network request.
 * @param {import("../script_utils.js").Cli} cli
 * @param {string} hash
 * @param {(error: unknown, header: import("../types/runtime").BlockHeader | undefined) => ((block: import("../types/runtime").AltBlockMessage) => void) | null} selectMutation
 */
module.exports = function updateAltBlockFromRpc(cli, hash, selectMutation) {
    let port = null;
    cli.forEachBinaryEntry(getLocalDatabase(global.database).altblockDB, function readPort(_key, data) {
        const block = global.protos.AltBlock.decode(data);
        if (block.hash === hash) port = block.port;
    });
    if (port === null) {
        console.log(`Not found altblock with ${hash} hash`);
        process.exit(1);
    }
    global.coinFuncs.getPortBlockHeaderByHash(port, hash, function onHeader(error, header) {
        const mutate = selectMutation(error, header);
        if (!mutate) process.exit(1);
        const changed = updateAltBlocks([hash], mutate);
        process.exit(changed ? 0 : 1);
    });
};
