"use strict";
const test = require("node:test");

test.describe("block_manager", { concurrency: false }, function blockManagerSuite() {
    require("./block_manager/payments.js");
    require("./block_manager/main_unlockers.js");
    require("./block_manager/alt_unlockers.js");
});
