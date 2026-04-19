"use strict";

const { arr2hex, calcErgReward, calcEthReward } = require("../helpers.js");
const COIN_PROFILE_SYMBOL = Symbol.for("nodejs-pool.coinProfile");

function cloneValue(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === "object" && !Buffer.isBuffer(value)) return Object.assign({}, value);
    return value;
}

function mergeSection(base, overrides) {
    const section = Object.assign({}, base);
    if (!overrides) return section;
    Object.keys(overrides).forEach(function mergeKey(key) {
        section[key] = cloneValue(overrides[key]);
    });
    return section;
}

function defaultPerfAliases(spec) {
    return typeof spec.algo === "string" && spec.algo.length > 0 ? [spec.algo] : [];
}

function createProfile(spec) {
    const profile = Object.assign({}, spec);
    // Coin files only need to declare differences from the common defaults.
    profile.listed = spec.listed !== false;
    profile.displayCoin = spec.displayCoin || spec.coin || "";
    profile.aliases = Array.isArray(spec.aliases) ? spec.aliases.slice() : [];
    profile.blob = mergeSection({}, spec.blob);
    profile.network = spec.network ? Object.assign({}, spec.network) : undefined;
    profile.addresses = spec.addresses ? Object.assign({}, spec.addresses) : undefined;
    profile.agent = spec.agent ? Object.assign({}, spec.agent) : undefined;
    profile.pool = mergeSection({}, spec.pool);
    profile.template = mergeSection({}, spec.template);
    profile.pow = mergeSection({}, spec.pow);
    profile.rpc = mergeSection({}, spec.rpc);
    profile.perf = mergeSection(
        spec.perf && Object.prototype.hasOwnProperty.call(spec.perf, "aliases") ? {} : { aliases: defaultPerfAliases(spec) },
        spec.perf
    );
    if (spec.mergedMining) profile.mergedMining = Object.assign({}, spec.mergedMining);
    if (spec.minerAlgoAliases) profile.minerAlgoAliases = Object.assign({}, spec.minerAlgoAliases);
    Object.defineProperty(profile, COIN_PROFILE_SYMBOL, { value: true });
    return profile;
}

function isCoinProfile(value) {
    return !!(value && value[COIN_PROFILE_SYMBOL] === true);
}

function parseBtcReward(block, config) {
    block.reward = 0;
    for (const vout of block.tx[0].vout) {
        if (config.headerRewardMode === "sum-vout") {
            if (config.rewardIgnoreAddress && vout.scriptPubKey.addresses && vout.scriptPubKey.addresses[0] === config.rewardIgnoreAddress) continue;
            block.reward += vout.value;
        } else if (vout.value > block.reward) {
            block.reward = vout.value;
        }
    }
    block.reward *= config.rewardMultiplier || 1;
    block.reward = parseInt(block.reward, 10);
    if (config.difficultyMultiplier) block.difficulty *= config.difficultyMultiplier;
    return block;
}

function normalizeDeroHeader(header) {
    header.timestamp /= 1000;
    header.difficulty *= 18;
    return header;
}

function loadEthBlockReward(port, block, runtime, callback) {
    const receipts = [];
    block.transactions.forEach(function buildReceiptRequest(tx) {
        receipts.push({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] });
    });

    if (!receipts.length) {
        block.reward = calcEthReward(block, []);
        return callback(null, block);
    }

    runtime.support.rpcPortDaemon2(port, "", receipts, function onReceipts(body) {
        if (!body || !(body instanceof Array)) return callback(true, body);
        block.reward = calcEthReward(block, body);
        return callback(null, block);
    });
}

function createEthRpcTimeoutBody(message) {
    return { error: { message } };
}

function parseEthBlockNumber(number) {
    // Ethereum-style RPC returns block numbers as hex strings like "0x1403059".
    // Parse them as base 16 or they collapse to 0 under base-10 parsing.
    return parseInt(number, 16);
}

function createEthRpcFinalizer(timeoutMs, timeoutMessage, callback) {
    let finished = false;
    const timer = setTimeout(function onTimeout() {
        if (finished) return;
        finished = true;
        callback(true, createEthRpcTimeoutBody(timeoutMessage));
    }, timeoutMs);

    return function finish(err, body) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callback(err, body);
    };
}

function createEthUncleReward(config, canonicalBlock, uncleBlock) {
    const rewardMultiplier = config.rewardMultiplier;
    const baseReward = config.uncleBaseReward;
    return (baseReward * (8 - (parseEthBlockNumber(canonicalBlock.number) - parseEthBlockNumber(uncleBlock.number))) / 8) * rewardMultiplier;
}

function getWalletReward(config, body, rewardCheck, port, runtime, callback) {
    let minerTxHash = body.result.miner_tx_hash == "" ? body.result.block_header.miner_tx_hash : body.result.miner_tx_hash;
    if (config.walletRewardLookup === false) minerTxHash = "";
    if (!minerTxHash) {
        body.result.block_header.reward = rewardCheck;
        return callback(null, body.result.block_header);
    }

    runtime.support.rpcPortWalletShort(port + 1, "get_transfer_by_txid", { txid: minerTxHash }, function onTransfer(body2) {
        if (!body2 || body2.error || !body2.result || !body2.result.transfer) return callback(true, body.result.block_header);
        // Asset-aware coins override this selector in their own coin file.
        let reward = typeof config.selectWalletTransferReward === "function"
            ? config.selectWalletTransferReward({
                body: body2,
                rewardCheck,
                runtime,
                transfer: body2.result.transfer,
                transfers: Array.isArray(body2.result.transfers) ? body2.result.transfers : []
            })
            : body2.result.transfer.amount;
        reward = Number.isFinite(Number(reward)) ? Number(reward) : body2.result.transfer.amount;
        if (reward !== rewardCheck) reward = Math.min(reward, rewardCheck);
        if (!config.walletZeroRewardAllowed && reward === 0) return callback(true, body);
        body.result.block_header.reward = reward;
        return callback(null, body.result.block_header);
    });
}

function createCryptonoteRpc(blockByHashMode, overrides) {
    const config = mergeSection({
        headerRewardMode: "max-vout",
        unlockConfirmationDepth: 60,
        walletRewardLookup: true,
        walletZeroRewardAllowed: false
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getblockheaderbyheight", { height: ctx.blockId }, function onHeader(body) {
            if (!body || !body.result) return ctx.callback(true, body);
            return ctx.callback(null, body.result.block_header);
        }, ctx.noErrorReport);
    };

    if (blockByHashMode === "header") {
        config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
            ctx.runtime.support.rpcPortDaemon(ctx.port, "getblockheaderbyhash", { hash: ctx.blockHash }, function onHeader(body) {
                if (!body || !body.result) return ctx.callback(true, body);
                return ctx.callback(null, body.result.block_header);
            }, ctx.noErrorReport);
        };
    } else {
        config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
            ctx.runtime.support.rpcPortDaemon(ctx.port, "getblock", { hash: ctx.blockHash }, function onBlock(body) {
                if (!body || !body.result) return ctx.callback(true, body);
                body.result.block_header.reward = 0;
                const blockJson = JSON.parse(body.result.json);
                const minerTx = blockJson.miner_tx;
                let rewardCheck = 0;
                if (config.headerRewardMode === "first-vout") rewardCheck = minerTx.vout[0].amount;
                else minerTx.vout.forEach(function chooseReward(vout) {
                    if (vout.amount > rewardCheck) rewardCheck = vout.amount;
                });

                if (!ctx.isOurBlock) {
                    body.result.block_header.reward = rewardCheck;
                    return ctx.callback(null, body.result.block_header);
                }

                return getWalletReward(config, body, rewardCheck, ctx.port, ctx.runtime, ctx.callback);
            }, ctx.noErrorReport);
        };
    }

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getlastblockheader", [], function onHeader(body) {
            if (!body || !body.result) {
                if (!ctx.noErrorReport) console.error("Last block header invalid: " + JSON.stringify(body));
                return ctx.callback(true, body);
            }
            return ctx.callback(null, body.result.block_header);
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getblocktemplate", {
            reserve_size: ctx.port in ctx.runtime.mmPortSet ? ctx.runtime.mmNonceSize + ctx.runtime.poolNonceSize : ctx.runtime.poolNonceSize,
            wallet_address: ctx.runtime.getPoolAddress(ctx.profile)
        }, function onTemplate(body) {
            return ctx.callback(body && body.result ? body.result : null);
        });
    };

    return config;
}

