"use strict";
const blockTemplate = require("node-blocktemplate");
const powHash = require("node-powhash");
const crypto = require("crypto");
const process = require("process");
const fs = require("fs");
const net = require("net");
const child_process = require("child_process");

const createConstants = require("./constants.js");
const { createTaskQueue, findSeries } = require("../common/callbacks.js");
const loadRegistry = require("./core/registry.js");
const { toBuffer } = require("./helpers.js");

const registry = loadRegistry();
const {
    all_algos,
    coin2port,
    coins,
    extra_nonce_mm_template_hex,
    extra_nonce_template_hex,
    fix_daemon_sh,
    mm_child_port_set,
    mm_nonce_size,
    mm_port_set,
    pool_nonce_size,
    port2blob_num,
    port2coin,
    port2displayCoin,
    ports,
    reCAST,
    reSRB,
    reSRBMULTI,
    reXMRSTAK,
    reXMRSTAKRX,
    reXMRig,
    reXNP
} = createConstants(blockTemplate);

/** @type {Record<string, number>} */
const miner_address_verify = Object.create(null);
/** @typedef {{jsonInput: {algo: string, blob: string}, cb: (result: import("../../types/coin_profiles").HexHashResult, errorKind?: string) => void, time: number, miner_address: string}} VerifyTask */
/** @typedef {import("../../types/coin_profiles").RpcCallback} RpcCallback */
/** @typedef {import("../../types/coin_profiles").ProfileCoinFuncs} ProfileCoinFuncs */
/** @typedef {{noErrorReport?: boolean | undefined, onMissing?: (() => unknown) | undefined, extra?: Record<string, unknown> | undefined}} RpcDispatchOptions */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasVerifyShareHosts() {
    return global.config && Array.isArray(global.config.verify_shares_host) && global.config.verify_shares_host.length > 0;
}

/** @param {unknown} value @returns {value is string} */
function isHexString(value) {
    return typeof value === "string" && value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

/** @param {unknown} value @returns {import("../../types/coin_profiles").HexHashResult} */
function verifierResultToHex(value) {
    if (value === null || value === false || isHexString(value)) return value;
    return Array.isArray(value) && value.every(isHexString) ? value : false;
}

/** @param {unknown} value */
function verifierResultToBuffer(value) {
    if (value === null || value === false) return value;
    if (Buffer.isBuffer(value)) return value;
    if (!isHexString(value)) return false;
    return Buffer.from(value, "hex");
}

/** @param {unknown} value */
function verifierResultToBuffers(value) {
    if (Array.isArray(value)) return value.map(verifierResultToBuffer);
    return verifierResultToBuffer(value);
}

/** @param {string} miner_address */
function decrementMinerAddressVerify(miner_address) {
    const pending = miner_address_verify[miner_address];
    if (pending === undefined) return;
    if (pending <= 1) delete miner_address_verify[miner_address];
    else miner_address_verify[miner_address] = pending - 1;
}

/** @param {RegExpExecArray | null} match */
function parseVersion(match) {
    if (!match) return null;
    return [match[1], match[2], match[3] || "0"].map(function parsePart(part) {
        return parseInt(part || "0", 10);
    });
}

/** @param {number[]} left @param {number[]} right */
function compareVersions(left, right) {
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; ++index) {
        const leftPart = left[index] || 0;
        const rightPart = right[index] || 0;
        if (leftPart < rightPart) return -1;
        if (leftPart > rightPart) return 1;
    }
    return 0;
}

/** @param {unknown} error */
function formatCallbackError(error) {
    if (error === null || typeof error === "undefined") return "unknown error";
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
    if (typeof error === "object") {
        try {
            return JSON.stringify(error);
        } catch (_jsonError) {
            return String(error);
        }
    }
    return String(error);
}

/** @param {unknown} error @param {string} mmCoin @param {number} mmPort */
function mergedMiningHeaderError(error, mmCoin, mmPort) {
    return new Error(`merged mining ${  mmCoin  } last block header failed on port ${  mmPort  }: ${  formatCallbackError(error)}`);
}

/** @param {string} agent @param {string} matcherName */
function versionMatches(agent, matcherName) {
    switch (matcherName) {
    case "xmrig": return parseVersion(reXMRig.exec(agent));
    case "xmrstakrx": return parseVersion(reXMRSTAKRX.exec(agent));
    case "xmrstak": return parseVersion(reXMRSTAK.exec(agent));
    case "xnp": return parseVersion(reXNP.exec(agent));
    case "cast": return parseVersion(reCAST.exec(agent));
    case "srb": return parseVersion(reSRB.exec(agent));
    case "srbmulti": return parseVersion(reSRBMULTI.exec(agent));
    default: return null;
    }
}

/** @param {number[] | null} version @param {import("../../types/coin_profiles").VersionRule} rule */
function versionAllowed(version, rule) {
    if (!version) return false;
    if (rule.minVersionInclusive && compareVersions(version, rule.minVersionInclusive.split(".").map(Number)) < 0) return false;
    if (rule.maxVersionExclusive && compareVersions(version, rule.maxVersionExclusive.split(".").map(Number)) >= 0) return false;
    return true;
}

/** @param {number | string} port @returns {import("../../types/coin_profiles").CoinProfile | null} */
function getProfileByPort(port) { return registry.profilesByPort[port.toString()] || null; }

/** @param {string} coin @returns {import("../../types/coin_profiles").CoinProfile | null} */
function getProfileByCoin(coin) { return registry.profilesByAlias[coin] || null; }

/** @param {number} blobType @returns {import("../../types/coin_profiles").CoinProfile[]} */
function getProfilesByBlobType(blobType) { return registry.profilesByBlobType[blobType] || []; }

/** @param {number} blobType @param {{port?: number, coin?: string}} [hint] */
function getProfileByBlobType(blobType, hint) {
    const profiles = getProfilesByBlobType(blobType);
    if (!profiles.length) return null;
    if (hint && typeof hint.port !== "undefined") {
        const profileByPort = getProfileByPort(hint.port);
        if (profileByPort && profileByPort.blobType === Number(blobType)) return profileByPort;
    }
    if (hint && typeof hint.coin === "string") {
        const profileByCoin = getProfileByCoin(hint.coin);
        if (profileByCoin && profileByCoin.blobType === Number(blobType)) return profileByCoin;
    }
    return profiles.length === 1 ? profiles[0] ?? null : null;
}

/** @param {number} blobType */
function getBlobTraits(blobType) { return registry.blobTraits[blobType] || { nonceSize: 4, proofSize: 32 }; }

/** @param {import("../../types/coin_profiles").CoinProfile} profile */
function getPoolAddress(profile) {
    const addressCoin = profile.rpc && profile.rpc.addressCoin;
    if (addressCoin) {
        const addressPort = coin2port[addressCoin];
        if (addressPort === undefined) throw new Error(`Unknown address coin: ${addressCoin}`);
        if (addressPort === global.config.daemon.port) return global.config.pool.address;
        const address = global.config.pool[`address_${addressPort}`];
        return typeof address === "string" ? address : "";
    }
    if (profile.port === global.config.daemon.port) return global.config.pool.address;
    const address = global.config.pool[`address_${profile.port}`];
    return typeof address === "string" ? address : "";
}

