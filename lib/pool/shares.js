"use strict";
const { getRemoteDatabase } = require("../common/database.js");
const createShareBlockHelpers = require("./share_blocks.js");

/** @typedef {import("../../types/pool_profiles").PoolBlockTemplate} PoolBlockTemplate */
/** @typedef {import("../../types/pool_profiles").PoolJob} PoolJob */
/** @typedef {import("../../types/pool_profiles").PoolMiner} PoolMiner */
/** @typedef {import("../../types/pool_profiles").PoolSubmitParams} PoolSubmitParams */
/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */

/** @typedef {((message: string) => void) & {enabled?: boolean}} ShareDebug */
/** @typedef {{randomBytes(size: number): Buffer}} ShareCrypto */
/** @typedef {{current: number|undefined, previous: number|undefined}} AnchorState */
/** @typedef {{last_ver_shares: number, hashes: number, connectTime: number, count: number, submissionBudget: boolean}} MinerWallet */
/** @typedef {{hashes: number, connectTime: number, count: number, submissionBudget: boolean, last_ver_shares?: number}} ProxyWallet */
/** @typedef {{height: number|undefined, difficulty: number, time: number, acc: number, raw_acc: number, acc2: number, share_num: number, trustedShare: boolean}} ShareWorker */
/** @typedef {Record<string, ShareWorker>} ShareWorkerMap */
/** @typedef {{run: (forceVerify: boolean, done: () => void) => void, cancel: () => void}} TrustQueueEntry */
/** @typedef {{payout: string, inFlight: number, queue: TrustQueueEntry[], draining: boolean, forceVerify: boolean}} TrustGate */
/** @typedef {PoolJob & {norm_diff: number, rewarded_difficulty: number, rewarded_difficulty2: number}} ShareJob */
/** @typedef {Buffer|unknown[]|string} ShareBlockData */
/** @typedef {(hashDiff: number|bigint, resultBuff: Buffer|null, blockData: ShareBlockData|null, isTrustedShare: boolean, isNeedCheckBlockDiff: boolean) => void} ShareVerificationCallback */
/** @typedef {{resultHash: string, resultBuff: Buffer, hashDiff: number|bigint}} VerifyResult */
/** @typedef {ReturnType<typeof createShareBlockHelpers>} ShareBlockHelpers */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @typedef {object} ShareProcessorDeps
 * @property {ShareCrypto} crypto
 * @property {ShareDebug} debug
 * @property {(value: number|bigint|string|Buffer) => number|bigint} divideBaseDiff
 * @property {(value: Buffer, options?: {endian?: "big"|"little", size?: number}) => bigint} bigIntFromBuffer
 * @property {(value: bigint, options: {endian: "big"|"little", size: number}) => Buffer} bigIntToBuffer
 * @property {(value: number|string|bigint|Buffer) => bigint} toBigInt
 * @property {number|string|bigint} baseRavenDiff
 * @property {AnchorState} anchorState
 * @property {Record<string, PoolBlockTemplate>} activeBlockTemplates
 * @property {Record<string, ProxyWallet>} proxyMiners
 * @property {Record<string, MinerWallet>} minerWallets
 * @property {Record<string, number>} walletTrust
 * @property {Record<string, number>} walletLastSeeTime
 * @property {(message: ProtoMessage) => void} processSend
 * @property {(miner: PoolMiner) => boolean} addProxyMiner
 * @property {(miner: PoolMiner) => boolean} adjustMinerDiff
 * @property {(payout: string, trustKey: string) => void} clearWalletSessionTrust
 * @property {(payout: string) => boolean} [isWalletBanned]
 * @property {() => string} getThreadName
 * @property {(coin: string|undefined, port?: number) => string} formatCoinPort
 * @property {(label: string, fields?: Record<string, unknown>) => string} [formatPoolEvent]
 * @property {() => boolean} [isBlockSubmitTestModeEnabled]
 * @property {() => Record<string, number>} getLastMinerLogTime
 * @property {(value: Record<string, number>) => void} setLastMinerLogTime
 */

const HEX_64_PATTERN = /^(?:0x)?([0-9a-f]{64})$/i;

