"use strict";

module.exports = function createPoolState() {
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
        activeBlockTemplates: {},
        pastBlockTemplates: {},
        bannedTmpIPs: {},
        bannedTmpWallets: {},
        bannedBigTmpWallets: {},
        bannedAddresses: {},
        notifyAddresses: {},
        minerWallets: {},
        proxyMiners: {},
        walletTrust: {},
        walletLastSeeTime: {},
        walletLastCheckTime: {},
        minerAgents: {},
        walletDebug: {},
        ipWhitelist: {},
        lastMinerLogTime: {},
        lastMinerNotifyTime: {},
        lastBlockHash: {},
        lastBlockHeight: {},
        lastBlockHashMM: {},
        lastBlockHeightMM: {},
        lastBlockTime: {},
        lastBlockKeepTime: {},
        lastBlockReward: {},
        newCoinHashFactor: {},
        lastCoinHashFactor: {},
        lastCoinHashFactorMM: {},
        lastBlockFixTime: {},
        lastBlockFixCount: {},
        anchorState: { current: undefined, previous: undefined },
        shareStats: {
            totalShares: 0,
            trustedShares: 0,
            normalShares: 0,
            invalidShares: 0,
            outdatedShares: 0,
            throttledShares: 0
        },
        minerCount: [],
        freeEthExtranonces: [],
        threadName: undefined,
        threadContextInitialized: false,
        threadResetInterval: null,
        threadStatsInterval: null,
        decId: 0,
        ethJobId: 0
    };

    Buffer.prototype.toByteArray = function toByteArray() {
        return Array.prototype.slice.call(this, 0);
    };

    function clearObject(target) {
        for (const key of Object.keys(target)) delete target[key];
    }

    function padHex(str, bytes) {
        const bytes2 = bytes * 2;
        return ("00".repeat(bytes) + str.substr(0, bytes2)).substr(-bytes2);
    }

    function toBigInt(value, base) {
        if (typeof value === "bigint") return value;
        if (typeof value === "number") return BigInt(Math.trunc(value));
        if (typeof value === "string") return BigInt(base === 16 ? `0x${value}` : value);
        if (Buffer.isBuffer(value)) return BigInt(`0x${value.toString("hex") || "00"}`);
        if (value && typeof value === "object") {
            if (typeof value.value === "bigint") return value.value;
            if (typeof value.toString === "function") {
                const stringValue = value.toString(base || 10);
                return BigInt(base === 16 ? `0x${stringValue}` : stringValue);
            }
            if (typeof value.toBuffer === "function") return bigIntFromBuffer(value.toBuffer({ endian: "big" }));
        }
        return BigInt(value || 0);
    }

    function bigIntFromBuffer(buffer, options) {
        options = options || {};
        const normalized = options.endian === "little" ? Buffer.from(buffer).reverse() : Buffer.from(buffer);
        return BigInt(`0x${normalized.toString("hex") || "00"}`);
    }

    function bigIntToBuffer(value, options) {
        options = options || {};
        let hex = toBigInt(value).toString(16);
        if (hex.length % 2) hex = `0${hex}`;
        if (typeof options.size === "number") {
            if (hex.length < options.size * 2) hex = `${"00".repeat(options.size)}${hex}`.slice(-options.size * 2);
            else if (hex.length > options.size * 2) hex = hex.slice(0, options.size * 2);
        }
        const buffer = Buffer.from(hex || "00", "hex");
        return options.endian === "little" ? Buffer.from(buffer).reverse() : buffer;
    }

    function divideBaseDiff(diff) {
        return toBigInt(global.coinFuncs.baseDiff()) / toBigInt(diff);
    }

    function sizedTargetValue(diff, size) {
        return ((1n << BigInt(size * 8)) - 1n) / toBigInt(diff);
    }

    function ravenTargetHex(diff) {
        return padHex((Number(global.coinFuncs.baseRavenDiff()) / Number(diff)).toString(16), 32);
    }

    function getNewId() {
        if (++state.decId > 999999999999999) state.decId = 0;
        return state.decId.toString(10);
    }

    function getNewEthJobId() {
        if (++state.ethJobId > 0xffff) state.ethJobId = 0;
        return padHex(state.ethJobId.toString(16), 2);
    }

    function getNewEthExtranonceId() {
        if (!state.freeEthExtranonces.length) {
            const errStr = state.threadName + "Pool server " + global.config.hostname + " has overlow extranonce of " + (16 - global.coinFuncs.uniqueWorkerIdBits) + " bits";
            console.error(errStr);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Pool node has extranonce overflow", errStr);
            return null;
        }
        return state.freeEthExtranonces.pop();
    }

    function ethExtranonce(id) {
        if (id === null) return null;
        return padHex(((id << global.coinFuncs.uniqueWorkerIdBits) + global.coinFuncs.uniqueWorkerId).toString(16), 2);
    }

    function getTargetHex(diff, size) {
        return padHex(bigIntToBuffer(sizedTargetValue(diff, size), { endian: "little", size }).toString("hex"), size);
    }

    function processSend(message, messageHandler) {
        if (global.__poolTestMode === true) return messageHandler(message);
        if (typeof process.send === "function") return process.send(message);
        return messageHandler(message);
    }

    function initThreadContext(isMaster, workerId, options) {
        if (state.threadContextInitialized) return;
        state.threadContextInitialized = true;
        options = options || {};

        if (isMaster) {
            state.threadName = options.threadName || "(Master) ";
            if (options.enableStats !== false) {
                state.threadStatsInterval = setInterval(function dumpShareStats() {
                    const shareStats = state.shareStats;
                    const trustedSharesPercent = (shareStats.totalShares ? shareStats.trustedShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const normalSharesPercent = (shareStats.totalShares ? shareStats.normalShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const invalidSharesPercent = (shareStats.totalShares ? shareStats.invalidShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const outdatedSharesPercent = (shareStats.totalShares ? shareStats.outdatedShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const throttledSharesPercent = (shareStats.totalShares ? shareStats.throttledShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    console.log(`>>> Trusted=${shareStats.trustedShares}(${trustedSharesPercent}%) / Validated=${shareStats.normalShares}(${normalSharesPercent}%) / Invalid=${shareStats.invalidShares}(${invalidSharesPercent}%) / Outdated=${shareStats.outdatedShares}(${outdatedSharesPercent}%) / Throttled=${shareStats.throttledShares}(${throttledSharesPercent}%) / Total=${shareStats.totalShares} shares`);
                    shareStats.totalShares = 0;
                    shareStats.trustedShares = 0;
                    shareStats.normalShares = 0;
                    shareStats.invalidShares = 0;
                    shareStats.outdatedShares = 0;
                    shareStats.throttledShares = 0;
                }, 30 * 1000);
            }
        } else {
            const resolvedWorkerId = typeof workerId !== "undefined" ? workerId : process.env.WORKER_ID;
            state.threadName = options.threadName || "(Worker " + resolvedWorkerId + " - " + process.pid + ") ";
            if (options.enableShareWindowReset !== false) {
                state.threadResetInterval = setInterval(function resetVerifiedShareWindow() {
                    for (const wallet in state.minerWallets) state.minerWallets[wallet].last_ver_shares = 0;
                }, global.config.pool.minerThrottleShareWindow * 1000);
            }
        }

        global.database.thread_id = state.threadName;
    }

    function resetRuntimeState() {
        if (state.threadResetInterval !== null) clearInterval(state.threadResetInterval);
        if (state.threadStatsInterval !== null) clearInterval(state.threadStatsInterval);
        state.threadResetInterval = null;
        state.threadStatsInterval = null;
        state.threadContextInitialized = false;
        state.threadName = undefined;

        state.activeMiners.clear();
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
        clearObject(state.minerAgents);
        clearObject(state.walletDebug);
        clearObject(state.ipWhitelist);
        clearObject(state.lastMinerLogTime);
        clearObject(state.lastMinerNotifyTime);
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
        clearObject(state.lastBlockFixTime);
        clearObject(state.lastBlockFixCount);
        state.anchorState.current = undefined;
        state.anchorState.previous = undefined;
        state.shareStats.totalShares = 0;
        state.shareStats.trustedShares = 0;
        state.shareStats.normalShares = 0;
        state.shareStats.invalidShares = 0;
        state.shareStats.outdatedShares = 0;
        state.shareStats.throttledShares = 0;
        state.minerCount.length = 0;
        state.freeEthExtranonces.length = 0;
        state.decId = 0;
        state.ethJobId = 0;
    }

    return {
        state,
        clearObject,
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
        getTargetHex,
        processSend,
        initThreadContext,
        resetRuntimeState
    };
};
