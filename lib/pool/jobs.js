"use strict";

// Miner jobs are protocol-facing views over block templates. Keeping them in a
// separate module makes it easier to refactor protocol handling without
// re-auditing the template-to-job conversion rules.
module.exports = function createMinerJobs(state) {
    return function attachMinerJobMethods(miner, deps) {
        const {
            protoVersion,
            getCoinJobParams,
            getNewId,
            getNewEthJobId,
            getTargetHex,
            getRavenTargetHex,
            toBigInt,
            divideBaseDiff
        } = deps;

        if (protoVersion !== 1) return miner;

        miner.getCoinJob = function getCoinJob(coin, params) {
            const bt = params.bt;
            if (miner.jobLastBlockHash === bt.idHash && !miner.newDiffToSet && miner.cachedJob !== null) return null;
            miner.jobLastBlockHash = bt.idHash;

            if (miner.newDiffToSet) {
                miner.difficulty = miner.newDiffToSet;
                miner.newDiffToSet = null;
                miner.newDiffRecommendation = null;
            } else if (miner.newDiffRecommendation) {
                miner.difficulty = miner.newDiffRecommendation;
                miner.newDiffRecommendation = null;
            }

            let coinDiff = miner.difficulty / miner.curr_coin_hash_factor;
            if (coinDiff < miner.curr_coin_min_diff) coinDiff = miner.curr_coin_min_diff;
            if (coinDiff > bt.difficulty) coinDiff = bt.difficulty;

            const blobTypeNum = global.coinFuncs.portBlobType(bt.port);
            const isEth = global.coinFuncs.blobTypeEth(blobTypeNum);
            const isErg = global.coinFuncs.blobTypeErg(blobTypeNum);
            const isExtraNonceBT = isEth || isErg;

            if (!miner.proxy || isExtraNonceBT) {
                const blobHex = bt.nextBlobHex();
                if (!blobHex) return null;
                const isXTM_C = global.coinFuncs.blobTypeXTM_C(blobTypeNum);
                const isGrin = global.coinFuncs.blobTypeGrin(blobTypeNum);
                const isRvn = global.coinFuncs.blobTypeRvn(blobTypeNum);
                const newJob = {
                    id: isRvn ? getNewEthJobId() : getNewId(),
                    coin,
                    blob_type_num: blobTypeNum,
                    blockHash: bt.idHash,
                    extraNonce: isExtraNonceBT ? miner.eth_extranonce : bt.extraNonce,
                    height: bt.height,
                    seed_hash: bt.seed_hash,
                    difficulty: coinDiff,
                    norm_diff: coinDiff * miner.curr_coin_hash_factor,
                    coinHashFactor: params.coinHashFactor,
                    submissions: new Map()
                };
                miner.validJobs.enq(newJob);

                if (isXTM_C) {
                    miner.cachedJob = {
                        blob: blobHex,
                        algo: "cuckaroo",
                        proofsize: global.coinFuncs.c29ProofSize(blobTypeNum),
                        noncebytes: global.coinFuncs.nonceSize(blobTypeNum),
                        nonceoffset: 0,
                        height: bt.height,
                        job_id: newJob.id,
                        target: getTargetHex(coinDiff, global.coinFuncs.nonceSize(blobTypeNum)),
                        id: miner.id
                    };
                } else if (isGrin) {
                    miner.cachedJob = {
                        pre_pow: blobHex,
                        algo: miner.protocol === "grin" ? "cuckaroo" : params.algo_name,
                        edgebits: 29,
                        proofsize: global.coinFuncs.c29ProofSize(blobTypeNum),
                        noncebytes: 4,
                        height: bt.height,
                        job_id: newJob.id,
                        difficulty: coinDiff,
                        id: miner.id
                    };
                } else if (isRvn) {
                    miner.cachedJob = [newJob.id, blobHex, bt.seed_hash, getRavenTargetHex(coinDiff), true, bt.height, bt.bits];
                } else if (isEth) {
                    miner.cachedJob = [newJob.id, bt.seed_hash, blobHex, true, coinDiff];
                } else if (isErg) {
                    miner.cachedJob = [
                        newJob.id,
                        bt.height,
                        bt.hash,
                        "",
                        "",
                        2,
                        (toBigInt(global.coinFuncs.baseDiff()) / toBigInt(coinDiff)).toString(),
                        "",
                        true
                    ];
                } else {
                    miner.cachedJob = {
                        blob: blobHex,
                        algo: params.algo_name,
                        height: bt.height,
                        seed_hash: bt.seed_hash,
                        job_id: newJob.id,
                        target: getTargetHex(coinDiff, global.coinFuncs.nonceSize(blobTypeNum)),
                        id: miner.id
                    };
                }
            } else {
                const blobHex = bt.nextBlobWithChildNonceHex();
                const newJob = {
                    id: getNewId(),
                    coin,
                    blob_type_num: blobTypeNum,
                    blockHash: bt.idHash,
                    extraNonce: bt.extraNonce,
                    height: bt.height,
                    seed_hash: bt.seed_hash,
                    difficulty: coinDiff,
                    norm_diff: coinDiff * miner.curr_coin_hash_factor,
                    clientPoolLocation: bt.clientPoolLocation,
                    clientNonceLocation: bt.clientNonceLocation,
                    coinHashFactor: params.coinHashFactor,
                    submissions: new Map()
                };
                miner.validJobs.enq(newJob);
                miner.cachedJob = {
                    blocktemplate_blob: blobHex,
                    blob_type: global.coinFuncs.blobTypeStr(bt.port, bt.block_version),
                    algo: params.algo_name,
                    difficulty: bt.difficulty,
                    height: bt.height,
                    seed_hash: bt.seed_hash,
                    reserved_offset: bt.reserved_offset,
                    client_nonce_offset: bt.clientNonceLocation,
                    client_pool_offset: bt.clientPoolLocation,
                    target_diff: coinDiff,
                    job_id: newJob.id,
                    id: miner.id
                };
            }

            return miner.cachedJob;
        };

        miner.sendCoinJob = function sendCoinJob(coin, params) {
            const job = miner.getCoinJob(coin, params);
            if (job === null) return;

            const blobTypeNum = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(coin));
            if (miner.protocol === "grin") {
                miner.pushMessage({ method: "getjobtemplate", result: job });
                return;
            }
            if (global.coinFuncs.blobTypeRvn(blobTypeNum)) {
                const target = job[3];
                if (!miner.last_target || miner.last_target !== target) {
                    miner.pushMessage({ method: "mining.set_target", params: [target], id: null });
                    miner.last_target = target;
                }
                miner.pushMessage({ method: "mining.notify", params: job, algo: params.algo_name, id: null });
                return;
            }
            if (global.coinFuncs.blobTypeEth(blobTypeNum)) {
                const notifyJob = job.slice();
                const diff = notifyJob.pop() / 0x100000000;
                if (!miner.last_diff || miner.last_diff !== diff) {
                    miner.pushMessage({ method: "mining.set_difficulty", params: [diff] });
                    miner.last_diff = diff;
                }
                miner.pushMessage({ method: "mining.notify", params: notifyJob, algo: params.algo_name });
                return;
            }
            if (global.coinFuncs.blobTypeErg(blobTypeNum)) {
                miner.pushMessage({ method: "mining.notify", params: job, algo: params.algo_name });
                return;
            }
            miner.pushMessage({ method: "job", params: job });
        };

        miner.sendSameCoinJob = function sendSameCoinJob() {
            const coin = typeof miner.curr_coin !== "undefined" ? miner.curr_coin : miner.selectBestCoin();
            if (coin !== false) miner.sendCoinJob(coin, getCoinJobParams(coin));
        };

        miner.getBestCoinJob = function getBestCoinJob() {
            const coin = miner.selectBestCoin();
            if (coin !== false) return miner.getCoinJob(coin, getCoinJobParams(coin));
            return undefined;
        };

        miner.sendBestCoinJob = function sendBestCoinJob() {
            const coin = miner.selectBestCoin();
            if (coin !== false) miner.sendCoinJob(coin, getCoinJobParams(coin));
        };

        return miner;
    };
};
