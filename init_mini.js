"use strict";
const applyConfigRows = require("./lib/common/config_rows.js");
const path = require("path");

const REPO_ROOT = __dirname;
const CONFIG_PATH = path.join(REPO_ROOT, "config.json");
const COIN_CONFIG_PATH = path.join(REPO_ROOT, "coinConfig.json");
const DATA_PROTO_PATH = path.join(REPO_ROOT, "lib/common/data.proto");

function init(callback) {

	let fs = require("fs");
	let mysql = require("promise-mysql");

	let config = fs.readFileSync(CONFIG_PATH);
	let coinConfig = fs.readFileSync(COIN_CONFIG_PATH);
	let protobuf = require('protocol-buffers');

	global.support = require("./lib/common/support.js")();
	global.config = JSON.parse(config);
	global.mysql = mysql.createPool(global.config.mysql);
	global.protos = protobuf(fs.readFileSync(DATA_PROTO_PATH));

	global.mysql.query("SELECT * FROM config").then(function (rows) {
		applyConfigRows(global.config, rows);
	}).then(function(){
		global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
		let coinInc = require(global.config.coin.funcFile);
		global.coinFuncs = new coinInc();
			let comms = require('./lib/common/local_comms');
		global.database = new comms();
		global.database.initEnv();
		
	}).then(callback);
}
		
module.exports = { init };
