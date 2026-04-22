"use strict";

const test = require("node:test");

test.describe("deploy", { concurrency: false }, function deploySuite() {
    require("./deploy/deploy.js");
    require("./deploy/leaf.js");
});
