"use strict";
const createShareBlockHelpers = require("./share_blocks.js");

const HEX_64_PATTERN = /^(?:0x)?([0-9a-f]{64})$/i;

// Share processing is the hottest code path in the pool. This module keeps the
// verification/submission pipeline together so the entrypoint only wires
// dependencies and protocol handlers.
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

    const walletAcc = {};
    const walletWorkerCount = {};
    const isWalletAccFinalizer = {};
    const extraWalletVerify = {};
    const extraVerifyWalletHashes = [];
    const walletVerificationGates = new Map();
    const shareBlockHelpers = createShareBlockHelpers({
        crypto,
        debug,
        divideBaseDiff,
        bigIntFromBuffer,
        bigIntToBuffer,
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

    function normalizeSyntheticResultHex(value) {
        if (typeof value !== "string") return "";
        const match = value.trim().match(HEX_64_PATTERN);
        return match ? match[1].toLowerCase() : "";
    }

    function isLoopbackAddress(ipAddress) {
        return ipAddress === "::1" || ipAddress === "::ffff:127.0.0.1" || (typeof ipAddress === "string" && ipAddress.startsWith("127."));
    }

    function isBlockSubmitTestBypassEnabled(miner) {
        return isBlockSubmitTestModeEnabled() === true && isLoopbackAddress(miner && miner.ipAddress);
    }

    function getBlockSubmitTestResultBuffer(miner, job, params) {
        if (!isBlockSubmitTestBypassEnabled(miner)) return null;
        const rawParams = params && params.raw_params instanceof Array ? params.raw_params : null;
        const minParamLength = job && job.coin === "ERG" ? 4 : 6;
        const rawResult = rawParams && rawParams.length >= minParamLength ? rawParams[rawParams.length - 1] : "";
        const fallbackRawResult = rawParams && rawParams.length >= 6 ? rawParams[rawParams.length - 1] : "";
        const coinResult = job && ["XTM-C", "", "XTM-T", "RTM", "ARQ"].includes(job.coin) ? params && params.result : "";
        const resultHex = [params && params.block_submit_test_result, rawResult, coinResult, fallbackRawResult].map(normalizeSyntheticResultHex).find(Boolean);
        return resultHex ? Buffer.from(resultHex, "hex") : null;
    }

    function hasBlockSubmitTrust(miner) {
        return !!(miner.validShares || (miner.payout in walletTrust && walletTrust[miner.payout] > 0));
    }

    function ensureWalletTrustEntry(miner) {
        if (!(miner.payout in walletTrust)) walletTrust[miner.payout] = 0;
        walletLastSeeTime[miner.payout] = Date.now();
    }

    function getVerifyRetryLimit() {
        const verifyConfig = global.config.pool && global.config.pool.verifyShareRetry;
        if (!verifyConfig || typeof verifyConfig.maxRetries !== "number") return 3;
        return Math.max(0, Math.floor(verifyConfig.maxRetries));
    }

    function getVerifyRetryDelayMs() {
        const verifyConfig = global.config.pool && global.config.pool.verifyShareRetry;
        if (!verifyConfig || typeof verifyConfig.retryDelayMs !== "number") return 30;
        return Math.max(0, Math.floor(verifyConfig.retryDelayMs));
    }

    function isRetryableVerifyFailure(hash, errorKind) {
        return hash === false && errorKind === "verify-host-error";
    }

    function isVerifierUnavailable(hash, errorKind) {
        return hash === null || isRetryableVerifyFailure(hash, errorKind);
    }

    // Only trusted-path shares wait here. Normal verification stays parallel.
    function getWalletVerificationGate(payout) {
        let gate = walletVerificationGates.get(payout);
        if (!gate) {
            gate = { inFlight: 0, queue: [], draining: false, forceVerify: false };
            walletVerificationGates.set(payout, gate);
        }
        return gate;
    }

    function getTrustedQueueLimit(payout) {
        const configuredLimit = Number(global.config.pool.minerThrottleSharePerSec) *
            Number(global.config.pool.minerThrottleShareWindow);
        const baseLimit = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 25;
        const proxy = proxyMiners[payout];
        return baseLimit * (proxy && proxy.submissionBudget === true ? 10 : 1);
    }

    function dropTrustedQueue(payout, gate) {
        walletVerificationGates.delete(payout);
        for (const entry of gate.queue.splice(0)) entry.cancel();
    }

    function drainTrustedQueue(payout) {
        const gate = walletVerificationGates.get(payout);
        if (!gate || gate.inFlight || gate.draining) return;
        if (isWalletBanned(payout)) return dropTrustedQueue(payout, gate);
        const entry = gate.queue.shift();
        if (!entry) {
            walletVerificationGates.delete(payout);
            return;
        }

        gate.draining = true;
        setImmediate(entry.run, gate.forceVerify, function onQueuedShareProcessed() {
            const currentGate = walletVerificationGates.get(payout);
            if (currentGate !== gate) return;
            gate.draining = false;
            if (!gate.queue.length) gate.forceVerify = false;
            drainTrustedQueue(payout);
        });
    }

    function finishWalletVerification(payout) {
        const gate = walletVerificationGates.get(payout);
        if (gate && gate.inFlight > 0) gate.inFlight -= 1;
        drainTrustedQueue(payout);
    }

    function markWalletVerificationFailed(payout) {
        const gate = walletVerificationGates.get(payout);
        // A failed check invalidates the whole queued generation.
        if (gate && (gate.queue.length || gate.draining)) gate.forceVerify = true;
        clearWalletSessionTrust(payout);
        if (payout in walletTrust) walletTrust[payout] = 0;
    }

    function storeShareDiv(miner, rawShareReward, shareReward2, shareNum, workerName, btPort, btHeight, btDifficulty, isBlockCandidate, isTrustedShare) {
        const timeNow = Date.now();
        if (miner.payout_div === null) {
            global.database.storeShare(btHeight, global.protos.Share.encode({
                paymentAddress: miner.address,
                paymentID: miner.paymentID,
                raw_shares: rawShareReward,
                shares2: shareReward2,
                share_num: shareNum,
                identifier: workerName,
                port: btPort,
                blockHeight: btHeight,
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
            const paymentAddress = payoutSplit[0];
            const paymentID = payoutSplit.length === 2 ? payoutSplit[1] : null;
            const payoutPercent = miner.payout_div[payout];
            global.database.storeShare(btHeight, global.protos.Share.encode({
                paymentAddress,
                paymentID,
                raw_shares: rawShareReward * payoutPercent / 100,
                shares2: Math.floor(shareReward2 * payoutPercent / 100),
                share_num: shareNum,
                identifier: workerName,
                port: btPort,
                blockHeight: btHeight,
                blockDiff: btDifficulty,
                poolType: miner.poolTypeEnum,
                foundBlock: isBlockCandidate,
                trustedShare: isTrustedShare,
                poolID: global.config.pool_id,
                timestamp: timeNow
            }));
        }
    }

    function getRawShareReward(job) {
        const hashesPerDifficulty = Number(job.hashesPerDifficulty || 1);
        return job.rewarded_difficulty * (Number.isFinite(hashesPerDifficulty) && hashesPerDifficulty > 0 ? hashesPerDifficulty : 1);
    }


    function getShareAccTimeMs() {
        const configured = Number(global.config && global.config.pool && global.config.pool.shareAccTime);
        if (!Number.isFinite(configured) || configured < 0) return 60 * 1000;
        return configured * 1000;
    }

    function walletAccFinalizer(walletKey, miner, btPort) {
        debug(formatPoolEvent("Share acc scan", { wallet: walletKey }));
        const wallet = walletAcc[walletKey];
        let isSomethingLeft = false;
        const timeNow = Date.now();
        for (const workerName in wallet) {
            const worker = wallet[workerName];
            if (timeNow - worker.time > getShareAccTimeMs()) {
                if (worker.acc != 0) {
                    debug(formatPoolEvent("Share acc flush", {
                        wallet: walletKey,
                        worker: workerName,
                        height: worker.height,
                        diff: worker.difficulty,
                        time: timeNow,
                        acc: worker.acc
                    }));
                    storeShareDiv(miner, worker.raw_acc, worker.acc2, worker.share_num, workerName, btPort, worker.height, worker.difficulty, false, worker.trustedShare);
                }
                debug(formatPoolEvent("Share acc worker remove", { wallet: walletKey, worker: workerName }));
                if (workerName !== "all_other_workers") --walletWorkerCount[walletKey];
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

    function recordShareData(miner, job, isTrustedShare, blockTemplate) {
        miner.hashes += job.norm_diff;
        const proxyMinerName = miner.payout;
        if (proxyMinerName in proxyMiners) {
            proxyMiners[proxyMinerName].hashes += job.norm_diff;
            proxyMiners[proxyMinerName].submissionBudget = true;
        }
        if (miner.payout in walletTrust) walletLastSeeTime[miner.payout] = Date.now();

        const timeNow = Date.now();
        const walletKey = miner.wallet_key + blockTemplate.port;
        if (!(walletKey in walletAcc)) {
            walletAcc[walletKey] = {};
            walletWorkerCount[walletKey] = 0;
            isWalletAccFinalizer[walletKey] = false;
        }

        const dbJobHeight = global.config.daemon.port == blockTemplate.port ? blockTemplate.height : anchorState.current;
        const wallet = walletAcc[walletKey];
        const workerName = miner.identifier in wallet || walletWorkerCount[walletKey] < 50 ? miner.identifier : "all_other_workers";

        if (!(workerName in wallet)) addShareWorker(wallet, walletKey, workerName, dbJobHeight, blockTemplate, timeNow, isTrustedShare);

        const worker = wallet[workerName];
        updateShareWorker(miner, job, worker, workerName, walletKey, blockTemplate, dbJobHeight, timeNow, isTrustedShare);

        debug(formatPoolEvent("Share acc update", {
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
        debug(getThreadName() + formatPoolEvent("Share accepted", {
            mode: isTrustedShare ? "trusted" : "valid",
            chain: formatCoinPort(job.coin, blockTemplate.port),
            diff: job.difficulty,
            rewardDiff: job.rewarded_difficulty,
            miner: miner.logString
        }));
        if (activeBlockTemplates[job.coin].idHash !== blockTemplate.idHash) {
            processSend({ type: "outdatedShare" });
        }
    }

    function addShareWorker(wallet, walletKey, workerName, dbJobHeight, blockTemplate, timeNow, isTrustedShare) {
        if (workerName !== "all_other_workers") ++walletWorkerCount[walletKey];
        debug(formatPoolEvent("Share acc worker add", { wallet: walletKey, worker: workerName, workers: walletWorkerCount[walletKey] }));
        wallet[workerName] = { height: dbJobHeight, difficulty: blockTemplate.difficulty, time: timeNow, acc: 0, raw_acc: 0, acc2: 0, share_num: 0, trustedShare: isTrustedShare };
    }

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
        if (worker.acc != 0) {
            debug(formatPoolEvent("Share acc flush", { wallet: walletKey, worker: workerName, height: worker.height, diff: worker.difficulty, time: timeNow, acc: worker.acc }));
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

    function getShareBuffer(miner, job, blockTemplate, params) {
        try {
            const template = Buffer.alloc(blockTemplate.buffer.length);
            blockTemplate.buffer.copy(template);
            template.writeUInt32BE(job.extraNonce, blockTemplate.reserved_offset);
            if (job.usesProxyNonce) {
                template.writeUInt32BE(params.poolNonce, job.clientPoolLocation);
                template.writeUInt32BE(params.workerNonce, job.clientNonceLocation);
            }
            return global.coinFuncs.constructNewBlob(template, params, blockTemplate.port);
        } catch (error) {
            const errStr = getThreadName() + formatPoolEvent("Blob build failed", {
                chain: formatCoinPort(job.coin, blockTemplate.port),
                miner: miner.logString,
                params,
                error: error && error.message ? error.message : String(error)
            });
            console.error(errStr);
            global.support.sendAdminFyi("pool:construct-new-blob:" + blockTemplate.port, "FYI: Can't constructNewBlob", errStr);
            return null;
        }
    }

    function processShare(miner, job, blockTemplate, params, processShareCB) {
        const port = blockTemplate.port;
        const profile = global.coinFuncs.getJobProfile(job);
        const poolSettings = profile && profile.pool ? profile.pool : {};
        const finalProcessShareCB = processShareCB;
        let forceVerifyTrusted = false;
        let isQueuedTrustedShare = false;
        let queuedShareCompletion = null;
        let shareProcessingCompleted = false;
        let shareThrottleChecked = false;
        let walletVerificationStarted = false;

        processShareCB = function finishShareProcessing(shareAccepted) {
            if (shareProcessingCompleted) return;
            shareProcessingCompleted = true;
            // A ban may arrive after an entry left the queue but before it finishes.
            if (isQueuedTrustedShare && shareAccepted === true && isWalletBanned(miner.payout)) shareAccepted = null;

            const gate = walletVerificationGates.get(miner.payout);
            const hasQueuedGeneration = gate && (gate.queue.length || gate.draining);
            if (
                (walletVerificationStarted && shareAccepted === null) ||
                (shareAccepted === false && hasQueuedGeneration)
            ) {
                markWalletVerificationFailed(miner.payout);
            }
            if (walletVerificationStarted) finishWalletVerification(miner.payout);

            try {
                finalProcessShareCB(shareAccepted);
            } finally {
                if (queuedShareCompletion) queuedShareCompletion();
            }
        };

        if (miner.payout in minerWallets) minerWallets[miner.payout].hashes += job.norm_diff;

        const shareThrottled = function (nextProcessShareCB) {
            if (shareThrottleChecked) return false;
            shareThrottleChecked = true;
            if (miner.payout in minerWallets) {
                const lastVerShares = ++minerWallets[miner.payout].last_ver_shares;
                const threshold = global.config.pool.minerThrottleSharePerSec * global.config.pool.minerThrottleShareWindow;
                if (lastVerShares > threshold) {
                    if (lastVerShares == threshold) {
                        console.error(getThreadName() + formatPoolEvent("Share throttled", {
                            diff: job.rewarded_difficulty2,
                            miner: miner.logString
                        }));
                    } else {
                        const throttleInvalidMultiplier = job.rewarded_difficulty2 >= 10000000 ? 10 : 1000;
                        if (threshold > 0 && lastVerShares > throttleInvalidMultiplier * threshold) {
                            console.error(getThreadName() + formatPoolEvent("Share throttled-invalid", {
                                diff: job.rewarded_difficulty2,
                                miner: miner.logString
                            }));
                            invalidShare(miner);
                            nextProcessShareCB(false);
                            return true;
                        }
                    }
                    processSend({ type: "throttledShare" });
                    if (addProxyMiner(miner)) {
                        const proxyMinerName = miner.payout;
                        proxyMiners[proxyMinerName].hashes += job.norm_diff;
                        proxyMiners[proxyMinerName].submissionBudget = true;
                        adjustMinerDiff(miner);
                    }
                    nextProcessShareCB(null);
                    return true;
                }
            }
            return false;
        };

        function startAsyncVerification() {
            if (walletVerificationStarted) return;
            walletVerificationStarted = true;
            getWalletVerificationGate(miner.payout).inFlight += 1;
        }

        function enqueueTrustedShare(resumeShareProcessing) {
            const gate = getWalletVerificationGate(miner.payout);
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

        function tryTrustedShare(onTrustedShare, resumeShareProcessing) {
            if (
                forceVerifyTrusted ||
                !global.config.pool.trustedMiners ||
                !isSafeToTrust(job.rewarded_difficulty2, miner.payout, miner.trust.trust) ||
                miner.trust.check_height === job.height
            ) return false;

            const gate = walletVerificationGates.get(miner.payout);
            if (!isQueuedTrustedShare && gate && (gate.inFlight || gate.draining || gate.queue.length)) {
                enqueueTrustedShare(resumeShareProcessing);
                return true;
            }
            onTrustedShare();
            return true;
        }

        function isBlockCandidateDiff(hashDiff) {
            return ge(hashDiff, blockTemplate.difficulty) ||
                ("child_template" in blockTemplate && ge(hashDiff, blockTemplate.child_template.difficulty));
        }

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
                shareThrottled() {
                    return shareThrottled(processShareCB);
                },
                startAsyncVerification,
                tryTrustedShare(onTrustedShare) {
                    return tryTrustedShare(onTrustedShare, function retrySpecialShare() {
                        runSpecialShareVerifier(verifyShareCB);
                    });
                },
                verifySlowHashWithRetry,
                verifyShareCB
            });
        }

        function buildVerifyResult() {
            const syntheticResultBuff = getBlockSubmitTestResultBuffer(miner, job, params);
            const resultHash = syntheticResultBuff ? syntheticResultBuff.toString("hex") : params.result;
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

        function verifyBlockSubmitTestBypass(hashDiff, resultBuff, verifyShareCB) {
            const allowUntrustedBlockSubmitTest = isBlockSubmitTestBypassEnabled(miner) && !hasBlockSubmitTrust(miner);
            if (!(allowUntrustedBlockSubmitTest && ge(hashDiff, blockTemplate.difficulty))) return false;
            if (shareThrottled(processShareCB)) return true;
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalidShare(miner)), true;
            verifyShareCB(hashDiff, resultBuff, blockData, true, true);
            return true;
        }

        function verifyExtraWalletHash(blockData, resultHash) {
            if (!(miner.payout in extraWalletVerify)) return;
            if (blockData === null) {
                console.error(getThreadName() + "IMPORTANT: " + formatPoolEvent("Verify", {
                    action: "share-buffer-failed",
                    miner: miner.logString,
                    chain: formatCoinPort(job.coin, port)
                }));
                return;
            }
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
            global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function (hash) {
                if (hash === null || hash === false) {
                    console.error(getThreadName() + "IMPORTANT: " + formatPoolEvent("Verify", {
                        action: "remote-failed",
                        chain: formatCoinPort(job.coin, port)
                    }));
                } else if (hash !== resultHash) {
                    console.error(getThreadName() + "IMPORTANT: " + formatPoolEvent("Verify", {
                        action: "invalid-share",
                        miner: miner.logString,
                        rewardDiff: job.rewarded_difficulty2
                    }));
                } else {
                    extraVerifyWalletHashes.push(miner.payout + " " + convertedBlob.toString("hex") + " " + resultHash + " " + global.coinFuncs.algoShortTypeStr(port) + " " + blockTemplate.height + " " + blockTemplate.seed_hash);
                }
            });
        }

        function verifyTrustedShare(hashDiff, resultBuff, resultHash, verifyShareCB) {
            if (isBlockCandidateDiff(hashDiff)) return false;
            return tryTrustedShare(function acceptTrustedShare() {
                let blockData = null;
                if (miner.payout in extraWalletVerify) blockData = getShareBuffer(miner, job, blockTemplate, params);
                verifyExtraWalletHash(blockData, resultHash);
                if (miner.lastSlowHashAsyncDelay) {
                    setTimeout(function () { return verifyShareCB(hashDiff, resultBuff, blockData, true, true); }, miner.lastSlowHashAsyncDelay);
                    debug("MINER: " + formatPoolEvent("Verify delay", { ms: miner.lastSlowHashAsyncDelay }));
                } else {
                    verifyShareCB(hashDiff, resultBuff, blockData, true, true);
                }
            }, function retryTrustedShare() {
                verifyShare(verifyShareCB);
            });
        }

        function verifyBlockCandidate(hashDiff, resultBuff, blockData, convertedBlob, verifyShareCB) {
            if (!ge(hashDiff, blockTemplate.difficulty)) return false;
            startAsyncVerification();
            const resultHash = resultBuff.toString("hex");
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
                    ensureWalletTrustEntry(miner);
                    walletTrust[miner.payout] += job.rewarded_difficulty2;
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                }, params);
            };
            if (miner.validShares || (miner.payout in walletTrust && walletTrust[miner.payout] > 0)) {
                submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, true, true, null, function (blockSubmitResult) {
                    if (!blockSubmitResult) {
                        return verifyCandidateHash(function onVerifiedFailedSubmit() {
                            ensureWalletTrustEntry(miner);
                            walletTrust[miner.payout] += job.rewarded_difficulty2;
                            return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                        }, function onUnavailableAfterFailedSubmit() {
                            return processShareCB(null);
                        });
                    }
                    ensureWalletTrustEntry(miner);
                    walletTrust[miner.payout] += job.rewarded_difficulty2;
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                }, params);
                return true;
            }
            verifyCandidateHash(function onVerifiedCandidate() {
                ensureWalletTrustEntry(miner);
                walletTrust[miner.payout] += job.rewarded_difficulty2;
                verifyShareCB(hashDiff, resultBuff, blockData, false, true);
            }, function onUnavailableCandidate() {
                submitUnverifiedCandidate();
            });
            return true;
        }

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
                ensureWalletTrustEntry(miner);
                walletTrust[miner.payout] += job.rewarded_difficulty2;
                return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
            });
        }

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
                }, verifyContext);
            };
            verifyOnce();
        }

        const verifyShare = function (verifyShareCB) {
            if (runSpecialShareVerifier(verifyShareCB)) return;
            const result = buildVerifyResult();
            if (!result) return;
            if (verifyBlockSubmitTestBypass(result.hashDiff, result.resultBuff, verifyShareCB)) return;
            if (verifyTrustedShare(result.hashDiff, result.resultBuff, result.resultHash, verifyShareCB)) return;
            if (miner.debugMiner) console.log(getThreadName() + "WALLET DEBUG: " + formatPoolEvent("Verify share", {
                miner: miner.logString,
                chain: formatCoinPort(job.coin, port)
            }));
            if (shareThrottled(processShareCB)) return;
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalidShare(miner));
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
            if (verifyBlockCandidate(result.hashDiff, result.resultBuff, blockData, convertedBlob, verifyShareCB)) return;
            verifySlowShare(result.hashDiff, result.resultBuff, result.resultHash, blockData, convertedBlob, verifyShareCB);
        };

        function getVerifiedBlockData(blockData) {
            if (blockData) return blockData;
            const nextBlockData = getShareBuffer(miner, job, blockTemplate, params);
            if (!nextBlockData) processShareCB(invalidShare(miner));
            return nextBlockData;
        }

        function submitMainBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
            const allowUntrustedBlockSubmitTest = isBlockSubmitTestBypassEnabled(miner) && !hasBlockSubmitTrust(miner);
            if (!isNeedCheckBlockDiff || !ge(hashDiff, blockTemplate.difficulty)) return false;
            const nextBlockData = getVerifiedBlockData(blockData);
            if (!nextBlockData) return true;
            if (allowUntrustedBlockSubmitTest) {
                submitBlock(miner, job, blockTemplate, nextBlockData, resultBuff, hashDiff, true, true, null, function onTestModeSubmit() {
                    return processShareCB(true);
                }, params);
            } else {
                submitBlock(miner, job, blockTemplate, nextBlockData, resultBuff, hashDiff, isTrustedShare, true, null, null, params);
            }
            return allowUntrustedBlockSubmitTest;
        }

        function buildChildShareBuffer(blockData) {
            blockTemplate.child_template_buffer = Buffer.from(blockTemplate.child_template_buffer);
            try {
                return global.coinFuncs.constructMMChildBlockBlob(blockData, port, blockTemplate.child_template_buffer);
            } catch (error) {
                const errStr = getThreadName() + formatPoolEvent("MM child blob build failed", {
                    chain: formatCoinPort(job.coin, port),
                    miner: miner.logString,
                    error: error && error.message ? error.message : String(error)
                });
                console.error(errStr);
                global.support.sendAdminFyi("pool:construct-mm-child-blob:" + port, "FYI: Can't construct_mm_child_block_blob", errStr);
                processShareCB(invalidShare(miner));
                return null;
            }
        }

        function submitChildBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare) {
            if (!("child_template" in blockTemplate) || !ge(hashDiff, blockTemplate.child_template.difficulty)) return true;
            const nextBlockData = getVerifiedBlockData(blockData);
            if (!nextBlockData) return false;
            const shareBuffer2 = buildChildShareBuffer(nextBlockData);
            if (shareBuffer2 === null) return false;
            submitBlock(miner, job, blockTemplate.child_template, shareBuffer2, resultBuff, hashDiff, isTrustedShare, false, null, null, params);
            return true;
        }

        verifyShare(function (hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
            if (submitMainBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff)) return;

            const isMm = "child_template" in blockTemplate;
            if (!submitChildBlockIfNeeded(hashDiff, resultBuff, blockData, isTrustedShare)) return;

            if (!ge(hashDiff, job.difficulty)) {
                const timeNow = Date.now();
                const lastMinerLogTime = getLastMinerLogTime();
                if (!(miner.payout in lastMinerLogTime) || timeNow - lastMinerLogTime[miner.payout] > 30 * 1000) {
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
                recordShareData(miner, job, isTrustedShare, blockTemplate.child_template);
            }
            return processShareCB(true);
        });
    }

    function resetShareState() {
        for (const [payout, gate] of walletVerificationGates) dropTrustedQueue(payout, gate);
        walletVerificationGates.clear();
        for (const key of Object.keys(walletAcc)) delete walletAcc[key];
        for (const key of Object.keys(walletWorkerCount)) delete walletWorkerCount[key];
        for (const key of Object.keys(isWalletAccFinalizer)) delete isWalletAccFinalizer[key];
        for (const key of Object.keys(extraWalletVerify)) delete extraWalletVerify[key];
        extraVerifyWalletHashes.length = 0;
    }

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
