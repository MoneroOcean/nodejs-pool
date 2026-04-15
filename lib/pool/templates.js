"use strict";

// Template management owns daemon polling, block-template normalization, and
// fan-out of template/hash-factor updates to connected miners. Keeping this
// logic isolated makes the pool entrypoint easier to read and keeps the data
// flow around active templates explicit.
module.exports = function createTemplateManager(deps) {
    const {
        cluster,
        debug,
        daemonPollMs,
        coins,
        activeMiners,
        activeBlockTemplates,
        pastBlockTemplates,
        lastBlockHash,
        lastBlockHeight,
        lastBlockHashMM,
        lastBlockHeightMM,
        lastBlockTime,
        lastBlockKeepTime,
        lastBlockReward,
        newCoinHashFactor,
        lastCoinHashFactor,
        lastCoinHashFactorMM,
        anchorState,
        sendToWorkers,
        getThreadName,
        formatCoinPort,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;

    function processRpcTemplate(rpcTemplate, coin, port, coinHashFactor, isHashFactorChange) {
        const template = Object.assign({}, rpcTemplate);

        template.coin = coin;
        template.port = parseInt(port);
        template.coinHashFactor = coinHashFactor;
        template.isHashFactorChange = isHashFactorChange;

        if (port in global.coinFuncs.getMM_PORTS()) {
            const childCoin = global.coinFuncs.PORT2COIN(global.coinFuncs.getMM_PORTS()[port]);
            if (childCoin in activeBlockTemplates) {
                template.child_template = activeBlockTemplates[childCoin];
                template.child_template_buffer = template.child_template.buffer;
                template.parent_blocktemplate_blob = global.coinFuncs.constructMMParentBlockBlob(
                    Buffer.from(rpcTemplate.blocktemplate_blob, "hex"),
                    port,
                    template.child_template_buffer
                ).toString("hex");
            }
        }

        return template;
    }

    // Runs only on the master thread in production. Workers reuse the same code
    // in test mode so template handling stays behavior-identical.
    function templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, bodyBt) {
        const template = processRpcTemplate(bodyBt, coin, port, coinHashFactor, isHashFactorChange);
        debug(getThreadName() + formatPoolEvent("Template update", {
            chain: formatCoinPort(coin, port),
            height: template.height
        }));
        if (cluster.isMaster) {
            sendToWorkers({ type: "newBlockTemplate", data: template });
            setNewBlockTemplate(template);

            // When a merged-mined child changes we must refresh the derived
            // parent template too, otherwise workers will mine with stale
            // parent blobs that reference the old child state.
            if (port in global.coinFuncs.getMM_CHILD_PORTS()) {
                const parentPorts = global.coinFuncs.getMM_CHILD_PORTS()[port];
                for (const parentPort in parentPorts) {
                    const parentCoin = global.coinFuncs.PORT2COIN(parentPort);
                    if (parentCoin in activeBlockTemplates) {
                        const parentTemplate = processRpcTemplate(
                            activeBlockTemplates[parentCoin],
                            parentCoin,
                            parentPort,
                            lastCoinHashFactor[parentCoin],
                            false
                        );
                        sendToWorkers({ type: "newBlockTemplate", data: parentTemplate });
                        setNewBlockTemplate(parentTemplate);
                    }
                }
            }
        } else {
            setNewBlockTemplate(template);
        }
    }

    function templateUpdate2(coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, bodyHeader, timesFailed) {
        const profile = global.coinFuncs.getPoolProfile(coin);
        if (profile && profile.rpc && profile.rpc.headerProvidesTemplate) {
            return templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, bodyHeader);
        }

        global.coinFuncs.getPortBlockTemplate(port, function (bodyBt) {
            if (!newCoinHashFactor[coin]) {
                console.log(getThreadName() + formatPoolEvent("Template fetch skipped", {
                    chain: formatCoinPort(coin, port),
                    reason: "zero-hash-factor"
                }));
                return;
            }

            if (bodyHeader.height < lastBlockHeight[coin]) {
                console.error(getThreadName() + formatPoolEvent("Template fetch ignored", {
                    chain: formatCoinPort(coin, port),
                    reason: "stale-height",
                    height: bodyHeader.height + 1,
                    needed: lastBlockHeight[coin] + 1
                }));
                return;
            }

            const auxChainXtm = bodyBt ? global.coinFuncs.getAuxChainXTM(bodyBt) : null;
            if (bodyHeader.mm && auxChainXtm) {
                if (bodyHeader.mm.height < lastBlockHeightMM[coin]) {
                    console.error(getThreadName() + formatPoolEvent("Template fetch ignored", {
                        chain: formatCoinPort(coin, port),
                        reason: "stale-mm-height",
                        mmHeight: bodyHeader.mm.height + 1,
                        needed: lastBlockHeightMM[coin] + 1
                    }));
                    return;
                }
            }

            timesFailed = timesFailed ? timesFailed : 0;
            if (!bodyBt) {
                timesFailed += 1;
                console.error(getThreadName() + formatPoolEvent("Template fetch failed", {
                    chain: formatCoinPort(coin, port),
                    attempt: timesFailed
                }));
                if (timesFailed <= 2) {
                    setTimeout(templateUpdate2, 500, coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, bodyHeader, timesFailed);
                } else {
                    coinHashFactorUpdate(coin, 0);
                }
                return;
            }

            if (!global.coinFuncs.hasTemplateBlob(bodyBt, port)) {
                timesFailed += 1;
                console.error(getThreadName() + formatPoolEvent("Template unusable", {
                    chain: formatCoinPort(coin, port),
                    attempt: timesFailed,
                    reason: "missing-mining-blob",
                    body: bodyBt
                }));
                if (timesFailed <= 2) {
                    setTimeout(templateUpdate2, 500, coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, bodyHeader, timesFailed);
                } else {
                    coinHashFactorUpdate(coin, 0);
                }
                return;
            }

            if (bodyHeader.mm && auxChainXtm) {
                if (auxChainXtm.height < bodyHeader.mm.height + 1) {
                    timesFailed += 1;
                    console.error(getThreadName() + formatPoolEvent("Template fetch stale", {
                        chain: formatCoinPort(coin, port),
                        attempt: timesFailed,
                        height: auxChainXtm.height,
                        needed: bodyHeader.mm.height + 1
                    }));
                    if (timesFailed <= 2) {
                        setTimeout(templateUpdate2, 500, coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, bodyHeader, timesFailed);
                    } else {
                        coinHashFactorUpdate(coin, 0);
                    }
                    return;
                }
            }

            const timeNow = Date.now();
            const maxBlockKeepTime = ("maxBlockKeepTime" + coin in global.config.daemon ? global.config.daemon["maxBlockKeepTime" + coin] : 60 * 60) * 1000;
            const isTimeChange = !(coin in lastBlockKeepTime) || timeNow - lastBlockKeepTime[coin] > maxBlockKeepTime;
            const isRewardCheckReady = bodyBt.expected_reward && (coin in lastBlockReward) && lastBlockReward[coin];
            const isRewardChange = isRewardCheckReady && bodyBt.expected_reward / lastBlockReward[coin] > 1.01;

            if (isHashChange || isMMHashChange || (isTimeChange && (!isRewardCheckReady || bodyBt.expected_reward !== lastBlockReward[coin])) || isRewardChange) {
                lastBlockKeepTime[coin] = timeNow;
                lastBlockReward[coin] = bodyBt.expected_reward;
                return templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, bodyBt);
            }
        });
    }

    function coinHashFactorUpdate(coin, coinHashFactor) {
        if (coin === "") return;
        if (coinHashFactor === 0 && lastCoinHashFactor[coin] === 0) return;
        if (cluster.isMaster) {
            sendToWorkers({ type: "newCoinHashFactor", data: { coin, coinHashFactor } });
        }
        setNewCoinHashFactor(true, coin, coinHashFactor);
    }

    function updateCoinHashFactor(coin) {
        const profile = global.coinFuncs.getPoolProfile(coin);
        if (profile && profile.perf && profile.perf.hashFactorDisabled) {
            coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
            return;
        }
        global.support.getCoinHashFactor(coin, function (coinHashFactor) {
            if (coinHashFactor === null) {
                console.error(getThreadName() + formatPoolEvent("Hash factor fetch failed", { chain: formatCoinPort(coin) }));
                coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
            } else if (!coinHashFactor) {
                coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
            } else {
                newCoinHashFactor[coin] = coinHashFactor;
            }
        });
    }

    function templateUpdate(coin, repeating) {
        const port = global.coinFuncs.COIN2PORT(coin);
        const coinHashFactor = newCoinHashFactor[coin];
        if (coinHashFactor) {
            global.coinFuncs.getPortLastBlockHeaderMM(port, function (err, body) {
                if (!newCoinHashFactor[coin]) {
                    console.log(getThreadName() + formatPoolEvent("Header fetch skipped", {
                        chain: formatCoinPort(coin, port),
                        reason: "zero-hash-factor"
                    }));
                    if (repeating === true) setTimeout(templateUpdate, daemonPollMs, coin, repeating);
                } else if (err === null && body.hash) {
                    const isHashFactorChange = Math.abs(lastCoinHashFactor[coin] - coinHashFactor) / coinHashFactor > 0.05;
                    const pollBlockInterval = "pollBlockInterval" + coin in global.config.daemon ? global.config.daemon["pollBlockInterval" + coin] : 60 * 60 * 1000;
                    const timeNow = Date.now();
                    const isHashChange = !(coin in lastBlockHash) || body.hash !== lastBlockHash[coin];
                    const isMMHashChange = body.mm && (!(coin in lastBlockHashMM) || body.mm.hash !== lastBlockHashMM[coin]);
                    const isTimeChange = !(coin in lastBlockTime) || timeNow - lastBlockTime[coin] > pollBlockInterval;
                    if (isHashChange || isMMHashChange || isTimeChange) {
                        lastBlockHash[coin] = body.hash;
                        lastBlockHeight[coin] = body.height;
                        if (body.mm) {
                            lastBlockHashMM[coin] = body.mm.hash;
                            lastBlockHeightMM[coin] = body.mm.height;
                        }
                        lastBlockTime[coin] = timeNow;
                        templateUpdate2(coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, body);
                    } else if (isHashFactorChange) {
                        coinHashFactorUpdate(coin, coinHashFactor);
                    }
                    if (repeating === true) setTimeout(templateUpdate, daemonPollMs, coin, repeating);
                } else {
                    console.error(getThreadName() + formatPoolEvent("Header fetch failed", { chain: formatCoinPort(coin, port) }));
                    coinHashFactorUpdate(coin, 0);
                    if (repeating !== false) setTimeout(templateUpdate, global.config.daemon.pollInterval, coin, repeating);
                }
            }, true);
        } else if (cluster.isMaster) {
            if (repeating !== false) setTimeout(templateUpdate, global.config.daemon.pollInterval, coin, repeating);
        }
    }

    function anchorBlockUpdate() {
        if (("" in activeBlockTemplates) && global.config.daemon.port == activeBlockTemplates[""].port) return;
        global.coinFuncs.getLastBlockHeader(function (err, body) {
            if (err === null) {
                anchorState.current = body.height + 1;
                if (!anchorState.previous || anchorState.previous != anchorState.current) {
                    anchorState.previous = anchorState.current;
                    debug("Anchor block was changed to " + anchorState.current);
                }
            } else {
                console.error(getThreadName() + formatPoolEvent("Anchor header fetch failed", {
                    chain: formatCoinPort("", global.config.daemon.port)
                }));
            }
        }, true);
    }

    function getCoinJobParams(coin) {
        const params = {};
        params.bt = activeBlockTemplates[coin];
        params.coinHashFactor = lastCoinHashFactorMM[coin];
        params.algo_name = global.coinFuncs.algoShortTypeStr(params.bt.port, params.bt.block_version);
        return params;
    }

    function setNewCoinHashFactor(isHashFactorChange, coin, coinHashFactor, checkHeight) {
        if (isHashFactorChange) lastCoinHashFactor[coin] = coinHashFactor;
        const prevCoinHashFactorMM = lastCoinHashFactorMM[coin];
        lastCoinHashFactorMM[coin] = coinHashFactor;

        const port = global.coinFuncs.COIN2PORT(coin);
        const isMm = port in global.coinFuncs.getMM_PORTS();
        const coinPort = formatCoinPort(coin, port);
        if (isMm) {
            const childCoin = global.coinFuncs.PORT2COIN(global.coinFuncs.getMM_PORTS()[port]);
            lastCoinHashFactorMM[coin] += lastCoinHashFactor[childCoin];
        }

        if (cluster.isMaster && coin !== "" && prevCoinHashFactorMM != lastCoinHashFactorMM[coin]) {
            console.log(getThreadName() + formatPoolEvent("Hash factor", {
                chain: coinPort,
                prev: prevCoinHashFactorMM,
                next: coinHashFactor,
                mm: isMm ? lastCoinHashFactorMM[coin] : undefined
            }));
        }
        if (!(coin in activeBlockTemplates)) return;

        if (isHashFactorChange && port in global.coinFuncs.getMM_CHILD_PORTS()) {
            const parentPorts = global.coinFuncs.getMM_CHILD_PORTS()[port];
            for (const parentPort in parentPorts) {
                const parentCoin = global.coinFuncs.PORT2COIN(parentPort);
                setNewCoinHashFactor(true, parentCoin, lastCoinHashFactor[parentCoin], 0);
            }
        }

        const timeBefore = Date.now();
        let strLogPrefix;

        if (isHashFactorChange) {
            const activeTemplate = activeBlockTemplates[coin];
            const algo = global.coinFuncs.algoShortTypeStr(activeTemplate.port, activeTemplate.block_version);

            strLogPrefix = "BT update";
            if (cluster.isMaster) console.log(getThreadName() + formatPoolEvent(strLogPrefix, {
                mode: "full",
                chain: coinPort,
                factor: lastCoinHashFactorMM[coin]
            }));

            for (const [_minerId, miner] of activeMiners) {
                if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
                if (checkHeight) miner.trust.check_height = checkHeight;
                miner.sendBestCoinJob();
            }
        } else {
            strLogPrefix = "BT update";
            if (cluster.isMaster) console.log(getThreadName() + formatPoolEvent(strLogPrefix, {
                mode: "fast",
                chain: coinPort,
                factor: lastCoinHashFactorMM[coin]
            }));

            const params = getCoinJobParams(coin);
            for (const [_minerId, miner] of activeMiners) {
                if (miner.curr_coin !== coin) continue;
                if (checkHeight) miner.trust.check_height = checkHeight;
                miner.sendCoinJob(coin, params);
            }
        }

        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(getThreadName() + formatPoolEvent("BT update slow", {
            chain: coinPort,
            elapsedMs: elapsed,
            miners: activeMiners.size
        }));
    }

    function setNewBlockTemplate(template) {
        const coin = template.coin;
        let isExtraCheck = false;
        if (coin in activeBlockTemplates) {
            if (coin in pastBlockTemplates) {
                pastBlockTemplates[coin].get(0).timeoutTime = Date.now() + 4 * 1000;
            } else {
                pastBlockTemplates[coin] = global.support.circularBuffer(10);
            }
            pastBlockTemplates[coin].enq(activeBlockTemplates[coin]);
            if (activeBlockTemplates[coin].port != template.port && global.config.pool.trustedMiners) isExtraCheck = true;
        }

        if (cluster.isMaster) {
            const auxChainXtm = global.coinFuncs.getAuxChainXTM(template);
            const xtmHeight = auxChainXtm ? auxChainXtm.height : "";
            const xtmDifficulty = auxChainXtm ? auxChainXtm.difficulty : "";
            console.log(getThreadName() + formatPoolEvent("Template", {
                chain: formatCoinPort(coin, template.port),
                height: template.height + (xtmHeight ? "/" + xtmHeight : ""),
                diff: template.difficulty + (xtmDifficulty ? "/" + xtmDifficulty : ""),
                factor: template.coinHashFactor
            }));
        } else {
            debug(getThreadName() + formatPoolEvent("Template", {
                chain: formatCoinPort(coin, template.port),
                height: template.height + (template.xtm_height ? "/" + template.xtm_height : ""),
                diff: template.difficulty
            }));
        }

        activeBlockTemplates[coin] = new global.coinFuncs.BlockTemplate(template);
        activeBlockTemplates[coin].timeCreated = Date.now();

        const height = activeBlockTemplates[coin].height;
        if (coin === "" && global.config.daemon.port == activeBlockTemplates[""].port) {
            anchorState.current = height;
        }

        setNewCoinHashFactor(template.isHashFactorChange, coin, template.coinHashFactor, isExtraCheck ? height : 0);
    }

    return {
        anchorBlockUpdate,
        coinHashFactorUpdate,
        getCoinJobParams,
        setNewBlockTemplate,
        setNewCoinHashFactor,
        templateUpdate,
        templateUpdate2,
        updateCoinHashFactor
    };
};