function createBtcRpc(overrides) {
    const config = mergeSection({
        difficultyMultiplier: 1,
        headerRewardMode: "max-vout",
        rewardMultiplier: 1
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getblockhash", params: [ctx.blockId] }, function onHash(body) {
            if (!body || !body.result) return ctx.callback(true, body);
            return ctx.runtime.coinFuncs.getPortAnyBlockHeaderByHash(ctx.port, body.result, false, ctx.callback, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getblock", params: [ctx.blockHash, 2] }, function onBlock(body) {
            if (!body || !body.result || !(body.result.tx instanceof Array) || body.result.tx.length < 1) return ctx.callback(true, body);
            return ctx.callback(null, parseBtcReward(body.result, config));
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getbestblockhash" }, function onHash(body) {
            if (!body || !body.result) return ctx.callback(true, body);
            const cacheKey = ctx.port.toString();
            ctx.runtime.owner.lastBlockCache = ctx.runtime.owner.lastBlockCache || {};
            if (ctx.runtime.owner.lastBlockCache[cacheKey] && ctx.runtime.owner.lastBlockCache[cacheKey].hash === body.result) {
                return ctx.callback(null, ctx.runtime.owner.lastBlockCache[cacheKey].header);
            }
            ctx.runtime.coinFuncs.getPortAnyBlockHeaderByHash(ctx.port, body.result, false, function onHeader(err, body2) {
                if (err === null) ctx.runtime.owner.lastBlockCache[cacheKey] = { hash: body.result, header: body2 };
                return ctx.callback(err, body2);
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getblocktemplate", params: [{ capabilities: ["coinbasetxn", "workid", "coinbase/append"], rules: ["segwit"] }] }, function onTemplate(body) {
            if (!(body && body.result)) return ctx.callback(null);
            return ctx.callback(config.createBlockTemplate(ctx.runtime.blockTemplate, body.result, ctx.runtime.getPoolAddress(ctx.profile)));
        });
    };

    return config;
}

function createEthRpc(overrides) {
    const config = mergeSection({
        headerProvidesTemplate: true,
        rewardMultiplier: 1000000000000000000,
        skipHashFallbackByHeight: true,
        uncleBaseReward: 2,
        callbackTimeoutMs: 30 * 1000
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        const finish = createEthRpcFinalizer(
            config.callbackTimeoutMs,
            "ETH block header by height timed out for " + ctx.port + "/" + ctx.blockId,
            ctx.callback
        );
        const blockId = ctx.blockId === "latest" ? ctx.blockId : "0x" + ctx.blockId.toString(16);
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [blockId, true] }, function onBlock(body) {
            if (!body || !body.result) return finish(true, body);
            body.result.height = parseEthBlockNumber(body.result.number);
            if (ctx.blockId === "latest") return finish(null, body.result);
            return loadEthBlockReward(ctx.port, body.result, ctx.runtime, finish);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        const finish = createEthRpcFinalizer(
            config.callbackTimeoutMs,
            "ETH block header by hash timed out for " + ctx.port + "/" + ctx.blockHash,
            ctx.callback
        );
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByHash", params: ["0x" + ctx.blockHash, true] }, function onBlock(body) {
            if (!body || !body.result) return finish(true, body);
            body.result.height = parseEthBlockNumber(body.result.number);
            ctx.runtime.coinFuncs.getPortBlockHeaderByID(ctx.port, body.result.height, function onCanonical(err, canonical) {
                if (err) return finish(true, body);
                if (body.result.hash === canonical.hash) return loadEthBlockReward(ctx.port, body.result, ctx.runtime, finish);

                const nearbyHeights = Array(16).fill().map(function mapHeight(_value, index) {
                    return body.result.height + index - 7;
                });
                (function scanNearbyHeight(index) {
                    if (index >= nearbyHeights.length) {
                        body.result.reward = null;
                        return finish(null, body.result);
                    }
                    const blockHeight = nearbyHeights[index];
                    ctx.runtime.coinFuncs.getPortBlockHeaderByID(ctx.port, blockHeight, function onHeader(err2, blockHeader) {
                        if (err2) {
                            if (ctx.isOurBlock) return finish(true, body);
                            return scanNearbyHeight(index + 1);
                        }
                        const uncleIndex = (blockHeader.uncles || []).indexOf("0x" + ctx.blockHash);
                        if (uncleIndex === -1) return scanNearbyHeight(index + 1);
                        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getUncleByBlockNumberAndIndex", params: ["0x" + blockHeight.toString(16), "0x" + uncleIndex.toString(16)] }, function onUncle(bodyUncle) {
                            if (!bodyUncle || !bodyUncle.result) return scanNearbyHeight(index + 1);
                            body.result.reward = createEthUncleReward(config, blockHeader, bodyUncle.result);
                            return finish(null, body.result);
                        }, ctx.noErrorReport);
                    }, ctx.noErrorReport);
                }(0));
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getWork", params: [] }, function onWork(body) {
            if (!body || !body.result || !(body.result instanceof Array)) return ctx.callback(true, body);
            const bt = ctx.runtime.blockTemplate.EthBlockTemplate(body.result);
            return ctx.callback(null, { hash: bt.hash, timestamp: Date.now() / 1000, difficulty: bt.difficulty, height: bt.height, seed_hash: bt.seed_hash });
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getWork", params: [] }, function onWork(body) {
            return ctx.callback(body && body.result ? ctx.runtime.blockTemplate.EthBlockTemplate(body.result) : null);
        });
    };

    return config;
}

function createErgRpc(overrides) {
    const config = mergeSection({}, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "blocks/at/" + ctx.blockId, null, function onHeight(body) {
            if (!body || !(body instanceof Array) || body.length !== 1) return ctx.callback(true, body);
            return ctx.runtime.coinFuncs.getPortAnyBlockHeaderByHash(ctx.port, body[0], false, ctx.callback, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "blocks/" + ctx.blockHash, null, function onBlock(body) {
            if (!body || !body.header) return ctx.callback(true, body);
            body.header.reward = calcErgReward(body.header.height, body.blockTransactions.transactions);
            return ctx.callback(null, body.header);
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "mining/candidate", null, function onCandidate(body) {
            if (!body || !body.pk) return ctx.callback(true, body);
            const bt = ctx.runtime.blockTemplate.ErgBlockTemplate(body);
            return ctx.callback(null, { hash: bt.hash, timestamp: Date.now() / 1000, difficulty: bt.difficulty, height: bt.height, hash2: bt.hash2 });
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "mining/candidate", null, function onCandidate(body) {
            return ctx.callback(body && body.pk ? ctx.runtime.blockTemplate.ErgBlockTemplate(body) : null);
        });
    };

    return config;
}

function createXtmBaseRpc(overrides) {
    return mergeSection({
        enrichLastBlockHeader(ctx) {
            ctx.runtime.coinFuncs.getPortBlockTemplate(ctx.port, function onTemplate(bt) {
                if (!bt) return ctx.callback(true, ctx.header);
                ctx.header.reward = bt.reward;
                ctx.header.difficulty = bt.difficulty;
                return ctx.callback(null, ctx.header);
            });
        }
    }, overrides);
}

function createXtmMainRpc(overrides) {
    const config = createXtmBaseRpc(overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "GetBlocks", { heights: [ctx.blockId] }, function onBlocks(body) {
            if (body && body.result instanceof Array && body.result.length === 1 && body.result[0].block) return ctx.callback(null, arr2hex(body.result[0].block.header));
            return ctx.callback(true, body);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "GetHeaderByHash", { hash: Buffer.from(ctx.blockHash, "hex").toJSON().data }, function onHeader(body) {
            if (!body || !body.result) return ctx.callback(true, body);
            body.result.header.height = parseInt(body.result.header.height, 10);
            body.result.header.reward = parseInt(body.result.reward, 10);
            return ctx.callback(null, arr2hex(body.result.header));
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "GetTipInfo", null, function onTip(body) {
            if (!body || !body.result) {
                if (!ctx.noErrorReport) console.error("Last block header invalid: " + JSON.stringify(body));
                return ctx.callback(true, body);
            }
            body.result.metadata.height = parseInt(body.result.metadata.best_block_height, 10);
            body.result.metadata.hash = body.result.metadata.best_block_hash;
            return ctx.callback(null, arr2hex(body.result.metadata));
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "GetNewBlockTemplateWithCoinbases", {
            algo: { pow_algo: 0 },
            coinbases: [{ address: ctx.runtime.getPoolAddress(ctx.profile), value: 1, stealth_payment: true, revealed_value_proof: true, coinbase_extra: [] }]
        }, function onTemplate(body) {
            if (!(body && body.result)) return ctx.callback(null);
            body.result.block.difficulty = parseInt(body.result.miner_data.target_difficulty, 10);
            body.result.block.reward = parseInt(body.result.miner_data.reward, 10);
            return ctx.callback(arr2hex(body.result.block));
        });
    };

    return config;
}

function assignXtmMainHeaderRpc(config) {
    const mainConfig = createXtmMainRpc();
    config.getBlockHeaderById = mainConfig.getBlockHeaderById;
    config.getAnyBlockHeaderByHash = mainConfig.getAnyBlockHeaderByHash;
    config.getLastBlockHeader = mainConfig.getLastBlockHeader;
}

function createXtmTRpc(overrides) {
    const config = createXtmBaseRpc(overrides);

    assignXtmMainHeaderRpc(config);

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "GetNewBlockTemplateWithCoinbases", {
            algo: { pow_algo: 2 },
            coinbases: [{ address: ctx.runtime.getPoolAddress(ctx.profile), value: 1, stealth_payment: true, revealed_value_proof: true, coinbase_extra: [] }]
        }, function onTemplate(body) {
            if (!(body && body.result)) return ctx.runtime.coinFuncs.getPortBlockTemplate(ctx.port, function retry(bt2) { return ctx.callback(bt2); });
            const result = body.result;
            return ctx.callback({
                blocktemplate_blob: "00".repeat(3) + arr2hex(result.merge_mining_hash) + "00".repeat(8) + "02" + "00".repeat(32),
                seed_hash: arr2hex(result.vm_key),
                reserved_offset: 44,
                difficulty: parseInt(result.miner_data.target_difficulty, 10),
                reward: parseInt(result.miner_data.reward, 10),
                height: parseInt(result.block.header.height, 10),
                xtm_block: result.block
            });
        });
    };

    return config;
}

function createXtmCRpc(overrides) {
    const config = createXtmBaseRpc(overrides);

    assignXtmMainHeaderRpc(config);

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "GetNewBlockTemplateWithCoinbases", {
            algo: { pow_algo: 3 },
            coinbases: [{ address: ctx.runtime.getPoolAddress(ctx.profile), value: 1, stealth_payment: true, revealed_value_proof: true, coinbase_extra: [] }]
        }, function onTemplate(body) {
            if (!(body && body.result)) return ctx.runtime.coinFuncs.getPortBlockTemplate(ctx.port, function retry(bt2) { return ctx.callback(bt2); });
            const result = body.result;
            return ctx.callback({
                blocktemplate_blob: arr2hex(result.merge_mining_hash),
                reserved_offset: 0,
                bt_nonce_size: 8,
                difficulty: parseInt(result.miner_data.target_difficulty, 10),
                reward: parseInt(result.miner_data.reward, 10),
                height: parseInt(result.block.header.height, 10),
                xtm_block: result.block
            });
        });
    };

    return config;
}

function createDeroRpc(overrides) {
    const config = mergeSection({
        unlockConfirmationDepth: 30,
        walletRewardLookup: true
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getblockheaderbyheight", { height: ctx.blockId }, function onHeader(body) {
            if (!body || !body.result) return ctx.callback(true, body);
            return ctx.callback(null, normalizeDeroHeader(body.result.block_header));
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getblockheaderbyhash", { hash: ctx.blockHash }, function onHeader(body) {
            if (!body || !body.result) return ctx.callback(true, body);
            return ctx.callback(null, body.result.block_header);
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getlastblockheader", [], function onHeader(body) {
            if (!body || !body.result) {
                if (!ctx.noErrorReport) console.error("Last block header invalid: " + JSON.stringify(body));
                return ctx.callback(true, body);
            }
            return ctx.callback(null, normalizeDeroHeader(body.result.block_header));
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getblocktemplate", {
            reserve_size: ctx.port in ctx.runtime.mmPortSet ? ctx.runtime.mmNonceSize + ctx.runtime.poolNonceSize : ctx.runtime.poolNonceSize,
            wallet_address: ctx.runtime.getPoolAddress(ctx.profile)
        }, function onTemplate(body) {
            if (body && body.result) {
                body.result.timestamp /= 1000;
                body.result.difficulty *= 18;
                body.result.mbl_difficulty = body.result.blockhashing_blob.charAt(0) == "4" ? body.result.difficulty : body.result.difficulty * 9;
                body.result.reserved_offset = 36;
            }
            return ctx.callback(body && body.result ? body.result : null);
        });
    };

    return config;
}

function createBlob(base, overrides) {
    return mergeSection(base, overrides);
}

function createPow(base, overrides) {
    return mergeSection(base, overrides);
}

function buildVerifyInput(algo, convertedBlob, extras) {
    return Object.assign({ algo: algo, blob: convertedBlob.toString("hex") }, extras || {});
}

function buildDefaultVerifyInput(ctx) {
    return buildVerifyInput(ctx.algo, ctx.convertedBlob);
}

function createHashPowFactory(defaults, hashBuff) {
    return function hashPow(overrides) {
        return createPow(Object.assign({
            verifyInput: buildDefaultVerifyInput,
            hashBuff: hashBuff
        }, defaults || {}), overrides);
    };
}

function createCyclePowFactory(hashMethod, packMethod) {
    return function cyclePow(overrides) {
        return createPow({
            c29(ctx) {
                return ctx.runtime.powHash[hashMethod](ctx.header, ctx.ring);
            },
            packEdges(ctx) {
                return ctx.runtime.powHash[packMethod](ctx.ring);
            }
        }, overrides);
    };
}

const blob = {
    cryptonote(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            convert(ctx) {
                return ctx.runtime.blockTemplate.convert_blob(ctx.blobBuffer, ctx.profile.blobType);
            },
            construct(ctx) {
                return ctx.runtime.blockTemplate.construct_block_blob(ctx.blockTemplateBuffer, Buffer.from(ctx.params.nonce, "hex"), ctx.profile.blobType);
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.get_block_id(ctx.blockBuffer, ctx.profile.blobType);
            }
        }, overrides);
    },
    identity(overrides) {
        return createBlob({
            nonceSize: 8,
            proofSize: 32,
            convert(ctx) {
                return Buffer.from(ctx.blobBuffer);
            },
            construct(ctx) {
                const next = Buffer.alloc(ctx.blockTemplateBuffer.length);
                ctx.blockTemplateBuffer.copy(next);
                return next;
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.get_block_id(ctx.blockBuffer, ctx.profile.blobType);
            }
        }, overrides);
    },
    grin(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            convert(ctx) {
                return ctx.runtime.blockTemplate.convert_blob(ctx.blobBuffer, ctx.profile.blobType);
            },
            construct(ctx) {
                return ctx.runtime.blockTemplate.construct_block_blob(
                    ctx.blockTemplateBuffer,
                    ctx.runtime.toBuffer(ctx.params.nonce, { endian: "little", size: 4 }, 10),
                    ctx.profile.blobType,
                    ctx.params.pow
                );
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.get_block_id(ctx.blockBuffer, ctx.profile.blobType);
            }
        }, overrides);
    },
    dero(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            convert(ctx) {
                return Buffer.from(ctx.blobBuffer);
            },
            construct(ctx) {
                return ctx.runtime.blockTemplate.constructNewDeroBlob(ctx.blockTemplateBuffer, Buffer.from(ctx.params.nonce, "hex"));
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.get_block_id(ctx.blockBuffer, ctx.profile.blobType);
            }
        }, overrides);
    },
    xtmT(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            nonceOffset: 39,
            convert(ctx) {
                return Buffer.from(ctx.blobBuffer);
            },
            construct(ctx) {
                const next = Buffer.alloc(ctx.blockTemplateBuffer.length);
                ctx.blockTemplateBuffer.copy(next);
                Buffer.from(ctx.params.nonce, "hex").copy(next, this.nonceOffset);
                return next;
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.get_block_id(ctx.blockBuffer, ctx.profile.blobType);
            }
        }, overrides);
    },
    raven(overrides) {
        return createBlob({
            nonceSize: 8,
            proofSize: 32,
            convert(ctx) {
                return ctx.runtime.blockTemplate.convertRavenBlob(ctx.blobBuffer);
            },
            construct(ctx) {
                return ctx.runtime.blockTemplate.constructNewRavenBlob(
                    ctx.blockTemplateBuffer,
                    ctx.runtime.toBuffer(ctx.params.nonce, { endian: "little", size: 8 }, 16),
                    ctx.runtime.toBuffer(ctx.params.mixhash, { endian: "little", size: 32 }, 16)
                );
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.get_block_id(ctx.blockBuffer, ctx.profile.blobType);
            }
        }, overrides);
    },
    rtm(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            convert(ctx) {
                return ctx.runtime.blockTemplate.convertRtmBlob(ctx.blobBuffer);
            },
            construct(ctx) {
                return ctx.runtime.blockTemplate.constructNewRtmBlob(ctx.blockTemplateBuffer, Buffer.from(ctx.params.nonce, "hex"));
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.blockHashBuff(ctx.runtime.blockTemplate.convertRtmBlob(ctx.blockBuffer));
            }
        }, overrides);
    },
    kcn(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            convert(ctx) {
                return ctx.runtime.blockTemplate.convertKcnBlob(ctx.blobBuffer);
            },
            construct(ctx) {
                return ctx.runtime.blockTemplate.constructNewKcnBlob(ctx.blockTemplateBuffer, Buffer.from(ctx.params.nonce, "hex"));
            },
            getBlockId(ctx) {
                return ctx.runtime.blockTemplate.blockHashBuff3(ctx.runtime.blockTemplate.convertKcnBlob(ctx.blockBuffer));
            }
        }, overrides);
    }
};

