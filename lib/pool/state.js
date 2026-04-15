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
        activeMinersByPayout: new Map(),
        activeMinerSockets: new Map(),
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
        protocolWarningState: Object.create(null),
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
        activeConnectionsByIP: {},
        activeConnectionsBySubnet: {},
        rpcRateBuckets: new Map(),
        minerCount: [],
        freeEthExtranonces: [],
        lastEthExtranonceOverflowNoticeAt: 0,
        threadName: undefined,
        threadContextInitialized: false,
        threadResetInterval: null,
        threadStatsInterval: null,
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
    const timedEntryMetadata = new WeakMap();

    Buffer.prototype.toByteArray = function toByteArray() {
        return Array.prototype.slice.call(this, 0);
    };

    function clearObject(target) {
        for (const key of Object.keys(target)) delete target[key];
    }

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

    function resetTimedEntryMetadata(target) {
        timedEntryMetadata.set(target, {
            lastPruneAt: 0,
            newEntriesSincePrune: 0
        });
    }

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
                    return target[left] - target[right];
                });
                for (let index = 0; index < keys.length - maxEntries; ++index) delete target[keys[index]];
            }
        }

        metadata.lastPruneAt = timeNow;
        metadata.newEntriesSincePrune = 0;
    }

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
        const baseDiff = toBigInt(global.coinFuncs.baseDiff());
        const divisor = toBigInt(diff);
        // Buggy miners can submit an all-zero result hash. Treat that as the
        // highest possible share difficulty so the normal verifier can reject
        // it cleanly instead of crashing the socket handler on division by zero.
        if (divisor === 0n) return baseDiff;
        return baseDiff / divisor;
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
            const timeNow = Date.now();
            const cooldownSeconds = global.config && global.config.pool && Number.isFinite(global.config.pool.ethExtranonceOverflowNotifyCooldown)
                ? global.config.pool.ethExtranonceOverflowNotifyCooldown
                : 600;
            const cooldownMs = Math.max(0, cooldownSeconds * 1000);
            if (state.lastEthExtranonceOverflowNoticeAt === 0 || timeNow - state.lastEthExtranonceOverflowNoticeAt >= cooldownMs) {
                state.lastEthExtranonceOverflowNoticeAt = timeNow;
                console.error(errStr);
                if (global.support && typeof global.support.sendEmail === "function") {
                    global.support.sendEmail(global.config.general.adminEmail, "FYI: Pool node has extranonce overflow", errStr);
                }
            }
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

    function formatThreadName(isMaster, workerId, pid) {
        if (isMaster) return "[M] ";
        return "[S" + workerId + ":" + pid + "] ";
    }

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

    function resolveCoinDisplay(coin, port) {
        if (global.coinFuncs && typeof port !== "undefined") {
            if (typeof global.coinFuncs.PORT2COIN_FULL === "function") {
                const displayCoin = global.coinFuncs.PORT2COIN_FULL(port);
                if (typeof displayCoin === "string" && displayCoin.length) return displayCoin;
            }
            if (typeof global.coinFuncs.PORT2COIN === "function") {
                const portCoin = global.coinFuncs.PORT2COIN(port);
                if (typeof portCoin === "string" && portCoin.length) return portCoin;
            }
        }
        if (typeof coin === "string" && coin.length) return coin;
        if (coin === "" && global.coinFuncs && global.config && global.config.daemon && typeof global.config.daemon.port !== "undefined") {
            if (typeof global.coinFuncs.PORT2COIN_FULL === "function") {
                const mainCoin = global.coinFuncs.PORT2COIN_FULL(global.config.daemon.port);
                if (typeof mainCoin === "string" && mainCoin.length) return mainCoin;
            }
        }
        return "PORT";
    }

    function formatCoinPort(coin, port) {
        const resolvedPort = resolveCoinPort(coin, port);
        const resolvedCoin = resolveCoinDisplay(coin, resolvedPort);
        if (typeof resolvedPort === "undefined") return resolvedCoin;
        return resolvedCoin + "/" + resolvedPort;
    }

    function formatLogValue(value) {
        if (value === undefined || value === null) return null;
        if (typeof value === "string") {
            if (value === "") return null;
            return /^[A-Za-z0-9._:/%+-]+$/.test(value) ? value : JSON.stringify(value);
        }
        if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    function formatLogFields(fields) {
        if (!fields || typeof fields !== "object") return "";
        const parts = [];
        Object.keys(fields).forEach(function appendField(key) {
            const value = formatLogValue(fields[key]);
            if (value === null) return;
            parts.push(key + "=" + value);
        });
        return parts.join(" ");
    }

    function formatPoolEvent(label, fields) {
        const suffix = formatLogFields(fields);
        return suffix ? label + ": " + suffix : label;
    }

    function initThreadContext(isMaster, workerId, options) {
        if (state.threadContextInitialized) return;
        state.threadContextInitialized = true;
        options = options || {};

        if (isMaster) {
            state.threadName = options.threadName || formatThreadName(true);
            if (options.enableStats !== false) {
                state.threadStatsInterval = setInterval(function dumpShareStats() {
                    const shareStats = state.shareStats;
                    const trustedSharesPercent = (shareStats.totalShares ? shareStats.trustedShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const normalSharesPercent = (shareStats.totalShares ? shareStats.normalShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const invalidSharesPercent = (shareStats.totalShares ? shareStats.invalidShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const outdatedSharesPercent = (shareStats.totalShares ? shareStats.outdatedShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    const throttledSharesPercent = (shareStats.totalShares ? shareStats.throttledShares / shareStats.totalShares * 100 : 0).toFixed(2);
                    console.log(state.threadName + "IMPORTANT: " + formatPoolEvent("Summary", {
                        total: shareStats.totalShares,
                        trusted: `${shareStats.trustedShares}(${trustedSharesPercent}%)`,
                        validated: `${shareStats.normalShares}(${normalSharesPercent}%)`,
                        invalid: `${shareStats.invalidShares}(${invalidSharesPercent}%)`,
                        outdated: `${shareStats.outdatedShares}(${outdatedSharesPercent}%)`,
                        throttled: `${shareStats.throttledShares}(${throttledSharesPercent}%)`
                    }));
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
            state.threadName = options.threadName || formatThreadName(false, resolvedWorkerId, process.pid);
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
        clearObject(state.activeConnectionsByIP);
        clearObject(state.activeConnectionsBySubnet);
        state.rpcRateBuckets.clear();
        state.minerCount.length = 0;
        state.freeEthExtranonces.length = 0;
        state.lastEthExtranonceOverflowNoticeAt = 0;
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
        getTargetHex,
        formatCoinPort,
        formatLogFields,
        formatPoolEvent,
        processSend,
        initThreadContext,
        resetRuntimeState
    };
};
