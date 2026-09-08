"use strict";
// Template management owns daemon polling, block-template normalization, and
// fan-out of template/hash-factor updates to connected miners. Keeping this
// logic isolated makes the pool entrypoint easier to read and keeps the data
// flow around active templates explicit.

/** @typedef {import("../../types/runtime").ProtoMessage} ProtoMessage */
/** @typedef {import("../../types/pool_profiles").PoolJobParams} PoolJobParams */

/** @typedef {ProtoMessage & {coin?: string, port?: number, height?: number, difficulty?: number, block_version?: number, hash?: string, blocktemplate_blob?: string, expected_reward?: number, coinHashFactor?: number, isHashFactorChange?: boolean, parent_blocktemplate_blob?: string, child_template?: ActiveTemplate, child_template_buffer?: Buffer, xtm_height?: number, buffer?: Buffer, idHash?: string, timeCreated?: number, timeoutTime?: number}} TemplateRecord */
/** @typedef {TemplateRecord & {coin: string, port: number, height: number, difficulty: number, coinHashFactor: number, isHashFactorChange: boolean}} UsableTemplate */
/** @typedef {UsableTemplate & {block_version?: number, idHash?: string, buffer?: Buffer}} ActiveTemplate */
/** @typedef {ProtoMessage & {hash: string, height: number, timestamp?: number, time?: number, mm?: ProtoMessage & {hash: string, height: number, timestamp?: number, time?: number}}} TemplateHeader */
/** @typedef {TemplateRecord & {height: number, difficulty: number}} RpcTemplate */
/** @typedef {ProtoMessage & {height: number, difficulty: number}} AuxTemplate */
/** @typedef {Omit<PoolJobParams, "bt"> & {bt: ActiveTemplate}} TemplateJobParams */
/** @typedef {{trust?: {check_height: number}, algos: Record<string, number>, curr_coin?: string, sendBestCoinJob: () => void, sendCoinJob: (coin: string, params: TemplateJobParams) => void}} TemplateMiner */
/** @typedef {{isMaster: boolean}} TemplateCluster */
/** @typedef {{[key: string]: number}} NumberMap */
/** @typedef {{[key: string]: string}} StringMap */
/** @typedef {{enq: (template: ActiveTemplate) => void}} TemplateBuffer */
/** @typedef {{
 *     cluster: TemplateCluster,
 *     debug: (message: string) => void,
 *     daemonPollMs: number,
 *     activeMiners: Map<string, TemplateMiner>,
 *     activeBlockTemplates: Record<string, ActiveTemplate>,
 *     pastBlockTemplates: Record<string, TemplateBuffer>,
 *     lastBlockHash: StringMap,
 *     lastBlockHeight: NumberMap,
 *     lastBlockHashMM: StringMap,
 *     lastBlockHeightMM: NumberMap,
 *     lastBlockTime: NumberMap,
 *     lastBlockKeepTime: NumberMap,
 *     lastBlockReward: NumberMap,
 *     newCoinHashFactor: NumberMap,
 *     lastCoinHashFactor: NumberMap,
 *     lastCoinHashFactorMM: NumberMap,
 *     daemonFailureSince: NumberMap,
 *     anchorState: {current: number|undefined, previous: number|undefined},
 *     sendToWorkers: (message: ProtoMessage) => void,
 *     getThreadName: () => string|undefined,
 *     formatCoinPort: (coin: string, port?: number|string) => string,
 *     formatPoolEvent: (label: string, fields?: Record<string, unknown>) => string
 * }} TemplateManagerDeps */

/** @param {unknown} value @param {string} key @returns {unknown} */
function readField(value, key) {
    if (value === null || typeof value !== "object" || !(key in value)) return undefined;
    return Reflect.get(value, key);
}

/** @param {unknown} value @returns {value is AuxTemplate} */
function isAuxTemplate(value) {
    return typeof readField(value, "height") === "number" && typeof readField(value, "difficulty") === "number";
}

/** @param {unknown} value @returns {value is TemplateHeader} */
function isTemplateHeader(value) {
    // Several adapters expose `time` or omit a timestamp entirely; stale-header
    // checks already treat either case as an unknown age.
    return typeof readField(value, "hash") === "string" && typeof readField(value, "height") === "number";
}