const pow = {
    randomx(overrides) {
        return createPow({
            variant: 0,
            verifyInput(ctx) {
                return buildVerifyInput(ctx.algo, ctx.convertedBlob, { seed_hash: ctx.blockTemplate.seed_hash });
            },
            hashBuff(ctx) {
                return ctx.runtime.powHash.randomx(ctx.convertedBlob, Buffer.from(ctx.blockTemplate.seed_hash, "hex"), this.variant);
            }
        }, overrides);
    },
    cryptonight(overrides) {
        return createPow({
            variant: 0,
            useHeight: false,
            verifyInput(ctx) {
                return buildVerifyInput(ctx.algo, ctx.convertedBlob, this.useHeight ? { height: ctx.blockTemplate.height } : undefined);
            },
            hashBuff(ctx) {
                if (this.useHeight) return ctx.runtime.powHash.cryptonight(ctx.convertedBlob, this.variant, ctx.blockTemplate.height);
                return ctx.runtime.powHash.cryptonight(ctx.convertedBlob, this.variant);
            }
        }, overrides);
    },
    cryptonightHeavy: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.cryptonight_heavy(ctx.convertedBlob, this.variant);
    }),
    cryptonightPico: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.cryptonight_pico(ctx.convertedBlob, this.variant);
    }),
    argon2: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.argon2(ctx.convertedBlob, this.variant);
    }),
    kawpow: createHashPowFactory(null, function hashBuff(ctx) {
        return ctx.runtime.powHash.kawpow(ctx.convertedBlob, Buffer.from(ctx.nonce, "hex"), Buffer.from(ctx.mixhash, "hex"));
    }),
    ethash: createHashPowFactory(null, function hashBuff(ctx) {
        return ctx.runtime.powHash.ethash(ctx.convertedBlob, Buffer.from(ctx.nonce, "hex"), ctx.blockTemplate.height);
    }),
    etchash: createHashPowFactory(null, function hashBuff(ctx) {
        return ctx.runtime.powHash.etchash(ctx.convertedBlob, Buffer.from(ctx.nonce, "hex"), ctx.blockTemplate.height);
    }),
    autolykos2: createHashPowFactory(null, function hashBuff(ctx) {
        return ctx.runtime.powHash.autolykos2_hashes(ctx.convertedBlob, ctx.blockTemplate.height);
    }),
    astrobwt: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.astrobwt(ctx.convertedBlob, this.variant);
    }),
    c29: createCyclePowFactory("c29", "c29_packed_edges"),
    c29v: createCyclePowFactory("c29v", "c29s_packed_edges"),
    c29b: createCyclePowFactory("c29b", "c29b_packed_edges"),
    c29s: createCyclePowFactory("c29s", "c29s_packed_edges")
};

