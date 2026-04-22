"use strict";

const applyConfigRows = require("./lib/common/config_rows.js");

function init(callback) {

	let fs = require("fs");
	let mysql = require("promise-mysql");

	let config = fs.readFileSync("../config.json");
	let coinConfig = fs.readFileSync("../coinConfig.json");
	let protobuf = require('protocol-buffers');

	global.support = require("./lib/common/support.js")();
	global.config = JSON.parse(config);
	global.mysql = mysql.createPool(global.config.mysql);
	global.protos = protobuf(fs.readFileSync('../lib/common/data.proto'));

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
