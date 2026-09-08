"use strict";
const { getRemoteDatabase } = require("../common/database.js");
const BLOCK_SUBMIT_FAILURE_RESULTS = new Set([
    false, "high-hash", "bad-txnmrklroot", "bad-cbtx-mnmerkleroot"
]);
const SUBMIT_RETRY_DELAY_MS = 100;

/** @typedef {import("../../types/pool_profiles").PoolBlockTemplate} PoolBlockTemplate */
/** @typedef {import("../../types/pool_profiles").PoolJob} PoolJob */
/** @typedef {import("../../types/pool_profiles").PoolMiner} PoolMiner */
/** @typedef {import("../../types/pool_profiles").PoolRpcResult} PoolRpcResult */
/** @typedef {import("../../types/pool_profiles").PoolSubmitParams} PoolSubmitParams */
/** @typedef {{diff: number|bigint, matchesSubmit: boolean}} LocalBlockCheck */
/** @typedef {{label: string, value: unknown}} DiffRow */
/** @typedef {{current: number|undefined, previous: number|undefined}} AnchorState */

/**
 * @typedef {object} ShareBlockDeps
 * @property {{randomBytes: (size: number) => Buffer}} crypto
 * @property {((message: string) => void) & {enabled?: boolean}} debug
 * @property {(value: number|bigint|string|Buffer) => number|bigint} divideBaseDiff
 * @property {(value: Buffer, options?: {endian?: "big"|"little", size?: number}) => bigint} bigIntFromBuffer
 * @property {(value: number|string|bigint|Buffer) => bigint} toBigInt
 * @property {number|string|bigint} baseRavenDiff
 * @property {AnchorState} anchorState
 * @property {Record<string, PoolBlockTemplate>} activeBlockTemplates
 * @property {Record<string, number>} walletTrust
 * @property {(message: {type: string}) => void} processSend
 * @property {(payout: string, trustKey: string) => void} clearWalletSessionTrust
 * @property {() => string} getThreadName
 * @property {(coin: string|undefined, port?: number) => string} formatCoinPort
 * @property {(label: string, fields?: Record<string, unknown>) => string} [formatPoolEvent]
 * @property {() => boolean} [isBlockSubmitTestModeEnabled]
 * @property {() => Record<string, number>} getLastMinerLogTime
 * @property {(value: Record<string, number>) => void} setLastMinerLogTime
 */