// Share processing is the hottest code path in the pool. This module keeps the
// verification/submission pipeline together so the entrypoint only wires
// dependencies and protocol handlers.
/** @param {ShareProcessorDeps} deps */
module.exports = function createShareProcessor(deps) {
    const {
        crypto,
        debug,
        divideBaseDiff,
        bigIntFromBuffer,
        bigIntToBuffer,
        toBigInt,
        baseRavenDiff,
        anchorState,
        activeBlockTemplates,
        proxyMiners,
        minerWallets,
        walletTrust,
        walletLastSeeTime,
        processSend,
        addProxyMiner,
        adjustMinerDiff,
        clearWalletSessionTrust,
        isWalletBanned = function fallbackIsWalletBanned() { return false; },
        getThreadName,
        formatCoinPort,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; },
        isBlockSubmitTestModeEnabled = function fallbackBlockSubmitTestMode() { return false; },
        getLastMinerLogTime,
        setLastMinerLogTime
    } = deps;

    /** @type {Record<string, ShareWorkerMap>} */
    const walletAcc = Object.create(null);
    /** @type {Record<string, number>} */
    const walletWorkerCount = Object.create(null);
    /** @type {Record<string, boolean>} */
    const isWalletAccFinalizer = Object.create(null);
    /** @type {Record<string, number>} */
    const extraWalletVerify = Object.create(null);
    /** @type {string[]} */
    const extraVerifyWalletHashes = [];
    /** @type {Map<string, TrustGate>} */
    const trustVerificationGates = new Map();
    /** @type {ShareBlockHelpers} */
    const shareBlockHelpers = createShareBlockHelpers({
        crypto,
        debug,
        divideBaseDiff,
        bigIntFromBuffer,
        toBigInt,
        baseRavenDiff,
        anchorState,
        activeBlockTemplates,
        walletTrust,
        processSend,
        clearWalletSessionTrust,
        getThreadName,
        formatCoinPort,
        formatPoolEvent,
        isBlockSubmitTestModeEnabled,
        getLastMinerLogTime,
        setLastMinerLogTime
    });
    const {
        invalidShare,
        isSafeToTrust,
        hashBuffDiff,
        hashRavenBuffDiff,
        hashEthBuffDiff,
        ge,
        reportMinerShare,
        submitBlock
    } = shareBlockHelpers;

    /** @param {unknown} value @returns {string} */
    function normalizeSyntheticResultHex(value) {
        if (typeof value !== "string") return "";
        const match = value.trim().match(HEX_64_PATTERN);
        const normalized = match && match[1];
        return typeof normalized === "string" ? normalized.toLowerCase() : "";
    }

    /** @param {unknown} ipAddress @returns {boolean} */
    function isLoopbackAddress(ipAddress) {
        return ipAddress === "::1" || ipAddress === "::ffff:127.0.0.1" || (typeof ipAddress === "string" && ipAddress.startsWith("127."));
    }

    /** @param {PoolMiner|null|undefined} miner @returns {boolean} */
    function isBlockSubmitTestBypassEnabled(miner) {
        return isBlockSubmitTestModeEnabled() === true && isLoopbackAddress(miner && miner.ipAddress);
    }

    /** @param {PoolMiner} miner @returns {string} */
    function getMinerTrustKey(miner) {
        return miner.trust_key || miner.payout;
    }

    /** @param {PoolMiner} miner @param {PoolJob} job @param {PoolSubmitParams} params @returns {Buffer|null} */
    function getBlockSubmitTestResultBuffer(miner, job, params) {
        if (!isBlockSubmitTestBypassEnabled(miner)) return null;
        const rawParams = params && params.raw_params instanceof Array ? params.raw_params : null;
        const minParamLength = job && job.coin === "ERG" ? 4 : 6;
        const rawResult = rawParams && rawParams.length >= minParamLength ? rawParams[rawParams.length - 1] : "";
        const fallbackRawResult = rawParams && rawParams.length >= 6 ? rawParams[rawParams.length - 1] : "";
        const coinResult = job && ["XTM-C", "", "XTM-T", "RTM", "ARQ"].includes(job.coin) ? params && params.result : "";
        const resultHex = [params && params["block_submit_test_result"], rawResult, coinResult, fallbackRawResult].map(normalizeSyntheticResultHex).find(Boolean);
        return resultHex ? Buffer.from(resultHex, "hex") : null;
    }

    /** @param {PoolMiner} miner @returns {boolean} */
    function hasBlockSubmitTrust(miner) {
        const trustKey = getMinerTrustKey(miner);
        return Boolean(miner.validShares || (trustKey in walletTrust && (walletTrust[trustKey] || 0) > 0));
    }

    /** @param {PoolMiner} miner @returns {string} */
    function ensureWalletTrustEntry(miner) {
        const trustKey = getMinerTrustKey(miner);
        if (!(trustKey in walletTrust)) walletTrust[trustKey] = 0;
        walletLastSeeTime[trustKey] = Date.now();
        return trustKey;
    }

    /** @param {PoolMiner} miner @param {number} difficulty @returns {void} */
    function addWalletTrust(miner, difficulty) {
        const trustKey = ensureWalletTrustEntry(miner);
        walletTrust[trustKey] = (walletTrust[trustKey] || 0) + difficulty;
    }

    /** @returns {number} */
    function getVerifyRetryLimit() {
        const verifyConfig = global.config.pool && global.config.pool["verifyShareRetry"];
        if (!isRecord(verifyConfig)) return 3;
        const maxRetries = verifyConfig["maxRetries"];
        if (typeof maxRetries !== "number") return 3;
        return Math.max(0, Math.floor(maxRetries));
    }

    /** @returns {number} */
    function getVerifyRetryDelayMs() {
        const verifyConfig = global.config.pool && global.config.pool["verifyShareRetry"];
        if (!isRecord(verifyConfig)) return 30;
        const retryDelayMs = verifyConfig["retryDelayMs"];
        if (typeof retryDelayMs !== "number") return 30;
        return Math.max(0, Math.floor(retryDelayMs));
    }

    /** @param {string|null|false} hash @param {string|undefined} errorKind @returns {boolean} */
    function isRetryableVerifyFailure(hash, errorKind) {
        return hash === false && errorKind === "verify-host-error";
    }

    /** @param {string|null|false} hash @param {string|undefined} errorKind @returns {boolean} */
    function isVerifierUnavailable(hash, errorKind) {
        return hash === null || isRetryableVerifyFailure(hash, errorKind);
    }

    // Only trusted-path shares wait here. Normal verification stays parallel.
    /** @param {string} trustKey @param {string} payout @returns {TrustGate} */
    function getTrustVerificationGate(trustKey, payout) {
        let gate = trustVerificationGates.get(trustKey);
        if (!gate) {
            gate = { payout, inFlight: 0, queue: [], draining: false, forceVerify: false };
            trustVerificationGates.set(trustKey, gate);
        }
        return gate;
    }

    /** @param {string} payout @returns {number} */
    function getTrustedQueueLimit(payout) {
        const configuredLimit = Number(global.config.pool["minerThrottleSharePerSec"]) *
            Number(global.config.pool["minerThrottleShareWindow"]);
        const baseLimit = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 25;
        const proxy = proxyMiners[payout];
        return baseLimit * (proxy && proxy.submissionBudget === true ? 10 : 1);
    }

    /** @param {string} trustKey @param {TrustGate} gate @returns {void} */
    function dropTrustedQueue(trustKey, gate) {
        trustVerificationGates.delete(trustKey);
        for (const entry of gate.queue.splice(0)) entry.cancel();
    }

    /** @param {string} trustKey @returns {void} */
    function drainTrustedQueue(trustKey) {
        const gate = trustVerificationGates.get(trustKey);
        if (!gate || gate.inFlight || gate.draining) return;
        if (isWalletBanned(gate.payout)) return dropTrustedQueue(trustKey, gate);
        const entry = gate.queue.shift();
        if (!entry) {
            trustVerificationGates.delete(trustKey);
            return;
        }

        gate.draining = true;
        setImmediate(entry.run, gate.forceVerify, function onQueuedShareProcessed() {
            const currentGate = trustVerificationGates.get(trustKey);
            if (currentGate !== gate) return;
            gate.draining = false;
            if (!gate.queue.length) gate.forceVerify = false;
            drainTrustedQueue(trustKey);
        });
    }

    /** @param {string} trustKey @returns {void} */
    function finishTrustVerification(trustKey) {
        const gate = trustVerificationGates.get(trustKey);
        if (gate && gate.inFlight > 0) gate.inFlight -= 1;
        drainTrustedQueue(trustKey);
    }

    /** @param {PoolMiner} miner @param {string} trustKey @returns {void} */
    function markTrustVerificationFailed(miner, trustKey) {
        const gate = trustVerificationGates.get(trustKey);
        // A failed check invalidates the whole queued generation.
        if (gate && (gate.queue.length || gate.draining)) gate.forceVerify = true;
        clearWalletSessionTrust(miner.payout, trustKey);
        if (miner.trust) miner.trust.trust = 0;
        if (trustKey in walletTrust) walletTrust[trustKey] = 0;
    }

    /** @param {PoolMiner} miner @param {number} rawShareReward @param {number} shareReward2 @param {number} shareNum @param {string} workerName @param {number} btPort @param {number|undefined} btHeight @param {number} btDifficulty @param {boolean} isBlockCandidate @param {boolean} isTrustedShare @returns {void} */
    function storeShareDiv(miner, rawShareReward, shareReward2, shareNum, workerName, btPort, btHeight, btDifficulty, isBlockCandidate, isTrustedShare) {
        const timeNow = Date.now();
        const database = getRemoteDatabase(global.database);
        const blockHeight = btHeight || 0;
        if (miner.payout_div === null) {
            database.storeShare(blockHeight, global.protos.Share.encode({
                paymentAddress: miner.address,
                ...(miner.paymentID !== null ? { paymentID: miner.paymentID } : {}),
                raw_shares: rawShareReward,
                shares2: shareReward2,
                share_num: shareNum,
                identifier: workerName,
                port: btPort,
                blockHeight,
                blockDiff: btDifficulty,
                poolType: miner.poolTypeEnum,
                foundBlock: isBlockCandidate,
                trustedShare: isTrustedShare,
                poolID: global.config.pool_id,
                timestamp: timeNow
            }));
            return;
        }

        for (const payout in miner.payout_div) {
            const payoutSplit = payout.split(".");
            const paymentAddress = payoutSplit[0] || "";
            const paymentID = payoutSplit.length === 2 ? payoutSplit[1] : null;
            const payoutPercent = miner.payout_div[payout];
            if (typeof payoutPercent !== "number") continue;
            database.storeShare(blockHeight, global.protos.Share.encode({
                paymentAddress,
                ...(paymentID ? { paymentID } : {}),
                raw_shares: rawShareReward * payoutPercent / 100,
                shares2: Math.floor(shareReward2 * payoutPercent / 100),
                share_num: shareNum,
                identifier: workerName,
                port: btPort,
                blockHeight,
                blockDiff: btDifficulty,
                poolType: miner.poolTypeEnum,
                foundBlock: isBlockCandidate,
                trustedShare: isTrustedShare,
                poolID: global.config.pool_id,
                timestamp: timeNow
            }));
        }
    }

    /** @param {ShareJob} job @returns {number} */
    function getRawShareReward(job) {
        const hashesPerDifficulty = Number(job.hashesPerDifficulty || 1);
        return job.rewarded_difficulty * (Number.isFinite(hashesPerDifficulty) && hashesPerDifficulty > 0 ? hashesPerDifficulty : 1);
    }

    /** @returns {number} */
    function getShareAccTimeMs() {
        const configured = Number(global.config && global.config.pool && global.config.pool["shareAccTime"]);
        if (!Number.isFinite(configured) || configured < 0) return 60 * 1000;
        return configured * 1000;
    }

    /** @param {string} walletKey @param {PoolMiner} miner @param {number} btPort @returns {void} */
    function walletAccFinalizer(walletKey, miner, btPort) {
        if (debug.enabled) debug(formatPoolEvent("Share acc scan", { wallet: walletKey }));
        const wallet = walletAcc[walletKey];
        if (!wallet) {
            isWalletAccFinalizer[walletKey] = false;
            return;
        }
        let isSomethingLeft = false;
        const timeNow = Date.now();
        for (const workerName in wallet) {
            const worker = wallet[workerName];
            if (!worker) continue;
            if (timeNow - worker.time > getShareAccTimeMs()) {
                if (worker.acc !== 0) {
                    if (debug.enabled) debug(formatPoolEvent("Share acc flush", {
                            wallet: walletKey,
                            worker: workerName,
                            height: worker.height,
                            diff: worker.difficulty,
                            time: timeNow,
                            acc: worker.acc
                        }));
                    storeShareDiv(miner, worker.raw_acc, worker.acc2, worker.share_num, workerName, btPort, worker.height, worker.difficulty, false, worker.trustedShare);
                }
                if (debug.enabled) debug(formatPoolEvent("Share acc worker remove", { wallet: walletKey, worker: workerName }));
                if (workerName !== "all_other_workers") walletWorkerCount[walletKey] = Math.max(0, (walletWorkerCount[walletKey] || 0) - 1);
                delete wallet[workerName];
            } else {
                isSomethingLeft = true;
            }
        }

        if (isSomethingLeft) {
            setTimeout(walletAccFinalizer, getShareAccTimeMs(), walletKey, miner, btPort);
        } else {
            isWalletAccFinalizer[walletKey] = false;
        }
    }

    /** @param {PoolMiner} miner @param {ShareJob} job @param {boolean} isTrustedShare @param {PoolBlockTemplate} blockTemplate @returns {void} */
    function recordShareData(miner, job, isTrustedShare, blockTemplate) {
        miner.hashes += job.norm_diff;
        const proxyMinerName = miner.payout;
        const proxyMiner = proxyMiners[proxyMinerName];
        if (proxyMiner) {
            proxyMiner.hashes += job.norm_diff;
            proxyMiner.submissionBudget = true;
        }
        const trustKey = getMinerTrustKey(miner);
        if (trustKey in walletTrust) walletLastSeeTime[trustKey] = Date.now();

        const timeNow = Date.now();
        const walletKey = miner.wallet_key + blockTemplate.port;
        if (!(walletKey in walletAcc)) {
            walletAcc[walletKey] = Object.create(null);
            walletWorkerCount[walletKey] = 0;
            isWalletAccFinalizer[walletKey] = false;
        }

        // eslint-disable-next-line eqeqeq -- intentional loose compare: config daemon.port may be a string while template port is numeric
        const dbJobHeight = global.config.daemon.port == blockTemplate.port ? blockTemplate.height : anchorState.current;
        const wallet = walletAcc[walletKey];
        if (!wallet) return;
        const workerName = Object.prototype.hasOwnProperty.call(wallet, miner.identifier) || (walletWorkerCount[walletKey] || 0) < 50
            ? miner.identifier
            : "all_other_workers";

        if (!Object.prototype.hasOwnProperty.call(wallet, workerName)) addShareWorker(wallet, walletKey, workerName, dbJobHeight, blockTemplate, timeNow, isTrustedShare);

        const worker = wallet[workerName];
        if (!worker) return;
        updateShareWorker(miner, job, worker, workerName, walletKey, blockTemplate, dbJobHeight, timeNow, isTrustedShare);

        if (debug.enabled) debug(formatPoolEvent("Share acc update", {
                wallet: walletKey,
                worker: workerName,
                height: dbJobHeight,
                diff: blockTemplate.difficulty,
                time: worker.time,
                acc: worker.acc,
                raw_acc: worker.raw_acc,
                add: job.rewarded_difficulty
            }));

        if (isWalletAccFinalizer[walletKey] === false) {
            isWalletAccFinalizer[walletKey] = true;
            setTimeout(walletAccFinalizer, getShareAccTimeMs(), walletKey, miner, blockTemplate.port);
        }

        processSend({ type: isTrustedShare ? "trustedShare" : "normalShare" });
        if (debug.enabled) debug(getThreadName() + formatPoolEvent("Share accepted", {
                mode: isTrustedShare ? "trusted" : "valid",
                chain: formatCoinPort(job.coin, blockTemplate.port),
                diff: job.difficulty,
                rewardDiff: job.rewarded_difficulty,
                miner: miner.logString
            }));
        const activeTemplate = activeBlockTemplates[job.coin];
        if (activeTemplate && activeTemplate.idHash !== blockTemplate.idHash) {
            processSend({ type: "outdatedShare" });
        }
    }

    /** @param {ShareWorkerMap} wallet @param {string} walletKey @param {string} workerName @param {number|undefined} dbJobHeight @param {PoolBlockTemplate} blockTemplate @param {number} timeNow @param {boolean} isTrustedShare @returns {void} */
    function addShareWorker(wallet, walletKey, workerName, dbJobHeight, blockTemplate, timeNow, isTrustedShare) {
        if (workerName !== "all_other_workers") walletWorkerCount[walletKey] = (walletWorkerCount[walletKey] || 0) + 1;
        if (debug.enabled) debug(formatPoolEvent("Share acc worker add", { wallet: walletKey, worker: workerName, workers: walletWorkerCount[walletKey] }));
        wallet[workerName] = { height: dbJobHeight, difficulty: blockTemplate.difficulty, time: timeNow, acc: 0, raw_acc: 0, acc2: 0, share_num: 0, trustedShare: isTrustedShare };
    }

    /** @param {PoolMiner} miner @param {ShareJob} job @param {ShareWorker} worker @param {string} workerName @param {string} walletKey @param {PoolBlockTemplate} blockTemplate @param {number|undefined} dbJobHeight @param {number} timeNow @param {boolean} isTrustedShare @returns {void} */
    function updateShareWorker(miner, job, worker, workerName, walletKey, blockTemplate, dbJobHeight, timeNow, isTrustedShare) {
        const rawShareReward = getRawShareReward(job);
        if (timeNow - worker.time <= getShareAccTimeMs() && worker.acc < 100000000) {
            worker.acc += job.rewarded_difficulty;
            worker.raw_acc += rawShareReward;
            worker.acc2 += job.rewarded_difficulty2;
            ++worker.share_num;
            worker.trustedShare = worker.trustedShare && isTrustedShare;
            return;
        }
        if (worker.acc !== 0) {
            if (debug.enabled) debug(formatPoolEvent("Share acc flush", { wallet: walletKey, worker: workerName, height: worker.height, diff: worker.difficulty, time: timeNow, acc: worker.acc }));
            storeShareDiv(miner, worker.raw_acc, worker.acc2, worker.share_num, workerName, blockTemplate.port, worker.height, worker.difficulty, false, isTrustedShare);
        }
        worker.height = dbJobHeight;
        worker.difficulty = blockTemplate.difficulty;
        worker.time = timeNow;
        worker.acc = job.rewarded_difficulty;
        worker.raw_acc = rawShareReward;
        worker.acc2 = job.rewarded_difficulty2;
        worker.share_num = 1;
        worker.trustedShare = isTrustedShare;
    }

    /** @param {PoolMiner} miner @param {PoolJob} job @param {PoolBlockTemplate} blockTemplate @param {PoolSubmitParams} params @returns {Buffer|null} */
    function getShareBuffer(miner, job, blockTemplate, params) {
        try {
            if (!blockTemplate.buffer || !Number.isInteger(blockTemplate.reserved_offset)) throw new Error("Block template buffer is unavailable");
            if (typeof job.extraNonce !== "number" || !Number.isInteger(job.extraNonce) || job.extraNonce < 0 || job.extraNonce > 0xffffffff) throw new Error("Job extra nonce is invalid");
            const reservedOffset = blockTemplate.reserved_offset;
            const template = Buffer.alloc(blockTemplate.buffer.length);
            blockTemplate.buffer.copy(template);
            template.writeUInt32BE(job.extraNonce, reservedOffset);
            if (job.usesProxyNonce) {
                const poolNonce = params.poolNonce;
                const workerNonce = params.workerNonce;
                const clientPoolLocation = job.clientPoolLocation;
                const clientNonceLocation = job.clientNonceLocation;
                if (typeof poolNonce !== "number" || !Number.isInteger(poolNonce) ||
                    typeof workerNonce !== "number" || !Number.isInteger(workerNonce) ||
                    typeof clientPoolLocation !== "number" || !Number.isInteger(clientPoolLocation) ||
                    typeof clientNonceLocation !== "number" || !Number.isInteger(clientNonceLocation)) throw new Error("Proxy nonce is invalid");
                template.writeUInt32BE(poolNonce, clientPoolLocation);
                template.writeUInt32BE(workerNonce, clientNonceLocation);
            }
            return global.coinFuncs.constructNewBlob(template, params, blockTemplate.port);
        } catch (error) {
            const errStr = getThreadName() + formatPoolEvent("Blob build failed", {
                chain: formatCoinPort(job.coin, blockTemplate.port),
                miner: miner.logString,
                params,
                error: error instanceof Error ? error.message : String(error)
            });
            console.error(errStr);
            global.support.sendAdminFyi(`pool:construct-new-blob:${  blockTemplate.port}`, "FYI: Can't constructNewBlob", errStr);
            return null;
        }
    }

    /** @param {PoolMiner} miner @param {ShareJob} job @param {PoolBlockTemplate} blockTemplate @param {PoolSubmitParams} params @param {(shareAccepted: boolean|null) => void} processShareCB @returns {void} */
    function processShare(miner, job, blockTemplate, params, processShareCB) {
        const port = blockTemplate.port;
        const trustKey = getMinerTrustKey(miner);
        const profile = global.coinFuncs.getJobProfile(job);
        const poolSettings = profile && profile.pool ? profile.pool : {};
        const finalProcessShareCB = processShareCB;
        let forceVerifyTrusted = false;
        let isQueuedTrustedShare = false;
        /** @type {(() => void)|null} */
        let queuedShareCompletion = null;
        let shareProcessingCompleted = false;
        let walletVerificationStarted = false;

        /** @param {boolean|null} shareAccepted @returns {void} */
        // eslint-disable-next-line no-param-reassign -- intentionally wraps the caller's callback in place; ~20 downstream call sites invoke the wrapped form
        processShareCB = function finishShareProcessing(shareAccepted) {
            if (shareProcessingCompleted) return;
            shareProcessingCompleted = true;

            const gate = trustVerificationGates.get(trustKey);
            const hasQueuedGeneration = gate && (gate.queue.length || gate.draining);
            if (
                (walletVerificationStarted && shareAccepted === null) ||
                (shareAccepted === false && hasQueuedGeneration)
            ) {
                markTrustVerificationFailed(miner, trustKey);
            }
            if (walletVerificationStarted) finishTrustVerification(trustKey);

            try {
                finalProcessShareCB(shareAccepted);
            } finally {
                if (queuedShareCompletion) queuedShareCompletion();
            }
        };

        const minerWallet = minerWallets[miner.payout];
        if (minerWallet) {
            minerWallet.hashes += job.norm_diff;
            const threshold = Number(global.config.pool["minerThrottleSharePerSec"]) * Number(global.config.pool["minerThrottleShareWindow"]);
            if (!miner.whiteList && ++minerWallet.last_ver_shares > threshold) {
                processSend({ type: "throttledShare" });
                if (addProxyMiner(miner)) {
                    const proxyMinerName = miner.payout;
                    const proxyMiner = proxyMiners[proxyMinerName];
                    if (proxyMiner) {
                        proxyMiner.hashes += job.norm_diff;
                        proxyMiner.submissionBudget = true;
                    }
                    adjustMinerDiff(miner);
                }
                return processShareCB(null);
            }
        }

        /** @returns {void} */
        function startAsyncVerification() {
            if (walletVerificationStarted) return;
            walletVerificationStarted = true;
            getTrustVerificationGate(trustKey, miner.payout).inFlight += 1;
        }

        /** @param {() => void} resumeShareProcessing @returns {void} */
        function enqueueTrustedShare(resumeShareProcessing) {
            const gate = getTrustVerificationGate(trustKey, miner.payout);
            if (gate.queue.length >= getTrustedQueueLimit(miner.payout)) {
                processSend({ type: "throttledShare" });
                processShareCB(null);
                return;
            }

            gate.queue.push({
                run(forceVerify, done) {
                    forceVerifyTrusted = forceVerify;
                    isQueuedTrustedShare = true;
                    queuedShareCompletion = done;
                    resumeShareProcessing();
                },
                cancel() { processShareCB(null); }
            });
        }

        /** @param {() => void} onTrustedShare @param {() => void} resumeShareProcessing @returns {boolean} */
        function tryTrustedShare(onTrustedShare, resumeShareProcessing) {
            if (
                forceVerifyTrusted ||
                !global.config.pool.trustedMiners ||
                !miner.trust ||
                !isSafeToTrust(job.rewarded_difficulty2, trustKey, miner.trust.trust) ||
                miner.trust.check_height === job.height
            ) return false;

            const gate = trustVerificationGates.get(trustKey);
            if (!isQueuedTrustedShare && gate && (gate.inFlight || gate.draining || gate.queue.length)) {
                enqueueTrustedShare(resumeShareProcessing);
                return true;
            }
            onTrustedShare();
            return true;
        }

        /** @param {number|bigint} hashDiff @returns {boolean} */
        function isBlockCandidateDiff(hashDiff) {
            const childTemplate = blockTemplate.child_template;
            return ge(hashDiff, blockTemplate.difficulty) ||
                Boolean(childTemplate && ge(hashDiff, childTemplate.difficulty));
        }

        /** @param {ShareVerificationCallback} verifyShareCB @returns {boolean} */
        function runSpecialShareVerifier(verifyShareCB) {
            return typeof poolSettings.verifySpecialShare === "function" && poolSettings.verifySpecialShare({
                bigIntToBuffer,
                blockTemplate,
                coinFuncs: global.coinFuncs,
                getBlockSubmitTestResultBuffer() {
                    return getBlockSubmitTestResultBuffer(miner, job, params);
                },
                getShareBuffer() {
                    return getShareBuffer(miner, job, blockTemplate, params);
                },
                hashBuffDiff,
                hashEthBuffDiff,
                hashRavenBuffDiff,
                ge,
                invalidShare,
                isBlockCandidateDiff,
                isSafeToTrust,
                job,
                miner,
                params,
                processShareCB,
                reportMinerShare,
                startAsyncVerification,
                trustKey,
                tryTrustedShare(onTrustedShare) {
                    return tryTrustedShare(onTrustedShare, function retrySpecialShare() {
                        runSpecialShareVerifier(verifyShareCB);
                    });
                },
                verifySlowHashWithRetry,
                verifyShareCB: function specialVerifyShareCB(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
                    verifyShareCB(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff);
                }
            });
        }

        /** @returns {VerifyResult|null} */
        function buildVerifyResult() {
            const syntheticResultBuff = getBlockSubmitTestResultBuffer(miner, job, params);
            const resultHash = syntheticResultBuff ? syntheticResultBuff.toString("hex") : params.result;
            if (typeof resultHash !== "string") {
                processShareCB(invalidShare(miner));
                return null;
            }
            let resultBuff = syntheticResultBuff;
            if (!resultBuff) {
                try {
                    resultBuff = Buffer.from(resultHash, "hex");
                } catch (_error) {
                    processShareCB(invalidShare(miner));
                    return null;
                }
            }
            return { resultHash, resultBuff, hashDiff: hashBuffDiff(resultBuff) };
        }

        /** @param {number|bigint} hashDiff @param {Buffer} resultBuff @param {ShareVerificationCallback} verifyShareCB @returns {boolean} */
        function verifyBlockSubmitTestBypass(hashDiff, resultBuff, verifyShareCB) {
            const allowUntrustedBlockSubmitTest = isBlockSubmitTestBypassEnabled(miner) && !hasBlockSubmitTrust(miner);
            if (!(allowUntrustedBlockSubmitTest && ge(hashDiff, blockTemplate.difficulty))) return false;
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalidShare(miner)), true;
            verifyShareCB(hashDiff, resultBuff, blockData, true, true);
            return true;
        }

        /** @param {Buffer|null} blockData @param {string} resultHash @returns {void} */
        function verifyExtraWalletHash(blockData, resultHash) {
            if (!(miner.payout in extraWalletVerify)) return;
            if (blockData === null) {
                console.error(`${getThreadName()  }IMPORTANT: ${  formatPoolEvent("Verify", {
                    action: "share-buffer-failed",
                    miner: miner.logString,
                    chain: formatCoinPort(job.coin, port)
                })}`);
                return;
            }
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
            if (!convertedBlob) return;
            global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function (hash) {
                if (hash === null || hash === false) {
                    console.error(`${getThreadName()  }IMPORTANT: ${  formatPoolEvent("Verify", {
                        action: "remote-failed",
                        chain: formatCoinPort(job.coin, port)
                    })}`);
                } else if (hash !== resultHash) {
                    console.error(`${getThreadName()  }IMPORTANT: ${  formatPoolEvent("Verify", {
                        action: "invalid-share",
                        miner: miner.logString,
                        rewardDiff: job.rewarded_difficulty2
                    })}`);
                } else {
                    extraVerifyWalletHashes.push(`${miner.payout  } ${  convertedBlob.toString("hex")  } ${  resultHash  } ${  global.coinFuncs.algoShortTypeStr(port)  } ${  blockTemplate.height  } ${  blockTemplate.seed_hash}`);
                }
            });
        }

        /** @param {number|bigint} hashDiff @param {Buffer} resultBuff @param {string} resultHash @param {ShareVerificationCallback} verifyShareCB @returns {boolean} */
        function verifyTrustedShare(hashDiff, resultBuff, resultHash, verifyShareCB) {
            if (isBlockCandidateDiff(hashDiff)) return false;
            return tryTrustedShare(function acceptTrustedShare() {
                let blockData = null;
                if (miner.payout in extraWalletVerify) blockData = getShareBuffer(miner, job, blockTemplate, params);
                verifyExtraWalletHash(blockData, resultHash);
                if (miner.lastSlowHashAsyncDelay) {
                    setTimeout(function () { return verifyShareCB(hashDiff, resultBuff, blockData, true, true); }, miner.lastSlowHashAsyncDelay);
                    if (debug.enabled) debug(`MINER: ${  formatPoolEvent("Verify delay", { ms: miner.lastSlowHashAsyncDelay })}`);
                } else {
                    verifyShareCB(hashDiff, resultBuff, blockData, true, true);
                }
            }, function retryTrustedShare() {
                verifyShare(verifyShareCB);
            });
        }

        /** @param {number|bigint} hashDiff @param {Buffer} resultBuff @param {ShareBlockData|null} blockData @param {Buffer} convertedBlob @param {ShareVerificationCallback} verifyShareCB @returns {boolean} */
        function verifyBlockCandidate(hashDiff, resultBuff, blockData, convertedBlob, verifyShareCB) {
            if (!ge(hashDiff, blockTemplate.difficulty)) return false;
            if (blockData === null) return false;
            startAsyncVerification();
            const resultHash = resultBuff.toString("hex");
            /** @type {(onVerified: () => void, onVerifierUnavailable: (hash?: string|null|false, errorKind?: string) => void) => void} */
            const verifyCandidateHash = function (onVerified, onVerifierUnavailable) {
                verifySlowHashWithRetry(convertedBlob, null, function onCandidateHash(hash, errorKind) {
                    if (isVerifierUnavailable(hash, errorKind)) return onVerifierUnavailable(hash, errorKind);
                    if (hash !== resultHash) {
                        reportMinerShare(miner, job);
                        return processShareCB(invalidShare(miner));
                    }
                    return onVerified();
                });
            };
            const submitUnverifiedCandidate = function () {
                submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, false, true, null, function (blockSubmitResult) {
                    if (!blockSubmitResult) return processShareCB(null);
                    addWalletTrust(miner, job.rewarded_difficulty2);
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                }, params, undefined);
            };
            if (hasBlockSubmitTrust(miner)) {
                submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, true, true, null, function (blockSubmitResult) {
                    if (!blockSubmitResult) {
                        return verifyCandidateHash(function onVerifiedFailedSubmit() {
                            addWalletTrust(miner, job.rewarded_difficulty2);
                            return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                        }, function onUnavailableAfterFailedSubmit() {
                            return processShareCB(null);
                        });
                    }
                    addWalletTrust(miner, job.rewarded_difficulty2);
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                }, params, undefined);
                return true;
            }
            verifyCandidateHash(function onVerifiedCandidate() {
                addWalletTrust(miner, job.rewarded_difficulty2);
                verifyShareCB(hashDiff, resultBuff, blockData, false, true);
            }, function onUnavailableCandidate() {
                submitUnverifiedCandidate();
            });
            return true;
        }

        /** @param {number|bigint} hashDiff @param {Buffer} resultBuff @param {string} resultHash @param {ShareBlockData|null} blockData @param {Buffer} convertedBlob @param {ShareVerificationCallback} verifyShareCB @returns {void} */
        function verifySlowShare(hashDiff, resultBuff, resultHash, blockData, convertedBlob, verifyShareCB) {
            const timeNow = Date.now();
            verifySlowHashWithRetry(convertedBlob, null, function onVerifiedHash(hash) {
                if (hash === null) return processShareCB(null);
                if (hash !== resultHash) {
                    reportMinerShare(miner, job);
                    return processShareCB(invalidShare(miner));
                }
                miner.lastSlowHashAsyncDelay = Date.now() - timeNow;
                if (miner.lastSlowHashAsyncDelay > 1000) miner.lastSlowHashAsyncDelay = 1000;
                addWalletTrust(miner, job.rewarded_difficulty2);
                return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
            });
        }

        /** @param {Buffer} convertedBlob @param {{nonce?: string, mixhash?: string}|null} verifyContext @param {(hash: string|null|false, errorKind?: string) => void} verifiedHashCB @returns {void} */
        function verifySlowHashWithRetry(convertedBlob, verifyContext, verifiedHashCB) {
            startAsyncVerification();
            const maxRetries = getVerifyRetryLimit();
            const retryDelayMs = getVerifyRetryDelayMs();
            let retries = 0;
            const verifyOnce = function () {
                global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function (hash, errorKind) {
                    if (hash === null) return verifiedHashCB(hash, errorKind);
                    if (isRetryableVerifyFailure(hash, errorKind)) {
                        if (retries < maxRetries) {
                            retries += 1;
                            return setTimeout(verifyOnce, retryDelayMs);
                        }
                        return verifiedHashCB(null, errorKind);
                    }
                    return verifiedHashCB(hash, errorKind);
                }, verifyContext || undefined);
            };
            verifyOnce();
        }

        /** @param {ShareVerificationCallback} verifyShareCB @returns {void} */
        const verifyShare = function (verifyShareCB) {
            if (runSpecialShareVerifier(verifyShareCB)) return;
            const result = buildVerifyResult();
            if (!result) return;
            if (verifyBlockSubmitTestBypass(result.hashDiff, result.resultBuff, verifyShareCB)) return;
            if (verifyTrustedShare(result.hashDiff, result.resultBuff, result.resultHash, verifyShareCB)) return;
            if (miner.debugMiner) console.log(`${getThreadName()  }WALLET DEBUG: ${  formatPoolEvent("Verify share", {
                miner: miner.logString,
                chain: formatCoinPort(job.coin, port)
            })}`);
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalidShare(miner));
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
            if (!convertedBlob) return processShareCB(invalidShare(miner));
            if (verifyBlockCandidate(result.hashDiff, result.resultBuff, blockData, convertedBlob, verifyShareCB)) return;
            verifySlowShare(result.hashDiff, result.resultBuff, result.resultHash, blockData, convertedBlob, verifyShareCB);
        };

        /** @param {ShareBlockData|null} blockData @returns {ShareBlockData|null} */
        function getVerifiedBlockData(blockData) {
            if (blockData) return blockData;
            const nextBlockData = getShareBuffer(miner, job, blockTemplate, params);
            if (!nextBlockData) processShareCB(invalidShare(miner));
            return nextBlockData;
        }

        /** @param {number|bigint} hashDiff @param {Buffer|null} resultBuff @param {ShareBlockData|null} blockData @param {boolean} isTrustedShare @param {boolean} isNeedCheckBlockDiff @returns {boolean} */
        function submitMainBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
            const allowUntrustedBlockSubmitTest = isBlockSubmitTestBypassEnabled(miner) && !hasBlockSubmitTrust(miner);
            if (!isNeedCheckBlockDiff || !ge(hashDiff, blockTemplate.difficulty)) return false;
            const nextBlockData = getVerifiedBlockData(blockData);
            if (!nextBlockData) return true;
            if (allowUntrustedBlockSubmitTest) {
                submitBlock(miner, job, blockTemplate, nextBlockData, resultBuff, hashDiff, true, true, null, function onTestModeSubmit() {
                    return processShareCB(true);
                }, params, undefined);
            } else {
                submitBlock(miner, job, blockTemplate, nextBlockData, resultBuff, hashDiff, isTrustedShare, true, null, null, params, undefined);
            }
            return allowUntrustedBlockSubmitTest;
        }

        /** @param {Buffer} blockData @returns {Buffer|null} */
        function buildChildShareBuffer(blockData) {
            try {
                if (!blockTemplate.child_template_buffer) throw new Error("Merged-mining child template buffer is unavailable");
                blockTemplate.child_template_buffer = Buffer.from(blockTemplate.child_template_buffer);
                return global.coinFuncs.constructMMChildBlockBlob(blockData, port, blockTemplate.child_template_buffer);
            } catch (error) {
                const errStr = getThreadName() + formatPoolEvent("MM child blob build failed", {
                    chain: formatCoinPort(job.coin, port),
                    miner: miner.logString,
                    error: error instanceof Error ? error.message : String(error)
                });
                console.error(errStr);
                global.support.sendAdminFyi(`pool:construct-mm-child-blob:${  port}`, "FYI: Can't construct_mm_child_block_blob", errStr);
                processShareCB(invalidShare(miner));
                return null;
            }
        }

        /** @param {number|bigint} hashDiff @param {Buffer|null} resultBuff @param {Buffer|unknown[]|string|null} blockData @param {boolean} isTrustedShare @returns {boolean} */
        function submitChildBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare) {
            const childTemplate = blockTemplate.child_template;
            if (!childTemplate || !ge(hashDiff, childTemplate.difficulty)) return true;
            const nextBlockData = getVerifiedBlockData(blockData);
            if (!nextBlockData) return false;
            if (!Buffer.isBuffer(nextBlockData)) return processShareCB(invalidShare(miner)), false;
            const shareBuffer2 = buildChildShareBuffer(nextBlockData);
            if (shareBuffer2 === null) return false;
            submitBlock(miner, job, childTemplate, shareBuffer2, resultBuff, hashDiff, isTrustedShare, false, null, null, params, undefined);
            return true;
        }

        verifyShare(function (hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
            if (submitMainBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff)) return;

            const childTemplate = blockTemplate.child_template;
            const isMm = Boolean(childTemplate);
            if (!submitChildBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare)) return;

            if (!ge(hashDiff, job.difficulty)) {
                const timeNow = Date.now();
                const lastMinerLogTime = getLastMinerLogTime();
                const lastLogTime = lastMinerLogTime[miner.payout];
                if (lastLogTime === undefined || timeNow - lastLogTime > 30 * 1000) {
                    console.warn(getThreadName() + formatPoolEvent("Low diff share", {
                        hashDiff,
                        needed: job.difficulty,
                        miner: miner.logString
                    }));
                    lastMinerLogTime[miner.payout] = timeNow;
                    setLastMinerLogTime(lastMinerLogTime);
                }
                return processShareCB(invalidShare(miner));
            }

            recordShareData(miner, job, isTrustedShare, blockTemplate);
            if (isMm) {
                job.rewarded_difficulty2 = 0;
                if (childTemplate) recordShareData(miner, job, isTrustedShare, childTemplate);
            }
            return processShareCB(true);
        });
    }

    function resetShareState() {
        for (const [trustKey, gate] of trustVerificationGates) dropTrustedQueue(trustKey, gate);
        trustVerificationGates.clear();
        for (const key of Object.keys(walletAcc)) delete walletAcc[key];
        for (const key of Object.keys(walletWorkerCount)) delete walletWorkerCount[key];
        for (const key of Object.keys(isWalletAccFinalizer)) delete isWalletAccFinalizer[key];
        for (const key of Object.keys(extraWalletVerify)) delete extraWalletVerify[key];
        extraVerifyWalletHashes.length = 0;
    }

    /** @param {string[]} entries @returns {void} */
    function replaceExtraWalletVerify(entries) {
        for (const key of Object.keys(extraWalletVerify)) delete extraWalletVerify[key];
        for (const entry of entries) extraWalletVerify[entry] = 1;
    }

    function drainExtraVerifyWalletHashes() {
        const hashes = extraVerifyWalletHashes.slice();
        extraVerifyWalletHashes.length = 0;
        return hashes;
    }

    return {
        processShare,
        resetShareState,
        replaceExtraWalletVerify,
        drainExtraVerifyWalletHashes
    };
};
