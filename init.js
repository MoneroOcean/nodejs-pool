"use strict";
const mysql = require("promise-mysql");
const fs = require("fs");
const cluster = require("cluster");
const argv = require('./parse_args')(process.argv.slice(2));
const config = fs.readFileSync("./config.json");
const coinConfig = fs.readFileSync("./coinConfig.json");
const protobuf = require('protocol-buffers');
const path = require('path');
const applyConfigRows = require("./lib/common/config_rows.js");
const isPrimaryProcess = require("./lib/common/is_primary_process.js");

global.support = require("./lib/common/support.js")();
global.config = JSON.parse(config);
global.mysql = mysql.createPool(global.config.mysql);
global.protos = protobuf(fs.readFileSync('./lib/common/data.proto'));
global.argv = argv;
let comms;
let coinInc;
let activeModule = null;
const { formatLogEvent } = require("./lib/common/logging.js");

function logEvent(label, fields) { console.log(formatLogEvent(label, fields)); }

function logStartup(kind, name) {
    console.log(`=== STARTING ${  kind.toUpperCase()  }: ${  name  } ===`);
}

function hasClusterWorkers(clusterApi) {
    if (!clusterApi || !clusterApi.workers) return false;
    return Object.keys(clusterApi.workers).some(function hasWorker(id) {
        return Boolean(clusterApi.workers[id]);
    });
}

function shutdownErrorMessage(error) { return error && error.message ? error.message : String(error); }

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

let databaseEnvClosed = false;
function closeDatabaseEnv() {
    if (databaseEnvClosed) return;
    const env = global.database && global.database.env;
    if (!env || typeof env.close !== "function") return;
    // Mark closed before calling close() so a later exit handler never double-closes (which throws).
    databaseEnvClosed = true;
    try {
        env.close();
    } catch (error) {
        console.error(`LMDB close failed: ${  shutdownErrorMessage(error)}`);
    }
}

function installGracefulShutdown(name) {
    let shuttingDown = false;
    const kind = Object.hasOwn(argv, 'module') ? 'module' : 'tool';

    async function handleSignal(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        logEvent("Shutdown", { kind, name, signal, status: "stopping" });

        async function runStep(label, fn) {
            try {
                await fn();
            } catch (error) {
                console.error(`${label  } failed: ${  shutdownErrorMessage(error)}`);
            }
        }

        await runStep("Module shutdown", stopActiveModule);
        await runStep("Cluster disconnect", disconnectCluster);
        await runStep("MySQL shutdown", closeMysql);
        await runStep("LMDB sync", syncDatabaseEnv);
        await runStep("LMDB close", closeDatabaseEnv);
        logEvent("Shutdown", { kind, name, signal, status: "stopped" });
        process.exit(0);
    }

    function triggerShutdown(signal) {
        handleSignal(signal).catch(function onUnhandled(error) {
            console.error(`Graceful shutdown failed for ${  name  }: ${  shutdownErrorMessage(error)}`);
            process.exit(1);
        });
    }

    ["SIGINT", "SIGTERM"].forEach(function registerSignal(signal) {
        process.on(signal, function onSignal() { triggerShutdown(signal); });
    });

    process.on("disconnect", function onDisconnect() { triggerShutdown("disconnect"); });

    // Final safety net: close the LMDB env (which frees this process's reader slots) on any exit
    // path the graceful handler does not cover - process.exit() on a load error, an uncaught
    // exception, or an unhandled rejection. Node runs "exit" listeners synchronously for all of
    // these, and the close is idempotent, so this never double-closes after a graceful shutdown.
    process.on("exit", closeDatabaseEnv);
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

function loadOptionalLib2Module(relativePath, moduleName) {
    const absolutePath = path.join(__dirname, relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Optional module '${  moduleName  }' requires lib2 at ${  absolutePath}`);
    }
    return require(relativePath);
}

const moduleLoaders = {
    pool: loadPoolModule,
    block_manager () {
        const runtime = require('./lib/block_manager.js').createBlockManagerRuntime();
        runtime.start();
        return runtime;
    },
    altblock_manager () { return loadOptionalLib2Module('./lib2/altblock_manager.js', 'altblock_manager'); },
    altblock_exchange () { return loadOptionalLib2Module('./lib2/altblock_exchange.js', 'altblock_exchange'); },
    payments () { return require('./lib/payments.js'); },
    api () { return require('./lib/api.js'); },
    remote_share () { return require('./lib/remote_share.js'); },
    worker () { return require('./lib/worker.js'); },
    pool_stats () { return require('./lib/pool_stats.js'); },
    long_runner () { return require('./lib/long_runner.js'); }
};

// Config Table Layout
// <module>.<item>

global.mysql.query("SELECT * FROM config").then(function (rows) {
    applyConfigRows(global.config, rows);
}).then(function(){
    global.config['coin'] = JSON.parse(coinConfig)[global.config.coin];
    coinInc = require(global.config.coin.funcFile);
    global.coinFuncs = new coinInc();
    if (argv.module === 'pool'){
        comms = require('./lib/pool/remote_uplink');
    } else {
        comms = require('./lib/common/local_comms');
    }
    global.database = new comms();
    global.database.initEnv();
    installGracefulShutdown(Object.hasOwn(argv, 'module') ? argv.module : (Object.hasOwn(argv, 'tool') ? argv.tool : 'process'));
    global.coinFuncs.blockedAddresses.push(global.config.pool.address);
    global.coinFuncs.blockedAddresses.push(global.config.payout.feeAddress);
    if (Object.hasOwn(argv, 'tool') && fs.existsSync(`./tools/${argv.tool}.js`)) {
        logStartup("tool", argv.tool);
        activeModule = require(`./tools/${argv.tool}.js`);
    } else if (Object.hasOwn(argv, 'module')){
        const loader = moduleLoaders[argv.module];
        if (!loader) {
            console.error("Invalid module provided.  Please provide a valid module");
            process.exit(1);
        }
        if (!cluster.isWorker) {
            console.log("");
            logStartup("module", argv.module);
        }
        return Promise.resolve().then(function runLoader() {
            return loader();
        }).then(function(loadedModule) {
            activeModule = loadedModule;
        }).catch(function onLoaderError(error) {
            console.error(`Failed to load module ${  argv.module  }: ${  shutdownErrorMessage(error)}`);
            process.exit(1);
        });
    } else {
        console.error("Invalid module/tool provided.  Please provide a valid module/tool");
        console.error(`Valid Modules: ${  Object.keys(moduleLoaders).join(", ")}`);
        console.error(`Valid Tools: ${  fs.readdirSync("./tools/").map(function(line) {
            return path.parse(line).name;
        }).join(", ")}`);
        process.exit(1);
    }
});
