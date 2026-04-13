"use strict";

const { getPoolSecurityConfig, getSubnet24, normalizeRemoteAddress } = require("./security.js");

module.exports = function createServerFactory(deps) {
    const { debug, fs, net, tls, state, handleMinerData, removeMiner } = deps;

    function incrementConnectionCount(target, key) {
        if (!key) return 0;
        if (key in target) return ++target[key];
        target[key] = 1;
        return 1;
    }

    function decrementConnectionCount(target, key) {
        if (!key || !(key in target)) return;
        if (--target[key] <= 0) delete target[key];
    }

    function clearSocketTimers(socket) {
        if (socket.authTimer) {
            clearTimeout(socket.authTimer);
            socket.authTimer = null;
        }
        if (socket.firstShareTimer) {
            clearTimeout(socket.firstShareTimer);
            socket.firstShareTimer = null;
        }
        if (socket.finalReplyTimer) {
            clearTimeout(socket.finalReplyTimer);
            socket.finalReplyTimer = null;
        }
    }

    function touchSocketActivity(socket) {
        const timeNow = Date.now();
        socket.lastSocketActivity = timeNow;
        if (socket.miner_id) {
            const miner = state.activeMiners.get(socket.miner_id);
            if (miner && typeof miner.touchSocketActivity === "function") miner.touchSocketActivity(timeNow);
        }
    }

    function noteProtocolError(socket) {
        const config = getPoolSecurityConfig();
        socket.protocolErrorCount = (socket.protocolErrorCount || 0) + 1;
        if (socket.protocolErrorCount >= config.protocolErrorLimit) {
            socket.destroyReason = "protocol-error-limit";
            socket.destroy();
            return true;
        }
        return false;
    }

    function createPoolSocketHandler(portData) {
        function handleMessage(socket, jsonData, pushMessage) {
            if (!jsonData.id) {
                console.warn("Miner RPC request missing RPC id");
                noteProtocolError(socket);
                return;
            }
            if (!jsonData.method) {
                console.warn("Miner RPC request missing RPC method");
                noteProtocolError(socket);
                return;
            }

            const sendReply = function sendReply(error, result) {
                if (!socket.writable || socket.finalizing) return;
                const reply = { jsonrpc: "2.0", id: jsonData.id, error: error ? { code: -1, message: error } : null, result };
                if (jsonData.id === "Stratum") reply.method = jsonData.method;
                debug("[MINER] REPLY TO MINER: " + JSON.stringify(reply));
                if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] reply " + JSON.stringify(reply));
                socket.write(JSON.stringify(reply) + "\n");
            };
            const sendReplyFinal = function sendReplyFinal(error, timeoutSeconds) {
                if (!socket.writable || socket.finalizing) return;
                socket.finalizing = true;
                clearSocketTimers(socket);
                const reply = { jsonrpc: "2.0", id: jsonData.id, error: { code: -1, message: error }, result: null };
                if (jsonData.id === "Stratum") reply.method = jsonData.method;
                debug("[MINER] FINAL REPLY TO MINER: " + JSON.stringify(reply));
                if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] final reply " + JSON.stringify(reply));
                const finishReply = function finishReply() {
                    socket.finalReplyTimer = null;
                    if (!socket.writable) return;
                    socket.end(JSON.stringify(reply) + "\n");
                };
                if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
                    // Keep long-ban replies expensive for abusive reconnect loops while
                    // avoiding a single fixed delay that is easy to fingerprint.
                    const delayMs = Math.max(1000, Math.ceil(Math.random() * timeoutSeconds * 1000));
                    socket.finalReplyTimer = setTimeout(finishReply, delayMs);
                    return;
                }
                finishReply();
            };

            debug("[MINER] GOT FROM MINER: " + JSON.stringify(jsonData));
            handleMinerData(socket, jsonData.id, jsonData.method, jsonData.params, socket.normalizedRemoteAddress, portData, sendReply, sendReplyFinal, pushMessage);
            if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] recieved " + JSON.stringify(jsonData));
        }

        return function socketConn(socket) {
            const securityConfig = getPoolSecurityConfig();
            const normalizedIp = normalizeRemoteAddress(socket.remoteAddress);
            const subnet = getSubnet24(normalizedIp);
            socket.normalizedRemoteAddress = normalizedIp;
            socket.subnet24 = subnet;
            socket.setKeepAlive(true);
            socket.setEncoding("utf8");
            socket.lastSocketActivity = Date.now();
            socket.protocolErrorCount = 0;
            socket.finalizing = false;

            if (incrementConnectionCount(state.activeConnectionsByIP, normalizedIp) > securityConfig.maxConnectionsPerIP ||
                incrementConnectionCount(state.activeConnectionsBySubnet, subnet) > securityConfig.maxConnectionsPerSubnet) {
                decrementConnectionCount(state.activeConnectionsByIP, normalizedIp);
                decrementConnectionCount(state.activeConnectionsBySubnet, subnet);
                socket.destroyReason = "connection-limit";
                socket.destroy();
                return;
            }

            socket.authTimer = setTimeout(function onAuthTimeout() {
                if (!socket.miner_id) {
                    socket.destroyReason = "auth-timeout";
                    socket.destroy();
                }
            }, securityConfig.socketAuthTimeoutMs);

            let dataBuffer = "";
            let pushMessage = function pushMessage(body) {
                if (!socket.writable || socket.finalizing) return;
                body.jsonrpc = "2.0";
                debug("[MINER] PUSH TO MINER: " + JSON.stringify(body));
                if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] push " + JSON.stringify(body));
                socket.write(JSON.stringify(body) + "\n");
            };

            socket.on("data", function onData(chunk) {
                if (socket.finalizing) {
                    socket.destroy();
                    return;
                }
                touchSocketActivity(socket);
                dataBuffer += chunk;
                if (Buffer.byteLength(dataBuffer, "utf8") > 102400) {
                    dataBuffer = null;
                    console.warn(state.threadName + "Excessive packet size from: " + socket.remoteAddress);
                    socket.destroy();
                    return;
                }
                if (!dataBuffer.includes("\n")) return;

                const messages = dataBuffer.split("\n");
                const incomplete = dataBuffer.slice(-1) === "\n" ? "" : messages.pop();
                for (const message of messages) {
                    if (message.trim() === "") continue;
                    try {
                        handleMessage(socket, JSON.parse(message), pushMessage);
                        if (socket.finalizing) break;
                    } catch (_error) {
                        socket.protocolErrorCount = (socket.protocolErrorCount || 0) + 1;
                        socket.destroy();
                        break;
                    }
                }
                dataBuffer = incomplete;
            }).on("error", function noop() {
            }).on("close", function onClose() {
                clearSocketTimers(socket);
                decrementConnectionCount(state.activeConnectionsByIP, normalizedIp);
                decrementConnectionCount(state.activeConnectionsBySubnet, subnet);
                pushMessage = function noopPush() {};
                if (socket.miner_id) removeMiner(state.activeMiners.get(socket.miner_id), { destroySocket: false });
                if ("eth_extranonce_id" in socket) state.freeEthExtranonces.push(socket.eth_extranonce_id);
            });
        };
    }

    function startPortServers(portList) {
        return Promise.all(portList.map(function startPortServer(portData) {
            return new Promise(function createServer(resolve, reject) {
                if (portData.portType !== "pplns") {
                    resolve(null);
                    return;
                }
                if (!global.config.pplns || global.config.pplns.enable !== true) {
                    resolve(null);
                    return;
                }

                const socketConn = createPoolSocketHandler(portData);
                const server = portData.ssl === true
                    ? tls.createServer({ key: fs.readFileSync("cert.key"), cert: fs.readFileSync("cert.pem") }, socketConn)
                    : net.createServer(socketConn);

                server.once("error", reject);
                server.listen(portData.port, global.config.bind_ip, function onListen(error) {
                    if (error) {
                        reject(error);
                        return;
                    }
                    server.removeListener("error", reject);
                    server.on("error", function onServerError(serverError) {
                        console.error("Can't bind server to " + portData.port + (portData.ssl === true ? " SSL" : "") + " port!");
                        console.error(serverError);
                    });
                    console.log(state.threadName + "Started server on port: " + portData.port);
                    resolve(server);
                });
            });
        })).then(function stripNullServers(servers) {
            return servers.filter(Boolean);
        });
    }

    return {
        createPoolSocketHandler,
        startPortServers
    };
};
