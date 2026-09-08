"use strict";
// The CommonJS export is the cluster singleton, represented as a default export in Node types.
const cluster = /** @type {import("node:cluster").Cluster} */ (/** @type {unknown} */ (require("cluster")));
const crypto = require("crypto");
const debug = require("debug")("pool");
const fs = require("fs");
const net = require("net");
const os = require("os");
const readline = require("readline");
const tls = require("tls");

const createLifecycle = require("./pool/lifecycle");
const createMessageHandler = require("./pool/messages");
const createMinerJobs = require("./pool/jobs");
const createMinerFactory = require("./pool/miners");
const createMinerRegistry = require("./pool/miner_registry");
const createProtocolHandler = require("./pool/protocol");
const createServerFactory = require("./pool/servers");
const createShareProcessor = require("./pool/shares");
const createPoolState = require("./pool/state");
const createTemplateManager = require("./pool/templates");

// Replaces target's contents in place, preserving its object identity so existing
// references stay valid. Skips the clear when source IS target (a mutated-in-place
// copy passed back), which would otherwise wipe the data before reassigning it.
/** @param {Record<string, number>} target @param {Record<string, number>} source @param {(target: Record<string, number>) => void} clearObject */
function copyStateObject(target, source, clearObject) {
    if (target === source) return;
    clearObject(target);
    Object.assign(target, source);
}

