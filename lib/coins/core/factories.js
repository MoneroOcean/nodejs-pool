"use strict";
const { arr2hex, calcErgReward, calcEthReward } = require("../helpers.js");
const COIN_PROFILE_SYMBOL = Symbol.for("nodejs-pool.coinProfile");
const RAVEN_DIFF_ONE_TARGET = BigInt("0x00000000ff000000000000000000000000000000000000000000000000000000");
const UINT256_MAX = (1n << 256n) - 1n;
const RAVEN_HASHES_PER_DIFFICULTY = Number(UINT256_MAX) / Number(RAVEN_DIFF_ONE_TARGET);
const XTM_T_MINING_HASH_OFFSET = 3;
const XTM_T_MINING_HASH_SIZE = 32;
const XTM_T_NONCE_OFFSET = XTM_T_MINING_HASH_OFFSET + XTM_T_MINING_HASH_SIZE;
const XTM_T_NONCE_SIZE = 8;
const XTM_T_MINER_NONCE_OFFSET = XTM_T_NONCE_OFFSET + 4;
const XTM_T_POW_ALGO_OFFSET = XTM_T_NONCE_OFFSET + XTM_T_NONCE_SIZE;
const XTM_T_POW_DATA_OFFSET = XTM_T_POW_ALGO_OFFSET + 1;
const XTM_T_POW_DATA_SIZE = 32;
const XTM_T_RANDOMXT_POW_ALGO = 2;
const XTM_T_POOL_RESERVED_OFFSET = XTM_T_POW_DATA_OFFSET;
const XTM_CUCKAROO_CYCLE_LENGTH = 42;

/** @param {unknown} value */
function cloneValue(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === "object" && !Buffer.isBuffer(value)) return Object.assign({}, value);
    return value;
}

/** @template T @param {T} value @returns {T} */
function cloneRpcTemplate(value) {
    return JSON.parse(JSON.stringify(value));
}

/** @template {object} T @param {T} base @param {Partial<T>} [overrides] */
function mergeSection(base, overrides) {
    const section = Object.assign({}, base);
    if (!overrides) return section;
    Object.keys(overrides).forEach(function mergeKey(key) {
        Object.assign(section, { [key]: cloneValue(Reflect.get(overrides, key)) });
    });
    return section;
}

/** @template T @param {Partial<T>} base @param {Partial<T>} [overrides] @returns {Partial<T>} */
function mergeOptionalSection(base, overrides) {
    const section = Object.assign({}, base);
    if (!overrides) return section;
    Object.keys(overrides).forEach(function mergeKey(key) {
        Object.assign(section, { [key]: cloneValue(Reflect.get(overrides, key)) });
    });
    return section;
}

/** @param {import("../../../types/coin_profiles").ProfileInput} spec */
function defaultPerfAliases(spec) { return typeof spec.algo === "string" && spec.algo.length > 0 ? [spec.algo] : []; }

/** @param {import("../../../types/coin_profiles").ProfileInput} spec @returns {import("../../../types/coin_profiles").CoinProfile} */
function createProfile(spec) {
    const { algo, blobType, blobTypeName } = spec;
    if (typeof algo !== "string" || !Number.isInteger(blobType) || typeof blobType !== "number" || typeof blobTypeName !== "string") {
        throw new TypeError("Coin profile requires an algorithm, blob type and blob name");
    }
    const displayCoin = spec.displayCoin || spec.coin || "";
    // Normalize optional sections once; handlers consume definite section objects.
    const profile = {
        ...spec,
        algo, blobType, blobTypeName,
        listed: spec.listed !== false,
        displayCoin,
        aliases: Array.from(new Set([...(spec.coin ? [spec.coin] : []), ...(displayCoin ? [displayCoin] : []), ...(spec.aliases || [])].filter(Boolean))),
        blob: mergeSection({ nonceSize: 4, proofSize: 32 }, spec.blob),
        pool: mergeOptionalSection({}, spec.pool),
        template: mergeSection({}, spec.template),
        pow: mergeSection({}, spec.pow),
        rpc: mergeSection({}, spec.rpc),
        perf: mergeSection({ aliases: defaultPerfAliases(spec) }, spec.perf),
        ...(spec.network ? { network: { ...spec.network } } : {}),
        ...(spec.addresses ? { addresses: { ...spec.addresses } } : {}),
        ...(spec.agent ? { agent: { ...spec.agent } } : {}),
        ...(spec.mergedMining ? { mergedMining: { ...spec.mergedMining } } : {}),
        ...(spec.minerAlgoAliases ? { minerAlgoAliases: { ...spec.minerAlgoAliases } } : {})
    };
    Object.defineProperty(profile, COIN_PROFILE_SYMBOL, { value: true });
    return profile;
}

/** @param {unknown} value @returns {value is import("../../../types/coin_profiles").CoinProfile} */
function isCoinProfile(value) {
    return value !== null && typeof value === "object" && Object.getOwnPropertyDescriptor(value, COIN_PROFILE_SYMBOL)?.value === true;
}

/** @param {import("../../../types/coin_profiles").BtcOutput} vout @param {string} address */
function voutPaysAddress(vout, address) {
    if (!address || !vout || !vout.scriptPubKey) return false;
    const scriptPubKey = vout.scriptPubKey;
    if (Array.isArray(scriptPubKey.addresses)) return scriptPubKey.addresses.includes(address);
    return scriptPubKey.address === address;
}

/** @param {import("../../../types/coin_profiles").BtcRewardBlock} block @param {import("../../../types/coin_profiles").RpcSettings} config @param {string} poolAddress @param {boolean} isOurBlock */
function parseBtcReward(block, config, poolAddress, isOurBlock) {
    let reward = 0;
    const sumPoolVout = isOurBlock && config.headerRewardMode === "sum-pool-vout";
    for (const vout of block.tx[0].vout) {
        if (sumPoolVout) {
            if (voutPaysAddress(vout, poolAddress)) reward += vout.value;
        } else if (vout.value > reward) {
            reward = vout.value;
        }
    }
    block.reward = Math.trunc(reward * (config.rewardMultiplier || 1));
    if (config.difficultyMultiplier) block.difficulty *= config.difficultyMultiplier;
    return block;
}

/** @param {unknown} value @returns {import("../../../types/coin_profiles").BtcRewardBlock | null} */
function normalizeBtcRewardBlock(value) {
    const block = asRpcRecord(value);
    const rawTransactions = block ? block["tx"] : null;
    const rawFirstTransaction = Array.isArray(rawTransactions) ? asRpcRecord(rawTransactions[0]) : null;
    const rawVouts = rawFirstTransaction ? rawFirstTransaction["vout"] : null;
    const difficulty = block ? Number(block["difficulty"]) : NaN;
    if (!Array.isArray(rawTransactions) || !Array.isArray(rawVouts) || rawVouts.length === 0
        || !Number.isFinite(difficulty) || difficulty <= 0) return null;
    const vout = [];
    for (const rawVout of rawVouts) {
        const source = asRpcRecord(rawVout);
        const amount = source ? Number(source["value"]) : NaN;
        if (!source || !Number.isFinite(amount) || amount < 0) return null;
        /** @type {import("../../../types/coin_profiles").BtcOutput} */
        const output = { value: amount };
        const script = asRpcRecord(source["scriptPubKey"]);
        if (script) {
            const addresses = Array.isArray(script["addresses"])
                ? script["addresses"].filter(function isAddress(address) { return typeof address === "string"; })
                : [];
            /** @type {{addresses?: string[], address?: string}} */
            const scriptPubKey = {};
            if (addresses.length) scriptPubKey.addresses = addresses;
            if (typeof script["address"] === "string") scriptPubKey.address = script["address"];
            output.scriptPubKey = scriptPubKey;
        }
        vout.push(output);
    }
    /** @type {import("../../../types/coin_profiles").BtcRewardBlock} */
    const normalized = { tx: [{ vout }, ...rawTransactions.slice(1)], difficulty };
    return normalized;
}

/** @param {import("../../../types/coin_profiles").RawBlockHeader} header @returns {import("../../../types/coin_profiles").RawBlockHeader} */
function normalizeDeroHeader(header) {
    const timestamp = Number(header["timestamp"]);
    const difficulty = Number(header["difficulty"]);
    if (Number.isFinite(timestamp)) header["timestamp"] = timestamp / 1000;
    if (Number.isFinite(difficulty)) header["difficulty"] = difficulty * 18;
    return header;
}

/** @param {import("../../../types/coin_profiles").RpcSettings} config @param {{number: string}} block */
function getEthBaseReward(config, block) {
    return typeof config.baseReward === "function" ? config.baseReward(parseEthBlockNumber(block.number)) : config.baseReward;
}

/** @param {unknown} value @returns {value is {result: {gasUsed: string, transactionHash: string}}} */
function isEthReceipt(value) {
    if (!value || typeof value !== "object" || !("result" in value)) return false;
    const result = value.result;
    return result !== null && typeof result === "object" && "gasUsed" in result && "transactionHash" in result &&
        typeof result.gasUsed === "string" && result.gasUsed.trim() !== "" &&
        Number.isFinite(Number(result.gasUsed)) && Number(result.gasUsed) >= 0 && typeof result.transactionHash === "string";
}

/** @param {import("../../../types/coin_profiles").RpcSettings} config @param {number} port @param {import("../../../types/coin_profiles").EthRewardBlock} block @param {import("../../../types/coin_profiles").ProfileRuntime} runtime @param {import("../../../types/coin_profiles").RawReplyCallback} callback @returns {unknown} */
function loadEthBlockReward(config, port, block, runtime, callback) {
    const baseReward = getEthBaseReward(config, block);
    if (typeof baseReward !== "number" || !Number.isFinite(baseReward) || baseReward <= 0) return callback(true, { error: { message: "invalid ETH-family base reward" } });
    const receipts = block.transactions.map(tx => ({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] }));

    if (!receipts.length) {
        block.reward = calcEthReward(block, [], baseReward);
        return callback(null, block);
    }

    return runtime.support.rpcPortDaemon2(port, "", receipts, function onReceipts(body) {
        if (!Array.isArray(body) || body.length !== receipts.length || !body.every(isEthReceipt)) return callback(true, body);
        // Every block transaction needs exactly one receipt before its fee is credited.
        const pending = new Set(block.transactions.map(tx => tx.hash));
        for (const receipt of body) {
            if (!pending.delete(receipt.result.transactionHash)) return callback(true, body);
        }
        if (pending.size !== 0) return callback(true, body);
        block.reward = calcEthReward(block, body, baseReward);
        return callback(null, block);
    });
}

/** @param {string} message */
function createEthRpcTimeoutBody(message) { return { error: { message } }; }

/** @param {string} number */
function parseEthBlockNumber(number) {
    // Ethereum-style RPC returns block numbers as hex strings like "0x1403059".
    // Parse them as base 16 or they collapse to 0 under base-10 parsing.
    return parseInt(number, 16);
}

/** @param {unknown} value @param {number | undefined} height @returns {import("../../../types/coin_profiles").EthRewardBlock | null} */
function normalizeEthRewardBlock(value, height) {
    const block = asRpcRecord(value);
    const rawTransactions = block ? block["transactions"] : null;
    const rawUncles = block ? block["uncles"] : null;
    const number = block?.["number"];
    const hash = block?.["hash"];
    const gasUsed = block?.["gasUsed"];
    if (!Array.isArray(rawTransactions) || !Array.isArray(rawUncles)
        || typeof number !== "string" || typeof hash !== "string"
        || (rawTransactions.length > 0 && (typeof gasUsed !== "string" || !Number.isFinite(Number(gasUsed)) || Number(gasUsed) < 0))) return null;
    const transactions = [];
    for (const rawTransaction of rawTransactions) {
        const transaction = asRpcRecord(rawTransaction);
        const gasPrice = transaction?.["gasPrice"];
        if (!transaction || typeof transaction["hash"] !== "string" || typeof gasPrice !== "string"
            || !Number.isFinite(Number(gasPrice)) || Number(gasPrice) < 0) return null;
        transactions.push({ hash: transaction["hash"], gasPrice });
    }
    /** @type {import("../../../types/coin_profiles").EthRewardBlock} */
    const normalized = { hash, number, gasUsed: typeof gasUsed === "string" ? gasUsed : "0x0", transactions, uncles: rawUncles };
    if (typeof height === "number") normalized.height = height;
    const baseFee = block?.["baseFeePerGas"];
    if (typeof baseFee === "string") normalized.baseFeePerGas = baseFee;
    return normalized;
}

