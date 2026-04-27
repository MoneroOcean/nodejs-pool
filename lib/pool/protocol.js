"use strict";
const { consumeRateLimitToken, getPoolSecurityConfig, normalizeRemoteAddress } = require("./security.js");
const RATE_LIMIT_METHODS = Object.freeze({ login: "login", "mining.authorize": "login", "mining.subscribe": "login", "mining.extranonce.subscribe": "login", submit: "submit", "mining.submit": "submit", keepalive: "keepalive", keepalived: "keepalive" });

// Protocol handling turns wire-level messages into miner/session operations.
// Keeping it separate from pool lifecycle code makes test-mode composition much
// easier and keeps transport concerns local.
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

    function getMinerNotification(payout) {
        return payout in state.notifyAddresses ? state.notifyAddresses[payout] : false;
    }

    function normalizeInvalidMinerKey(value) {
        if (typeof value !== "string") return "";
        const trimmed = value.trim();
        return trimmed ? trimmed.substring(0, retention.minerAgents.maxKeyLength) : "";
    }

    function getInvalidMinerLogKey(miner) {
        if (miner && typeof miner.invalidLogKey === "string" && miner.invalidLogKey !== "") return miner.invalidLogKey;
        if (miner) {
            const normalizedPayout = normalizeInvalidMinerKey(miner.payout);
            if (normalizedPayout !== "") return normalizedPayout;
        }
        return "invalid-wallet";
    }

    function normalizeTrackedAgentKey(agent) {
        if (typeof agent !== "string") return "";
        const trimmed = agent.trim();
        return trimmed ? trimmed.substring(0, retention.minerAgents.maxKeyLength) : "";
    }

    function getJobSubmissions(job) {
        if (job.submissions instanceof Map) return job.submissions;
        job.submissions = new Map();
        return job.submissions;
    }

    function getSharedTemplateNonceSubmissions(blockTemplate) {
        if (blockTemplate.sharedNonceSubmissions instanceof Set) return blockTemplate.sharedNonceSubmissions;
        blockTemplate.sharedNonceSubmissions = new Set();
        return blockTemplate.sharedNonceSubmissions;
    }

    function shouldTrackSharedTemplateNonce(job) {
        const poolSettings = getPoolSettingsForJob(job);
        return poolSettings.sharedTemplateNonces === true;
    }

    function getSharedTemplateNonceLimit() {
        const baseLimit = global.config.pool.minerThrottleShareWindow * global.config.pool.minerThrottleSharePerSec * 100;
        return Math.max(65536, baseLimit);
    }

    function hasTrackedSharedTemplateNonce(blockTemplate, nonce) {
        return getSharedTemplateNonceSubmissions(blockTemplate).has(nonce);
    }

    function trackSharedTemplateNonce(blockTemplate, nonce) {
        const submissions = getSharedTemplateNonceSubmissions(blockTemplate);
        submissions.add(nonce);
        const limit = getSharedTemplateNonceLimit();
        while (submissions.size > limit) submissions.delete(submissions.values().next().value);
    }

    function hasProxySubmissionBudget(miner) {
        if (!miner) return false;
        const proxyMinerName = miner.proxyMinerName || miner.payout;
        return !!(proxyMinerName && proxyMinerName in state.proxyMiners);
    }

    function getTrackedSubmissionLimit(miner) {
        const multiplier = hasProxySubmissionBudget(miner) ? 1000 : 100;
        return global.config.pool.minerThrottleShareWindow * global.config.pool.minerThrottleSharePerSec * multiplier;
    }

    function willShareBeThrottled(miner) {
        const minerWallet = state.minerWallets[miner.payout];
        if (!minerWallet) return false;
        const threshold = global.config.pool.minerThrottleSharePerSec * global.config.pool.minerThrottleShareWindow;
        return minerWallet.last_ver_shares >= threshold;
    }

    function trackJobSubmission(job, nonceTest) {
        const submissions = getJobSubmissions(job);
        submissions.set(nonceTest, 1);
    }

    function hasReachedSubmissionLimit(job, miner) {
        return getJobSubmissions(job).size >= getTrackedSubmissionLimit(miner);
    }

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

    function consumeRpcRateLimit(rateMethod, ip, now) {
        const limitConfig = getRateLimitConfig(rateMethod);
        if (!limitConfig) return true;
        const normalizedIp = normalizeRemoteAddress(ip);
        return consumeRateLimitToken(
            state.rpcRateBuckets,
            rateMethod + ":" + normalizedIp,
            limitConfig.ratePerSecond,
            limitConfig.burst,
            now,
            limitConfig.config
        );
    }

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
            rateMethod + ":" + normalizeRemoteAddress(ip),
            ratePerSecond,
            burst,
            now,
            config
        );
    }

    function claimEthExtranonceId(preferredId) {
        if (Number.isInteger(preferredId)) {
            const index = state.freeEthExtranonces.lastIndexOf(preferredId);
            if (index !== -1) {
                state.freeEthExtranonces.splice(index, 1);
                return preferredId;
            }
        }
        return utils.getNewEthExtranonceId();
    }

    function getEthExtranoncePreviewId(socket) {
        if (Number.isInteger(socket.eth_extranonce_id)) return socket.eth_extranonce_id;
        if (Number.isInteger(socket.eth_extranonce_preview_id)) return socket.eth_extranonce_preview_id;
        if (!state.freeEthExtranonces.length) return null;
        socket.eth_extranonce_preview_id = state.freeEthExtranonces[state.freeEthExtranonces.length - 1];
        return socket.eth_extranonce_preview_id;
    }

    function normalizeExtraNonceSubmitNonce(nonce, extraNonce, options) {
        if (typeof nonce !== "string") return nonce;

        const normalizedNonce = nonce.toLowerCase().startsWith("0x")
            ? nonce.slice(2)
            : nonce;
        if (typeof extraNonce !== "string" || !extraNonce.length) return normalizedNonce;

        const normalizedExtraNonce = extraNonce.toLowerCase();
        const fullNonceHexLength = 16;
        const suffixHexLength = fullNonceHexLength - normalizedExtraNonce.length;
        const normalizedNonceLower = normalizedNonce.toLowerCase();
        const requireFullNonceExtraNoncePrefix = !!(options && options.requireFullNonceExtraNoncePrefix);

        // Some eth-style miners submit only the nonce suffix while others submit
        // the full 8-byte nonce. Coins that share the eth_submitWork nonce space
        // require full nonces to stay inside the assigned pool extranonce segment.
        // Do not bypass this check for miner quirks; parse the miner's real full
        // nonce field before calling this normalizer instead.
        if (normalizedNonce.length === suffixHexLength) {
            return normalizedExtraNonce + normalizedNonce;
        }
        if (normalizedNonce.length === fullNonceHexLength) {
            return !requireFullNonceExtraNoncePrefix || normalizedNonceLower.startsWith(normalizedExtraNonce)
                ? normalizedNonceLower
                : null;
        }

        return null;
    }

    // Active jobs always resolve to a coin profile with attached pool handlers.
    // Listening ports usually do too, but the generic eth-style front port does
    // not, so preserve the pre-refactor fallback there instead of crashing.
    function getPoolSettingsForCoin(coin) {
        return global.coinFuncs.getPoolProfile(coin).pool;
    }

    function getPoolSettingsForJob(job) {
        return global.coinFuncs.getJobProfile(job).pool;
    }

    function getPoolProfileForPort(port) {
        return global.coinFuncs.getPoolProfile(port);
    }

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

    return function handleMinerData(socket, id, method, params, ip, portData, sendReply, sendReplyFinal, pushMessage) {
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

        function handleUnknownMethod() {
            const config = getPoolSecurityConfig();
            const minerId = socket.miner_id || (params && params instanceof Object && "id" in params ? params.id : "");
            const miner = minerId ? state.activeMiners.get(minerId) : null;

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
            sendReplyFinal("Rate limit exceeded for " + rateMethod + " requests");
            return;
        }

        function normalizeAuthorizeParams() {
            if (!params || !(params instanceof Array)) {
                sendReplyFinal("No array params specified");
                return false;
            }
            const authorizeAlgoState = getAuthorizeAlgoState(portData.port);
            params = { login: params[0], pass: params[1], agent: socket.eth_agent ? socket.eth_agent : "[generic_ethminer]", algo: authorizeAlgoState.algos, "algo-perf": authorizeAlgoState.algosPerf, "algo-min-time": authorizeAlgoState.algoMinTime };
            return true;
        }

        function validateLoginParams() {
            if (ip in state.bannedTmpIPs) return sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)"), false;
            if (!params) return processSend({ type: "banIP", data: ip }), sendReplyFinal("No params specified"), false;
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

        function applyAuthorizeExtranonce(miner) {
            if (method !== "mining.authorize") return;
            const newId = Number.isInteger(socket.eth_extranonce_id)
                ? socket.eth_extranonce_id
                : claimEthExtranonceId(socket.eth_extranonce_preview_id);
            if (newId !== null) {
                socket.eth_extranonce_id = newId;
                delete socket.eth_extranonce_preview_id;
                miner.eth_extranonce = utils.ethExtranonce(newId);
                return;
            }
            miner.valid_miner = false;
            miner.error = "Not enough extranoces. Switch to other pool node.";
        }

        function rejectInvalidMiner(miner) {
            if (miner.valid_miner) return false;
            const invalidLogKey = getInvalidMinerLogKey(miner);
            if (!(invalidLogKey in state.lastMinerLogTime) || timeNow - state.lastMinerLogTime[invalidLogKey] > 10 * 60 * 1000) {
                console.log(state.threadName + formatPoolEvent("Invalid miner", { miner: miner.logString, email: miner.email, reason: miner.error }));
                touchTimedEntry(state.lastMinerLogTime, invalidLogKey, timeNow, retention.minerLog);
            }
            sendReplyFinal(miner.error, miner.delay_reply);
            return true;
        }

        function rejectMinerNotification(miner) {
            const minerAgentNotification = !global.coinFuncs.algoMainCheck(miner.algos) && global.coinFuncs.algoPrevMainCheck(miner.algos)
                ? global.coinFuncs.get_miner_agent_warning_notification(params.agent)
                : false;
            const minerNotification = minerAgentNotification || getMinerNotification(miner.payout);
            if (!(minerNotification && (!(miner.payout in state.lastMinerNotifyTime) || timeNow - state.lastMinerNotifyTime[miner.payout] > 60 * 60 * 1000))) return false;
            touchTimedEntry(state.lastMinerNotifyTime, miner.payout, timeNow, retention.minerNotify);
            console.error(state.threadName + formatPoolEvent("Miner notice", { miner: miner.logString, message: minerNotification }));
            sendReplyFinal(minerNotification + " (miner will connect after several attempts)");
            return true;
        }

        function registerMinerWallet(miner) {
            if (miner.proxy) return true;
            const proxyMinerName = miner.payout;
            if ((params.agent && params.agent.includes("proxy")) || (proxyMinerName in state.proxyMiners)) {
                if (!addProxyMiner(miner)) {
                    sendReplyFinal("Temporary (one hour max) mining ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
                    return false;
                }
                if (state.proxyMiners[proxyMinerName].hashes) adjustMinerDiff(miner);
                return true;
            }
            if (!(miner.payout in state.minerWallets)) {
                state.minerWallets[miner.payout] = { connectTime: Date.now(), count: 1, hashes: 0, last_ver_shares: 0 };
                return true;
            }
            if (++state.minerWallets[miner.payout].count <= global.config.pool.workerMax) return true;
            state.bannedBigTmpWallets[miner.payout] = 1;
            sendReplyFinal("Temporary (one hour max) ban on new miner connections since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
            return false;
        }

        function finishLogin(miner, minerId) {
            socket.miner_id = minerId;
            addActiveMiner(miner, socket);
            if (socket.authTimer) {
                clearTimeout(socket.authTimer);
                socket.authTimer = null;
            }
            scheduleFirstShareTimer(minerId);
            const trackedAgent = normalizeTrackedAgentKey(params.agent);
            if (trackedAgent !== "" && process.env.WORKER_ID == 1) touchTimedEntry(state.minerAgents, trackedAgent, timeNow, retention.minerAgents);
        }

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
            getPoolSettingsForCoin(coin).sendLoginResult({ coin, jobParams: deps.getCoinJobParams(coin), miner, minerId, scheduleFirstShareTimer, sendReply, sendReplyFinal, socket, utils });
            miner.protocol = "default";
            return true;
        }

        function handleLoginRequest() {
            if (ip in state.bannedTmpIPs) {
                sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)");
                return;
            }
            if (!validateLoginParams()) return;
            const minerId = utils.getNewId();
            const miner = createMiner(minerId, params.login, params.pass, params.rigid, ip, portData.difficulty, pushMessage, 1, portData.portType, portData.port, params.agent, params.algo, params["algo-perf"], params["algo-min-time"]);
            if (miner.debugMiner) socket.debugMiner = 1;
            applyAuthorizeExtranonce(miner);
            if (rejectInvalidMiner(miner) || rejectMinerNotification(miner) || !registerMinerWallet(miner)) return;
            finishLogin(miner, minerId);
            sendLoginJob(miner, minerId);
        }

        function handleSubscribeRequest() {
            if (params && params instanceof Array && params.length >= 1) socket.eth_agent = params[0];
            const previewId = getEthExtranoncePreviewId(socket);
            if (previewId !== null) {
                const subscribeResult = [["mining.notify", utils.getNewId(), "EthereumStratum/1.0.0"], utils.ethExtranonce(previewId)];
                if (!(params instanceof Array) || params[1] !== "EthereumStratum/1.0.0") subscribeResult.push(6);
                sendReply(null, subscribeResult);
            } else {
                sendReplyFinal("Not enough extranoces. Switch to other pool node.");
            }
        }

        function handleGetJobTemplateRequest() {
            const miner = state.activeMiners.get(socket.miner_id ? socket.miner_id : "");
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return;
            }
            if (!consumePreShareRateLimit("job-request", miner, ip, timeNow)) {
                sendReplyFinal("Rate limit exceeded for job requests before first valid share");
                return;
            }
            miner.touchProtocolActivity();
            sendReply(null, miner.getBestCoinJob());
        }

        function handleGetJobRequest() {
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            const miner = state.activeMiners.get(params.id);
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return;
            }
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
            sendReply(null, miner.getBestCoinJob());
        }

        function normalizeMiningSubmitParams() {
            if (!params || !(params instanceof Array)) {
                sendReply("No array params specified");
                return false;
            }
            for (const param of params) {
                if (typeof param !== "string") {
                    sendReply("Not correct params specified");
                    return false;
                }
            }
            if (params.length >= 3) {
                params = { job_id: params[1], raw_params: params };
            } else {
                sendReply("Not correct params specified");
                return false;
            }
            return true;
        }

        function getSubmitMiner() {
            if (!params) {
                sendReplyFinal("No params specified");
                return null;
            }
            const minerId = params.id ? params.id : (socket.miner_id ? socket.miner_id : "");
            const miner = state.activeMiners.get(minerId);
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return null;
            }
            if (typeof params.job_id === "number") params.job_id = params.job_id.toString();
            return miner;
        }

        function getSubmitJob(miner) {
            const job = miner.validJobs.toarray().filter(function findJob(candidate) {
                return candidate.id === params.job_id;
            })[0];
            if (job) {
                if (!miner.hasSubmittedValidShare && miner.invalidJobIdCount > 0) miner.invalidJobIdCount = 0;
                return job;
            }
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

        function rejectBadShare(miner, replyText) {
            const banned = miner.checkBan(false);
            sendReply(replyText);
            if (banned) closeSocketAfterReply();
            miner.storeInvalidShare();
        }

        function validateSubmitNonce(miner, job, poolSettings) {
            const blobTypeNum = job.blob_type_num;
            if (method === "mining.submit") {
                if (!poolSettings.parseMiningSubmitParams({ params })) {
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
            if (miner.proxy) {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(state.threadName + formatPoolEvent("Malformed nonce", { miner: miner.logString, params }));
                    rejectBadShare(miner, "Duplicate share");
                    return false;
                }
            }
            return true;
        }

        function getSubmitBlockTemplate(miner, job) {
            job.rewarded_difficulty = job.difficulty;
            if (state.activeBlockTemplates[job.coin].idHash === job.blockHash) {
                const blockTemplate = state.activeBlockTemplates[job.coin];
                if (!state.lastCoinHashFactorMM[job.coin] && Date.now() - blockTemplate.timeCreated > 60 * 60 * 1000) {
                    sendReplyFinal("This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.");
                    return null;
                }
                return blockTemplate;
            }
            const blockTemplate = state.pastBlockTemplates[job.coin].toarray().filter(function findPastTemplate(template) {
                return template.idHash === job.blockHash;
            })[0];
            const isOutdated = updateLateShareDifficulty(job, blockTemplate);
            if (blockTemplate && !isOutdated) return blockTemplate;
            rejectExpiredShare(miner, job, blockTemplate ? "Block outdated" : "Block expired");
            return null;
        }

        function updateLateShareDifficulty(job, blockTemplate) {
            if (!(blockTemplate && blockTemplate.timeoutTime)) return false;
            const lateTime = Date.now() - blockTemplate.timeoutTime;
            if (lateTime <= 0) return false;
            const maxLateTime = global.config.pool.targetTime * 1000;
            if (lateTime >= maxLateTime) return true;
            const factor = (maxLateTime - lateTime) / maxLateTime;
            job.rewarded_difficulty = job.difficulty * Math.pow(factor, 6);
            return false;
        }

        function rejectExpiredShare(miner, job, errStr) {
            const logTime = Date.now();
            if (!(miner.payout in state.lastMinerLogTime) || logTime - state.lastMinerLogTime[miner.payout] > 30 * 1000) {
                console.warn(state.threadName + formatPoolEvent("Share rejected", { reason: errStr, height: job.height, diff: job.difficulty, miner: miner.logString }));
                touchTimedEntry(state.lastMinerLogTime, miner.payout, logTime, retention.minerLog);
            }
            miner.sendSameCoinJob();
            rejectBadShare(miner, errStr);
        }

        function rejectDuplicateTemplateNonce(miner, job, blockTemplate) {
            if (!(shouldTrackSharedTemplateNonce(job) && hasTrackedSharedTemplateNonce(blockTemplate, params.nonce))) return false;
            console.warn(state.threadName + formatPoolEvent("Duplicate share", { reason: "template-nonce", nonce: params.nonce, miner: miner.logString }));
            rejectBadShare(miner, "Duplicate share");
            return true;
        }

        function rejectDuplicateJobSubmission(miner, job, nonceTest) {
            if (willShareBeThrottled(miner)) return false;
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

        function handleShareProcessed(miner, job, poolSettings, shareAccepted) {
            if (miner.removed_miner) return;
            if (shareAccepted === null) {
                sendReply("Throttled down share submission (please increase difficulty)");
                return;
            }
            const banned = miner.checkBan(shareAccepted);
            if (global.config.pool.trustedMiners) {
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
            miner.lastShareTime = Date.now() / 1000 || 0;
            if (socket.firstShareTimer) {
                clearTimeout(socket.firstShareTimer);
                socket.firstShareTimer = null;
            }
            if (miner.protocol === "grin") sendReply(null, "ok");
            else if (poolSettings.submitSuccess === "boolean") sendReply(null, true);
            else sendReply(null, { status: "OK" });
            if (banned) closeSocketAfterReply();
        }

        function handleSubmitRequest() {
            const miner = getSubmitMiner();
            if (!miner) return;
            const job = getSubmitJob(miner);
            if (!job) return;
            miner.touchProtocolActivity();
            const poolSettings = getPoolSettingsForJob(job);
            if (!validateSubmitNonce(miner, job, poolSettings)) return;
            const nonceTest = poolSettings.submissionKey({ miner, params });
            const blockTemplate = getSubmitBlockTemplate(miner, job);
            if (!blockTemplate) return;
            const trackSharedTemplateNonceForShare = shouldTrackSharedTemplateNonce(job);
            if (rejectDuplicateTemplateNonce(miner, job, blockTemplate)) return;
            const shareWindowThrottled = willShareBeThrottled(miner);
            if (rejectDuplicateJobSubmission(miner, job, nonceTest)) return;
            if (trackSharedTemplateNonceForShare) trackSharedTemplateNonce(blockTemplate, params.nonce);
            if (!shareWindowThrottled) trackJobSubmission(job, nonceTest);
            job.rewarded_difficulty2 = job.rewarded_difficulty * job.coinHashFactor;
            shareProcessor.processShare(miner, job, blockTemplate, params, function onShareProcessed(shareAccepted) {
                handleShareProcessed(miner, job, poolSettings, shareAccepted);
            });
        }

        function handleKeepaliveRequest() {
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            const minerId = socket.miner_id ? socket.miner_id : (params.id ? params.id : "");
            const miner = state.activeMiners.get(minerId);
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return;
            }
            miner.touchProtocolActivity();
            sendReply(null, { status: "KEEPALIVED" });
        }

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
