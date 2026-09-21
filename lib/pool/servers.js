"use strict";
const { getPoolSecurityConfig, getSubnet24, normalizeRemoteAddress } = require("./security.js");

/** @typedef {import("./miner_registry").RegistryMiner & {touchSocketActivity?: (time: number) => void, validJobs?: {toarray: () => unknown[]}}} ConnectedMiner */
/** @typedef {import("./miner_registry").MinerSocket & {normalizedRemoteAddress?: string, subnet24?: string | null, lastSocketActivity?: number, protocolErrorCount?: number, debugMiner?: boolean, finalReplyTimer?: NodeJS.Timeout | null, largeFrameTimer?: NodeJS.Timeout | null, eth_extranonce_id?: number, eth_extranonce_preview_id?: number}} PoolSocket */
/** @typedef {{lastLoggedAt: number, suppressedCount: number, lastRemoteAddress: string}} ProtocolWarning */
/** @typedef {{normalizedIp: string, subnet: string | null, release: () => void}} ConnectionReservation */
/** @typedef {(body: Record<string, unknown>) => void} PushMessage */
/** @typedef {(error: unknown, result?: unknown) => void} SendReply */
/** @typedef {(error: unknown, timeoutSeconds?: number) => void} SendFinalReply */
/** @typedef {{threadName?: string | undefined, activeConnectionsByIP: Record<string, number>, activeConnectionsBySubnet: Record<string, number>, delayedFinalSocketsByIP?: Map<string, PoolSocket>, activeMiners: Map<string, ConnectedMiner>, protocolWarningState: Record<string, ProtocolWarning>, freeEthExtranonces: number[]}} ServerState */
/** @typedef {(socket: PoolSocket, id: string | number, method: string, params: unknown, ip: string, port: import("../../types/runtime").PortConfig, reply: SendReply, finalReply: SendFinalReply, push: PushMessage, request: Record<string, unknown>) => void} HandleMinerData */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

const STANDARD_PACKET_BYTES = 100 * 1024;
const LARGE_FRAME_MAX_BYTES = 12 * 1024 * 1024;
const LARGE_FRAME_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const LARGE_FRAME_BUFFERED_MAX_BYTES = 32 * 1024 * 1024;
const LARGE_FRAME_TIMEOUT_MS = 30 * 1000;
const PEARL_PREFIX_CHARS = 4096;
const MAX_RPC_ID_STRING_CHARS = 128;
const MAX_REPLY_BYTES = 256 * 1024;
const PEARL_REQUEST_FIELDS = new Set(["jsonrpc", "id", "method", "params", "result"]);
const PEARL_PARAM_FIELDS = new Set(["job_id", "plain_proof", "proof_encoding", "jackpot", "adjustment_factor"]);

/** @param {unknown} value @param {boolean} [allowEmptyProof] */
function isPearlSubmitRequest(value, allowEmptyProof = false) {
    if (!isRecord(value) || value["method"] !== "mining.submit" || !isRecord(value["params"])) return false;
    const params = value["params"];
    if (!Object.keys(value).every(field => PEARL_REQUEST_FIELDS.has(field)) ||
        !Object.keys(params).every(field => PEARL_PARAM_FIELDS.has(field)) || !isValidRpcId(value["id"]) ||
        (value["jsonrpc"] !== undefined && value["jsonrpc"] !== "2.0") ||
        (value["result"] !== undefined && (typeof value["result"] !== "string" || value["result"].length > 64))) return false;
    const jobId = params["job_id"];
    const validJobId = typeof jobId === "string"
        ? jobId.length > 0 && jobId.length <= 256
        : typeof jobId === "number" && Number.isSafeInteger(jobId);
    const proof = params["plain_proof"];
    return validJobId && typeof proof === "string" && (allowEmptyProof || proof.length > 0) &&
        (params["proof_encoding"] === undefined || params["proof_encoding"] === "none");
}

/** Large submissions are admitted only when the bounded prefix identifies Pearl's named submit.
 * @param {unknown} value
 */