function readUInt64BufferBE(buf, offset = 0) {
    const hi = BigInt(buf.readUInt32BE(offset));
    const lo = BigInt(buf.readUInt32BE(offset + 4));
    return ((hi << 32n) | lo).toString(10);
}

function buildDefaultTarget(ctx) {
    return ctx.getTargetHex(ctx.coinDiff, ctx.coinFuncs.nonceSize(ctx.blobTypeNum));
}

function buildStandardJobPayload(ctx) {
    return {
        blob: ctx.blobHex,
        algo: ctx.params.algo_name,
        height: ctx.blockTemplate.height,
        seed_hash: ctx.blockTemplate.seed_hash,
        job_id: ctx.newJob.id,
        target: buildDefaultTarget(ctx),
        id: ctx.miner.id
    };
}

function buildXtmCJobPayload(ctx) {
    return {
        blob: ctx.blobHex,
        algo: this.jobAlgo || ctx.params.algo_name,
        proofsize: ctx.coinFuncs.c29ProofSize(ctx.blobTypeNum),
        noncebytes: ctx.coinFuncs.nonceSize(ctx.blobTypeNum),
        nonceoffset: 0,
        height: ctx.blockTemplate.height,
        job_id: ctx.newJob.id,
        target: buildDefaultTarget(ctx),
        id: ctx.miner.id
    };
}