/** @param {unknown} value @returns {value is RpcTemplate} */
function isRpcTemplate(value) {
    return typeof readField(value, "height") === "number" && typeof readField(value, "difficulty") === "number";
}

/** @param {unknown} value @returns {value is ActiveTemplate} */
function isActiveTemplate(value) {
    return typeof readField(value, "coin") === "string" && typeof readField(value, "port") === "number" &&
        typeof readField(value, "height") === "number" && typeof readField(value, "difficulty") === "number" &&
        typeof readField(value, "coinHashFactor") === "number" && typeof readField(value, "isHashFactorChange") === "boolean";
}

/** @param {Buffer} blob @param {number} port @param {Buffer} childBuffer @returns {Buffer|null} */
function constructParentBlockBlob(blob, port, childBuffer) {
    try {
        return global.coinFuncs.constructMMParentBlockBlob(blob, port, childBuffer);
    } catch (_error) {
        // A malformed parent template should not prevent the child template
        // from being published to miners.
        return null;
    }
}

/** @param {TemplateManagerDeps} deps @returns {Record<string, unknown>} */
module.exports = function createTemplateManager(deps) {
    const {
        cluster,
        debug,
        daemonPollMs,
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
        daemonFailureSince = {},
        anchorState,
        sendToWorkers,
        getThreadName,
        formatCoinPort,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;

    /** @param {unknown} error @returns {string} */
    function formatRpcErrorDetail(error) {
        if (!error) return "";
        if (error instanceof Error) return error.message || String(error);
        if (typeof error === "string") return error;
        if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
        try {
            return JSON.stringify(error);
        } catch (_error) {
            return String(error);
        }
    }

    /** @param {string} coin @param {number} port @returns {string[]} */
    function getDaemonHealthKeys(coin, port) {
        const mainPort = global.config && global.config.daemon ? global.config.daemon.port : port;
        if (coin === "") return [`xmr:${  port}`, `xtm:${  port}`];
        if (typeof coin === "string" && coin.startsWith("XTM")) return [`xtm:${  mainPort}`];
        return [];
    }

    /** @param {string} key @param {boolean|unknown} failed @returns {void} */
    function setDaemonFailure(key, failed) {
        if (failed && !(key in daemonFailureSince)) daemonFailureSince[key] = Date.now();
        else if (!failed) delete daemonFailureSince[key];
    }

    /** @param {string} coin @param {number} port @param {boolean|unknown} failed @returns {void} */
    function markDaemonFailure(coin, port, failed) {
        getDaemonHealthKeys(coin, port).forEach(function updateDaemonFailure(key) {
            setDaemonFailure(key, failed);
        });
    }

    /** @param {string} coin @param {number} port @param {TemplateHeader} header @returns {void} */
    function markHeaderHealth(coin, port, header) {
        if (coin !== "") return markDaemonFailure(coin, port, false);
        const configuredAge = Number(global.config.daemon["maxBlockAgeSeconds"]);
        const maxAgeMs = (Number.isFinite(configuredAge) && configuredAge > 0 ? configuredAge : 10800) * 1000;
        /** @param {unknown} timestamp @returns {boolean} */
        const stale = function isStale(timestamp) {
            return Number.isFinite(Number(timestamp)) && Date.now() - Number(timestamp) * 1000 > maxAgeMs;
        };
        setDaemonFailure(`xmr:${  port}`, stale(header.timestamp ?? header.time));
        setDaemonFailure(`xtm:${  port}`, header.mm ? stale(header.mm.timestamp ?? header.mm.time) : false);
    }

    /** @param {TemplateRecord} rpcTemplate @param {string} coin @param {number|string} port @param {number} coinHashFactor @param {boolean} isHashFactorChange @returns {TemplateRecord} */
    function processRpcTemplate(rpcTemplate, coin, port, coinHashFactor, isHashFactorChange) {
        const template = Object.assign({}, rpcTemplate);

        template.coin = coin;
        template.port = typeof port === "number" ? port : parseInt(port, 10);
        template.coinHashFactor = coinHashFactor;
        template.isHashFactorChange = isHashFactorChange;

        const mmPorts = global.coinFuncs.getMM_PORTS();
        if (String(port) in mmPorts) {
            const childPort = mmPorts[String(port)];
            const childCoin = typeof childPort === "number" ? global.coinFuncs.PORT2COIN(childPort) : undefined;
            if (typeof childCoin === "string" && childCoin in activeBlockTemplates) {
                const childTemplate = activeBlockTemplates[childCoin];
                if (!childTemplate || !childTemplate.buffer) return template;
                template.child_template = childTemplate;
                template.child_template_buffer = childTemplate.buffer;
                const parentBlob = constructParentBlockBlob(
                    Buffer.from(rpcTemplate.blocktemplate_blob || "", "hex"),
                    typeof port === "number" ? port : parseInt(port, 10),
                    childTemplate.buffer
                );
                if (parentBlob) template.parent_blocktemplate_blob = parentBlob.toString("hex");
            }
        }

        return template;
    }

    // Runs only on the master thread in production. Workers reuse the same code
    // in test mode so template handling stays behavior-identical.
    /** @param {string} coin @param {number} port @param {number} coinHashFactor @param {boolean} isHashFactorChange @param {TemplateRecord} bodyBt @param {TemplateHeader} [bodyHeader] @returns {void} */
    function templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, bodyBt, bodyHeader) {
        const template = processRpcTemplate(bodyBt, coin, port, coinHashFactor, isHashFactorChange);
        const templateHeader = bodyHeader || (isTemplateHeader(bodyBt) ? bodyBt : undefined);
        if (templateHeader) markHeaderHealth(coin, port, templateHeader);
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
            const mmChildPorts = global.coinFuncs.getMM_CHILD_PORTS();
            if (String(port) in mmChildPorts) {
                const parentPorts = mmChildPorts[String(port)];
                if (!parentPorts || typeof parentPorts !== "object") return;
                for (const parentPort in parentPorts) {
                    const parentPortNumber = parseInt(parentPort, 10);
                    const parentCoin = global.coinFuncs.PORT2COIN(parentPortNumber);
                    if (typeof parentCoin === "string" && parentCoin in activeBlockTemplates) {
                        const parentTemplate = activeBlockTemplates[parentCoin];
                        if (!parentTemplate) continue;
                        const derivedTemplate = processRpcTemplate(
                            parentTemplate,
                            parentCoin,
                            parentPortNumber,
                            lastCoinHashFactor[parentCoin] || 0,
                            false
                        );
                        sendToWorkers({ type: "newBlockTemplate", data: derivedTemplate });
                        setNewBlockTemplate(derivedTemplate);
                    }
                }
            }
        } else {
            setNewBlockTemplate(template);
        }
    }

    /** @param {string} coin @param {number} port @param {boolean} isHashChange @param {boolean} isMMHashChange @param {number} coinHashFactor @param {boolean} isHashFactorChange @param {TemplateHeader} bodyHeader @param {number|undefined} [timesFailed] @returns {void} */
    function templateUpdate2(coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, bodyHeader, timesFailed) {
        const profile = global.coinFuncs.getPoolProfile(coin);
        if (profile && profile.rpc && profile.rpc["headerProvidesTemplate"] === true) {
            return templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, bodyHeader);
        }

        if (!bodyHeader) return;

        /** @param {string} reason @param {Record<string, unknown>} fields @returns {void} */
        function retryTemplateFetch(reason, fields) {
            const nextTimesFailed = (timesFailed || 0) + 1;
            console.error(getThreadName() + formatPoolEvent(reason, Object.assign({
                chain: formatCoinPort(coin, port),
                attempt: nextTimesFailed
            }, fields)));
            if (nextTimesFailed <= 2) {
                setTimeout(templateUpdate2, 500, coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, bodyHeader, nextTimesFailed);
            } else {
                markDaemonFailure(coin, port, true);
                coinHashFactorUpdate(coin, 0);
            }
        }

        /** @param {RpcTemplate|null} bodyBt @returns {boolean} */
        function skipTemplateFetch(bodyBt) {
            if (!newCoinHashFactor[coin]) {
                console.log(getThreadName() + formatPoolEvent("Template fetch skipped", { chain: formatCoinPort(coin, port), reason: "zero-hash-factor" }));
                return true;
            }
            const previousHeight = lastBlockHeight[coin] || 0;
            if (bodyHeader.height < previousHeight) {
                console.error(getThreadName() + formatPoolEvent("Template fetch ignored", { chain: formatCoinPort(coin, port), reason: "stale-height", height: bodyHeader.height + 1, needed: previousHeight + 1 }));
                return true;
            }
            const auxValue = bodyBt ? global.coinFuncs.getAuxChainXTM(bodyBt) : null;
            const auxChainXtm = isAuxTemplate(auxValue) ? auxValue : null;
            const previousMmHeight = lastBlockHeightMM[coin] || 0;
            if (bodyHeader.mm && auxChainXtm && bodyHeader.mm.height < previousMmHeight) {
                console.error(getThreadName() + formatPoolEvent("Template fetch ignored", { chain: formatCoinPort(coin, port), reason: "stale-mm-height", mmHeight: bodyHeader.mm.height + 1, needed: previousMmHeight + 1 }));
                return true;
            }
            return false;
        }

        /** @param {RpcTemplate|null} bodyBt @param {unknown} templateError @param {AuxTemplate|null} auxChainXtm @returns {boolean} */
        function rejectInvalidTemplate(bodyBt, templateError, auxChainXtm) {
            if (!bodyBt) return retryTemplateFetch("Template fetch failed", { error: formatRpcErrorDetail(templateError) }), true;
            if (!global.coinFuncs.hasTemplateBlob(bodyBt, port)) return retryTemplateFetch("Template unusable", { reason: "missing-mining-blob", body: bodyBt }), true;
            if (bodyHeader.mm && auxChainXtm && auxChainXtm.height < bodyHeader.mm.height + 1) {
                retryTemplateFetch("Template fetch stale", { height: auxChainXtm.height, needed: bodyHeader.mm.height + 1 });
                return true;
            }
            return false;
        }

        global.coinFuncs.getPortBlockTemplate(port, function onTemplate(rawTemplate, templateError) {
            const template = isRpcTemplate(rawTemplate) ? rawTemplate : null;
            if (skipTemplateFetch(template)) return;
            const auxValue = template ? global.coinFuncs.getAuxChainXTM(template) : null;
            const auxChainXtm = isAuxTemplate(auxValue) ? auxValue : null;
            if (rejectInvalidTemplate(template, templateError, auxChainXtm)) return;
            markHeaderHealth(coin, port, bodyHeader);

            const timeNow = Date.now();
            const maxBlockKeepTimeValue = `maxBlockKeepTime${  coin}` in global.config.daemon ? global.config.daemon[`maxBlockKeepTime${  coin}`] : 60 * 60;
            const maxBlockKeepTime = Number(maxBlockKeepTimeValue) * 1000;
            const isTimeChange = !(coin in lastBlockKeepTime) || timeNow - (lastBlockKeepTime[coin] || 0) > maxBlockKeepTime;
            const expectedReward = template && typeof template.expected_reward === "number" ? template.expected_reward : 0;
            const isRewardCheckReady = Boolean(expectedReward && (coin in lastBlockReward) && lastBlockReward[coin]);
            const previousReward = lastBlockReward[coin] || 1;
            const isRewardChange = Boolean(isRewardCheckReady && expectedReward / previousReward > 1.01);

            if (isHashChange || isMMHashChange || (isTimeChange && (!isRewardCheckReady || expectedReward !== previousReward)) || isRewardChange) {
                lastBlockKeepTime[coin] = timeNow;
                if (!template || expectedReward === 0) return;
                lastBlockReward[coin] = expectedReward;
                return templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, template, bodyHeader);
            }
        }, true);
    }

    /** @param {string} coin @param {number} coinHashFactor @returns {void} */
    function coinHashFactorUpdate(coin, coinHashFactor) {
        if (coin === "") return;
        if (coinHashFactor === 0 && lastCoinHashFactor[coin] === 0) return;
        if (cluster.isMaster) {
            sendToWorkers({ type: "newCoinHashFactor", data: { coin, coinHashFactor } });
        }
        setNewCoinHashFactor(true, coin, coinHashFactor);
    }

    /** @param {string} coin @returns {void} */
    function updateCoinHashFactor(coin) {
        const profile = global.coinFuncs.getPoolProfile(coin);
        const perf = profile && profile["perf"];
        if (perf && typeof perf === "object" && "hashFactorDisabled" in perf && perf.hashFactorDisabled === true) {
            coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
            return;
        }
        global.support.getCoinHashFactor(coin, function onHashFactor(coinHashFactor) {
            if (!coinHashFactor) {
                if (coinHashFactor === null) console.error(getThreadName() + formatPoolEvent("Hash factor fetch failed", { chain: formatCoinPort(coin) }));
                coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);
            } else {
                newCoinHashFactor[coin] = coinHashFactor;
            }
        });
    }

    /** @param {string} coin @param {boolean|undefined} [repeating] @returns {void} */
    function templateUpdate(coin, repeating) {
        const port = global.coinFuncs.COIN2PORT(coin);
        if (typeof port !== "number") return;
        const activePort = port;
        const coinHashFactor = newCoinHashFactor[coin];
        if (typeof coinHashFactor === "number" && coinHashFactor !== 0) {
            const activeCoinHashFactor = coinHashFactor;
            /** @param {Error|string|boolean|null} err @param {unknown} body */
            function onHeader(err, body) {
                const header = isTemplateHeader(body) ? body : undefined;
                handleTemplateHeader(coin, activePort, activeCoinHashFactor, repeating, err, header);
            }
            global.coinFuncs.getPortLastBlockHeaderMM(port, onHeader, true);
        } else if (cluster.isMaster) {
            if (repeating !== false) setTimeout(templateUpdate, Number(global.config.daemon["pollInterval"]), coin, repeating);
        }
    }

    /** @param {string} coin @param {number} port @param {number} coinHashFactor @param {boolean|undefined} repeating @param {Error|string|boolean|null} err @param {TemplateHeader|undefined} body @returns {void} */
    function handleTemplateHeader(coin, port, coinHashFactor, repeating, err, body) {
        if (!newCoinHashFactor[coin]) {
            console.log(getThreadName() + formatPoolEvent("Header fetch skipped", { chain: formatCoinPort(coin, port), reason: "zero-hash-factor" }));
            scheduleTemplateRepeat(coin, repeating, daemonPollMs, true);
            return;
        }
        if (err !== null || !body || !body.hash) {
            console.error(getThreadName() + formatPoolEvent("Header fetch failed", { chain: formatCoinPort(coin, port) }));
            markDaemonFailure(coin, port, true);
            coinHashFactorUpdate(coin, 0);
            scheduleTemplateRepeat(coin, repeating, Number(global.config.daemon["pollInterval"]), true);
            return;
        }
        const isHashFactorChange = Math.abs((lastCoinHashFactor[coin] || 0) - coinHashFactor) / coinHashFactor > 0.05;
        const pollBlockInterval = Number(`pollBlockInterval${  coin}` in global.config.daemon ? global.config.daemon[`pollBlockInterval${  coin}`] : 60 * 60 * 1000);
        const timeNow = Date.now();
        const isHashChange = !(coin in lastBlockHash) || body.hash !== lastBlockHash[coin];
        const isMMHashChange = Boolean(body.mm && (!(coin in lastBlockHashMM) || body.mm.hash !== lastBlockHashMM[coin]));
        const isTimeChange = !(coin in lastBlockTime) || timeNow - (lastBlockTime[coin] || 0) > pollBlockInterval;
        if (isHashChange || isMMHashChange || isTimeChange) {
            updateLastTemplateHeader(coin, body, timeNow);
            templateUpdate2(coin, port, isHashChange, isMMHashChange, coinHashFactor, isHashFactorChange, body);
        } else {
            markHeaderHealth(coin, port, body);
            if (isHashFactorChange) coinHashFactorUpdate(coin, coinHashFactor);
        }
        scheduleTemplateRepeat(coin, repeating, daemonPollMs, true);
    }

    /** @param {string} coin @param {boolean|undefined} repeating @param {number} delayMs @param {boolean} requireTrue @returns {void} */
    function scheduleTemplateRepeat(coin, repeating, delayMs, requireTrue) {
        if (requireTrue ? repeating === true : repeating !== false) setTimeout(templateUpdate, delayMs, coin, repeating);
    }

    /** @param {string} coin @param {TemplateHeader} body @param {number} timeNow @returns {void} */
    function updateLastTemplateHeader(coin, body, timeNow) {
        lastBlockHash[coin] = body.hash;
        lastBlockHeight[coin] = body.height;
        if (body.mm) {
            lastBlockHashMM[coin] = body.mm.hash;
            lastBlockHeightMM[coin] = body.mm.height;
        }
        lastBlockTime[coin] = timeNow;
    }

    /** @param {string} mode @param {string} coinPort @param {string} coin @returns {void} */
    function logBtUpdate(mode, coinPort, coin) {
        if (cluster.isMaster) console.log(getThreadName() + formatPoolEvent("BT update", { mode, chain: coinPort, factor: lastCoinHashFactorMM[coin] }));
    }

    /** @param {string} coin @param {number|undefined} checkHeight @returns {void} */
    function notifyBestCoinMiners(coin, checkHeight) {
        const activeTemplate = activeBlockTemplates[coin];
        if (!activeTemplate) return;
        const algo = global.coinFuncs.algoShortTypeStr(activeTemplate.port);
        for (const miner of activeMiners.values()) {
            if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
            if (checkHeight && miner.trust) miner.trust.check_height = checkHeight;
            miner.sendBestCoinJob();
        }
    }

    /** @param {string} coin @param {number|undefined} checkHeight @returns {void} */
    function notifySameCoinMiners(coin, checkHeight) {
        const params = getCoinJobParams(coin);
        for (const miner of activeMiners.values()) {
            if (miner.curr_coin !== coin) continue;
            if (checkHeight && miner.trust) miner.trust.check_height = checkHeight;
            miner.sendCoinJob(coin, params);
        }
    }

    /** @returns {void} */
    function anchorBlockUpdate() {
        // eslint-disable-next-line eqeqeq -- intentional loose compare: config daemon.port may be a string while template port is numeric
        if (("" in activeBlockTemplates) && global.config.daemon.port == activeBlockTemplates[""].port) return;
        /** @param {Error|string|boolean|null} err @param {unknown} body */
        function onHeader(err, body) {
            const header = isTemplateHeader(body) ? body : null;
            if (err === null && header) {
                anchorState.current = header.height + 1;
                if (!anchorState.previous || anchorState.previous !== anchorState.current) {
                    anchorState.previous = anchorState.current;
                    debug(`Anchor block was changed to ${  anchorState.current}`);
                }
            } else {
                console.error(getThreadName() + formatPoolEvent("Anchor header fetch failed", {
                    chain: formatCoinPort("", global.config.daemon.port)
                }));
            }
        }
        global.coinFuncs.getLastBlockHeader(onHeader, true);
    }

    /** @param {string} coin @returns {TemplateJobParams} */
    function getCoinJobParams(coin) {
        const bt = activeBlockTemplates[coin];
        if (!bt) throw new Error(`No active block template for ${  coin}`);
        const coinHashFactor = lastCoinHashFactorMM[coin] || 0;
        const algoName = global.coinFuncs.algoShortTypeStr(bt.port);
        const hashesPerDifficulty = global.coinFuncs.getPoolHashesPerDifficulty(bt.port);
        if (hashesPerDifficulty !== 1) return { bt, coinHashFactor, hashesPerDifficulty, algo_name: algoName };
        return { bt, coinHashFactor, algo_name: algoName };
    }

    /** @param {boolean} isHashFactorChange @param {string} coin @param {number} coinHashFactor @param {number} [checkHeight] @returns {void} */
    function setNewCoinHashFactor(isHashFactorChange, coin, coinHashFactor, checkHeight) {
        if (isHashFactorChange) lastCoinHashFactor[coin] = coinHashFactor;
        const prevCoinHashFactorMM = lastCoinHashFactorMM[coin];
        lastCoinHashFactorMM[coin] = coinHashFactor;

        const port = global.coinFuncs.COIN2PORT(coin);
        if (typeof port !== "number") return;
        const mmPorts = global.coinFuncs.getMM_PORTS();
        const isMm = String(port) in mmPorts;
        const coinPort = formatCoinPort(coin, port);
        if (isMm) {
            const childPort = mmPorts[String(port)];
            const childCoin = typeof childPort === "number" ? global.coinFuncs.PORT2COIN(childPort) : undefined;
            if (typeof childCoin === "string") lastCoinHashFactorMM[coin] += lastCoinHashFactor[childCoin] || 0;
        }

        if (cluster.isMaster && coin !== "" && prevCoinHashFactorMM !== lastCoinHashFactorMM[coin]) {
            console.log(getThreadName() + formatPoolEvent("Hash factor", {
                chain: coinPort,
                prev: prevCoinHashFactorMM,
                next: coinHashFactor,
                mm: isMm ? lastCoinHashFactorMM[coin] : undefined
            }));
        }
        if (!(coin in activeBlockTemplates)) return;

        const mmChildPorts = global.coinFuncs.getMM_CHILD_PORTS();
        if (isHashFactorChange && String(port) in mmChildPorts) {
            const parentPorts = mmChildPorts[String(port)];
            if (!parentPorts || typeof parentPorts !== "object") return;
            for (const parentPort in parentPorts) {
                const parentPortNumber = parseInt(parentPort, 10);
                const parentCoin = global.coinFuncs.PORT2COIN(parentPortNumber);
                if (typeof parentCoin === "string") setNewCoinHashFactor(true, parentCoin, lastCoinHashFactor[parentCoin] || 0, 0);
            }
        }

        const timeBefore = Date.now();
        if (isHashFactorChange) {
            logBtUpdate("full", coinPort, coin);
            notifyBestCoinMiners(coin, checkHeight);
        } else {
            logBtUpdate("fast", coinPort, coin);
            notifySameCoinMiners(coin, checkHeight);
        }

        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(getThreadName() + formatPoolEvent("BT update slow", {
            chain: coinPort,
            elapsedMs: elapsed,
            miners: activeMiners.size
        }));
    }

    /** @param {TemplateRecord} template @returns {void} */
    function setNewBlockTemplate(template) {
        const coin = template.coin;
        if (typeof coin !== "string" || typeof template.port !== "number" ||
            typeof template.height !== "number" || typeof template.difficulty !== "number" ||
            typeof template.coinHashFactor !== "number" || typeof template.isHashFactorChange !== "boolean") return;
        const previousTemplate = activeBlockTemplates[coin];
        if (previousTemplate && previousTemplate.idHash === template.idHash) {
            const isMmParentTemplate = typeof template.parent_blocktemplate_blob === "string";
            if (!isMmParentTemplate || previousTemplate.parent_blocktemplate_blob === template.parent_blocktemplate_blob) return;
        }
        let isExtraCheck = false;
        if (previousTemplate) {
            previousTemplate.timeoutTime = Date.now() + 4 * 1000;
            const history = pastBlockTemplates[coin] || global.support.circularBuffer(10);
            pastBlockTemplates[coin] = history;
            history.enq(previousTemplate);
            if (previousTemplate.port !== template.port && global.config.pool.trustedMiners) isExtraCheck = true;
        }

        if (cluster.isMaster) {
            const auxValue = global.coinFuncs.getAuxChainXTM(template);
            const auxChainXtm = isAuxTemplate(auxValue) ? auxValue : null;
            const xtmHeight = auxChainXtm ? auxChainXtm.height : "";
            const xtmDifficulty = auxChainXtm ? auxChainXtm.difficulty : "";
            console.log(getThreadName() + formatPoolEvent("Template", {
                chain: formatCoinPort(coin, template.port),
                height: template.height + (xtmHeight ? `/${  xtmHeight}` : ""),
                diff: template.difficulty + (xtmDifficulty ? `/${  xtmDifficulty}` : ""),
                factor: template.coinHashFactor
            }));
        } else {
            debug(getThreadName() + formatPoolEvent("Template", {
                chain: formatCoinPort(coin, template.port),
                height: template.height + (template.xtm_height ? `/${  template.xtm_height}` : ""),
                diff: template.difficulty
            }));
        }

        const candidate = new global.coinFuncs.BlockTemplate(template);
        // BlockTemplate normalizes the wire fields and does not retain the
        // pool-only factor metadata, so attach that state after construction.
        const activeTemplate = Object.assign(candidate, {
            coinHashFactor: template.coinHashFactor,
            isHashFactorChange: template.isHashFactorChange
        });
        if (!isActiveTemplate(activeTemplate)) return;
        activeBlockTemplates[coin] = activeTemplate;
        activeTemplate.timeCreated = Date.now();

        const height = activeTemplate.height;
        // eslint-disable-next-line eqeqeq -- intentional loose compare: config daemon.port may be a string while template port is numeric
        if (coin === "" && global.config.daemon.port == activeTemplate.port) {
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
