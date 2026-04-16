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
        let resultHex = normalizeSyntheticResultHex(params && params.block_submit_test_result);
        if (!resultHex && params && params.raw_params instanceof Array) {
            const minParamLength = job && job.coin === "ERG" ? 4 : 6;
            if (params.raw_params.length >= minParamLength) {
                resultHex = normalizeSyntheticResultHex(params.raw_params[params.raw_params.length - 1]);
            }
        }
        if (!resultHex && job && job.coin === "XTM-C") {
            resultHex = normalizeSyntheticResultHex(params && params.result);
        }
        if (!resultHex && job && (job.coin === "" || job.coin === "XTM-T" || job.coin === "RTM" || job.coin === "ARQ")) {
            resultHex = normalizeSyntheticResultHex(params && params.result);
        }
        if (!resultHex && params && params.raw_params instanceof Array && params.raw_params.length >= 6) {
            resultHex = normalizeSyntheticResultHex(params.raw_params[params.raw_params.length - 1]);
        }
        return resultHex ? Buffer.from(resultHex, "hex") : null;
    }

    function hasBlockSubmitTrust(miner) {
        return !!(miner.validShares || (miner.payout in walletTrust && walletTrust[miner.payout] > 0));
    }

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
        debug(formatPoolEvent("Share acc scan", { wallet: walletKey }));
        const wallet = walletAcc[walletKey];
        let isSomethingLeft = false;
        const timeNow = Date.now();
        for (const workerName in wallet) {
            const worker = wallet[workerName];
            if (timeNow - worker.time > global.config.pool.shareAccTime * 1000) {
                if (worker.acc != 0) {
                    debug(formatPoolEvent("Share acc flush", {
                        wallet: walletKey,
                        worker: workerName,
                        height: worker.height,
                        diff: worker.difficulty,
                        time: timeNow,
                        acc: worker.acc
                    }));
                    storeShareDiv(miner, worker.acc, worker.acc2, worker.share_num, workerName, btPort, worker.height, worker.difficulty, false, worker.trustedShare);
                }
                debug(formatPoolEvent("Share acc worker remove", { wallet: walletKey, worker: workerName }));
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
            debug(formatPoolEvent("Share acc worker add", {
                wallet: walletKey,
                worker: workerName,
                workers: walletWorkerCount[walletKey]
            }));
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
                debug(formatPoolEvent("Share acc flush", {
                    wallet: walletKey,
                    worker: workerName,
                    height: worker.height,
                    diff: worker.difficulty,
                    time: timeNow,
                    acc: worker.acc
                }));
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

        debug(formatPoolEvent("Share acc update", {
            wallet: walletKey,
            worker: workerName,
            height: dbJobHeight,
            diff: blockTemplate.difficulty,
            time: worker.time,
            acc: worker.acc,
            add: job.rewarded_difficulty
        }));

        if (isWalletAccFinalizer[walletKey] === false) {
            isWalletAccFinalizer[walletKey] = true;
            setTimeout(walletAccFinalizer, global.config.pool.shareAccTime * 1000, walletKey, miner, blockTemplate.port);
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
            const errStr = getThreadName() + formatPoolEvent("Blob build failed", {
                chain: formatCoinPort(job.coin, blockTemplate.port),
                miner: miner.logString,
                params,
                error: error && error.message ? error.message : String(error)
            });
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
                        console.error(getThreadName() + formatPoolEvent("Share throttled", {
                            diff: job.rewarded_difficulty2,
                            miner: miner.logString
                        }));
                    } else if (job.rewarded_difficulty2 >= 10000000 && lastVerShares > 10 * threshold) {
                        console.error(getThreadName() + formatPoolEvent("Share throttled-invalid", {
                            diff: job.rewarded_difficulty2,
                            miner: miner.logString
                        }));
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
                getBlockSubmitTestResultBuffer() {
                    return getBlockSubmitTestResultBuffer(miner, job, params);
                },
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

            const syntheticResultBuff = getBlockSubmitTestResultBuffer(miner, job, params);
            const resultHash = syntheticResultBuff ? syntheticResultBuff.toString("hex") : params.result;
            let resultBuff = syntheticResultBuff;
            if (!resultBuff) {
                try {
                    resultBuff = Buffer.from(resultHash, "hex");
                } catch (_error) {
                    return processShareCB(invalidShare(miner));
                }
            }
            const hashDiff = hashBuffDiff(resultBuff);
            const allowUntrustedBlockSubmitTest = isBlockSubmitTestBypassEnabled(miner) && !hasBlockSubmitTrust(miner);

            if (allowUntrustedBlockSubmitTest && ge(hashDiff, blockTemplate.difficulty)) {
                if (shareThrottled(processShareCB)) return;
                const blockData = getShareBuffer(miner, job, blockTemplate, params);
                if (blockData === null) return processShareCB(invalidShare(miner));
                return verifyShareCB(hashDiff, resultBuff, blockData, true, true);
            }

            if (global.config.pool.trustedMiners && isSafeToTrust(job.rewarded_difficulty2, miner.payout, miner.trust.trust) && miner.trust.check_height !== job.height) {
                let blockData = null;
                if (miner.payout in extraWalletVerify) {
                    blockData = getShareBuffer(miner, job, blockTemplate, params);
                    if (blockData !== null) {
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
                    } else {
                        console.error(getThreadName() + "IMPORTANT: " + formatPoolEvent("Verify", {
                            action: "share-buffer-failed",
                            miner: miner.logString,
                            chain: formatCoinPort(job.coin, port)
                        }));
                    }
                }
                if (miner.lastSlowHashAsyncDelay) {
                    setTimeout(function () { return verifyShareCB(hashDiff, resultBuff, blockData, true, true); }, miner.lastSlowHashAsyncDelay);
                    debug("MINER: " + formatPoolEvent("Verify delay", { ms: miner.lastSlowHashAsyncDelay }));
                } else {
                    return verifyShareCB(hashDiff, resultBuff, blockData, true, true);
                }
                return;
            }

            if (miner.debugMiner) console.log(getThreadName() + "WALLET DEBUG: " + formatPoolEvent("Verify share", {
                miner: miner.logString,
                chain: formatCoinPort(job.coin, port)
            }));
            if (shareThrottled(processShareCB)) return;
            const blockData = getShareBuffer(miner, job, blockTemplate, params);
            if (blockData === null) return processShareCB(invalidShare(miner));
            const convertedBlob = global.coinFuncs.convertBlob(blockData, port);

            if (ge(hashDiff, blockTemplate.difficulty)) {
                if (miner.validShares || (miner.payout in walletTrust && walletTrust[miner.payout] > 0)) {
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
            const allowUntrustedBlockSubmitTest = isBlockSubmitTestBypassEnabled(miner) && !hasBlockSubmitTrust(miner);
            if (allowUntrustedBlockSubmitTest && isNeedCheckBlockDiff && ge(hashDiff, blockTemplate.difficulty)) {
                if (!blockData) {
                    blockData = getShareBuffer(miner, job, blockTemplate, params);
                    if (!blockData) return processShareCB(invalidShare(miner));
                }
                submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, true, true, null, function onTestModeSubmit() {
                    return processShareCB(true);
                });
                return;
            }

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
                    const errStr = getThreadName() + formatPoolEvent("MM child blob build failed", {
                        chain: formatCoinPort(job.coin, port),
                        miner: miner.logString,
                        error: error && error.message ? error.message : String(error)
                    });
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
