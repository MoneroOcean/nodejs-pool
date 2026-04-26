"use strict";
const test = require("node:test");

test.describe("remote share", { concurrency: false }, function remoteShareSuite() {
    require("./remote_share/ingress.js");
    require("./remote_share/block_jobs.js");
    require("./remote_share/pending_summary.js");
});
