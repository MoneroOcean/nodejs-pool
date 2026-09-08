"use strict";
const { pool, pow, preset } = require("./core/factories.js");

module.exports = preset.cryptonoteHeader({ port: 11898, coin: "TRTL", blobType: 2, algo: "argon2/chukwav2", blobTypeName: "forknote2",
    pool: pool.standard({
        /**
         * Turtle's HTTP daemon returns a plain response body for a successful
         * 202 submission, while the common handler receives JSON-RPC objects.
         * Keep the conversion at this profile boundary.
         * @param {import("../../types/pool_profiles").PoolBlockAcceptanceContext | import("../../types/pool_profiles").PoolAccepted202Context} context
         * @returns {boolean}
        */
        acceptSubmittedBlock(context) {
            if (typeof context.rpcResult !== "string") return false;
            /** @type {import("../../types/pool_profiles").PoolAccepted202Context} */
            const accepted = { rpcResult: context.rpcResult };
            if (typeof context.rpcStatus === "number") accepted.rpcStatus = context.rpcStatus;
            return pool.submitAccept.accepted202String(accepted);
        },
        submitBlockRpc: pool.blockSubmit.httpBlockBody
    }),
    pow: pow.argon2({ variant: 2 }),
    perf: { aliases: ["argon2/chukwav2", "chukwav2"] }
});