/** @param {number} timeoutMs @param {string} timeoutMessage @param {import("../../../types/coin_profiles").RawReplyCallback} callback */
function createEthRpcFinalizer(timeoutMs, timeoutMessage, callback) {
    let finished = false;
    const timer = setTimeout(function onTimeout() {
        if (finished) return;
        finished = true;
        callback(true, createEthRpcTimeoutBody(timeoutMessage));
    }, timeoutMs);

    /** @param {unknown} err @param {unknown} body */
    return function finish(err, body) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callback(err, body);
    };
}

/** @param {import("../../../types/coin_profiles").RpcSettings} config @param {{number: string}} canonicalBlock @param {{number: string}} uncleBlock */
function createEthUncleReward(config, canonicalBlock, uncleBlock) {
    const rewardMultiplier = config.rewardMultiplier;
    if (typeof rewardMultiplier !== "number" || !Number.isFinite(rewardMultiplier)) return null;
    const baseReward = typeof config.baseReward === "function"
        ? config.baseReward(parseEthBlockNumber(uncleBlock.number))
        : config.uncleBaseReward;
    if (typeof baseReward !== "number" || !Number.isFinite(baseReward)) return null;
    if (config.fixedUncleReward) return baseReward / 32 * rewardMultiplier;
    return (baseReward * (8 - (parseEthBlockNumber(canonicalBlock.number) - parseEthBlockNumber(uncleBlock.number))) / 8) * rewardMultiplier;
}

/** @param {unknown} value @returns {value is import("../../../types/coin_profiles").RpcRecord} */
function isRpcRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {import("../../../types/coin_profiles").RpcRecord | null} */
function asRpcRecord(value) {
    return isRpcRecord(value) ? value : null;
}

/** @param {unknown} body @returns {import("../../../types/coin_profiles").RpcRecord | null} */
function rpcResultRecord(body) {
    const reply = asRpcRecord(body);
    return reply ? asRpcRecord(reply["result"]) : null;
}

/** @param {unknown} body @returns {unknown} */
function rpcResultValue(body) {
    return asRpcRecord(body)?.["result"];
}

/** @param {unknown} body @returns {unknown} */
function rpcError(body) {
    const reply = asRpcRecord(body);
    return reply ? reply["error"] : undefined;
}

/** @param {unknown} value @returns {import("../../../types/coin_profiles").WalletTransfer | null} */
function normalizeWalletTransfer(value) {
    const transfer = asRpcRecord(value);
    if (!transfer) return null;
    const rawAmount = transfer["amount"];
    if (typeof rawAmount !== "number" && (typeof rawAmount !== "string" || rawAmount.trim() === "")) return null;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    /** @type {import("../../../types/coin_profiles").WalletTransfer} */
    const normalized = { amount };
    if (typeof transfer["asset_type"] === "string") normalized.asset_type = transfer["asset_type"];
    if (Array.isArray(transfer["amounts"])) {
        if (transfer["amounts"].some(item => typeof item !== "number" && (typeof item !== "string" || item.trim() === ""))) return null;
        const amounts = transfer["amounts"].map(Number);
        if (!amounts.every(function validAmount(item) { return Number.isFinite(item) && item >= 0; })) return null;
        normalized.amounts = amounts;
    }
    return normalized;
}

/** @param {import("../../../types/coin_profiles").WalletTransfer | null} value @returns {value is import("../../../types/coin_profiles").WalletTransfer} */
function isWalletTransfer(value) { return value !== null; }

/** @param {import("../../../types/coin_profiles").RpcSettings} config @param {import("../../../types/coin_profiles").RpcRecord} body @param {number} rewardCheck @param {number} port @param {import("../../../types/coin_profiles").ProfileRuntime} runtime @param {import("../../../types/coin_profiles").RawReplyCallback} callback @param {boolean | undefined} noErrorReport @returns {unknown} */
function getWalletReward(config, body, rewardCheck, port, runtime, callback, noErrorReport) {
    const result = rpcResultRecord(body);
    const blockHeader = result ? asRpcRecord(result["block_header"]) : null;
    if (!result || !blockHeader) return callback(true, body);
    const requestedHash = result["miner_tx_hash"] === "" ? blockHeader["miner_tx_hash"] : result["miner_tx_hash"];
    let minerTxHash = typeof requestedHash === "string" ? requestedHash : "";
    if (config.walletRewardLookup === false) minerTxHash = "";
    if (!minerTxHash) {
        blockHeader["reward"] = rewardCheck;
        return callback(null, blockHeader);
    }

    return runtime.support.rpcPortWalletShort(port + 1, "get_transfer_by_txid", { txid: minerTxHash }, function onTransfer(body2) {
        const transferResult = rpcResultRecord(body2);
        const transfer = transferResult ? normalizeWalletTransfer(transferResult["transfer"]) : null;
        if (!transferResult || !transfer) {
            const headerWithError = Object.assign({}, blockHeader, {
                error: rpcError(body2) || body2 || { message: "wallet reward lookup failed" },
                errorSource: "wallet_reward_lookup"
            });
            return callback(true, headerWithError);
        }
        const rawTransfers = transferResult["transfers"];
        const normalizedTransfers = Array.isArray(rawTransfers) ? rawTransfers.map(normalizeWalletTransfer) : [];
        if (normalizedTransfers.some(function missing(item) { return item === null; })) return callback(true, body);
        const transfers = normalizedTransfers.filter(isWalletTransfer);
        // Asset-aware coins override this selector in their own coin file.
        let reward = typeof config.selectWalletTransferReward === "function"
            ? config.selectWalletTransferReward({
                body: asRpcRecord(body2) || {},
                rewardCheck,
                runtime,
                transfer,
                transfers
            })
            : transfer.amount;
        reward = Number.isFinite(Number(reward)) ? Number(reward) : transfer.amount;
        if (reward !== rewardCheck) reward = Math.min(reward, rewardCheck);
        if (!config.walletZeroRewardAllowed && reward === 0) return callback(true, body);
        blockHeader["reward"] = reward;
        return callback(null, blockHeader);
    }, noErrorReport);
}

