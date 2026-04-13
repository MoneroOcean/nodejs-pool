"use strict";

const { consumeRateLimitToken, getPoolSecurityConfig, normalizeRemoteAddress } = require("./security.js");

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
        adjustMinerDiff,
        shareProcessor,
        removeMiner,
        processSend
    } = deps;

    function getMinerNotification(payout) {
        return payout in state.notifyAddresses ? state.notifyAddresses[payout] : false;
    }

    function getInvalidMinerLogKey(miner) {
        if (miner && typeof miner.invalidLogKey === "string" && miner.invalidLogKey !== "") return miner.invalidLogKey;
        return "invalid-login";
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

    function normalizeExtraNonceSubmitNonce(nonce, extraNonce) {
        if (typeof nonce !== "string") return nonce;

        const normalizedNonce = nonce.toLowerCase().startsWith("0x")
            ? nonce.slice(2)
            : nonce;
        if (typeof extraNonce !== "string" || !extraNonce.length) return normalizedNonce;

        const normalizedExtraNonce = extraNonce.toLowerCase();
        const fullNonceHexLength = 16;
        const suffixHexLength = fullNonceHexLength - normalizedExtraNonce.length;
        const normalizedNonceLower = normalizedNonce.toLowerCase();

        // Some eth-style miners submit only the nonce suffix while others submit
        // the full 8-byte nonce as-is. Live SRBMiner etchash traffic on MO does
        // not prefix the full nonce with the subscribe extranonce.
        if (normalizedNonce.length === suffixHexLength) {
            return normalizedExtraNonce + normalizedNonce;
        }
        if (normalizedNonce.length === fullNonceHexLength) {
            return normalizedNonceLower;
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
        let rateMethod = null;
        if (method === "login" || method === "mining.authorize" || method === "mining.subscribe" || method === "mining.extranonce.subscribe") rateMethod = "login";
        else if (method === "submit" || method === "mining.submit") rateMethod = "submit";
        else if (method === "keepalive" || method === "keepalived") rateMethod = "keepalive";

        if (rateMethod && !consumeRpcRateLimit(rateMethod, ip, timeNow)) {
            sendReplyFinal("Rate limit exceeded for " + rateMethod + " requests");
            return;
        }

        switch (method) {
        case "mining.authorize":
            if (!params || !(params instanceof Array)) {
                sendReplyFinal("No array params specified");
                return;
            }
            const authorizeAlgoState = getAuthorizeAlgoState(portData.port);
            params = {
                login: params[0],
                pass: params[1],
                agent: socket.eth_agent ? socket.eth_agent : "[generic_ethminer]",
                algo: authorizeAlgoState.algos,
                "algo-perf": authorizeAlgoState.algosPerf,
                "algo-min-time": authorizeAlgoState.algoMinTime
            };
        case "login": {
            if (ip in state.bannedTmpIPs) {
                sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)");
                return;
            }
            if (!params) {
                processSend({ type: "banIP", data: ip });
                sendReplyFinal("No params specified");
                return;
            }
            if (!params.login) {
                processSend({ type: "banIP", data: ip });
                sendReplyFinal("No login specified");
                return;
            }
            if (socket.miner_id && state.activeMiners.has(socket.miner_id)) {
                processSend({ type: "banIP", data: ip });
                sendReplyFinal("No double login is allowed");
                return;
            }
            if (socket.miner_id) delete socket.miner_id;

            if (!params.pass) params.pass = "x";
            const minerId = utils.getNewId();
            const miner = createMiner(
                minerId, params.login, params.pass, params.rigid, ip, portData.difficulty, pushMessage, 1, portData.portType, portData.port, params.agent,
                params.algo, params["algo-perf"], params["algo-min-time"]
            );
            if (miner.debugMiner) socket.debugMiner = 1;

            if (method === "mining.authorize") {
                const newId = Number.isInteger(socket.eth_extranonce_id)
                    ? socket.eth_extranonce_id
                    : claimEthExtranonceId(socket.eth_extranonce_preview_id);
                if (newId !== null) {
                    socket.eth_extranonce_id = newId;
                    delete socket.eth_extranonce_preview_id;
                    miner.eth_extranonce = utils.ethExtranonce(newId);
                } else {
                    miner.valid_miner = false;
                    miner.error = "Not enough extranoces. Switch to other pool node.";
                }
            }

            if (!miner.valid_miner) {
                const invalidLogKey = getInvalidMinerLogKey(miner);
                if (!(invalidLogKey in state.lastMinerLogTime) || timeNow - state.lastMinerLogTime[invalidLogKey] > 10 * 60 * 1000) {
                    console.log(state.threadName + "Invalid miner " + miner.logString + " [" + miner.email + "], disconnecting due to: " + miner.error);
                    touchTimedEntry(state.lastMinerLogTime, invalidLogKey, timeNow, retention.minerLog);
                }
                sendReplyFinal(miner.error, miner.delay_reply);
                return;
            }

            const minerAgentNotification = !global.coinFuncs.algoMainCheck(miner.algos) && global.coinFuncs.algoPrevMainCheck(miner.algos)
                ? global.coinFuncs.get_miner_agent_warning_notification(params.agent)
                : false;
            const minerNotification = minerAgentNotification || getMinerNotification(miner.payout);
            if (minerNotification && (!(miner.payout in state.lastMinerNotifyTime) || timeNow - state.lastMinerNotifyTime[miner.payout] > 60 * 60 * 1000)) {
                touchTimedEntry(state.lastMinerNotifyTime, miner.payout, timeNow, retention.minerNotify);
                console.error("Sent notification to " + miner.logString + ": " + minerNotification);
                sendReplyFinal(minerNotification + " (miner will connect after several attempts)");
                return;
            }

            if (!miner.proxy) {
                const proxyMinerName = miner.payout;
                if ((params.agent && params.agent.includes("proxy")) || (proxyMinerName in state.proxyMiners)) {
                    if (!addProxyMiner(miner)) {
                        sendReplyFinal("Temporary (one hour max) mining ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
                        return;
                    }
                    if (state.proxyMiners[proxyMinerName].hashes) adjustMinerDiff(miner);
                } else if (!(miner.payout in state.minerWallets)) {
                    state.minerWallets[miner.payout] = {
                        connectTime: Date.now(),
                        count: 1,
                        hashes: 0,
                        last_ver_shares: 0
                    };
                } else if (++state.minerWallets[miner.payout].count > global.config.pool.workerMax) {
                    state.bannedBigTmpWallets[miner.payout] = 1;
                    sendReplyFinal("Temporary (one hour max) ban on new miner connections since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
                    return;
                }
            }

            socket.miner_id = minerId;
            state.activeMiners.set(minerId, miner);
            state.activeMinerSockets.set(minerId, socket);
            if (socket.authTimer) {
                clearTimeout(socket.authTimer);
                socket.authTimer = null;
            }
            scheduleFirstShareTimer(minerId);
            const trackedAgent = normalizeTrackedAgentKey(params.agent);
            if (trackedAgent !== "" && process.env.WORKER_ID == 1) {
                touchTimedEntry(state.minerAgents, trackedAgent, timeNow, retention.minerAgents);
            }

            if (id === "Stratum") {
                sendReply(null, "ok");
                miner.protocol = "grin";
                return;
            }
            if (method === "mining.authorize") {
                sendReply(null, true);
                miner.protocol = "eth";
                miner.sendBestCoinJob();
                return;
            }

            const coin = miner.selectBestCoin();
            if (coin === false) {
                sendReplyFinal("No block template yet. Please wait.");
                miner.protocol = "default";
                return;
            }

            const jobParams = deps.getCoinJobParams(coin);
            const poolSettings = getPoolSettingsForCoin(coin);
            poolSettings.sendLoginResult({
                coin,
                jobParams,
                miner,
                minerId,
                scheduleFirstShareTimer,
                sendReply,
                sendReplyFinal,
                socket,
                utils
            });
            miner.protocol = "default";
            return;
        }

        case "mining.subscribe": {
            if (params && params instanceof Array && params.length >= 1) socket.eth_agent = params[0];
            const previewId = getEthExtranoncePreviewId(socket);
            if (previewId !== null) {
                sendReply(null, [["mining.notify", utils.getNewId(), "EthereumStratum/1.0.0"], utils.ethExtranonce(previewId), 6]);
            } else {
                sendReplyFinal("Not enough extranoces. Switch to other pool node.");
            }
            return;
        }

        case "mining.extranonce.subscribe":
            sendReply(null, true);
            return;

        case "getjobtemplate": {
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
            return;
        }

        case "getjob": {
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
            return;
        }

        case "mining.submit":
            if (!params || !(params instanceof Array)) {
                sendReply("No array params specified");
                return;
            }
            for (const param of params) {
                if (typeof param !== "string") {
                    sendReply("Not correct params specified");
                    return;
                }
            }
            if (params.length >= 3) {
                params = { job_id: params[1], raw_params: params };
            } else {
                sendReply("Not correct params specified");
                return;
            }
        case "submit": {
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            const minerId = params.id ? params.id : (socket.miner_id ? socket.miner_id : "");
            const miner = state.activeMiners.get(minerId);
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return;
            }
            if (typeof params.job_id === "number") params.job_id = params.job_id.toString();

            const job = miner.validJobs.toarray().filter(function findJob(candidate) {
                return candidate.id === params.job_id;
            })[0];
            if (!job) {
                if (!miner.hasSubmittedValidShare) {
                    miner.invalidJobIdCount = (miner.invalidJobIdCount || 0) + 1;
                    if (miner.invalidJobIdCount >= getPoolSecurityConfig().invalidJobIdLimitBeforeShare) {
                        removeMiner(miner, { reason: "invalid-job-id-limit", destroySocket: false });
                        sendReply("Invalid job id");
                        closeSocketAfterReply();
                        return;
                    }
                }
                sendReply("Invalid job id");
                return;
            }
            if (!miner.hasSubmittedValidShare && miner.invalidJobIdCount > 0) miner.invalidJobIdCount = 0;
            miner.touchProtocolActivity();

            const blobTypeNum = job.blob_type_num;
            const poolSettings = getPoolSettingsForJob(job);
            if (method === "mining.submit") {
                if (!poolSettings.parseMiningSubmitParams({ params })) {
                    sendReply("Invalid job params");
                    return;
                }
            }

            const isNonceValid = poolSettings.validateSubmitParams({
                blobTypeNum,
                coinFuncs: global.coinFuncs,
                job,
                miner,
                normalizeExtraNonceSubmitNonce,
                params,
                state
            });

            if (!isNonceValid) {
                console.warn(state.threadName + "Malformed nonce: " + JSON.stringify(params) + " from " + miner.logString);
                const banned = miner.checkBan(false);
                sendReply("Duplicate share");
                if (banned) closeSocketAfterReply();
                miner.storeInvalidShare();
                return;
            }

            let nonceTest;
            if (miner.proxy) {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(state.threadName + "Malformed nonce: " + JSON.stringify(params) + " from " + miner.logString);
                    const banned = miner.checkBan(false);
                    sendReply("Duplicate share");
                    if (banned) closeSocketAfterReply();
                    miner.storeInvalidShare();
                    return;
                }
            }
            nonceTest = poolSettings.submissionKey({
                miner,
                params
            });

            let blockTemplate;
            job.rewarded_difficulty = job.difficulty;
            if (state.activeBlockTemplates[job.coin].idHash !== job.blockHash) {
                blockTemplate = state.pastBlockTemplates[job.coin].toarray().filter(function findPastTemplate(template) {
                    return template.idHash === job.blockHash;
                })[0];
                let isOutdated = false;
                if (blockTemplate && blockTemplate.timeoutTime) {
                    const lateTime = Date.now() - blockTemplate.timeoutTime;
                    if (lateTime > 0) {
                        const maxLateTime = global.config.pool.targetTime * 1000;
                        if (lateTime < maxLateTime) {
                            const factor = (maxLateTime - lateTime) / maxLateTime;
                            job.rewarded_difficulty = job.difficulty * Math.pow(factor, 6);
                        } else {
                            isOutdated = true;
                        }
                    }
                }
                if (!blockTemplate || isOutdated) {
                    const errStr = blockTemplate ? "Block outdated" : "Block expired";
                    const timeNow = Date.now();
                    if (!(miner.payout in state.lastMinerLogTime) || timeNow - state.lastMinerLogTime[miner.payout] > 30 * 1000) {
                        console.warn(state.threadName + errStr + ", Height: " + job.height + " (diff " + job.difficulty + ") from " + miner.logString);
                        touchTimedEntry(state.lastMinerLogTime, miner.payout, timeNow, retention.minerLog);
                    }
                    miner.sendSameCoinJob();
                    const banned = miner.checkBan(false);
                    sendReply(errStr);
                    if (banned) closeSocketAfterReply();
                    miner.storeInvalidShare();
                    return;
                }
            } else {
                blockTemplate = state.activeBlockTemplates[job.coin];
                if (!state.lastCoinHashFactorMM[job.coin] && Date.now() - blockTemplate.timeCreated > 60 * 60 * 1000) {
                    sendReplyFinal("This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.");
                    return;
                }
            }

            const trackSharedTemplateNonceForShare = shouldTrackSharedTemplateNonce(job);
            if (trackSharedTemplateNonceForShare && hasTrackedSharedTemplateNonce(blockTemplate, params.nonce)) {
                console.warn(state.threadName + "Duplicate template nonce " + params.nonce + " from " + miner.logString);
                const banned = miner.checkBan(false);
                sendReply("Duplicate share");
                if (banned) closeSocketAfterReply();
                miner.storeInvalidShare();
                return;
            }

            const shareWindowThrottled = willShareBeThrottled(miner);
            if (!shareWindowThrottled) {
                const submissions = getJobSubmissions(job);
                if (submissions.has(nonceTest)) {
                    console.warn(state.threadName + "Duplicate miner share with " + nonceTest + " nonce from " + miner.logString);
                    const banned = miner.checkBan(false);
                    sendReply("Duplicate share");
                    if (banned) closeSocketAfterReply();
                    miner.storeInvalidShare();
                    return;
                }
                if (hasReachedSubmissionLimit(job, miner)) {
                    console.warn(state.threadName + "Rejected share after " + submissions.size + " tracked nonces for current job from " + miner.logString);
                    sendReply("Too many share submissions for the current job. Wait for a new job.");
                    return;
                }
            }
            if (trackSharedTemplateNonceForShare) trackSharedTemplateNonce(blockTemplate, params.nonce);
            if (!shareWindowThrottled) trackJobSubmission(job, nonceTest);

            job.rewarded_difficulty2 = job.rewarded_difficulty * job.coinHashFactor;
            shareProcessor.processShare(miner, job, blockTemplate, params, function onShareProcessed(shareAccepted) {
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
                        debug(state.threadName + "Share trust broken by " + miner.logString);
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
            });
            return;
        }

        case "keepalive":
        case "keepalived": {
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
            return;
        }

        default:
            handleUnknownMethod();
            return;
        }
    };
};