function isPearlSubmitPrefix(value) {
    if (typeof value !== "string") return false;
    const prefix = value.slice(0, PEARL_PREFIX_CHARS);
    const field = '"plain_proof"';
    const fieldIndex = prefix.indexOf(field);
    if (fieldIndex < 0) return false;
    const valueStart = /^\s*:\s*"/.exec(prefix.slice(fieldIndex + field.length));
    if (!valueStart) return false;
    const openingQuote = fieldIndex + field.length + valueStart[0].length - 1;
    try {
        // Close an empty proof, its params object, and the top-level request.
        // JSON.parse then proves that method/params/plain_proof are direct
        // members rather than strings or nested decoys.
        return isPearlSubmitRequest(JSON.parse(`${prefix.slice(0, openingQuote + 1)  }"}}`), true);
    } catch (_error) {
        return false;
    }
}

/** A large proof is accepted only after this socket's miner received a PRL job.
 * @param {ConnectedMiner|undefined} miner
 */
function hasPearlJob(miner) {
    if (!miner || !miner.validJobs || typeof miner.validJobs.toarray !== "function") return false;
    return miner.validJobs.toarray().some(function isPearlJob(job) {
        return isRecord(job) && job["coin"] === "PRL";
    });
}

/** @param {Record<string, unknown>} request @returns {Record<string, unknown>} */
function sanitizeRequestForLog(request) {
    const safeMethod = isRecord(request)
        && typeof request["method"] === "string"
        && request["method"].length <= 64
        && /^[A-Za-z0-9_.:-]+$/.test(request["method"])
        ? request["method"] : "[invalid]";
    const params = isRecord(request) && isRecord(request["params"]) ? request["params"] : null;
    const proof = params && typeof params["plain_proof"] === "string" ? params["plain_proof"] : null;
    if (proof === null) {
        return { method: safeMethod, params: "[redacted]" };
    }
    return {
        method: safeMethod,
        params: { plain_proof_chars: proof.length },
    };
}

/** @param {number} port */
function isListenPortNumber(port) {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

/** @param {unknown} value @returns {value is string | number} */
function isValidRpcId(value) {
    return (isNonEmptyString(value) && value.length <= MAX_RPC_ID_STRING_CHARS) ||
        (typeof value === "number" && Number.isFinite(value));
}

/** @param {unknown} value @returns {Set<number>} */
function normalizeSkipListenPorts(value) {
    if (value === undefined || value === null) return new Set();
    if (Array.isArray(value)) {
        return new Set(value.map(Number).filter(isListenPortNumber));
    }
    if (typeof value === "number") {
        return isListenPortNumber(value) ? new Set([value]) : new Set();
    }
    if (typeof value !== "string") return new Set();

    const trimmed = value.trim();
    if (trimmed === "") return new Set();

    if (trimmed[0] === "[") {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return new Set(parsed.map(Number).filter(isListenPortNumber));
        } catch (_error) {
            // malformed JSON port list; fall through to default handling
        }
    }

    return new Set(trimmed.split(",").map(function parsePort(port) {
        return Number(port.trim());
    }).filter(isListenPortNumber));
}

function getSkipListenPorts() {
    return normalizeSkipListenPorts(global.config && global.config.skipListenPorts);
}

