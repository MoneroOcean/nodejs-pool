"use strict";
const test = require("node:test");

test.describe("worker", { concurrency: false }, function workerSuite() {
    require("./worker/history_imports.js");
    require("./worker/runtime_rollups.js");
    require("./worker/runtime_cache.js");
});
