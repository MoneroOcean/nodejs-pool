"use strict";
const { parseArgs } = require("node:util");

module.exports = function parseArgv(args, options = {}) {
    const captureRemainder = options["--"] === true;
    const parsed = parseArgs({
        args: args,
        options: {},
        allowPositionals: true,
        strict: false,
        tokens: true,
    });

    const result = captureRemainder ? { _: [], "--": [] } : { _: [] };
    let afterTerminator = false;

    for (let i = 0; i < parsed.tokens.length; ++i) {
        const token = parsed.tokens[i];

        if (token.kind === "option-terminator") {
            afterTerminator = true;
            continue;
        }

        if (token.kind === "option") {
            if (typeof token.value !== "undefined") {
                result[token.name] = token.value;
                continue;
            }

            const nextToken = parsed.tokens[i + 1];
            if (!afterTerminator && nextToken && nextToken.kind === "positional") {
                result[token.name] = nextToken.value;
                ++i;
            } else {
                result[token.name] = true;
            }
            continue;
        }

        (afterTerminator && captureRemainder ? result["--"] : result._).push(token.value);
    }
    return result;
};
