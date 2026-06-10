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

        function buildJob(coin, bt, blobTypeNum, coinDiff, params, extraFields) {
            const hashesPerDifficulty = params.hashesPerDifficulty || 1;
            const coinDifficultyFactor = params.coinHashFactor * hashesPerDifficulty;
            const newJob = Object.assign({
                id: extraFields.id || getNewId(),
                coin,
                blob_type_num: blobTypeNum,
                blockHash: bt.idHash,
                extraNonce: extraFields.extraNonce,
                height: bt.height,
                seed_hash: bt.seed_hash,
                difficulty: coinDiff,
                norm_diff: coinDiff * coinDifficultyFactor,
                coinHashFactor: params.coinHashFactor,
                hashesPerDifficulty,
                coinDifficultyFactor,
                submissions: new Map()
            }, extraFields);
            miner.validJobs.enq(newJob);
            return newJob;
        }

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

            const hashesPerDifficulty = params.hashesPerDifficulty || 1;
            const rawCoinDiff = miner.difficulty / (params.coinHashFactor * hashesPerDifficulty);
            const coinDiff = Math.min(Math.max(rawCoinDiff, miner.curr_coin_min_diff), bt.difficulty);

            const profile = global.coinFuncs.getPoolProfile(bt.port);
            const poolSettings = profile && profile.pool ? profile.pool : {};
            const blobTypeNum = profile ? profile.blobType : global.coinFuncs.portBlobType(bt.port);
            const usesSharedTemplateNonce = poolSettings.sharedTemplateNonces === true;
            const usesProxyNonce = miner.proxy &&
                !usesSharedTemplateNonce &&
                poolSettings.disableProxyNonce !== true &&
                bt.disableProxyNonce !== true &&
                Number.isInteger(bt.clientPoolLocation) &&
                Number.isInteger(bt.clientNonceLocation);

            if (!usesProxyNonce) {
                const blobHex = bt.nextBlobHex();
                if (!blobHex) return null;
                const newJob = buildJob(coin, bt, blobTypeNum, coinDiff, params, {
                    id: poolSettings.useEthJobId ? getNewEthJobId() : getNewId(),
                    extraNonce: usesSharedTemplateNonce ? miner.eth_extranonce : bt.extraNonce,
                    usesProxyNonce: false
                });

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
                const newJob = buildJob(coin, bt, blobTypeNum, coinDiff, params, {
                    extraNonce: bt.extraNonce,
                    usesProxyNonce: true,
                    clientPoolLocation: bt.clientPoolLocation,
                    clientNonceLocation: bt.clientNonceLocation
                });
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
            if (miner.protocol === "ethproxy") {
                if (typeof miner.rememberEthProxyWork === "function") miner.rememberEthProxyWork(job);
                if (typeof miner.buildEthProxyWorkResult === "function") {
                    miner.pushMessage({
                        id: 0,
                        jsonrpc: "2.0",
                        result: miner.buildEthProxyWorkResult(job),
                        algo: params.algo_name
                    });
                }
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
