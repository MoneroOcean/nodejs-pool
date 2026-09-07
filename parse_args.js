"use strict";
const { parseArgs } = require("node:util");

/**
 * Raw CLI values belong at the boundary; callers validate individual options
 * before passing them to core operations.
 * @typedef {{[name: string]: string | boolean | string[] | undefined, _: string[], "--"?: string[]}} ParsedArgs
 */

/**
 * @param {string[]} args
 * @param {{"--"?: boolean}} [options]
 * @returns {ParsedArgs}
 */
module.exports = function parseArgv(args, options = {}) {
    const captureRemainder = options["--"] === true;
    // strict:false + tokens:true lets us accept unknown flags and pair
    // space-separated "--foo bar" by hand (parseArgs leaves bar as a positional).
    const parsed = parseArgs({
        args,
        options: {},
        allowPositionals: true,
        strict: false,
        tokens: true,
    });

    /** @type {string[]} */
    const remainder = [];
    /** @type {ParsedArgs} */
    const result = captureRemainder ? { _: [], "--": remainder } : { _: [] };
    let afterTerminator = false;

    for (let i = 0; i < parsed.tokens.length; ++i) {
        const token = parsed.tokens[i];
        if (!token) continue;

        if (token.kind === "option-terminator") {
            afterTerminator = true;
            continue;
        }

        if (token.kind === "option") {
            // These names store positional metadata, never option values.
            if (token.name === "_" || token.name === "--") throw new Error(`Reserved option name: ${token.name}`);
            if (typeof token.value !== "undefined") {
                result[token.name] = token.value;
                continue;
            }

            // A bare flag takes the next positional as its value ("--foo bar");
            // with nothing to consume it is a boolean. Never reach past "--".
            const nextToken = parsed.tokens[i + 1];
            if (!afterTerminator && nextToken && nextToken.kind === "positional") {
                result[token.name] = nextToken.value;
                ++i;
            } else {
                result[token.name] = true;
            }
            continue;
        }

        (afterTerminator && captureRemainder ? remainder : result._).push(token.value);
    }
    return result;
};