function createPoolRuntime() {
    const stateTools = createPoolState();
    const { state, clearObject } = stateTools;

    function getThreadName() {
        return state.threadName;
    }

    function getLastMinerLogTime() {
        return state.lastMinerLogTime;
    }

    /** @param {Record<string, number>} nextValue */
    function setLastMinerLogTime(nextValue) {
        copyStateObject(state.lastMinerLogTime, nextValue, clearObject);
    }

    /** @type {(message: unknown) => void} */
    let messageHandler = function uninitializedMessageHandler() {};
    /** @param {unknown} message */
    function processSend(message) {
        return stateTools.processSend(message, messageHandler);
    }

    const minerRegistry = createMinerRegistry({
        cluster,
        debug,
        state,
        processSend,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    const templateManager = createTemplateManager({
        cluster,
        debug,
        daemonPollMs: state.daemonPollMs,
        activeMiners: state.activeMiners,
        activeBlockTemplates: state.activeBlockTemplates,
        pastBlockTemplates: state.pastBlockTemplates,
        lastBlockHash: state.lastBlockHash,
        lastBlockHeight: state.lastBlockHeight,
        lastBlockHashMM: state.lastBlockHashMM,
        lastBlockHeightMM: state.lastBlockHeightMM,
        lastBlockTime: state.lastBlockTime,
        lastBlockKeepTime: state.lastBlockKeepTime,
        lastBlockReward: state.lastBlockReward,
        newCoinHashFactor: state.newCoinHashFactor,
        lastCoinHashFactor: state.lastCoinHashFactor,
        lastCoinHashFactorMM: state.lastCoinHashFactorMM,
        daemonFailureSince: state.daemonFailureSince,
        anchorState: state.anchorState,
        sendToWorkers: minerRegistry.sendToWorkers,
        getThreadName,
        formatCoinPort: stateTools.formatCoinPort,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    const shareProcessor = createShareProcessor({
        crypto,
        debug,
        divideBaseDiff: stateTools.divideBaseDiff,
        bigIntFromBuffer: stateTools.bigIntFromBuffer,
        toBigInt: stateTools.toBigInt,
        baseRavenDiff: global.coinFuncs.baseRavenDiff(),
        anchorState: state.anchorState,
        activeBlockTemplates: state.activeBlockTemplates,
        proxyMiners: state.proxyMiners,
        minerWallets: state.minerWallets,
        walletTrust: state.walletTrust,
        walletLastSeeTime: state.walletLastSeeTime,
        processSend,
        addProxyMiner: minerRegistry.addProxyMiner,
        adjustMinerDiff: minerRegistry.adjustMinerDiff,
        clearWalletSessionTrust: minerRegistry.clearWalletSessionTrust,
        /** @param {string} payout */
        isWalletBanned(payout) {
            return payout in state.bannedAddresses ||
                payout in state.bannedTmpWallets ||
                payout in state.bannedBigTmpWallets;
        },
        getThreadName,
        formatCoinPort: stateTools.formatCoinPort,
        formatPoolEvent: stateTools.formatPoolEvent,
        isBlockSubmitTestModeEnabled: stateTools.refreshBlockSubmitTestMode,
        getLastMinerLogTime,
        setLastMinerLogTime
    });

    const attachMinerJobMethods = createMinerJobs();

    const minerFactory = createMinerFactory({
        debug,
        state,
        retention: stateTools.retention,
        touchTimedEntry: stateTools.touchTimedEntry,
        utils: {
            getNewId: stateTools.getNewId,
            getNewEthJobId: stateTools.getNewEthJobId,
            getTargetHex: stateTools.getTargetHex,
            ravenTargetHex: stateTools.ravenTargetHex,
            toBigInt: stateTools.toBigInt,
            divideBaseDiff: stateTools.divideBaseDiff
        },
        attachMinerJobMethods,
        getCoinJobParams: templateManager.getCoinJobParams,
        processSend,
        removeMiner: minerRegistry.removeMiner,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    const handleMinerData = createProtocolHandler({
        debug,
        state,
        retention: stateTools.retention,
        touchTimedEntry: stateTools.touchTimedEntry,
        utils: {
            getNewId: stateTools.getNewId,
            getNewEthExtranonceId: stateTools.getNewEthExtranonceId,
            ethExtranonce: stateTools.ethExtranonce
        },
        createMiner: minerFactory.createMiner,
        addProxyMiner: minerRegistry.addProxyMiner,
        addActiveMiner: minerRegistry.addActiveMiner,
        adjustMinerDiff: minerRegistry.adjustMinerDiff,
        shareProcessor,
        removeMiner: minerRegistry.removeMiner,
        processSend,
        getCoinJobParams: templateManager.getCoinJobParams,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    const serverFactory = createServerFactory({
        debug,
        fs,
        net,
        tls,
        state,
        handleMinerData,
        removeMiner: minerRegistry.removeMiner,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    messageHandler = createMessageHandler({
        cluster,
        debug,
        state,
        sendToWorkers: minerRegistry.sendToWorkers,
        setNewBlockTemplate: templateManager.setNewBlockTemplate,
        setNewCoinHashFactor: templateManager.setNewCoinHashFactor,
        formatCoinPort: stateTools.formatCoinPort,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    const lifecycle = createLifecycle({
        cluster,
        fs,
        net,
        os,
        pruneTimedEntries: stateTools.pruneTimedEntries,
        readline,
        retention: stateTools.retention,
        state,
        minerRegistry,
        shareProcessor,
        templateManager,
        messageHandler,
        startPortServers: serverFactory.startPortServers,
        formatCoinPort: stateTools.formatCoinPort,
        formatPoolEvent: stateTools.formatPoolEvent
    });

    let hasProcessMessageListener = false;
    function attachProcessMessageListener() {
        if (hasProcessMessageListener) return;
        process.on("message", messageHandler);
        hasProcessMessageListener = true;
    }

    function resetRuntimeState() {
        shareProcessor.resetShareState();
        stateTools.resetRuntimeState();
    }

    /** @param {Record<string, number>} [coinHashFactors] */
    function initializeCoinHashFactors(coinHashFactors) {
        state.newCoinHashFactor[""] = 1;
        state.lastCoinHashFactor[""] = 1;
        state.lastCoinHashFactorMM[""] = 1;

        if (!global.config.daemon.enableAlgoSwitching) return;
        global.coinFuncs.getCOINS().forEach(function initializeCoin(coin) {
            const factor = coinHashFactors?.[coin] ?? 0;
            state.newCoinHashFactor[coin] = factor;
            state.lastCoinHashFactor[coin] = factor;
            state.lastCoinHashFactorMM[coin] = factor;
        });
    }

    function snapshotTestState() {
        return {
            activeMiners: state.activeMiners,
            activeMinersByPayout: state.activeMinersByPayout,
            activeBlockTemplates: state.activeBlockTemplates,
            bannedTmpIPs: state.bannedTmpIPs,
            bannedTmpWallets: state.bannedTmpWallets,
            bannedBigTmpWallets: state.bannedBigTmpWallets,
            bannedAddresses: state.bannedAddresses,
            notifyAddresses: state.notifyAddresses,
            minerWallets: state.minerWallets,
            proxyMiners: state.proxyMiners,
            minerAgents: state.minerAgents,
            ip_whitelist: state.ipWhitelist,
            activeConnectionsByIP: state.activeConnectionsByIP,
            activeConnectionsBySubnet: state.activeConnectionsBySubnet,
            daemonFailureSince: state.daemonFailureSince,
            minerCount: state.minerCount,
            workerMinerCounts: state.workerMinerCounts,
            walletLastCheckTime: state.walletLastCheckTime,
            walletLastSeeTime: state.walletLastSeeTime,
            walletTrust: state.walletTrust,
            lastMinerLogTime: state.lastMinerLogTime,
            lastMinerNotifyTime: state.lastMinerNotifyTime,
            blockSubmitTestMode: stateTools.getBlockSubmitTestModeState(),
            shareStats: {
                totalShares: state.shareStats.totalShares,
                trustedShares: state.shareStats.trustedShares,
                normalShares: state.shareStats.normalShares,
                invalidShares: state.shareStats.invalidShares,
                outdatedShares: state.shareStats.outdatedShares,
                throttledShares: state.shareStats.throttledShares
            }
        };
    }

    /** @param {import("node:net").Server[]} servers @returns {Promise<void[]>} */
    function stopServers(servers) {
        return Promise.all(servers.map(/** @returns {Promise<void>} */ function closeServer(server) {
            return new Promise(function onClose(resolve) {
                server.close(function closed() { resolve(); });
            });
        }));
    }

    /** @param {{workerId?: number, threadName?: string, uniqueWorkerId?: number, uniqueWorkerIdBits?: number, freeEthExtranonces?: number[], coinHashFactors?: Record<string, number>, templates?: import("./pool/templates").TemplateRecord[], ports?: import("../types/runtime").PortConfig[]}} [options] */
    function startTestRuntime(options) {
        const opts = options || {};

        resetRuntimeState();
        stateTools.clearBlockSubmitTestMarker();
        stateTools.initThreadContext(false, opts.workerId || 1, {
            threadName: opts.threadName || "(Test Worker) ",
            enableShareWindowReset: false
        });

        global.coinFuncs.uniqueWorkerId = opts.uniqueWorkerId || 0;
        global.coinFuncs.uniqueWorkerIdBits = opts.uniqueWorkerIdBits || 0;
        state.freeEthExtranonces = opts.freeEthExtranonces
            ? opts.freeEthExtranonces.slice()
            : [...Array(1 << 16).keys()];

        initializeCoinHashFactors(opts.coinHashFactors);
        (opts.templates || []).forEach(function installTemplate(template) {
            templateManager.setNewBlockTemplate(template);
        });

        return serverFactory.startPortServers(opts.ports || global.config.ports).then(function onServers(servers) {
            return {
                servers,
                setTemplate: templateManager.setNewBlockTemplate,
                getState: snapshotTestState,
                stop: function stop() {
                    return stopServers(servers);
                }
            };
        });
    }

    /** @param {string} coin @param {number} coinHashFactor */
    function setTestCoinHashFactor(coin, coinHashFactor) {
        state.newCoinHashFactor[coin] = coinHashFactor;
        state.lastCoinHashFactor[coin] = coinHashFactor;
        state.lastCoinHashFactorMM[coin] = coinHashFactor;
    }

    function startProduction() {
        if (cluster.isMaster) stateTools.clearBlockSubmitTestMarker();
        stateTools.initThreadContext(cluster.isMaster, process.env["WORKER_ID"]);
        attachProcessMessageListener();
        if (cluster.isMaster) lifecycle.startMaster();
        else lifecycle.startWorker();
        return true;
    }

    return {
        startProduction,
        testApi: {
            startTestRuntime,
            resetRuntimeState,
            setNewBlockTemplate: templateManager.setNewBlockTemplate,
            setNewCoinHashFactor: templateManager.setNewCoinHashFactor,
            setTestCoinHashFactor,
            templateUpdate2: templateManager.templateUpdate2,
            registerPool: minerRegistry.registerPool,
            retargetMiners: minerRegistry.retargetMiners,
            checkAliveMiners: minerRegistry.checkAliveMiners,
            getBlockSubmitTestModeState: stateTools.getBlockSubmitTestModeState,
            refreshBlockSubmitTestMode: stateTools.refreshBlockSubmitTestMode,
            clearBlockSubmitTestMarker: stateTools.clearBlockSubmitTestMarker,
            handleMinerData,
            messageHandler
        }
    };
}

const runtime = createPoolRuntime();

if (global.__poolTestMode === true) {
    module.exports = runtime.testApi;
} else {
    runtime.startProduction();
    module.exports = runtime;
}