/** @param {{debug: ((message: string) => void) & {enabled?: boolean}, fs: typeof import("node:fs"), net: typeof import("node:net"), tls: typeof import("node:tls"), state: ServerState, handleMinerData: HandleMinerData, removeMiner: ReturnType<typeof import("./miner_registry")>["removeMiner"], formatPoolEvent?: (label: string, fields?: Record<string, unknown>) => string}} deps */
module.exports = function createServerFactory(deps) {
    const {
        debug,
        fs,
        net,
        tls,
        state,
        handleMinerData,
        removeMiner,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;
    const PROTOCOL_WARNING_WINDOW_MS = 5 * 60 * 1000;
    let largeFrameBufferedBytes = 0;
    const largeFrameBufferedBytesBySource = new Map();
    // tls.Server hands the application a different socket object after the
    // handshake. Keep only the pending raw-to-TLS handoff keyed by its public
    // four-tuple; the raw socket's close listener remains the cleanup fallback.
    const pendingTlsReservationsByTuple = new Map(/** @type {[string, ConnectionReservation][]} */ ([]));

    /** @param {Record<string, number>} target @param {string | null} key */
    function incrementConnectionCount(target, key) {
        if (!key) return 0;
        const count = (target[key] ?? 0) + 1;
        target[key] = count;
        return count;
    }

    /** @param {Record<string, number>} target @param {string | null} key */
    function decrementConnectionCount(target, key) {
        if (!key) return;
        const count = target[key];
        if (count === undefined) return;
        if (count <= 1) delete target[key];
        else target[key] = count - 1;
    }

    /** @param {PoolSocket} socket @param {string} reason */
    function rejectConnection(socket, reason) {
        if (!socket) return;
        socket.destroyReason = reason;
        if (typeof socket.destroy === "function" && !socket.destroyed) socket.destroy();
    }

    /** @param {PoolSocket} socket */
    function getSocketTupleKey(socket) {
        if (!socket || typeof socket !== "object") return null;
        if (typeof socket.remoteAddress !== "string" || typeof socket.localAddress !== "string"
            || typeof socket.remoteFamily !== "string" || typeof socket.localFamily !== "string"
            || !Number.isInteger(socket.remotePort) || !Number.isInteger(socket.localPort)) return null;
        return JSON.stringify([
            socket.remoteFamily, socket.remoteAddress.toLowerCase(), socket.remotePort,
            socket.localFamily, socket.localAddress.toLowerCase(), socket.localPort
        ]);
    }

    /** @param {PoolSocket} socket */
    function takeTlsReservation(socket) {
        if (!socket || typeof socket !== "object") return null;
        const tupleKey = getSocketTupleKey(socket);
        if (!tupleKey) return null;
        const reservation = pendingTlsReservationsByTuple.get(tupleKey);
        if (reservation) pendingTlsReservationsByTuple.delete(tupleKey);
        return reservation || null;
    }

    /** @param {PoolSocket} socket @param {string | null} [tlsTupleKey] */
    function reserveConnection(socket, tlsTupleKey = null) {
        if (tlsTupleKey && (typeof socket.once !== "function" || pendingTlsReservationsByTuple.has(tlsTupleKey))) {
            rejectConnection(socket, "tls-reservation-conflict");
            return null;
        }

        const securityConfig = getPoolSecurityConfig();
        const normalizedIp = normalizeRemoteAddress(socket.remoteAddress);
        const subnet = getSubnet24(normalizedIp);
        const ipCount = incrementConnectionCount(state.activeConnectionsByIP, normalizedIp);
        if (ipCount > securityConfig.maxConnectionsPerIP) {
            decrementConnectionCount(state.activeConnectionsByIP, normalizedIp);
            rejectConnection(socket, "connection-limit");
            return null;
        }

        const subnetCount = incrementConnectionCount(state.activeConnectionsBySubnet, subnet);
        if (subnetCount > securityConfig.maxConnectionsPerSubnet) {
            decrementConnectionCount(state.activeConnectionsByIP, normalizedIp);
            decrementConnectionCount(state.activeConnectionsBySubnet, subnet);
            rejectConnection(socket, "connection-limit");
            return null;
        }

        let active = true;
        const reservation = {
            normalizedIp,
            subnet,
            release() {
                if (!active) return;
                active = false;
                if (tlsTupleKey && pendingTlsReservationsByTuple.get(tlsTupleKey) === reservation) {
                    pendingTlsReservationsByTuple.delete(tlsTupleKey);
                }
                decrementConnectionCount(state.activeConnectionsByIP, normalizedIp);
                decrementConnectionCount(state.activeConnectionsBySubnet, subnet);
            }
        };
        if (tlsTupleKey) {
            pendingTlsReservationsByTuple.set(tlsTupleKey, reservation);
            socket.once("close", reservation.release);
        }
        return reservation;
    }

    /** @param {PoolSocket} socket */
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

    function getDelayedFinalSocketsByIP() {
        if (!(state.delayedFinalSocketsByIP instanceof Map)) {
            state.delayedFinalSocketsByIP = new Map();
        }
        return state.delayedFinalSocketsByIP;
    }

    /** @param {PoolSocket} socket */
    function clearDelayedFinalSocket(socket) {
        const delayedFinalSocketsByIP = state.delayedFinalSocketsByIP;
        if (!(delayedFinalSocketsByIP instanceof Map)) return;
        const ip = socket.normalizedRemoteAddress || normalizeRemoteAddress(socket.remoteAddress);
        if (ip && delayedFinalSocketsByIP.get(ip) === socket) delayedFinalSocketsByIP.delete(ip);
    }

    /** @param {PoolSocket} socket @param {string} payload @returns {boolean} */
    function writeSocketPayload(socket, payload) {
        if (Buffer.byteLength(payload, "utf8") > MAX_REPLY_BYTES) {
            socket.finalizing = true;
            clearDelayedFinalSocket(socket);
            clearSocketTimers(socket);
            rejectConnection(socket, "reply-too-large");
            return false;
        }
        try {
            if (socket.write(payload) !== false) return true;
        } catch (_error) {
            // Close below through the same bounded failure path.
        }
        socket.finalizing = true;
        clearDelayedFinalSocket(socket);
        clearSocketTimers(socket);
        rejectConnection(socket, "write-backpressure");
        return false;
    }

    /** @param {PoolSocket} socket */
    function registerDelayedFinalSocket(socket) {
        const ip = socket.normalizedRemoteAddress || normalizeRemoteAddress(socket.remoteAddress);
        if (!ip) return true;
        const delayedFinalSocketsByIP = getDelayedFinalSocketsByIP();
        const existingSocket = delayedFinalSocketsByIP.get(ip);
        if (existingSocket && existingSocket !== socket && existingSocket.writable && !existingSocket.destroyed) return false;
        delayedFinalSocketsByIP.set(ip, socket);
        return true;
    }

    /** @param {PoolSocket} socket */
    function touchSocketActivity(socket) {
        const timeNow = Date.now();
        socket.lastSocketActivity = timeNow;
        if (socket.miner_id) {
            const miner = state.activeMiners.get(socket.miner_id);
            if (miner && typeof miner.touchSocketActivity === "function") miner.touchSocketActivity(timeNow);
        }
    }

    /** @param {PoolSocket} socket */
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

    function getProtocolWarningState() {
        if (!state.protocolWarningState || typeof state.protocolWarningState !== "object") {
            state.protocolWarningState = Object.create(null);
        }
        return state.protocolWarningState;
    }

    /** @param {PoolSocket} socket @param {string} warningType @param {string} label */
    function warnProtocolIssue(socket, warningType, label) {
        const warningState = getProtocolWarningState();
        const remoteAddress = socket && typeof socket.normalizedRemoteAddress === "string" && socket.normalizedRemoteAddress !== ""
            ? socket.normalizedRemoteAddress
            : normalizeRemoteAddress(socket && socket.remoteAddress) || "unknown";
        const threadName = typeof state.threadName === "string" ? state.threadName : "";
        const timeNow = Date.now();
        const previous = warningState[warningType];

        if (previous && timeNow - previous.lastLoggedAt < PROTOCOL_WARNING_WINDOW_MS) {
            ++previous.suppressedCount;
            previous.lastRemoteAddress = remoteAddress;
            return;
        }

        let logLine = threadName + formatPoolEvent(label, { ip: remoteAddress });
        if (previous && previous.suppressedCount > 0) {
            logLine += ` (${  formatPoolEvent("suppressed", {
                count: previous.suppressedCount,
                lastIp: previous.lastRemoteAddress
            })  })`;
        }
        console.warn(logLine);
        warningState[warningType] = {
            lastLoggedAt: timeNow,
            suppressedCount: 0,
            lastRemoteAddress: remoteAddress
        };
    }

    /** @param {import("../../types/runtime").PortConfig} portData @param {{tls?: boolean}} [options] */
    function createPoolSocketHandler(portData, options = {}) {
        const isTls = options.tls === true;

        /** @param {PoolSocket} socket @param {unknown} jsonData @param {PushMessage} pushMessage */
        function handleMessage(socket, jsonData, pushMessage) {
            const request = isRecord(jsonData) ? jsonData : {};
            const rpcId = request["id"];
            if (!isValidRpcId(rpcId)) {
                const isMissingId = typeof rpcId === "undefined" || rpcId === null || rpcId === "";
                warnProtocolIssue(socket, isMissingId ? "missing-rpc-id" : "invalid-rpc-id", isMissingId ? "Miner RPC missing id" : "Miner RPC invalid id");
                noteProtocolError(socket);
                return;
            }
            const rpcMethod = request["method"];
            if (!isNonEmptyString(rpcMethod)) {
                const isMissingMethod = typeof rpcMethod === "undefined" || rpcMethod === null || rpcMethod === "";
                warnProtocolIssue(socket, isMissingMethod ? "missing-rpc-method" : "invalid-rpc-method", isMissingMethod ? "Miner RPC missing method" : "Miner RPC invalid method");
                noteProtocolError(socket);
                return;
            }

            /** @param {unknown} reply */
            function serializeReply(reply) {
                try {
                    const serialized = `${JSON.stringify(reply)  }\n`;
                    if (Buffer.byteLength(serialized, "utf8") > MAX_REPLY_BYTES) throw new RangeError("reply exceeds limit");
                    return serialized;
                } catch (_error) {
                    socket.destroyReason = "reply-serialization";
                    socket.finalizing = true;
                    clearDelayedFinalSocket(socket);
                    clearSocketTimers(socket);
                    if (typeof socket.destroy === "function" && !socket.destroyed) socket.destroy();
                    return null;
                }
            }

            const sendReply = /** @type {SendReply} */ function sendReply(error, result) {
                if (!socket.writable || socket.finalizing) return;
                const reply = { jsonrpc: "2.0", id: rpcId, error: error ? { code: -1, message: error } : null, result };
                if (rpcId === "Stratum") Object.assign(reply, {method: rpcMethod});
                const serializedReply = serializeReply(reply);
                if (serializedReply === null) return;
                if (debug.enabled) debug(`MINER: ${  formatPoolEvent("Reply", { body: reply })}`);
                if (socket.debugMiner) console.log(`${state.threadName  }WALLET DEBUG: ${  formatPoolEvent("Reply", { body: reply })}`);
                writeSocketPayload(socket, serializedReply);
            };
            const sendReplyFinal = /** @type {SendFinalReply} */ function sendReplyFinal(error, timeoutSeconds) {
                if (!socket.writable || socket.finalizing) return;
                socket.finalizing = true;
                clearSocketTimers(socket);
                const reply = { jsonrpc: "2.0", id: rpcId, error: { code: -1, message: error }, result: null };
                if (rpcId === "Stratum") Object.assign(reply, {method: rpcMethod});
                const serializedReply = serializeReply(reply);
                if (serializedReply === null) return;
                if (debug.enabled) debug(`MINER: ${  formatPoolEvent("Final reply", { body: reply })}`);
                if (socket.debugMiner) console.log(`${state.threadName  }WALLET DEBUG: ${  formatPoolEvent("Final reply", { body: reply })}`);
                const finishReply = function finishReply() {
                    clearDelayedFinalSocket(socket);
                    socket.finalReplyTimer = null;
                    if (!socket.writable) return;
                    socket.end(serializedReply);
                };
                if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
                    if (!registerDelayedFinalSocket(socket)) {
                        socket.destroyReason = "delayed-final-limit";
                        if (typeof socket.destroy === "function" && !socket.destroyed) socket.destroy();
                        return;
                    }
                    // Keep long-ban replies expensive for abusive reconnect loops while
                    // avoiding a single fixed delay that is easy to fingerprint.
                    const delayMs = Math.max(1000, Math.ceil(Math.random() * timeoutSeconds * 1000));
                    socket.finalReplyTimer = setTimeout(finishReply, delayMs);
                    return;
                }
                finishReply();
            };

            let logJson = "";
            if (debug.enabled || socket.debugMiner) logJson = JSON.stringify(sanitizeRequestForLog(request));
            if (debug.enabled) debug(`MINER: ${  formatPoolEvent("Request", { body: logJson })}`);
            handleMinerData(socket, rpcId, rpcMethod, request["params"], socket.normalizedRemoteAddress ?? "", portData, sendReply, sendReplyFinal, pushMessage, request);
            if (socket.debugMiner) console.log(`${state.threadName  }WALLET DEBUG: ${  formatPoolEvent("Request", { body: logJson })}`);
        }

        return /** @param {PoolSocket} socket */ function socketConn(socket) {
            const reservation = isTls ? takeTlsReservation(socket) : reserveConnection(socket);
            if (!reservation) {
                if (isTls) rejectConnection(socket, "tls-reservation-missing");
                return;
            }
            const securityConfig = getPoolSecurityConfig();
            const normalizedIp = reservation.normalizedIp;
            const subnet = reservation.subnet;
            socket.normalizedRemoteAddress = normalizedIp;
            socket.subnet24 = subnet;
            socket.setKeepAlive(true);
            socket.setEncoding("utf8");
            socket.lastSocketActivity = Date.now();
            socket.protocolErrorCount = 0;
            socket.finalizing = false;

            socket.authTimer = setTimeout(function onAuthTimeout() {
                if (!socket.miner_id) {
                    socket.destroyReason = "auth-timeout";
                    socket.destroy();
                }
            }, securityConfig.socketAuthTimeoutMs);

            let dataBuffer = "";
            let dataBufferBytes = 0;
            let largeFrame = false;
            let accountedLargeFrameBytes = 0;
            const largeFrameSource = socket.normalizedRemoteAddress ?? "unknown";
            function clearLargeFrameTimer() {
                if (!socket.largeFrameTimer) return;
                clearTimeout(socket.largeFrameTimer);
                socket.largeFrameTimer = null;
            }
            function releaseLargeFrameBuffer() {
                clearLargeFrameTimer();
                largeFrameBufferedBytes = Math.max(0, largeFrameBufferedBytes - accountedLargeFrameBytes);
                const sourceBytes = Math.max(0,
                    (largeFrameBufferedBytesBySource.get(largeFrameSource) || 0) - accountedLargeFrameBytes);
                if (sourceBytes === 0) largeFrameBufferedBytesBySource.delete(largeFrameSource);
                else largeFrameBufferedBytesBySource.set(largeFrameSource, sourceBytes);
                accountedLargeFrameBytes = 0;
            }
            /** @returns {boolean} */
            function accountLargeFrameBuffer() {
                const additionalBytes = dataBufferBytes - accountedLargeFrameBytes;
                if (additionalBytes <= 0) return true;
                const sourceBytes = largeFrameBufferedBytesBySource.get(largeFrameSource) || 0;
                if (additionalBytes > LARGE_FRAME_SOURCE_MAX_BYTES - sourceBytes ||
                    additionalBytes > LARGE_FRAME_BUFFERED_MAX_BYTES - largeFrameBufferedBytes) return false;
                largeFrameBufferedBytes += additionalBytes;
                largeFrameBufferedBytesBySource.set(largeFrameSource, sourceBytes + additionalBytes);
                accountedLargeFrameBytes = dataBufferBytes;
                return true;
            }
            function startLargeFrameTimer() {
                if (socket.largeFrameTimer) return;
                socket.largeFrameTimer = setTimeout(function onLargeFrameTimeout() {
                    socket.largeFrameTimer = null;
                    dataBuffer = "";
                    dataBufferBytes = 0;
                    releaseLargeFrameBuffer();
                    socket.destroyReason = "large frame timeout";
                    socket.destroy();
                }, LARGE_FRAME_TIMEOUT_MS);
            }
            let pushMessage = /** @type {PushMessage} */ function pushMessage(body) {
                if (!socket.writable || socket.finalizing) return;
                body["jsonrpc"] = "2.0";
                if (debug.enabled) debug(`MINER: ${  formatPoolEvent("Push", { body })}`);
                if (socket.debugMiner) console.log(`${state.threadName  }WALLET DEBUG: ${  formatPoolEvent("Push", { body })}`);
                writeSocketPayload(socket, `${JSON.stringify(body)  }\n`);
            };

            socket.on("data", function onData(chunk) {
                if (socket.finalizing) {
                    socket.destroy();
                    return;
                }
                touchSocketActivity(socket);
                const chunkText = typeof chunk === "string" ? chunk : String(chunk);
                dataBuffer += chunkText;
                dataBufferBytes += Buffer.byteLength(chunkText, "utf8");
                if (dataBufferBytes > STANDARD_PACKET_BYTES && !largeFrame) {
                    const miner = socket.miner_id ? state.activeMiners.get(socket.miner_id) : undefined;
                    largeFrame = hasPearlJob(miner) && isPearlSubmitPrefix(dataBuffer);
                }
                if (largeFrame && !accountLargeFrameBuffer()) {
                    dataBuffer = "";
                    dataBufferBytes = 0;
                    releaseLargeFrameBuffer();
                    socket.destroyReason = "large-frame-buffer-limit";
                    socket.destroy();
                    return;
                }
                if (largeFrame) startLargeFrameTimer();
                if (dataBufferBytes > (largeFrame ? LARGE_FRAME_MAX_BYTES : STANDARD_PACKET_BYTES)) {
                    dataBuffer = "";
                    dataBufferBytes = 0;
                    releaseLargeFrameBuffer();
                    console.warn(state.threadName + formatPoolEvent("Packet too large", { ip: socket.remoteAddress }));
                    socket.destroy();
                    return;
                }
                if (!chunkText.includes("\n")) return;

                const messages = dataBuffer.split("\n");
                const incomplete = dataBuffer.slice(-1) === "\n" ? "" : messages.pop() ?? "";
                for (const message of messages) {
                    if (message.trim() === "") continue;
                    try {
                        const request = JSON.parse(message);
                        if (Buffer.byteLength(message, "utf8") > STANDARD_PACKET_BYTES) {
                            const miner = socket.miner_id ? state.activeMiners.get(socket.miner_id) : undefined;
                            if (!hasPearlJob(miner) || !isPearlSubmitRequest(request)) throw new Error("invalid large request");
                        }
                        handleMessage(socket, request, pushMessage);
                        if (socket.finalizing) break;
                    } catch (_error) {
                        socket.protocolErrorCount = (socket.protocolErrorCount || 0) + 1;
                        socket.destroy();
                        break;
                    }
                }
                releaseLargeFrameBuffer();
                dataBuffer = incomplete;
                dataBufferBytes = Buffer.byteLength(incomplete, "utf8");
                largeFrame = false;
                if (dataBufferBytes > STANDARD_PACKET_BYTES) {
                    const miner = socket.miner_id ? state.activeMiners.get(socket.miner_id) : undefined;
                    largeFrame = hasPearlJob(miner) && isPearlSubmitPrefix(dataBuffer);
                    if (!largeFrame || dataBufferBytes > LARGE_FRAME_MAX_BYTES || !accountLargeFrameBuffer()) {
                        dataBuffer = "";
                        dataBufferBytes = 0;
                        releaseLargeFrameBuffer();
                        socket.destroy();
                    } else {
                        startLargeFrameTimer();
                    }
                }
            }).on("error", function noop() {
            }).on("close", function onClose() {
                releaseLargeFrameBuffer();
                clearDelayedFinalSocket(socket);
                clearSocketTimers(socket);
                reservation.release();
                pushMessage = function noopPush() {};
                if (socket.miner_id) removeMiner(state.activeMiners.get(socket.miner_id), { destroySocket: false });
                if (typeof socket.eth_extranonce_id === "number") state.freeEthExtranonces.push(socket.eth_extranonce_id);
                else if (typeof socket.eth_extranonce_preview_id === "number") state.freeEthExtranonces.push(socket.eth_extranonce_preview_id);
            });
        };
    }

    /** @param {import("../../types/runtime").PortConfig[]} portList */
    function startPortServers(portList) {
        const skipListenPorts = getSkipListenPorts();
        return Promise.all(portList.map(function startPortServer(portData) {
            return new Promise(/** @param {(server: import("node:net").Server | null) => void} resolve */ function createServer(resolve, reject) {
                if (portData.portType !== "pplns") {
                    resolve(null);
                    return;
                }
                if (!global.config.pplns || global.config.pplns.enable !== true) {
                    resolve(null);
                    return;
                }
                if (skipListenPorts.has(Number(portData.port))) {
                    console.log(state.threadName + formatPoolEvent("Listen skipped", {
                        service: "stratum",
                        port: portData.port,
                        reason: "configured-skip"
                    }));
                    resolve(null);
                    return;
                }

                const securityConfig = getPoolSecurityConfig();
                const socketConn = createPoolSocketHandler(portData, { tls: portData.ssl === true });
                const server = portData.ssl === true
                    ? tls.createServer({
                        key: fs.readFileSync("cert.key"),
                        cert: fs.readFileSync("cert.pem"),
                        handshakeTimeout: securityConfig.tlsHandshakeTimeoutMs
                    }, socketConn)
                    : net.createServer(socketConn);

                if (portData.ssl === true) {
                    const onTlsConnection = /** @param {PoolSocket} socket */ function onTlsConnection(socket) {
                        const tupleKey = getSocketTupleKey(socket);
                        if (!tupleKey) rejectConnection(socket, "tls-tuple-missing");
                        else reserveConnection(socket, tupleKey);
                    };
                    server.prependListener("connection", onTlsConnection);
                    server.on("tlsClientError", /** @param {unknown} _error @param {PoolSocket} socket */ function onTlsClientError(_error, socket) {
                        const reservation = takeTlsReservation(socket);
                        if (reservation) reservation.release();
                        rejectConnection(socket, "tls-handshake-error");
                    });
                }

                server.once("error", reject);
                server.listen(portData.port, global.config.bind_ip, function onListen() {
                    server.removeListener("error", reject);
                    server.on("error", function onServerError(serverError) {
                        console.error(state.threadName + formatPoolEvent("Stratum bind failed", {
                            port: portData.port,
                            ssl: portData.ssl === true,
                            error: serverError && serverError.message ? serverError.message : String(serverError)
                        }));
                    });
                    console.log(state.threadName + formatPoolEvent("Listen", {
                        service: "stratum",
                        port: portData.port,
                        ssl: portData.ssl === true
                    }));
                    resolve(server);
                });
            });
        })).then(function stripNullServers(servers) {
            return servers.filter(server => server !== null);
        });
    }

    return {
        createPoolSocketHandler,
        startPortServers
    };
};

module.exports.normalizeSkipListenPorts = normalizeSkipListenPorts;
module.exports.isPearlSubmitPrefix = isPearlSubmitPrefix;
module.exports.hasPearlJob = hasPearlJob;
module.exports.sanitizeRequestForLog = sanitizeRequestForLog;
module.exports.LARGE_FRAME_TIMEOUT_MS = LARGE_FRAME_TIMEOUT_MS;
