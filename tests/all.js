"use strict";

const fs = require("fs");
const path = require("path");

require("./pool.js");
require("./block_manager.js");
require("./long_runner.js");
require("./stats.js");
require("./worker.js");
require("./remote_share.js");
require("./api.js");
require("./support.js");
require("./live.js");
require("./payments.js");
require("./payment_unlock_batch.js");

const privateLib2Tests = path.join(__dirname, "..", "lib2", "tests", "all.js");
if (fs.existsSync(privateLib2Tests)) require(privateLib2Tests);
