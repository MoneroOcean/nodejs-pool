"use strict";

module.exports = function createServerFactory(deps) {
    const { debug, fs, net, tls, state, handleMinerData, removeMiner } = deps;

    function createPoolSocketHandler(portData) {
        function handleMessage(socket, jsonData, pushMessage) {
            if (!jsonData.id) {
                console.warn("Miner RPC request missing RPC id");
                return;
            }
            if (!jsonData.method) {
                console.warn("Miner RPC request missing RPC method");
                return;
            }

            const sendReply = function sendReply(error, result) {
                if (!socket.writable) return;
                const reply = { jsonrpc: "2.0", id: jsonData.id, error: error ? { code: -1, message: error } : null, result };
                if (jsonData.id === "Stratum") reply.method = jsonData.method;
                debug("[MINER] REPLY TO MINER: " + JSON.stringify(reply));
                if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] reply " + JSON.stringify(reply));
                socket.write(JSON.stringify(reply) + "\n");
            };
            const sendReplyFinal = function sendReplyFinal(error, timeout) {
                setTimeout(function closeSocket() {
                    if (!socket.writable) return;
                    const reply = { jsonrpc: "2.0", id: jsonData.id, error: { code: -1, message: error }, result: null };
                    if (jsonData.id === "Stratum") reply.method = jsonData.method;
                    debug("[MINER] FINAL REPLY TO MINER: " + JSON.stringify(reply));
                    if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] final reply " + JSON.stringify(reply));
                    socket.end(JSON.stringify(reply) + "\n");
                }, (timeout ? timeout : 9) * 1000);
            };

            debug("[MINER] GOT FROM MINER: " + JSON.stringify(jsonData));
            handleMinerData(socket, jsonData.id, jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, sendReplyFinal, pushMessage);
            if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] recieved " + JSON.stringify(jsonData));
        }

        return function socketConn(socket) {
            socket.setKeepAlive(true);
            socket.setEncoding("utf8");

            let dataBuffer = "";
            let pushMessage = function pushMessage(body) {
                if (!socket.writable) return;
                body.jsonrpc = "2.0";
                debug("[MINER] PUSH TO MINER: " + JSON.stringify(body));
                if (socket.debugMiner) console.log(state.threadName + " [WALLET DEBUG] push " + JSON.stringify(body));
                socket.write(JSON.stringify(body) + "\n");
            };

            socket.on("data", function onData(chunk) {
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
                    } catch (_error) {
                        socket.destroy();
                        break;
                    }
                }
                dataBuffer = incomplete;
            }).on("error", function noop() {
            }).on("close", function onClose() {
                pushMessage = function noopPush() {};
                if (socket.miner_id) removeMiner(state.activeMiners.get(socket.miner_id));
                if ("eth_extranonce_id" in socket) state.freeEthExtranonces.push(socket.eth_extranonce_id);
            });
        };
    }

    function startPortServers(portList) {
        return Promise.all(portList.map(function startPortServer(portData) {
            return new Promise(function createServer(resolve, reject) {
                if (global.config[portData.portType].enable !== true) {
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
