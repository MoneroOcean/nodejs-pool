"use strict";

const runner = require("./live/runner.js");

module.exports = runner;

if (require.main === module) {
    runner.runFromCli(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
