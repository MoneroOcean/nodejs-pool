"use strict";

const test = require("node:test");

test.describe("payments", { concurrency: false }, function paymentsSuite() {
    require("./payments/runtime.js");
    require("./payments/submit_cycle.js");
    require("./payments/submit_review.js");
    require("./payments/recovery_cycle.js");
    require("./payments/recovery_submitted.js");
});
