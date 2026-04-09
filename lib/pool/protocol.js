"use strict";

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
        processSend
    } = deps;

    function getMinerNotification(payout) {
        return payout in state.notifyAddresses ? state.notifyAddresses[payout] : false;
    }

    function getInvalidMinerLogKey(ip) {
        return "invalid-login:" + ip;
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

    function getTrackedSubmissionLimit() {
        return global.config.pool.minerThrottleShareWindow * global.config.pool.minerThrottleSharePerSec * 100;
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

    function hasReachedSubmissionLimit(job) {
        return getJobSubmissions(job).size >= getTrackedSubmissionLimit();
    }

    return function handleMinerData(socket, id, method, params, ip, portData, sendReply, sendReplyFinal, pushMessage) {
        switch (method) {
        case "mining.authorize":
            if (!params || !(params instanceof Array)) {
                sendReplyFinal("No array params specified");
                return;
            }
            params = {
                login: params[0],
                pass: params[1],
                agent: socket.eth_agent ? socket.eth_agent : "[generic_ethminer]",
                algo: ["kawpow"],
                "algo-perf": { kawpow: 1 }
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
            if (socket.miner_id) {
                processSend({ type: "banIP", data: ip });
                sendReplyFinal("No double login is allowed");
                return;
            }

            if (!params.pass) params.pass = "x";
            const minerId = utils.getNewId();
            const miner = createMiner(
                minerId, params.login, params.pass, params.rigid, ip, portData.difficulty, pushMessage, 1, portData.portType, portData.port, params.agent,
                params.algo, params["algo-perf"], params["algo-min-time"]
            );
            if (miner.debugMiner) socket.debugMiner = 1;

            if (method === "mining.authorize") {
                const newId = socket.eth_extranonce_id ? socket.eth_extranonce_id : utils.getNewEthExtranonceId();
                if (newId !== null) {
                    socket.eth_extranonce_id = newId;
                    miner.eth_extranonce = utils.ethExtranonce(newId);
                } else {
                    miner.valid_miner = false;
                    miner.error = "Not enough extranoces. Switch to other pool node.";
                }
            }

            const timeNow = Date.now();
            if (!miner.valid_miner) {
                const invalidLogKey = getInvalidMinerLogKey(ip);
                if (!(invalidLogKey in state.lastMinerLogTime) || timeNow - state.lastMinerLogTime[invalidLogKey] > 10 * 60 * 1000) {
                    console.log("Invalid miner " + miner.logString + " [" + miner.email + "], disconnecting due to: " + miner.error);
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
            const blobTypeNum = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(coin));
            if (global.coinFuncs.blobTypeRvn(blobTypeNum) || global.coinFuncs.blobTypeEth(blobTypeNum) || global.coinFuncs.blobTypeErg(blobTypeNum)) {
                const newId = socket.eth_extranonce_id ? socket.eth_extranonce_id : utils.getNewEthExtranonceId();
                if (newId !== null) {
                    socket.eth_extranonce_id = newId;
                    miner.eth_extranonce = utils.ethExtranonce(newId);
                    sendReply(null, { id: minerId, algo: jobParams.algo_name, extra_nonce: miner.eth_extranonce });
                    miner.sendCoinJob(coin, jobParams);
                } else {
                    sendReplyFinal("Not enough extranoces. Switch to other pool node.");
                }
            } else if (global.coinFuncs.blobTypeXTM_C(blobTypeNum)) {
                const newId = socket.eth_extranonce_id ? socket.eth_extranonce_id : utils.getNewEthExtranonceId();
                if (newId !== null) {
                    socket.eth_extranonce_id = newId;
                    miner.eth_extranonce = utils.ethExtranonce(newId);
                    const job = miner.getCoinJob(coin, jobParams);
                    job.xn = miner.eth_extranonce;
                    sendReply(null, { id: minerId, job, status: "OK" });
                } else {
                    sendReplyFinal("Not enough extranoces. Switch to other pool node.");
                }
            } else {
                sendReply(null, { id: minerId, job: miner.getCoinJob(coin, jobParams), status: "OK" });
            }
            miner.protocol = "default";
            return;
        }

        case "mining.subscribe": {
            if (params && params instanceof Array && params.length >= 1) socket.eth_agent = params[0];
            const newId = socket.eth_extranonce_id ? socket.eth_extranonce_id : utils.getNewEthExtranonceId();
            if (newId !== null) {
                socket.eth_extranonce_id = newId;
                sendReply(null, [["mining.notify", utils.getNewId(), "EthereumStratum/1.0.0"], utils.ethExtranonce(newId), 6]);
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
            miner.heartbeat();
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
            miner.heartbeat();
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
            miner.heartbeat();
            if (typeof params.job_id === "number") params.job_id = params.job_id.toString();

            const job = miner.validJobs.toarray().filter(function findJob(candidate) {
                return candidate.id === params.job_id;
            })[0];
            if (!job) {
                sendReply("Invalid job id");
                return;
            }

            const blobTypeNum = job.blob_type_num;
            if (method === "mining.submit") {
                if (global.coinFuncs.blobTypeEth(blobTypeNum) || global.coinFuncs.blobTypeErg(blobTypeNum)) {
                    params.nonce = params.raw_params[2];
                } else if (global.coinFuncs.blobTypeRvn(blobTypeNum) && params.raw_params.length >= 5) {
                    params.nonce = params.raw_params[2].substr(2);
                    params.header_hash = params.raw_params[3].substr(2);
                    params.mixhash = params.raw_params[4].substr(2);
                } else {
                    sendReply("Invalid job params");
                    return;
                }
            }

            const isNonceValid = (function nonceSanityCheck() {
                if (global.coinFuncs.blobTypeGrin(blobTypeNum)) {
                    if (global.coinFuncs.blobTypeXTM_C(blobTypeNum)) {
                        if (!state.nonceCheck64.test(params.nonce) || !params.nonce.toLowerCase().startsWith(miner.eth_extranonce)) return false;
                    } else if (typeof params.nonce !== "number") {
                        return false;
                    }
                    return params.pow instanceof Array && params.pow.length === global.coinFuncs.c29ProofSize(blobTypeNum);
                }

                if (typeof params.nonce !== "string") return false;
                if (global.coinFuncs.nonceSize(blobTypeNum) == 8) {
                    const isExtraNonceBT = global.coinFuncs.blobTypeEth(blobTypeNum) || global.coinFuncs.blobTypeErg(blobTypeNum);
                    if (isExtraNonceBT) params.nonce = job.extraNonce + params.nonce;
                    if (!state.nonceCheck64.test(params.nonce)) return false;
                    if (global.coinFuncs.blobTypeRvn(blobTypeNum)) {
                        return state.hashCheck32.test(params.mixhash) && state.hashCheck32.test(params.header_hash);
                    }
                    return isExtraNonceBT || state.hashCheck32.test(params.result);
                }
                return state.nonceCheck32.test(params.nonce) && state.hashCheck32.test(params.result);
            }());

            if (!isNonceValid) {
                console.warn(state.threadName + "Malformed nonce: " + JSON.stringify(params) + " from " + miner.logString);
                miner.checkBan(false);
                sendReply("Duplicate share");
                miner.storeInvalidShare();
                return;
            }

            let nonceTest;
            if (miner.proxy) {
                if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
                    console.warn(state.threadName + "Malformed nonce: " + JSON.stringify(params) + " from " + miner.logString);
                    miner.checkBan(false);
                    sendReply("Duplicate share");
                    miner.storeInvalidShare();
                    return;
                }
                nonceTest = global.coinFuncs.blobTypeGrin(blobTypeNum) ? params.pow.join(":") + `_${params.poolNonce}_${params.workerNonce}` : `${params.nonce}_${params.poolNonce}_${params.workerNonce}`;
            } else {
                nonceTest = global.coinFuncs.blobTypeGrin(blobTypeNum) ? params.pow.join(":") : params.nonce;
            }

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
                    sendReply(errStr);
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

            if (!willShareBeThrottled(miner)) {
                const submissions = getJobSubmissions(job);
                if (submissions.has(nonceTest)) {
                    console.warn(state.threadName + "Duplicate miner share with " + nonceTest + " nonce from " + miner.logString);
                    miner.checkBan(false);
                    sendReply("Duplicate share");
                    miner.storeInvalidShare();
                    return;
                }
                if (hasReachedSubmissionLimit(job)) {
                    console.warn(state.threadName + "Rejected share after " + submissions.size + " tracked nonces for current job from " + miner.logString);
                    sendReply("Too many share submissions for the current job. Wait for a new job.");
                    return;
                }
                trackJobSubmission(job, nonceTest);
            }

            job.rewarded_difficulty2 = job.rewarded_difficulty * job.coinHashFactor;
            shareProcessor.processShare(miner, job, blockTemplate, params, function onShareProcessed(shareAccepted) {
                if (miner.removed_miner) return;
                if (shareAccepted === null) {
                    sendReply("Throttled down share submission (please increase difficulty)");
                    return;
                }
                miner.checkBan(shareAccepted);

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
                    return;
                }

                miner.lastShareTime = Date.now() / 1000 || 0;
                if (miner.protocol === "grin") sendReply(null, "ok");
                else if (global.coinFuncs.blobTypeRvn(blobTypeNum) || global.coinFuncs.blobTypeEth(blobTypeNum) || global.coinFuncs.blobTypeErg(blobTypeNum) || global.coinFuncs.blobTypeXTM_C(blobTypeNum)) sendReply(null, true);
                else sendReply(null, { status: "OK" });
            });
            return;
        }

        case "keepalive":
        case "keepalived": {
            if (!params) {
                sendReplyFinal("No params specified");
                return;
            }
            const miner = state.activeMiners.get(params.id ? params.id : (socket.miner_id ? socket.miner_id : ""));
            if (!miner) {
                sendReplyFinal("Unauthenticated");
                return;
            }
            miner.heartbeat();
            sendReply(null, { status: "KEEPALIVED" });
            return;
        }
        }
    };
};
