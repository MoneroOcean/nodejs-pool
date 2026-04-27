"use strict";
const BLOCK_SUBMIT_FAILURE_RESULTS = new Set([
    false, "high-hash", "bad-txnmrklroot", "bad-cbtx-mnmerkleroot"
]);

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

    function formatDiff(value) {
        return value === undefined || value === null || value === "" ? "unknown" : value.toString();
    }

    function getLocalBlockCheck(blockTemplate, blockData, resultBuff, job) {
        if (!Buffer.isBuffer(blockData)) return null;
        try {
            const convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
            const buff = convertedBlob ? global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate) : null;
            if (!Buffer.isBuffer(buff)) return null;
            let diff = hashBuffDiff(buff);
            if (job && (job.coin === "ETH" || job.coin === "ETC" || job.coin === "ERG")) diff = hashEthBuffDiff(buff);
            else if (job && (job.coin === "RVN" || job.coin === "XNA")) diff = hashRavenBuffDiff(buff);
            return { diff, matchesSubmit: !Buffer.isBuffer(resultBuff) || buff.equals(resultBuff) };
        } catch (_error) {
            return null;
        }
    }

    function getBlockSubmitDiffMessage(blockTemplate, blockData, resultBuff, hashDiff, requiredDiff, job) {
        const localCheck = getLocalBlockCheck(blockTemplate, blockData, resultBuff, job);
        let message = "\nSubmitted share difficulty: " + formatDiff(hashDiff) +
            "\nRequired block difficulty: " + formatDiff(requiredDiff);
        if (localCheck !== null) {
            const localDiff = localCheck.diff;
            message += "\nLocally verified difficulty: " + formatDiff(localDiff);
            if (!localCheck.matchesSubmit || (requiredDiff !== undefined && requiredDiff !== null && requiredDiff !== "" && !ge(localDiff, requiredDiff))) {
                message += "\nLocal check says this was not block level; no action is needed for this submit failure.";
            }
        }
        return message;
    }

    function submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, portUsedToSubmit, submitBlockCB) {
        const isMainPort = global.config.daemon.port == blockTemplate.port;
        const profile = global.coinFuncs.getPoolProfile(blockTemplate.port);
        const poolSettings = profile && profile.pool ? profile.pool : {};
        const dualDisplayCoin = poolSettings.dualSubmitDisplayCoin;
        const dualDisplayPort = poolSettings.dualSubmitReportPort || (dualDisplayCoin ? global.coinFuncs.COIN2PORT(dualDisplayCoin) : blockTemplate.port);

        function isSubmitFailure(rpcResult) {
            if (!rpcResult) return false;
            if (rpcResult.error) return true;
            return BLOCK_SUBMIT_FAILURE_RESULTS.has(rpcResult.result);
        }

        function resetShareTrust() {
            if (!global.config.pool.trustedMiners) return;
            debug(getThreadName() + formatPoolEvent("Share trust reset", { miner: miner.logString }));
            if (miner.payout in walletTrust && walletTrust[miner.payout] !== 0) {
                clearWalletSessionTrust(miner.payout);
                walletTrust[miner.payout] = 0;
            } else {
                miner.trust.trust = 0;
            }
        }

        function shouldNotifySubmitFailure() {
            if (!(isParentBlock && isTrustedShare && !shouldSuppressBlockSubmitFailureEmail())) return true;
            const convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
            const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
            return Buffer.isBuffer(buff) && Buffer.isBuffer(resultBuff) && buff.equals(resultBuff);
        }

        function storeResolvedBlock(newBlockHash, isDisplaySubmitPort, reportDiff, reportPort, reportHeight) {
            const timeNow = Date.now();
            if (isMainPort && !isDisplaySubmitPort) {
                global.database.storeBlock(blockTemplate.height, global.protos.Block.encode({ hash: newBlockHash, difficulty: blockTemplate.xmr_difficulty, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true }));
            } else {
                global.database.storeAltBlock(Math.floor(timeNow / 1000), global.protos.AltBlock.encode({ hash: newBlockHash, difficulty: reportDiff, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true, port: reportPort, height: reportHeight, anchor_height: anchorState.current }));
            }
        }

        function sendSubmitFailureEmail(reportCoinPort, reportHeight, blockDataStr, rpcResult, getDiffMessage) {
            setTimeout(function () {
                if (typeof global.coinFuncs.getPortLastBlockHeader !== "function") return;
                global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function (err, body) {
                    if (err !== null) return console.error(getThreadName() + formatPoolEvent("Header fetch failed", { chain: formatCoinPort(blockTemplate.coin, blockTemplate.port) }));
                    if (blockTemplate.height == body.height + 1) {
                        global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit " + reportCoinPort + " block to deamon", "The pool server: " + global.config.hostname + " can't submit block to deamon on " + reportCoinPort + getDiffMessage() + "\nInput: " + blockDataStr + "\n" + getThreadName() + "Error submitting " + reportCoinPort + " block at " + reportHeight + " height from " + miner.logString + ", isTrustedShare: " + isTrustedShare + " error ): " + JSON.stringify(rpcResult));
                    }
                }, true);
            }, 2 * 1000);
        }

        function buildSubmitReport(port) {
            const isDisplaySubmitPort = port === global.config.daemon.port && !!dualDisplayCoin;
            const reportCoin = isDisplaySubmitPort ? dualDisplayCoin : blockTemplate.coin;
            const reportDiff = isDisplaySubmitPort ? blockTemplate.xtm_difficulty : blockTemplate.difficulty;
            const reportPort = isDisplaySubmitPort ? dualDisplayPort : blockTemplate.port;
            const reportHeight = isDisplaySubmitPort ? blockTemplate.xtm_height : blockTemplate.height;
            const activeHeight = isDisplaySubmitPort ? activeBlockTemplates[blockTemplate.coin].xtm_height : activeBlockTemplates[blockTemplate.coin].height;
            return { activeHeight, isDisplaySubmitPort, reportCoinPort: formatCoinPort(reportCoin, reportPort), reportDiff, reportHeight, reportPort };
        }

        const replyFn = function (rpcResult, rpcStatus, port, nextSubmitBlockCB) {
            const { activeHeight, isDisplaySubmitPort, reportCoinPort, reportDiff, reportHeight, reportPort } = buildSubmitReport(port);
            const requiredBlockDiff = isMainPort && !isDisplaySubmitPort && blockTemplate.xmr_difficulty ? blockTemplate.xmr_difficulty : reportDiff;
            const getDiffMessage = function () {
                return getBlockSubmitDiffMessage(blockTemplate, blockData, resultBuff, hashDiff, requiredBlockDiff, job);
            };
            const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString("hex") : JSON.stringify(blockData);

            if (isSubmitFailure(rpcResult)) {
                const isNotifyAdmin = shouldNotifySubmitFailure();
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
                    sendSubmitFailureEmail(reportCoinPort, reportHeight, blockDataStr, rpcResult, getDiffMessage);
                }
                resetShareTrust();
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
                    storeResolvedBlock(newBlockHash, isDisplaySubmitPort, reportDiff, reportPort, reportHeight);
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
                chain: reportCoinPort,
                height: reportHeight,
                activeHeight,
                miner: miner.logString,
                trusted: isTrustedShare,
                rpcStatus,
                errorType: typeof rpcResult,
                error: rpcResult
            }) + ", block hex: \n" + blockDataStr);
            if (!shouldSuppressBlockSubmitFailureEmail()) {
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit block to deamon on " + formatCoinPort(blockTemplate.coin, blockTemplate.port), "Input: " + blockDataStr + "\nThe pool server: " + global.config.hostname + " can't submit block to deamon on " + formatCoinPort(blockTemplate.coin, blockTemplate.port) + getDiffMessage() + "\nRPC Error. Please check logs for details");
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
