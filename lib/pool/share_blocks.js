"use strict";

module.exports = function createShareBlockHelpers(deps) {
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
        walletTrust,
        processSend,
        clearWalletSessionTrust,
        getThreadName,
        formatCoinPort,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; },
        isBlockSubmitTestModeEnabled = function fallbackBlockSubmitTestMode() { return false; },
        getLastMinerLogTime,
        setLastMinerLogTime
    } = deps;

    function invalidShare(miner) {
        processSend({ type: "invalidShare" });
        miner.sendSameCoinJob();
        if (miner.payout in walletTrust && walletTrust[miner.payout] !== 0) {
            clearWalletSessionTrust(miner.payout);
            walletTrust[miner.payout] = 0;
        }
        return false;
    }

    function isSafeToTrust(rewardDiff, minerWallet, minerTrust) {
        const rewardDiff2 = rewardDiff * global.config.pool.trustThreshold;
        return rewardDiff < 400000 && minerTrust != 0 && (
            ((minerWallet in walletTrust) &&
                rewardDiff2 * global.config.pool.trustThreshold < walletTrust[minerWallet] &&
                crypto.randomBytes(1).readUIntBE(0, 1) > global.config.pool.trustMin) || (
                rewardDiff2 < minerTrust &&
                crypto.randomBytes(1).readUIntBE(0, 1) > Math.max(256 - minerTrust / rewardDiff / 2, global.config.pool.trustMin)
            )
        );
    }

    function hashBuffDiff(hash) {
        return divideBaseDiff(bigIntFromBuffer(hash, { endian: "little", size: 32 }));
    }

    function hashRavenBuffDiff(hash) {
        return Number(baseRavenDiff) / Number(bigIntFromBuffer(hash));
    }

    function hashEthBuffDiff(hash) {
        return divideBaseDiff(bigIntFromBuffer(hash));
    }

    function ge(left, right) {
        if (typeof left === "bigint" || typeof right === "bigint" || typeof left === "object" || typeof right === "object") {
            return toBigInt(left) >= toBigInt(right);
        }
        return left >= right;
    }

    function reportMinerShare(miner, job) {
        const timeNow = Date.now();
        const lastMinerLogTime = getLastMinerLogTime();
        if (!(miner.payout in lastMinerLogTime) || timeNow - lastMinerLogTime[miner.payout] > 30 * 1000) {
            console.error(getThreadName() + formatPoolEvent("Bad share", {
                chain: formatCoinPort(job.coin),
                diff: job.difficulty,
                miner: miner.logString
            }));
            lastMinerLogTime[miner.payout] = timeNow;
            setLastMinerLogTime(lastMinerLogTime);
        }
    }

    function shouldSuppressBlockSubmitFailureEmail() {
        return isBlockSubmitTestModeEnabled() === true;
    }

    function submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, portUsedToSubmit, submitBlockCB) {
        const isMainPort = global.config.daemon.port == blockTemplate.port;
        const profile = global.coinFuncs.getPoolProfile(blockTemplate.port);
        const poolSettings = profile && profile.pool ? profile.pool : {};
        const dualDisplayCoin = poolSettings.dualSubmitDisplayCoin;
        const dualDisplayPort = poolSettings.dualSubmitReportPort || (dualDisplayCoin ? global.coinFuncs.COIN2PORT(dualDisplayCoin) : blockTemplate.port);
        const replyFn = function (rpcResult, rpcStatus, port, nextSubmitBlockCB) {
            const isDisplaySubmitPort = port === global.config.daemon.port && !!dualDisplayCoin;
            const reportCoin = isDisplaySubmitPort ? dualDisplayCoin : blockTemplate.coin;
            const reportDiff = isDisplaySubmitPort ? blockTemplate.xtm_difficulty : blockTemplate.difficulty;
            const reportPort = isDisplaySubmitPort ? dualDisplayPort : blockTemplate.port;
            const reportHeight = isDisplaySubmitPort ? blockTemplate.xtm_height : blockTemplate.height;
            const activeHeight = isDisplaySubmitPort ? activeBlockTemplates[blockTemplate.coin].xtm_height : activeBlockTemplates[blockTemplate.coin].height;
            const reportCoinPort = formatCoinPort(reportCoin, reportPort);
            const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString("hex") : JSON.stringify(blockData);

            if (rpcResult && (rpcResult.error || rpcResult.result === "high-hash" || rpcResult.result === "bad-txnmrklroot" || rpcResult.result === "bad-cbtx-mnmerkleroot")) {
                let isNotifyAdmin = true;
                if (isParentBlock && isTrustedShare && !shouldSuppressBlockSubmitFailureEmail()) {
                    const convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
                    const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                    if (!Buffer.isBuffer(buff) || !Buffer.isBuffer(resultBuff) || !buff.equals(resultBuff)) isNotifyAdmin = false;
                }
                console.error(getThreadName() + formatPoolEvent("Block submit failed", {
                    chain: reportCoinPort,
                    height: reportHeight,
                    activeHeight,
                    miner: miner.logString,
                    trusted: isTrustedShare,
                    valid: isNotifyAdmin,
                    rpcStatus,
                    error: rpcResult
                }) + ", block hex: \n" + blockDataStr);

                if (isNotifyAdmin && !shouldSuppressBlockSubmitFailureEmail()) {
                    setTimeout(function () {
                        if (typeof global.coinFuncs.getPortLastBlockHeader !== "function") return;
                        global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function (err, body) {
                            if (err !== null) return console.error(getThreadName() + formatPoolEvent("Header fetch failed", {
                                chain: formatCoinPort(blockTemplate.coin, blockTemplate.port)
                            }));
                            if (blockTemplate.height == body.height + 1) {
                                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit " + reportCoinPort + " block to deamon", "The pool server: " + global.config.hostname + " can't submit block to deamon on " + reportCoinPort + "\nInput: " + blockDataStr + "\n" + getThreadName() + "Error submitting " + reportCoinPort + " block at " + reportHeight + " height from " + miner.logString + ", isTrustedShare: " + isTrustedShare + " error ): " + JSON.stringify(rpcResult));
                            }
                        }, true);
                    }, 2 * 1000);
                }
                if (global.config.pool.trustedMiners) {
                    debug(getThreadName() + formatPoolEvent("Share trust reset", { miner: miner.logString }));
                    if (miner.payout in walletTrust && walletTrust[miner.payout] !== 0) {
                        clearWalletSessionTrust(miner.payout);
                        walletTrust[miner.payout] = 0;
                    } else {
                        miner.trust.trust = 0;
                    }
                }
                if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
                return;
            }

            if (poolSettings.acceptSubmittedBlock({
                rpcResult,
                rpcStatus
            })) {
                poolSettings.resolveSubmittedBlockHash({
                    blockData,
                    blockTemplate,
                    coinFuncs: global.coinFuncs,
                    isDisplaySubmitPort,
                    resultBuff,
                    rpcResult
                }, function onBlockHash(newBlockHash) {
                    if (newBlockHash === "0".repeat(64)) {
                        const errorMessage = getThreadName() + formatPoolEvent("Block hash unresolved", {
                            chain: reportCoinPort,
                            hash: newBlockHash,
                            height: reportHeight,
                            miner: miner.logString,
                            trusted: isTrustedShare,
                            submit: rpcResult
                        }) + ", block hex: \n" + blockDataStr;
                        console.error(errorMessage);
                        global.support.sendEmail(global.config.general.adminEmail, "FYI: Dropped unresolved zero-hash block on " + reportCoinPort, errorMessage);
                        if (nextSubmitBlockCB) return nextSubmitBlockCB(true);
                        return;
                    }
                    console.log(getThreadName() + formatPoolEvent("Block found", {
                        chain: reportCoinPort,
                        hash: newBlockHash,
                        height: reportHeight,
                        miner: miner.logString,
                        trusted: isTrustedShare,
                        submit: rpcResult
                    }) + ", block hex: \n" + blockDataStr);
                    const timeNow = Date.now();
                    if (isMainPort && !isDisplaySubmitPort) {
                        global.database.storeBlock(blockTemplate.height, global.protos.Block.encode({ hash: newBlockHash, difficulty: blockTemplate.xmr_difficulty, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true }));
                    } else {
                        global.database.storeAltBlock(Math.floor(timeNow / 1000), global.protos.AltBlock.encode({ hash: newBlockHash, difficulty: reportDiff, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true, port: reportPort, height: reportHeight, anchor_height: anchorState.current }));
                    }
                    if (nextSubmitBlockCB) return nextSubmitBlockCB(true);
                });
                return;
            }

            if (!portUsedToSubmit) {
                console.error(getThreadName() + formatPoolEvent("Block submit unknown", {
                    chain: reportCoinPort,
                    height: reportHeight,
                    activeHeight,
                    miner: miner.logString,
                    trusted: isTrustedShare,
                    rpcStatus,
                    errorType: typeof rpcResult,
                    error: rpcResult
                }) + ", block hex: \n" + blockDataStr);
                return setTimeout(submitBlock, 500, miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, port, nextSubmitBlockCB);
            }
            console.error(getThreadName() + formatPoolEvent("Block submit rpc-error", {
                chain: formatCoinPort(blockTemplate.coin, blockTemplate.port)
            }));
            if (!shouldSuppressBlockSubmitFailureEmail()) {
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit block to deamon on " + formatCoinPort(blockTemplate.coin, blockTemplate.port), "Input: " + blockDataStr + "\nThe pool server: " + global.config.hostname + " can't submit block to deamon on " + formatCoinPort(blockTemplate.coin, blockTemplate.port) + "\nRPC Error. Please check logs for details");
            }
            if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
        };

        const stdReplyFn = function (rpcResult, rpcStatus) {
            return replyFn(rpcResult, rpcStatus, blockTemplate.port, submitBlockCB);
        };

        poolSettings.submitBlockRpc.call(poolSettings, {
            blockData,
            blockTemplate,
            hashDiff,
            isBlockSubmitTestModeEnabled,
            job,
            portUsedToSubmit,
            replyDispatcher: replyFn,
            replyFn: stdReplyFn,
            suppressFailureEmail: shouldSuppressBlockSubmitFailureEmail(),
            submitBlockCB,
            support: global.support
        });
    }

    return {
        invalidShare,
        isSafeToTrust,
        hashBuffDiff,
        hashRavenBuffDiff,
        hashEthBuffDiff,
        ge,
        reportMinerShare,
        submitBlock
    };
};