function buildGrinJobPayload(ctx) {
    return {
        pre_pow: ctx.blobHex,
        algo: ctx.miner.protocol === "grin" ? (this.jobAlgo || ctx.params.algo_name) : ctx.params.algo_name,
        edgebits: this.edgeBits || 29,
        proofsize: ctx.coinFuncs.c29ProofSize(ctx.blobTypeNum),
        noncebytes: ctx.coinFuncs.nonceSize(ctx.blobTypeNum),
        height: ctx.blockTemplate.height,
        job_id: ctx.newJob.id,
        difficulty: ctx.coinDiff,
        id: ctx.miner.id
    };
}

function buildRavenJobPayload(ctx) {
    return [ctx.newJob.id, ctx.blobHex, ctx.blockTemplate.seed_hash, ctx.getRavenTargetHex(ctx.coinDiff), true, ctx.blockTemplate.height, ctx.blockTemplate.bits];
}

function buildEthJobPayload(ctx) {
    return [ctx.newJob.id, ctx.blockTemplate.seed_hash, ctx.blobHex, true, ctx.coinDiff];
}

function buildErgJobPayload(ctx) {
    return [
        ctx.newJob.id,
        ctx.blockTemplate.height,
        ctx.blockTemplate.hash,
        "",
        "",
        2,
        (ctx.toBigInt(ctx.coinFuncs.baseDiff()) / ctx.toBigInt(ctx.coinDiff)).toString(),
        "",
        true
    ];
}

function buildProxyJobPayload(ctx) {
    return {
        blocktemplate_blob: ctx.blobHex,
        blob_type: ctx.coinFuncs.blobTypeStr(ctx.blockTemplate.port, ctx.blockTemplate.block_version),
        algo: ctx.params.algo_name,
        difficulty: ctx.blockTemplate.difficulty,
        height: ctx.blockTemplate.height,
        seed_hash: ctx.blockTemplate.seed_hash,
        reserved_offset: ctx.blockTemplate.reserved_offset,
        client_nonce_offset: ctx.blockTemplate.clientNonceLocation,
        client_pool_offset: ctx.blockTemplate.clientPoolLocation,
        target_diff: ctx.coinDiff,
        job_id: ctx.newJob.id,
        id: ctx.miner.id
    };
}

function pushStandardJob(ctx) {
    ctx.miner.pushMessage({ method: "job", params: ctx.job });
}

function pushRavenJob(ctx) {
    const target = ctx.job[3];
    if (!ctx.miner.last_target || ctx.miner.last_target !== target) {
        ctx.miner.pushMessage({ method: "mining.set_target", params: [target], id: null });
        ctx.miner.last_target = target;
    }
    ctx.miner.pushMessage({ method: "mining.notify", params: ctx.job, algo: ctx.params.algo_name, id: null });
}

function pushEthJob(ctx) {
    const notifyJob = ctx.job.slice();
    const diff = notifyJob.pop() / 0x100000000;
    if (!ctx.miner.last_diff || ctx.miner.last_diff !== diff) {
        ctx.miner.pushMessage({ method: "mining.set_difficulty", params: [diff] });
        ctx.miner.last_diff = diff;
    }
    ctx.miner.pushMessage({ method: "mining.notify", params: notifyJob, algo: ctx.params.algo_name });
}

function pushErgJob(ctx) {
    ctx.miner.pushMessage({ method: "mining.notify", params: ctx.job, algo: ctx.params.algo_name });
}

function parseUnsupportedMiningSubmit() {
    return false;
}

function parseEthArrayMiningSubmit(ctx) {
    ctx.params.nonce = ctx.params.raw_params[2];
    return true;
}

function parseRavenArrayMiningSubmit(ctx) {
    if (ctx.params.raw_params.length < 5) return false;
    ctx.params.nonce = ctx.params.raw_params[2].substr(2);
    ctx.params.header_hash = ctx.params.raw_params[3].substr(2);
    ctx.params.mixhash = ctx.params.raw_params[4].substr(2);
    return true;
}

function validateStandardSubmit(ctx) {
    if (typeof ctx.params.nonce !== "string") return false;
    if (ctx.coinFuncs.nonceSize(ctx.job.blob_type_num) == 8) {
        if (this.sharedTemplateNonces === true) ctx.params.nonce = ctx.normalizeExtraNonceSubmitNonce(ctx.params.nonce, ctx.job.extraNonce);
        if (!ctx.state.nonceCheck64.test(ctx.params.nonce)) return false;
        if (typeof this.validateExtraSubmitFields === "function" && !this.validateExtraSubmitFields(ctx)) return false;
        return this.sharedTemplateNonces === true || ctx.state.hashCheck32.test(ctx.params.result);
    }
    return ctx.state.nonceCheck32.test(ctx.params.nonce) && ctx.state.hashCheck32.test(ctx.params.result);
}

function validateRavenExtraSubmitFields(ctx) {
    return ctx.state.hashCheck32.test(ctx.params.mixhash) && ctx.state.hashCheck32.test(ctx.params.header_hash);
}

function validateRavenSubmit(ctx) {
    if (typeof ctx.params.nonce !== "string") return false;
    return ctx.state.nonceCheck64.test(ctx.params.nonce) && validateRavenExtraSubmitFields(ctx);
}

function validateProofSubmit(ctx) {
    return typeof ctx.params.nonce === "number" &&
        ctx.params.pow instanceof Array &&
        ctx.params.pow.length === ctx.coinFuncs.c29ProofSize(ctx.job.blob_type_num);
}

