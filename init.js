"use strict";
let mysql = require("promise-mysql");
let fs = require("fs");
let argv = require('./parse_args')(process.argv.slice(2));
let config = fs.readFileSync("./config.json");
let coinConfig = fs.readFileSync("./coinConfig.json");
let protobuf = require('protocol-buffers');
let path = require('path');

global.support = require("./lib/support.js")();
global.config = JSON.parse(config);
global.mysql = mysql.createPool(global.config.mysql);
global.protos = protobuf(fs.readFileSync('./lib/data.proto'));
global.argv = argv;
let comms;
let coinInc;

function logStartup(kind, name) {
    console.log("Starting " + name + " " + kind + ".");
}

function loadPoolModule() {
    global.config.ports = [];
    return global.mysql.query("SELECT * FROM port_config").then(function(rows){
        rows.forEach(function(row){
            row.hidden = row.hidden === 1;
            row.ssl = row.ssl === 1;
            global.config.ports.push({
                port: row.poolPort,
                difficulty: row.difficulty,
                desc: row.portDesc,
                portType: row.portType,
                hidden: row.hidden,
                ssl: row.ssl
            });
        });
    }).then(function(){
        require('./lib/pool.js');
    });
}

const moduleLoaders = {
    pool: loadPoolModule,
    blockManager: function () { require('./lib/blockManager.js'); },
    altblockManager: function () { require('./lib2/altblockManager.js'); },
    altblockExchange: function () { require('./lib2/altblockExchange.js'); },
    payments: function () { require('./lib/payments.js'); },
    api: function () { require('./lib/api.js'); },
    remoteShare: function () { require('./lib/remoteShare.js'); },
    worker: function () { require('./lib/worker.js'); },
    pool_stats: function () { require('./lib/pool_stats.js'); },
    longRunner: function () { require('./lib/longRunner.js'); }
};

// Config Table Layout
// <module>.<item>

global.mysql.query("SELECT * FROM config").then(function (rows) {
    rows.forEach(function (row){
        if (!global.config.hasOwnProperty(row.module)){
            global.config[row.module] = {};
        }
        if (global.config[row.module].hasOwnProperty(row.item)){
            return;
        }
        switch(row.item_type){
            case 'int':
                global.config[row.module][row.item] = parseInt(row.item_value);
                break;
            case 'bool':
                global.config[row.module][row.item] = (row.item_value === "true");
                break;
            case 'string':
                global.config[row.module][row.item] = row.item_value;
                break;
            case 'float':
                global.config[row.module][row.item] = parseFloat(row.item_value);
                break;
        }
    });
}).then(function(){
    global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
    coinInc = require(global.config.coin.funcFile);
    global.coinFuncs = new coinInc();
    if (argv.module === 'pool'){
        comms = require('./lib/remote_comms');
    } else {
        comms = require('./lib/local_comms');
    }
    global.database = new comms();
    global.database.initEnv();
    global.coinFuncs.blockedAddresses.push(global.config.pool.address);
    global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
    if (argv.hasOwnProperty('tool') && fs.existsSync('./tools/'+argv.tool+'.js')) {
        logStartup("tool", argv.tool);
        require('./tools/'+argv.tool+'.js');
    } else if (argv.hasOwnProperty('module')){
        const loader = moduleLoaders[argv.module];
        if (!loader) {
            console.error("Invalid module provided.  Please provide a valid module");
            process.exit(1);
        }
        logStartup("module", argv.module);
        loader();
    } else {
        console.error("Invalid module/tool provided.  Please provide a valid module/tool");
        console.error("Valid Modules: pool, blockManager, payments, api, remoteShare, worker, longRunner");
        let valid_tools = "Valid Tools: ";
        fs.readdirSync('./tools/').forEach(function(line){
            valid_tools += path.parse(line).name + ", ";
        });
        valid_tools = valid_tools.slice(0, -2);
        console.error(valid_tools);
        process.exit(1);
    }
});
