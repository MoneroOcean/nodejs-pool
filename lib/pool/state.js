"use strict";
const fs = require("fs");
const path = require("path");
const { formatLogFields, formatLogEvent, formatLogValue, formatThreadName } = require("../common/logging.js");
const {
    fromBuffer: bigIntFromBuffer,
    toBigInt,
    toBuffer: bigIntToBuffer
} = require("../coins/helpers.js");

/** @typedef {import("../../types/runtime").BlockTemplateRecord} BlockTemplateRecord */
/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */

/** @typedef {{maxAgeMs: number, maxEntries: number, pruneIntervalMs: number, pruneAfterAdds: number}} TimedEntryOptions */
/** @typedef {{maxAgeMs?: number, maxEntries?: number, pruneIntervalMs?: number, pruneAfterAdds?: number}} TimedEntryOptionsInput */
/** @typedef {{lastPruneAt: number, newEntriesSincePrune: number}} TimedEntryMetadata */
/** @typedef {{current: number|undefined, previous: number|undefined}} AnchorState */
/** @typedef {{totalShares: number, trustedShares: number, normalShares: number, invalidShares: number, outdatedShares: number, throttledShares: number}} ShareStats */
/** @typedef {{markerPath: string, enabled: boolean, lastCheckAt: number}} BlockSubmitTestMode */
/** @typedef {{last_ver_shares: number, hashes: number, connectTime: number, count: number, submissionBudget: boolean}} MinerWalletState */
/** @typedef {{tokens: number, lastRefillAt: number}} RateBucket */
/** @typedef {Record<string, number>} NumberMap */
/** @typedef {Record<string, string>} StringMap */
/** @typedef {Record<string, BlockTemplateRecord>} TemplateMap */

/**
 * @typedef {object} PoolState
 * @property {RegExp} nonceCheck32
 * @property {RegExp} nonceCheck64
 * @property {RegExp} hashCheck32
 * @property {RegExp} hexMatch
 * @property {RegExp} localhostCheck
 * @property {number} blockNotifyPort
 * @property {number} daemonPollMs
 * @property {Map<string, unknown>} activeMiners
 * @property {Map<string, unknown>} activeMinersByPayout
 * @property {Map<string, unknown>} activeMinerSockets
 * @property {TemplateMap} activeBlockTemplates
 * @property {Record<string, {enq: (value: BlockTemplateRecord) => void}>} pastBlockTemplates
 * @property {NumberMap} bannedTmpIPs
 * @property {NumberMap} bannedTmpWallets
 * @property {NumberMap} bannedBigTmpWallets
 * @property {StringMap} bannedAddresses
 * @property {NumberMap} notifyAddresses
 * @property {Record<string, MinerWalletState>} minerWallets
 * @property {Record<string, MinerWalletState>} proxyMiners
 * @property {Record<string, {trust: number, check_height: number}>} walletTrust
 * @property {NumberMap} walletLastSeeTime
 * @property {NumberMap} walletLastCheckTime
 * @property {StringMap} minerAgents
 * @property {NumberMap} walletDebug
 * @property {NumberMap} ipWhitelist
 * @property {NumberMap} lastMinerLogTime
 * @property {NumberMap} lastMinerNotifyTime
 * @property {Record<string, unknown>} protocolWarningState
 * @property {StringMap} lastBlockHash
 * @property {NumberMap} lastBlockHeight
 * @property {StringMap} lastBlockHashMM
 * @property {NumberMap} lastBlockHeightMM
 * @property {NumberMap} lastBlockTime
 * @property {NumberMap} lastBlockKeepTime
 * @property {NumberMap} lastBlockReward
 * @property {NumberMap} newCoinHashFactor
 * @property {NumberMap} lastCoinHashFactor
 * @property {NumberMap} lastCoinHashFactorMM
 * @property {NumberMap} lastBlockLagStartTime
 * @property {NumberMap} lastBlockFixTime
 * @property {NumberMap} daemonFailureSince
 * @property {AnchorState} anchorState
 * @property {ShareStats} shareStats
 * @property {NumberMap} activeConnectionsByIP
 * @property {NumberMap} activeConnectionsBySubnet
 * @property {Map<string, RateBucket>} rpcRateBuckets
 * @property {number[][]} minerCount
 * @property {number[]} freeEthExtranonces
 * @property {number} lastEthExtranonceOverflowNoticeAt
 * @property {BlockSubmitTestMode} blockSubmitTestMode
 * @property {string|undefined} threadName
 * @property {boolean} threadContextInitialized
 * @property {NodeJS.Timeout|null} threadResetInterval
 * @property {NodeJS.Timeout|null} threadStatsInterval
 * @property {number} decId
 * @property {number} ethJobId
 */

