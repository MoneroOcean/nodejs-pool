"use strict";
// Miner jobs are protocol-facing views over block templates. Keeping them in a
// separate module makes it easier to refactor protocol handling without
// re-auditing the template-to-job conversion rules.

/** @typedef {import("../../types/pool_profiles").PoolJobPayload} JobPayload */
/** @typedef {import("../../types/pool_profiles").PoolBlockTemplate} MinerBlockTemplate */
/** @typedef {import("../../types/pool_profiles").PoolJobParams} JobParams */
/** @typedef {import("../../types/pool_profiles").PoolJob} MinerJob */
/** @typedef {import("../../types/pool_profiles").PoolJobSettings} JobPoolSettings */
/** @typedef {import("../../types/pool_profiles").PoolMinerView} PoolMinerView */

/**
 * @typedef {object} JobExtraFields
 * @property {string} [id]
 * @property {number|string} [extraNonce]
 * @property {boolean} usesProxyNonce
 * @property {number} [clientPoolLocation]
 * @property {number} [clientNonceLocation]
 */

/**
 * @typedef {object} JobBuffer
 * @property {(job: MinerJob) => void} enq
 */

/**
 * @typedef {PoolMinerView & {
 *     id: string,
 *     payout: string,
 *     jobLastBlockHash?: string,
 *     difficulty: number,
 *     curr_coin_min_diff: number,
 *     newDiffToSet?: number|null,
 *     newDiffRecommendation?: number|null,
 *     eth_extranonce?: string,
 *     validJobs: JobBuffer,
 *     cachedJob: JobPayload|null,
 *     curr_coin?: string,
 *     selectBestCoin: () => string|false,
 *     sendSameCoinJob: () => void,
 *     getBestCoinJob: () => JobPayload|null|undefined,
 *     sendBestCoinJob: () => void
 * }} JobMiner
 */

/**
 * @typedef {object} JobDependencies
 * @property {number} protoVersion
 * @property {(coin: string) => JobParams} getCoinJobParams
 * @property {() => string} getNewId
 * @property {() => string} getNewEthJobId
 * @property {(value: number, size?: number) => string} getTargetHex
 * @property {(value: number) => string} getRavenTargetHex
 * @property {(value: number) => bigint} toBigInt
 */

/** @param {unknown} value @returns {value is JobPoolSettings} */
function isJobPoolSettings(value) {
    if (!value || typeof value !== "object") return false;
    const buildJobPayload = Object.getOwnPropertyDescriptor(value, "buildJobPayload");
    const buildProxyJobPayload = Object.getOwnPropertyDescriptor(value, "buildProxyJobPayload");
    if (!buildJobPayload || !buildProxyJobPayload) return false;
    return typeof buildJobPayload.value === "function" &&
        typeof buildProxyJobPayload.value === "function";
}

/** @param {import("../../types/runtime").CoinProfile|null} profile @returns {JobPoolSettings} */
function getJobPoolSettings(profile) {
    if (profile && typeof profile === "object" && isJobPoolSettings(profile.pool)) return profile.pool;
    throw new Error("Pool profile has no job handlers");
}

