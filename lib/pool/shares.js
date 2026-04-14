"use strict";
const createShareBlockHelpers = require("./share-blocks.js");

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
        getThreadName,
        getLastMinerLogTime,
        setLastMinerLogTime
    } = deps;

    const walletAcc = {};
    const walletWorkerCount = {};
    const isWalletAccFinalizer = {};
    const extraWalletVerify = {};
    const extraVerifyWalletHashes = [];
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

    function ensureWalletTrustEntry(miner) {
        if (!(miner.payout in walletTrust)) walletTrust[miner.payout] = 0;
        walletLastSeeTime[miner.payout] = Date.now();
    }

    function storeShareDiv(miner, shareReward, shareReward2, shareNum, workerName, btPort, btHeight, btDifficulty, isBlockCandidate, isTrustedShare) {
        const timeNow = Date.now();
        if (miner.payout_div === null) {
            global.database.storeShare(btHeight, global.protos.Share.encode({
                paymentAddress: miner.address,
                paymentID: miner.paymentID,
                raw_shares: shareReward,
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
                raw_shares: shareReward * payoutPercent / 100,
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

    function walletAccFinalizer(walletKey, miner, btPort) {
        debug("!!! " + walletKey + ": scanning for old worker names");
        const wallet = walletAcc[walletKey];
        let isSomethingLeft = false;
        const timeNow = Date.now();
        for (const workerName in wallet) {
            const worker = wallet[workerName];
            if (timeNow - worker.time > global.config.pool.shareAccTime * 1000) {
                if (worker.acc != 0) {
                    debug("!!! " + walletKey + " / " + workerName + ": storing old worker share " + worker.height + " " + worker.difficulty + " " + timeNow + " " + worker.acc);
                    storeShareDiv(miner, worker.acc, worker.acc2, worker.share_num, workerName, btPort, worker.height, worker.difficulty, false, worker.trustedShare);
                }
                debug("!!! " + walletKey + ": removing old worker " + workerName);
                if (workerName !== "all_other_workers") --walletWorkerCount[walletKey];
                delete wallet[workerName];
            } else {
                isSomethingLeft = true;
            }
        }

        if (isSomethingLeft) {
            setTimeout(walletAccFinalizer, global.config.pool.shareAccTime * 1000, walletKey, miner, btPort);
        } else {
            isWalletAccFinalizer[walletKey] = false;
        }
    }

    function recordShareData(miner, job, isTrustedShare, blockTemplate) {
        miner.hashes += job.norm_diff;
        const proxyMinerName = miner.payout;
        if (proxyMinerName in proxyMiners) proxyMiners[proxyMinerName].hashes += job.norm_diff;
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

        if (!(workerName in wallet)) {
            if (workerName !== "all_other_workers") ++walletWorkerCount[walletKey];
            debug("!!! " + walletKey + ": adding new worker " + workerName + " (num " + walletWorkerCount[walletKey] + ")");
            wallet[workerName] = {
                height: dbJobHeight,
                difficulty: blockTemplate.difficulty,
                time: timeNow,
                acc: 0,
                acc2: 0,
                share_num: 0,
                trustedShare: isTrustedShare
            };
        }

        const worker = wallet[workerName];
        if (timeNow - worker.time > global.config.pool.shareAccTime * 1000 || worker.acc >= 100000000) {
            if (worker.acc != 0) {
                debug("!!! " + walletKey + " / " + workerName + ": storing share " + worker.height + " " + worker.difficulty + " " + timeNow + " " + worker.acc);
                storeShareDiv(miner, worker.acc, worker.acc2, worker.share_num, workerName, blockTemplate.port, worker.height, worker.difficulty, false, isTrustedShare);
            }

            worker.height = dbJobHeight;
            worker.difficulty = blockTemplate.difficulty;
            worker.time = timeNow;
            worker.acc = job.rewarded_difficulty;
            worker.acc2 = job.rewarded_difficulty2;
            worker.share_num = 1;
            worker.trustedShare = isTrustedShare;
        } else {
            worker.acc += job.rewarded_difficulty;
            worker.acc2 += job.rewarded_difficulty2;
            ++worker.share_num;
            worker.trustedShare = worker.trustedShare && isTrustedShare;
        }

        debug("!!! " + walletKey + " / " + workerName + ": accumulating share " + dbJobHeight + " " + blockTemplate.difficulty + " " + worker.time + " " + worker.acc + " (+" + job.rewarded_difficulty + ")");

        if (isWalletAccFinalizer[walletKey] === false) {
            isWalletAccFinalizer[walletKey] = true;
            setTimeout(walletAccFinalizer, global.config.pool.shareAccTime * 1000, walletKey, miner, blockTemplate.port);
        }

        processSend({ type: isTrustedShare ? "trustedShare" : "normalShare" });
        debug(getThreadName() + (isTrustedShare ? "Accepted trusted share at difficulty: " : "Accepted valid share at difficulty: ") + job.difficulty + "/" + job.rewarded_difficulty + " from: " + miner.logString);
        if (activeBlockTemplates[job.coin].idHash !== blockTemplate.idHash) {
            processSend({ type: "outdatedShare" });
        }
    }

    function getShareBuffer(miner, job, blockTemplate, params) {
        try {
            const template = Buffer.alloc(blockTemplate.buffer.length);
            blockTemplate.buffer.copy(template);
            template.writeUInt32BE(job.extraNonce, blockTemplate.reserved_offset);
            if (miner.proxy) {
                template.writeUInt32BE(params.poolNonce, job.clientPoolLocation);
                template.writeUInt32BE(params.workerNonce, job.clientNonceLocation);
            }
            return global.coinFuncs.constructNewBlob(template, params, blockTemplate.port);
        } catch (error) {
            const errStr = "Can't constructNewBlob of " + blockTemplate.port + " port with " + JSON.stringify(params) + " params from " + miner.logString + ": " + error;
            console.error(errStr);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't constructNewBlob", errStr);
            return null;
        }
    }

    function processShare(miner, job, blockTemplate, params, processShareCB) {
        const port = blockTemplate.port;
        const blobTypeNum = job.blob_type_num;
        const profile = global.coinFuncs.getJobProfile(job);
        const poolSettings = profile && profile.pool ? profile.pool : {};

        if (miner.payout in minerWallets) minerWallets[miner.payout].hashes += job.norm_diff;

        const shareThrottled = function (nextProcessShareCB) {
            if (miner.payout in minerWallets) {
                const lastVerShares = ++minerWallets[miner.payout].last_ver_shares;
                const threshold = global.config.pool.minerThrottleSharePerSec * global.config.pool.minerThrottleShareWindow;
                if (lastVerShares > threshold) {
                    if (lastVerShares == threshold) {
                        console.error(getThreadName() + "Throttled down miner share (diff " + job.rewarded_difficulty2 + ") submission from " + miner.logString);
                    } else if (job.rewarded_difficulty2 >= 10000000 && lastVerShares > 10 * threshold) {
                        console.error(getThreadName() + "Throttled down miner share as invalid (diff " + job.rewarded_difficulty2 + ") submission from " + miner.logString);
                        invalidShare(miner);
                        nextProcessShareCB(false);
                        return true;
                    }
                    processSend({ type: "throttledShare" });
                    if (addProxyMiner(miner)) {
                        const proxyMinerName = miner.payout;
                        proxyMiners[proxyMinerName].hashes += job.norm_diff;
                        adjustMinerDiff(miner);
                    }
                    nextProcessShareCB(null);
                    return true;
                }
            }
            return false;
        };

        const verifyShare = function (verifyShareCB) {
            if (typeof poolSettings.verifySpecialShare === "function" && poolSettings.verifySpecialShare({
                bigIntToBuffer,
                blockTemplate,
                coinFuncs: global.coinFuncs,
                getShareBuffer() {
                    return getShareBuffer(miner, job, blockTemplate, params);
                },
                hashBuffDiff,
                hashEthBuffDiff,
                hashRavenBuffDiff,
                invalidShare,
                job,
                miner,
                params,
                processShareCB,
                reportMinerShare,
                shareThrottled() {
                    return shareThrottled(processShareCB);
                },
                verifyShareCB
            })) {
                return;
            }

            const resultHash = params.result;
            let resultBuff;
            try {
                resultBuff = Buffer.from(resultHash, "hex");
            } catch (_error) {
                return processShareCB(invalidShare(miner));
            }
            const hashDiff = hashBuffDiff(resultBuff);

            if (global.config.pool.trustedMiners && isSafeToTrust(job.rewarded_difficulty2, miner.payout, miner.trust.trust) && miner.trust.check_height !== job.height) {
                let blockData = null;
                if (miner.payout in extraWalletVerify) {
                    blockData = getShareBuffer(miner, job, blockTemplate, params);
                    if (blockData !== null) {
                        const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
                        global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function (hash) {
                            if (hash === null || hash === false) {
                                console.error(getThreadName() + "[EXTRA CHECK] Can't verify share remotely!");
                            } else if (hash !== resultHash) {
                                console.error(getThreadName() + miner.logString + " [EXTRA CHECK] INVALID SHARE OF " + job.rewarded_difficulty2 + " REWARD HASHES");
                            } else {
                                extraVerifyWalletHashes.push(miner.payout + " " + convertedBlob.toString("hex") + " " + resultHash + " " + global.coinFuncs.algoShortTypeStr(port) + " " + blockTemplate.height + " " + blockTemplate.seed_hash);
                            }
                        });
                    } else {
                        console.error(getThreadName() + miner.logString + " [EXTRA CHECK] CAN'T MAKE SHARE BUFFER");
                    }
                }
                if (miner.lastSlowHashAsyncDelay) {
                    setTimeout(function () { return verifyShareCB(hashDiff, resultBuff, blockData, true, true); }, miner.lastSlowHashAsyncDelay);
                    debug("[MINER] Delay " + miner.lastSlowHashAsyncDelay);
                } else {
                    return verifyShareCB(hashDiff, resultBuff, blockData, true, true);
                }
                return;
            }

            if (miner.debugMiner) console.log(getThreadName() + miner.logString + " [WALLET DEBUG] verify share");
            if (shareThrottled(processShareCB)) return;
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalidShare(miner));
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);

            if (ge(hashDiff, blockTemplate.difficulty)) {
                if (miner.validShares || (miner.payout in minerWallets && minerWallets[miner.payout].hashes)) {
                    submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, true, true, null, function (blockSubmitResult) {
                        if (!blockSubmitResult) {
                            const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                            if (!buff.equals(resultBuff)) {
                                reportMinerShare(miner, job);
                                return processShareCB(invalidShare(miner));
                            }
                        }
                        ensureWalletTrustEntry(miner);
                        walletTrust[miner.payout] += job.rewarded_difficulty2;
                        return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
                    });
                } else {
                    const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                    if (!buff.equals(resultBuff)) {
                        reportMinerShare(miner, job);
                        return processShareCB(invalidShare(miner));
                    }
                    ensureWalletTrustEntry(miner);
                    walletTrust[miner.payout] += job.rewarded_difficulty2;
                    return verifyShareCB(hashDiff, resultBuff, blockData, false, true);
                }
            } else {
                const timeNow = Date.now();
                global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function (hash) {
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
        };

        verifyShare(function (hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {
            if (isNeedCheckBlockDiff && ge(hashDiff, blockTemplate.difficulty)) {
                if (!blockData) {
                    blockData = getShareBuffer(miner, job, blockTemplate, params);
                    if (!blockData) return processShareCB(invalidShare(miner));
                }
                submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, true, null);
            }

            const isMm = "child_template" in blockTemplate;
            if (isMm && ge(hashDiff, blockTemplate.child_template.difficulty)) {
                if (!blockData) {
                    blockData = getShareBuffer(miner, job, blockTemplate, params);
                    if (!blockData) return processShareCB(invalidShare(miner));
                }
                blockTemplate.child_template_buffer = Buffer.from(blockTemplate.child_template_buffer);
                let shareBuffer2 = null;
                try {
                    shareBuffer2 = global.coinFuncs.constructMMChildBlockBlob(blockData, port, blockTemplate.child_template_buffer);
                } catch (error) {
                    const errStr = "Can't construct_mm_child_block_blob with " + blockData.toString("hex") + " parent block and " + blockTemplate.child_template_buffer.toString("hex") + " child block share buffers from " + miner.logString + ": " + error;
                    console.error(errStr);
                    global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't construct_mm_child_block_blob", errStr);
                    return processShareCB(invalidShare(miner));
                }
                if (shareBuffer2 === null) return processShareCB(invalidShare(miner));
                submitBlock(miner, job, blockTemplate.child_template, shareBuffer2, resultBuff, hashDiff, isTrustedShare, false, null);
            }

            if (!ge(hashDiff, job.difficulty)) {
                const timeNow = Date.now();
                const lastMinerLogTime = getLastMinerLogTime();
                if (!(miner.payout in lastMinerLogTime) || timeNow - lastMinerLogTime[miner.payout] > 30 * 1000) {
                    console.warn(getThreadName() + "Rejected low diff (" + hashDiff + " < " + job.difficulty + ") share from miner " + miner.logString);
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
