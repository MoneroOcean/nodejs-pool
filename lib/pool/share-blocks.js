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
        getThreadName,
        getLastMinerLogTime,
        setLastMinerLogTime
    } = deps;

    function invalidShare(miner) {
        processSend({ type: "invalidShare" });
        miner.sendSameCoinJob();
        walletTrust[miner.payout] = 0;
        return false;
    }

    function readUInt64BE(buf, offset = 0) {
        const hi = BigInt(buf.readUInt32BE(offset));
        const lo = BigInt(buf.readUInt32BE(offset + 4));
        return ((hi << 32n) | lo).toString(10);
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
            console.error(getThreadName() + "Bad " + job.coin + " coin share from miner (diff " + job.difficulty + ") " + miner.logString);
            lastMinerLogTime[miner.payout] = timeNow;
            setLastMinerLogTime(lastMinerLogTime);
        }
    }

    function submitBlock(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, portUsedToSubmit, submitBlockCB) {
        const isMainPort = global.config.daemon.port == blockTemplate.port;
        const replyFn = function (rpcResult, rpcStatus, port, nextSubmitBlockCB) {
            const isTariPort = port === global.config.daemon.port;
            const reportCoin = isTariPort ? "XTM" : blockTemplate.coin;
            const reportDiff = isTariPort ? blockTemplate.xtm_difficulty : blockTemplate.difficulty;
            const reportPort = isTariPort ? 18144 : blockTemplate.port;
            const reportHeight = isTariPort ? blockTemplate.xtm_height : blockTemplate.height;
            const activeHeight = isTariPort ? activeBlockTemplates[blockTemplate.coin].xtm_height : activeBlockTemplates[blockTemplate.coin].height;
            const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString("hex") : JSON.stringify(blockData);
            const blobTypeNum = global.coinFuncs.portBlobType(blockTemplate.port, blockTemplate.block_version);

            if (rpcResult && (rpcResult.error || rpcResult.result === "high-hash" || rpcResult.result === "bad-txnmrklroot" || rpcResult.result === "bad-cbtx-mnmerkleroot")) {
                let isNotifyAdmin = true;
                if (isParentBlock && isTrustedShare) {
                    const convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
                    const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
                    if (!buff.equals(resultBuff)) isNotifyAdmin = false;
                }
                console.error(getThreadName() + "Error submitting " + reportCoin + " (port " + reportPort + ") block at height " + reportHeight + " (active block template height: " + activeHeight + ") from " + miner.logString + ", isTrustedShare: " + isTrustedShare + ", valid: " + isNotifyAdmin + ", rpcStatus: " + rpcStatus + ", error: " + JSON.stringify(rpcResult) + ", block hex: \n" + blockDataStr);

                if (isNotifyAdmin) {
                    setTimeout(function () {
                        if (typeof global.coinFuncs.getPortLastBlockHeader !== "function") return;
                        global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function (err, body) {
                            if (err !== null) return console.error("Last block header request failed for " + blockTemplate.port + " port!");
                            if (blockTemplate.height == body.height + 1) {
                                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit " + reportCoin + " block to deamon on " + reportPort + " port", "The pool server: " + global.config.hostname + " can't submit block to deamon on " + reportPort + " port\nInput: " + blockDataStr + "\n" + getThreadName() + "Error submitting " + reportCoin + " block at " + reportHeight + " height from " + miner.logString + ", isTrustedShare: " + isTrustedShare + " error ): " + JSON.stringify(rpcResult));
                            }
                        });
                    }, 2 * 1000);
                }
                if (global.config.pool.trustedMiners) {
                    debug(getThreadName() + "Share trust broken by " + miner.logString);
                    miner.trust.trust = 0;
                    walletTrust[miner.payout] = 0;
                }
                if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
                return;
            }

            if (rpcResult && (
                (isMainPort && typeof rpcResult.result === "object" && rpcResult.result && rpcResult.result.status === "OK") ||
                (!isMainPort && typeof rpcResult.result !== "undefined") ||
                (rpcResult.response !== "rejected" && global.coinFuncs.blobTypeErg(blobTypeNum)) ||
                (typeof rpcResult === "string" && rpcStatus == 202 && blockTemplate.port == 11898)
            )) {
                const getBlockId = function (cb) {
                    if (global.coinFuncs.blobTypeDero(blobTypeNum)) return cb(rpcResult.result.blid);
                    if (global.coinFuncs.blobTypeRvn(blobTypeNum)) return cb(resultBuff.toString("hex"));
                    if (global.coinFuncs.blobTypeErg(blobTypeNum)) return setTimeout(global.coinFuncs.getPortBlockHeaderByID, 10 * 1000, blockTemplate.port, blockTemplate.height, function (err, body) {
                        cb(err === null && body.powSolutions.pk === blockTemplate.hash2 ? body.id : "0".repeat(64));
                    });
                    if (global.coinFuncs.blobTypeEth(blobTypeNum)) return setTimeout(global.coinFuncs.ethBlockFind, 30 * 1000, blockTemplate.port, blockData[0], function (blockHash) {
                        cb(blockHash ? blockHash.substr(2) : "0".repeat(64));
                    });
                    if (isTariPort && typeof rpcResult.result === "object" && rpcResult.result && global.coinFuncs.getAuxChainXTM(rpcResult.result)) return cb(rpcResult.result._aux.chains[0].block_hash);
                    if (global.coinFuncs.blobTypeXTM_C(blobTypeNum) || global.coinFuncs.blobTypeXTM_T(blobTypeNum)) return cb(Buffer.from(rpcResult.result.block_hash).toString("hex"));
                    return cb(global.coinFuncs.getBlockID(blockData, blockTemplate.port).toString("hex"));
                };

                getBlockId(function (newBlockHash) {
                    console.log(getThreadName() + "New " + reportCoin + " (port " + reportPort + ") block " + newBlockHash + " found at height " + reportHeight + " by " + miner.logString + ", isTrustedShare: " + isTrustedShare + " - submit result: " + JSON.stringify(rpcResult) + ", block hex: \n" + blockDataStr);
                    const timeNow = Date.now();
                    if (isMainPort && !isTariPort) {
                        global.database.storeBlock(blockTemplate.height, global.protos.Block.encode({ hash: newBlockHash, difficulty: blockTemplate.xmr_difficulty, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true }));
                    } else {
                        global.database.storeAltBlock(Math.floor(timeNow / 1000), global.protos.AltBlock.encode({ hash: newBlockHash, difficulty: reportDiff, shares: 0, timestamp: timeNow, poolType: miner.poolTypeEnum, unlocked: false, valid: true, port: reportPort, height: reportHeight, anchor_height: anchorState.current }));
                    }
                    if (nextSubmitBlockCB) return nextSubmitBlockCB(true);
                });
                return;
            }

            if (!portUsedToSubmit) {
                console.error(getThreadName() + "Unknown error submitting " + reportCoin + " (port " + reportPort + ") block at height " + reportHeight + " (active block template height: " + activeHeight + ") from " + miner.logString + ", isTrustedShare: " + isTrustedShare + ", rpcStatus: " + rpcStatus + ", error (" + (typeof rpcResult) + "): " + JSON.stringify(rpcResult) + ", block hex: \n" + blockDataStr);
                return setTimeout(submitBlock, 500, miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, port, nextSubmitBlockCB);
            }
            console.error(getThreadName() + "RPC Error. Please check logs for details");
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit block to deamon on " + blockTemplate.port + " port", "Input: " + blockDataStr + "\nThe pool server: " + global.config.hostname + " can't submit block to deamon on " + blockTemplate.port + " port\nRPC Error. Please check logs for details");
            if (nextSubmitBlockCB) return nextSubmitBlockCB(false);
        };

        const stdReplyFn = function (rpcResult, rpcStatus) {
            return replyFn(rpcResult, rpcStatus, blockTemplate.port, submitBlockCB);
        };

        if (blockTemplate.port == 11898) global.support.rpcPortDaemon2(blockTemplate.port, "block", blockData.toString("hex"), stdReplyFn);
        else if (global.coinFuncs.blobTypeRvn(job.blob_type_num) || global.coinFuncs.blobTypeRtm(job.blob_type_num) || global.coinFuncs.blobTypeKcn(job.blob_type_num)) global.support.rpcPortDaemon2(blockTemplate.port, "", { method: "submitblock", params: [blockData.toString("hex")] }, stdReplyFn);
        else if (global.coinFuncs.blobTypeEth(job.blob_type_num)) global.support.rpcPortDaemon2(blockTemplate.port, "", { method: "eth_submitWork", params: blockData, jsonrpc: "2.0", id: 0 }, stdReplyFn);
        else if (global.coinFuncs.blobTypeErg(job.blob_type_num)) global.support.rpcPortDaemon2(blockTemplate.port, "mining/solution", { n: blockData }, stdReplyFn);
        else if (global.coinFuncs.blobTypeDero(job.blob_type_num)) global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [blockTemplate.blocktemplate_blob, blockData.toString("hex")], stdReplyFn);
        else if (global.coinFuncs.blobTypeXTM_T(job.blob_type_num)) {
            blockTemplate.xtm_block.header.nonce = blockData.readUInt32BE(3 + 32 + 4).toString();
            blockTemplate.xtm_block.header.pow.pow_data = [...blockData.slice(3 + 32 + 8 + 1)];
            global.support.rpcPortDaemon(blockTemplate.port, "SubmitBlock", blockTemplate.xtm_block, stdReplyFn);
        } else if (global.coinFuncs.blobTypeXTM_C(job.blob_type_num)) {
            blockTemplate.xtm_block.header.nonce = readUInt64BE(blockData, 0);
            blockTemplate.xtm_block.header.pow.pow_data = job.c29_packed_edges;
            global.support.rpcPortDaemon(blockTemplate.port, "SubmitBlock", blockTemplate.xtm_block, stdReplyFn);
        } else if (isMainPort) {
            const isXmr = parseInt(hashDiff) >= blockTemplate.xmr_difficulty;
            const isXtm = parseInt(hashDiff) >= blockTemplate.xtm_difficulty;
            if (isXmr && (!portUsedToSubmit || portUsedToSubmit === blockTemplate.port + 2)) global.support.rpcPortDaemon(blockTemplate.port + 2, "submitblock", [blockData.toString("hex")], function (rpcResult, rpcStatus) {
                return replyFn(rpcResult, rpcStatus, blockTemplate.port + 2, submitBlockCB);
            });
            if (isXtm && (!portUsedToSubmit || portUsedToSubmit === blockTemplate.port)) global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [blockData.toString("hex")], function (rpcResult, rpcStatus) {
                return replyFn(rpcResult, rpcStatus, blockTemplate.port, isXmr ? null : submitBlockCB);
            });
            if (!isXmr && !isXtm) {
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit low diff block to deamon on " + blockTemplate.port + " port", "The pool server: " + global.config.hostname + " can't submit low diff block to deamon on " + blockTemplate.port + " port");
                global.support.rpcPortDaemon(blockTemplate.port + 2, "submitblock", [blockData.toString("hex")], function (rpcResult, rpcStatus) {
                    return replyFn(rpcResult, rpcStatus, blockTemplate.port + 2, submitBlockCB);
                });
                global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [blockData.toString("hex")], function (rpcResult, rpcStatus) {
                    return replyFn(rpcResult, rpcStatus, blockTemplate.port, null);
                });
            }
        } else {
            global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [blockData.toString("hex")], stdReplyFn);
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