function validateXtmCSubmit(ctx) {
    return typeof ctx.params.nonce === "string" &&
        ctx.state.nonceCheck64.test(ctx.params.nonce) &&
        ctx.params.nonce.toLowerCase().startsWith(ctx.miner.eth_extranonce) &&
        ctx.params.pow instanceof Array &&
        ctx.params.pow.length === ctx.coinFuncs.c29ProofSize(ctx.job.blob_type_num);
}

function buildStandardSubmissionKey(ctx) {
    if (ctx.miner.proxy) return `${ctx.params.nonce}_${ctx.params.poolNonce}_${ctx.params.workerNonce}`;
    return ctx.params.nonce;
}

function buildProofSubmissionKey(ctx) {
    const proofKey = ctx.params.pow.join(":");
    if (ctx.miner.proxy) return `${proofKey}_${ctx.params.poolNonce}_${ctx.params.workerNonce}`;
    return proofKey;
}

function getDefaultAuthorizeAlgoState(ctx) {
    const algo = ctx.profile && ctx.profile.algo ? ctx.profile.algo : ctx.coinFuncs.algoShortTypeStr(ctx.port);
    return {
        algos: [algo],
        algosPerf: { [algo]: 1 },
        algoMinTime: 60
    };
}

function attachLoginExtraNonce(ctx) {
    const newId = ctx.socket.eth_extranonce_id ? ctx.socket.eth_extranonce_id : ctx.utils.getNewEthExtranonceId();
    if (newId === null) return false;
    ctx.socket.eth_extranonce_id = newId;
    ctx.miner.eth_extranonce = ctx.utils.ethExtranonce(newId);
    ctx.scheduleFirstShareTimer(ctx.minerId);
    return true;
}

function sendStandardLoginResult(ctx) {
    ctx.sendReply(null, { id: ctx.minerId, job: ctx.miner.getCoinJob(ctx.coin, ctx.jobParams), status: "OK" });
}

function sendExtraNonceLoginResult(ctx) {
    if (!attachLoginExtraNonce(ctx)) {
        ctx.sendReplyFinal("Not enough extranoces. Switch to other pool node.");
        return;
    }
    ctx.sendReply(null, { id: ctx.minerId, algo: ctx.jobParams.algo_name, extra_nonce: ctx.miner.eth_extranonce });
    ctx.miner.sendCoinJob(ctx.coin, ctx.jobParams);
}

function sendXtmCLoginResult(ctx) {
    if (!attachLoginExtraNonce(ctx)) {
        ctx.sendReplyFinal("Not enough extranoces. Switch to other pool node.");
        return;
    }
    const job = ctx.miner.getCoinJob(ctx.coin, ctx.jobParams);
    job.xn = ctx.miner.eth_extranonce;
    ctx.sendReply(null, { id: ctx.minerId, job: job, status: "OK" });
}

function rejectSpecialShare(ctx) {
    ctx.reportMinerShare(ctx.miner, ctx.job);
    ctx.processShareCB(ctx.invalidShare(ctx.miner));
    return true;
}

function verifyXtmCShare(ctx) {
    const header = Buffer.concat([ctx.bigIntToBuffer(BigInt(`0x${ctx.params.nonce}`), { endian: "big", size: 8 }), ctx.blockTemplate.buffer]);
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        const c29PackedEdgesBuff = ctx.coinFuncs.c29_packed_edges(ctx.params.pow, ctx.job.blob_type_num, ctx.blockTemplate.port);
        ctx.job.c29_packed_edges = Array.from(Buffer.from(c29PackedEdgesBuff, "hex"));
        ctx.verifyShareCB(ctx.hashBuffDiff(syntheticResult), syntheticResult, header, false, true);
        return true;
    }
    if (ctx.coinFuncs.c29(header, ctx.params.pow, ctx.blockTemplate.port)) return rejectSpecialShare(ctx);
    const c29PackedEdgesBuff = ctx.coinFuncs.c29_packed_edges(ctx.params.pow, ctx.job.blob_type_num, ctx.blockTemplate.port);
    ctx.job.c29_packed_edges = Array.from(Buffer.from(c29PackedEdgesBuff, "hex"));
    const resultBuff = ctx.coinFuncs.c29_cycle_hash(c29PackedEdgesBuff);
    ctx.verifyShareCB(ctx.hashBuffDiff(resultBuff), resultBuff, header, false, true);
    return true;
}

function verifyGrinShare(ctx) {
    const blockData = ctx.getShareBuffer();
    if (blockData === null) {
        ctx.processShareCB(ctx.invalidShare(ctx.miner));
        return true;
    }
    const header = Buffer.concat([ctx.coinFuncs.convertBlob(blockData, ctx.blockTemplate.port), ctx.bigIntToBuffer(BigInt(ctx.params.nonce), { endian: "big", size: 4 })]);
    if (ctx.coinFuncs.c29(header, ctx.params.pow, ctx.blockTemplate.port)) return rejectSpecialShare(ctx);
    const packedEdges = ctx.coinFuncs.c29_packed_edges(ctx.params.pow, ctx.job.blob_type_num, ctx.blockTemplate.port);
    const resultBuff = ctx.coinFuncs.c29_cycle_hash(packedEdges);
    ctx.verifyShareCB(ctx.hashBuffDiff(resultBuff), resultBuff, blockData, false, true);
    return true;
}

function verifyRavenShare(ctx) {
    const blockData = ctx.getShareBuffer();
    if (blockData === null) {
        ctx.processShareCB(ctx.invalidShare(ctx.miner));
        return true;
    }
    const convertedBlob = ctx.coinFuncs.convertBlob(blockData, ctx.blockTemplate.port);
    if (ctx.params.header_hash !== convertedBlob.toString("hex")) {
        console.error("Wrong header hash:" + ctx.params.header_hash + " " + convertedBlob.toString("hex"));
        return rejectSpecialShare(ctx);
    }
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        ctx.verifyShareCB(ctx.hashRavenBuffDiff(syntheticResult), syntheticResult, blockData, false, true);
        return true;
    }
    const resultBuff = ctx.coinFuncs.slowHashBuff(convertedBlob, ctx.blockTemplate, ctx.params.nonce, ctx.params.mixhash);
    ctx.verifyShareCB(ctx.hashRavenBuffDiff(resultBuff), resultBuff, blockData, false, true);
    return true;
}

function verifyEthShare(ctx) {
    if (ctx.shareThrottled()) return true;
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        const mixHash = ctx.params.raw_params instanceof Array && typeof ctx.params.raw_params[4] === "string"
            ? ctx.params.raw_params[4]
            : `0x${"00".repeat(32)}`;
        ctx.verifyShareCB(
            ctx.hashEthBuffDiff(syntheticResult),
            syntheticResult,
            [`0x${ctx.params.nonce}`, `0x${ctx.blockTemplate.hash}`, mixHash],
            false,
            true
        );
        return true;
    }
    const hashes = ctx.coinFuncs.slowHashBuff(Buffer.from(ctx.blockTemplate.hash, "hex"), ctx.blockTemplate, ctx.params.nonce);
    const resultBuff = hashes[0];
    ctx.verifyShareCB(ctx.hashEthBuffDiff(resultBuff), resultBuff, ["0x" + ctx.params.nonce, "0x" + ctx.blockTemplate.hash, "0x" + hashes[1].toString("hex")], false, true);
    return true;
}

