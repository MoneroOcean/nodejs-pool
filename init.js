"use strict";
let mysql = require("promise-mysql");
let fs = require("fs");
let cluster = require("cluster");
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
let activeModule = null;

function logStartup(kind, name) {
    console.log("=== STARTING " + kind.toUpperCase() + ": " + name + " ===");
}

function isPrimaryProcess(clusterApi) {
    if (!clusterApi) return false;
    if (typeof clusterApi.isPrimary === "boolean") return clusterApi.isPrimary;
    return clusterApi.isMaster === true;
}

function hasClusterWorkers(clusterApi) {
    if (!clusterApi || !clusterApi.workers) return false;
    return Object.keys(clusterApi.workers).some(function hasWorker(id) {
        return !!clusterApi.workers[id];
    });
}

function shutdownErrorMessage(error) {
    return error && error.stack ? error.stack : String(error);
}

function stopActiveModule() {
    if (!activeModule || typeof activeModule.stop !== "function") return Promise.resolve();
    return Promise.resolve(activeModule.stop());
}

function disconnectCluster() {
    return new Promise(function onDisconnect(resolve) {
        if (!isPrimaryProcess(cluster) || !hasClusterWorkers(cluster) || typeof cluster.disconnect !== "function") {
            resolve();
            return;
        }
        try {
            cluster.disconnect(resolve);
        } catch (_error) {
            resolve();
        }
    });
}

function closeMysql() {
    if (!global.mysql || typeof global.mysql.end !== "function") return Promise.resolve();
    return Promise.resolve(global.mysql.end());
}

function syncDatabaseEnv() {
    return new Promise(function onSync(resolve) {
        const env = global.database && global.database.env;
        if (!env || typeof env.sync !== "function") {
            resolve();
            return;
        }
        try {
            env.sync(resolve);
        } catch (_error) {
            resolve();
        }
    });
}

function closeDatabaseEnv() {
    const env = global.database && global.database.env;
    if (!env || typeof env.close !== "function") return;
    env.close();
}

function installGracefulShutdown(name) {
    let shuttingDown = false;

    async function handleSignal(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("Graceful shutdown requested for " + name + " via " + signal);

        async function runStep(label, fn) {
            try {
                await fn();
            } catch (error) {
                console.error(label + " failed: " + shutdownErrorMessage(error));
            }
        }

        await runStep("Module shutdown", stopActiveModule);
        await runStep("Cluster disconnect", disconnectCluster);
        await runStep("MySQL shutdown", closeMysql);
        await runStep("LMDB sync", syncDatabaseEnv);
        await runStep("LMDB close", closeDatabaseEnv);
        process.exit(0);
    }

    ["SIGINT", "SIGTERM"].forEach(function registerSignal(signal) {
        process.on(signal, function onSignal() {
            handleSignal(signal).catch(function onUnhandled(error) {
                console.error("Graceful shutdown failed for " + name + ": " + shutdownErrorMessage(error));
                process.exit(1);
            });
        });
    });
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
        return require('./lib/pool.js');
    });
}

const moduleLoaders = {
    pool: loadPoolModule,
    blockManager: function () { return require('./lib/blockManager.js'); },
    altblockManager: function () { return require('./lib2/altblockManager.js'); },
    altblockExchange: function () { return require('./lib2/altblockExchange.js'); },
    payments: function () { return require('./lib/payments.js'); },
    api: function () { return require('./lib/api.js'); },
    remoteShare: function () { return require('./lib/remoteShare.js'); },
    worker: function () { return require('./lib/worker.js'); },
    pool_stats: function () { return require('./lib/pool_stats.js'); },
    longRunner: function () { return require('./lib/longRunner.js'); }
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
        comms = require('./lib/pool/remote_uplink');
    } else {
        comms = require('./lib/local_comms');
    }
    global.database = new comms();
    global.database.initEnv();
    installGracefulShutdown(argv.hasOwnProperty('module') ? argv.module : (argv.hasOwnProperty('tool') ? argv.tool : 'process'));
    global.coinFuncs.blockedAddresses.push(global.config.pool.address);
    global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
    if (argv.hasOwnProperty('tool') && fs.existsSync('./tools/'+argv.tool+'.js')) {
        logStartup("tool", argv.tool);
        activeModule = require('./tools/'+argv.tool+'.js');
    } else if (argv.hasOwnProperty('module')){
        const loader = moduleLoaders[argv.module];
        if (!loader) {
            console.error("Invalid module provided.  Please provide a valid module");
            process.exit(1);
        }
        if (!cluster.isWorker) {
            console.log("");
            logStartup("module", argv.module);
        }
        return Promise.resolve(loader()).then(function(loadedModule) {
            activeModule = loadedModule;
        });
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