/** @param {unknown} value @returns {value is PoolRpcResult} */
function isRpcResult(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function finiteNumberOr(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

/** @param {ShareBlockDeps} deps */
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

    /** @param {PoolMiner} miner @returns {string} */
    function getMinerTrustKey(miner) {
        return miner.trust_key || miner.payout;
    }

    /** @param {PoolMiner} miner @returns {boolean} */
    function invalidShare(miner) {
        const trustKey = getMinerTrustKey(miner);
        processSend({ type: "invalidShare" });
        miner.sendSameCoinJob();
        if (global.config.pool.trustedMiners) {
            clearWalletSessionTrust(miner.payout, trustKey);
            if (miner.trust) miner.trust.trust = 0;
            if (trustKey in walletTrust) walletTrust[trustKey] = 0;
        }
        return false;
    }

    /** @param {number} rewardDiff @param {string} trustKey @param {number} minerTrust @returns {boolean} */
    function isSafeToTrust(rewardDiff, trustKey, minerTrust) {
        // Only gate trust below the NiceHash difficulty ceiling (XMR niceHashDiff); above it every share is verified.
        if (!(rewardDiff < 400000 && minerTrust !== 0)) return false;
        const trustThreshold = finiteNumberOr(global.config.pool["trustThreshold"], 1);
        const trustMin = finiteNumberOr(global.config.pool["trustMin"], 0);
        // trustChange slows the session-branch trust ramp (>= 1; 1 == legacy behaviour). A higher value makes a
        // miner re-earn trust over more verified shares after a reset, which lowers the sustainable fake-share
        // fraction WITHOUT raising the steady-state verification rate (the gate still floors at trustMin).
        const configuredTrustChange = finiteNumberOr(global.config.pool["trustChange"], 1);
        const trustChange = configuredTrustChange > 0 ? configuredTrustChange : 1;
        const rewardDiff2 = rewardDiff * trustThreshold;
        const walletTrustValue = walletTrust[trustKey];
        const walletOk = (trustKey in walletTrust) && typeof walletTrustValue === "number" && rewardDiff2 * trustThreshold < walletTrustValue;
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

    /** @param {Buffer} hash @returns {number|bigint} */
    function hashBuffDiff(hash) {
        return divideBaseDiff(bigIntFromBuffer(hash, { endian: "little", size: 32 }));
    }

    /** @param {Buffer} hash @returns {number} */
    function hashRavenBuffDiff(hash) {
        return Number(baseRavenDiff) / Number(bigIntFromBuffer(hash));
    }

    /** @param {Buffer} hash @returns {number|bigint} */
    function hashEthBuffDiff(hash) {
        return divideBaseDiff(bigIntFromBuffer(hash));
    }

    /** @param {number|bigint|string|Buffer} left @param {number|bigint|string|Buffer} right @returns {boolean} */
    function ge(left, right) {
        if (typeof left === "bigint" || typeof right === "bigint" || typeof left === "string" || typeof right === "string" || Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
            return toBigInt(left) >= toBigInt(right);
        }
        return left >= right;
    }

    /** @param {PoolMiner} miner @param {PoolJob} job @returns {void} */
    function reportMinerShare(miner, job) {
        const timeNow = Date.now();
        const lastMinerLogTime = getLastMinerLogTime();
        const lastLogTime = lastMinerLogTime[miner.payout];
        if (lastLogTime === undefined || timeNow - lastLogTime > 30 * 1000) {
            console.error(getThreadName() + formatPoolEvent("Bad share", {
                chain: formatCoinPort(job.coin),
                diff: job.difficulty,
                miner: miner.logString
            }));
            lastMinerLogTime[miner.payout] = timeNow;
            setLastMinerLogTime(lastMinerLogTime);
        }
    }

    /** @returns {boolean} */
    function shouldSuppressBlockSubmitFailureEmail() {
        return isBlockSubmitTestModeEnabled() === true;
    }

    /** @param {unknown} value @returns {string} */
    function formatDiff(value) {
        return value === undefined || value === null || value === "" ? "unknown" : String(value);
    }

    /** @param {DiffRow[]} rows @returns {string} */
    function formatDiffRows(rows) {
        const labelWidth = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
        const valueWidth = rows.reduce((max, row) => Math.max(max, formatDiff(row.value).length), 0);
        return rows.map((row) => `\n${  row.label.padEnd(labelWidth)  }: ${  formatDiff(row.value).padStart(valueWidth)}`).join("");
    }

    /** @param {PoolBlockTemplate} blockTemplate @param {Buffer|unknown[]} blockData @param {Buffer|null} resultBuff @param {PoolJob} job @param {PoolMiner} miner @param {(result: LocalBlockCheck|null) => unknown} callback @returns {unknown} */
    function getLocalBlockCheck(blockTemplate, blockData, resultBuff, job, miner, callback) {
        if (!Buffer.isBuffer(blockData)) return callback(null);
        let convertedBlob;
        try {
            convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
        } catch (_error) {
            return callback(null);
        }
        if (!convertedBlob) return callback(null);

        /** @param {Buffer|Buffer[]|null|false} buff @returns {unknown} */
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

    /** @param {PoolBlockTemplate} blockTemplate @param {Buffer|unknown[]} blockData @param {Buffer|null} resultBuff @param {number|bigint} hashDiff @param {number|bigint|string|undefined|null} requiredDiff @param {PoolJob} job @param {PoolMiner} miner @param {(message: string) => unknown} callback @returns {unknown} */
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

    /**
     * @param {PoolMiner} miner
     * @param {PoolJob} job
     * @param {PoolBlockTemplate} blockTemplate
     * @param {Buffer|unknown[]} blockData
     * @param {Buffer|null} resultBuff
     * @param {number|bigint} hashDiff
     * @param {boolean} isTrustedShare
     * @param {boolean} isParentBlock
     * @param {number|boolean|null|undefined} portUsedToSubmit
     * @param {((success: boolean) => void)|null|undefined} submitBlockCB
     * @param {PoolSubmitParams|undefined} submitParams
     * @param {number|undefined} submitRetryCount
     * @returns {unknown}
     */
    function submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, portUsedToSubmit, submitBlockCB, submitParams, submitRetryCount) {
        // eslint-disable-next-line eqeqeq -- intentional loose compare: config daemon.port may be a string while template port is numeric
        const isMainPort = global.config.daemon.port == blockTemplate.port;
        const profile = global.coinFuncs.getPoolProfile(blockTemplate.port);
        const poolSettings = profile && profile.pool ? profile.pool : {};
        const dualDisplayCoin = poolSettings.dualSubmitDisplayCoin;
        const configuredDualDisplayPort = poolSettings.dualSubmitReportPort;
        const mappedDualDisplayPort = typeof configuredDualDisplayPort === "number" || !dualDisplayCoin
            ? undefined
            : global.coinFuncs.COIN2PORT(dualDisplayCoin);
        const dualDisplayPort = typeof configuredDualDisplayPort === "number"
            ? configuredDualDisplayPort
            : mappedDualDisplayPort ?? blockTemplate.port;
        const currentSubmitRetryCount = submitRetryCount || 0;

        /** @param {unknown} rpcResult @returns {boolean} */
        function isSubmitFailure(rpcResult) {
            if (!isRpcResult(rpcResult)) return false;
            if (rpcResult.error) return true;
            const result = rpcResult.result;
            return (typeof result === "boolean" || typeof result === "string") && BLOCK_SUBMIT_FAILURE_RESULTS.has(result);
        }

        /** @returns {void} */
        function resetShareTrust() {
            if (!global.config.pool.trustedMiners) return;
            const trustKey = getMinerTrustKey(miner);
            debug(getThreadName() + formatPoolEvent("Share trust reset", { miner: miner.logString }));
            clearWalletSessionTrust(miner.payout, trustKey);
            if (miner.trust) miner.trust.trust = 0;
            if (trustKey in walletTrust) walletTrust[trustKey] = 0;
        }

        /** @param {(notifyAdmin: boolean) => unknown} callback @returns {unknown} */
        function shouldNotifySubmitFailure(callback) {
            if (!(isParentBlock && isTrustedShare && !shouldSuppressBlockSubmitFailureEmail())) return callback(true);
            if (!Buffer.isBuffer(blockData)) return callback(false);
            let convertedBlob;
            try {
                convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
            } catch (_error) {
                return callback(false);
            }
            if (!convertedBlob) return callback(false);

            /** @param {Buffer|Buffer[]|null|false} buff @returns {unknown} */
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

        /** @param {boolean} isDisplaySubmitPort @returns {boolean} */
        function shouldRetryXmrSubmitFailure(isDisplaySubmitPort) {
            return !isDisplaySubmitPort && blockTemplate.coin === "" && currentSubmitRetryCount === 0;
        }

        /** @param {number} port @param {((success: boolean) => void)|null|undefined} nextSubmitBlockCB @param {number} delayMs @returns {NodeJS.Timeout} */
        function retrySubmit(port, nextSubmitBlockCB, delayMs) {
            return setTimeout(submitBlock, delayMs, miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, port, nextSubmitBlockCB, submitParams, currentSubmitRetryCount + 1);
        }

        /** @param {string} newBlockHash @param {boolean} isDisplaySubmitPort @param {number|undefined} reportDiff @param {number} reportPort @param {number} reportHeight @returns {void} */
        function storeResolvedBlock(newBlockHash, isDisplaySubmitPort, reportDiff, reportPort, reportHeight) {
            const timeNow = Date.now();
            if (isMainPort && !isDisplaySubmitPort) {
                const blockDifficulty = finiteNumberOr(blockTemplate.xmr_difficulty, blockTemplate.difficulty);
                const database = getRemoteDatabase(global.database);
                database.storeBlock(blockTemplate.height, global.protos.Block.encode({ hash: newBlockHash, difficulty: blockDifficulty, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true }));
            } else {
                // roundHashes is accumulated in raw hash-work units. Coins whose
                // Stratum difficulty represents several hashes per difficulty
                // must store the matching work denominator or displayed effort
                // is inflated by that conversion factor.
                const effectiveReportDiff = finiteNumberOr(reportDiff, 0);
                const workDifficulty = typeof global.coinFuncs.getPoolWorkDifficulty === "function"
                    ? global.coinFuncs.getPoolWorkDifficulty(reportPort, effectiveReportDiff)
                    : effectiveReportDiff;
                const anchorHeight = finiteNumberOr(anchorState.current, 0);
                const database = getRemoteDatabase(global.database);
                database.storeAltBlock(Math.floor(timeNow / 1000), global.protos.AltBlock.encode({ hash: newBlockHash, difficulty: workDifficulty, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true, port: reportPort, height: reportHeight, anchor_height: anchorHeight }));
            }
        }

        /** @param {string} reportCoinPort @param {number} reportHeight @param {string} blockDataStr @param {unknown} rpcResult @param {(callback: (message: string) => unknown) => unknown} getDiffMessage @returns {void} */
        function sendSubmitFailureEmail(reportCoinPort, reportHeight, blockDataStr, rpcResult, getDiffMessage) {
            setTimeout(function () {
                if (typeof global.coinFuncs.getPortLastBlockHeader !== "function") return;
                global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function onHeader(err, body) {
                    if (err !== null || !body) return console.error(getThreadName() + formatPoolEvent("Header fetch failed", { chain: formatCoinPort(blockTemplate.coin, blockTemplate.port) }));
                    if (blockTemplate.height === body.height + 1) {
                        getDiffMessage(function onDiffMessage(diffMessage) {
                            global.support.sendAdminFyi(`pool:block-submit:${  reportCoinPort}`, `FYI: Can't submit ${  reportCoinPort  } block to daemon`, `The pool server: ${  global.config.hostname  } can't submit block to daemon on ${  reportCoinPort  }${diffMessage  }\nInput: ${  blockDataStr  }\n${  getThreadName()  }Error submitting ${  reportCoinPort  } block at ${  reportHeight  } height from ${  miner.logString  }, isTrustedShare: ${  isTrustedShare  } error ): ${  JSON.stringify(rpcResult)}`);
                        });
                    }
                }, true);
            }, 2 * 1000);
        }

        /** @param {number} port @param {boolean|undefined} isDisplaySubmitPortOverride @returns {{activeHeight: number, isDisplaySubmitPort: boolean, reportCoinPort: string, reportDiff: number, reportHeight: number, reportPort: number}} */
        function buildSubmitReport(port, isDisplaySubmitPortOverride) {
            const isDisplaySubmitPort = typeof isDisplaySubmitPortOverride === "boolean"
                ? isDisplaySubmitPortOverride
                : port === global.config.daemon.port && Boolean(dualDisplayCoin);
            const reportCoin = isDisplaySubmitPort ? dualDisplayCoin : blockTemplate.coin;
            const reportDiff = isDisplaySubmitPort ? blockTemplate.xtm_difficulty ?? blockTemplate.difficulty : blockTemplate.difficulty;
            const reportPort = isDisplaySubmitPort ? dualDisplayPort : blockTemplate.port;
            const reportHeight = isDisplaySubmitPort ? blockTemplate.xtm_height ?? blockTemplate.height : blockTemplate.height;
            const activeTemplate = activeBlockTemplates[blockTemplate.coin] || blockTemplate;
            const activeHeight = isDisplaySubmitPort ? activeTemplate.xtm_height ?? activeTemplate.height : activeTemplate.height;
            return { activeHeight, isDisplaySubmitPort, reportCoinPort: formatCoinPort(reportCoin, reportPort), reportDiff, reportHeight, reportPort };
        }

        /** @param {PoolRpcResult} rpcResult @param {number|undefined} rpcStatus @param {number} port @param {((success: boolean) => void)|null|undefined} nextSubmitBlockCB @param {boolean|undefined} [isDisplaySubmitPortOverride] @returns {unknown} */
        const replyFn = function (rpcResult, rpcStatus, port, nextSubmitBlockCB, isDisplaySubmitPortOverride) {
            const { activeHeight, isDisplaySubmitPort, reportCoinPort, reportDiff, reportHeight, reportPort } = buildSubmitReport(port, isDisplaySubmitPortOverride);
            const requiredBlockDiff = isMainPort && !isDisplaySubmitPort && blockTemplate.xmr_difficulty ? blockTemplate.xmr_difficulty : reportDiff;
            /** @param {(message: string) => unknown} callback @returns {unknown} */
            const getDiffMessage = function (callback) {
                return getBlockSubmitDiffMessage(blockTemplate, blockData, resultBuff, hashDiff, requiredBlockDiff, job, miner, callback);
            };
            const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString("hex") : JSON.stringify(blockData);

            if (isSubmitFailure(rpcResult)) {
                if (shouldRetryXmrSubmitFailure(isDisplaySubmitPort)) {
                    console.warn(`${getThreadName() + formatPoolEvent("Block submit retry", {
                        chain: reportCoinPort,
                        height: reportHeight,
                        activeHeight,
                        miner: miner.logString,
                        trusted: isTrustedShare,
                        rpcStatus,
                        error: rpcResult
                    })  }, block hex: \n${  blockDataStr}`);
                    return retrySubmit(port, nextSubmitBlockCB, SUBMIT_RETRY_DELAY_MS);
                }
                return shouldNotifySubmitFailure(function onSubmitFailureNotify(isNotifyAdmin) {
                    console.error(`${getThreadName() + formatPoolEvent("Block submit failed", {
                        chain: reportCoinPort,
                        height: reportHeight,
                        activeHeight,
                        miner: miner.logString,
                        trusted: isTrustedShare,
                        valid: isNotifyAdmin,
                        rpcStatus,
                        error: rpcResult
                    })  }, block hex: \n${  blockDataStr}`);

                    if (isNotifyAdmin && !shouldSuppressBlockSubmitFailureEmail()) {
                        sendSubmitFailureEmail(reportCoinPort, reportHeight, blockDataStr, rpcResult, getDiffMessage);
                    }
                    resetShareTrust();
                    if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
                });
            }

            const acceptSubmittedBlock = poolSettings.acceptSubmittedBlock;
            const resolveSubmittedBlockHash = poolSettings.resolveSubmittedBlockHash;
            if (typeof acceptSubmittedBlock === "function" && typeof resolveSubmittedBlockHash === "function" && acceptSubmittedBlock({
                rpcResult,
                ...(typeof rpcStatus === "number" ? { rpcStatus } : {})
            })) {
                resolveSubmittedBlockHash({
                    blockData,
                    blockTemplate,
                    coinFuncs: global.coinFuncs,
                    isDisplaySubmitPort,
                    resultBuff,
                    rpcResult
                }, function onBlockHash(newBlockHash) {
                    if (newBlockHash === "0".repeat(64)) {
                        const errorMessage = `${getThreadName() + formatPoolEvent("Block hash unresolved", {
                            chain: reportCoinPort,
                            hash: newBlockHash,
                            height: reportHeight,
                            miner: miner.logString,
                            trusted: isTrustedShare,
                            submit: rpcResult
                        })  }, block hex: \n${  blockDataStr}`;
                        console.error(errorMessage);
                        global.support.sendAdminFyi(`pool:zero-hash-block:${  reportCoinPort}`, `FYI: Dropped unresolved zero-hash block on ${  reportCoinPort}`, errorMessage);
                        if (nextSubmitBlockCB) return nextSubmitBlockCB(true);
                        return;
                    }
                    console.log(`${getThreadName() + formatPoolEvent("Block found", {
                        chain: reportCoinPort,
                        hash: newBlockHash,
                        height: reportHeight,
                        miner: miner.logString,
                        trusted: isTrustedShare,
                        submit: rpcResult
                    })  }, block hex: \n${  blockDataStr}`);
                    storeResolvedBlock(newBlockHash, isDisplaySubmitPort, reportDiff, reportPort, reportHeight);
                    if (nextSubmitBlockCB) return nextSubmitBlockCB(true);
                });
                return;
            }

            if (!portUsedToSubmit) {
                console.error(`${getThreadName() + formatPoolEvent("Block submit unknown", {
                    chain: reportCoinPort,
                    height: reportHeight,
                    activeHeight,
                    miner: miner.logString,
                    trusted: isTrustedShare,
                    rpcStatus,
                    errorType: typeof rpcResult,
                    error: rpcResult
                })  }, block hex: \n${  blockDataStr}`);
                return retrySubmit(port, nextSubmitBlockCB, SUBMIT_RETRY_DELAY_MS);
            }
            console.error(`${getThreadName() + formatPoolEvent("Block submit rpc-error", {
                chain: reportCoinPort,
                height: reportHeight,
                activeHeight,
                miner: miner.logString,
                trusted: isTrustedShare,
                rpcStatus,
                errorType: typeof rpcResult,
                error: rpcResult
            })  }, block hex: \n${  blockDataStr}`);
            if (!shouldSuppressBlockSubmitFailureEmail()) {
                const submitCoinPort = reportCoinPort;
                return getDiffMessage(function onRpcErrorDiff(diffMessage) {
                    global.support.sendAdminFyi(`pool:block-submit-rpc:${  submitCoinPort}`, `FYI: Can't submit block to daemon on ${  submitCoinPort}`, `Input: ${  blockDataStr  }\nThe pool server: ${  global.config.hostname  } can't submit block to daemon on ${  submitCoinPort  }${diffMessage  }\nRPC Error. Please check logs for details`);
                    if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
                });
            }
            if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
            return undefined;
        };

        /** @param {PoolRpcResult} rpcResult @param {number|undefined} rpcStatus @returns {unknown} */
        const stdReplyFn = function (rpcResult, rpcStatus) {
            return replyFn(rpcResult, rpcStatus, blockTemplate.port, submitBlockCB);
        };

        try {
            const submitBlockRpc = poolSettings.submitBlockRpc;
            if (typeof submitBlockRpc !== "function") {
                return stdReplyFn({ error: { code: -1, message: "submitBlockRpc is unavailable" } }, 0);
            }
            const submitPort = typeof portUsedToSubmit === "number" ? portUsedToSubmit : undefined;
            // Verification keeps exact bigint difficulty; profile submitters expose a numeric context.
            const submitHashDiff = typeof hashDiff === "bigint" ? Number(hashDiff) : hashDiff;
            /** @type {import("../../types/pool_profiles").PoolSubmitBlockContext} */
            const submitContext = {
                blockData,
                blockTemplate,
                hashDiff: submitHashDiff,
                isBlockSubmitTestModeEnabled,
                isParentBlock,
                isTrustedShare,
                job,
                params: submitParams,
                replyDispatcher: replyFn,
                replyFn: stdReplyFn,
                suppressFailureEmail: shouldSuppressBlockSubmitFailureEmail(),
                support: global.support
            };
            if (submitPort !== undefined) submitContext.portUsedToSubmit = submitPort;
            if (submitBlockCB !== undefined) submitContext.submitBlockCB = submitBlockCB;
            return Reflect.apply(submitBlockRpc, poolSettings, [submitContext]);
        } catch (error) {
            const errorRecord = error instanceof Error ? error : isRpcResult(error) ? error : null;
            const message = errorRecord && typeof errorRecord.message === "string" ? errorRecord.message : String(error);
            console.error(getThreadName() + formatPoolEvent("Block submit exception", {
                chain: formatCoinPort(blockTemplate.coin, blockTemplate.port),
                height: blockTemplate.height,
                miner: miner.logString,
                params: submitParams,
                trusted: isTrustedShare,
                error: errorRecord && typeof errorRecord.stack === "string" ? errorRecord.stack : message
            }));
            return stdReplyFn({ error: { code: -1, message: `SubmitBlock exception: ${  message}` } }, 0);
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