function verifyErgShare(ctx) {
    if (ctx.shareThrottled()) return true;
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        ctx.verifyShareCB(ctx.hashEthBuffDiff(syntheticResult), syntheticResult, ctx.params.nonce, false, true);
        return true;
    }
    const hashes = ctx.coinFuncs.slowHashBuff(Buffer.concat([Buffer.from(ctx.blockTemplate.hash, "hex"), Buffer.from(ctx.params.nonce, "hex")]), ctx.blockTemplate);
    ctx.verifyShareCB(ctx.hashEthBuffDiff(hashes[1]), null, ctx.params.nonce, false, true);
    return true;
}

function acceptDefinedResult(ctx) {
    return !!(ctx.rpcResult && typeof ctx.rpcResult.result !== "undefined");
}

function acceptBooleanTrue(ctx) {
    return !!(ctx.rpcResult && ctx.rpcResult.result === true);
}

function acceptStatusOkObject(ctx) {
    return !!(ctx.rpcResult && typeof ctx.rpcResult.result === "object" && ctx.rpcResult.result && ctx.rpcResult.result.status === "OK");
}

function acceptNonRejectedResponse(ctx) {
    return !!(ctx.rpcResult && ctx.rpcResult.response !== "rejected");
}

function acceptAccepted202String(ctx) {
    return typeof ctx.rpcResult === "string" && ctx.rpcStatus == 202;
}

function resolveDefaultSubmittedBlockHash(ctx, callback) {
    if (ctx.isDisplaySubmitPort && typeof ctx.rpcResult.result === "object" && ctx.rpcResult.result && ctx.coinFuncs.getAuxChainXTM(ctx.rpcResult.result)) {
        return callback(ctx.rpcResult.result._aux.chains[0].block_hash);
    }
    return callback(ctx.coinFuncs.getBlockID(ctx.blockData, ctx.blockTemplate.port).toString("hex"));
}

function resolveDeroSubmittedBlockHash(ctx, callback) {
    return callback(ctx.rpcResult.result.blid);
}

function resolveResultHashSubmittedBlockHash(ctx, callback) {
    return callback(ctx.resultBuff.toString("hex"));
}

function resolveErgSubmittedBlockHash(ctx, callback) {
    return setTimeout(ctx.coinFuncs.getPortBlockHeaderByID, 10 * 1000, ctx.blockTemplate.port, ctx.blockTemplate.height, function onHeader(err, body) {
        callback(err === null && body.powSolutions.pk === ctx.blockTemplate.hash2 ? body.id : "0".repeat(64));
    });
}

function resolveEthSubmittedBlockHash(ctx, callback) {
    return setTimeout(ctx.coinFuncs.ethBlockFind, 30 * 1000, ctx.blockTemplate.port, ctx.blockData[0], function onBlockHash(blockHash) {
        callback(blockHash ? blockHash.substr(2) : "0".repeat(64));
    });
}

function resolveXtmSubmittedBlockHash(ctx, callback) {
    return callback(Buffer.from(ctx.rpcResult.result.block_hash).toString("hex"));
}

function submitCryptonoteBlock(ctx) {
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "submitblock", [ctx.blockData.toString("hex")], ctx.replyFn);
}

function submitHttpBlockBody(ctx) {
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "block", ctx.blockData.toString("hex"), ctx.replyFn);
}

function submitBtcBlock(ctx) {
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "", { method: "submitblock", params: [ctx.blockData.toString("hex")] }, ctx.replyFn);
}

function submitEthBlock(ctx) {
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "", { method: "eth_submitWork", params: ctx.blockData, jsonrpc: "2.0", id: 0 }, ctx.replyFn);
}

function submitErgBlock(ctx) {
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "mining/solution", { n: ctx.blockData }, ctx.replyFn);
}

function submitDeroBlock(ctx) {
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "submitblock", [ctx.blockTemplate.blocktemplate_blob, ctx.blockData.toString("hex")], ctx.replyFn);
}

function submitXtmRxBlock(ctx) {
    ctx.blockTemplate.xtm_block.header.nonce = ctx.blockData.readUInt32BE(3 + 32 + 4).toString();
    ctx.blockTemplate.xtm_block.header.pow.pow_data = [...ctx.blockData.slice(3 + 32 + 8 + 1)];
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "SubmitBlock", ctx.blockTemplate.xtm_block, ctx.replyFn);
}

function submitXtmCBlock(ctx) {
    ctx.blockTemplate.xtm_block.header.nonce = readUInt64BufferBE(ctx.blockData, 0);
    ctx.blockTemplate.xtm_block.header.pow.pow_data = ctx.job.c29_packed_edges;
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "SubmitBlock", ctx.blockTemplate.xtm_block, ctx.replyFn);
}

function submitDualMainBlock(ctx) {
    const isXmr = parseInt(ctx.hashDiff, 10) >= ctx.blockTemplate.xmr_difficulty;
    const isXtm = parseInt(ctx.hashDiff, 10) >= ctx.blockTemplate.xtm_difficulty;
    const mainSubmitPort = ctx.blockTemplate.port + (this.mainSubmitPortOffset || 0);
    const auxSubmitPort = ctx.blockTemplate.port + (this.dualSubmitPortOffset || 0);

    if (isXmr && (!ctx.portUsedToSubmit || ctx.portUsedToSubmit === mainSubmitPort)) {
        ctx.support.rpcPortDaemon(mainSubmitPort, "submitblock", [ctx.blockData.toString("hex")], function onMainSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, mainSubmitPort, ctx.submitBlockCB);
        });
    }
    if (isXtm && (!ctx.portUsedToSubmit || ctx.portUsedToSubmit === auxSubmitPort)) {
        ctx.support.rpcPortDaemon(auxSubmitPort, "submitblock", [ctx.blockData.toString("hex")], function onAuxSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, auxSubmitPort, isXmr ? null : ctx.submitBlockCB);
        });
    }
    if (!isXmr && !isXtm) {
        if (!ctx.suppressFailureEmail) {
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't submit low diff block to deamon on " + ctx.blockTemplate.port + " port", "The pool server: " + global.config.hostname + " can't submit low diff block to deamon on " + ctx.blockTemplate.port + " port");
        }
        ctx.support.rpcPortDaemon(mainSubmitPort, "submitblock", [ctx.blockData.toString("hex")], function onLowMainSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, mainSubmitPort, ctx.submitBlockCB);
        });
        ctx.support.rpcPortDaemon(auxSubmitPort, "submitblock", [ctx.blockData.toString("hex")], function onLowAuxSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, auxSubmitPort, null);
        });
    }
}

const basePoolConfig = {
    // Pool profiles carry executable handlers so the pool modules stay generic.
    minDifficulty: "config",
    niceHashDiffMultiplier: 1,
    buildJobPayload: buildStandardJobPayload,
    buildProxyJobPayload: buildProxyJobPayload,
    pushJob: pushStandardJob,
    parseMiningSubmitParams: parseUnsupportedMiningSubmit,
    validateSubmitParams: validateStandardSubmit,
    submissionKey: buildStandardSubmissionKey,
    submitSuccess: "status",
    authorizeAlgoState: getDefaultAuthorizeAlgoState,
    sendLoginResult: sendStandardLoginResult,
    verifySpecialShare: null,
    acceptSubmittedBlock: acceptDefinedResult,
    resolveSubmittedBlockHash: resolveDefaultSubmittedBlockHash,
    submitBlockRpc: submitCryptonoteBlock,
    sharedTemplateNonces: false,
    useEthJobId: false
};

