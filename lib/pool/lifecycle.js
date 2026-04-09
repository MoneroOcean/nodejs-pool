"use strict";

module.exports = function createLifecycle(deps) {
    const {
        cluster,
        fs,
        net,
        os,
        readline,
        state,
        minerRegistry,
        shareProcessor,
        templateManager,
        messageHandler,
        startPortServers
    } = deps;

    function dumpRuntimeState() {
        const fileName = "dump" + (cluster.isMaster ? "" : "_" + process.env.WORKER_ID.toString());
        fs.access(fileName, fs.F_OK, function onAccess(error) {
            if (!error) return;
            console.log("DUMPING VARS TO " + fileName + " FILE");
            const stream = fs.createWriteStream(fileName, { flags: "a" });
            stream.write("activeMiners:\n");
            for (const [minerId, miner] of state.activeMiners) stream.write(minerId + ": " + JSON.stringify(miner, null, "\t") + "\n");
            stream.write("\n\n\npastBlockTemplates:\n" + JSON.stringify(state.pastBlockTemplates, null, "\t") + "\n");
            stream.write("\n\n\nlastBlockHash:\n" + JSON.stringify(state.lastBlockHash, null, "\t") + "\n");
            stream.write("\n\n\nlastBlockHeight:\n" + JSON.stringify(state.lastBlockHeight, null, "\t") + "\n");
            stream.write("\n\n\nlastBlockHashMM:\n" + JSON.stringify(state.lastBlockHashMM, null, "\t") + "\n");
            stream.write("\n\n\nlastBlockHeightMM:\n" + JSON.stringify(state.lastBlockHeightMM, null, "\t") + "\n");
            stream.write("\n\n\nlastCoinHashFactor:\n" + JSON.stringify(state.lastCoinHashFactor, null, "\t") + "\n");
            stream.write("\n\n\nnewCoinHashFactor:\n" + JSON.stringify(state.newCoinHashFactor, null, "\t") + "\n");
            stream.write("\n\n\nlastCoinHashFactorMM:\n" + JSON.stringify(state.lastCoinHashFactorMM, null, "\t") + "\n");
            stream.write("\n\n\nactiveBlockTemplates:\n" + JSON.stringify(state.activeBlockTemplates, null, "\t") + "\n");
            stream.write("\n\n\nproxyMiners:\n" + JSON.stringify(state.proxyMiners, null, "\t") + "\n");
            stream.write("\n\n\nanchorBlockHeight: " + state.anchorState.current + "\n");
            stream.write("\n\n\nanchorBlockPrevHeight: " + state.anchorState.previous + "\n");
            stream.write("\n\n\nwalletTrust:\n" + JSON.stringify(state.walletTrust, null, "\t") + "\n");
            stream.write("\n\n\nwalletLastSeeTime:\n" + JSON.stringify(state.walletLastSeeTime, null, "\t") + "\n");
            stream.write("\n\n\nbannedTmpIPs:\n" + JSON.stringify(state.bannedTmpIPs, null, "\t") + "\n");
            stream.write("\n\n\nbannedTmpWallets:\n" + JSON.stringify(state.bannedTmpWallets, null, "\t") + "\n");
            stream.write("\n\n\nbannedBigTmpWallets:\n" + JSON.stringify(state.bannedBigTmpWallets, null, "\t") + "\n");
            stream.end();
        });
    }

    function getUniqueWorkerID(callback) {
        if (!global.config.eth_pool_support) return callback(0, 1);
        global.mysql.query("SELECT id FROM pool_workers WHERE pool_id = ? AND worker_id = ?", [global.config.pool_id, process.env.WORKER_ID]).then(function onRows(rows) {
            if (rows.length === 0) {
                global.mysql.query("INSERT INTO pool_workers (pool_id, worker_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=id", [global.config.pool_id, process.env.WORKER_ID]).then(function retry() {
                    getUniqueWorkerID(callback);
                }).catch(function onInsertError() {
                    console.error("Can't register unique pool worker for " + global.config.pool_id + " pool_id and " + process.env.WORKER_ID + " worker_id");
                    process.exit(1);
                });
                return;
            }
            if (rows.length !== 1) {
                console.error("Can't get unique pool worker for " + global.config.pool_id + " pool_id and " + process.env.WORKER_ID + " worker_id");
                process.exit(1);
                return;
            }
            global.mysql.query("SELECT MAX(id) as maxId FROM pool_workers").then(function onMaxRows(rowsMax) {
                if (rowsMax.length !== 1) {
                    console.error("Can't get max id from pool_workers table");
                    process.exit(1);
                    return;
                }
                if (global.config.max_pool_worker_num && rowsMax[0].maxId > global.config.max_pool_worker_num) {
                    console.error("Prease recreate pool_workers table");
                    process.exit(1);
                    return;
                }
                callback(rows[0].id - 1, (global.config.max_pool_worker_num ? global.config.max_pool_worker_num : rowsMax[0].maxId) - 1);
            });
        });
    }

    function scheduleWorkerReloads() {
        function addBans(isShow) {
            global.mysql.query("SELECT mining_address, reason FROM bans").then(function onBans(rows) {
                state.bannedAddresses = {};
                rows.forEach(function onBan(row) {
                    state.bannedAddresses[row.mining_address] = row.reason;
                    if (isShow) console.log("Added blocked address " + row.mining_address + ": " + row.reason);
                });
            }).catch(function onBanError(error) {
                console.error("SQL query failed: " + error);
            });

            global.mysql.query("SELECT mining_address, message FROM notifications").then(function onNotifications(rows) {
                state.notifyAddresses = {};
                rows.forEach(function onNotification(row) {
                    state.notifyAddresses[row.mining_address] = row.message;
                    if (isShow) console.log("Added notify address " + row.mining_address + ": " + row.message);
                });
            }).catch(function onNotificationError(error) {
                console.error("SQL query failed: " + error);
            });
        }

        function loadTrustFiles() {
            const numWorkers = os.cpus().length;
            for (let i = 1; i <= numWorkers; ++i) {
                const fileName = "wallet_trust_" + i.toString();
                const stream = fs.createReadStream(fileName);
                stream.on("error", function onStreamError() { console.error("Can't open " + fileName + " file"); });
                const lineReader = readline.createInterface({ input: stream });
                lineReader.on("error", function onLineError() { console.error("Can't read lines from " + fileName + " file"); });
                lineReader.on("line", function onLine(line) {
                    const parts = line.split(/\t/);
                    if (parts.length !== 3) {
                        console.error("Error line " + line + " ignored from " + fileName + " file");
                        return;
                    }
                    const wallet = parts[0];
                    const trust = parseInt(parts[1], 10);
                    const time = parseInt(parts[2], 10);
                    if (Date.now() - time < 24 * 60 * 60 * 1000 && (!(wallet in state.walletTrust) || trust < state.walletTrust[wallet])) {
                        state.walletTrust[wallet] = trust;
                        state.walletLastSeeTime[wallet] = time;
                    }
                });
            }
        }

        function dumpTrustAndAgentFiles() {
            let trustFile = "";
            for (const wallet in state.walletTrust) {
                const time = state.walletLastSeeTime[wallet];
                if (Date.now() - time < 24 * 60 * 60 * 1000) trustFile += wallet + "\t" + state.walletTrust[wallet].toString() + "\t" + time.toString() + "\n";
                else {
                    delete state.walletTrust[wallet];
                    delete state.walletLastSeeTime[wallet];
                }
            }
            fs.writeFile("wallet_trust_" + process.env.WORKER_ID.toString(), trustFile, function onTrustWrite(error) {
                if (error) console.error("Error saving wallet trust file");
            });

            if (process.env.WORKER_ID == 1) {
                fs.writeFile("miner_agents", Object.keys(state.minerAgents).join("\n"), function onAgentsWrite(error) {
                    if (error) console.error("Error saving miner_agents file");
                });
            }
        }

        function reloadExtraFiles() {
            function loadListFile(fileName, target) {
                for (const key of Object.keys(target)) delete target[key];
                fs.access(fileName, fs.F_OK, function onAccess(error) {
                    if (error) return;
                    const stream = fs.createReadStream(fileName);
                    stream.on("error", function onStreamError() { console.error("Can't open " + fileName + " file"); });
                    const lineReader = readline.createInterface({ input: stream });
                    lineReader.on("line", function onLine(line) {
                        target[line] = 1;
                    });
                });
            }

            function loadExtraWalletVerify() {
                const entries = [];
                fs.access("extra_wallet_verify.txt", fs.F_OK, function onAccess(error) {
                    if (error) {
                        shareProcessor.replaceExtraWalletVerify(entries);
                        return;
                    }
                    const stream = fs.createReadStream("extra_wallet_verify.txt");
                    stream.on("error", function onStreamError() { console.error("Can't open extra_wallet_verify.txt file"); });
                    const lineReader = readline.createInterface({ input: stream });
                    lineReader.on("line", function onLine(line) {
                        console.log(state.threadName + "[EXTRA CHECK] added: '" + line + "'");
                        entries.push(line);
                    });
                    lineReader.on("close", function onClose() {
                        shareProcessor.replaceExtraWalletVerify(entries);
                    });
                });

                const fileName = "extra_verify_wallet_hashes_" + process.env.WORKER_ID.toString();
                fs.writeFile(fileName, shareProcessor.drainExtraVerifyWalletHashes().join("\n"), function onWrite(error) {
                    if (error) console.error("Error saving " + fileName + " file");
                });
            }

            loadListFile("wallet_debug.txt", state.walletDebug);
            loadListFile("ip_whitelist.txt", state.ipWhitelist);
            loadExtraWalletVerify();
        }

        addBans(true);
        loadTrustFiles();
        setInterval(addBans, 10 * 60 * 1000);
        setInterval(dumpTrustAndAgentFiles, 10 * 60 * 1000);
        setInterval(reloadExtraFiles, 5 * 60 * 1000);
        setInterval(function clearShortBans() {
            state.bannedTmpIPs = {};
            state.bannedTmpWallets = {};
        }, 10 * 60 * 1000);
        setInterval(function clearLongBans() {
            state.bannedBigTmpWallets = {};
        }, 60 * 60 * 1000);
    }

    function scheduleMasterDbSync(numWorkers) {
        setInterval(function updatePoolRows() {
            if ("" in state.activeBlockTemplates) {
                global.mysql.query(
                    "UPDATE pools SET last_checkin = ?, active = ?, blockIDTime = now(), blockID = ?, port = ? WHERE id = ?",
                    [global.support.formatDate(Date.now()), true, state.activeBlockTemplates[""].height, state.activeBlockTemplates[""].port, global.config.pool_id]
                ).catch(function onPoolUpdateError(error) {
                    console.error("SQL query failed: " + error);
                });
            } else {
                global.mysql.query(
                    "UPDATE pools SET last_checkin = ?, active = ? WHERE id = ?",
                    [global.support.formatDate(Date.now()), true, global.config.pool_id]
                ).catch(function onPoolUpdateError(error) {
                    console.error("SQL query failed: " + error);
                });
            }

            global.config.ports.forEach(function updatePortRow(portData) {
                let minerCount = 0;
                for (let i = 1; i <= numWorkers; ++i) minerCount += state.minerCount[i][portData.port];
                global.mysql.query(
                    "UPDATE ports SET lastSeen = now(), miners = ? WHERE pool_id = ? AND network_port = ?",
                    [minerCount, global.config.pool_id, portData.port]
                ).catch(function onPortUpdateError(error) {
                    console.error("SQL query failed: " + error);
                });
            });
        }, 30 * 1000);
    }

    function scheduleStuckTemplateMonitor() {
        setInterval(function checkTemplateHealth() {
            if (!("" in state.activeBlockTemplates)) return;

            global.mysql.query("SELECT blockID, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)").then(function onRows(rows) {
                let topHeight = 0;
                const port = state.activeBlockTemplates[""].port;
                const height = state.activeBlockTemplates[""].height;

                rows.forEach(function onRow(row) {
                    if (row.port != port) return;
                    if (row.blockID > topHeight) topHeight = row.blockID;
                });

                if (!topHeight) {
                    console.error("Can't get top height amongst all leaf nodes for " + port + " port");
                    state.lastBlockFixTime[port] = Date.now();
                    state.lastBlockFixCount[port] = 0;
                    return;
                }

                if (height < topHeight - 3) {
                    console.error("!!! Current block height " + height + " is stuck compared to top height (" + topHeight + ") amongst other leaf nodes for " + port + " port");
                    if (!(port in state.lastBlockFixTime)) state.lastBlockFixTime[port] = Date.now();

                    if (Date.now() - state.lastBlockFixTime[port] <= 20 * 60 * 1000) return;

                    state.lastBlockFixCount[port] = port in state.lastBlockFixCount ? state.lastBlockFixCount[port] + 1 : 1;
                    if (state.lastBlockFixCount[port] > 5 && global.config.general.allowStuckPoolKill && port == global.config.daemon.port) {
                        global.support.sendEmail(
                            global.config.general.adminEmail,
                            "Pool server " + global.config.hostname + " will be terminated",
                            "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " will be terminated due to main chain block template stuck"
                        );
                        console.error("Block height was not updated for a long time for main port. Check your monerod. Exiting...");
                        fs.closeSync(fs.openSync("block_template_is_stuck", "w"));
                        setTimeout(function exitAfterEmail() { process.exit(); }, 30 * 1000);
                        return;
                    }

                    global.coinFuncs.fixDaemonIssue(height, topHeight, port);
                    state.lastBlockFixTime[port] = Date.now();
                    return;
                }

                if (height >= topHeight + 3) {
                    console.warn("Current block height " + height + " is somehow greater than top height (" + topHeight + ") amongst other leaf nodes for " + port + " port");
                }
                state.lastBlockFixTime[port] = Date.now();
                state.lastBlockFixCount[port] = 0;
            }).catch(function onMonitorError(error) {
                console.error("SQL query failed: " + error);
            });
        }, 60 * 1000);
    }

    function startMaster() {
        const numWorkers = global.config.worker_num ? global.config.worker_num : os.cpus().length;
        const workerIdMap = {};
        for (let i = 1; i <= numWorkers; ++i) {
            state.minerCount[i] = [];
            global.config.ports.forEach(function resetWorkerPort(portData) {
                state.minerCount[i][portData.port] = 0;
            });
        }

        minerRegistry.registerPool();
        scheduleMasterDbSync(numWorkers);
        scheduleStuckTemplateMonitor();
        console.log("Master cluster setting up " + numWorkers + " workers...");
        for (let i = 0; i < numWorkers; i++) {
            const worker = cluster.fork({ WORKER_ID: workerIdMap[i + 1] = i + 1 });
            worker.on("message", messageHandler);
        }
        cluster.on("online", function onOnline(worker) {
            console.log("Worker " + worker.process.pid + " is online");
        });
        cluster.on("exit", function onExit(worker, code, signal) {
            console.error("Worker " + worker.process.pid + " died with code: " + code + ", and signal: " + signal);
            const previousWorkerId = workerIdMap[worker.id];
            delete workerIdMap[worker.id];
            const nextWorker = cluster.fork({ WORKER_ID: previousWorkerId });
            workerIdMap[nextWorker.id] = previousWorkerId;
            nextWorker.on("message", messageHandler);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Started new worker " + previousWorkerId,
                "Hello,\r\nMaster thread of " + global.config.hostname + " starts new worker with id " + previousWorkerId);
        });

        state.newCoinHashFactor[""] = state.lastCoinHashFactor[""] = state.lastCoinHashFactorMM[""] = 1;
        templateManager.templateUpdate("");
        setTimeout(templateManager.templateUpdate, state.daemonPollMs, "", true);
        if (global.config.daemon.enableAlgoSwitching) {
            global.coinFuncs.getCOINS().forEach(function scheduleCoin(coin) {
                state.newCoinHashFactor[coin] = state.lastCoinHashFactor[coin] = state.lastCoinHashFactorMM[coin] = 0;
                setInterval(templateManager.updateCoinHashFactor, 5 * 1000, coin);
                templateManager.templateUpdate(coin);
                setTimeout(templateManager.templateUpdate, state.daemonPollMs, coin, true);
            });
        }

        global.support.sendEmail(global.config.general.adminEmail, "Pool server " + global.config.hostname + " online",
            "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");
        setInterval(dumpRuntimeState, 60 * 1000);

        const notifyServer = net.createServer(function onSocket(socket) {
            const timer = setTimeout(function onTimeout() {
                console.error(state.threadName + "Timeout waiting for block notify input");
                socket.destroy();
            }, 3 * 1000);
            let buffer = "";
            socket.on("data", function onData(chunk) { buffer += chunk; });
            socket.on("end", function onEnd() {
                clearTimeout(timer);
                const port = parseInt(buffer.toString());
                const coin = global.coinFuncs.PORT2COIN(port);
                if (typeof coin === "undefined") console.error(state.threadName + "Block notify for unknown coin with " + port + " port");
                else {
                    console.log(state.threadName + "Block notify for coin " + coin + " with " + port + " port");
                    templateManager.templateUpdate(coin, false);
                }
            });
            socket.on("error", function onError() {
                console.error(state.threadName + "Socket error on block notify port");
                socket.destroy();
            });
        });
        notifyServer.listen(state.blockNotifyPort, "127.0.0.1", function onListen() {
            console.log(state.threadName + "Block notify server on " + state.blockNotifyPort + " port started");
        });
    }

    function startWorker() {
        getUniqueWorkerID(function onWorkerId(id, maxId) {
            global.coinFuncs.uniqueWorkerId = id;
            global.coinFuncs.uniqueWorkerIdBit = 0;
            while (maxId) {
                maxId >>= 1;
                ++global.coinFuncs.uniqueWorkerIdBits;
            }
            state.freeEthExtranonces = [...Array(1 << (16 - global.coinFuncs.uniqueWorkerIdBits)).keys()];
            console.log(state.threadName + "Starting pool worker with " + global.coinFuncs.uniqueWorkerId + " unique id and " + global.coinFuncs.uniqueWorkerIdBits + " reserved bits");

            state.newCoinHashFactor[""] = state.lastCoinHashFactor[""] = state.lastCoinHashFactorMM[""] = 1;
            templateManager.templateUpdate("");
            if (global.config.daemon.enableAlgoSwitching) {
                global.coinFuncs.getCOINS().forEach(function onCoin(coin) {
                    state.newCoinHashFactor[coin] = state.lastCoinHashFactor[coin] = state.lastCoinHashFactorMM[coin] = 0;
                    templateManager.templateUpdate(coin);
                });
            }

            templateManager.anchorBlockUpdate();
            setInterval(templateManager.anchorBlockUpdate, 3 * 1000);
            setInterval(minerRegistry.checkAliveMiners, 60 * 1000);
            setInterval(minerRegistry.retargetMiners, global.config.pool.retargetTime * 1000);
            setInterval(dumpRuntimeState, 60 * 1000);
            scheduleWorkerReloads();
            startPortServers(global.config.ports).catch(function onServerError(error) {
                console.error(error);
                process.exit(1);
            });
        });
    }

    return {
        startMaster,
        startWorker
    };
};
