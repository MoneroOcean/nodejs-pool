"use strict";
const { consumeRateLimitToken, getPoolSecurityConfig, isLoopbackAddress, normalizeRemoteAddress } = require("./security.js");
/** @typedef {import("../../types/pool_profiles").PoolMiner} PoolMiner */
/** @typedef {import("../../types/pool_profiles").PoolSocket} PoolSocket */
/** @typedef {import("../../types/pool_profiles").PoolRuntimeState} PoolState */
/** @typedef {import("../../types/pool_profiles").PoolBlockTemplate} PoolBlockTemplate */
/** @typedef {import("../../types/pool_profiles").PoolJob} PoolJob */
/** @typedef {import("../../types/pool_profiles").PoolJobParams} PoolJobParams */
/** @typedef {import("../../types/pool_profiles").PoolJobPayload} PoolJobPayload */
/** @typedef {import("../../types/pool_profiles").PoolProfileSettings} PoolProfileSettings */
/** @typedef {import("../../types/pool_profiles").PoolSubmitParams} PoolSubmitParams */
/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */

/** Params after one of the array wire formats has been normalized. */
/** @typedef {PoolSubmitParams & {
 *     login?: string,
 *     pass?: string,
 *     rigid?: string,
 *     agent?: string,
 *     extensions?: string[],
 *     algo?: string[],
 *     "algo-perf"?: Record<string, unknown>,
 *     "algo-min-time"?: unknown,
 *     block_submit_test_result?: string
 * }} ProtocolParams */
/** @typedef {{port: number, portType: string|number, difficulty: number, desc?: string}} ProtocolPort */
/** @typedef {TimedEntryRetention & {maxKeyLength: number}} AgentRetention */
/** @typedef {{maxAgeMs: number, maxEntries: number, pruneIntervalMs: number, pruneAfterAdds: number}} TimedEntryRetention */
/** @typedef {{minerAgents: AgentRetention, minerLog: TimedEntryRetention, minerNotify: TimedEntryRetention}} ProtocolRetention */
/** @typedef {{
 *     getNewId: () => string,
 *     getNewEthExtranonceId: () => number|null,
 *     ethExtranonce: (id: number) => string
 * }} ProtocolUtils */
/** @typedef {{
 *     debug: (message: string) => void,
 *     retention: ProtocolRetention,
 *     state: PoolState,
 *     touchTimedEntry: (target: Record<string, number>, key: string, value: number, options: TimedEntryRetention) => void,
 *     utils: ProtocolUtils,
 *     createMiner: (id: string, login: string, pass: string, rigid: string|undefined, ipAddress: string, startingDiff: number, pushMessage: (message: Record<string, unknown>) => void, protoVersion: number, portType: string|number, port: number, agent: string|undefined, algos: string[]|undefined, algosPerf: Record<string, unknown>|undefined, algoMinTime: unknown) => PoolMiner,
 *     addProxyMiner: (miner: PoolMiner) => boolean,
 *     addActiveMiner: (miner: PoolMiner, socket: PoolSocket) => void,
 *     adjustMinerDiff: (miner: PoolMiner) => boolean,
 *     shareProcessor: {processShare(miner: PoolMiner, job: PoolJob & {rewarded_difficulty: number, rewarded_difficulty2: number}, blockTemplate: PoolBlockTemplate, params: PoolSubmitParams, callback: (accepted: boolean|null) => void): void},
 *     removeMiner: (miner: PoolMiner, options?: {destroySocket?: boolean, reason?: string}) => void,
 *     processSend: (message: ProtoMessage) => void,
 *     getCoinJobParams: (coin: string) => PoolJobParams,
 *     formatPoolEvent?: (label: string, fields?: Record<string, unknown>) => string
 * }} ProtocolDependencies */
/** @typedef {Pick<PoolProfileSettings, "sendLoginResult"> & {
 *     requiresExtranonce?: boolean
 * }} PoolLoginSettings */
/** @typedef {Pick<PoolProfileSettings, "validateSubmitParams"|"submissionKey"> & {
 *     sharedTemplateNonces?: boolean,
 *     sharedTemplateSubmissions?: boolean,
 *     parseMiningSubmitParams?: (context: {params: PoolSubmitParams}) => boolean,
 *     submitSuccess?: "boolean"|"status"
 * }} PoolSubmitSettings */

/** @param {unknown} value @returns {value is ProtocolParams} */
function isProtocolParams(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    for (const [key, field] of Object.entries(value)) {
        if (["login", "pass", "rigid", "agent", "result", "header_hash", "mixhash", "block_submit_test_result"].includes(key)) {
            if (typeof field !== "string") return false;
        } else if (["job_id", "nonce"].includes(key)) {
            if (typeof field !== "string" && typeof field !== "number") return false;
        } else if (key === "extensions" || key === "algo") {
            if (!Array.isArray(field) || !field.every(item => typeof item === "string")) return false;
        } else if (key === "pow") {
            if (!Array.isArray(field) || !field.every(item => typeof item === "number")) return false;
        } else if (key === "poolNonce" || key === "workerNonce") {
            if (typeof field !== "number") return false;
        } else if (key === "raw_params") {
            if (!Array.isArray(field)) return false;
        } else if (key === "algo-perf") {
            if (!field || typeof field !== "object" || Array.isArray(field)) return false;
        }
    }
    return true;
}

/** @param {unknown} value @returns {ProtocolParams} */
function normalizeProtocolParams(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    // In-process callers can supply undefined; JSON callers cannot. Omit it
    // before the validated request reaches protocol handlers.
    const params = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
    // Malformed proofs retain the job identity so the existing proof validator
    // rejects them through the normal invalid-share accounting path.
    if (Array.isArray(params["pow"]) && !params["pow"].every(edge => typeof edge === "number")) delete params["pow"];
    return isProtocolParams(params) ? params : {};
}