function createPoolConfig(base, overrides) {
    return mergeSection(mergeSection(basePoolConfig, base), overrides);
}

const pool = {
    standard(overrides) {
        return createPoolConfig({}, overrides);
    },
    raven(overrides) {
        return createPoolConfig({
            minDifficulty: 0.01,
            niceHashDiffMultiplier: 50,
            buildJobPayload: buildRavenJobPayload,
            pushJob: pushRavenJob,
            parseMiningSubmitParams: parseRavenArrayMiningSubmit,
            validateSubmitParams: validateRavenSubmit,
            submitSuccess: "boolean",
            sendLoginResult: sendExtraNonceLoginResult,
            verifySpecialShare: verifyRavenShare,
            resolveSubmittedBlockHash: resolveResultHashSubmittedBlockHash,
            submitBlockRpc: submitBtcBlock,
            useEthJobId: true
        }, overrides);
    },
    eth(overrides) {
        return createPoolConfig({
            minDifficulty: 0.01 * 0x100000000,
            niceHashDiffMultiplier: 50,
            buildJobPayload: buildEthJobPayload,
            pushJob: pushEthJob,
            parseMiningSubmitParams: parseEthArrayMiningSubmit,
            submitSuccess: "boolean",
            sendLoginResult: sendExtraNonceLoginResult,
            verifySpecialShare: verifyEthShare,
            acceptSubmittedBlock: acceptBooleanTrue,
            resolveSubmittedBlockHash: resolveEthSubmittedBlockHash,
            submitBlockRpc: submitEthBlock,
            sharedTemplateNonces: true,
        }, overrides);
    },
    erg(overrides) {
        return createPoolConfig({
            minDifficulty: 0.01 * 0x100000000,
            niceHashDiffMultiplier: 50,
            buildJobPayload: buildErgJobPayload,
            pushJob: pushErgJob,
            parseMiningSubmitParams: parseEthArrayMiningSubmit,
            submitSuccess: "boolean",
            sendLoginResult: sendExtraNonceLoginResult,
            verifySpecialShare: verifyErgShare,
            acceptSubmittedBlock: acceptNonRejectedResponse,
            resolveSubmittedBlockHash: resolveErgSubmittedBlockHash,
            submitBlockRpc: submitErgBlock,
            sharedTemplateNonces: true,
        }, overrides);
    },
    grin(overrides) {
        return createPoolConfig({
            minDifficulty: 1,
            niceHashDiffMultiplier: 1,
            buildJobPayload: buildGrinJobPayload,
            validateSubmitParams: validateProofSubmit,
            submissionKey: buildProofSubmissionKey,
            verifySpecialShare: verifyGrinShare
        }, overrides);
    },
    xtmC(overrides) {
        return createPoolConfig({
            minDifficulty: 1,
            niceHashDiffMultiplier: 1,
            buildJobPayload: buildXtmCJobPayload,
            validateSubmitParams: validateXtmCSubmit,
            submissionKey: buildProofSubmissionKey,
            submitSuccess: "boolean",
            sendLoginResult: sendXtmCLoginResult,
            verifySpecialShare: verifyXtmCShare,
            resolveSubmittedBlockHash: resolveXtmSubmittedBlockHash,
            submitBlockRpc: submitXtmCBlock,
            jobAlgo: "cuckaroo",
            edgeBits: 29
        }, overrides);
    }
};
pool.submitAccept = Object.freeze({
    statusOkObject: acceptStatusOkObject,
    accepted202String: acceptAccepted202String
});
pool.blockHash = Object.freeze({
    deroBlid: resolveDeroSubmittedBlockHash,
    xtmRpcHash: resolveXtmSubmittedBlockHash
});
pool.blockSubmit = Object.freeze({
    httpBlockBody: submitHttpBlockBody,
    btc: submitBtcBlock,
    dero: submitDeroBlock,
    xtmRx: submitXtmRxBlock,
    dualMain: submitDualMainBlock
});

const template = {
    standard(overrides) {
        return mergeSection({
            hashOnly: false,
            bufferField: "blocktemplate_blob",
            reserveOffsetSource: "scan-or-template"
        }, overrides);
    },
    directReserve(overrides) {
        return template.standard(Object.assign({ reserveOffsetSource: "template" }, overrides || {}));
    },
    hashOnly(overrides) {
        return template.standard(Object.assign({ hashOnly: true }, overrides || {}));
    },
    dero(overrides) {
        return template.directReserve(Object.assign({ bufferField: "blockhashing_blob" }, overrides || {}));
    }
};

const btcTemplate = {
    raven(blockTemplate, result, poolAddress) {
        return blockTemplate.RavenBlockTemplate(result, poolAddress);
    },
    rtm(blockTemplate, result, poolAddress) {
        return blockTemplate.RtmBlockTemplate(result, poolAddress);
    }
};

const rpc = {
    cryptonoteGetBlock(overrides) {
        return createCryptonoteRpc("getblock", overrides);
    },
    cryptonoteHeader(overrides) {
        return createCryptonoteRpc("header", overrides);
    },
    btc(overrides) {
        return createBtcRpc(overrides);
    },
    eth(overrides) {
        return createEthRpc(overrides);
    },
    erg(overrides) {
        return createErgRpc(overrides);
    },
    xtmMain(overrides) {
        return createXtmMainRpc(overrides);
    },
    xtmT(overrides) {
        return createXtmTRpc(overrides);
    },
    xtmC(overrides) {
        return createXtmCRpc(overrides);
    },
    dero(overrides) {
        return createDeroRpc(overrides);
    }
};

function createProfilePreset(baseSpec) {
    return function preset(spec) {
        return createProfile(mergeSection(baseSpec, spec));
    };
}

const preset = {
    cryptonote: createProfilePreset({
        blob: blob.cryptonote(),
        pool: pool.standard()
    }),
    cryptonoteGetBlock: createProfilePreset({
        blob: blob.cryptonote(),
        pool: pool.standard(),
        rpc: rpc.cryptonoteGetBlock()
    }),
    cryptonoteHeader: createProfilePreset({
        blob: blob.cryptonote(),
        pool: pool.standard(),
        rpc: rpc.cryptonoteHeader()
    }),
    grinGetBlock: createProfilePreset({
        blob: blob.grin(),
        pool: pool.grin(),
        rpc: rpc.cryptonoteGetBlock()
    }),
    identityHashOnly: createProfilePreset({
        blob: blob.identity(),
        template: template.hashOnly()
    }),
    directReserve: createProfilePreset({
        template: template.directReserve()
    }),
    btcSubmitReserve: createProfilePreset({
        pool: pool.standard({
            submitBlockRpc: pool.blockSubmit.btc
        }),
        template: template.directReserve()
    })
};

module.exports = {
    blob,
    btcTemplate,
    createProfile,
    isCoinProfile,
    pool,
    pow,
    preset,
    rpc,
    template
};
