"use strict";
const { parseArgs } = require("node:util");

module.exports = function parseArgv(args, options = {}) {
    const captureRemainder = options["--"] === true;
    // strict:false + tokens:true lets us accept unknown flags and pair
    // space-separated "--foo bar" by hand (parseArgs leaves bar as a positional).
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

        (afterTerminator && captureRemainder ? result["--"] : result._).push(token.value);
    }
    return result;
};
