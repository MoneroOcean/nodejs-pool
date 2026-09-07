"use strict";
// Miner jobs are protocol-facing views over block templates. Keeping them in a
// separate module makes it easier to refactor protocol handling without
// re-auditing the template-to-job conversion rules.

/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */
/** @typedef {import("../../types/runtime").BlockTemplateRecord} BlockTemplateRecord */

/** @typedef {ProtoMessage|unknown[]} JobPayload */

/**
 * @typedef {BlockTemplateRecord & {
 *     idHash: string,
 *     port: number,
 *     block_version: number,
 *     extraNonce: string,
 *     nextBlobHex: () => string,
 *     nextBlobWithChildNonceHex: () => string,
 *     disableProxyNonce?: boolean,
 *     clientPoolLocation?: number,
 *     clientNonceLocation?: number
 * }} MinerBlockTemplate
 */

/**
 * @typedef {object} JobParams
 * @property {MinerBlockTemplate} bt
 * @property {number} coinHashFactor
 * @property {number|undefined} [hashesPerDifficulty]
 * @property {string} algo_name
 */

/**
 * @typedef {object} JobExtraFields
 * @property {string|undefined} [id]
 * @property {string|undefined} [extraNonce]
 * @property {boolean} usesProxyNonce
 * @property {number|undefined} [clientPoolLocation]
 * @property {number|undefined} [clientNonceLocation]
 */

/**
 * @typedef {object} MinerJob
 * @property {string} id
 * @property {string} coin
 * @property {number} blob_type_num
 * @property {string} blockHash
 * @property {string|undefined} [extraNonce]
 * @property {number} height
 * @property {string|undefined} [seed_hash]
 * @property {number} difficulty
 * @property {number} norm_diff
 * @property {number} coinHashFactor
 * @property {number} hashesPerDifficulty
 * @property {number} coinDifficultyFactor
 * @property {Map<string, unknown>} submissions
 */

/**
 * @typedef {object} JobPoolSettings
 * @property {boolean} [integerDifficulty]
 * @property {boolean} [sharedTemplateNonces]
 * @property {boolean} [disableProxyNonce]
 * @property {boolean} [useEthJobId]
 * @property {(context: Record<string, unknown>) => JobPayload} buildJobPayload
 * @property {(context: Record<string, unknown>) => JobPayload} buildProxyJobPayload
 * @property {(context: Record<string, unknown>) => void} pushJob
 */

/**
 * @typedef {object} JobBuffer
 * @property {(job: MinerJob) => void} enq
 */

/**
 * @typedef {object} JobMiner
 * @property {string|undefined} [jobLastBlockHash]
 * @property {number} difficulty
 * @property {number} curr_coin_min_diff
 * @property {number|null|undefined} [newDiffToSet]
 * @property {number|null|undefined} [newDiffRecommendation]
 * @property {boolean} proxy
 * @property {string|undefined} [eth_extranonce]
 * @property {JobBuffer} validJobs
 * @property {JobPayload|null} cachedJob
 * @property {string} protocol
 * @property {string|undefined} [curr_coin]
 * @property {(coin: string, params: JobParams) => void} sendCoinJob
 * @property {() => string|false} selectBestCoin
 * @property {(coin: string, params: JobParams) => JobPayload|null} getCoinJob
 * @property {(job: JobPayload) => void} [rememberEthProxyWork]
 * @property {(job: JobPayload) => unknown} [buildEthProxyWorkResult]
 * @property {(message: unknown) => void} pushMessage
 * @property {() => void} sendSameCoinJob
 * @property {() => JobPayload|null|undefined} getBestCoinJob
 * @property {() => void} sendBestCoinJob
 */

/**
 * @typedef {object} JobDependencies
 * @property {number} protoVersion
 * @property {(coin: string) => JobParams} getCoinJobParams
 * @property {() => string} getNewId
 * @property {() => string} getNewEthJobId
 * @property {(value: number) => string} getTargetHex
 * @property {(value: number) => string} getRavenTargetHex
 * @property {(value: number) => bigint} toBigInt
 */

/** @param {unknown} value @returns {value is JobPoolSettings} */
function isJobPoolSettings(value) {
    if (!value || typeof value !== "object") return false;
    const buildJobPayload = Object.getOwnPropertyDescriptor(value, "buildJobPayload");
    const buildProxyJobPayload = Object.getOwnPropertyDescriptor(value, "buildProxyJobPayload");
    const pushJob = Object.getOwnPropertyDescriptor(value, "pushJob");
    if (!buildJobPayload || !buildProxyJobPayload || !pushJob) return false;
    return typeof buildJobPayload.value === "function" &&
        typeof buildProxyJobPayload.value === "function" &&
        typeof pushJob.value === "function";
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
            const blobTypeNum = typeof profileBlobType === "number" ? profileBlobType : portBlobType(bt.port);
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
                miner.last_diff = undefined;
                miner.last_target = undefined;
            }
            if (native && nativeAlgoChanged && poolSettings.requiresExtranonce === true && typeof miner.eth_extranonce === "string") {
                miner.pushMessage({
                    method: "mining.set_extranonce",
                    params: [miner.eth_extranonce, 6],
                    algo: params.algo_name
                });
            }
            if (native) miner.nativeJobAlgo = params.algo_name;
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
