"use strict";
const test = require("node:test");

test.describe("pool_stats", { concurrency: false }, function poolStatsSuite() {
    require("./stats/cache_state.js");
    require("./stats/runtime_refresh.js");
});
