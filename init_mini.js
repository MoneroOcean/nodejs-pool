"use strict";
const applyConfigRows = require("./lib/common/config_rows.js");
const path = require("path");

const REPO_ROOT = __dirname;
const CONFIG_PATH = path.join(REPO_ROOT, "config.json");
const COIN_CONFIG_PATH = path.join(REPO_ROOT, "coinConfig.json");
const DATA_PROTO_PATH = path.join(REPO_ROOT, "lib/common/data.proto");

// Standalone scripts (manage_scripts/tools) open the shared LMDB env here but exit via
// process.exit() without a graceful shutdown. Closing the env on "exit" frees this process's
// reader slots (and aborts any read txn an iterator left open) so a script run never leaves a
// stale reader behind. Idempotent and guarded so it is safe on every exit path.
let envClosed = false;
function closeEnv() {
    if (envClosed) return;
    const env = global.database && global.database.env;
    if (!env || typeof env.close !== "function") return;
    envClosed = true;
    try {
        env.close();
    } catch (_error) { /* best-effort close on shutdown; ignore errors */ }
}

function init(callback) {

    let fs = require("fs");
    let mysql = require("promise-mysql");

    let config = fs.readFileSync(CONFIG_PATH);
    let coinConfig = fs.readFileSync(COIN_CONFIG_PATH);
    let protobuf = require("protocol-buffers");

    global.support = require("./lib/common/support.js")();
    global.config = JSON.parse(config);
    global.mysql = mysql.createPool(global.config.mysql);
    global.protos = protobuf(fs.readFileSync(DATA_PROTO_PATH));

    global.mysql.query("SELECT * FROM config").then(function (rows) {
        applyConfigRows(global.config, rows);
    }).then(function(){
        global.config["coin"] = JSON.parse(coinConfig)[global.config.coin];
        let coinInc = require(global.config.coin.funcFile);
        global.coinFuncs = new coinInc();
        let comms = require("./lib/common/local_comms");
        global.database = new comms();
        global.database.initEnv();
        process.on("exit", closeEnv);
    }).then(callback);
}

module.exports = { init };
