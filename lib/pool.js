"use strict";

const cluster = require("cluster");
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
const createMinerRegistry = require("./pool/miner-registry");
const createProtocolHandler = require("./pool/protocol");
const createServerFactory = require("./pool/servers");
const createShareProcessor = require("./pool/shares");
const createPoolState = require("./pool/state");
const createTemplateManager = require("./pool/templates");

function copyStateObject(target, source, clearObject) {
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

    function setLastMinerLogTime(nextValue) {
        copyStateObject(state.lastMinerLogTime, nextValue, clearObject);
    }

    let messageHandler = function uninitializedMessageHandler() {};
    function processSend(message) {
        return stateTools.processSend(message, messageHandler);
    }

    const minerRegistry = createMinerRegistry({
        cluster,
        debug,
        state,
        processSend
    });

    const templateManager = createTemplateManager({
        cluster,
        debug,
        daemonPollMs: state.daemonPollMs,
        coins: global.coinFuncs.getCOINS(),
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
        anchorState: state.anchorState,
        sendToWorkers: minerRegistry.sendToWorkers,
        getThreadName
    });

    const shareProcessor = createShareProcessor({
        crypto,
        debug,
        divideBaseDiff: stateTools.divideBaseDiff,
        bigIntFromBuffer: stateTools.bigIntFromBuffer,
        bigIntToBuffer: stateTools.bigIntToBuffer,
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
        getThreadName,
        getLastMinerLogTime,
        setLastMinerLogTime
    });

    const attachMinerJobMethods = createMinerJobs(state);

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
        removeMiner: minerRegistry.removeMiner
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
        adjustMinerDiff: minerRegistry.adjustMinerDiff,
        shareProcessor,
        processSend,
        getCoinJobParams: templateManager.getCoinJobParams
    });

    const serverFactory = createServerFactory({
        debug,
        fs,
        net,
        tls,
        state,
        handleMinerData,
        removeMiner: minerRegistry.removeMiner
    });

    messageHandler = createMessageHandler({
        cluster,
        debug,
        state,
        sendToWorkers: minerRegistry.sendToWorkers,
        setNewBlockTemplate: templateManager.setNewBlockTemplate,
        setNewCoinHashFactor: templateManager.setNewCoinHashFactor
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
        startPortServers: serverFactory.startPortServers
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

    function initializeCoinHashFactors(coinHashFactors) {
        state.newCoinHashFactor[""] = 1;
        state.lastCoinHashFactor[""] = 1;
        state.lastCoinHashFactorMM[""] = 1;

        if (!global.config.daemon.enableAlgoSwitching) return;
        global.coinFuncs.getCOINS().forEach(function initializeCoin(coin) {
            const factor = coinHashFactors && coin in coinHashFactors ? coinHashFactors[coin] : 0;
            state.newCoinHashFactor[coin] = factor;
            state.lastCoinHashFactor[coin] = factor;
            state.lastCoinHashFactorMM[coin] = factor;
        });
    }

    function snapshotTestState() {
        return {
            activeMiners: state.activeMiners,
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
            minerCount: state.minerCount,
            walletLastCheckTime: state.walletLastCheckTime,
            walletLastSeeTime: state.walletLastSeeTime,
            walletTrust: state.walletTrust,
            lastMinerLogTime: state.lastMinerLogTime,
            lastMinerNotifyTime: state.lastMinerNotifyTime,
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

    function stopServers(servers) {
        return Promise.all(servers.map(function closeServer(server) {
            return new Promise(function onClose(resolve) {
                server.close(function closed() { resolve(); });
            });
        }));
    }

    function startTestRuntime(options) {
        options = options || {};

        resetRuntimeState();
        stateTools.initThreadContext(false, options.workerId || 1, {
            threadName: options.threadName || "(Test Worker) ",
            enableShareWindowReset: false
        });

        global.coinFuncs.uniqueWorkerId = options.uniqueWorkerId || 0;
        global.coinFuncs.uniqueWorkerIdBits = options.uniqueWorkerIdBits || 0;
        state.freeEthExtranonces = options.freeEthExtranonces
            ? options.freeEthExtranonces.slice()
            : [...Array(1 << 16).keys()];

        initializeCoinHashFactors(options.coinHashFactors);
        (options.templates || []).forEach(function installTemplate(template) {
            templateManager.setNewBlockTemplate(template);
        });

        return serverFactory.startPortServers(options.ports || global.config.ports).then(function onServers(servers) {
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

    function setTestCoinHashFactor(coin, coinHashFactor) {
        state.newCoinHashFactor[coin] = coinHashFactor;
        state.lastCoinHashFactor[coin] = coinHashFactor;
        state.lastCoinHashFactorMM[coin] = coinHashFactor;
    }

    function startProduction() {
        if (global.config.general.allowStuckPoolKill && fs.existsSync("block_template_is_stuck")) {
            console.error("Stuck block template was detected on previous run. Please fix monerod and remove block_template_is_stuck file after that. Exiting...");
            setTimeout(function exitAfterDelay() { process.exit(); }, 5 * 1000);
            return false;
        }

        stateTools.initThreadContext(cluster.isMaster, process.env.WORKER_ID);
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
