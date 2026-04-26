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

            const profile = global.coinFuncs.getPoolProfile(bt.port);
            const poolSettings = profile && profile.pool ? profile.pool : {};
            const blobTypeNum = profile ? profile.blobType : global.coinFuncs.portBlobType(bt.port);
            const usesSharedTemplateNonce = poolSettings.sharedTemplateNonces === true;

            if (!miner.proxy || usesSharedTemplateNonce) {
                const blobHex = bt.nextBlobHex();
                if (!blobHex) return null;
                const newJob = {
                    id: poolSettings.useEthJobId ? getNewEthJobId() : getNewId(),
                    coin,
                    blob_type_num: blobTypeNum,
                    blockHash: bt.idHash,
                    extraNonce: usesSharedTemplateNonce ? miner.eth_extranonce : bt.extraNonce,
                    height: bt.height,
                    seed_hash: bt.seed_hash,
                    difficulty: coinDiff,
                    norm_diff: coinDiff * miner.curr_coin_hash_factor,
                    coinHashFactor: params.coinHashFactor,
                    submissions: new Map()
                };
                miner.validJobs.enq(newJob);

                miner.cachedJob = poolSettings.buildJobPayload({
                    blobHex,
                    blobTypeNum,
                    blockTemplate: bt,
                    coin,
                    coinDiff,
                    coinFuncs: global.coinFuncs,
                    getRavenTargetHex,
                    getTargetHex,
                    miner,
                    newJob,
                    params,
                    toBigInt
                });
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
                miner.cachedJob = poolSettings.buildProxyJobPayload({
                    blobHex,
                    blobTypeNum,
                    blockTemplate: bt,
                    coin,
                    coinDiff,
                    coinFuncs: global.coinFuncs,
                    miner,
                    newJob,
                    params
                });
            }

            return miner.cachedJob;
        };

        miner.sendCoinJob = function sendCoinJob(coin, params) {
            const job = miner.getCoinJob(coin, params);
            if (job === null) return;

            const profile = global.coinFuncs.getPoolProfile(coin);
            const poolSettings = profile && profile.pool ? profile.pool : {};
            if (miner.protocol === "grin") {
                miner.pushMessage({ method: "getjobtemplate", result: job });
                return;
            }
            poolSettings.pushJob({
                job,
                miner,
                params
            });
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