module.exports = function createMinerJobs() {
    /** @param {JobMiner} miner @param {JobDependencies} deps @returns {JobMiner} */
    return function attachMinerJobMethods(miner, deps) {
        const {
            protoVersion,
            getCoinJobParams,
            getNewId,
            getNewEthJobId,
            getTargetHex,
            getRavenTargetHex,
            toBigInt
        } = deps;

        if (protoVersion !== 1) return miner;

        /**
         * @param {string} coin
         * @param {MinerBlockTemplate} bt
         * @param {number} blobTypeNum
         * @param {number} coinDiff
         * @param {JobParams} params
         * @param {JobExtraFields} extraFields
         * @returns {MinerJob}
         */
        function buildJob(coin, bt, blobTypeNum, coinDiff, params, extraFields) {
            const hashesPerDifficulty = params.hashesPerDifficulty || 1;
            const coinDifficultyFactor = params.coinHashFactor * hashesPerDifficulty;
            /** @type {MinerJob} */
            const newJob = Object.assign({
                id: extraFields.id || getNewId(),
                coin,
                blob_type_num: blobTypeNum,
                blockHash: bt.idHash,
                height: bt.height,
                difficulty: coinDiff,
                norm_diff: coinDiff * coinDifficultyFactor,
                coinHashFactor: params.coinHashFactor,
                hashesPerDifficulty,
                coinDifficultyFactor,
                submissions: new Map(),
                ...(typeof extraFields.extraNonce !== "undefined" ? { extraNonce: extraFields.extraNonce } : {}),
                ...(typeof bt.seed_hash !== "undefined" ? { seed_hash: bt.seed_hash } : {})
            }, extraFields);
            miner.validJobs.enq(newJob);
            return newJob;
        }

        miner.getCoinJob = function getCoinJob(coin, params) {
            const bt = params.bt;
            if (
                miner.jobLastBlockHash === bt.idHash &&
                !miner.newDiffToSet &&
                miner.cachedJob !== null
            ) return null;
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
            let coinDiff = Math.min(Math.max(rawCoinDiff, miner.curr_coin_min_diff), bt.difficulty);

            const profile = global.coinFuncs.getPoolProfile(bt.port);
            const poolSettings = getJobPoolSettings(profile);
            if (poolSettings.integerDifficulty === true) coinDiff = Math.floor(coinDiff);
            const profileBlobType = profile && profile.blobType;
            const portBlobType = global.coinFuncs["portBlobType"];
            if (typeof portBlobType !== "function") throw new Error("coinFuncs.portBlobType is unavailable");
            let blobTypeNum;
            if (typeof profileBlobType === "number") {
                blobTypeNum = profileBlobType;
            } else {
                const resolvedBlobType = portBlobType(bt.port);
                if (typeof resolvedBlobType !== "number" || !Number.isInteger(resolvedBlobType)) {
                    throw new Error(`coinFuncs.portBlobType returned an invalid value for port ${  bt.port}`);
                }
                blobTypeNum = resolvedBlobType;
            }
            const usesSharedTemplateNonce = poolSettings.sharedTemplateNonces === true;
            const needsNativeExtranonce = miner.mo_native === true && (usesSharedTemplateNonce || poolSettings.requiresExtranonce === true);
            if (needsNativeExtranonce && typeof miner.eth_extranonce !== "string" &&
                typeof miner.ensureEthExtranonce === "function" && !miner.ensureEthExtranonce()) return null;
            const usesProxyNonce = miner.proxy &&
                !usesSharedTemplateNonce &&
                poolSettings.disableProxyNonce !== true &&
                bt.disableProxyNonce !== true &&
                Number.isInteger(bt.clientPoolLocation) &&
                Number.isInteger(bt.clientNonceLocation);

            if (!usesProxyNonce) {
                const blobHex = bt.nextBlobHex();
                if (!blobHex) return null;
                const extraNonce = usesSharedTemplateNonce ? miner.eth_extranonce : bt.extraNonce;
                const newJob = buildJob(coin, bt, blobTypeNum, coinDiff, params, {
                    id: poolSettings.useEthJobId ? getNewEthJobId() : getNewId(),
                    usesProxyNonce: false,
                    ...(typeof extraNonce !== "undefined" ? { extraNonce } : {})
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
                    usesProxyNonce: true,
                    ...(typeof bt.extraNonce !== "undefined" ? { extraNonce: bt.extraNonce } : {}),
                    ...(typeof bt.clientPoolLocation !== "undefined" ? { clientPoolLocation: bt.clientPoolLocation } : {}),
                    ...(typeof bt.clientNonceLocation !== "undefined" ? { clientNonceLocation: bt.clientNonceLocation } : {})
                });
                miner.cachedJob = poolSettings.buildProxyJobPayload({
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
            }

            return miner.cachedJob;
        };

        miner.sendCoinJob = function sendCoinJob(coin, params, options) {
            const jobOverride = options && Object.prototype.hasOwnProperty.call(options, "job") ? options.job : undefined;
            const job = typeof jobOverride === "undefined" ? miner.getCoinJob(coin, params) : jobOverride;
            if (job === null) return;

            const profile = global.coinFuncs.getPoolProfile(coin);
            const poolSettings = getJobPoolSettings(profile);
            if (miner.protocol === "grin") {
                miner.pushMessage({ method: "getjobtemplate", result: job });
                return;
            }
            const native = miner.mo_native === true;
            const nativeAlgoChanged = native && miner.nativeJobAlgo !== params.algo_name;
            if (nativeAlgoChanged) {
                delete miner.last_diff;
                delete miner.last_target;
            }
            if (native && nativeAlgoChanged && poolSettings.requiresExtranonce === true && typeof miner.eth_extranonce === "string") {
                miner.pushMessage({
                    method: "mining.set_extranonce",
                    params: [miner.eth_extranonce, 6],
                    algo: params.algo_name
                });
            }
            if (native) miner.nativeJobAlgo = params.algo_name;
            if (typeof poolSettings.pushJob !== "function") throw new Error("Pool profile has no pushJob handler");
            poolSettings.pushJob({
                job,
                miner,
                params,
                native
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