const shareVerifyQueues = (global.config.verify_shares_host || []).map(function registerVerifyQueue(verify_shares_host, index) {
    const health = { lastErrorAt: 0, errorCount: 0 };
    const queue = createTaskQueue(16, /** @param {VerifyTask} task */ function verifyShareRemote(task, queueCB) {
        decrementMinerAddressVerify(task.miner_address);
        const cb = task.cb;
        if (Date.now() - task.time > 60 * 1000) {
            cb(null);
            return queueCB();
        }

        const socket = new net.Socket();
        let is_cb = false;
        /** @param {import("../../types/coin_profiles").HexHashResult} result @param {string} [errorKind] */
        function return_cb(result, errorKind) {
            if (is_cb) return;
            is_cb = true;
            clearTimeout(timer);
            cb(result, errorKind);
            return queueCB();
        }

        const timer = setTimeout(function onTimeout() {
            socket.destroy();
            if (health.errorCount > 10) {
                const err_str = `Server ${  global.config.hostname  } timeouted share verification to ${  verify_shares_host}`;
                console.error(err_str);
                global.support.sendAdminFyi(`coins:verify-share:${  verify_shares_host}`, "FYI: Can't verify share", err_str);
            }
            health.lastErrorAt = Date.now();
            ++health.errorCount;
            return return_cb(null);
        }, 60 * 1000);

        socket.connect(2222, verify_shares_host, function onConnect() {
            socket.write(`${JSON.stringify(task.jsonInput)  }\n`);
        });

        let buff = "";
        socket.on("data", function onData(buff1) {
            buff += buff1;
        });

        socket.on("end", function onEnd() {
            try {
                /** @type {unknown} */
                const jsonOutput = JSON.parse(buff);
                if (!isRecord(jsonOutput) || !("result" in jsonOutput)) throw new Error("Verifier reply has no result");
                const rawResult = jsonOutput["result"];
                const result = verifierResultToHex(rawResult);
                if (result === false && rawResult !== false) throw new Error("Verifier reply has an invalid hash result");
                health.errorCount = 0;
                return return_cb(result);
            } catch (_error) {
                if (health.errorCount > 10) {
                    const err_str = `Server ${  global.config.hostname  } got wrong JSON from ${  verify_shares_host}`;
                    console.error(err_str);
                    global.support.sendAdminFyi(`coins:verify-share:${  verify_shares_host}`, "FYI: Can't verify share", err_str);
                }
                health.lastErrorAt = Date.now();
                ++health.errorCount;
                return return_cb(false, "verify-host-error");
            }
        });

        socket.on("error", function onError() {
            socket.destroy();
            if (health.errorCount > 10) {
                const err_str = `Server ${  global.config.hostname  } got socket error from ${  verify_shares_host}`;
                console.error(err_str);
                global.support.sendAdminFyi(`coins:verify-share:${  verify_shares_host}`, "FYI: Can't verify share", err_str);
            }
            health.lastErrorAt = Date.now();
            ++health.errorCount;
            return return_cb(false, "verify-host-error");
        });
    });

    setInterval(function checkQueue(queue_obj, queueIndex) {
        if (queue_obj.length() === 0) return;
        const oldestTask = queue_obj.oldest();
        if (oldestTask && Date.now() - oldestTask.data.time <= 60 * 1000) return;
        /** @type {Record<string, number>} */
        const miner_address = Object.create(null);
        queue_obj.remove(function removeExpired(task) {
            const d = task.data;
            miner_address[d.miner_address] = (miner_address[d.miner_address] ?? 0) + 1;
            if (Date.now() - d.time <= 60 * 1000) return false;
            decrementMinerAddressVerify(d.miner_address);
            d.cb(null);
            return true;
        });
        console.error(`${global.database.thread_id  }Share verify queue ${  queueIndex  } state: ${  queue_obj.length()  } items in the queue ${  queue_obj.running()  } items being processed`);
        Object.keys(miner_address).forEach(function reportMiner(key) {
            if ((miner_address[key] ?? 0) > 100) {
                const minerKey = String(key || "");
                console.error(`Too many shares from ${  minerKey.substr(minerKey.length - 10)  }: ${  miner_address[key]}`);
            }
        });
    }, 30 * 1000, queue, index);
    return { queue, health, host: verify_shares_host };
});