/** @type {Readonly<Record<string, "login"|"submit"|"keepalive">>} */
const RATE_LIMIT_METHODS = Object.freeze({ login: "login", "mining.authorize": "login", "mining.subscribe": "login", "mining.extranonce.subscribe": "login", submit: "submit", "mining.submit": "submit", keepalive: "keepalive", keepalived: "keepalive" });
const SUPPORTED_LOGIN_EXTENSIONS = Object.freeze(["mo-native", "submit-result"]);
// Accepted submissions stay tracked for the template lifetime; this hard cap
// bounds active and retained template memory without evicting credited work.
const SHARED_TEMPLATE_SUBMISSION_LIMIT = 65536;

// Protocol handling turns wire-level messages into miner/session operations.
// Keeping it separate from pool lifecycle code makes test-mode composition much
// easier and keeps transport concerns local.
/** @param {ProtocolDependencies} deps @returns {(socket: PoolSocket, id: string|number|null, method: string, params: unknown, ip: string, portData: ProtocolPort, sendReply: (error: unknown, result?: unknown) => void, sendReplyFinal: (error: unknown, delayReply?: number) => void, pushMessage: (message: Record<string, unknown>) => void, request?: ProtoMessage) => void} */
module.exports = function createProtocolHandler(deps) {
    const {
        debug,
        retention,
        state,
        touchTimedEntry,
        utils,
        createMiner,
        addProxyMiner,
        addActiveMiner,
        adjustMinerDiff,
        shareProcessor,
        removeMiner,
        processSend,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;

    /** @param {string} payout @returns {string|false} */
    function getMinerNotification(payout) {
        return payout in state.notifyAddresses ? (state.notifyAddresses[payout] ?? false) : false;
    }

    /** @param {unknown} value @returns {string} */
    function normalizeInvalidMinerKey(value) {
        if (typeof value !== "string") return "";
        const trimmed = value.trim();
        return trimmed ? trimmed.substring(0, retention.minerAgents.maxKeyLength) : "";
    }

    /** @param {PoolMiner|null|undefined} miner @returns {string} */
    function getInvalidMinerLogKey(miner) {
        if (miner && typeof miner.invalidLogKey === "string" && miner.invalidLogKey !== "") return miner.invalidLogKey;
        if (miner) {
            const normalizedPayout = normalizeInvalidMinerKey(miner.payout);
            if (normalizedPayout !== "") return normalizedPayout;
        }
        return "invalid-wallet";
    }

    /** @param {unknown} agent @returns {string} */
    function normalizeTrackedAgentKey(agent) {
        if (typeof agent !== "string") return "";
        const trimmed = agent.trim();
        return trimmed ? trimmed.substring(0, retention.minerAgents.maxKeyLength) : "";
    }

    /** @param {PoolJob} job @returns {Map<string, number>} */
    function getJobSubmissions(job) {
        if (job.submissions instanceof Map) return job.submissions;
        job.submissions = new Map();
        return job.submissions;
    }

    /** @param {PoolBlockTemplate} blockTemplate @returns {Set<string>} */
    function getSharedTemplateSubmissions(blockTemplate) {
        if (blockTemplate.templateSubmissions instanceof Set) return blockTemplate.templateSubmissions;
        blockTemplate.templateSubmissions = new Set();
        return blockTemplate.templateSubmissions;
    }

    /** @param {PoolJob} job @returns {"nonce"|"submission"|null} */
    function sharedTemplateSubmissionMode(job) {
        const poolSettings = getPoolSettingsForJob(job);
        if (poolSettings.sharedTemplateNonces === true) return "nonce";
        if (poolSettings.sharedTemplateSubmissions === true) return "submission";
        return null;
    }

    /** @param {PoolBlockTemplate} blockTemplate @param {string} submissionKey @returns {boolean} */
    function hasTrackedSharedTemplateSubmission(blockTemplate, submissionKey) {
        return getSharedTemplateSubmissions(blockTemplate).has(submissionKey);
    }

    /** @param {PoolBlockTemplate} blockTemplate @param {string} submissionKey @returns {boolean} */
    function trackSharedTemplateSubmission(blockTemplate, submissionKey) {
        const submissions = getSharedTemplateSubmissions(blockTemplate);
        // The entry is an in-flight reservation until verification completes;
        // accepted entries stay here for the rest of the template lifetime.
        if (submissions.size >= SHARED_TEMPLATE_SUBMISSION_LIMIT) return false;
        submissions.add(submissionKey);
        return true;
    }

    /** @param {PoolBlockTemplate} blockTemplate @param {string} submissionKey @returns {void} */
    function untrackSharedTemplateSubmission(blockTemplate, submissionKey) {
        getSharedTemplateSubmissions(blockTemplate).delete(submissionKey);
    }

    /** @param {PoolMiner|null|undefined} miner @returns {boolean} */
    function hasProxySubmissionBudget(miner) {
        if (!miner) return false;
        const proxyMinerName = miner.proxyMinerName || miner.payout;
        const proxyMiner = proxyMinerName && state.proxyMiners[proxyMinerName];
        return Boolean(proxyMiner && proxyMiner.submissionBudget === true);
    }

    /** @param {PoolMiner|null|undefined} miner @returns {number} */
    function getTrackedSubmissionLimit(miner) {
        const multiplier = hasProxySubmissionBudget(miner) ? 1000 : 100;
        return global.config.pool.minerThrottleShareWindow * global.config.pool.minerThrottleSharePerSec * multiplier;
    }

    /** @param {PoolJob} job @param {string} nonceTest @returns {void} */
    function trackJobSubmission(job, nonceTest) {
        const submissions = getJobSubmissions(job);
        submissions.set(nonceTest, 1);
    }

    /** @param {PoolJob} job @param {string} nonceTest @returns {void} */
    function untrackJobSubmission(job, nonceTest) {
        getJobSubmissions(job).delete(nonceTest);
    }

    /** @param {PoolJob} job @param {PoolMiner|null|undefined} miner @returns {boolean} */
    function hasReachedSubmissionLimit(job, miner) {
        const limit = getTrackedSubmissionLimit(miner);
        return limit > 0 && getJobSubmissions(job).size >= limit;
    }

    /** @param {string} method @returns {{config: ReturnType<typeof getPoolSecurityConfig>, ratePerSecond: number, burst: number}|null} */
    function getRateLimitConfig(method) {
        const config = getPoolSecurityConfig();
        switch (method) {
        case "login":
            return {
                config,
                ratePerSecond: config.loginRateLimitPerSecond,
                burst: config.loginRateLimitBurst
            };
        case "submit":
            return {
                config,
                ratePerSecond: config.submitRateLimitPerSecond,
                burst: config.submitRateLimitBurst
            };
        case "keepalive":
            return {
                config,
                ratePerSecond: config.keepaliveRateLimitPerSecond,
                burst: config.keepaliveRateLimitBurst
            };
        default:
            return null;
        }
    }

    /** @param {string} rateMethod @param {string} ip @param {number} now @returns {boolean} */
    function consumeRpcRateLimit(rateMethod, ip, now) {
        const limitConfig = getRateLimitConfig(rateMethod);
        if (!limitConfig) return true;
        const normalizedIp = normalizeRemoteAddress(ip);
        const loopbackLogin = rateMethod === "login" && isLoopbackAddress(normalizedIp);
        return consumeRateLimitToken(
            state.rpcRateBuckets,
            `${rateMethod  }:${  normalizedIp}`,
            loopbackLogin ? limitConfig.config.loginRateLimitLoopbackPerSecond : limitConfig.ratePerSecond,
            loopbackLogin ? limitConfig.config.loginRateLimitLoopbackBurst : limitConfig.burst,
            now,
            limitConfig.config
        );
    }

    /** @param {string} rateMethod @param {PoolMiner|null} miner @param {string} ip @param {number} now @returns {boolean} */
    function consumePreShareRateLimit(rateMethod, miner, ip, now) {
        if (!miner || miner.hasSubmittedValidShare) return true;
        const config = getPoolSecurityConfig();
        let ratePerSecond;
        let burst;
        switch (rateMethod) {
        case "job-request":
            ratePerSecond = config.jobRequestRateLimitPerSecond;
            burst = config.jobRequestRateLimitBurst;
            break;
        default:
            return true;
        }
        return consumeRateLimitToken(
            state.rpcRateBuckets,
            `${rateMethod  }:${  normalizeRemoteAddress(ip)}`,
            ratePerSecond,
            burst,
            now,
            config
        );
    }

    /** @param {unknown} nonce @param {string|undefined} extraNonce @param {{requireFullNonceExtraNoncePrefix?: boolean}|undefined} options @returns {string|null} */
    function normalizeExtraNonceSubmitNonce(nonce, extraNonce, options) {
        if (typeof nonce !== "string") return null;

        const normalizedNonce = nonce.toLowerCase().startsWith("0x") ? nonce.slice(2) : nonce;
        if (typeof extraNonce !== "string" || !extraNonce.length) return normalizedNonce;

        const normalizedExtraNonce = extraNonce.toLowerCase();
        const fullNonceHexLength = 16;
        const suffixHexLength = fullNonceHexLength - normalizedExtraNonce.length;
        const normalizedNonceLower = normalizedNonce.toLowerCase();
        const requireFullNonceExtraNoncePrefix = Boolean(options && options.requireFullNonceExtraNoncePrefix);

        // Some native miners submit only the nonce suffix while others submit the
        // full 8-byte nonce. Shared nonce-space profiles require full nonces to
        // stay inside the assigned pool extranonce segment.
        // Do not bypass this check for miner quirks; parse the miner's real full
        // nonce field before calling this normalizer instead.
        if (normalizedNonce.length === suffixHexLength) {
            return normalizedExtraNonce + normalizedNonceLower;
        }
        if (normalizedNonce.length === fullNonceHexLength) {
            return !requireFullNonceExtraNoncePrefix || normalizedNonceLower.startsWith(normalizedExtraNonce)
                ? normalizedNonceLower
                : null;
        }

        return null;
    }

    /** @param {unknown} value @returns {value is PoolLoginSettings} */
    function isPoolLoginSettings(value) {
        if (!value || typeof value !== "object") return false;
        return "sendLoginResult" in value && typeof value.sendLoginResult === "function";
    }

    /** @param {unknown} value @returns {value is PoolSubmitSettings} */
    function isPoolSubmitSettings(value) {
        if (!value || typeof value !== "object") return false;
        return "validateSubmitParams" in value && "submissionKey" in value && typeof value.validateSubmitParams === "function" && typeof value.submissionKey === "function";
    }

    /** @param {string} coin @returns {PoolLoginSettings} */
    function getPoolSettingsForCoin(coin) {
        const profile = global.coinFuncs.getPoolProfile(coin);
        if (!profile || !isPoolLoginSettings(profile.pool)) throw new Error(`Pool profile has no login handler for ${  coin}`);
        return profile.pool;
    }

    /** @param {PoolJob} job @returns {PoolSubmitSettings} */
    function getPoolSettingsForJob(job) {
        const profile = global.coinFuncs.getJobProfile(job);
        if (!profile || !isPoolSubmitSettings(profile.pool)) throw new Error(`Pool profile has no submit handlers for ${  job.coin}`);
        return profile.pool;
    }

    /** @param {number} port @returns {import("../../types/coin_profiles").CoinProfile|null} */
    function getPoolProfileForPort(port) {
        return global.coinFuncs.getPoolProfile(port);
    }

    /** @param {number} port @returns {{algos: string[], algosPerf: Record<string, number>, algoMinTime: number}} */
    function getAuthorizeAlgoState(port) {
        const profile = getPoolProfileForPort(port);
        if (!profile || !profile.pool || typeof profile.pool.authorizeAlgoState !== "function") {
            return {
                algos: ["kawpow"],
                algosPerf: { kawpow: 1 },
                algoMinTime: 60
            };
        }
        return profile.pool.authorizeAlgoState({
            coinFuncs: global.coinFuncs,
            port,
            profile
        });
    }

    return function handleMinerData(socket, id, method, inputParams, ip, portData, sendReply, sendReplyFinal, pushMessage, request) {
        const wireParams = inputParams;
        let params = normalizeProtocolParams(inputParams);
        /** @returns {void} */
        function closeSocketAfterReply() {
            if (socket.finalizing) return;
            socket.finalizing = true;
            if (typeof socket.end === "function" && socket.writable) {
                setImmediate(function finalizeSocket() {
                    if (socket.destroyed || socket.writableEnded) return;
                    if (socket.writable) socket.end();
                    else if (typeof socket.destroy === "function") socket.destroy();
                });
                return;
            }
            else if (typeof socket.destroy === "function" && !socket.destroyed) socket.destroy();
        }

        /** @param {string} minerId @returns {void} */
        function scheduleFirstShareTimer(minerId) {
            if (socket.firstShareTimer) {
                clearTimeout(socket.firstShareTimer);
                socket.firstShareTimer = null;
            }
            const miner = state.activeMiners.get(minerId);
            if (!miner || miner.hasSubmittedValidShare) return;
            if (!(typeof socket.destroy === "function" || typeof socket.end === "function")) return;

            const config = getPoolSecurityConfig();
            const timeoutMs = config.minerFirstShareTimeoutMs;
            if (timeoutMs <= 0) return;

            const delayMs = Math.max(0, miner.connectTime + timeoutMs - Date.now());
            socket.firstShareTimer = setTimeout(function enforceFirstShareDeadline() {
                const activeMiner = state.activeMiners.get(minerId);
                if (activeMiner && !activeMiner.hasSubmittedValidShare) {
                    removeMiner(activeMiner, { reason: "first-share-timeout" });
                }
            }, delayMs);
        }

        /** @returns {void} */
        function handleUnknownMethod() {
            const config = getPoolSecurityConfig();
            const minerId = socket.miner_id || "";
            const miner = minerId ? (state.activeMiners.get(minerId) ?? null) : null;

            socket.protocolErrorCount = (socket.protocolErrorCount || 0) + 1;
            if (!miner || !miner.hasSubmittedValidShare || socket.protocolErrorCount >= config.protocolErrorLimit) {
                sendReplyFinal("Unknown RPC method");
                return;
            }
            sendReply("Unknown RPC method");
        }

        const timeNow = Date.now();
        const rateMethod = RATE_LIMIT_METHODS[method] || null;
        if (rateMethod && !consumeRpcRateLimit(rateMethod, ip, timeNow)) {
            sendReplyFinal(`Rate limit exceeded for ${  rateMethod  } requests`);
            return;
        }

        /** @returns {boolean} */
        function normalizeAuthorizeParams() {
            if (!(wireParams instanceof Array)) {
                sendReplyFinal("No array params specified");
                return false;
            }
            const authorizeAlgoState = getAuthorizeAlgoState(portData.port);
            params = { login: typeof wireParams[0] === "string" ? wireParams[0] : "", pass: typeof wireParams[1] === "string" ? wireParams[1] : "", agent: socket.eth_agent ? socket.eth_agent : "[generic_ethminer]", algo: authorizeAlgoState.algos, "algo-perf": authorizeAlgoState.algosPerf, "algo-min-time": authorizeAlgoState.algoMinTime };
            return true;
        }

        /** @returns {boolean} */
        function validateLoginParams() {
            if (ip in state.bannedTmpIPs) return sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)"), false;
            if (inputParams === null || typeof inputParams === "undefined") return processSend({ type: "banIP", data: ip }), sendReplyFinal("No params specified"), false;
            if (!params.login) return processSend({ type: "banIP", data: ip }), sendReplyFinal("No login specified"), false;
            if (socket.miner_id && state.activeMiners.has(socket.miner_id)) {
                processSend({ type: "banIP", data: ip });
                sendReplyFinal("No double login is allowed");
                return false;
            }
            if (socket.miner_id) delete socket.miner_id;
            if (!params.pass) params.pass = "x";
            return true;
        }

        /** @param {PoolMiner} miner @returns {boolean} */
        function attachMinerExtranonce(miner) {
            if (typeof miner.eth_extranonce === "string") return true;
            const newId = claimEthExtranonceId();
            if (newId !== null) {
                miner.eth_extranonce = utils.ethExtranonce(newId);
                return true;
            }
            miner.valid_miner = false;
            miner.error = "Not enough extranonces. Switch to other pool node.";
            return false;
        }

        /** @param {PoolMiner} miner @returns {void} */
        function applyAuthorizeExtranonce(miner) {
            if (method !== "mining.authorize") return;
            attachMinerExtranonce(miner);
        }

        /** @returns {string[]} */
        function requestedLoginExtensions() {
            if (!params || !Array.isArray(params.extensions)) return [];
            const extensions = params.extensions;
            return SUPPORTED_LOGIN_EXTENSIONS.filter((extension) => extensions.includes(extension));
        }

        /** @param {PoolMiner} miner @returns {void} */
        function attachMinerProtocolMethods(miner) {
            miner.ensureEthExtranonce = function ensureEthExtranonce() {
                return attachMinerExtranonce(miner);
            };
        }

        /** @param {PoolMiner} miner @param {unknown} error @param {unknown} result @returns {void} */
        function sendDecoratedLoginReply(miner, error, result) {
            let decoratedResult = result;
            if (!error && result && typeof result === "object" && !Array.isArray(result) && miner.login_extensions.length) {
                decoratedResult = { ...result, extensions: miner.login_extensions };
            }
            sendReply(error, decoratedResult);
        }

        /** @param {PoolMiner} miner @returns {{result: unknown, coin: string, jobParams: PoolJobParams, job?: PoolJobPayload, nativeArray: boolean}|null} */
        function buildNativeGetJobResult(miner) {
            const coin = miner.selectBestCoin();
            if (coin === false) return null;
            const jobParams = deps.getCoinJobParams(coin);
            const freshJob = miner.getCoinJob(coin, jobParams);
            if (!miner.valid_miner) return null;
            const job = freshJob === null ? miner.cachedJob : freshJob;
            if (job === null || typeof job === "undefined") return null;
            const poolSettings = getPoolSettingsForCoin(coin);
            if (!(job instanceof Array)) {
                miner.nativeJobAlgo = jobParams.algo_name;
                return {
                    result: { ...job, id: miner.id },
                    coin,
                    jobParams,
                    nativeArray: false
                };
            }
            /** @type {{id: string, algo: string, extra_nonce?: string}} */
            const result = { id: miner.id, algo: jobParams.algo_name };
            if (poolSettings && poolSettings.requiresExtranonce === true && typeof miner.eth_extranonce === "string") {
                result.extra_nonce = miner.eth_extranonce;
            }
            return { result, coin, jobParams, job, nativeArray: true };
        }

        /** @returns {number|null} */
        function claimEthExtranonceId() {
            if (typeof socket.eth_extranonce_id === "number" && Number.isInteger(socket.eth_extranonce_id)) return socket.eth_extranonce_id;
            if (typeof socket.eth_extranonce_preview_id === "number" && Number.isInteger(socket.eth_extranonce_preview_id)) {
                const newId = socket.eth_extranonce_preview_id;
                socket.eth_extranonce_id = newId;
                delete socket.eth_extranonce_preview_id;
                return newId;
            }
            const newId = utils.getNewEthExtranonceId();
            if (newId !== null) socket.eth_extranonce_id = newId;
            return newId;
        }

        /** @returns {number|null} */
        function getEthExtranoncePreviewId() {
            if (typeof socket.eth_extranonce_id === "number" && Number.isInteger(socket.eth_extranonce_id)) return socket.eth_extranonce_id;
            if (typeof socket.eth_extranonce_preview_id === "number" && Number.isInteger(socket.eth_extranonce_preview_id)) return socket.eth_extranonce_preview_id;
            const newId = utils.getNewEthExtranonceId();
            if (newId === null) return null;
            socket.eth_extranonce_preview_id = newId;
            return newId;
        }

        /** @param {PoolMiner} miner @returns {boolean} */
        function rejectInvalidMiner(miner) {
            if (miner.valid_miner) return false;
            const invalidLogKey = getInvalidMinerLogKey(miner);
            if (!(invalidLogKey in state.lastMinerLogTime) || timeNow - (state.lastMinerLogTime[invalidLogKey] ?? 0) > 10 * 60 * 1000) {
                console.log(state.threadName + formatPoolEvent("Invalid miner", { miner: miner.logString, email: miner.email, reason: miner.error }));
                touchTimedEntry(state.lastMinerLogTime, invalidLogKey, timeNow, retention.minerLog);
            }
            sendReplyFinal(miner.error, miner.delay_reply);
            return true;
        }

        /** @param {PoolMiner} miner @returns {boolean} */
        function rejectMinerNotification(miner) {
            const minerAgentNotification = !global.coinFuncs.algoMainCheck(miner.algos) && global.coinFuncs.algoPrevMainCheck(miner.algos)
                ? global.coinFuncs.get_miner_agent_warning_notification(params.agent || "")
                : false;
            const minerNotification = minerAgentNotification || getMinerNotification(miner.payout);
            if (!(minerNotification && (!(miner.payout in state.lastMinerNotifyTime) || timeNow - (state.lastMinerNotifyTime[miner.payout] ?? 0) > 60 * 60 * 1000))) return false;
            touchTimedEntry(state.lastMinerNotifyTime, miner.payout, timeNow, retention.minerNotify);
            console.error(state.threadName + formatPoolEvent("Miner notice", { miner: miner.logString, message: minerNotification }));
            sendReplyFinal(`${minerNotification  } (miner will connect after several attempts)`);
            return true;
        }

        /** @param {PoolMiner} miner @returns {boolean} */
        function registerMinerWallet(miner) {
            if (miner.proxy) return true;
            const proxyMinerName = miner.payout;
            if ((params.agent && params.agent.includes("proxy")) || (proxyMinerName in state.proxyMiners)) {
                if (!addProxyMiner(miner)) {
                    sendReplyFinal("Temporary (one hour max) mining ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
                    return false;
                }
                if (state.proxyMiners[proxyMinerName]?.hashes) adjustMinerDiff(miner);
                return true;
            }
            const wallet = state.minerWallets[miner.payout];
            if (!wallet) {
                state.minerWallets[miner.payout] = { connectTime: Date.now(), count: 1, hashes: 0, last_ver_shares: 0, submissionBudget: false };
                return true;
            }
            // check before incrementing: a rejected over-limit login must not bump the count
            // (the worker never connects, so it is never decremented -> the count would drift up
            // and eventually reject legitimate miners under the real limit).
            if (wallet.count < global.config.pool.workerMax) {
                ++wallet.count;
                return true;
            }
            state.bannedBigTmpWallets[miner.payout] = 1;
            sendReplyFinal("Temporary (one hour max) ban on new miner connections since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
            return false;
        }

        /** @param {PoolMiner} miner @param {string} minerId @returns {void} */
        function finishLogin(miner, minerId) {
            socket.miner_id = minerId;
            addActiveMiner(miner, socket);
            if (socket.authTimer) {
                clearTimeout(socket.authTimer);
                socket.authTimer = null;
            }
            scheduleFirstShareTimer(minerId);
            const trackedAgent = normalizeTrackedAgentKey(params.agent);
            if (trackedAgent !== "" && process.env["WORKER_ID"] === "1") touchTimedEntry(state.minerAgents, trackedAgent, timeNow, retention.minerAgents);
        }

        /** @param {PoolMiner} miner @param {string} minerId @returns {boolean} */
        function sendLoginJob(miner, minerId) {
            if (id === "Stratum") return sendReply(null, "ok"), miner.protocol = "grin", true;
            if (method === "mining.authorize") {
                sendReply(null, true);
                miner.protocol = "eth";
                miner.sendBestCoinJob();
                return true;
            }
            const coin = miner.selectBestCoin();
            if (coin === false) return sendReplyFinal("No block template yet. Please wait."), miner.protocol = "default", true;
            /** @type {import("../../types/pool_profiles").PoolExtraNonceLoginContext} */
            const loginContext = {
                coin,
                jobParams: deps.getCoinJobParams(coin),
                miner,
                minerId,
                scheduleFirstShareTimer,
                sendReply: function sendLoginReply(error, result) {
                    sendDecoratedLoginReply(miner, error, result);
                },
                sendReplyFinal,
                socket,
                utils
            };
            getPoolSettingsForCoin(coin).sendLoginResult(loginContext);
            miner.protocol = "default";
            return true;
        }

        /** @returns {void} */
        function handleLoginRequest() {
            if (ip in state.bannedTmpIPs) {
                sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)");
                return;
            }
            if (!validateLoginParams()) return;
            const minerId = utils.getNewId();
            const miner = createMiner(minerId, params.login || "", params.pass || "x", params.rigid, ip, portData.difficulty, pushMessage, 1, portData.portType, portData.port, params.agent, params.algo, params["algo-perf"], params["algo-min-time"]);
            if (miner.debugMiner) socket.debugMiner = true;
            miner.login_extensions = requestedLoginExtensions();
            miner.mo_native = miner.login_extensions.includes("mo-native");
            miner.submit_result = miner.login_extensions.includes("submit-result");
            socket.mo_native = miner.mo_native;
            socket.submit_result = miner.submit_result;
            attachMinerProtocolMethods(miner);
            applyAuthorizeExtranonce(miner);
            if (rejectInvalidMiner(miner) || rejectMinerNotification(miner) || !registerMinerWallet(miner)) return;
            finishLogin(miner, minerId);
            sendLoginJob(miner, minerId);
        }

        /** @returns {void} */
        function handleSubscribeRequest() {
            if (wireParams instanceof Array && wireParams.length >= 1 && typeof wireParams[0] === "string") socket.eth_agent = wireParams[0];
            const previewId = getEthExtranoncePreviewId();
            if (previewId !== null) {
                /** @type {unknown[]} */
                const subscribeResult = [["mining.notify", utils.getNewId(), "EthereumStratum/1.0.0"], utils.ethExtranonce(previewId)];
                if (!(wireParams instanceof Array) || wireParams[1] !== "EthereumStratum/1.0.0") subscribeResult.push(6);
                sendReply(null, subscribeResult);
            } else {
                sendReplyFinal("Not enough extranonces. Switch to other pool node.");
            }
        }

        /** @returns {PoolMiner|null} */
        function getSocketMiner() {
            const minerId = socket.miner_id || "";
            return minerId ? (state.activeMiners.get(minerId) ?? null) : null;
        }

        /** @returns {PoolMiner|null} */
        function getAuthenticatedSocketMiner() {
            const miner = getSocketMiner();
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return null;
            }
            return miner;
        }

        /** @returns {void} */
        function handleGetJobTemplateRequest() {
            const miner = getAuthenticatedSocketMiner();
            if (!miner) return;
            if (!consumePreShareRateLimit("job-request", miner, ip, timeNow)) {
                sendReplyFinal("Rate limit exceeded for job requests before first valid share");
                return;
            }
            miner.touchProtocolActivity();
            sendReply(null, miner.getBestCoinJob());
        }

        /** @returns {void} */
        function handleGetJobRequest() {
            if (inputParams === null || typeof inputParams === "undefined") {
                sendReplyFinal("No params specified");
                return;
            }
            const miner = getAuthenticatedSocketMiner();
            if (!miner) return;
            if (!consumePreShareRateLimit("job-request", miner, ip, timeNow)) {
                sendReplyFinal("Rate limit exceeded for job requests before first valid share");
                return;
            }
            miner.touchProtocolActivity();
            if (params.algo && params.algo instanceof Array && params["algo-perf"] && params["algo-perf"] instanceof Object) {
                const status = miner.setAlgos(params.algo, params["algo-perf"], params["algo-min-time"]);
                if (status !== "") {
                    sendReply(status);
                    return;
                }
            }
            if (miner.mo_native) {
                const nativeJob = buildNativeGetJobResult(miner);
                if (!nativeJob) {
                    sendReplyFinal("No block template yet. Please wait.");
                    return;
                }
                sendReply(null, nativeJob.result);
                if (nativeJob.nativeArray) {
                    miner.sendCoinJob(nativeJob.coin, nativeJob.jobParams, { job: nativeJob.job ?? null });
                }
                return;
            }
            sendReply(null, miner.getBestCoinJob());
        }

        /** @returns {boolean} */
        function normalizeMiningSubmitParams() {
            if (!(wireParams instanceof Array)) {
                sendReply("No array params specified");
                return false;
            }
            for (const param of wireParams) {
                if (typeof param !== "string") {
                    sendReply("Not correct params specified");
                    return false;
                }
            }
            if (wireParams.length >= 3) {
                params = { job_id: wireParams[1], raw_params: wireParams };
                if (socket.submit_result && request && typeof request["result"] === "string") params.result = request["result"];
            } else {
                sendReply("Not correct params specified");
                return false;
            }
            return true;
        }

        /** @returns {PoolMiner|null} */
        function getSubmitMiner() {
            if (inputParams === null || typeof inputParams === "undefined") {
                sendReplyFinal("No params specified");
                return null;
            }
            const miner = getAuthenticatedSocketMiner();
            if (!miner) return null;
            if (typeof params.job_id === "number") params.job_id = params.job_id.toString();
            return miner;
        }

        /** @param {PoolMiner} miner @returns {null} */
        function rejectInvalidSubmitJob(miner) {
            if (!miner.hasSubmittedValidShare) {
                miner.invalidJobIdCount = (miner.invalidJobIdCount || 0) + 1;
                if (miner.invalidJobIdCount >= getPoolSecurityConfig().invalidJobIdLimitBeforeShare) {
                    removeMiner(miner, { reason: "invalid-job-id-limit", destroySocket: false });
                    sendReply("Invalid job id");
                    closeSocketAfterReply();
                    return null;
                }
            }
            sendReply("Invalid job id");
            return null;
        }

        /** @param {PoolMiner} miner @returns {PoolJob|null} */
        function getSubmitJob(miner) {
            const job = miner.validJobs.toarray().filter(function findJob(candidate) {
                return candidate.id === params.job_id;
            })[0];
            if (job) {
                if (!miner.hasSubmittedValidShare && miner.invalidJobIdCount > 0) miner.invalidJobIdCount = 0;
                return job;
            }
            return rejectInvalidSubmitJob(miner);
        }

        /** @param {PoolMiner} miner @param {string} replyText @returns {void} */
        function rejectBadShare(miner, replyText) {
            const banned = miner.checkBan(false);
            sendReply(replyText);
            if (banned) closeSocketAfterReply();
            miner.storeInvalidShare();
        }

        /** @param {PoolMiner} miner @param {PoolJob} job @param {PoolSubmitSettings} poolSettings @returns {boolean} */
        function validateSubmitNonce(miner, job, poolSettings) {
            const blobTypeNum = job.blob_type_num;
            if (method === "mining.submit") {
                if (typeof poolSettings.parseMiningSubmitParams !== "function" || !poolSettings.parseMiningSubmitParams({ params })) {
                    sendReply("Invalid job params");
                    return false;
                }
            }
            const isNonceValid = poolSettings.validateSubmitParams({ blobTypeNum, coinFuncs: global.coinFuncs, job, miner, normalizeExtraNonceSubmitNonce, params, state });
            if (!isNonceValid) {
                console.warn(state.threadName + formatPoolEvent("Malformed nonce", { miner: miner.logString, params }));
                rejectBadShare(miner, "Duplicate share");
                return false;
            }
            if (job.usesProxyNonce) {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(state.threadName + formatPoolEvent("Malformed nonce", { miner: miner.logString, params }));
                    rejectBadShare(miner, "Duplicate share");
                    return false;
                }
            }
            return true;
        }

        /** @param {PoolMiner} miner @param {PoolJob & {rewarded_difficulty: number}} job @returns {PoolBlockTemplate|null} */
        function getSubmitBlockTemplate(miner, job) {
            job.rewarded_difficulty = job.difficulty;
            const activeTemplate = state.activeBlockTemplates[job.coin];
            if (activeTemplate && activeTemplate.idHash === job.blockHash) return activeTemplate;
            const blockTemplate = state.pastBlockTemplates[job.coin]?.toarray().find(function findPastTemplate(template) {
                return template.idHash === job.blockHash;
            });
            const isOutdated = updateLateShareDifficulty(job, blockTemplate);
            if (blockTemplate && !isOutdated) return blockTemplate;
            rejectExpiredShare(miner, job, blockTemplate ? "Block outdated" : "Block expired");
            return null;
        }

        /** @param {PoolJob & {rewarded_difficulty: number}} job @param {PoolBlockTemplate|null|undefined} blockTemplate @returns {boolean} */
        function updateLateShareDifficulty(job, blockTemplate) {
            if (!(blockTemplate && blockTemplate.timeoutTime)) return false;
            const lateTime = Date.now() - blockTemplate.timeoutTime;
            if (lateTime <= 0) return false;
            const maxLateTime = global.config.pool.targetTime * 1000;
            if (lateTime >= maxLateTime) return true;
            // Steeply decay credited difficulty for shares that land after the template
            // timed out (full credit near the timeout, near-zero as lateTime -> maxLateTime).
            const factor = (maxLateTime - lateTime) / maxLateTime;
            job.rewarded_difficulty = job.difficulty * Math.pow(factor, 6);
            return false;
        }

        /** @param {PoolMiner} miner @param {PoolJob} job @param {string} errStr @returns {void} */
        function rejectExpiredShare(miner, job, errStr) {
            const logTime = Date.now();
            if (!(miner.payout in state.lastMinerLogTime) || logTime - (state.lastMinerLogTime[miner.payout] ?? 0) > 30 * 1000) {
                console.warn(state.threadName + formatPoolEvent("Share rejected", { reason: errStr, height: job.height, diff: job.difficulty, miner: miner.logString }));
                touchTimedEntry(state.lastMinerLogTime, miner.payout, logTime, retention.minerLog);
            }
            miner.sendSameCoinJob();
            rejectBadShare(miner, errStr);
        }

        /** @param {PoolMiner} miner @param {PoolBlockTemplate} blockTemplate @param {string} submissionKey @param {"nonce"|"submission"|null} mode @returns {boolean} */
        function rejectDuplicateTemplateSubmission(miner, blockTemplate, submissionKey, mode) {
            if (!(mode && hasTrackedSharedTemplateSubmission(blockTemplate, submissionKey))) return false;
            console.warn(state.threadName + formatPoolEvent("Duplicate share", {
                reason: mode === "nonce" ? "template-nonce" : "template-submission",
                nonce: submissionKey,
                miner: miner.logString
            }));
            rejectBadShare(miner, "Duplicate share");
            return true;
        }

        /** @param {PoolMiner} miner @param {PoolJob} job @param {string} nonceTest @returns {boolean} */
        function rejectDuplicateJobSubmission(miner, job, nonceTest) {
            const submissions = getJobSubmissions(job);
            if (submissions.has(nonceTest)) {
                console.warn(state.threadName + formatPoolEvent("Duplicate share", { reason: "miner-nonce", nonce: nonceTest, miner: miner.logString }));
                rejectBadShare(miner, "Duplicate share");
                return true;
            }
            if (!hasReachedSubmissionLimit(job, miner)) return false;
            console.warn(state.threadName + formatPoolEvent("Share limit", { tracked: submissions.size, miner: miner.logString }));
            sendReply("Too many share submissions for the current job. Wait for a new job.");
            return true;
        }

        /** @param {PoolMiner} miner @param {PoolJob & {rewarded_difficulty2: number}} job @param {PoolSubmitSettings} poolSettings @param {boolean|null} shareAccepted @returns {void} */
        function handleShareProcessed(miner, job, poolSettings, shareAccepted) {
            const wasRemoved = miner.removed_miner;
            let banned = false;
            if (shareAccepted !== null) banned = miner.checkBan(shareAccepted);
            if (wasRemoved) return;
            if (shareAccepted === null) {
                sendReply("Throttled down share submission (please increase difficulty)");
                return;
            }
            if (global.config.pool.trustedMiners && miner.trust) {
                if (shareAccepted) {
                    miner.trust.trust += job.rewarded_difficulty2;
                    miner.trust.check_height = 0;
                } else {
                    debug(state.threadName + formatPoolEvent("Share trust reset", { miner: miner.logString }));
                    miner.storeInvalidShare();
                    miner.trust.trust = 0;
                }
            }
            if (!shareAccepted) {
                sendReply("Low difficulty share");
                if (banned) closeSocketAfterReply();
                return;
            }
            miner.touchValidShare();
            miner.lastShareTime = Date.now() / 1000;
            if (socket.firstShareTimer) {
                clearTimeout(socket.firstShareTimer);
                socket.firstShareTimer = null;
            }
            if (miner.protocol === "grin") sendReply(null, "ok");
            else if (poolSettings.submitSuccess === "boolean") sendReply(null, true);
            else sendReply(null, { status: "OK" });
            if (banned) closeSocketAfterReply();
        }

        /** @returns {void} */
        function handleSubmitRequest() {
            const miner = getSubmitMiner();
            if (!miner) return;
            const trackedJob = getSubmitJob(miner);
            if (!trackedJob) return;
            const currentCoinHashFactor = state.lastCoinHashFactorMM[trackedJob.coin];
            if (typeof currentCoinHashFactor !== "number" || !Number.isFinite(currentCoinHashFactor) || currentCoinHashFactor <= 0) {
                const blockTemplate = state.activeBlockTemplates[trackedJob.coin];
                if (currentCoinHashFactor === 0 && blockTemplate && Date.now() - (blockTemplate.timeCreated ?? Date.now()) > 10 * 60 * 1000) {
                    sendReplyFinal("This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.");
                } else {
                    sendReply("Block expired");
                }
                return;
            }
            miner.touchProtocolActivity();
            const poolSettings = getPoolSettingsForJob(trackedJob);
            if (!validateSubmitNonce(miner, trackedJob, poolSettings)) return;
            const nonceTest = poolSettings.submissionKey({ miner, job: trackedJob, params });
            const job = { ...trackedJob, rewarded_difficulty: trackedJob.difficulty, rewarded_difficulty2: 0 };
            const blockTemplate = getSubmitBlockTemplate(miner, job);
            if (!blockTemplate) return;
            const templateSubmissionMode = sharedTemplateSubmissionMode(trackedJob);
            if (rejectDuplicateTemplateSubmission(miner, blockTemplate, nonceTest, templateSubmissionMode)) return;
            if (rejectDuplicateJobSubmission(miner, trackedJob, nonceTest)) return;
            if (templateSubmissionMode && !trackSharedTemplateSubmission(blockTemplate, nonceTest)) {
                if (blockTemplate.templateSubmissionLimitLogged !== true) {
                    blockTemplate.templateSubmissionLimitLogged = true;
                    console.warn(state.threadName + formatPoolEvent("Template share limit", { tracked: getSharedTemplateSubmissions(blockTemplate).size, miner: miner.logString }));
                }
                sendReply("Too many share submissions for the current template. Wait for a new template.");
                return;
            }
            trackJobSubmission(trackedJob, nonceTest);
            job.rewarded_difficulty2 = job.rewarded_difficulty * (job.hashesPerDifficulty || 1) * job.coinHashFactor;
            let callbackInvoked = false;
            try {
                shareProcessor.processShare(miner, job, blockTemplate, params, function onShareProcessed(shareAccepted) {
                    callbackInvoked = true;
                    if (shareAccepted === null) untrackJobSubmission(trackedJob, nonceTest);
                    if (templateSubmissionMode && shareAccepted !== true) untrackSharedTemplateSubmission(blockTemplate, nonceTest);
                    handleShareProcessed(miner, job, poolSettings, shareAccepted);
                });
            } catch (error) {
                // A synchronous verifier failure happens before ownership moves
                // to the completion callback, so release both reservations.
                if (!callbackInvoked) {
                    untrackJobSubmission(trackedJob, nonceTest);
                    if (templateSubmissionMode) untrackSharedTemplateSubmission(blockTemplate, nonceTest);
                }
                throw error;
            }
        }

        /** @returns {void} */
        function handleKeepaliveRequest() {
            if (inputParams === null || typeof inputParams === "undefined") {
                sendReplyFinal("No params specified");
                return;
            }
            const miner = getAuthenticatedSocketMiner();
            if (!miner) return;
            miner.touchProtocolActivity();
            sendReply(null, { status: "KEEPALIVED" });
        }

        /** @type {Record<string, () => void>} */
        const methodHandlers = {
            "mining.authorize": function onAuthorize() { if (normalizeAuthorizeParams()) handleLoginRequest(); },
            login: handleLoginRequest,
            "mining.subscribe": handleSubscribeRequest,
            "mining.extranonce.subscribe": function onExtraNonceSubscribe() { sendReply(null, true); },
            getjobtemplate: handleGetJobTemplateRequest,
            getjob: handleGetJobRequest,
            "mining.submit": function onMiningSubmit() { if (normalizeMiningSubmitParams()) handleSubmitRequest(); },
            submit: handleSubmitRequest,
            keepalive: handleKeepaliveRequest,
            keepalived: handleKeepaliveRequest
        };
        const handler = methodHandlers[method];
        if (handler) handler();
        else handleUnknownMethod();
    };
};
