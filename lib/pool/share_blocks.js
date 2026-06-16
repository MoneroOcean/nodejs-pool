"use strict";
const BLOCK_SUBMIT_FAILURE_RESULTS = new Set([
    false, "high-hash", "bad-txnmrklroot", "bad-cbtx-mnmerkleroot"
]);
const SUBMIT_RETRY_DELAY_MS = 100;

module.exports = function createShareBlockHelpers(deps) {
    const {
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
        // Only gate trust below the NiceHash difficulty ceiling (XMR niceHashDiff); above it every share is verified.
        if (!(rewardDiff < 400000 && minerTrust != 0)) return false;
        const trustThreshold = global.config.pool.trustThreshold;
        const trustMin = global.config.pool.trustMin;
        // trustChange slows the session-branch trust ramp (>= 1; 1 == legacy behaviour). A higher value makes a
        // miner re-earn trust over more verified shares after a reset, which lowers the sustainable fake-share
        // fraction WITHOUT raising the steady-state verification rate (the gate still floors at trustMin).
        const trustChange = global.config.pool.trustChange > 0 ? global.config.pool.trustChange : 1;
        const rewardDiff2 = rewardDiff * trustThreshold;
        const walletOk = (minerWallet in walletTrust) && rewardDiff2 * trustThreshold < walletTrust[minerWallet];
        const sessionOk = rewardDiff2 < minerTrust;
        if (!(walletOk || sessionOk)) return false;
        // SECURITY: draw the trust lottery ONCE and gate it on the easiest applicable threshold.
        // The legacy code drew a separate crypto.randomBytes(1) for the wallet branch AND the session branch and
        // OR-ed them, which multiplied the trust probability: a miner satisfying both branches was verified only
        // when BOTH draws failed, collapsing the catch rate to ~(trustMin/256)^2 (~0.67% at trustMin=20) instead
        // of the intended ~trustMin/256 (~8.2%). A single draw keeps the OR semantics (trusted if it beats the
        // most lenient eligible threshold) while restoring the intended one-in-N verification rate.
        const gate = walletOk ? trustMin : Math.max(256 - minerTrust / rewardDiff / (2 * trustChange), trustMin);
        return crypto.randomBytes(1).readUIntBE(0, 1) > gate;
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

    function formatDiffRows(rows) {
        const labelWidth = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
        const valueWidth = rows.reduce((max, row) => Math.max(max, formatDiff(row.value).length), 0);
        return rows.map((row) => "\n" + row.label.padEnd(labelWidth) + ": " + formatDiff(row.value).padStart(valueWidth)).join("");
    }

    function getLocalBlockCheck(blockTemplate, blockData, resultBuff, job, miner, callback) {
        if (!Buffer.isBuffer(blockData)) return callback(null);
        let convertedBlob;
        try {
            convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
        } catch (_error) {
            return callback(null);
        }
        if (!convertedBlob) return callback(null);

        function finish(buff) {
            if (!Buffer.isBuffer(buff)) return callback(null);
            let diff = hashBuffDiff(buff);
            if (job && (job.coin === "ETH" || job.coin === "ETC" || job.coin === "ERG")) diff = hashEthBuffDiff(buff);
            else if (job && (job.coin === "RVN" || job.coin === "XNA")) diff = hashRavenBuffDiff(buff);
            return callback({ diff, matchesSubmit: !Buffer.isBuffer(resultBuff) || buff.equals(resultBuff) });
        }

        if (typeof global.coinFuncs.slowHashBuffAsync === "function") {
            return global.coinFuncs.slowHashBuffAsync(convertedBlob, blockTemplate, miner && miner.payout, finish);
        }
        if (typeof global.coinFuncs.isHashVerifierEnabled === "function" && global.coinFuncs.isHashVerifierEnabled()) return callback(null);

        try {
            return finish(global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate));
        } catch (_error) {
            return callback(null);
        }
    }

    function getBlockSubmitDiffMessage(blockTemplate, blockData, resultBuff, hashDiff, requiredDiff, job, miner, callback) {
        const diffRows = [
            { label: "Submitted share difficulty", value: hashDiff },
            { label: "Required block difficulty", value: requiredDiff }
        ];
        return getLocalBlockCheck(blockTemplate, blockData, resultBuff, job, miner, function onLocalCheck(localCheck) {
            if (localCheck !== null) {
                const localDiff = localCheck.diff;
                diffRows.push({ label: "Locally verified difficulty", value: localDiff });
                let message = formatDiffRows(diffRows);
                if (!localCheck.matchesSubmit || (requiredDiff !== undefined && requiredDiff !== null && requiredDiff !== "" && !ge(localDiff, requiredDiff))) {
                    message += "\nLocal check says this was not block level; no action is needed for this submit failure.";
                }
                return callback(message);
            }
            return callback(formatDiffRows(diffRows));
        });
    }

    function submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, portUsedToSubmit, submitBlockCB, submitParams, submitRetryCount) {
        const isMainPort = global.config.daemon.port == blockTemplate.port;
        const profile = global.coinFuncs.getPoolProfile(blockTemplate.port);
        const poolSettings = profile && profile.pool ? profile.pool : {};
        const dualDisplayCoin = poolSettings.dualSubmitDisplayCoin;
        const dualDisplayPort = poolSettings.dualSubmitReportPort || (dualDisplayCoin ? global.coinFuncs.COIN2PORT(dualDisplayCoin) : blockTemplate.port);
        const currentSubmitRetryCount = submitRetryCount || 0;

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

        function shouldNotifySubmitFailure(callback) {
            if (!(isParentBlock && isTrustedShare && !shouldSuppressBlockSubmitFailureEmail())) return callback(true);
            let convertedBlob;
            try {
                convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
            } catch (_error) {
                return callback(false);
            }
            if (!convertedBlob) return callback(false);

            function finish(buff) {
                return callback(Buffer.isBuffer(buff) && Buffer.isBuffer(resultBuff) && buff.equals(resultBuff));
            }

            if (typeof global.coinFuncs.slowHashBuffAsync === "function") {
                return global.coinFuncs.slowHashBuffAsync(convertedBlob, blockTemplate, miner && miner.payout, finish);
            }
            if (typeof global.coinFuncs.isHashVerifierEnabled === "function" && global.coinFuncs.isHashVerifierEnabled()) return callback(false);

            try {
                return finish(global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate));
            } catch (_error) {
                return callback(false);
            }
        }

        function shouldRetryXmrSubmitFailure(isDisplaySubmitPort) {
            return !isDisplaySubmitPort && blockTemplate.coin === "" && currentSubmitRetryCount === 0;
        }

        function retrySubmit(port, nextSubmitBlockCB, delayMs) {
            return setTimeout(submitBlock, delayMs, miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, port, nextSubmitBlockCB, submitParams, currentSubmitRetryCount + 1);
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
                        getDiffMessage(function onDiffMessage(diffMessage) {
                            global.support.sendAdminFyi("pool:block-submit:" + reportCoinPort, "FYI: Can't submit " + reportCoinPort + " block to daemon", "The pool server: " + global.config.hostname + " can't submit block to daemon on " + reportCoinPort + diffMessage + "\nInput: " + blockDataStr + "\n" + getThreadName() + "Error submitting " + reportCoinPort + " block at " + reportHeight + " height from " + miner.logString + ", isTrustedShare: " + isTrustedShare + " error ): " + JSON.stringify(rpcResult));
                        });
                    }
                }, true);
            }, 2 * 1000);
        }

        function buildSubmitReport(port, isDisplaySubmitPortOverride) {
            const isDisplaySubmitPort = typeof isDisplaySubmitPortOverride === "boolean"
                ? isDisplaySubmitPortOverride
                : port === global.config.daemon.port && !!dualDisplayCoin;
            const reportCoin = isDisplaySubmitPort ? dualDisplayCoin : blockTemplate.coin;
            const reportDiff = isDisplaySubmitPort ? blockTemplate.xtm_difficulty : blockTemplate.difficulty;
            const reportPort = isDisplaySubmitPort ? dualDisplayPort : blockTemplate.port;
            const reportHeight = isDisplaySubmitPort ? blockTemplate.xtm_height : blockTemplate.height;
            const activeHeight = isDisplaySubmitPort ? activeBlockTemplates[blockTemplate.coin].xtm_height : activeBlockTemplates[blockTemplate.coin].height;
            return { activeHeight, isDisplaySubmitPort, reportCoinPort: formatCoinPort(reportCoin, reportPort), reportDiff, reportHeight, reportPort };
        }

        const replyFn = function (rpcResult, rpcStatus, port, nextSubmitBlockCB, isDisplaySubmitPortOverride) {
            const { activeHeight, isDisplaySubmitPort, reportCoinPort, reportDiff, reportHeight, reportPort } = buildSubmitReport(port, isDisplaySubmitPortOverride);
            const requiredBlockDiff = isMainPort && !isDisplaySubmitPort && blockTemplate.xmr_difficulty ? blockTemplate.xmr_difficulty : reportDiff;
            const getDiffMessage = function (callback) {
                return getBlockSubmitDiffMessage(blockTemplate, blockData, resultBuff, hashDiff, requiredBlockDiff, job, miner, callback);
            };
            const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString("hex") : JSON.stringify(blockData);

            if (isSubmitFailure(rpcResult)) {
                if (shouldRetryXmrSubmitFailure(isDisplaySubmitPort)) {
                    console.warn(getThreadName() + formatPoolEvent("Block submit retry", {
                        chain: reportCoinPort,
                        height: reportHeight,
                        activeHeight,
                        miner: miner.logString,
                        trusted: isTrustedShare,
                        rpcStatus,
                        error: rpcResult
                    }) + ", block hex: \n" + blockDataStr);
                    return retrySubmit(port, nextSubmitBlockCB, SUBMIT_RETRY_DELAY_MS);
                }
                return shouldNotifySubmitFailure(function onSubmitFailureNotify(isNotifyAdmin) {
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
                });
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
                        global.support.sendAdminFyi("pool:zero-hash-block:" + reportCoinPort, "FYI: Dropped unresolved zero-hash block on " + reportCoinPort, errorMessage);
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
                return retrySubmit(port, nextSubmitBlockCB, SUBMIT_RETRY_DELAY_MS);
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
                const submitCoinPort = formatCoinPort(blockTemplate.coin, blockTemplate.port);
                return getDiffMessage(function onRpcErrorDiff(diffMessage) {
                    global.support.sendAdminFyi("pool:block-submit-rpc:" + submitCoinPort, "FYI: Can't submit block to daemon on " + submitCoinPort, "Input: " + blockDataStr + "\nThe pool server: " + global.config.hostname + " can't submit block to daemon on " + submitCoinPort + diffMessage + "\nRPC Error. Please check logs for details");
                    if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
                });
            }
            if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
        };

        const stdReplyFn = function (rpcResult, rpcStatus) {
            return replyFn(rpcResult, rpcStatus, blockTemplate.port, submitBlockCB);
        };

        try {
            poolSettings.submitBlockRpc.call(poolSettings, {
                blockData,
                blockTemplate,
                hashDiff,
                isBlockSubmitTestModeEnabled,
                job,
                params: submitParams,
                portUsedToSubmit,
                replyDispatcher: replyFn,
                replyFn: stdReplyFn,
                suppressFailureEmail: shouldSuppressBlockSubmitFailureEmail(),
                submitBlockCB,
                support: global.support
            });
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            console.error(getThreadName() + formatPoolEvent("Block submit exception", {
                chain: formatCoinPort(blockTemplate.coin, blockTemplate.port),
                height: blockTemplate.height,
                miner: miner.logString,
                params: submitParams,
                trusted: isTrustedShare,
                error: error && error.stack ? error.stack : message
            }));
            return stdReplyFn({ error: { code: -1, message: "SubmitBlock exception: " + message } }, 0);
        }
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
