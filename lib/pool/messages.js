"use strict";

/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */

/**
 * @typedef {"trustedShare"|"normalShare"|"invalidShare"|"outdatedShare"|"throttledShare"} ShareStatType
 */
/** @typedef {"trustedShares"|"normalShares"|"invalidShares"|"outdatedShares"|"throttledShares"} ShareStatKey */

/**
 * @typedef {object} MessageState
 * @property {{totalShares: number, trustedShares: number, normalShares: number, invalidShares: number, outdatedShares: number, throttledShares: number}} shareStats
 * @property {RegExp} localhostCheck
 * @property {Record<string, number>} bannedTmpIPs
 * @property {Record<string, number>} bannedTmpWallets
 * @property {number[][]} minerCount
 * @property {string} threadName
 */

/**
 * @typedef {object} MessageCluster
 * @property {boolean} isMaster
 */

/** @typedef {{type: ShareStatType}} ShareStatMessage */
/** @typedef {{type: "banIP", data: string, wallet?: string}} BanMessage */
/** @typedef {ProtoMessage & {coin: string, port?: number}} TemplateData */
/** @typedef {{coin: string, coinHashFactor: number}} HashFactorData */
/** @typedef {{worker_id: number, ports: number[]}} MinerPortData */
/** @typedef {{type: "newBlockTemplate", data: TemplateData}} TemplateMessage */
/** @typedef {{type: "newCoinHashFactor", data: HashFactorData}} HashFactorMessage */
/** @typedef {{type: "minerPortCount", data: MinerPortData}} MinerPortMessage */
/** @typedef {{type: "sendRemote", body: string}} RemoteMessage */
/** @typedef {ShareStatMessage|BanMessage|TemplateMessage|HashFactorMessage|MinerPortMessage|RemoteMessage} PoolMessage */

/**
 * @typedef {object} MessageDependencies
 * @property {MessageCluster} cluster
 * @property {(message: string) => void} debug
 * @property {MessageState} state
 * @property {(message: PoolMessage) => void} sendToWorkers
 * @property {(template: ProtoMessage) => void} setNewBlockTemplate
 * @property {(isHashFactorChange: boolean, coin: string, coinHashFactor: number) => void} setNewCoinHashFactor
 * @property {(coin: string, port?: number) => string} formatCoinPort
 * @property {(label: string, fields?: Record<string, unknown>) => string} [formatPoolEvent]
 */

/**
 * @param {unknown} value
 * @returns {value is {type: string, data?: unknown, wallet?: unknown, body?: unknown}}
 */
function isMessageObject(value) {
    if (value === null || typeof value !== "object") return false;
    const typeValue = Object.getOwnPropertyDescriptor(value, "type");
    return Boolean(typeValue) && typeof typeValue.value === "string";
}

/** @param {unknown} value @returns {value is TemplateData} */
function isTemplateData(value) {
    if (value === null || typeof value !== "object") return false;
    const coin = Object.getOwnPropertyDescriptor(value, "coin");
    return Boolean(coin) && typeof coin.value === "string";
}

/** @param {unknown} value @returns {value is HashFactorData} */
function isHashFactorData(value) {
    if (value === null || typeof value !== "object") return false;
    const coin = Object.getOwnPropertyDescriptor(value, "coin");
    const factor = Object.getOwnPropertyDescriptor(value, "coinHashFactor");
    return Boolean(coin) && typeof coin.value === "string" && Boolean(factor) && typeof factor.value === "number";
}

/** @param {unknown} value @returns {value is MinerPortData} */
function isMinerPortData(value) {
    if (value === null || typeof value !== "object") return false;
    const workerId = Object.getOwnPropertyDescriptor(value, "worker_id");
    const ports = Object.getOwnPropertyDescriptor(value, "ports");
    return Boolean(workerId) && typeof workerId.value === "number" && Boolean(ports) && Array.isArray(ports.value);
}

/** @param {unknown} value @returns {value is PoolMessage} */
function isPoolMessage(value) {
    if (!isMessageObject(value)) return false;
    switch (value.type) {
    case "trustedShare":
    case "normalShare":
    case "invalidShare":
    case "outdatedShare":
    case "throttledShare":
        return true;
    case "banIP":
        return typeof value.data === "string" && (typeof value.wallet === "undefined" || typeof value.wallet === "string");
    case "newBlockTemplate":
        return isTemplateData(value.data);
    case "newCoinHashFactor":
        return isHashFactorData(value.data);
    case "minerPortCount":
        return isMinerPortData(value.data);
    case "sendRemote":
        return typeof value.body === "string";
    default:
        return false;
    }
}

/** @param {string} value @returns {value is ShareStatType} */
function isShareStatType(value) {
    return value === "trustedShare" || value === "normalShare" || value === "invalidShare" ||
        value === "outdatedShare" || value === "throttledShare";
}

/**
 * @param {MessageDependencies} deps
 * @returns {(message: unknown) => void}
 */
module.exports = function createMessageHandler(deps) {
    const {
        cluster,
        debug,
        state,
        sendToWorkers,
        setNewBlockTemplate,
        setNewCoinHashFactor,
        formatCoinPort,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;
    /** @type {Record<ShareStatType, ShareStatKey>} */
    const shareStatMap = {
        trustedShare: "trustedShares",
        normalShare: "normalShares",
        invalidShare: "invalidShares",
        outdatedShare: "outdatedShares",
        throttledShare: "throttledShares"
    };

    return function messageHandler(message) {
        if (!isPoolMessage(message)) return;
        if (isShareStatType(message.type)) {
            const shareStat = shareStatMap[message.type];
            ++state.shareStats[shareStat];
            // outdatedShare rides alongside a trusted/normal share (sent when the share's template is stale),
            // so it must not bump totalShares again or accepted shares would be double-counted.
            if (shareStat !== "outdatedShares") ++state.shareStats.totalShares;
            return;
        }

        switch (message.type) {
        case "banIP":
            debug(state.threadName + formatPoolEvent("Ban update", { source: "cluster" }));
            if (cluster.isMaster) {
                sendToWorkers(message);
            } else if (!state.localhostCheck.test(message.data)) {
                state.bannedTmpIPs[message.data] = 1;
            } else if (message.wallet) {
                state.bannedTmpWallets[message.wallet] = 1;
            }
            break;
        case "newBlockTemplate":
            debug(state.threadName + formatPoolEvent("Template message", {
                chain: formatCoinPort(message.data.coin, message.data.port)
            }));
            setNewBlockTemplate(message.data);
            break;
        case "newCoinHashFactor":
            debug(state.threadName + formatPoolEvent("Hash factor message", {
                chain: formatCoinPort(message.data.coin)
            }));
            setNewCoinHashFactor(true, message.data.coin, message.data.coinHashFactor);
            break;
        case "minerPortCount":
            if (cluster.isMaster) state.minerCount[message.data.worker_id] = message.data.ports;
            break;
        case "sendRemote":
            if (cluster.isMaster) global.database.sendQueue.push({ body: Buffer.from(message.body, "hex") });
            break;
        }
    };
};
