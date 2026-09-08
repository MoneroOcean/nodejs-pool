"use strict";

// Compile-only assertions: TypeScript fails if an expected rejection disappears.
// This file is never executed by the runtime test suite.
const parseArgv = require("../../parse_args.js");
const { scanText } = require("../../scripts/lint-sensitive-data.js");
const { paymentWhere } = require("../../script_account_utils.js");

parseArgv(["--depth", "10"]);
scanText("ordinary text", "example.js");

// @ts-expect-error CLI tokens must be strings.
parseArgv([10]);
// @ts-expect-error Optional boundary settings accept booleans, not text flags.
parseArgv([], { "--": "yes" });
// @ts-expect-error Omit optional settings instead of storing undefined in core options.
parseArgv([], { "--": undefined });
// @ts-expect-error A scanner input is definite text, never undefined.
scanText(undefined, "example.js");

const options = parseArgv([]);
// @ts-expect-error Raw boundary values must be validated before entering a string-only core.
scanText(options["missing"], "example.js");

// @ts-expect-error Array indexing can be absent even though the array itself is definite.
scanText(options._[0], "example.js");

paymentWhere({ address: "wallet", paymentId: null }, false);
// @ts-expect-error Internal accounts require a definite address.
paymentWhere({ address: undefined, paymentId: null }, false);
// @ts-expect-error Internal absence is represented explicitly by null.
paymentWhere({ address: "wallet", paymentId: undefined }, false);

/**
 * @param {ReturnType<typeof import("../../lib/pool/templates")>} templates
 * @param {ReturnType<typeof import("../../lib/pool/servers")>} servers
 */
module.exports = function checkPoolFactoryContracts(templates, servers) {
    templates.templateUpdate("", false);
    servers.startPortServers([]);
    // @ts-expect-error Factory methods retain their exact argument types.
    templates.templateUpdate(18081, false);
    // @ts-expect-error Port records must be complete before starting listeners.
    servers.startPortServers([{ port: 3333 }]);
};

/** @param {import("../../types/runtime").LocalDatabasePending} pending */
module.exports.checkPendingDatabase = function checkPendingDatabase(pending) {
    const { getLocalDatabase, getInitializedLocalDatabase } = require("../../lib/common/database.js");
    // @ts-expect-error A local constructor must finish opening resources before use.
    getLocalDatabase(pending);
    getInitializedLocalDatabase(pending).getCache("stats");
};