/** @param {string} blockByHashMode @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createCryptonoteRpc(blockByHashMode, overrides) {
    /** @type {import("../../../types/coin_profiles").RpcSettings} */
    const config = mergeSection({
        headerRewardMode: "max-vout",
        unlockConfirmationDepth: 60,
        walletRewardLookup: true,
        walletZeroRewardAllowed: false
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        const method = config.blockByHeightMethod || "getblockheaderbyheight";
        ctx.runtime.support.rpcPortDaemon(ctx.port, method, { height: ctx.blockId }, function onHeader(body) {
            const result = rpcResultRecord(body);
            const header = result ? asRpcRecord(result["block_header"]) : null;
            if (!header) return ctx.callback(true, body);
            return ctx.callback(null, header);
        }, ctx.noErrorReport);
    };

    if (blockByHashMode === "header") {
        config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
            const method = config.blockHeaderByHashMethod || "getblockheaderbyhash";
            ctx.runtime.support.rpcPortDaemon(ctx.port, method, { hash: ctx.blockHash }, function onHeader(body) {
                const result = rpcResultRecord(body);
                const header = result ? asRpcRecord(result["block_header"]) : null;
                if (!header) return ctx.callback(true, body);
                return ctx.callback(null, header);
            }, ctx.noErrorReport);
        };
    } else {
        config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
            const method = config.blockByHashMethod || blockByHashMode;
            ctx.runtime.support.rpcPortDaemon(ctx.port, method, { hash: ctx.blockHash }, function onBlock(body) {
                const reply = asRpcRecord(body);
                const result = rpcResultRecord(body);
                const blockHeader = result ? asRpcRecord(result["block_header"]) : null;
                const blockJson = result ? result["json"] : undefined;
                if (!reply || !result || !blockHeader || typeof blockJson !== "string") return ctx.callback(true, body);
                blockHeader["reward"] = 0;
                let parsedMinerTx;
                try {
                    parsedMinerTx = JSON.parse(blockJson);
                } catch (_parseError) {
                    return ctx.callback(true, body);
                }
                const minerTxRecord = asRpcRecord(parsedMinerTx);
                const minerTx = minerTxRecord ? asRpcRecord(minerTxRecord["miner_tx"]) : null;
                const vouts = minerTx ? minerTx["vout"] : null;
                if (!Array.isArray(vouts) || vouts.length < 1) return ctx.callback(true, body);
                let rewardCheck = 0;
                const amounts = vouts.map(function readAmount(vout) {
                    const amount = asRpcRecord(vout)?.["amount"];
                    return Number(amount);
                });
                if (!amounts.every(Number.isFinite)) return ctx.callback(true, body);
                if (config.headerRewardMode === "first-vout") rewardCheck = amounts[0] || 0;
                else amounts.forEach(function chooseReward(amount) {
                    if (amount > rewardCheck) rewardCheck = amount;
                });

                if (!ctx.isOurBlock) {
                    blockHeader["reward"] = rewardCheck;
                    return ctx.callback(null, blockHeader);
                }

                return getWalletReward(config, reply, rewardCheck, ctx.port, ctx.runtime, ctx.callback, ctx.noErrorReport);
            }, ctx.noErrorReport);
        };
    }

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getlastblockheader", [], function onHeader(body) {
            const result = rpcResultRecord(body);
            const header = result ? asRpcRecord(result["block_header"]) : null;
            if (!header) return ctx.callback(true, body);
            return ctx.callback(null, header);
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon(ctx.port, "getblocktemplate", {
            reserve_size: ctx.port in ctx.runtime.mmPortSet ? ctx.runtime.mmNonceSize + ctx.runtime.poolNonceSize : ctx.runtime.poolNonceSize,
            wallet_address: ctx.runtime.getPoolAddress(ctx.profile)
        }, function onTemplate(body) {
            return ctx.callback(rpcResultRecord(body), rpcError(body));
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createBtcRpc(overrides) {
    /** @type {import("../../../types/coin_profiles").RpcSettings} */
    const config = mergeSection({
        difficultyMultiplier: 1,
        headerRewardMode: "max-vout",
        rewardMultiplier: 1
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getblockhash", params: [ctx.blockId] }, function onHash(body) {
            const rawResult = asRpcRecord(body)?.["result"];
            if (typeof rawResult === "string" || Buffer.isBuffer(rawResult)) {
                return ctx.runtime.coinFuncs.getPortAnyBlockHeaderByHash(ctx.port, rawResult, false, ctx.callback, ctx.noErrorReport);
            }
            return ctx.callback(true, body);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getblock", params: [ctx.blockHash, 2] }, function onBlock(body) {
            const block = normalizeBtcRewardBlock(rpcResultRecord(body));
            if (!block) return ctx.callback(true, body);
            return ctx.callback(null, parseBtcReward(block, config, ctx.runtime.getPoolAddress(ctx.profile), ctx.isOurBlock));
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getbestblockhash" }, function onHash(body) {
            const rawHash = asRpcRecord(body)?.["result"];
            if (typeof rawHash !== "string" && !Buffer.isBuffer(rawHash)) return ctx.callback(true, body);
            const blockHash = Buffer.isBuffer(rawHash) ? rawHash.toString("hex") : rawHash;
            const cacheKey = ctx.port.toString();
            const cache = ctx.runtime.owner.lastBlockCache || (ctx.runtime.owner.lastBlockCache = {});
            if (cache[cacheKey] && cache[cacheKey].hash === blockHash) {
                return ctx.callback(null, cache[cacheKey].header);
            }
            return ctx.runtime.coinFuncs.getPortAnyBlockHeaderByHash(ctx.port, blockHash, false, function onHeader(err, body2) {
                if (err === null && isRpcRecord(body2)) cache[cacheKey] = { hash: blockHash, header: body2 };
                return ctx.callback(err, body2);
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { method: "getblocktemplate", params: [{ capabilities: ["coinbasetxn", "workid", "coinbase/append"], rules: ["segwit"] }] }, function onTemplate(body) {
            const result = rpcResultRecord(body);
            if (!result) return ctx.callback(null, rpcError(body));
            let built;
            try {
                const createBlockTemplate = config.createBlockTemplate;
                if (typeof createBlockTemplate !== "function") return ctx.callback(null, "BTC block template builder unavailable");
                built = createBlockTemplate(ctx.runtime.blockTemplate, result, ctx.runtime.getPoolAddress(ctx.profile));
            } catch (err) {
                // createBlockTemplate (e.g. RtmBlockTemplate) can throw on a malformed daemon reply or
                // an unparseable selected transaction. This runs inside the daemon-RPC reply callback,
                // which jsonRequest invokes OUTSIDE its try/catch, so an uncaught throw here crashes the
                // process. Treat a build failure like a no-result reply: skip this cycle and retry next poll.
                const detail = err instanceof Error ? err.message : String(err);
                console.error(`getblocktemplate build failed (port ${ctx.port}): ${detail}`);
                return ctx.callback(null, detail || "template build failed");
            }
            return ctx.callback(built, null);
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createEthRpc(overrides) {
    /** @type {import("../../../types/coin_profiles").RpcSettings} */
    const config = mergeSection({
        headerProvidesTemplate: true,
        // eth_getWork returns mining work, not a canonical block hash; probing it
        // with eth_getBlockByHash creates false daemon failures.
        liveTipProbe: false,
        rewardMultiplier: 1000000000000000000,
        skipHashFallbackByHeight: true,
        baseReward: 2,
        uncleBaseReward: 2,
        callbackTimeoutMs: 30 * 1000
    }, overrides);
    const callbackTimeoutMs = config.callbackTimeoutMs ?? 30 * 1000;

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        const finish = createEthRpcFinalizer(
            callbackTimeoutMs,
            `ETH block header by height timed out for ${  ctx.port  }/${  ctx.blockId}`,
            ctx.callback
        );
        const numericBlockId = typeof ctx.blockId === "number" ? ctx.blockId : Number(ctx.blockId);
        if (ctx.blockId !== "latest" && (!Number.isSafeInteger(numericBlockId) || numericBlockId < 0)) return finish(true, { error: { message: "invalid ETH block height" } });
        const blockId = ctx.blockId === "latest" ? ctx.blockId : `0x${  numericBlockId.toString(16)}`;
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [blockId, true] }, function onBlock(body) {
            const blockHeight = ctx.blockId === "latest" ? undefined : numericBlockId;
            const block = normalizeEthRewardBlock(rpcResultRecord(body), blockHeight);
            if (!block) return finish(true, body);
            if (ctx.blockId === "latest") return finish(null, block);
            return loadEthBlockReward(config, ctx.port, block, ctx.runtime, finish);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        const finish = createEthRpcFinalizer(
            callbackTimeoutMs,
            `ETH block header by hash timed out for ${  ctx.port  }/${  ctx.blockHash}`,
            ctx.callback
        );
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByHash", params: [`0x${  ctx.blockHash}`, true] }, function onBlock(body) {
            const block = normalizeEthRewardBlock(rpcResultRecord(body), undefined);
            if (!block) return finish(true, body);
            const blockHeight = parseEthBlockNumber(block.number);
            if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) return finish(true, body);
            block.height = blockHeight;
            return ctx.runtime.coinFuncs.getPortBlockHeaderByID(ctx.port, blockHeight, function onCanonical(err, canonical) {
                const canonicalRecord = asRpcRecord(canonical);
                const canonicalHash = canonicalRecord?.["hash"];
                const canonicalNumber = canonicalRecord?.["number"];
                if (err || !canonicalRecord || typeof canonicalHash !== "string") return finish(true, body);
                if (block.hash === canonicalHash) return loadEthBlockReward(config, ctx.port, block, ctx.runtime, finish);

                // Hash isn't the canonical block at its height, so it may be an uncle: scan a window of
                // neighbouring heights (height-7 .. height+8) for the block that references it as an uncle.
                const nearbyHeights = Array.from({ length: 16 }, function mapHeight(_value, index) {
                    return blockHeight + index - 7;
                });
                return (function scanNearbyHeight(index) {
                    if (index >= nearbyHeights.length) {
                        // Not the canonical block at its height and not referenced as an uncle within
                        // the inclusion window -> a true orphan. ETH-family headers carry no
                        // confirmations/topoheight, so without this an orphaned found block is treated
                        // as valid and paid out: neither checkOrphans (mo_altblockmanager) nor
                        // isAltblockOrphanResponse (block_manager) detect it, and the height-fallback
                        // is gated behind a non-null error which this success path does not set. Mark
                        // it with the confirmations=-1 sentinel both already recognise. The canonical
                        // (hash===canonical) and uncle (createEthUncleReward) branches never reach here,
                // so valid blocks and uncles are not affected.
                        block.reward = null;
                        block.confirmations = -1;
                        return finish(null, block);
                    }
                    const nearbyHeight = nearbyHeights[index];
                    if (nearbyHeight === undefined) return scanNearbyHeight(index + 1);
                    ctx.runtime.coinFuncs.getPortBlockHeaderByID(ctx.port, nearbyHeight, function onHeader(err2, blockHeader) {
                        if (err2) {
                            if (ctx.isOurBlock) return finish(true, body);
                            return scanNearbyHeight(index + 1);
                        }
                        if (!blockHeader) return scanNearbyHeight(index + 1);
                        const headerRecord = asRpcRecord(blockHeader);
                        const uncles = headerRecord?.["uncles"];
                        const uncleIndex = Array.isArray(uncles) ? uncles.indexOf(`0x${  ctx.blockHash}`) : -1;
                        if (uncleIndex === -1) return scanNearbyHeight(index + 1);
                        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getUncleByBlockNumberAndIndex", params: [`0x${  nearbyHeight.toString(16)}`, `0x${  uncleIndex.toString(16)}`] }, function onUncle(bodyUncle) {
                            const uncle = rpcResultRecord(bodyUncle);
                            const uncleNumber = uncle?.["number"];
                            if (!uncle || typeof uncleNumber !== "string" || typeof canonicalNumber !== "string") return scanNearbyHeight(index + 1);
                            const uncleReward = createEthUncleReward(config, { number: canonicalNumber }, { number: uncleNumber });
                            if (uncleReward === null) return scanNearbyHeight(index + 1);
                            block.reward = uncleReward;
                            return finish(null, block);
                        }, ctx.noErrorReport);
                    }, ctx.noErrorReport);
                }(0));
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getWork", params: [] }, function onWork(body) {
            const work = rpcResultValue(body);
            if (!work || !Array.isArray(work)) return ctx.callback(true, body);
            const bt = ctx.runtime.blockTemplate.EthBlockTemplate(work);
            return ctx.callback(null, { hash: bt.hash, timestamp: Date.now() / 1000, difficulty: bt.difficulty, height: bt.height, seed_hash: bt.seed_hash });
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", { jsonrpc: "2.0", id: 1, method: "eth_getWork", params: [] }, function onWork(body) {
            const work = rpcResultValue(body);
            return ctx.callback(work ? ctx.runtime.blockTemplate.EthBlockTemplate(work) : null, rpcError(body));
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {unknown} value @returns {{header: import("../../../types/coin_profiles").RawBlockHeader & {height: number}, blockTransactions: {transactions: unknown[]}} | null} */
function normalizeErgBlock(value) {
    const block = asRpcRecord(value);
    const header = block ? asRpcRecord(block["header"]) : null;
    const blockTransactions = block ? asRpcRecord(block["blockTransactions"]) : null;
    const transactions = blockTransactions?.["transactions"];
    const height = header ? Number(header["height"]) : NaN;
    if (!header || !blockTransactions || !Array.isArray(transactions) || !Number.isSafeInteger(height) || height < 0) return null;
    /** @type {import("../../../types/coin_profiles").RawBlockHeader & {height: number}} */
    const normalizedHeader = Object.assign(header, { height });
    return { header: normalizedHeader, blockTransactions: { transactions } };
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createErgRpc(overrides) {
    // mining/candidate returns candidate work, not necessarily an indexed block id.
    /** @type {import("../../../types/coin_profiles").RpcSettings} */
    const config = mergeSection({ liveTipProbe: false }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, `blocks/at/${  ctx.blockId}`, null, function onHeight(body) {
            if (!Array.isArray(body) || body.length !== 1 || (typeof body[0] !== "string" && !Buffer.isBuffer(body[0]))) return ctx.callback(true, body);
            return ctx.runtime.coinFuncs.getPortAnyBlockHeaderByHash(ctx.port, body[0], false, ctx.callback, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        return ctx.runtime.support.rpcPortDaemon2(ctx.port, `blocks/${  ctx.blockHash}`, null, function onBlock(body) {
            const block = normalizeErgBlock(body);
            if (!block || typeof block.header["id"] !== "string") return ctx.callback(true, body);
            // The Ergo node serves forked/orphaned blocks by id (blocks/{id}) with HTTP 200, and the
            // header carries no orphan marker, so without this an orphaned found block returns as a
            // clean success and gets paid (same class as the eth-family fix). Confirm it is the
            // canonical block at its height; if a DIFFERENT single canonical id occupies that height,
            // mark it orphan with confirmations=-1 (the sentinel checkOrphans / isAltblockOrphanResponse
            // recognise). On any ambiguity (lookup unavailable / multiple ids) fall through to the
            // normal path so a real block is never wrongly rejected.
            return ctx.runtime.support.rpcPortDaemon2(ctx.port, `blocks/at/${  block.header.height}`, null, function onCanonical(ids) {
                if (Array.isArray(ids) && ids.length === 1 && ids[0] !== block.header["id"]) {
                    block.header["reward"] = null;
                    block.header["confirmations"] = -1;
                    return ctx.callback(null, block.header);
                }
                const reward = calcErgReward(block.header.height, block.blockTransactions.transactions);
                if (reward === null || !Number.isSafeInteger(reward) || reward <= 0) {
                    block.header["reward"] = null;
                    block.header["error"] = { message: "Ergo daemon reward data failed EIP-27 validation" };
                    block.header["errorSource"] = "erg_reward_validation";
                    return ctx.callback(true, block.header);
                }
                block.header["reward"] = reward;
                return ctx.callback(null, block.header);
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "mining/candidate", null, function onCandidate(body) {
            const candidate = asRpcRecord(body);
            if (!candidate || !candidate["pk"]) return ctx.callback(true, body);
            const bt = ctx.runtime.blockTemplate.ErgBlockTemplate(candidate);
            return ctx.callback(null, { hash: bt.hash, timestamp: Date.now() / 1000, difficulty: bt.difficulty, height: bt.height, hash2: bt.hash2 });
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "mining/candidate", null, function onCandidate(body) {
            const candidate = asRpcRecord(body);
            return ctx.callback(candidate && candidate["pk"] ? ctx.runtime.blockTemplate.ErgBlockTemplate(candidate) : null, rpcError(body));
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {import("../../../types/coin_profiles").RpcContext} ctx */
function xtmCoinbases(ctx) {
    return [{ address: ctx.runtime.getPoolAddress(ctx.profile), value: 1, stealth_payment: true, revealed_value_proof: true, coinbase_extra: [] }];
}

/** @param {unknown} value @returns {number | null} */
function parseFiniteRpcNumber(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value @param {boolean} includeHeight @returns {{block: import("../../../types/coin_profiles").RpcRecord, difficulty: number, reward: number, height?: number, mergeMiningHash: unknown, vmKey: unknown} | null} */
function normalizeXtmTemplate(value, includeHeight) {
    const result = asRpcRecord(value);
    const block = result ? asRpcRecord(result["block"]) : null;
    const minerData = result ? asRpcRecord(result["miner_data"]) : null;
    const difficulty = minerData ? parseFiniteRpcNumber(minerData["target_difficulty"]) : null;
    const reward = minerData ? parseFiniteRpcNumber(minerData["reward"]) : null;
    if (!result || !block || !minerData || difficulty === null || difficulty < 0 || reward === null || reward < 0) return null;
    const normalized = {
        block,
        difficulty,
        reward,
        mergeMiningHash: result["merge_mining_hash"],
        vmKey: result["vm_key"]
    };
    if (!includeHeight) return normalized;
    const header = asRpcRecord(block["header"]);
    const height = header ? parseFiniteRpcNumber(header["height"]) : null;
    if (height === null || !Number.isSafeInteger(height) || height < 0) return null;
    return Object.assign(normalized, { height });
}

/** @param {unknown} value @returns {value is number[]} */
function isRpcByteArray(value) {
    return Array.isArray(value) && value.every(function isByte(item) {
        return typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255;
    });
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createXtmBaseRpc(overrides) {
    /** @type {import("../../../types/coin_profiles").RpcSettings} */
    const config = {};
    config.enrichLastBlockHeader = function enrichLastBlockHeader(ctx) {
        return ctx.runtime.coinFuncs.getPortBlockTemplate(ctx.port, function onTemplate(bt) {
            const template = asRpcRecord(bt);
            const reward = template ? parseFiniteRpcNumber(template["reward"]) : null;
            const difficulty = template ? parseFiniteRpcNumber(template["difficulty"]) : null;
            if (!template || reward === null || difficulty === null) return ctx.callback(true, ctx.header);
            ctx.header["reward"] = reward;
            ctx.header["difficulty"] = difficulty;
            return ctx.callback(null, ctx.header);
        }, ctx.noErrorReport);
    };
    return mergeSection(config, overrides);
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createXtmMainRpc(overrides) {
    const config = createXtmBaseRpc(overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "GetBlocks", { heights: [ctx.blockId] }, function onBlocks(body) {
            const result = rpcResultValue(body);
            const first = Array.isArray(result) && result.length === 1 ? asRpcRecord(result[0]) : null;
            const block = first ? asRpcRecord(first["block"]) : null;
            const header = block ? asRpcRecord(block["header"]) : null;
            if (header) return ctx.callback(null, arr2hex(header));
            return ctx.callback(true, body);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "GetHeaderByHash", { hash: Buffer.from(ctx.blockHash, "hex").toJSON().data }, function onHeader(body) {
            const result = rpcResultRecord(body);
            const header = result ? asRpcRecord(result["header"]) : null;
            const height = header ? parseFiniteRpcNumber(header["height"]) : null;
            const reward = result ? parseFiniteRpcNumber(result["reward"]) : null;
            if (!header || height === null || reward === null) return ctx.callback(true, body);
            header["height"] = Math.trunc(height);
            header["reward"] = reward;
            return ctx.callback(null, arr2hex(header));
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "GetTipInfo", null, function onTip(body) {
            const result = rpcResultRecord(body);
            const metadata = result ? asRpcRecord(result["metadata"]) : null;
            const height = metadata ? parseFiniteRpcNumber(metadata["best_block_height"]) : null;
            const hash = metadata?.["best_block_hash"];
            if (!metadata || height === null || typeof hash !== "string") return ctx.callback(true, body);
            metadata["height"] = Math.trunc(height);
            metadata["hash"] = hash;
            return ctx.callback(null, arr2hex(metadata));
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "GetNewBlockTemplateWithCoinbases", {
            algo: { pow_algo: 0 },
            coinbases: xtmCoinbases(ctx)
        }, function onTemplate(body) {
            const template = normalizeXtmTemplate(rpcResultValue(body), false);
            if (!template) return ctx.callback(null, rpcError(body));
            template.block["difficulty"] = template.difficulty;
            template.block["reward"] = template.reward;
            return ctx.callback(arr2hex(template.block), null);
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {import("../../../types/coin_profiles").RpcSettings} config */
function assignXtmMainHeaderRpc(config) {
    const mainConfig = createXtmMainRpc();
    if (typeof mainConfig.getBlockHeaderById === "function") config.getBlockHeaderById = mainConfig.getBlockHeaderById;
    if (typeof mainConfig.getAnyBlockHeaderByHash === "function") config.getAnyBlockHeaderByHash = mainConfig.getAnyBlockHeaderByHash;
    if (typeof mainConfig.getLastBlockHeader === "function") config.getLastBlockHeader = mainConfig.getLastBlockHeader;
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createXtmTRpc(overrides) {
    const config = createXtmBaseRpc(overrides);

    assignXtmMainHeaderRpc(config);

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "GetNewBlockTemplateWithCoinbases", {
            algo: { pow_algo: 2 },
            coinbases: xtmCoinbases(ctx)
        }, function onTemplate(body) {
            const template = normalizeXtmTemplate(rpcResultValue(body), true);
            if (!template || !isRpcByteArray(template.mergeMiningHash) || !isRpcByteArray(template.vmKey)) {
                return ctx.runtime.coinFuncs.getPortBlockTemplate(ctx.port, function retry(bt2, err2) { return ctx.callback(bt2, err2 || rpcError(body)); }, ctx.noErrorReport);
            }
            return ctx.callback({
                blocktemplate_blob: "00".repeat(XTM_T_MINING_HASH_OFFSET)
                    + arr2hex(template.mergeMiningHash)
                    + "00".repeat(XTM_T_NONCE_SIZE)
                    + XTM_T_RANDOMXT_POW_ALGO.toString(16).padStart(2, "0")
                    + "00".repeat(XTM_T_POW_DATA_SIZE),
                seed_hash: arr2hex(template.vmKey),
                // Tari's own XMRig proxy reserves bytes 35..39, but the pool
                // needs a full 16-byte Monero-style reserve for xmr-node-proxy.
                // RandomXT currently permits up to 32 bytes of pow_data, and
                // submitXtmRxBlock copies these mined bytes into SubmitBlock.
                // Keep bytes 35..42 for the miner nonce and place the pool
                // reserve inside pow_data without touching pow_algo at byte 43.
                reserved_offset: XTM_T_POOL_RESERVED_OFFSET,
                difficulty: template.difficulty,
                reward: template.reward,
                height: template.height,
                xtm_block: template.block
            }, null);
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createXtmCRpc(overrides) {
    const config = createXtmBaseRpc(overrides);

    assignXtmMainHeaderRpc(config);

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "GetNewBlockTemplateWithCoinbases", {
            algo: { pow_algo: 3 },
            coinbases: xtmCoinbases(ctx)
        }, function onTemplate(body) {
            const template = normalizeXtmTemplate(rpcResultValue(body), true);
            if (!template || !isRpcByteArray(template.mergeMiningHash)) {
                return ctx.runtime.coinFuncs.getPortBlockTemplate(ctx.port, function retry(bt2, err2) { return ctx.callback(bt2, err2 || rpcError(body)); }, ctx.noErrorReport);
            }
            return ctx.callback({
                blocktemplate_blob: arr2hex(template.mergeMiningHash),
                reserved_offset: 0,
                bt_nonce_size: 8,
                difficulty: template.difficulty,
                reward: template.reward,
                height: template.height,
                xtm_block: template.block
            }, null);
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
function createDeroRpc(overrides) {
    /** @type {import("../../../types/coin_profiles").RpcSettings} */
    const config = mergeSection({
        unlockConfirmationDepth: 30,
        walletRewardLookup: true
    }, overrides);

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "getblockheaderbyheight", { height: ctx.blockId }, function onHeader(body) {
            const result = rpcResultRecord(body);
            const header = result ? asRpcRecord(result["block_header"]) : null;
            if (!header) return ctx.callback(true, body);
            return ctx.callback(null, normalizeDeroHeader(header));
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "getblockheaderbyhash", { hash: ctx.blockHash }, function onHeader(body) {
            const result = rpcResultRecord(body);
            const header = result ? asRpcRecord(result["block_header"]) : null;
            if (!header) return ctx.callback(true, body);
            return ctx.callback(null, normalizeDeroHeader(header));
        }, ctx.noErrorReport);
    };

    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "getlastblockheader", [], function onHeader(body) {
            const result = rpcResultRecord(body);
            const header = result ? asRpcRecord(result["block_header"]) : null;
            if (!header) return ctx.callback(true, body);
            return ctx.callback(null, normalizeDeroHeader(header));
        }, ctx.noErrorReport);
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        return ctx.runtime.support.rpcPortDaemon(ctx.port, "getblocktemplate", {
            reserve_size: ctx.port in ctx.runtime.mmPortSet ? ctx.runtime.mmNonceSize + ctx.runtime.poolNonceSize : ctx.runtime.poolNonceSize,
            wallet_address: ctx.runtime.getPoolAddress(ctx.profile)
        }, function onTemplate(body) {
            const result = rpcResultRecord(body);
            const timestamp = result ? parseFiniteRpcNumber(result["timestamp"]) : null;
            const difficulty = result ? parseFiniteRpcNumber(result["difficulty"]) : null;
            const blockHashingBlob = result?.["blockhashing_blob"];
            if (!result || timestamp === null || timestamp < 0 || difficulty === null || difficulty <= 0 || typeof blockHashingBlob !== "string") {
                return ctx.callback(null, rpcError(body));
            }
            result["timestamp"] = timestamp / 1000;
            const normalizedDifficulty = difficulty * 18;
            result["difficulty"] = normalizedDifficulty;
            result["mbl_difficulty"] = blockHashingBlob.charAt(0) === "4" ? normalizedDifficulty : normalizedDifficulty * 9;
            result["reserved_offset"] = 36;
            return ctx.callback(result, null);
        }, ctx.noErrorReport);
    };

    return config;
}

/** @param {import("../../../types/coin_profiles").BlobSettings} base @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
function createBlob(base, overrides) { return mergeSection(base, overrides); }

/** @param {import("../../../types/coin_profiles").PowSettings} base @param {Partial<import("../../../types/coin_profiles").PowSettings>} [overrides] */
function createPow(base, overrides) { return mergeSection(base, overrides); }

/** @param {string} algo @param {Buffer} convertedBlob @param {{seed_hash?: string | undefined, height?: number | undefined, nonce?: string | undefined, mixhash?: string | undefined}} [extras] */
function buildVerifyInput(algo, convertedBlob, extras) {
    return {
        algo, blob: convertedBlob.toString("hex"),
        ...(extras?.seed_hash !== undefined ? { seed_hash: extras.seed_hash } : {}),
        ...(extras?.height !== undefined ? { height: extras.height } : {}),
        ...(extras?.nonce !== undefined ? { nonce: extras.nonce } : {}),
        ...(extras?.mixhash !== undefined ? { mixhash: extras.mixhash } : {})
    };
}

/** @param {import("../../../types/coin_profiles").HashContext} ctx */
function buildDefaultVerifyInput(ctx) { return buildVerifyInput(ctx.algo, ctx.convertedBlob); }

/** @param {import("../../../types/coin_profiles").PowSettings} defaults @param {NonNullable<import("../../../types/coin_profiles").PowSettings["hashBuff"]>} hashBuff */
function createHashPowFactory(defaults, hashBuff) {
    /** @param {Partial<import("../../../types/coin_profiles").PowSettings>} [overrides] */
    return function hashPow(overrides) {
        return createPow(Object.assign({
            verifyInput: buildDefaultVerifyInput,
            hashBuff
        }, defaults || {}), overrides);
    };
}

/** @param {"c29" | "c29v" | "c29b" | "c29s"} hashMethod @param {"c29_packed_edges" | "c29s_packed_edges" | "c29b_packed_edges"} packMethod */
function createCyclePowFactory(hashMethod, packMethod) {
    /** @param {Partial<import("../../../types/coin_profiles").PowSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
    xtmT(overrides) {
        return createBlob({
            nonceSize: 4,
            proofSize: 32,
            nonceOffset: XTM_T_MINER_NONCE_OFFSET,
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").BlobSettings>} [overrides] */
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
    /** @param {Partial<import("../../../types/coin_profiles").PowSettings>} [overrides] */
    randomx(overrides) {
        return createPow({
            variant: 0,
            verifyInput(ctx) {
                const seedHash = ctx.blockTemplate.seed_hash;
                if (typeof seedHash !== "string") throw new TypeError("RandomX template requires a seed hash");
                return buildVerifyInput(ctx.algo, ctx.convertedBlob, { seed_hash: seedHash });
            },
            hashBuff(ctx) {
                const seedHash = ctx.blockTemplate.seed_hash;
                if (typeof seedHash !== "string") return false;
                return ctx.runtime.powHash.randomx(ctx.convertedBlob, Buffer.from(seedHash, "hex"), this.variant ?? 0);
            }
        }, overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").PowSettings>} [overrides] */
    cryptonight(overrides) {
        return createPow({
            variant: 0,
            useHeight: false,
            verifyInput(ctx) {
                return buildVerifyInput(ctx.algo, ctx.convertedBlob, this.useHeight ? { height: ctx.blockTemplate.height } : undefined);
            },
            hashBuff(ctx) {
                if (this.useHeight) return ctx.runtime.powHash.cryptonight(ctx.convertedBlob, this.variant ?? 0, ctx.blockTemplate.height);
                return ctx.runtime.powHash.cryptonight(ctx.convertedBlob, this.variant ?? 0);
            }
        }, overrides);
    },
    cryptonightHeavy: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.cryptonight_heavy(ctx.convertedBlob, this.variant ?? 0);
    }),
    cryptonightPico: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.cryptonight_pico(ctx.convertedBlob, this.variant ?? 0);
    }),
    argon2: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.argon2(ctx.convertedBlob, this.variant ?? 0);
    }),
    kawpow: createHashPowFactory({
        verifyInput(ctx) {
            return buildVerifyInput(ctx.algo, ctx.convertedBlob, {
                height: ctx.blockTemplate.height,
                mixhash: ctx.mixhash,
                nonce: ctx.nonce
            });
        }
    }, function hashBuff(ctx) {
        if (typeof ctx.nonce !== "string" || typeof ctx.mixhash !== "string") return false;
        const hashes = ctx.runtime.powHash.kawpow_light(ctx.convertedBlob, Buffer.from(ctx.nonce, "hex"), ctx.blockTemplate.height);
        return hashes[1].equals(Buffer.from(ctx.mixhash, "hex")) ? hashes[0] : false;
    }),
    ethash: createHashPowFactory({
        verifyInput(ctx) {
            return buildVerifyInput(ctx.algo, ctx.convertedBlob, {
                height: ctx.blockTemplate.height,
                nonce: ctx.nonce
            });
        }
    }, function hashBuff(ctx) {
        if (typeof ctx.nonce !== "string") return false;
        return ctx.runtime.powHash.ethash(ctx.convertedBlob, Buffer.from(ctx.nonce, "hex"), ctx.blockTemplate.height);
    }),
    etchash: createHashPowFactory({
        verifyInput(ctx) {
            return buildVerifyInput(ctx.algo, ctx.convertedBlob, {
                height: ctx.blockTemplate.height,
                nonce: ctx.nonce
            });
        }
    }, function hashBuff(ctx) {
        if (typeof ctx.nonce !== "string") return false;
        return ctx.runtime.powHash.etchash(ctx.convertedBlob, Buffer.from(ctx.nonce, "hex"), ctx.blockTemplate.height);
    }),
    autolykos2: createHashPowFactory({
        verifyInput(ctx) {
            return buildVerifyInput(ctx.algo, ctx.convertedBlob, { height: ctx.blockTemplate.height });
        }
    }, function hashBuff(ctx) {
        return ctx.runtime.powHash.autolykos2_hashes(ctx.convertedBlob, ctx.blockTemplate.height);
    }),
    astrobwt: createHashPowFactory({ variant: 0 }, function hashBuff(ctx) {
        return ctx.runtime.powHash.astrobwt(ctx.convertedBlob, this.variant ?? 0);
    }),
    c29: createCyclePowFactory("c29", "c29_packed_edges"),
    c29v: createCyclePowFactory("c29v", "c29s_packed_edges"),
    c29b: createCyclePowFactory("c29b", "c29b_packed_edges"),
    c29s: createCyclePowFactory("c29s", "c29s_packed_edges")
};

/** @param {Buffer} buf @param {number} [offset] */
function readUInt64BufferBE(buf, offset = 0) {
    if (!Buffer.isBuffer(buf)) throw new TypeError("XTM nonce read expected Buffer");

    /*
     * Do not use Buffer.readUInt32BE here.
     *
     * Production XTM-T submits on Node v24/V8 13.6 have twice observed
     * Buffer.readUInt32BE returning a fractional uint32 value such as
     * 2200978431.9999986 or 3447195903.9999986 while the same Buffer's
     * indexed bytes and DataView backing-store reads were the correct
     * integers. That made a valid block fail before it reached the daemon.
     *
     * DataView#getUint32 reads the Buffer's ArrayBuffer backing store
     * directly and matched the actual bytes in those incidents, so this
     * block-critical nonce conversion intentionally avoids Buffer's uint32
     * helper.
     */
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const hi = BigInt(view.getUint32(offset, false));
    const lo = BigInt(view.getUint32(offset + 4, false));
    return ((hi << 32n) | lo).toString(10);
}

/** @typedef {import("../../../types/pool_profiles").PoolBlockTemplate} PoolBlockTemplate */
/** @typedef {import("../../../types/pool_profiles").PoolJob} PoolJob */
/** @typedef {import("../../../types/pool_profiles").PoolJobParams} PoolJobParams */
/** @typedef {import("../../../types/pool_profiles").PoolMinerView} PoolMinerView */
/** @typedef {import("../../../types/pool_profiles").BuildJobContext} BuildJobContext */
/** @typedef {import("../../../types/pool_profiles").PushJobContext} PushJobContext */
/** @typedef {import("../../../types/pool_profiles").PoolAuthorizeAlgoContext} PoolAuthorizeAlgoContext */
/** @typedef {import("../../../types/pool_profiles").PoolAuthorizeAlgoState} PoolAuthorizeAlgoState */
/** @typedef {import("../../../types/pool_profiles").PoolLoginContext} PoolLoginContext */
/** @typedef {import("../../../types/pool_profiles").PoolExtraNonceLoginContext} PoolExtraNonceLoginContext */
/** @typedef {import("../../../types/pool_profiles").PoolSubmitContext} PoolSubmitContext */
/** @typedef {import("../../../types/pool_profiles").PoolSubmissionKeyContext} PoolSubmissionKeyContext */
/** @typedef {import("../../../types/pool_profiles").PoolSpecialShareContext} PoolSpecialShareContext */
/** @typedef {import("../../../types/pool_profiles").PoolBlockAcceptanceContext} PoolBlockAcceptanceContext */
/** @typedef {import("../../../types/pool_profiles").PoolBlockHashContext} PoolBlockHashContext */
/** @typedef {import("../../../types/pool_profiles").PoolSubmitBlockContext} PoolSubmitBlockContext */
/** @typedef {import("../../../types/pool_profiles").PoolProfileSettings} PoolProfileSettings */
/** @typedef {import("../../../types/pool_profiles").PoolJobPayload} PoolJobPayload */
/** @typedef {import("../../../types/pool_profiles").PoolSubmitParams} PoolSubmitParams */
/** @typedef {import("../../../types/pool_profiles").PoolRpcResult} PoolRpcResult */
/** @typedef {import("../../../types/pool_profiles").PoolAccepted202Context} PoolAccepted202Context */
/** @typedef {import("../../../types/runtime").ProtoMessage & {method: string, params: PoolJobPayload, algo?: string, id?: null}} PoolPushMessage */

/** @param {BuildJobContext} ctx @returns {string} */
function buildDefaultTarget(ctx) { return ctx.getTargetHex(ctx.coinDiff, ctx.coinFuncs.nonceSize(ctx.blobTypeNum)); }

/** @param {BuildJobContext} ctx @returns {PoolJobPayload} */
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

/** @this {PoolProfileSettings} @param {BuildJobContext} ctx @returns {PoolJobPayload} */
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
        xn: ctx.miner.eth_extranonce,
        id: ctx.miner.id
    };
}

/** @this {PoolProfileSettings} @param {BuildJobContext} ctx @returns {PoolJobPayload} */
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

/** @param {BuildJobContext} ctx @returns {PoolJobPayload} */
function buildRavenJobPayload(ctx) {
    return [ctx.newJob.id, ctx.blobHex, ctx.blockTemplate.seed_hash, ctx.getRavenTargetHex(ctx.coinDiff), true, ctx.blockTemplate.height, ctx.blockTemplate.bits];
}

/** @param {BuildJobContext} ctx @returns {PoolJobPayload} */
function buildEthJobPayload(ctx) {
    return [ctx.newJob.id, ctx.blockTemplate.seed_hash, ctx.blobHex, true, ctx.coinDiff];
}

/** @param {BuildJobContext} ctx @returns {PoolJobPayload} */
function buildErgJobPayload(ctx) {
    // Pre-apply Ergo's difficulty multiplier so every miner receives the final
    // per-miner target directly, with identity difficulty sent alongside it.
    const shareDifficulty = ctx.toBigInt(ctx.coinDiff);
    return [
        ctx.newJob.id,
        ctx.blockTemplate.height,
        ctx.blockTemplate.hash,
        "",
        "",
        2,
        (ctx.toBigInt(ctx.coinFuncs.baseDiff()) / shareDifficulty).toString(),
        "",
        true
    ];
}

/** @param {BuildJobContext} ctx @returns {PoolJobPayload} */
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

/** @param {PushJobContext} ctx @returns {void} */
function pushStandardJob(ctx) {
    /** @type {PoolPushMessage} */
    const message = { method: "job", params: ctx.job };
    if (ctx.native === true) message.algo = ctx.params.algo_name;
    ctx.miner.pushMessage(message);
}

/** @param {PushJobContext & {job: [string, string, string, string, boolean, number, string|undefined]}} ctx @returns {void} */
function pushRavenJob(ctx) {
    const target = ctx.job[3];
    if (!ctx.miner.last_target || ctx.miner.last_target !== target) {
        /** @type {PoolPushMessage} */
        const targetMessage = { method: "mining.set_target", params: [target], id: null };
        if (ctx.native === true) targetMessage.algo = ctx.params.algo_name;
        ctx.miner.pushMessage(targetMessage);
        ctx.miner.last_target = target;
    }
    ctx.miner.pushMessage({ method: "mining.notify", params: ctx.job, algo: ctx.params.algo_name, id: null });
}

/** @param {PushJobContext & {job: [string, string, string, boolean, number]}} ctx @returns {void} */
function pushEthJob(ctx) {
    const notifyJob = ctx.job.slice(0, 4);
    const diff = ctx.job[4] / 0x100000000;
    if (!ctx.miner.last_diff || ctx.miner.last_diff !== diff) {
        /** @type {PoolPushMessage} */
        const difficultyMessage = { method: "mining.set_difficulty", params: [diff], id: null };
        if (ctx.native === true) difficultyMessage.algo = ctx.params.algo_name;
        ctx.miner.pushMessage(difficultyMessage);
        ctx.miner.last_diff = diff;
    }
    ctx.miner.pushMessage({ method: "mining.notify", params: notifyJob, algo: ctx.params.algo_name, id: null });
}

/** @param {PushJobContext} ctx @returns {void} */
function pushErgJob(ctx) {
    const diff = 1;
    const isNiceHash = typeof ctx.miner.agent === "string" && ctx.miner.agent.includes("NiceHash");
    if (ctx.miner.last_diff !== diff) {
        /** @type {PoolPushMessage} */
        const diffMessage = { method: "mining.set_difficulty", params: [diff], id: null };
        if (ctx.native === true) diffMessage.algo = ctx.params.algo_name;
        if (!isNiceHash) Reflect.deleteProperty(diffMessage, "id");
        ctx.miner.pushMessage(diffMessage);
        ctx.miner.last_diff = diff;
    }
    const notifyMessage = { method: "mining.notify", params: ctx.job, algo: ctx.params.algo_name, id: null };
    if (!isNiceHash) Reflect.deleteProperty(notifyMessage, "id");
    ctx.miner.pushMessage(notifyMessage);
}

/** @returns {boolean} */
function parseUnsupportedMiningSubmit() { return false; }

/** @param {PoolSubmitContext} ctx @returns {boolean} */
function parseEthArrayMiningSubmit(ctx) {
    if (!Array.isArray(ctx.params.raw_params) || typeof ctx.params.raw_params[2] !== "string") return false;
    ctx.params.nonce = ctx.params.raw_params[2];
    return true;
}

/** @param {PoolSubmitContext} ctx @returns {boolean} */
function parseRavenArrayMiningSubmit(ctx) {
    const rawParams = ctx.params.raw_params;
    if (!Array.isArray(rawParams) || rawParams.length < 5 ||
        typeof rawParams[2] !== "string" || typeof rawParams[3] !== "string" || typeof rawParams[4] !== "string") return false;
    ctx.params.nonce = rawParams[2].substr(2);
    ctx.params.header_hash = rawParams[3].substr(2);
    ctx.params.mixhash = rawParams[4].substr(2);
    return true;
}

/** @this {import("../../../types/pool_profiles").PoolSubmitValidationSettings} @param {PoolSubmitContext} ctx @returns {boolean} */
function validateStandardSubmit(ctx) {
    let nonce = ctx.params.nonce;
    if (typeof nonce !== "string") return false;
    if (ctx.coinFuncs.nonceSize(ctx.job.blob_type_num) === 8) {
        if (this.sharedTemplateNonces === true) {
            const extraNonce = typeof ctx.job.extraNonce === "string" ? ctx.job.extraNonce : undefined;
            const normalizedNonce = ctx.normalizeExtraNonceSubmitNonce(nonce, extraNonce, {
                requireFullNonceExtraNoncePrefix: this.requireFullNonceExtraNoncePrefix === true
            });
            if (typeof normalizedNonce !== "string") return false;
            nonce = normalizedNonce;
            ctx.params.nonce = normalizedNonce;
        }
        if (!ctx.state.nonceCheck64.test(nonce)) return false;
        if (typeof this.validateExtraSubmitFields === "function" && !this.validateExtraSubmitFields(ctx)) return false;
        return this.sharedTemplateNonces === true || (typeof ctx.params.result === "string" && ctx.state.hashCheck32.test(ctx.params.result));
    }
    return typeof ctx.params.result === "string" && ctx.state.nonceCheck32.test(nonce) && ctx.state.hashCheck32.test(ctx.params.result);
}

/** @param {PoolSubmitContext} ctx @returns {boolean} */
function validateRavenExtraSubmitFields(ctx) {
    return typeof ctx.params.mixhash === "string" && typeof ctx.params.header_hash === "string" &&
        ctx.state.hashCheck32.test(ctx.params.mixhash) && ctx.state.hashCheck32.test(ctx.params.header_hash);
}

/** @param {PoolSubmitContext} ctx @returns {boolean} */
function validateRavenSubmit(ctx) {
    if (typeof ctx.params.nonce !== "string") return false;
    return ctx.state.nonceCheck64.test(ctx.params.nonce) && validateRavenExtraSubmitFields(ctx);
}

/** @param {unknown} value @returns {value is number} */
function isUint32(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** @param {unknown} proof @param {number} expectedSize @returns {boolean} */
function validateC29Proof(proof, expectedSize) {
    if (!Array.isArray(proof) || proof.length !== expectedSize) return false;
    for (const edge of proof) {
        if (!isUint32(edge)) return false;
    }
    return true;
}

/** @param {PoolSubmitContext} ctx @returns {boolean} */
function validateProofSubmit(ctx) {
    return isUint32(ctx.params.nonce) &&
        validateC29Proof(ctx.params.pow, ctx.coinFuncs.c29ProofSize(ctx.job.blob_type_num));
}

/** @param {PoolSubmitContext} ctx @returns {boolean} */
function validateXtmCSubmit(ctx) {
    return typeof ctx.params.nonce === "string" &&
        typeof ctx.miner.eth_extranonce === "string" &&
        ctx.state.nonceCheck64.test(ctx.params.nonce) &&
        ctx.params.nonce.toLowerCase().startsWith(ctx.miner.eth_extranonce) &&
        validateC29Proof(ctx.params.pow, ctx.coinFuncs.c29ProofSize(ctx.job.blob_type_num));
}

/** @param {PoolSubmissionKeyContext} ctx @returns {string} */
function buildStandardSubmissionKey(ctx) {
    const nonce = typeof ctx.params.nonce === "string" ? ctx.params.nonce : "";
    if (ctx.job && ctx.job.usesProxyNonce) return `${nonce}_${ctx.params.poolNonce}_${ctx.params.workerNonce}`;
    return nonce;
}

/** @param {PoolSubmissionKeyContext} ctx @returns {string} */
function buildProofSubmissionKey(ctx) {
    const proofKey = Array.isArray(ctx.params.pow) ? ctx.params.pow.join(":") : "";
    if (ctx.job && ctx.job.usesProxyNonce) return `${proofKey}_${ctx.params.poolNonce}_${ctx.params.workerNonce}`;
    return proofKey;
}

/** @param {PoolAuthorizeAlgoContext} ctx @returns {PoolAuthorizeAlgoState} */
function getDefaultAuthorizeAlgoState(ctx) {
    const algo = ctx.profile && ctx.profile.algo ? ctx.profile.algo : ctx.coinFuncs.algoShortTypeStr(ctx.port);
    return {
        algos: [algo],
        algosPerf: { [algo]: 1 },
        algoMinTime: 60
    };
}

/** @param {PoolExtraNonceLoginContext} ctx @returns {boolean} */
function attachLoginExtraNonce(ctx) {
    /** @type {number|null} */
    let newId = null;
    if (typeof ctx.socket.eth_extranonce_id === "number" && Number.isInteger(ctx.socket.eth_extranonce_id)) {
        newId = ctx.socket.eth_extranonce_id;
    } else if (typeof ctx.socket.eth_extranonce_preview_id === "number" && Number.isInteger(ctx.socket.eth_extranonce_preview_id)) {
        newId = ctx.socket.eth_extranonce_preview_id;
        ctx.socket.eth_extranonce_id = newId;
        delete ctx.socket.eth_extranonce_preview_id;
    } else {
        newId = ctx.utils.getNewEthExtranonceId();
        if (newId !== null) ctx.socket.eth_extranonce_id = newId;
    }
    if (newId === null) return false;
    ctx.miner.eth_extranonce = ctx.utils.ethExtranonce(newId);
    ctx.scheduleFirstShareTimer(ctx.minerId);
    return true;
}

/** @param {PoolLoginContext} ctx @returns {void} */
function sendStandardLoginResult(ctx) {
    if (ctx.miner.mo_native === true) {
        const job = ctx.miner.getCoinJob(ctx.coin, ctx.jobParams);
        ctx.sendReply(null, { id: ctx.minerId, algo: ctx.jobParams.algo_name, job, status: "OK" });
        ctx.miner.nativeJobAlgo = ctx.jobParams.algo_name;
        return;
    }
    ctx.sendReply(null, { id: ctx.minerId, job: ctx.miner.getCoinJob(ctx.coin, ctx.jobParams), status: "OK" });
}

/** @param {PoolExtraNonceLoginContext} ctx @returns {void} */
function sendExtraNonceLoginResult(ctx) {
    if (!attachLoginExtraNonce(ctx)) {
        ctx.sendReplyFinal("Not enough extranonces. Switch to other pool node.");
        return;
    }
    ctx.sendReply(null, { id: ctx.minerId, algo: ctx.jobParams.algo_name, extra_nonce: ctx.miner.eth_extranonce });
    ctx.miner.sendCoinJob(ctx.coin, ctx.jobParams);
}

/** @param {PoolExtraNonceLoginContext} ctx @returns {void} */
function sendXtmCLoginResult(ctx) {
    if (!attachLoginExtraNonce(ctx)) {
        ctx.sendReplyFinal("Not enough extranonces. Switch to other pool node.");
        return;
    }
    const job = ctx.miner.getCoinJob(ctx.coin, ctx.jobParams);
    if (ctx.miner.mo_native === true) {
        ctx.sendReply(null, { id: ctx.minerId, algo: ctx.jobParams.algo_name, extra_nonce: ctx.miner.eth_extranonce });
        ctx.miner.sendCoinJob(ctx.coin, ctx.jobParams, { job });
        return;
    }
    ctx.sendReply(null, { id: ctx.minerId, job, status: "OK" });
}

/** @param {PoolSpecialShareContext} ctx @returns {boolean} */
function rejectSpecialShare(ctx) {
    ctx.reportMinerShare(ctx.miner, ctx.job);
    ctx.processShareCB(ctx.invalidShare(ctx.miner));
    return true;
}

/**
 * @param {PoolSpecialShareContext} ctx
 * @param {Buffer} convertedBlob
 * @param {{nonce?: string|undefined, mixhash?: string|undefined}|null} verifyContext
 * @param {(hashes: Buffer|Buffer[]|null|false, errorKind?: string) => void} callback
 * @returns {void}
 */
function callSlowHashBuffAsync(ctx, convertedBlob, verifyContext, callback) {
    if (typeof ctx.startAsyncVerification === "function") ctx.startAsyncVerification();
    if (typeof ctx.coinFuncs.slowHashBuffAsync === "function") {
        return ctx.coinFuncs.slowHashBuffAsync(convertedBlob, ctx.blockTemplate, ctx.miner.payout, callback, verifyContext || undefined);
    }
    if (typeof ctx.coinFuncs.isHashVerifierEnabled === "function" && ctx.coinFuncs.isHashVerifierEnabled()) {
        return callback(false, "missing-async-hash-helper");
    }
    try {
        return callback(ctx.coinFuncs.slowHashBuff(
            convertedBlob,
            ctx.blockTemplate,
            verifyContext ? verifyContext.nonce : undefined,
            verifyContext ? verifyContext.mixhash : undefined
        ));
    } catch (_error) {
        return callback(false, "local-hash-error");
    }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object";
}

/** @param {PoolSubmitParams} params @param {string} name @returns {string|null} */
function getStringParam(params, name) {
    const value = params[name];
    return typeof value === "string" ? value : null;
}

/** @param {PoolSubmitParams} params @returns {number[]|null} */
function getProofParam(params) {
    return Array.isArray(params.pow) && params.pow.every((edge) => typeof edge === "number") ? params.pow : null;
}

/** @param {PoolSubmitBlockContext} ctx @returns {Buffer|null} */
function getSubmitBuffer(ctx) {
    if (Buffer.isBuffer(ctx.blockData)) return ctx.blockData;
    ctx.replyFn({ error: { code: -1, message: "Block submit data must be a buffer" } }, 0);
    return null;
}

/** @param {unknown} hashes @param {number} count @returns {hashes is Buffer[]} */
function validHashBuffers(hashes, count) {
    return Array.isArray(hashes) && hashes.length >= count && hashes.slice(0, count).every(Buffer.isBuffer);
}

/** @param {PoolSpecialShareContext} ctx @returns {boolean} */
function verifyXtmCShare(ctx) {
    const nonce = getStringParam(ctx.params, "nonce");
    const proof = getProofParam(ctx.params);
    const blockBuffer = ctx.blockTemplate.buffer;
    if (nonce === null || proof === null || !blockBuffer) return rejectSpecialShare(ctx);
    const header = Buffer.concat([ctx.bigIntToBuffer(BigInt(`0x${nonce}`), { endian: "big", size: 8 }), blockBuffer]);
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        const c29PackedEdgesBuff = ctx.coinFuncs.c29_packed_edges(proof, ctx.job.blob_type_num, ctx.blockTemplate.port);
        ctx.job.c29_packed_edges = Array.from(Buffer.from(c29PackedEdgesBuff, "hex"));
        ctx.verifyShareCB(ctx.hashBuffDiff(syntheticResult), syntheticResult, header, false, true);
        return true;
    }
    if (ctx.coinFuncs.c29(header, proof, ctx.blockTemplate.port)) return rejectSpecialShare(ctx);
    const c29PackedEdgesBuff = ctx.coinFuncs.c29_packed_edges(proof, ctx.job.blob_type_num, ctx.blockTemplate.port);
    ctx.job.c29_packed_edges = Array.from(Buffer.from(c29PackedEdgesBuff, "hex"));
    const resultBuff = ctx.coinFuncs.c29_cycle_hash(c29PackedEdgesBuff);
    ctx.verifyShareCB(ctx.hashBuffDiff(resultBuff), resultBuff, header, false, true);
    return true;
}

/** @param {PoolSpecialShareContext} ctx @returns {boolean} */
function verifyGrinShare(ctx) {
    const blockData = ctx.getShareBuffer();
    if (blockData === null) {
        ctx.processShareCB(ctx.invalidShare(ctx.miner));
        return true;
    }
    const convertedBlob = ctx.coinFuncs.convertBlob(blockData, ctx.blockTemplate.port);
    const proof = getProofParam(ctx.params);
    const nonce = ctx.params.nonce;
    if (!convertedBlob || proof === null || (typeof nonce !== "string" && typeof nonce !== "number")) return rejectSpecialShare(ctx);
    const header = Buffer.concat([convertedBlob, ctx.bigIntToBuffer(BigInt(nonce), { endian: "big", size: 4 })]);
    if (ctx.coinFuncs.c29(header, proof, ctx.blockTemplate.port)) return rejectSpecialShare(ctx);
    const packedEdges = ctx.coinFuncs.c29_packed_edges(proof, ctx.job.blob_type_num, ctx.blockTemplate.port);
    const resultBuff = ctx.coinFuncs.c29_cycle_hash(packedEdges);
    ctx.verifyShareCB(ctx.hashBuffDiff(resultBuff), resultBuff, blockData, false, true);
    return true;
}

/** @param {PoolSpecialShareContext} ctx @returns {boolean} */
function verifyRavenShare(ctx) {
    const blockData = ctx.getShareBuffer();
    if (blockData === null) {
        ctx.processShareCB(ctx.invalidShare(ctx.miner));
        return true;
    }
    const convertedBlob = ctx.coinFuncs.convertBlob(blockData, ctx.blockTemplate.port);
    const headerHash = getStringParam(ctx.params, "header_hash");
    const nonce = getStringParam(ctx.params, "nonce");
    const mixhash = getStringParam(ctx.params, "mixhash");
    if (!convertedBlob || headerHash === null || nonce === null || mixhash === null) return rejectSpecialShare(ctx);
    if (headerHash !== convertedBlob.toString("hex")) {
        console.error(`Wrong header hash:${  headerHash  } ${  convertedBlob.toString("hex")}`);
        return rejectSpecialShare(ctx);
    }
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        ctx.verifyShareCB(ctx.hashRavenBuffDiff(syntheticResult), syntheticResult, blockData, false, true);
        return true;
    }
    let quickResult;
    try {
        quickResult = ctx.coinFuncs.kawpowQuickHash(convertedBlob, nonce, mixhash);
    } catch (_error) {
        return rejectSpecialShare(ctx);
    }
    const quickDiff = ctx.hashRavenBuffDiff(quickResult);
    if (!ctx.ge(quickDiff, ctx.job.difficulty)) {
        ctx.verifyShareCB(quickDiff, quickResult, blockData, false, true);
        return true;
    }
    const acceptTrustedShare = function () {
        ctx.verifyShareCB(quickDiff, quickResult, blockData, true, true);
    };
    const isBlockCandidate = typeof ctx.isBlockCandidateDiff === "function"
        ? ctx.isBlockCandidateDiff(quickDiff)
        : ctx.ge(quickDiff, ctx.blockTemplate.difficulty);
    if (!isBlockCandidate && typeof ctx.tryTrustedShare === "function" && ctx.tryTrustedShare(acceptTrustedShare)) return true;
    if (
        !isBlockCandidate &&
        typeof ctx.tryTrustedShare !== "function" &&
        global.config.pool.trustedMiners &&
        ctx.miner.trust &&
        typeof ctx.job.rewarded_difficulty2 === "number" &&
        ctx.isSafeToTrust(ctx.job.rewarded_difficulty2, ctx.trustKey || ctx.miner.trust_key || ctx.miner.payout, ctx.miner.trust.trust) &&
        ctx.miner.trust.check_height !== ctx.job.height
    ) {
        acceptTrustedShare();
        return true;
    }
    ctx.verifySlowHashWithRetry(convertedBlob, { mixhash, nonce }, function onHash(hash) {
        if (hash === null) return ctx.processShareCB(null);
        if (!hash) return rejectSpecialShare(ctx);
        const resultBuff = Buffer.from(hash, "hex");
        if (!resultBuff.equals(quickResult)) return rejectSpecialShare(ctx);
        ctx.verifyShareCB(ctx.hashRavenBuffDiff(resultBuff), resultBuff, blockData, false, true);
    });
    return true;
}

/** @param {PoolSpecialShareContext} ctx @returns {boolean} */
function verifyEthShare(ctx) {
    const blockHash = getStringParam(ctx.blockTemplate, "hash");
    const nonce = getStringParam(ctx.params, "nonce");
    if (blockHash === null || nonce === null) return rejectSpecialShare(ctx);
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        const mixHash = ctx.params.raw_params instanceof Array && typeof ctx.params.raw_params[4] === "string"
            ? ctx.params.raw_params[4]
            : `0x${"00".repeat(32)}`;
        ctx.verifyShareCB(
            ctx.hashEthBuffDiff(syntheticResult),
            syntheticResult,
            [`0x${nonce}`, `0x${blockHash}`, mixHash],
            false,
            true
        );
        return true;
    }
    callSlowHashBuffAsync(ctx, Buffer.from(blockHash, "hex"), { nonce }, function onEthHash(hashes) {
        // Verifier-unavailable (timeout / socket / bad-JSON) returns null or false, never a hash buffer pair.
        // A genuinely bad PoW still returns valid buffers and is rejected later by the difficulty check, so a
        // missing buffer pair means the remote verifier failed, not that the miner cheated: drop the share
        // (no credit, no penalty) instead of resetting trust and feeding the ban counter on honest miners.
        if (!validHashBuffers(hashes, 2)) return ctx.processShareCB(null);
        const resultBuff = hashes[0];
        const mixHash = hashes[1];
        if (!resultBuff || !mixHash) return ctx.processShareCB(null);
        ctx.verifyShareCB(ctx.hashEthBuffDiff(resultBuff), resultBuff, [`0x${  nonce}`, `0x${  blockHash}`, `0x${  mixHash.toString("hex")}`], false, true);
    });
    return true;
}

/** @param {PoolSpecialShareContext} ctx @returns {boolean} */
function verifyErgShare(ctx) {
    const blockHash = getStringParam(ctx.blockTemplate, "hash");
    const nonce = getStringParam(ctx.params, "nonce");
    if (blockHash === null || nonce === null) return rejectSpecialShare(ctx);
    const syntheticResult = typeof ctx.getBlockSubmitTestResultBuffer === "function" ? ctx.getBlockSubmitTestResultBuffer() : null;
    if (syntheticResult) {
        ctx.verifyShareCB(ctx.hashEthBuffDiff(syntheticResult), syntheticResult, nonce, false, true);
        return true;
    }
    callSlowHashBuffAsync(ctx, Buffer.concat([Buffer.from(blockHash, "hex"), Buffer.from(nonce, "hex")]), null, function onErgHash(hashes) {
        // See verifyEthShare: a missing buffer pair is a verifier outage, not a forged share. Drop it harmlessly
        // (processShareCB(null)) rather than penalising/banning honest ERG miners during verifier downtime.
        if (!validHashBuffers(hashes, 2)) return ctx.processShareCB(null);
        const resultBuff = hashes[1];
        if (!resultBuff) return ctx.processShareCB(null);
        ctx.verifyShareCB(ctx.hashEthBuffDiff(resultBuff), null, nonce, false, true);
    });
    return true;
}

/** @param {PoolBlockAcceptanceContext} ctx @returns {boolean} */
function acceptDefinedResult(ctx) {
    if (!ctx.rpcResult || typeof ctx.rpcResult.result === "undefined") return false;
    const result = ctx.rpcResult.result;
    if (isRecord(result) && typeof result["block_id"] === "undefined" && result["status"] !== "OK") return false;
    return true;
}

/** @param {PoolBlockAcceptanceContext} ctx @returns {boolean} */
function acceptBooleanTrue(ctx) { return Boolean(ctx.rpcResult && ctx.rpcResult.result === true); }

/** @param {PoolBlockAcceptanceContext} ctx @returns {boolean} */
function acceptStatusOkObject(ctx) {
    return Boolean(ctx.rpcResult && isRecord(ctx.rpcResult.result) && ctx.rpcResult.result["status"] === "OK");
}

// Tari SubmitBlock returns result.block_hash without status OK on success.
// Treating it as generic object result makes valid XTM blocks retry and alert.
/** @param {PoolBlockAcceptanceContext} ctx @returns {boolean} */
function acceptXtmBlockHashResult(ctx) {
    if (!ctx.rpcResult || !isRecord(ctx.rpcResult.result)) return false;
    const blockHash = ctx.rpcResult.result["block_hash"];
    if (Array.isArray(blockHash) || Buffer.isBuffer(blockHash)) return blockHash.length > 0;
    return typeof blockHash === "string" && blockHash.length > 0;
}

/** @param {PoolBlockAcceptanceContext & {rpcResult: PoolRpcResult & {response?: unknown}}} ctx @returns {boolean} */
function acceptNonRejectedResponse(ctx) { return Boolean(ctx.rpcResult && ctx.rpcResult.response !== "rejected"); }

/** @param {PoolAccepted202Context} ctx @returns {boolean} */
function acceptAccepted202String(ctx) { return typeof ctx.rpcResult === "string" && ctx.rpcStatus === 202; }

/** @param {PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback @returns {void} */
function resolveDefaultSubmittedBlockHash(ctx, callback) {
    if (ctx.isDisplaySubmitPort && isRecord(ctx.rpcResult.result)) {
        const aux = ctx.rpcResult.result["_aux"];
        const chains = isRecord(aux) ? aux["chains"] : undefined;
        const firstChain = Array.isArray(chains) ? chains[0] : undefined;
        const blockHash = isRecord(firstChain) ? firstChain["block_hash"] : undefined;
        if (typeof blockHash === "string") return callback(blockHash);
    }
    if (!Buffer.isBuffer(ctx.blockData)) return callback("0".repeat(64));
    return callback(ctx.coinFuncs.getBlockID(ctx.blockData, ctx.blockTemplate.port).toString("hex"));
}

/** @param {PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback @returns {void} */
function resolveDeroSubmittedBlockHash(ctx, callback) {
    const blockId = isRecord(ctx.rpcResult.result) ? ctx.rpcResult.result["blid"] : undefined;
    return callback(typeof blockId === "string" ? blockId : "0".repeat(64));
}

/** @param {PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback @returns {void} */
function resolveResultHashSubmittedBlockHash(ctx, callback) {
    return callback(ctx.resultBuff ? ctx.resultBuff.toString("hex") : "0".repeat(64));
}

/** @param {PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback @returns {NodeJS.Timeout} */
function resolveErgSubmittedBlockHash(ctx, callback) {
    return setTimeout(function checkSubmittedErgBlock() {
        /** @param {unknown} err @param {unknown} body */
        ctx.coinFuncs.getPortBlockHeaderByID(ctx.blockTemplate.port, ctx.blockTemplate.height, function onHeader(err, body) {
            // Guard the daemon/relay reply: a non-error but malformed/partial header lacking
            // powSolutions would otherwise throw inside this setTimeout callback (no surrounding
            // try/catch, no process-level uncaughtException handler) and crash the block-submit
            // confirm path. Treat a missing solution as "not our block" (the err!==null sentinel).
            const powSolutions = isRecord(body) ? body["powSolutions"] : undefined;
            const pk = err === null && isRecord(powSolutions) ? powSolutions["pk"] : undefined;
            const blockId = isRecord(body) ? body["id"] : undefined;
            callback(pk === ctx.blockTemplate.hash2 && typeof blockId === "string" ? blockId : "0".repeat(64));
        });
    }, 10 * 1000);
}

const ETH_BLOCK_RESOLVE_DELAY_MS = 30 * 1000;
const ETH_BLOCK_RESOLVE_ATTEMPTS = 10; // ~5 min of retries before giving up on an unreachable daemon

/** @param {PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback @returns {NodeJS.Timeout} */
function resolveEthSubmittedBlockHash(ctx, callback) {
    // The block was already accepted by the daemon (eth_submitWork === true). Resolving its on-chain
    // hash via ethBlockFind can transiently fail if the daemon is down/slow/restarting during this
    // window; a single attempt then yields the zero-hash and share_blocks drops the accepted block
    // uncredited (with an admin FYI). ethBlockFind is read-only/idempotent, so retry a bounded number
    // of times, then fall back to the zero-hash (the prior behaviour) once attempts are exhausted.
    // NOTE: this retry state is in-memory only -- a pool restart inside the window still loses the
    // in-flight block, and outages longer than the window still fall back to the zero-hash drop.
    let attempt = 0;
    function attemptResolve() {
        const blockData = Array.isArray(ctx.blockData) ? ctx.blockData : [];
        const nonce = typeof blockData[0] === "string" ? blockData[0] : "";
        /** @param {string|null} blockHash */
        ctx.coinFuncs.ethBlockFind(ctx.blockTemplate.port, nonce, function onBlockHash(blockHash) {
            if (blockHash) return callback(blockHash.substr(2));
            attempt += 1;
            if (attempt >= ETH_BLOCK_RESOLVE_ATTEMPTS) return callback("0".repeat(64));
            return setTimeout(attemptResolve, ETH_BLOCK_RESOLVE_DELAY_MS);
        });
    }
    return setTimeout(attemptResolve, ETH_BLOCK_RESOLVE_DELAY_MS);
}

/** @param {PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback @returns {void} */
function resolveXtmSubmittedBlockHash(ctx, callback) {
    const result = ctx.rpcResult.result;
    const blockHash = isRecord(result) ? result["block_hash"] : undefined;
    if (Array.isArray(blockHash) || Buffer.isBuffer(blockHash)) return callback(Buffer.from(blockHash).toString("hex"));
    if (typeof blockHash === "string") return callback(blockHash);
    return callback("0".repeat(64));
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitCryptonoteBlock(ctx) {
    const blockData = getSubmitBuffer(ctx);
    if (!blockData) return;
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "submitblock", [blockData.toString("hex")], ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitHttpBlockBody(ctx) {
    const blockData = getSubmitBuffer(ctx);
    if (!blockData) return;
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "block", blockData.toString("hex"), ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitBtcBlock(ctx) {
    const blockData = getSubmitBuffer(ctx);
    if (!blockData) return;
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "", { method: "submitblock", params: [blockData.toString("hex")] }, ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitEthBlock(ctx) {
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "", { method: "eth_submitWork", params: ctx.blockData, jsonrpc: "2.0", id: 0 }, ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitErgBlock(ctx) {
    ctx.support.rpcPortDaemon2(ctx.blockTemplate.port, "mining/solution", { n: ctx.blockData }, ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitDeroBlock(ctx) {
    const blockData = getSubmitBuffer(ctx);
    if (!blockData) return;
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "submitblock", [ctx.blockTemplate.blocktemplate_blob, blockData.toString("hex")], ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitXtmRxBlock(ctx) {
    if (!Buffer.isBuffer(ctx.blockData) ||
        ctx.blockData.length <= XTM_T_POW_ALGO_OFFSET ||
        ctx.blockData[XTM_T_POW_ALGO_OFFSET] !== XTM_T_RANDOMXT_POW_ALGO) {
        const actual = Buffer.isBuffer(ctx.blockData) && ctx.blockData.length > XTM_T_POW_ALGO_OFFSET
            ? ctx.blockData[XTM_T_POW_ALGO_OFFSET]
            : "missing";
        return ctx.replyFn({
            error: {
                code: -1,
                message: `Invalid XTM-T pow_algo byte ${actual}; expected ${XTM_T_RANDOMXT_POW_ALGO}`
            }
        }, 0);
    }
    const blockData = ctx.blockData;
    if (!Buffer.isBuffer(blockData)) return;
    const sourceBlock = ctx.blockTemplate.xtm_block;
    if (!sourceBlock) return ctx.replyFn({ error: { code: -1, message: "Missing XTM template" } }, 0);
    const xtmBlock = cloneRpcTemplate(sourceBlock);
    const powData = blockData.slice(XTM_T_POW_DATA_OFFSET);

    xtmBlock.header.nonce = readUInt64BufferBE(blockData, XTM_T_NONCE_OFFSET);
    xtmBlock.header.pow.pow_data = powData.every((byte) => byte === 0) ? [] : [...powData];
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "SubmitBlock", xtmBlock, ctx.replyFn, true);
}

/** @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitXtmCBlock(ctx) {
    if (!Buffer.isBuffer(ctx.blockData)) return ctx.replyFn({ error: { code: -1, message: "Block submit data must be a buffer" } }, 0);
    const sourceBlock = ctx.blockTemplate.xtm_block;
    if (!sourceBlock) return ctx.replyFn({ error: { code: -1, message: "Missing XTM template" } }, 0);
    const xtmBlock = cloneRpcTemplate(sourceBlock);

    xtmBlock.header.nonce = readUInt64BufferBE(ctx.blockData, 0);
    xtmBlock.header.pow.pow_data = ctx.job.c29_packed_edges || [];
    ctx.support.rpcPortDaemon(ctx.blockTemplate.port, "SubmitBlock", xtmBlock, ctx.replyFn, true);
}

/** @this {PoolProfileSettings} @param {PoolSubmitBlockContext} ctx @returns {void} */
function submitDualMainBlock(ctx) {
    const blockData = getSubmitBuffer(ctx);
    if (!blockData) return;
    const xmrDifficulty = ctx.blockTemplate.xmr_difficulty;
    const xtmDifficulty = ctx.blockTemplate.xtm_difficulty;
    const isXmr = typeof xmrDifficulty === "number" && ctx.hashDiff >= xmrDifficulty;
    const isXtm = typeof xtmDifficulty === "number" && ctx.hashDiff >= xtmDifficulty;
    const mainSubmitPort = Number(global.config.daemon.mainBlockSubmitPort || this.mainSubmitPort || ctx.blockTemplate.port);
    const auxSubmitPort = Number(global.config.daemon.dualBlockSubmitPort || this.dualSubmitPort || ctx.blockTemplate.port);

    if (isXmr && (!ctx.portUsedToSubmit || ctx.portUsedToSubmit === mainSubmitPort)) {
        ctx.support.rpcPortDaemon(mainSubmitPort, "submitblock", [blockData.toString("hex")], function onMainSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, mainSubmitPort, ctx.submitBlockCB, false);
        }, true);
    }
    if (isXtm && (!ctx.portUsedToSubmit || ctx.portUsedToSubmit === auxSubmitPort)) {
        ctx.support.rpcPortDaemon(auxSubmitPort, "submitblock", [blockData.toString("hex")], function onAuxSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, auxSubmitPort, isXmr ? null : ctx.submitBlockCB, true);
        }, true);
    }
    if (!isXmr && !isXtm) {
        if (!ctx.suppressFailureEmail) {
            global.support.sendAdminFyi(`coins:low-diff-submit:${  ctx.blockTemplate.port}`, `FYI: Can't submit low diff block to daemon on ${  ctx.blockTemplate.port  } port`, `The pool server: ${  global.config.hostname  } can't submit low diff block to daemon on ${  ctx.blockTemplate.port  } port`);
        }
        ctx.support.rpcPortDaemon(mainSubmitPort, "submitblock", [blockData.toString("hex")], function onLowMainSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, mainSubmitPort, ctx.submitBlockCB, false);
        }, true);
        ctx.support.rpcPortDaemon(auxSubmitPort, "submitblock", [blockData.toString("hex")], function onLowAuxSubmit(rpcResult, rpcStatus) {
            return ctx.replyDispatcher(rpcResult, rpcStatus, auxSubmitPort, null, true);
        }, true);
    }
}

/** @type {PoolProfileSettings} */
const basePoolConfig = {
    // Pool profiles carry executable handlers so the pool modules stay generic.
    minDifficulty: "config",
    niceHashDiffMultiplier: 1,
    buildJobPayload: buildStandardJobPayload,
    buildProxyJobPayload,
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
    disableProxyNonce: false,
    sharedTemplateNonces: false,
    sharedTemplateSubmissions: false,
    useEthJobId: false
};

/** @param {Partial<PoolProfileSettings>} base @param {Partial<PoolProfileSettings>} [overrides] @returns {PoolProfileSettings} */
function createPoolConfig(base, overrides) { return mergeSection(mergeSection(basePoolConfig, base), overrides); }

/** @type {import("../../../types/pool_profiles").PoolFactories} */
const pool = {
    /** @param {Partial<PoolProfileSettings>} [overrides] */
    standard(overrides) {
        return createPoolConfig({}, overrides);
    },
    /** @param {Partial<PoolProfileSettings>} [overrides] */
    raven(overrides) {
        return createPoolConfig({
            minDifficulty: 0.01,
            niceHashDiffMultiplier: 50,
            hashesPerDifficulty: RAVEN_HASHES_PER_DIFFICULTY,
            buildJobPayload: buildRavenJobPayload,
            pushJob: pushRavenJob,
            parseMiningSubmitParams: parseRavenArrayMiningSubmit,
            validateSubmitParams: validateRavenSubmit,
            submitSuccess: "boolean",
            sendLoginResult: sendExtraNonceLoginResult,
            verifySpecialShare: verifyRavenShare,
            resolveSubmittedBlockHash: resolveResultHashSubmittedBlockHash,
            submitBlockRpc: submitBtcBlock,
            useEthJobId: true,
            requiresExtranonce: true
        }, overrides);
    },
    /** @param {Partial<PoolProfileSettings>} [overrides] */
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
            // Never relax extranonce validation for miner submits here. If a
            // miner puts the full nonce in a non-standard field, parse that
            // field before validation instead.
            requireFullNonceExtraNoncePrefix: true,
            requiresExtranonce: true
        }, overrides);
    },
    /** @param {Partial<PoolProfileSettings>} [overrides] */
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
            requireFullNonceExtraNoncePrefix: true,
            requiresExtranonce: true
        }, overrides);
    },
    /** @param {Partial<PoolProfileSettings>} [overrides] */
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
    /** @param {Partial<PoolProfileSettings>} [overrides] */
    xtmC(overrides) {
        return createPoolConfig({
            minDifficulty: 1,
            integerDifficulty: true,
            niceHashDiffMultiplier: 1,
            // Tari expresses Cuckaroo work in cycles, but its canonical network
            // hashrate counts every edge in the 42-edge proof.
            hashesPerDifficulty: XTM_CUCKAROO_CYCLE_LENGTH,
            buildJobPayload: buildXtmCJobPayload,
            validateSubmitParams: validateXtmCSubmit,
            submissionKey: buildProofSubmissionKey,
            submitSuccess: "boolean",
            sendLoginResult: sendXtmCLoginResult,
            verifySpecialShare: verifyXtmCShare,
            acceptSubmittedBlock: acceptXtmBlockHashResult,
            resolveSubmittedBlockHash: resolveXtmSubmittedBlockHash,
            submitBlockRpc: submitXtmCBlock,
            sharedTemplateSubmissions: true,
            requiresExtranonce: true,
            jobAlgo: "cuckaroo",
            edgeBits: 29
        }, overrides);
    },
    submitAccept: Object.freeze({
        statusOkObject: acceptStatusOkObject,
        xtmBlockHashResult: acceptXtmBlockHashResult,
        accepted202String: acceptAccepted202String
    }),
    blockHash: Object.freeze({
        deroBlid: resolveDeroSubmittedBlockHash,
        xtmRpcHash: resolveXtmSubmittedBlockHash
    }),
    blockSubmit: Object.freeze({
        httpBlockBody: submitHttpBlockBody,
        btc: submitBtcBlock,
        dero: submitDeroBlock,
        xtmRx: submitXtmRxBlock,
        dualMain: submitDualMainBlock
    })
};

const template = {
    /** @param {import("../../../types/coin_profiles").TemplateSettings} [overrides] @returns {import("../../../types/coin_profiles").TemplateSettings} */
    standard(overrides) {
        /** @type {import("../../../types/coin_profiles").TemplateSettings} */
        const defaults = {
            hashOnly: false,
            bufferField: "blocktemplate_blob",
            reserveOffsetSource: "scan-or-template"
        };
        return mergeSection(defaults, overrides);
    },
    /** @param {import("../../../types/coin_profiles").TemplateSettings} [overrides] @returns {import("../../../types/coin_profiles").TemplateSettings} */
    directReserve(overrides) {
        return template.standard(Object.assign({ reserveOffsetSource: "template" }, overrides || {}));
    },
    /** @param {import("../../../types/coin_profiles").TemplateSettings} [overrides] @returns {import("../../../types/coin_profiles").TemplateSettings} */
    hashOnly(overrides) {
        return template.standard(Object.assign({ hashOnly: true }, overrides || {}));
    },
    /** @param {import("../../../types/coin_profiles").TemplateSettings} [overrides] @returns {import("../../../types/coin_profiles").TemplateSettings} */
    dero(overrides) {
        return template.directReserve(Object.assign({ bufferField: "blockhashing_blob" }, overrides || {}));
    }
};

const btcTemplate = {
    /** @param {typeof import("node-blocktemplate")} blockTemplate @param {Record<string, unknown>} result @param {string} poolAddress */
    raven(blockTemplate, result, poolAddress) {
        return blockTemplate.RavenBlockTemplate(result, poolAddress);
    },
    /** @param {typeof import("node-blocktemplate")} blockTemplate @param {Record<string, unknown>} result @param {string} poolAddress */
    rtm(blockTemplate, result, poolAddress) {
        return blockTemplate.RtmBlockTemplate(result, poolAddress);
    }
};

const rpc = {
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    cryptonoteGetBlock(overrides) {
        return createCryptonoteRpc("getblock", overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    cryptonoteHeader(overrides) {
        return createCryptonoteRpc("header", overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    btc(overrides) {
        return createBtcRpc(overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    eth(overrides) {
        return createEthRpc(overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    erg(overrides) {
        return createErgRpc(overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    xtmMain(overrides) {
        return createXtmMainRpc(overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    xtmT(overrides) {
        return createXtmTRpc(overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    xtmC(overrides) {
        return createXtmCRpc(overrides);
    },
    /** @param {Partial<import("../../../types/coin_profiles").RpcSettings>} [overrides] @returns {import("../../../types/coin_profiles").RpcSettings} */
    dero(overrides) {
        return createDeroRpc(overrides);
    }
};

/** @param {Partial<import("../../../types/coin_profiles").CoinProfileSpec>} baseSpec */
function createProfilePreset(baseSpec) {
    /** @param {import("../../../types/coin_profiles").ProfileInput} spec */
    return function preset(spec) {
        return createProfile({ ...baseSpec, ...spec });
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
    }),
    raptoreum: createProfilePreset({
        blobType: 104,
        algo: "ghostrider",
        blobTypeName: "raptoreum",
        blob: blob.rtm(),
        pool: pool.standard({
            submitBlockRpc: pool.blockSubmit.btc
        }),
        rpc: rpc.btc({
            createBlockTemplate: btcTemplate.rtm,
            headerRewardMode: "sum-pool-vout",
            rewardMultiplier: 100000000,
            difficultyMultiplier: 0xFFFFFFFF
        }),
        pow: pow.cryptonight({ variant: 18 }),
        template: template.directReserve()
    }),
    raven: createProfilePreset({
        blobType: 101,
        algo: "kawpow",
        blobTypeName: "raven",
        blob: blob.raven(),
        pool: pool.raven(),
        minerAlgoAliases: { kawpow: ["kawpow1", "kawpow4"] },
        perf: {
            aliases: ["kawpow1", "kawpow4", "kawpow"],
            legacyDifficultyAliases: ["kawpow4", "kawpow"]
        },
        rpc: rpc.btc({
            createBlockTemplate: btcTemplate.raven,
            headerRewardMode: "sum-pool-vout",
            rewardMultiplier: 100000000
        }),
        pow: pow.kawpow(),
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
