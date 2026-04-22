"use strict";

const test = require("node:test");

test.describe("api", { concurrency: false }, function apiSuite() {
    require("./api/cache_and_payments.js");
    require("./api/public_and_auth.js");
});