module.exports = function createPoolState() {
    const BLOCK_SUBMIT_TEST_MODE_CHECK_MS = 5 * 1000;
    const BLOCK_SUBMIT_TEST_MARKER_FILENAME = ".pool-live-block-submit-test";
    const nonceCheck32 = /^[0-9a-f]{8}$/;
    const nonceCheck64 = /^[0-9a-f]{16}$/;
    const hashCheck32 = /^[0-9a-f]{64}$/;
    const hexMatch = /^(?:[0-9a-f][0-9a-f])+$/;
    const localhostCheck = /127\.0\.0\.1$/;

    const state = {
        nonceCheck32,
        nonceCheck64,
        hashCheck32,
        hexMatch,
        localhostCheck,
        blockNotifyPort: 2223,
        daemonPollMs: 500,
        activeMiners: new Map(),
        activeMinersByPayout: new Map(),
        activeMinerSockets: new Map(),
        activeBlockTemplates: /** @type {TemplateMap} */ ({}),
        pastBlockTemplates: /** @type {Record<string, {enq: (value: BlockTemplateRecord) => void}>} */ ({}),
        bannedTmpIPs: /** @type {NumberMap} */ ({}),
        bannedTmpWallets: /** @type {NumberMap} */ ({}),
        bannedBigTmpWallets: /** @type {NumberMap} */ ({}),
        bannedAddresses: /** @type {Record<string, unknown>} */ ({}),
        notifyAddresses: /** @type {Record<string, unknown>} */ ({}),
        minerWallets: /** @type {Record<string, MinerWalletState>} */ ({}),
        proxyMiners: /** @type {Record<string, MinerWalletState>} */ ({}),
        walletTrust: /** @type {NumberMap} */ ({}),
        walletLastSeeTime: /** @type {NumberMap} */ ({}),
        walletLastCheckTime: /** @type {NumberMap} */ ({}),
        minerAgents: /** @type {NumberMap} */ ({}),
        walletDebug: /** @type {Record<string, unknown>} */ ({}),
        ipWhitelist: /** @type {Record<string, unknown>} */ ({}),
        lastMinerLogTime: /** @type {NumberMap} */ ({}),
        lastMinerNotifyTime: /** @type {NumberMap} */ ({}),
        protocolWarningState: /** @type {Record<string, unknown>} */ (Object.create(null)),
        lastBlockHash: /** @type {StringMap} */ ({}),
        lastBlockHeight: /** @type {NumberMap} */ ({}),
        lastBlockHashMM: /** @type {StringMap} */ ({}),
        lastBlockHeightMM: /** @type {NumberMap} */ ({}),
        lastBlockTime: /** @type {NumberMap} */ ({}),
        lastBlockKeepTime: /** @type {NumberMap} */ ({}),
        lastBlockReward: /** @type {NumberMap} */ ({}),
        newCoinHashFactor: /** @type {NumberMap} */ ({}),
        lastCoinHashFactor: /** @type {NumberMap} */ ({}),
        lastCoinHashFactorMM: /** @type {NumberMap} */ ({}),
        lastBlockLagStartTime: /** @type {NumberMap} */ ({}),
        lastBlockFixTime: /** @type {NumberMap} */ ({}),
        daemonFailureSince: /** @type {NumberMap} */ ({}),
        anchorState: { current: undefined, previous: undefined },
        shareStats: {
            totalShares: 0,
            trustedShares: 0,
            normalShares: 0,
            invalidShares: 0,
            outdatedShares: 0,
            throttledShares: 0
        },
        activeConnectionsByIP: /** @type {NumberMap} */ ({}),
        activeConnectionsBySubnet: /** @type {NumberMap} */ ({}),
        rpcRateBuckets: /** @type {Map<string, RateBucket>} */ (new Map()),
        minerCount: /** @type {number[][]} */ ([]),
        freeEthExtranonces: /** @type {number[]} */ ([]),
        lastEthExtranonceOverflowNoticeAt: 0,
        blockSubmitTestMode: {
            markerPath: path.join(process.cwd(), BLOCK_SUBMIT_TEST_MARKER_FILENAME),
            enabled: false,
            lastCheckAt: 0
        },
        threadName: /** @type {string|undefined} */ (undefined),
        threadContextInitialized: false,
        threadResetInterval: /** @type {NodeJS.Timeout|null} */ (null),
        threadStatsInterval: /** @type {NodeJS.Timeout|null} */ (null),
        decId: 0,
        ethJobId: 0
    };

    const retention = {
        minerAgents: {
            maxAgeMs: 24 * 60 * 60 * 1000,
            maxEntries: 2048,
            maxKeyLength: 255,
            pruneIntervalMs: 10 * 60 * 1000,
            pruneAfterAdds: 32
        },
        minerLog: {
            maxAgeMs: 6 * 60 * 60 * 1000,
            maxEntries: 50000,
            pruneIntervalMs: 10 * 60 * 1000,
            pruneAfterAdds: 256
        },
        minerNotify: {
            maxAgeMs: 24 * 60 * 60 * 1000,
            maxEntries: 50000,
            pruneIntervalMs: 10 * 60 * 1000,
            pruneAfterAdds: 256
        },
        walletCheck: {
            maxAgeMs: 24 * 60 * 60 * 1000,
            maxEntries: 50000,
            pruneIntervalMs: 10 * 60 * 1000,
            pruneAfterAdds: 256
        }
    };
    /** @type {WeakMap<NumberMap, TimedEntryMetadata>} */
    const timedEntryMetadata = new WeakMap();

    Buffer.prototype.toByteArray = function toByteArray() {
        return Array.prototype.slice.call(this, 0);
    };

    /** @param {object} target @returns {void} */
    function clearObject(target) {
        for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
    }

    /** @param {NumberMap} target @returns {TimedEntryMetadata} */
    function getTimedEntryMetadata(target) {
        let metadata = timedEntryMetadata.get(target);
        if (!metadata) {
            metadata = {
                lastPruneAt: 0,
                newEntriesSincePrune: 0
            };
            timedEntryMetadata.set(target, metadata);
        }
        return metadata;
    }

    /** @param {NumberMap} target @returns {void} */
    function resetTimedEntryMetadata(target) {
        timedEntryMetadata.set(target, {
            lastPruneAt: 0,
            newEntriesSincePrune: 0
        });
    }

    /**
     * @param {NumberMap} target
     * @param {number|undefined} now
     * @param {TimedEntryOptionsInput|undefined} options
     * @returns {void}
     */
    function pruneTimedEntries(target, now, options) {
        const timeNow = typeof now === "number" ? now : Date.now();
        const maxAgeMs = options && typeof options.maxAgeMs === "number" ? options.maxAgeMs : null;
        const maxEntries = options && typeof options.maxEntries === "number" ? options.maxEntries : null;
        const metadata = getTimedEntryMetadata(target);

        if (maxAgeMs !== null) {
            for (const key of Object.keys(target)) {
                const value = target[key];
                if (typeof value !== "number" || timeNow - value > maxAgeMs) delete target[key];
            }
        }

        if (maxEntries !== null) {
            const keys = Object.keys(target);
            if (keys.length > maxEntries) {
                keys.sort(function compareTimedKeys(left, right) {
                    return (target[left] || 0) - (target[right] || 0);
                });
                for (let index = 0; index < keys.length - maxEntries; ++index) {
                    const key = keys[index];
                    if (key !== undefined) delete target[key];
                }
            }
        }

        metadata.lastPruneAt = timeNow;
        metadata.newEntriesSincePrune = 0;
    }

    /**
     * @param {NumberMap} target
     * @param {string} key
     * @param {number|undefined} now
     * @param {TimedEntryOptionsInput|undefined} options
     * @returns {void}
     */
    function touchTimedEntry(target, key, now, options) {
        const timeNow = typeof now === "number" ? now : Date.now();
        const metadata = getTimedEntryMetadata(target);
        const hadKey = Object.prototype.hasOwnProperty.call(target, key);
        target[key] = timeNow;
        if (!hadKey) ++metadata.newEntriesSincePrune;

        const pruneIntervalMs = options && typeof options.pruneIntervalMs === "number" ? options.pruneIntervalMs : 0;
        const pruneAfterAdds = options && typeof options.pruneAfterAdds === "number" ? options.pruneAfterAdds : 0;
        const shouldPruneByTime = metadata.lastPruneAt === 0 || (pruneIntervalMs > 0 && timeNow - metadata.lastPruneAt >= pruneIntervalMs);
        const shouldPruneByAdds = pruneAfterAdds > 0 && metadata.newEntriesSincePrune >= pruneAfterAdds;

        if (shouldPruneByTime || shouldPruneByAdds) pruneTimedEntries(target, timeNow, options);
    }

    /** @param {string} str @param {number} bytes @returns {string} */
    function padHex(str, bytes) {
        // Left-pad a hex string to a fixed width of `bytes` (2 hex chars per byte),
        // keeping only the leading hexLength chars if the input already exceeds it.
        const hexLength = bytes * 2;
        return ("00".repeat(bytes) + str.substr(0, hexLength)).substr(-hexLength);
    }

    /** @param {number|string|bigint|Buffer} value @returns {bigint} */
    function toStateBigInt(value) {
        const converted = toBigInt(value);
        if (typeof converted !== "bigint") throw new Error("Expected bigint conversion result");
        return converted;
    }

    /** @param {string} methodName @returns {number} */
    function callCoinNumber(methodName) {
        const method = global.coinFuncs[methodName];
        if (typeof method !== "function") throw new Error(`coinFuncs.${  methodName} is unavailable`);
        const value = method();
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`coinFuncs.${  methodName} returned an invalid value`);
        return value;
    }

    /** @param {string} propertyName @returns {number} */
    function getCoinNumber(propertyName) {
        const value = global.coinFuncs[propertyName];
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`coinFuncs.${  propertyName} is unavailable`);
        return value;
    }

    /** @param {number|string|bigint|Buffer} diff @returns {bigint} */
    function divideBaseDiff(diff) {
        const baseDiff = toStateBigInt(callCoinNumber("baseDiff"));
        const divisor = toStateBigInt(diff);
        // Buggy miners can submit an all-zero result hash. Treat that as zero
        // difficulty so trusted-share accounting cannot credit forged work,
        // while still avoiding a division-by-zero crash in the verifier.
        if (divisor === 0n) return 0n;
        return baseDiff / divisor;
    }

    /** @param {number|string|bigint|Buffer} diff @param {number} size @returns {bigint} */
    function sizedTargetValue(diff, size) {
        return ((1n << BigInt(size * 8)) - 1n) / toBigInt(diff);
    }

    /** @param {number} diff @returns {string} */
    function ravenTargetHex(diff) {
        return padHex((callCoinNumber("baseRavenDiff") / Number(diff)).toString(16), 32);
    }

    /** @returns {string} */
    function getNewId() {
        if (++state.decId > 999999999999999) state.decId = 0;
        return state.decId.toString(10);
    }

    /** @returns {string} */
    function getNewEthJobId() {
        if (++state.ethJobId > 0xffff) state.ethJobId = 0;
        return padHex(state.ethJobId.toString(16), 2);
    }

    /** @returns {number|null} */
    function getNewEthExtranonceId() {
        if (!state.freeEthExtranonces.length) {
            const errStr = `${state.threadName  }Pool server ${  global.config.hostname  } has overflow extranonce of ${  16 - getCoinNumber("uniqueWorkerIdBits")  } bits`;
            const timeNow = Date.now();
            const configuredCooldown = global.config && global.config.pool ? global.config.pool["ethExtranonceOverflowNotifyCooldown"] : undefined;
            const cooldownSeconds = typeof configuredCooldown === "number" && Number.isFinite(configuredCooldown)
                ? configuredCooldown
                : 600;
            const cooldownMs = Math.max(0, cooldownSeconds * 1000);
            if (state.lastEthExtranonceOverflowNoticeAt === 0 || timeNow - state.lastEthExtranonceOverflowNoticeAt >= cooldownMs) {
                state.lastEthExtranonceOverflowNoticeAt = timeNow;
                console.error(errStr);
                if (global.support && typeof global.support.sendAdminFyi === "function") {
                    /** @type {(key: string, subject: string, body: string, options?: {cooldownMs: number}) => void} */
                    const sendAdminFyi = global.support.sendAdminFyi;
                    sendAdminFyi("pool:eth-extranonce-overflow", "FYI: Pool node has extranonce overflow", errStr, { cooldownMs });
                }
            }
            return null;
        }
        const extranonceId = state.freeEthExtranonces.pop();
        return typeof extranonceId === "number" ? extranonceId : null;
    }

    /** @param {number|null} id @returns {string|null} */
    function ethExtranonce(id) {
        if (id === null) return null;
        return padHex(((id << getCoinNumber("uniqueWorkerIdBits")) + getCoinNumber("uniqueWorkerId")).toString(16), 2);
    }

    function getBlockSubmitTestModeState() {
        return {
            markerPath: state.blockSubmitTestMode.markerPath,
            enabled: state.blockSubmitTestMode.enabled,
            lastCheckAt: state.blockSubmitTestMode.lastCheckAt
        };
    }

    function refreshBlockSubmitTestMode() {
        const timeNow = Date.now();
        const modeState = state.blockSubmitTestMode;
        if (modeState.lastCheckAt !== 0 && timeNow - modeState.lastCheckAt < BLOCK_SUBMIT_TEST_MODE_CHECK_MS) {
            return modeState.enabled;
        }

        modeState.lastCheckAt = timeNow;
        let nextEnabled = false;
        try {
            nextEnabled = fs.existsSync(modeState.markerPath);
        } catch (_error) {
            nextEnabled = false;
        }

        if (nextEnabled !== modeState.enabled && state.threadName) {
            console.error(state.threadName + formatPoolEvent("Block submit test mode", {
                enabled: nextEnabled ? 1 : 0,
                marker: path.basename(modeState.markerPath)
            }));
        }

        modeState.enabled = nextEnabled;
        return modeState.enabled;
    }

    function clearBlockSubmitTestMarker() {
        const modeState = state.blockSubmitTestMode;
        try {
            fs.rmSync(modeState.markerPath, { force: true });
        } catch (_error) {
            // Ignore stale-marker cleanup failures here; startup should not
            // fail just because a previous test left no file behind.
        }
        modeState.enabled = false;
        modeState.lastCheckAt = 0;
    }

    /** @param {number|string|bigint|Buffer} diff @param {number} size @returns {string} */
    function getTargetHex(diff, size) {
        return padHex(bigIntToBuffer(sizedTargetValue(diff, size), { endian: "little", size }).toString("hex"), size);
    }

    /** @param {unknown} message @param {(value: unknown) => unknown} messageHandler @returns {unknown} */
    function processSend(message, messageHandler) {
        if (Reflect.get(global, "__poolTestMode") === true) return messageHandler(message);
        if (typeof process.send === "function") return process.send(message);
        return messageHandler(message);
    }

    /** @param {string|undefined} coin @param {number|string|undefined|null} port @returns {number|string|undefined} */
    function resolveCoinPort(coin, port) {
        if (typeof port !== "undefined" && port !== null && port !== "") return port;
        if (global.coinFuncs && typeof global.coinFuncs.COIN2PORT === "function" && typeof coin !== "undefined") {
            const mappedPort = global.coinFuncs.COIN2PORT(coin);
            if (typeof mappedPort !== "undefined") return mappedPort;
        }
        if (coin === "" && global.config && global.config.daemon && typeof global.config.daemon.port !== "undefined") {
            return global.config.daemon.port;
        }
        return undefined;
    }

    /** @param {string|undefined} coin @param {number|string|undefined} port @returns {string} */
    function resolveCoinDisplay(coin, port) {
        if (global.coinFuncs && typeof port !== "undefined") {
            const displayCoin = callCoinDisplay("PORT2COIN_FULL", port) || callCoinDisplay("PORT2COIN", port);
            if (displayCoin) return displayCoin;
        }
        if (typeof coin === "string" && coin.length) return coin;
        if (coin === "" && global.coinFuncs && global.config && global.config.daemon && typeof global.config.daemon.port !== "undefined") {
            const mainCoin = callCoinDisplay("PORT2COIN_FULL", global.config.daemon.port);
            if (mainCoin) return mainCoin;
        }
        return "PORT";
    }

    /** @param {string} method @param {number|string} port @returns {string|null} */
    function callCoinDisplay(method, port) {
        const displayMethod = global.coinFuncs[method];
        if (typeof displayMethod !== "function") return null;
        // Coin display helpers may consult sibling methods through `this`.
        // Preserve the runtime object when invoking a dynamically selected helper.
        const coin = displayMethod.call(global.coinFuncs, port);
        return typeof coin === "string" && coin.length ? coin : null;
    }

    /** @param {string|undefined} coin @param {number|string|undefined} port @returns {string} */
    function formatCoinPort(coin, port) {
        const resolvedPort = resolveCoinPort(coin, port);
        const resolvedCoin = resolveCoinDisplay(coin, resolvedPort);
        if (typeof resolvedPort === "undefined") return resolvedCoin;
        return `${resolvedCoin  }/${  resolvedPort}`;
    }

    /** @param {string} label @param {Record<string, unknown>|undefined} fields @returns {string} */
    function formatPoolEvent(label, fields) { return formatLogEvent(label, fields); }

    /**
     * @param {boolean} isMaster
     * @param {string|number|undefined} workerId
     * @param {{threadName?: string, enableStats?: boolean, enableShareWindowReset?: boolean}|undefined} options
     * @returns {void}
     */
    function initThreadContext(isMaster, workerId, options) {
        if (state.threadContextInitialized) return;
        state.threadContextInitialized = true;
        const opts = options || {};

        if (isMaster) {
            state.threadName = opts.threadName || formatThreadName({ primary: true });
            if (opts.enableStats !== false) {
                state.threadStatsInterval = setInterval(function dumpShareStats() {
                    const shareStats = state.shareStats;
                    const trustedSharesPercent = (shareStats.totalShares ? shareStats.trustedShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const normalSharesPercent = (shareStats.totalShares ? shareStats.normalShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const invalidSharesPercent = (shareStats.totalShares ? shareStats.invalidShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const outdatedSharesPercent = (shareStats.totalShares ? shareStats.outdatedShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const throttledSharesPercent = (shareStats.totalShares ? shareStats.throttledShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    console.log(`${state.threadName  }IMPORTANT: ${  formatPoolEvent("Summary", {
                        total: shareStats.totalShares,
                        trusted: `${shareStats.trustedShares}(${trustedSharesPercent}%)`,
                        validated: `${shareStats.normalShares}(${normalSharesPercent}%)`,
                        invalid: `${shareStats.invalidShares}(${invalidSharesPercent}%)`,
                        outdated: `${shareStats.outdatedShares}(${outdatedSharesPercent}%)`,
                        throttled: `${shareStats.throttledShares}(${throttledSharesPercent}%)`
                    })}`);
                    shareStats.totalShares = 0;
                    shareStats.trustedShares = 0;
                    shareStats.normalShares = 0;
                    shareStats.invalidShares = 0;
                    shareStats.outdatedShares = 0;
                    shareStats.throttledShares = 0;
                }, 30 * 1000);
            }
        } else {
            const resolvedWorkerId = typeof workerId !== "undefined" ? workerId : process.env["WORKER_ID"];
            state.threadName = opts.threadName || (typeof resolvedWorkerId === "undefined"
                ? formatThreadName({ pid: process.pid })
                : formatThreadName({ workerId: resolvedWorkerId, pid: process.pid }));
            if (opts.enableShareWindowReset !== false) {
                state.threadResetInterval = setInterval(function resetVerifiedShareWindow() {
                    for (const wallet in state.minerWallets) {
                        const minerWallet = state.minerWallets[wallet];
                        if (minerWallet) minerWallet.last_ver_shares = 0;
                    }
                }, Number(global.config.pool["minerThrottleShareWindow"] || 0) * 1000);
            }
        }

        global.database.thread_id = state.threadName || "";
    }

    function resetRuntimeState() {
        if (state.threadResetInterval !== null) clearInterval(state.threadResetInterval);
        if (state.threadStatsInterval !== null) clearInterval(state.threadStatsInterval);
        state.threadResetInterval = null;
        state.threadStatsInterval = null;
        state.threadContextInitialized = false;
        state.threadName = undefined;

        state.activeMiners.clear();
        state.activeMinersByPayout.clear();
        state.activeMinerSockets.clear();
        clearObject(state.activeBlockTemplates);
        clearObject(state.pastBlockTemplates);
        clearObject(state.bannedTmpIPs);
        clearObject(state.bannedTmpWallets);
        clearObject(state.bannedBigTmpWallets);
        clearObject(state.bannedAddresses);
        clearObject(state.notifyAddresses);
        clearObject(state.minerWallets);
        clearObject(state.proxyMiners);
        clearObject(state.walletTrust);
        clearObject(state.walletLastSeeTime);
        clearObject(state.walletLastCheckTime);
        resetTimedEntryMetadata(state.walletLastCheckTime);
        clearObject(state.minerAgents);
        resetTimedEntryMetadata(state.minerAgents);
        clearObject(state.walletDebug);
        clearObject(state.ipWhitelist);
        clearObject(state.lastMinerLogTime);
        resetTimedEntryMetadata(state.lastMinerLogTime);
        clearObject(state.lastMinerNotifyTime);
        resetTimedEntryMetadata(state.lastMinerNotifyTime);
        clearObject(state.protocolWarningState);
        clearObject(state.lastBlockHash);
        clearObject(state.lastBlockHeight);
        clearObject(state.lastBlockHashMM);
        clearObject(state.lastBlockHeightMM);
        clearObject(state.lastBlockTime);
        clearObject(state.lastBlockKeepTime);
        clearObject(state.lastBlockReward);
        clearObject(state.newCoinHashFactor);
        clearObject(state.lastCoinHashFactor);
        clearObject(state.lastCoinHashFactorMM);
        clearObject(state.lastBlockLagStartTime);
        clearObject(state.lastBlockFixTime);
        clearObject(state.daemonFailureSince);
        state.anchorState.current = undefined;
        state.anchorState.previous = undefined;
        state.shareStats.totalShares = 0;
        state.shareStats.trustedShares = 0;
        state.shareStats.normalShares = 0;
        state.shareStats.invalidShares = 0;
        state.shareStats.outdatedShares = 0;
        state.shareStats.throttledShares = 0;
        clearObject(state.activeConnectionsByIP);
        clearObject(state.activeConnectionsBySubnet);
        state.rpcRateBuckets.clear();
        state.minerCount.length = 0;
        state.freeEthExtranonces.length = 0;
        state.lastEthExtranonceOverflowNoticeAt = 0;
        state.blockSubmitTestMode.markerPath = path.join(process.cwd(), BLOCK_SUBMIT_TEST_MARKER_FILENAME);
        state.blockSubmitTestMode.enabled = false;
        state.blockSubmitTestMode.lastCheckAt = 0;
        state.decId = 0;
        state.ethJobId = 0;
    }

    return {
        state,
        retention,
        clearObject,
        pruneTimedEntries,
        touchTimedEntry,
        padHex,
        toBigInt,
        bigIntFromBuffer,
        bigIntToBuffer,
        divideBaseDiff,
        ravenTargetHex,
        getNewId,
        getNewEthJobId,
        getNewEthExtranonceId,
        ethExtranonce,
        BLOCK_SUBMIT_TEST_MODE_CHECK_MS,
        BLOCK_SUBMIT_TEST_MARKER_FILENAME,
        getBlockSubmitTestModeState,
        refreshBlockSubmitTestMode,
        clearBlockSubmitTestMarker,
        getTargetHex,
        formatCoinPort,
        formatLogValue,
        formatLogFields,
        formatPoolEvent,
        processSend,
        initThreadContext,
        resetRuntimeState
    };
};
