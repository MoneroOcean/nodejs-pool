"use strict";

// Miner construction stays here so protocol handling only needs to ask for a
// validated session object and can ignore the login parsing details.
module.exports = function createMinerFactory(deps) {
    const { debug, state, retention, touchTimedEntry, utils, attachMinerJobMethods, getCoinJobParams, processSend, removeMiner } = deps;

    const reEmail = /^\S+@\S+\.\S+$/;
    const COINS = global.coinFuncs.getCOINS();

    function buildInitialAlgoState(agent, passAlgoSplit, algos, algosPerf, algoMinTime) {
        if (passAlgoSplit.length === 2) {
            const algoName = passAlgoSplit[1];
            return {
                algos: [algoName],
                algosPerf: { [algoName]: 1 },
                algoMinTime: 60
            };
        }

        if (algos && Array.isArray(algos) && global.config.daemon.enableAlgoSwitching) {
            return { algos, algosPerf, algoMinTime };
        }

        const agentAlgo = global.coinFuncs.get_miner_agent_not_supported_algo(agent);
        return {
            algos: agentAlgo ? [agentAlgo] : global.coinFuncs.getDefaultAlgos(),
            algosPerf: global.coinFuncs.getDefaultAlgosPerf(),
            algoMinTime: 60
        };
    }

    function createMiner(id, login, pass, rigid, ipAddress, startingDiff, pushMessage, protoVersion, portType, port, agent, algos, algosPerf, algoMinTime) {
        const miner = {};
        if (typeof agent === "string" && agent.length > retention.minerAgents.maxKeyLength) {
            agent = agent.substring(0, retention.minerAgents.maxKeyLength);
        }
        const loginDiffSplit = login.split("+");
        const loginDivSplit = loginDiffSplit[0].split("%");
        const loginPaymentIdSplit = loginDivSplit[0].split(".");
        const passAlgoSplit = pass.split("~");
        let passSplit = passAlgoSplit[0].split(":");

        if (passSplit.length === 1 && reEmail.test(passSplit[0])) {
            passSplit.push(passSplit[0]);
            passSplit[0] = "email";
        }

        miner.payout = miner.address = (passSplit.length === 3 ? passSplit[2] : loginPaymentIdSplit[0]);
        miner.paymentID = null;
        miner.identifier = agent && agent.includes("MinerGate") ? "MinerGate" : (rigid ? rigid : passSplit[0]).substring(0, 64);
        if (typeof loginPaymentIdSplit[1] !== "undefined") {
            if (loginPaymentIdSplit[1].length === 64 && state.hexMatch.test(loginPaymentIdSplit[1]) && global.coinFuncs.validatePlainAddress(miner.address)) {
                miner.paymentID = loginPaymentIdSplit[1];
                miner.payout += "." + miner.paymentID;
                if (typeof loginPaymentIdSplit[2] !== "undefined" && miner.identifier === "x") {
                    miner.identifier = loginPaymentIdSplit[2].substring(0, 64);
                }
            } else if (miner.identifier === "x") {
                miner.identifier = loginPaymentIdSplit[1].substring(0, 64);
            }
        }

        miner.debugMiner = miner.payout in state.walletDebug;
        miner.whiteList = ipAddress in state.ipWhitelist;
        miner.email = passSplit.length >= 2 ? passSplit[1] : "";
        miner.logString = miner.payout.substr(miner.payout.length - 10) + ":" + miner.identifier + " (" + ipAddress + ")";
        miner.agent = agent;

        if (loginDiffSplit.length > 2) {
            miner.error = "Please use monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number] login/user format";
            miner.valid_miner = false;
            return miner;
        }
        if (Math.abs(loginDivSplit.length % 2) === 0 || loginDivSplit.length > 5) {
            miner.error = "Please use monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number] login/user format";
            miner.valid_miner = false;
            return miner;
        }

        miner.payout_div = {};
        let payoutPercentLeft = 100;
        for (let index = 1; index < loginDivSplit.length - 1; index += 2) {
            const percent = parseFloat(loginDivSplit[index]);
            const address = loginDivSplit[index + 1];
            if (isNaN(percent) || percent < 0.1) {
                miner.error = "Your payment divide split " + percent + " is below 0.1% and can't be processed";
                miner.valid_miner = false;
                return miner;
            }
            if (percent > 99.9) {
                miner.error = "Your payment divide split " + percent + " is above 99.9% and can't be processed";
                miner.valid_miner = false;
                return miner;
            }
            payoutPercentLeft -= percent;
            if (payoutPercentLeft < 0.1) {
                miner.error = "Your summary payment divide split exceeds 99.9% and can't be processed";
                miner.valid_miner = false;
                return miner;
            }
            if (address.length !== 95 || !global.coinFuncs.validateAddress(address)) {
                miner.error = "Invalid payment address provided: " + address + ". Please use 95_char_long_monero_wallet_address format";
                miner.valid_miner = false;
                return miner;
            }
            if (address in state.bannedAddresses) {
                miner.error = "Permanently banned payment address " + address + " provided: " + state.bannedAddresses[address];
                miner.valid_miner = false;
                return miner;
            }
            if (address in state.bannedTmpWallets) {
                miner.error = "Temporary (10 minutes max) banned payment address " + address;
                miner.valid_miner = false;
                return miner;
            }
            if (address in state.bannedBigTmpWallets) {
                miner.error = "Temporary (one hour max) ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)";
                miner.valid_miner = false;
                miner.delay_reply = 600;
                return miner;
            }
            if (address in miner.payout_div) {
                miner.error = "You can't repeat payment split address " + address;
                miner.valid_miner = false;
                return miner;
            }
            miner.payout_div[address] = percent;
        }

        if (payoutPercentLeft === 100) {
            miner.payout_div = null;
        } else {
            if (miner.payout in miner.payout_div) {
                miner.error = "You can't repeat payment split address " + miner.payout;
                miner.valid_miner = false;
                return miner;
            }
            miner.payout_div[miner.payout] = payoutPercentLeft;
        }

        if (passSplit.length > 3) {
            miner.error = "Please use worker_name[:email_or_pass[:monero_address]][~algo_name] password format";
            miner.valid_miner = false;
            return miner;
        }
        if (miner.payout in state.bannedAddresses) {
            miner.error = "Permanently banned payment address " + miner.payout + " provided: " + state.bannedAddresses[miner.payout];
            miner.valid_miner = false;
            return miner;
        }
        if (miner.payout in state.bannedTmpWallets) {
            miner.error = "Temporary (10 minutes max) banned payment address " + miner.payout;
            miner.valid_miner = false;
            return miner;
        }
        if (miner.payout in state.bannedBigTmpWallets) {
            miner.error = "Temporary (one hour max) ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)";
            miner.valid_miner = false;
            miner.delay_reply = 600;
            return miner;
        }
        if (global.coinFuncs.exchangeAddresses.indexOf(miner.address) !== -1 && !miner.paymentID) {
            miner.error = "Exchange addresses need 64 hex character long payment IDs. Please specify it after your wallet address as follows after dot: Wallet.PaymentID";
            miner.valid_miner = false;
            return miner;
        }
        if (!global.coinFuncs.validateAddress(miner.address)) {
            miner.error = "Invalid payment address provided: " + miner.address + ". Please use 95_char_long_monero_wallet_address format";
            miner.valid_miner = false;
            return miner;
        }
        if (!("" in state.activeBlockTemplates)) {
            miner.error = "No active block template";
            miner.valid_miner = false;
            return miner;
        }

        miner.setAlgos = function setAlgos(nextAlgos, nextAlgosPerf, nextAlgoMinTime) {
            miner.algos = {};
            for (const algo of nextAlgos) miner.algos[algo] = 1;
            if (global.coinFuncs.is_miner_agent_no_haven_support(miner.agent)) delete miner.algos["cn-heavy/xhv"];
            if (miner.algos.kawpow4) {
                miner.algos.kawpow = 1;
                delete miner.algos.kawpow4;
            }
            const check = global.coinFuncs.algoCheck(miner.algos);
            if (check !== true) return check;
            if ("cn-pico" in miner.algos) miner.algos["cn-pico/trtl"] = 1;

            if (!(nextAlgosPerf && nextAlgosPerf instanceof Object)) {
                nextAlgosPerf = global.coinFuncs.algoMainCheck(miner.algos) ? global.coinFuncs.getDefaultAlgosPerf() : global.coinFuncs.getPrevAlgosPerf();
            }

            const coinPerf = global.coinFuncs.convertAlgosToCoinPerf(nextAlgosPerf);
            if (!(coinPerf instanceof Object)) return coinPerf;
            if (!("" in coinPerf && global.coinFuncs.algoMainCheck(miner.algos))) coinPerf[""] = -1;
            miner.coin_perf = coinPerf;
            miner.algo_min_time = nextAlgoMinTime ? nextAlgoMinTime : 60;
            return "";
        };

        const initialAlgoState = buildInitialAlgoState(agent, passAlgoSplit, algos, algosPerf, algoMinTime);
        const status = miner.setAlgos(initialAlgoState.algos, initialAlgoState.algosPerf, initialAlgoState.algoMinTime);
        if (status !== "") {
            miner.error = status;
            miner.valid_miner = false;
            return miner;
        }

        miner.error = "";
        miner.valid_miner = true;
        miner.removed_miner = false;
        miner.proxy = agent && agent.includes("xmr-node-proxy");
        miner.xmrig_proxy = agent && agent.includes("xmrig-proxy");
        miner.id = id;
        miner.ipAddress = ipAddress;
        miner.pushMessage = pushMessage;
        miner.connectTime = Date.now();
        miner.lastSocketActivity = miner.connectTime;
        miner.lastProtocolActivity = miner.connectTime;
        miner.lastValidShareTimeMs = 0;
        miner.hasSubmittedValidShare = false;
        miner.acceptedShareCount = 0;
        miner.invalidJobIdCount = 0;
        miner.touchSocketActivity = function touchSocketActivity(timeNow) {
            miner.lastSocketActivity = typeof timeNow === "number" ? timeNow : Date.now();
        };
        miner.touchProtocolActivity = function touchProtocolActivity(timeNow) {
            const nextTime = typeof timeNow === "number" ? timeNow : Date.now();
            miner.lastProtocolActivity = nextTime;
            miner.lastContact = nextTime;
        };
        miner.touchValidShare = function touchValidShare(timeNow) {
            const nextTime = typeof timeNow === "number" ? timeNow : Date.now();
            miner.hasSubmittedValidShare = true;
            ++miner.acceptedShareCount;
            miner.lastValidShareTimeMs = nextTime;
            miner.lastContact = nextTime;
        };
        miner.heartbeat = function heartbeat() {
            miner.touchProtocolActivity();
        };
        miner.heartbeat();
        miner.port = port;
        miner.portType = portType;

        switch (portType) {
        case "pplns": miner.poolTypeEnum = global.protos.POOLTYPE.PPLNS; break;
        case "pps": miner.poolTypeEnum = global.protos.POOLTYPE.PPS; break;
        case "solo": miner.poolTypeEnum = global.protos.POOLTYPE.SOLO; break;
        case "prop": miner.poolTypeEnum = global.protos.POOLTYPE.PROP; break;
        default:
            console.error("Wrong portType " + portType);
            miner.poolTypeEnum = global.protos.POOLTYPE.PPLNS;
        }

        miner.wallet_key = miner.payout + " " + miner.poolTypeEnum + " " + JSON.stringify(miner.payout_div) + " ";
        miner.lastShareTime = Math.floor(Date.now() / 1000);
        miner.validShares = 0;
        miner.invalidShares = 0;
        miner.hashes = 0;

        if (global.config.pool.trustedMiners) {
            miner.trust = { trust: 0, check_height: 0 };
        }

        const email = miner.email.trim();
        if (email !== "") {
            const payoutAddress = miner.payout;
            const timeNow = Date.now();
            if (!(payoutAddress in state.walletLastCheckTime) || timeNow - state.walletLastCheckTime[payoutAddress] > 60 * 1000) {
                global.mysql.query("SELECT id FROM users WHERE username = ? LIMIT 1", [payoutAddress]).then(function ensureUser(rows) {
                    if (rows.length > 0 || global.coinFuncs.blockedAddresses.indexOf(payoutAddress) !== -1) return;
                    global.mysql.query("INSERT INTO users (username, email) VALUES (?, ?)", [payoutAddress, email]).catch(function onInsertError(error) {
                        console.error("SQL query failed: " + error);
                    });
                    console.log("Setting password " + email + " for " + payoutAddress);
                }).catch(function onSelectError(error) {
                    console.error("SQL query failed: " + error);
                });
                touchTimedEntry(state.walletLastCheckTime, payoutAddress, timeNow, retention.walletCheck);
            }
        }

        miner.validJobs = global.support.circularBuffer(10);
        miner.cachedJob = null;
        miner.storeInvalidShare = function storeInvalidShare() {
            const timeNow = Date.now();
            miner.invalidShareCount = miner.invalidShareCount ? miner.invalidShareCount + 1 : 1;
            if (!miner.lastInvalidShareTime || timeNow - miner.lastInvalidShareTime > 10 * 60 * 1000) {
                global.database.storeInvalidShare(global.protos.InvalidShare.encode({
                    paymentAddress: miner.address,
                    paymentID: miner.paymentID,
                    identifier: miner.identifier,
                    count: miner.invalidShareCount
                }));
                miner.lastInvalidShareTime = timeNow;
                miner.invalidShareCount = 0;
            }
        };

        miner.setNewDiff = function setNewDiff(difficulty) {
            if (miner.fixed_diff) return false;
            miner.newDiffRecommendation = difficulty;
            const ratio = Math.abs(difficulty - miner.difficulty) / miner.difficulty;
            if (ratio < 0.2) return false;
            miner.newDiffToSet = difficulty;
            debug(state.threadName + "Difficulty change to: " + miner.newDiffToSet + " For: " + miner.logString);
            if (miner.hashes > 0) {
                const seconds = Math.floor((Date.now() - miner.connectTime) / 1000);
                const hashesPerSecond = Math.floor(miner.hashes / seconds);
                debug(state.threadName + "Hashes: " + miner.hashes + " in: " + seconds + " seconds gives: " + hashesPerSecond + " hashes/second or: " +
                    hashesPerSecond * global.config.pool.targetTime + " difficulty versus: " + miner.newDiffToSet);
            }
            return true;
        };

        miner.selectBestCoin = function selectBestCoin() {
            if (miner.debugMiner) console.log(state.threadName + miner.logString + " [WALLET DEBUG] current coin is " + miner.curr_coin);
            if (typeof miner.curr_coin !== "undefined" && miner.curr_coin_time && state.lastCoinHashFactorMM[miner.curr_coin] &&
                Date.now() - miner.curr_coin_time < miner.algo_min_time * 1000) {
                return miner.curr_coin;
            }

            let bestCoin = "";
            let bestCoinPerf = miner.coin_perf[""] * 1.1;
            COINS.forEach(function considerCoin(coin) {
                if (!(coin in miner.coin_perf) || !(coin in state.activeBlockTemplates)) return;
                const coinHashFactor = state.lastCoinHashFactorMM[coin];
                if (!coinHashFactor) return;
                const bt = state.activeBlockTemplates[coin];
                const algo = global.coinFuncs.algoShortTypeStr(bt.port, bt.block_version);
                if (miner.difficulty / coinHashFactor > bt.difficulty * 3) return;
                if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) return;
                let coinPerf = miner.coin_perf[coin] * coinHashFactor;
                if (miner.curr_coin === coin) coinPerf *= 1.05;
                if (miner.debugMiner) console.log(state.threadName + miner.logString + " [WALLET DEBUG] " + coin + ": " + coinPerf);
                if (coinPerf > bestCoinPerf) {
                    bestCoin = coin;
                    bestCoinPerf = coinPerf;
                }
            });

            if (bestCoinPerf < 0) return false;
            if (typeof miner.curr_coin === "undefined" || miner.curr_coin !== bestCoin) {
                const blobTypeNum = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(bestCoin));
                if (global.coinFuncs.blobTypeGrin(blobTypeNum)) miner.curr_coin_min_diff = 1;
                else if (global.coinFuncs.blobTypeRvn(blobTypeNum)) miner.curr_coin_min_diff = 0.01;
                else if (global.coinFuncs.blobTypeEth(blobTypeNum) || global.coinFuncs.blobTypeErg(blobTypeNum)) miner.curr_coin_min_diff = 0.01 * 0x100000000;
                else miner.curr_coin_min_diff = global.config.pool.minDifficulty;
                miner.curr_coin = bestCoin;
                miner.curr_coin_hash_factor = state.lastCoinHashFactorMM[bestCoin];
                miner.curr_coin_time = Date.now();
                if (global.config.pool.trustedMiners) miner.trust.check_height = state.activeBlockTemplates[bestCoin].height;
            }
            return bestCoin;
        };

        miner.fixed_diff = false;
        miner.difficulty = startingDiff;
        if (loginDiffSplit.length === 2) {
            miner.fixed_diff = true;
            if (loginDiffSplit[1].substring(0, 4) === "perf") {
                let perfDiff = 0;
                if (miner.coin_perf[""] > 2) perfDiff = Math.floor(miner.coin_perf[""] * (global.config.pool.targetTime || 30));
                if (loginDiffSplit[1].substring(4, 8) === "auto" || perfDiff === 0) miner.fixed_diff = false;
                miner.difficulty = perfDiff || startingDiff;
            } else {
                miner.difficulty = Number(loginDiffSplit[1]);
            }
            if (miner.difficulty < global.config.pool.minDifficulty) miner.difficulty = global.config.pool.minDifficulty;
            if (miner.difficulty > global.config.pool.maxDifficulty) miner.difficulty = global.config.pool.maxDifficulty;
        }

        miner.curr_coin_hash_factor = 1;
        miner.curr_coin_min_diff = global.config.pool.minDifficulty;
        miner.curr_coin = miner.selectBestCoin();

        if (agent && agent.includes("NiceHash")) {
            miner.fixed_diff = true;
            const blobTypeNum = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(miner.curr_coin));
            const minNiceHashDiff = (global.coinFuncs.blobTypeRvn(blobTypeNum) || global.coinFuncs.blobTypeEth(blobTypeNum) || global.coinFuncs.blobTypeErg(blobTypeNum))
                ? global.coinFuncs.niceHashDiff * 50
                : global.coinFuncs.niceHashDiff;
            if (miner.difficulty < minNiceHashDiff) miner.difficulty = minNiceHashDiff;
        }

        miner.calcNewDiff = function calcNewDiff() {
            const timeNow = Date.now();
            const proxyMinerName = miner.payout;
            let source;
            let target;
            let minDiff;
            let historyTime;
            const proxyMiner = state.proxyMiners[proxyMinerName];
            if (proxyMiner && proxyMiner.hashes / (timeNow - proxyMiner.connectTime) > miner.difficulty) {
                source = proxyMiner;
                target = 15;
                minDiff = 10 * global.config.pool.minDifficulty;
                historyTime = 5;
            } else if (miner.payout in state.minerWallets && state.minerWallets[miner.payout].last_ver_shares >= global.config.pool.minerThrottleSharePerSec * global.config.pool.minerThrottleShareWindow) {
                source = state.minerWallets[miner.payout];
                target = 15;
                minDiff = 10 * global.config.pool.minDifficulty;
                historyTime = 5;
            } else {
                source = miner;
                target = miner.proxy ? 15 : global.config.pool.targetTime;
                minDiff = miner.proxy ? 10 * global.config.pool.minDifficulty : global.config.pool.minDifficulty;
                historyTime = 60;
            }

            if (source.connectTimeShift) {
                const timeSinceLastShift = timeNow - source.connectTimeShift;
                const timeWindow = historyTime * 60 * 1000;
                if (timeSinceLastShift > timeWindow) {
                    if (timeSinceLastShift > 2 * timeWindow) source.hashes = 0;
                    else source.hashes -= source.hashesShift;
                    source.connectTime = source.connectTimeShift;
                    source.connectTimeShift = timeNow;
                    source.hashesShift = source.hashes;
                }
            } else {
                source.connectTimeShift = timeNow;
                source.hashesShift = source.hashes;
            }

            let hashes = source.hashes;
            let period = (timeNow - source.connectTime) / 1000;
            if (hashes === 0) {
                hashes = miner.difficulty;
                target = 2 * global.config.pool.retargetTime;
                if (period < target) period = target;
            }
            const diff = hashes * target / period;
            return diff < minDiff ? minDiff : diff;
        };

        miner.checkBan = function checkBan(validShare) {
            if (!global.config.pool.banEnabled || miner.whiteList) return false;
            if (validShare) ++miner.validShares;
            else {
                ++miner.invalidShares;
                if (miner.validShares === 0) {
                    console.error(state.threadName + "Suspended miner IP for submitting bad share with zero trust " + miner.logString);
                    removeMiner(miner, { destroySocket: false });
                    processSend({ type: "banIP", data: miner.ipAddress, wallet: miner.payout });
                    return true;
                }
            }
            const shareCount = miner.validShares + miner.invalidShares;
            if (shareCount >= global.config.pool.banThreshold) {
                if (100 * miner.invalidShares / shareCount >= global.config.pool.banPercent) {
                    console.error(state.threadName + "Suspended miner IP for submitting too many bad shares recently " + miner.logString);
                    removeMiner(miner, { destroySocket: false });
                    processSend({ type: "banIP", data: miner.ipAddress, wallet: miner.payout });
                    return true;
                } else {
                    miner.invalidShares = 0;
                    miner.validShares = 0;
                }
            }
            return false;
        };

        attachMinerJobMethods(miner, {
            protoVersion,
            getCoinJobParams,
            getNewId: utils.getNewId,
            getNewEthJobId: utils.getNewEthJobId,
            getTargetHex: utils.getTargetHex,
            getRavenTargetHex: utils.ravenTargetHex,
            toBigInt: utils.toBigInt,
            divideBaseDiff: utils.divideBaseDiff
        });

        return miner;
    }

    return {
        createMiner
    };
};