/** @param {unknown} data */
function Coin(data) {
    this.data = data;
    this.uniqueWorkerId = 0;
    this.uniqueWorkerIdBits = 0;
    this.verify_share_host_index = 0;
    /** @type {Record<string, {hash: string, header: import("../../types/runtime").BlockHeader}>} */
    this.lastBlockCache = {};
    const self = this;

    const mainProfileCandidate = getProfileByPort(global.config.daemon.port) || registry.profiles.find(function findNetworkProfile(profile) {
        return Boolean(profile.network);
    }) || registry.profiles[0];
    if (!mainProfileCandidate || !mainProfileCandidate.network || !mainProfileCandidate.addresses) throw new Error("Main coin profile requires network and address settings");
    /** @type {import("../../types/coin_profiles").CoinProfile} */
    const mainProfile = mainProfileCandidate;
    const networkConfig = mainProfileCandidate.network[global.config.general.testnet === true ? "testnet" : "mainnet"];
    if (!networkConfig) throw new Error("Main coin profile has no settings for the configured network");

    this.coinDevAddress = mainProfileCandidate.addresses.coinDev;
    this.poolDevAddress = mainProfileCandidate.addresses.poolDev;
    this.blockedAddresses = [this.coinDevAddress, this.poolDevAddress].concat(mainProfileCandidate.addresses.blocked || []);
    this.prefix = networkConfig.prefix;
    this.subPrefix = networkConfig.subPrefix;
    this.intPrefix = networkConfig.intPrefix;
    if (typeof mainProfile.niceHashDiff !== "number") throw new Error("Main coin profile requires a NiceHash difficulty");
    this.niceHashDiff = mainProfile.niceHashDiff;
    this.registry = registry;

    const instanceId = Buffer.alloc(4);
    // Pack a 32-bit nonce-area instance id: high 10 bits = pool_id, low 22 bits = pid (stored little-endian).
    instanceId.writeUInt32LE((((global.config.pool_id % (1 << 10)) << 22) + (process.pid % (1 << 22))) >>> 0);
    if (global.argv && global.argv["module"] === "pool") {
        console.log(`Generated instanceId: ${  instanceId.toString("hex")}`);
    }

    /** @param {import("../../types/coin_profiles").ProfileRuntime["coinFuncs"]} [context] */
    function createRuntime(context) {
        return {
            blockTemplate,
            cnUtil: blockTemplate,
            coin2port,
            coinFuncs: context || self,
            getPoolAddress,
            mmChildPortSet: mm_child_port_set,
            mmNonceSize: mm_nonce_size,
            mmPortSet: mm_port_set,
            multiHashing: powHash,
            owner: self,
            poolNonceSize: pool_nonce_size,
            powHash,
            support: global.support,
            toBuffer
        };
    }

    /** @param {unknown} value @returns {value is ProfileCoinFuncs} */
    function isProfileCoinFuncs(value) {
        return isRecord(value)
            && typeof value["getPortAnyBlockHeaderByHash"] === "function"
            && typeof value["getPortBlockHeaderByID"] === "function"
            && typeof value["getPortBlockTemplate"] === "function";
    }

    /** @param {string | number} key @param {number | undefined} version @param {Coin} context */
    function resolveProfileKey(key, version, context) {
        if (typeof key === "number") return resolveProfile(key, version, context);
        if (typeof key === "string" && /^\d+$/.test(key)) return resolveProfile(parseInt(key, 10), version, context);
        if (key === "") return mainProfile;
        return typeof key === "string" ? getProfileByCoin(key) : null;
    }

    /** @param {string | number} key @returns {import("../../types/coin_profiles").CoinProfile | null} */
    this.getCoinProfile = function getCoinProfile(key) {
        return resolveProfileKey(key, undefined, this);
    };

    this.getPoolProfile = this.getCoinProfile;
    /** @param {number} blobType */
    this.getProfilesByBlobType = function getProfiles(blobType) {
        return getProfilesByBlobType(blobType).slice();
    };
    /** @param {number} blobType */
    this.getBlobTraits = function getTraits(blobType) {
        return Object.assign({}, getBlobTraits(blobType));
    };
    /** @param {{coin?: string, blob_type_num?: number | string, port?: number}} job @returns {import("../../types/coin_profiles").CoinProfile | null} */
    this.getJobProfile = function getJobProfile(job) {
        if (job && typeof job.coin === "string") {
            const profile = this.getCoinProfile(job.coin);
            if (profile) return profile;
        }
        if (job && (typeof job.blob_type_num === "number" || typeof job.blob_type_num === "string")) {
            const profile = getProfileByBlobType(Number(job.blob_type_num), { ...(job.coin !== undefined ? { coin: job.coin } : {}), ...(job.port !== undefined ? { port: job.port } : {}) });
            if (profile) return profile;
        }
        return null;
    };
    /** @param {string | number} key @param {number} [version] @returns {import("../../types/coin_profiles").CoinProfile | null} */
    this.getResolvedProfile = function getResolvedProfile(key, version) {
        return resolveProfileKey(key, version, this);
    };
    /** @param {string | number} key @param {number} [version] @returns {Partial<import("../../types/pool_profiles").PoolProfileSettings> | null} */
    this.getPoolSettings = function getPoolSettings(key, version) {
        const profile = this.getResolvedProfile(key, version);
        return profile && profile.pool ? profile.pool : null;
    };
    /** @param {string | number} key @param {number} [version] @returns {import("../../types/coin_profiles").RpcSettings | null} */
    this.getRpcSettings = function getRpcSettings(key, version) {
        const profile = this.getResolvedProfile(key, version);
        return profile && profile.rpc ? profile.rpc : null;
    };
    this.baseDiff = blockTemplate.baseDiff;
    this.baseRavenDiff = blockTemplate.baseRavenDiff;

    /** @param {string} address */
    this.validatePlainAddress = function validatePlainAddress(address) {
        const code = blockTemplate.address_decode(Buffer.from(address));
        return code === this.prefix || code === this.subPrefix;
    };

    /** @param {string} address */
    this.validateAddress = function validateAddress(address) {
        if (this.validatePlainAddress(address)) return true;
        return blockTemplate.address_decode_integrated(Buffer.from(address)) === this.intPrefix;
    };

    /** @param {number} port @param {number} [_version] */
    this.portBlobType = function portBlobType(port, _version) {
        return port2blob_num[port];
    };

    /** @param {number} port @param {number | undefined} version @param {Pick<Coin, "portBlobType">} context */
    function resolveProfile(port, version, context) {
        const directProfile = getProfileByPort(port);
        if (directProfile) return directProfile;
        const resolver = context && typeof context.portBlobType === "function" ? context : self;
        const blobType = resolver.portBlobType(port, version);
        if (typeof blobType === "undefined") return null;
        return getProfileByBlobType(blobType, { port });
    }

    /** @param {unknown} context @param {number} port @param {string} methodName @param {RpcCallback} callback @param {RpcDispatchOptions} [options] @returns {unknown} */
    function callProfileRpc(context, port, methodName, callback, options) {
        const config = options || {};
        const profile = resolveProfile(port, undefined, self);
        const handler = profile?.rpc?.[methodName];
        if (typeof handler !== "function") {
            if (typeof config.onMissing === "function") return config.onMissing();
            return callback(true, null);
        }
        const runtimeContext = isProfileCoinFuncs(context) ? context : undefined;
        return handler(Object.assign({
            callback,
            noErrorReport: config.noErrorReport,
            port,
            profile,
            runtime: createRuntime(runtimeContext)
        }, config.extra || {}));
    }

    /** @param {{blocktemplate_blob?: string, blob?: string, blockhashing_blob?: string}} template @param {number} port */
    this.hasTemplateBlob = function hasTemplateBlob(template, port) {
        const profile = resolveProfile(port, undefined, this);
        return profile !== null && ((profile.template && profile.template.hashOnly) || (template && (template.blocktemplate_blob || template.blob || template.blockhashing_blob)));
    };

    /** @param {number} blob_type_num */
    this.c29ProofSize = function c29ProofSize(blob_type_num) {
        return getBlobTraits(blob_type_num).proofSize;
    };

    /** @param {number} blob_type_num */
    this.nonceSize = function nonceSize(blob_type_num) {
        return getBlobTraits(blob_type_num).nonceSize;
    };

    /** @param {string | number} key @returns {number | "config"} */
    this.getCoinMinDifficulty = function getCoinMinDifficulty(key) {
        const profile = this.getResolvedProfile(key);
        if (!profile || !profile.pool || profile.pool.minDifficulty === "config" || profile.pool.minDifficulty === undefined) {
            return global.config.pool.minDifficulty;
        }
        return profile.pool.minDifficulty;
    };

    /** @param {string | number} key @returns {number} */
    this.getNiceHashMinimumDifficulty = function getNiceHashMinimumDifficulty(key) {
        const profile = this.getResolvedProfile(key);
        const multiplier = profile && profile.pool && profile.pool.niceHashDiffMultiplier ? profile.pool.niceHashDiffMultiplier : 1;
        return this.niceHashDiff * multiplier;
    };

    /** @param {string | number} key @returns {number} */
    this.getPoolHashesPerDifficulty = function getPoolHashesPerDifficulty(key) {
        const profile = this.getResolvedProfile(key);
        const scale = profile && profile.pool ? Number(profile.pool.hashesPerDifficulty) : 1;
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    };

    /** @param {string | number} key @param {number} difficulty */
    this.getPoolWorkDifficulty = function getPoolWorkDifficulty(key, difficulty) {
        const value = Number(difficulty);
        if (!Number.isFinite(value)) return parseInt(String(difficulty));
        const scale = this.getPoolHashesPerDifficulty(key);
        return scale === 1 ? value : Math.round(value * scale);
    };

    /** @param {Record<string, number>} algos */
    this.normalizeMinerAlgos = function normalizeMinerAlgos(algos) {
        /** @type {Record<string, number>} */
        const normalized = {};
        for (const [algo, value] of Object.entries(algos)) {
            normalized[algo] = value;
            for (const canonicalAlgo of registry.canonicalAlgosByAlias[algo] || []) normalized[canonicalAlgo] = value;
        }
        return normalized;
    };

    /** @param {Buffer} blobBuffer @param {number} port */
    this.convertBlob = function convertBlob(blobBuffer, port) {
        const profile = resolveProfile(port, blobBuffer[0], this);
        if (!profile || !profile.blob || typeof profile.blob.convert !== "function") return null;
        try {
            return profile.blob.convert({ blobBuffer, port, profile, runtime: createRuntime(this) });
        } catch (error) {
            const err_str = `Can't do port ${  port  } convert_blob ${  blobBuffer.toString("hex")  } with blob type ${  profile.blobType  }: ${  error}`;
            console.error(err_str);
            global.support.sendAdminFyi(`coins:convert-blob:${  port}`, "FYI: Can't convert_blob", err_str);
            return null;
        }
    };

    /** @param {Buffer} blockTemplateBuffer @param {{nonce: string, mixhash?: string, pow?: number[]}} params @param {number} port */
    this.constructNewBlob = function constructNewBlob(blockTemplateBuffer, params, port) {
        const profile = resolveProfile(port, blockTemplateBuffer[0], this);
        if (!profile || !profile.blob || typeof profile.blob.construct !== "function") return null;
        return profile.blob.construct({ blockTemplateBuffer, params, port, profile, runtime: createRuntime(this) });
    };

    /** @param {Buffer} parentTemplateBuffer @param {number} port @param {Buffer} childTemplateBuffer */
    this.constructMMParentBlockBlob = function constructMMParentBlockBlob(parentTemplateBuffer, port, childTemplateBuffer) {
        const blobType = this.portBlobType(port, parentTemplateBuffer[0]);
        if (blobType === undefined) throw new Error(`Unknown merged-mining port: ${port}`);
        return blockTemplate.construct_mm_parent_block_blob(parentTemplateBuffer, blobType, childTemplateBuffer);
    };

    /** @param {Buffer} shareBuffer @param {number} port @param {Buffer} childTemplateBuffer */
    this.constructMMChildBlockBlob = function constructMMChildBlockBlob(shareBuffer, port, childTemplateBuffer) {
        const blobType = this.portBlobType(port, shareBuffer[0]);
        if (blobType === undefined) throw new Error(`Unknown merged-mining port: ${port}`);
        return blockTemplate.construct_mm_child_block_blob(shareBuffer, blobType, childTemplateBuffer);
    };

    /** @param {Buffer} blockBuffer @param {number} port */
    this.getBlockID = function getBlockID(blockBuffer, port) {
        const profile = resolveProfile(port, blockBuffer[0], this);
        if (!profile || !profile.blob || typeof profile.blob.getBlockId !== "function") return blockTemplate.get_block_id(blockBuffer, 0);
        return profile.blob.getBlockId({ blockBuffer, port, profile, runtime: createRuntime(this) });
    };

    /** @param {unknown} obj */
    this.getAuxChainXTM = function getAuxChainXTM(obj) {
        if (!isRecord(obj)) return null;
        const aux = obj["_aux"];
        if (!isRecord(aux)) return null;
        const chains = aux["chains"];
        if (!Array.isArray(chains) || chains.length !== 1) return null;
        const chain = chains[0];
        if (!isRecord(chain)) return null;
        return chain;
    };

    /** @param {import("../../types/coin_profiles").BlockTemplateInput} template @param {import("../../types/coin_profiles").TemplateSettings} templateConfig @param {boolean} is_mm @param {string} blob */
    function getReservedOffset(template, templateConfig, is_mm, blob) {
        if (templateConfig.reserveOffsetSource === "template") return template.reserved_offset ?? template.reservedOffset ?? null;
        const template_hex = (template.port in mm_port_set && !is_mm) ? extra_nonce_mm_template_hex : extra_nonce_template_hex;
        const found = blob.indexOf(template_hex);
        if (found === -1) return (template.reserved_offset || template.reservedOffset) ?? null;
        const offset = (found >> 1) + 2;
        if (is_mm || templateConfig.reserveOffsetSource === "blob" || templateConfig.reserveOffsetSource === "found") return offset;
        if (template.reserved_offset && !template._aux) return template.reserved_offset;
        return template.reservedOffset || offset;
    }

    /** @param {import("../../types/coin_profiles").BlockTemplateInput} template */
    this.BlockTemplate = function BlockTemplate(template) {
        const profile = resolveProfile(template.port, undefined, global.coinFuncs || self);
        const templateConfig = profile && profile.template ? profile.template : {};
        this.difficulty = template.mbl_difficulty ? template.mbl_difficulty : template.difficulty;
        const auxBaseDifficulty = template._aux && template._aux.base_difficulty !== undefined ? parseInt(String(template._aux.base_difficulty), 10) : this.difficulty;
        this.xmr_difficulty = template.wide_difficulty ? parseInt(template.wide_difficulty, 16) : auxBaseDifficulty;
        const aux_chain_xtm = global.coinFuncs.getAuxChainXTM(template);
        if (aux_chain_xtm) {
            this.xtm_height = parseInt(String(aux_chain_xtm["height"]), 10);
            this.xtm_difficulty = parseInt(String(aux_chain_xtm["difficulty"]), 10);
            this.difficulty = Math.min(this.xmr_difficulty, this.xtm_difficulty);
        }
        this.xtm_block = template.xtm_block;
        this.height = template.height;
        this.bits = template.bits;
        this.seed_hash = template.seed_hash;
        this.coin = template.coin;
        this.port = template.port;
        this.disableProxyNonce = template.no_proxy_nonce === true || template.disable_proxy_nonce === true;

        const templateBlob = template.blocktemplate_blob || template.blob;
        if (!templateBlob && templateConfig.hashOnly) {
            const hash = template.hash;
            if (typeof hash !== "string") throw new Error("Hash-only template requires a hash");
            this.hash = this.idHash = hash;
            this.hash2 = template.hash2;
            this.block_version = 0;
            this.nextBlobHex = function nextBlobHex() { return hash; };
            return;
        }
        if (!templateBlob) console.error(`INTERNAL ERROR: No blob in ${this.port} port block template: ${JSON.stringify(template)}`);
        this.blocktemplate_blob = templateBlob || extra_nonce_mm_template_hex;

        const is_mm = "child_template" in template;
        if (is_mm) {
            this.child_template = template.child_template;
            this.child_template_buffer = template.child_template_buffer;
        }

        const blobField = templateConfig.bufferField || "blocktemplate_blob";
        const blob = is_mm ? template.parent_blocktemplate_blob
            : (template[blobField] || this.blocktemplate_blob);
        if (typeof blob !== "string") throw new Error("Merged-mining template requires a parent blob");

        this.idHash = crypto.createHash("md5").update(blob).digest("hex");
        const buffer = Buffer.from(blob, "hex");
        this.buffer = buffer;
        this.block_version = buffer[0] ?? 0;

        const reservedOffset = getReservedOffset(template, templateConfig, is_mm, blob);
        const offset = reservedOffset ?? 0;
        this.reserved_offset = offset;
        if (reservedOffset === null) {
            console.error(`INTERNAL ERROR: No reserved offset in ${  this.port  } port block template: ${  JSON.stringify(template)}`);
        }

        if (template.bt_nonce_size === undefined || template.bt_nonce_size >= 16) {
            instanceId.copy(this.buffer, this.reserved_offset + 4, 0, 4);
            this.extraNonce = 0;
            if (!this.disableProxyNonce) {
                this.clientNonceLocation = this.reserved_offset + 12;
                this.clientPoolLocation = this.reserved_offset + 8;
            }
            this.nextBlobHex = function nextBlobHex() {
                buffer.writeUInt32BE(this.extraNonce = (this.extraNonce ?? 0) + 1, offset);
                const blobHex = global.coinFuncs.convertBlob(buffer, template.port);
                return blobHex ? blobHex.toString("hex") : null;
            };
            this.nextBlobWithChildNonceHex = function nextBlobWithChildNonceHex() {
                buffer.writeUInt32BE(this.extraNonce = (this.extraNonce ?? 0) + 1, offset);
                return buffer.toString("hex");
            };
        } else {
            this.extraNonce = 0;
            this.extraNonce2 = 0;
            this.nextBlobHex = function nextBlobHex() {
                const blobHex = global.coinFuncs.convertBlob(buffer, template.port);
                return blobHex ? blobHex.toString("hex") : null;
            };
            this.nextBlobWithChildNonceHex = function nextBlobWithChildNonceHex() {
                return null;
            };
        }
    };

    this.getPORTS = function getPORTS() { return ports; };
    this.getCOINS = function getCOINS() { return coins; };
    /** @this {Coin} @param {number | string} port */
    this.PORT2COIN = function PORT2COIN(port) {
        if (port.toString() in port2coin) return port2coin[port];
        const profile = resolveProfile(Number(port), undefined, this);
        return profile ? profile.displayCoin : undefined;
    };
    /** @this {Coin} @param {number | string} port */
    this.PORT2COIN_FULL = function PORT2COIN_FULL(port) {
        if (port.toString() in port2displayCoin) return port2displayCoin[port];
        const coin = this.PORT2COIN(port);
        return coin === "" ? mainProfile.displayCoin : coin;
    };
    /** @param {string} coin */
    this.COIN2PORT = function COIN2PORT(coin) { return coin2port[coin]; };
    this.getMM_PORTS = function getMM_PORTS() { return mm_port_set; };
    this.getMM_CHILD_PORTS = function getMM_CHILD_PORTS() { return mm_child_port_set; };

    this.getDefaultAlgos = function getDefaultAlgos() {
        return Object.keys(registry.defaultAlgoPerf);
    };

    this.getDefaultAlgosPerf = function getDefaultAlgosPerf() {
        return Object.assign({}, registry.defaultAlgoPerf);
    };

    this.getPrevAlgosPerf = function getPrevAlgosPerf() {
        return Object.assign({}, registry.prevAlgoPerf);
    };

    /** @param {Record<string, number>} algos_perf */
    this.convertAlgosToCoinPerf = function convertAlgosToCoinPerf(algos_perf) {
        /** @type {Record<string, number>} */
        const coin_perf = {};
        registry.profiles.forEach(function registerPerf(profile) {
            if (!profile.perf || !profile.perf.aliases || !profile.perf.aliases.length) return;
            const coinKey = typeof profile.coin === "string" ? profile.coin : profile.displayCoin;
            for (const alias of profile.perf.aliases) {
                let perf = algos_perf[alias];
                if (perf === undefined) continue;
                if (Array.isArray(profile.perf.legacyDifficultyAliases) && profile.perf.legacyDifficultyAliases.includes(alias)) {
                    const scale = profile.pool ? Number(profile.pool.hashesPerDifficulty) : 1;
                    if (Number.isFinite(scale) && scale > 0) perf *= scale;
                }
                coin_perf[coinKey] = perf;
                break;
            }
        });
        return coin_perf;
    };

    /** @param {Record<string, number>} algos */
    this.algoMainCheck = function algoMainCheck(algos) {
        return Object.keys(registry.mainAlgoSet).some(function hasMainAlgo(algo) {
            return algo in algos;
        });
    };

    /** @param {Record<string, number>} algos */
    this.algoPrevMainCheck = function algoPrevMainCheck(algos) {
        return Object.keys(registry.prevMainAlgoSet).some(function hasPrevMainAlgo(algo) {
            return algo in algos;
        });
    };

    /** @param {Record<string, number>} algos */
    this.algoCheck = function algoCheck(algos) {
        if (this.algoMainCheck(algos)) return true;
        for (const algo in all_algos) if (algo in algos) return true;
        return `algo array must include at least one supported pool algo: [${  Object.keys(algos).join(", ")  }]`;
    };

    /** @param {Buffer} convertedBlob @param {import("../../types/coin_profiles").HashTemplate} template @param {string} [nonce] @param {string} [mixhash] */
    this.slowHashBuff = function slowHashBuff(convertedBlob, template, nonce, mixhash) {
        const profile = resolveProfile(template.port, template.block_version, this);
        if (!profile || !profile.pow || typeof profile.pow.hashBuff !== "function") {
            console.error(`Unknown ${  template.port  } port for Cryptonight PoW type`);
            return powHash.cryptonight(convertedBlob, 13, template.height);
        }
        return profile.pow.hashBuff({
            blockTemplate: template,
            algo: profile.algo,
            convertedBlob,
            ...(mixhash !== undefined ? { mixhash } : {}),
            ...(nonce !== undefined ? { nonce } : {}),
            port: template.port,
            profile,
            runtime: createRuntime(this)
        });
    };

    /** @param {Buffer} convertedBlob @param {import("../../types/coin_profiles").HashTemplate} template @param {string} [nonce] @param {string} [mixhash] */
    this.slowHash = function slowHash(convertedBlob, template, nonce, mixhash) {
        const result = this.slowHashBuff(convertedBlob, template, nonce, mixhash);
        if (result === false) return false;
        return Array.isArray(result) ? result.map(hash => hash.toString("hex")) : result.toString("hex");
    };

    // KAWPOW finalizer is kept local because it is a cheap special-verifier precheck.
    /** @param {Buffer} convertedBlob @param {string} nonce @param {string} mixhash */
    this.kawpowQuickHash = function kawpowQuickHash(convertedBlob, nonce, mixhash) {
        return powHash.kawpow(convertedBlob, Buffer.from(nonce, "hex"), Buffer.from(mixhash, "hex"));
    };

    /** @param {Buffer} convertedBlob @param {import("../../types/coin_profiles").HashTemplate} template @param {string} miner_address @param {(result: import("../../types/coin_profiles").HexHashResult, errorKind?: string) => void} cb @param {import("../../types/coin_profiles").VerifyContext} [verifyContext] */
    this.slowHashAsync = function slowHashAsync(convertedBlob, template, miner_address, cb, verifyContext) {
        const nonce = verifyContext && verifyContext.nonce;
        const mixhash = verifyContext && verifyContext.mixhash;
        const profile = resolveProfile(template.port, template.block_version, this);
        const hashLocal = () => this.slowHash(convertedBlob, template, nonce, mixhash);

        if (!hasVerifyShareHosts()) {
            try {
                return cb(hashLocal());
            } catch (_error) {
                return cb(false, "local-hash-error");
            }
        }

        const pending = miner_address_verify[miner_address] ?? 0;
        if (pending > 100) return cb(null);
        miner_address_verify[miner_address] = pending + 1;

        let jsonInput = { algo: profile?.algo || this.algoShortTypeStr(template.port), blob: convertedBlob.toString("hex") };
        if (profile && profile.pow && typeof profile.pow.verifyInput === "function") {
            jsonInput = profile.pow.verifyInput({
                algo: profile.algo,
                blockTemplate: template,
                convertedBlob,
                ...(mixhash !== undefined ? { mixhash } : {}),
                ...(nonce !== undefined ? { nonce } : {}),
                port: template.port,
                profile,
                runtime: createRuntime(this)
            });
        }

        const time_now = Date.now();
        /** @type {typeof shareVerifyQueues[number] | null} */
        let bestQueue = null;
        let minQueueSize = Infinity;
        for (const candidate of shareVerifyQueues) {
            if (time_now - candidate.health.lastErrorAt < 60 * 1000 && candidate.health.errorCount > 0 && candidate.host !== "127.0.0.1") continue;
            const queueSize = candidate.queue.length() + candidate.queue.running();
            if (queueSize < minQueueSize) {
                bestQueue = candidate;
                minQueueSize = queueSize;
            }
        }
        // If every remote verifier is cooling down, retry the least recently failed one.
        if (!bestQueue) {
            for (const candidate of shareVerifyQueues) {
                if (!bestQueue || candidate.health.lastErrorAt < bestQueue.health.lastErrorAt) bestQueue = candidate;
            }
        }
        if (!bestQueue) return cb(null);

        return bestQueue.queue.unshift({
            jsonInput,
            cb(result, errorKind) {
                return cb(result, errorKind);
            },
            time: time_now,
            miner_address
        });
    };

    /** @typedef {(result: import("../../types/coin_profiles").BufferHashResult, errorKind?: string) => void} BufferHashCallback */
    /**
     * @overload
     * @param {Buffer} convertedBlob
     * @param {import("../../types/coin_profiles").HashTemplate} template
     * @param {string} miner_address
     * @param {BufferHashCallback} cb
     * @param {import("../../types/coin_profiles").VerifyContext} [verifyContext]
     * @returns {void}
     */
    /**
     * @overload
     * @param {Buffer} convertedBlob
     * @param {import("../../types/coin_profiles").HashTemplate} template
     * @param {BufferHashCallback} cb
     * @param {import("../../types/coin_profiles").VerifyContext} [verifyContext]
     * @returns {void}
     */
    /**
     * @param {Buffer} convertedBlob
     * @param {import("../../types/coin_profiles").HashTemplate} template
     * @param {string | ((result: import("../../types/coin_profiles").BufferHashResult, errorKind?: string) => void)} miner_address
     * @param {((result: import("../../types/coin_profiles").BufferHashResult, errorKind?: string) => void) | import("../../types/coin_profiles").VerifyContext} [cb]
     * @param {import("../../types/coin_profiles").VerifyContext} [verifyContext]
     */
    this.slowHashBuffAsync = function slowHashBuffAsync(convertedBlob, template, miner_address, cb, verifyContext) {
        // Support the overloaded signature where (cb, verifyContext) are passed positionally
        // without a miner_address; shift them into locals rather than mutating the params.
        const isShifted = typeof miner_address === "function";
        const callback = isShifted ? miner_address : typeof cb === "function" ? cb : null;
        if (!callback) throw new TypeError("A hash result callback is required");
        const context = isShifted && cb && typeof cb === "object" ? cb : verifyContext;
        const minerAddress = isShifted ? "" : miner_address;
        const nonce = context && context.nonce;
        const mixhash = context && context.mixhash;

        if (!hasVerifyShareHosts()) {
            try {
                return callback(this.slowHashBuff(convertedBlob, template, nonce, mixhash));
            } catch (_error) {
                return callback(false, "local-hash-error");
            }
        }

        return this.slowHashAsync(convertedBlob, template, minerAddress || "", function onRemoteHash(hash, errorKind) {
            return callback(verifierResultToBuffers(hash), errorKind);
        }, context);
    };

    this.isHashVerifierEnabled = hasVerifyShareHosts;

    // C29 proof helpers are kept local because they are cheap special-verifier checks.
    /** @param {Buffer} header @param {number[]} ring @param {number} port */
    this.c29 = function c29(header, ring, port) {
        const profile = resolveProfile(port, undefined, this);
        if (!profile || !profile.pow || typeof profile.pow.c29 !== "function") return powHash.c29s(header, ring);
        return profile.pow.c29({ header, port, profile, ring, runtime: createRuntime(this) });
    };

    /** @param {number[]} ring @param {number} blob_type_num @param {number | string | {port?: number, coin?: string}} [hint] */
    this.c29_packed_edges = function c29_packed_edges(ring, blob_type_num, hint) {
        const profile = getProfileByBlobType(blob_type_num,
            typeof hint === "number" ? { port: hint } :
                typeof hint === "string" ? { coin: hint } :
                    hint
        );
        if (!profile || !profile.pow || typeof profile.pow.packEdges !== "function") return powHash.c29s_packed_edges(ring);
        return profile.pow.packEdges({ blobType: blob_type_num, profile, ring, runtime: createRuntime(this) });
    };

    /** @param {string} packed_edges */
    this.c29_cycle_hash = function c29_cycle_hash(packed_edges) {
        return powHash.c29_cycle_hash(packed_edges);
    };

    /** @param {number} port */
    this.blobTypeStr = function blobTypeStr(port) {
        const profile = resolveProfile(port, undefined, this);
        return profile ? profile.blobTypeName : "cryptonote";
    };

    /** @param {number} port */
    this.algoShortTypeStr = function algoShortTypeStr(port) {
        const profile = resolveProfile(port, undefined, this);
        if (profile) return profile.algo;
        console.error(`Unknown ${  port  } port for PoW type`);
        return "rx/0";
    };

    /** @param {string} algo @param {Record<string, number>} algos */
    this.isMinerSupportAlgo = function isMinerSupportAlgo(algo, algos) {
        if (algo in algos) return true;
        const aliases = registry.minerAlgoAliases[algo];
        if (!aliases) return false;
        return aliases.some(function hasAlias(alias) {
            return alias in algos;
        });
    };

    /** @param {string} agent */
    this.get_miner_agent_warning_notification = function get_miner_agent_warning_notification(agent) {
        for (const profile of registry.profiles) {
            const warningRules = profile.agent && profile.agent.warningRules;
            if (!warningRules) continue;
            for (const rule of warningRules) {
                const version = versionMatches(agent, rule.matcher);
                if (!version || !versionAllowed(version, rule)) continue;
                return rule.message.replace("{agent}", agent);
            }
        }
        return false;
    };

    /** @param {string} agent */
    this.is_miner_agent_no_haven_support = function is_miner_agent_no_haven_support(agent) {
        return this.getUnsupportedAlgosForMiner(agent).length > 0;
    };

    /** @param {string} agent */
    this.get_miner_agent_not_supported_algo = function get_miner_agent_not_supported_algo(agent) {
        for (const profile of registry.profiles) {
            const unsupportedByMatcher = profile.agent && profile.agent.unsupportedByMatcher;
            if (!unsupportedByMatcher) continue;
            for (const [matcher, algo] of Object.entries(unsupportedByMatcher)) {
                if (versionMatches(agent, matcher)) return algo;
            }
        }
        return false;
    };

    /** @param {string} agent */
    this.getUnsupportedAlgosForMiner = function getUnsupportedAlgosForMiner(agent) {
        /** @type {string[]} */
        const unsupportedAlgos = [];
        for (const profile of registry.profiles) {
            const noSupportRules = profile.agent && profile.agent.noSupportRules;
            if (!noSupportRules) continue;
            for (const rule of noSupportRules) {
                const version = versionMatches(agent, rule.matcher);
                if (!version || !versionAllowed(version, rule)) continue;
                const profileUnsupportedAlgos = Array.isArray(rule.unsupportedAlgos) ? rule.unsupportedAlgos : [];
                profileUnsupportedAlgos.forEach(function addUnsupportedAlgo(algo) {
                    if (!unsupportedAlgos.includes(algo)) unsupportedAlgos.push(algo);
                });
            }
        }
        return unsupportedAlgos;
    };

    /** @typedef {{reason?: string, height?: number | string | null | undefined, topHeight?: number | string | null | undefined, xmrHeight?: number | string | null | undefined, expectedXmrHeight?: number | string | null | undefined, xtmHeight?: number | string | null | undefined, expectedXtmHeight?: number | string | null | undefined, port?: number | null | undefined}} DaemonIssueInput */

    /** @param {DaemonIssueInput | number | string | null | undefined} issueOrHeight @param {number} [topHeight] @param {number} [port] */
    function normalizeDaemonIssue(issueOrHeight, topHeight, port) {
        // Accept legacy positional heights and aliases at this boundary only.
        /** @type {DaemonIssueInput} */
        const issue = typeof issueOrHeight === "object" && issueOrHeight !== null
            ? issueOrHeight : { xmrHeight: issueOrHeight, expectedXmrHeight: topHeight, port };
        return {
            reason: issue.reason || "template-stuck",
            xmrHeight: issue.xmrHeight ?? issue.height ?? null,
            expectedXmrHeight: issue.expectedXmrHeight ?? issue.topHeight ?? null,
            xtmHeight: issue.xtmHeight ?? null,
            expectedXtmHeight: issue.expectedXtmHeight ?? null,
            port: issue.port ?? null
        };
    }

    /** @param {string[]} args @param {string} flag @param {number | string | null} value */
    function appendDaemonIssueArg(args, flag, value) {
        if (value === null || value === "") return;
        args.push(flag, String(value));
    }

    /** @param {ReturnType<typeof normalizeDaemonIssue>} issue */
    function daemonIssueArgs(issue) {
        const args = [issue.reason || "template-stuck"];
        appendDaemonIssueArg(args, "--port", issue.port);
        appendDaemonIssueArg(args, "--xmr-height", issue.xmrHeight);
        appendDaemonIssueArg(args, "--expected-xmr-height", issue.expectedXmrHeight);
        appendDaemonIssueArg(args, "--xtm-height", issue.xtmHeight);
        appendDaemonIssueArg(args, "--expected-xtm-height", issue.expectedXtmHeight);
        return args;
    }

    /** @param {ReturnType<typeof normalizeDaemonIssue>} issue */
    function daemonIssueHeightSummary(issue) {
        const parts = [];
        if (issue.xmrHeight !== null || issue.expectedXmrHeight !== null) {
            parts.push(`XMR height ${  issue.xmrHeight !== null ? issue.xmrHeight : "unknown" 
                } expected ${  issue.expectedXmrHeight !== null ? issue.expectedXmrHeight : "unknown"}`);
        }
        if (issue.xtmHeight !== null || issue.expectedXtmHeight !== null) {
            parts.push(`XTM height ${  issue.xtmHeight !== null ? issue.xtmHeight : "unknown" 
                } expected ${  issue.expectedXtmHeight !== null ? issue.expectedXtmHeight : "unknown"}`);
        }
        return parts.length ? parts.join("; ") : "height unknown expected unknown";
    }

    /** @param {DaemonIssueInput | number | string | null | undefined} issueOrHeight @param {number} [topHeight] @param {number} [port] */
    this.fixDaemonIssue = function fixDaemonIssue(issueOrHeight, topHeight, port) {
        const issue = normalizeDaemonIssue(issueOrHeight, topHeight, port);
        const args = daemonIssueArgs(issue);
        const issuePort = issue.port !== null ? issue.port : "unknown";
        global.support.sendEmail(
            global.config.general.adminEmail,
            `Pool server ${  global.config.hostname  } has daemon issue: ${  issue.reason}`,
            `The pool server: ${  global.config.hostname  } with IP: ${  global.config.bind_ip 
            } has daemon issue for ${  issuePort  } port: ${  issue.reason  }\n` +
            `Observed heights amongst other leaf nodes: ${  daemonIssueHeightSummary(issue)  }\n` +
            `Attempting to fix ${  issue.reason  }...`
        );
        if (!fs.existsSync(fix_daemon_sh)) {
            console.error(`No ${  fix_daemon_sh  } script was found to fix stuff`);
            return;
        }
        child_process.execFile(fix_daemon_sh, args, function callback(error, stdout, stderr) {
            console.log(`> ${  fix_daemon_sh  } ${  args.join(" ")}`);
            console.log(stdout);
            console.error(stderr);
            if (error) console.error(`${fix_daemon_sh  } script returned error exit code: ${  error.code}`);
        });
    };

    /** @param {number} port @param {string} miner_hex @param {string} nonce_hex @param {string} block_height_hex @param {import("../../types/coin_profiles").EthBlockCallback} callback */
    this.ethBlockCheck = function ethBlockCheck(port, miner_hex, nonce_hex, block_height_hex, callback) {
        const profile = resolveProfile(port, undefined, this);
        global.support.rpcPortDaemon2(port, "", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [block_height_hex, true] }, function onBlock(body) {
            const block = isRecord(body) && isRecord(body["result"]) ? body["result"] : null;
            if (!block) return callback(null, null);
            if (block["miner"] === miner_hex && block["nonce"] === nonce_hex && typeof block["hash"] === "string") return callback(block["hash"]);
            const heightHex = block["number"];
            const uncles = block["uncles"];
            if (typeof heightHex !== "string" || !Array.isArray(uncles)) return callback(null, null);
            const blockHeight = parseInt(heightHex, 16);
            if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) return callback(null, null);
            findSeries(uncles.map((_uncle, index) => index), function eachUncle(index, next) {
                global.support.rpcPortDaemon2(port, "", { jsonrpc: "2.0", id: 1, method: "eth_getUncleByBlockNumberAndIndex", params: [heightHex, `0x${index.toString(16)}`] }, function onUncle(body_uncle) {
                    const uncle = isRecord(body_uncle) && isRecord(body_uncle["result"]) ? body_uncle["result"] : null;
                    return next(uncle && uncle["miner"] === miner_hex && uncle["nonce"] === nonce_hex && typeof uncle["hash"] === "string" ? uncle["hash"] : null);
                });
            }, /** @param {string | null} blockHash */ function onComplete(blockHash) {
                return callback(blockHash, blockHeight, profile);
            });
        });
    };

    /** @param {number} port @param {string} nonce_hex @param {(hash: string | null) => void} callback */
    this.ethBlockFind = function ethBlockFind(port, nonce_hex, callback) {
        const miner_hex = global.config.pool[`address_${port}`];
        if (typeof miner_hex !== "string") return callback(null);
        global.coinFuncs.ethBlockCheck(port, miner_hex, nonce_hex, "latest", function onLatest(block_hash, block_height) {
            if (block_hash) return callback(block_hash);
            if (!block_height) return callback(null);
            findSeries(Array.from({ length: 32 }, function mapHeight(_value, index) {
                return block_height - index - 1;
            }), function eachHeight(nextHeight, next) {
                global.coinFuncs.ethBlockCheck(port, miner_hex, nonce_hex, `0x${  nextHeight.toString(16)}`, function onCheck(found_hash) {
                    return next(found_hash);
                });
            }, /** @param {string | null} found_hash */ function onDone(found_hash) {
                return callback(found_hash);
            });
        });
    };

    /** @param {number} port @param {number | string} blockId @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortBlockHeaderByID = function getPortBlockHeaderByID(port, blockId, callback, no_error_report) {
        return callProfileRpc(this, port, "getBlockHeaderById", callback, {
            extra: { blockId },
            noErrorReport: no_error_report
        });
    };

    /** @param {number | string} blockId @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getBlockHeaderByID = function getBlockHeaderByID(blockId, callback, no_error_report) {
        return this.getPortBlockHeaderByID(global.config.daemon.port, blockId, callback, no_error_report);
    };

    /** @param {number} port @param {string | Buffer} blockHash @param {boolean} is_our_block @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortAnyBlockHeaderByHash = function getPortAnyBlockHeaderByHash(port, blockHash, is_our_block, callback, no_error_report) {
        // Profiles send hashes through JSON-RPC, so normalize the public Buffer form once.
        const normalizedHash = Buffer.isBuffer(blockHash) ? blockHash.toString("hex") : blockHash;
        return callProfileRpc(this, port, "getAnyBlockHeaderByHash", callback, {
            extra: {
                blockHash: normalizedHash,
                isOurBlock: is_our_block
            },
            noErrorReport: no_error_report
        });
    };

    /** @param {number} port @param {string | Buffer} blockHash @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortBlockHeaderByHash = function getPortBlockHeaderByHash(port, blockHash, callback, no_error_report) {
        return this.getPortAnyBlockHeaderByHash(port, blockHash, true, callback, no_error_report);
    };

    /** @param {string | Buffer} blockHash @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getBlockHeaderByHash = function getBlockHeaderByHash(blockHash, callback, no_error_report) {
        return this.getPortBlockHeaderByHash(global.config.daemon.port, blockHash, callback, no_error_report);
    };

    /** @param {number} port @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortLastBlockHeader = function getPortLastBlockHeader(port, callback, no_error_report) {
        return callProfileRpc(this, port, "getLastBlockHeader", callback, {
            noErrorReport: no_error_report
        });
    };

    /** @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getLastBlockHeader = function getLastBlockHeader(callback, no_error_report) {
        return this.getPortLastBlockHeader(global.config.daemon.port, callback, no_error_report);
    };

    /** @param {number} port @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortLastBlockHeaderWithRewardDiff = function getPortLastBlockHeaderWithRewardDiff(port, callback, no_error_report) {
        const profile = resolveProfile(port, undefined, this);
        return global.coinFuncs.getPortLastBlockHeader(port, function onHeader(is_err, body) {
            if (is_err) return callback(is_err, body);
            if (!body) return callback(true, body);
            const enrichLastBlockHeader = profile?.rpc?.enrichLastBlockHeader;
            if (profile && typeof enrichLastBlockHeader === "function" && isRecord(body)) {
                return enrichLastBlockHeader({
                    callback,
                    header: body,
                    port,
                    profile,
                    runtime: createRuntime(isProfileCoinFuncs(global.coinFuncs) ? global.coinFuncs : undefined)
                });
            }
            return callback(is_err, body);
        }, no_error_report);
    };

    /** @param {number} port @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortLastBlockHeaderMM = function getPortLastBlockHeaderMM(port, callback, no_error_report) {
        const profile = resolveProfile(port, undefined, this);
        return global.coinFuncs.getPortLastBlockHeader(port, function onHeader(is_err, body) {
            if (is_err) return callback(is_err, body);
            if (!body) return callback(true, body);
            const mmCoin = profile && profile.rpc ? profile.rpc.lastHeaderMmCoin : null;
            if (port === global.config.daemon.port && mmCoin) {
                const mmPort = coin2port[mmCoin];
                if (mmPort === undefined) return callback(new Error(`Unknown merged mining coin: ${  mmCoin}`), body);
                return global.coinFuncs.getPortLastBlockHeader(mmPort, function onMMHeader(mm_err, body2) {
                    if (mm_err) return callback(mergedMiningHeaderError(mm_err, mmCoin, mmPort), body);
                    if (!body2) return callback(new Error(`Merged mining header unavailable for ${  mmCoin}`), body);
                    body["mm"] = body2;
                    return callback(null, body);
                }, no_error_report);
            }
            return callback(is_err, body);
        }, no_error_report);
    };

    /** @param {number} port @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getPortBlockTemplate = function getPortBlockTemplate(port, callback, no_error_report) {
        return callProfileRpc(this, port, "getBlockTemplate", callback, {
            noErrorReport: no_error_report,
            onMissing() {
                return callback(null, null);
            }
        });
    };

    /** @param {RpcCallback} callback @param {boolean} [no_error_report] @returns {unknown} */
    this.getBlockTemplate = function getBlockTemplate(callback, no_error_report) {
        return this.getPortBlockTemplate(global.config.daemon.port, callback, no_error_report);
    };
}

module.exports = Coin;
