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
    port2algo,
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

let miner_address_verify = {};
let shareVerifyQueue = [];
let shareVerifyQueueErrorTime = [];
let shareVerifyQueueErrorCount = [];

function parseVersion(match) {
    if (!match) return null;
    return [match[1], match[2], match[3] || "0"].map(function parsePart(part) {
        return parseInt(part || "0", 10);
    });
}

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

function versionAllowed(version, rule) {
    if (!version) return false;
    if (rule.minVersionInclusive && compareVersions(version, rule.minVersionInclusive.split(".").map(Number)) < 0) return false;
    if (rule.maxVersionExclusive && compareVersions(version, rule.maxVersionExclusive.split(".").map(Number)) >= 0) return false;
    return true;
}

function getProfileByPort(port) {
    return registry.profilesByPort[port.toString()] || null;
}

function getProfileByCoin(coin) {
    return registry.profilesByAlias[coin] || null;
}

function getProfilesByBlobType(blobType) {
    return registry.profilesByBlobType[blobType] || [];
}

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
    return profiles.length === 1 ? profiles[0] : null;
}

function getBlobTraits(blobType) {
    return registry.blobTraits[blobType] || { nonceSize: 4, proofSize: 32 };
}

function getPoolAddress(profile) {
    const addressCoin = profile.rpc && profile.rpc.addressCoin;
    if (addressCoin) {
        const addressPort = coin2port[addressCoin];
        if (addressPort === global.config.daemon.port) return global.config.pool.address;
        return global.config.pool["address_" + addressPort.toString()];
    }
    if (profile.port === global.config.daemon.port) return global.config.pool.address;
    return global.config.pool["address_" + profile.port.toString()];
}

if (global.config.verify_shares_host) global.config.verify_shares_host.forEach(function registerVerifyQueue(verify_shares_host, index) {
    shareVerifyQueueErrorTime[index] = 0;
    shareVerifyQueueErrorCount[index] = 0;
    shareVerifyQueue[index] = createTaskQueue(16, function verifyShareRemote(task, queueCB) {
        if (task.miner_address in miner_address_verify) --miner_address_verify[task.miner_address];
        const cb = task.cb;
        if (Date.now() - task.time > 60 * 1000) {
            cb(null);
            return queueCB();
        }

        const socket = new net.Socket();
        let is_cb = false;
        function return_cb(result) {
            if (is_cb) return;
            is_cb = true;
            cb(result);
            return queueCB();
        }

        const timer = setTimeout(function onTimeout() {
            socket.destroy();
            if (shareVerifyQueueErrorCount[index] > 100) {
                const err_str = "Server " + global.config.hostname + " timeouted share verification to " + verify_shares_host;
                console.error(err_str);
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
            }
            shareVerifyQueueErrorTime[index] = Date.now();
            ++shareVerifyQueueErrorCount[index];
            return return_cb(false);
        }, 60 * 1000);

        socket.connect(2222, verify_shares_host, function onConnect() {
            socket.write(JSON.stringify(task.jsonInput) + "\n");
        });

        let buff = "";
        socket.on("data", function onData(buff1) {
            buff += buff1;
        });

        socket.on("end", function onEnd() {
            clearTimeout(timer);
            try {
                const jsonOutput = JSON.parse(buff.toString());
                if (!("result" in jsonOutput)) return return_cb(false);
                shareVerifyQueueErrorCount[index] = 0;
                return return_cb(jsonOutput.result);
            } catch (_error) {
                if (shareVerifyQueueErrorCount[index] > 100) {
                    const err_str = "Server " + global.config.hostname + " got wrong JSON from " + verify_shares_host;
                    console.error(err_str);
                    global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
                }
                shareVerifyQueueErrorTime[index] = Date.now();
                ++shareVerifyQueueErrorCount[index];
                return return_cb(false);
            }
        });

        socket.on("error", function onError() {
            socket.destroy();
            if (shareVerifyQueueErrorCount[index] > 100) {
                const err_str = "Server " + global.config.hostname + " got socket error from " + verify_shares_host;
                console.error(err_str);
                global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
            }
            shareVerifyQueueErrorTime[index] = Date.now();
            ++shareVerifyQueueErrorCount[index];
            return return_cb(false);
        });
    });

    setInterval(function checkQueue(queue_obj, queueIndex) {
        if (queue_obj.length() < 1000) return;
        const miner_address = {};
        queue_obj.remove(function removeExpired(task) {
            const d = task.data;
            if (!(d.miner_address in miner_address)) miner_address[d.miner_address] = 1;
            else ++miner_address[d.miner_address];
            if (Date.now() - d.time <= 60 * 1000) return false;
            d.cb(null);
            return true;
        });
        console.error(global.database.thread_id + "Share verify queue " + queueIndex + " state: " + queue_obj.length() + " items in the queue " + queue_obj.running() + " items being processed");
        Object.keys(miner_address).forEach(function reportMiner(key) {
            if (miner_address[key] > 100) console.error("Too many shares from " + key + ": " + miner_address[key]);
        });
    }, 30 * 1000, shareVerifyQueue[index], index);
});

function Coin(data) {
    this.data = data;
    this.uniqueWorkerId = 0;
    this.uniqueWorkerIdBits = 0;
    this.verify_share_host_index = 0;
    const self = this;

    const mainProfile = getProfileByPort(global.config.daemon.port) || registry.profiles.find(function findNetworkProfile(profile) {
        return !!profile.network;
    }) || registry.profiles[0];
    const networkConfig = global.config.general.testnet === true ? mainProfile.network.testnet : mainProfile.network.mainnet;

    this.coinDevAddress = mainProfile.addresses.coinDev;
    this.poolDevAddress = mainProfile.addresses.poolDev;
    this.blockedAddresses = [this.coinDevAddress, this.poolDevAddress].concat(mainProfile.addresses.blocked || []);
    this.prefix = networkConfig.prefix;
    this.subPrefix = networkConfig.subPrefix;
    this.intPrefix = networkConfig.intPrefix;
    this.niceHashDiff = mainProfile.niceHashDiff;
    this.registry = registry;

    let instanceId = Buffer.alloc(4);
    instanceId.writeUInt32LE((((global.config.pool_id % (1 << 10)) << 22) + (process.pid % (1 << 22))) >>> 0);
    if (global.argv && global.argv.module === "pool") {
        console.log("Generated instanceId: " + instanceId.toString("hex"));
    }

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

    function resolveProfileKey(key, version, context) {
        if (typeof key === "number") return resolveProfile(key, version, context);
        if (typeof key === "string" && /^\d+$/.test(key)) return resolveProfile(parseInt(key, 10), version, context);
        if (key === "") return mainProfile;
        return typeof key === "string" ? getProfileByCoin(key) : null;
    }

    this.getCoinProfile = function getCoinProfile(key) {
        return resolveProfileKey(key, undefined, this);
    };

    this.getPoolProfile = this.getCoinProfile;
    this.getProfilesByBlobType = function getProfiles(blobType) {
        return getProfilesByBlobType(blobType).slice();
    };
    this.getBlobTraits = function getTraits(blobType) {
        return Object.assign({}, getBlobTraits(blobType));
    };
    this.getJobProfile = function getJobProfile(job) {
        if (job && typeof job.coin === "string") {
            const profile = this.getCoinProfile(job.coin);
            if (profile) return profile;
        }
        if (job && (typeof job.blob_type_num === "number" || typeof job.blob_type_num === "string")) {
            const profile = getProfileByBlobType(job.blob_type_num, { coin: job.coin, port: job.port });
            if (profile) return profile;
        }
        return null;
    };
    this.getResolvedProfile = function getResolvedProfile(key, version) {
        return resolveProfileKey(key, version, this);
    };
    this.getPoolSettings = function getPoolSettings(key, version) {
        const profile = this.getResolvedProfile(key, version);
        return profile && profile.pool ? profile.pool : null;
    };
    this.getRpcSettings = function getRpcSettings(key, version) {
        const profile = this.getResolvedProfile(key, version);
        return profile && profile.rpc ? profile.rpc : null;
    };
    this.baseDiff = blockTemplate.baseDiff;
    this.baseRavenDiff = blockTemplate.baseRavenDiff;

    this.validatePlainAddress = function validatePlainAddress(address) {
        const code = blockTemplate.address_decode(Buffer.from(address));
        return code === this.prefix || code === this.subPrefix;
    };

    this.validateAddress = function validateAddress(address) {
        if (this.validatePlainAddress(address)) return true;
        return blockTemplate.address_decode_integrated(Buffer.from(address)) === this.intPrefix;
    };

    this.portBlobType = function portBlobType(port) {
        return port2blob_num[port];
    };

    function resolveProfile(port, version, context) {
        const directProfile = getProfileByPort(port);
        if (directProfile) return directProfile;
        const resolver = context && typeof context.portBlobType === "function" ? context : self;
        const blobType = resolver.portBlobType(port, version);
        if (typeof blobType === "undefined") return null;
        return getProfileByBlobType(blobType, { port: port });
    }

    function callProfileRpc(context, port, methodName, callback, options) {
        const config = options || {};
        const profile = resolveProfile(port, undefined, context);
        if (!profile || !profile.rpc || typeof profile.rpc[methodName] !== "function") {
            if (typeof config.onMissing === "function") return config.onMissing();
            return callback(true, null);
        }
        return profile.rpc[methodName](Object.assign({
            callback: callback,
            noErrorReport: config.noErrorReport,
            port: port,
            profile: profile,
            runtime: createRuntime(context)
        }, config.extra || {}));
    }

    this.hasTemplateBlob = function hasTemplateBlob(template, port) {
        const profile = resolveProfile(port, undefined, this);
        return !!profile && ((profile.template && profile.template.hashOnly) || (template && (template.blocktemplate_blob || template.blob || template.blockhashing_blob)));
    };

    this.c29ProofSize = function c29ProofSize(blob_type_num) {
        return getBlobTraits(blob_type_num).proofSize;
    };

    this.nonceSize = function nonceSize(blob_type_num) {
        return getBlobTraits(blob_type_num).nonceSize;
    };

    this.getCoinMinDifficulty = function getCoinMinDifficulty(key) {
        const profile = this.getResolvedProfile(key);
        if (!profile || !profile.pool || profile.pool.minDifficulty === "config" || profile.pool.minDifficulty === undefined) {
            return global.config.pool.minDifficulty;
        }
        return profile.pool.minDifficulty;
    };

    this.getNiceHashMinimumDifficulty = function getNiceHashMinimumDifficulty(key) {
        const profile = this.getResolvedProfile(key);
        const multiplier = profile && profile.pool && profile.pool.niceHashDiffMultiplier ? profile.pool.niceHashDiffMultiplier : 1;
        return this.niceHashDiff * multiplier;
    };

    this.normalizeMinerAlgos = function normalizeMinerAlgos(algos) {
        const normalized = {};
        const reverseAliases = registry.canonicalAlgosByAlias;
        for (const algo in algos) {
            normalized[algo] = algos[algo];
            const canonicalList = reverseAliases[algo];
            if (!canonicalList) continue;
            canonicalList.forEach(function registerCanonical(canonicalAlgo) {
                normalized[canonicalAlgo] = algos[algo];
            });
        }
        return normalized;
    };

    this.convertBlob = function convertBlob(blobBuffer, port) {
        const profile = resolveProfile(port, blobBuffer[0], this);
        if (!profile || !profile.blob || typeof profile.blob.convert !== "function") return null;
        try {
            return profile.blob.convert({ blobBuffer: blobBuffer, port: port, profile: profile, runtime: createRuntime(this) });
        } catch (error) {
            const err_str = "Can't do port " + port + " convert_blob " + blobBuffer.toString("hex") + " with blob type " + profile.blobType + ": " + error;
            console.error(err_str);
            global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't convert_blob", err_str);
            return null;
        }
    };

    this.constructNewBlob = function constructNewBlob(blockTemplateBuffer, params, port) {
        const profile = resolveProfile(port, blockTemplateBuffer[0], this);
        if (!profile || !profile.blob || typeof profile.blob.construct !== "function") return null;
        return profile.blob.construct({ blockTemplateBuffer: blockTemplateBuffer, params: params, port: port, profile: profile, runtime: createRuntime(this) });
    };

    this.constructMMParentBlockBlob = function constructMMParentBlockBlob(parentTemplateBuffer, port, childTemplateBuffer) {
        return blockTemplate.construct_mm_parent_block_blob(parentTemplateBuffer, this.portBlobType(port, parentTemplateBuffer[0]), childTemplateBuffer);
    };

    this.constructMMChildBlockBlob = function constructMMChildBlockBlob(shareBuffer, port, childTemplateBuffer) {
        return blockTemplate.construct_mm_child_block_blob(shareBuffer, this.portBlobType(port, shareBuffer[0]), childTemplateBuffer);
    };

    this.getBlockID = function getBlockID(blockBuffer, port) {
        const profile = resolveProfile(port, blockBuffer[0], this);
        if (!profile || !profile.blob || typeof profile.blob.getBlockId !== "function") return blockTemplate.get_block_id(blockBuffer, 0);
        return profile.blob.getBlockId({ blockBuffer: blockBuffer, port: port, profile: profile, runtime: createRuntime(this) });
    };

    this.getAuxChainXTM = function getAuxChainXTM(obj) {
        if (typeof obj._aux === "object" && obj._aux.chains instanceof Array && obj._aux.chains.length === 1 && typeof obj._aux.chains[0] === "object" && obj._aux.chains[0]) {
            return obj._aux.chains[0];
        }
        return null;
    };

    this.BlockTemplate = function BlockTemplate(template) {
        const profile = resolveProfile(template.port, undefined, global.coinFuncs || self);
        const templateConfig = profile && profile.template ? profile.template : {};
        this.difficulty = template.mbl_difficulty ? template.mbl_difficulty : template.difficulty;
        this.xmr_difficulty = template.wide_difficulty ? parseInt(template.wide_difficulty, 16) : this.difficulty;
        const aux_chain_xtm = global.coinFuncs.getAuxChainXTM(template);
        if (aux_chain_xtm) {
            this.xtm_height = parseInt(aux_chain_xtm.height, 10);
            this.xtm_difficulty = parseInt(aux_chain_xtm.difficulty, 10);
        }
        this.xtm_block = template.xtm_block;
        this.height = template.height;
        this.bits = template.bits;
        this.seed_hash = template.seed_hash;
        this.coin = template.coin;
        this.port = template.port;

        if (template.blocktemplate_blob) this.blocktemplate_blob = template.blocktemplate_blob;
        else if (template.blob) this.blocktemplate_blob = template.blob;
        else if (templateConfig.hashOnly) {
            const hash = template.hash;
            this.hash = this.idHash = hash;
            this.hash2 = template.hash2;
            this.block_version = 0;
            this.nextBlobHex = function nextBlobHex() { return hash; };
            return;
        } else {
            console.error("INTERNAL ERROR: No blob in " + this.port + " port block template: " + JSON.stringify(template));
            this.blocktemplate_blob = extra_nonce_mm_template_hex;
        }

        const is_mm = "child_template" in template;
        if (is_mm) {
            this.child_template = template.child_template;
            this.child_template_buffer = template.child_template_buffer;
        }

        const blobField = templateConfig.bufferField || "blocktemplate_blob";
        const blob = is_mm ? template.parent_blocktemplate_blob : (template[blobField] || this.blocktemplate_blob);

        this.idHash = crypto.createHash("md5").update(blob).digest("hex");
        this.buffer = Buffer.from(blob, "hex");
        this.block_version = this.buffer[0];

        if (templateConfig.reserveOffsetSource === "template") {
            this.reserved_offset = template.reserved_offset !== undefined ? template.reserved_offset : template.reservedOffset;
        } else {
            const template_hex = (template.port in mm_port_set && !is_mm) ? extra_nonce_mm_template_hex : extra_nonce_template_hex;
            const found_reserved_offset_template = blob.indexOf(template_hex);
            if (found_reserved_offset_template !== -1) {
                const found_reserved_offset = (found_reserved_offset_template >> 1) + 2;
                if (is_mm) this.reserved_offset = found_reserved_offset;
                else if (template.reserved_offset && !template._aux) this.reserved_offset = template.reserved_offset;
                else if (template.reservedOffset) this.reserved_offset = template.reservedOffset;
                else this.reserved_offset = found_reserved_offset;
            } else {
                this.reserved_offset = template.reserved_offset ? template.reserved_offset : template.reservedOffset;
            }
        }

        if (this.reserved_offset === undefined) {
            console.error("INTERNAL ERROR: No reserved offset in " + this.port + " port block template: " + JSON.stringify(template));
            this.reserved_offset = 0;
        }

        if (template.bt_nonce_size === undefined || template.bt_nonce_size >= 16) {
            instanceId.copy(this.buffer, this.reserved_offset + 4, 0, 4);
            this.extraNonce = 0;
            this.clientNonceLocation = this.reserved_offset + 12;
            this.clientPoolLocation = this.reserved_offset + 8;
            this.nextBlobHex = function nextBlobHex() {
                this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
                const blobHex = global.coinFuncs.convertBlob(this.buffer, this.port);
                return blobHex ? blobHex.toString("hex") : null;
            };
            this.nextBlobWithChildNonceHex = function nextBlobWithChildNonceHex() {
                this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
                return this.buffer.toString("hex");
            };
        } else {
            this.extraNonce = 0;
            this.extraNonce2 = 0;
            this.nextBlobHex = function nextBlobHex() {
                const blobHex = global.coinFuncs.convertBlob(this.buffer, this.port);
                return blobHex ? blobHex.toString("hex") : null;
            };
            this.nextBlobWithChildNonceHex = function nextBlobWithChildNonceHex() {
                return null;
            };
        }
    };

    this.getPORTS = function getPORTS() { return ports; };
    this.getCOINS = function getCOINS() { return coins; };
    this.PORT2COIN = function PORT2COIN(port) {
        if (port.toString() in port2coin) return port2coin[port];
        const profile = resolveProfile(port, undefined, this);
        return profile ? profile.displayCoin : undefined;
    };
    this.PORT2COIN_FULL = function PORT2COIN_FULL(port) {
        if (port.toString() in port2displayCoin) return port2displayCoin[port];
        const coin = this.PORT2COIN(port);
        return coin === "" ? mainProfile.displayCoin : coin;
    };
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

    this.convertAlgosToCoinPerf = function convertAlgosToCoinPerf(algos_perf) {
        const coin_perf = {};
        registry.profiles.forEach(function registerPerf(profile) {
            if (!profile.perf || !profile.perf.aliases || !profile.perf.aliases.length) return;
            const coinKey = typeof profile.coin === "string" ? profile.coin : profile.displayCoin;
            for (const alias of profile.perf.aliases) {
                if (!(alias in algos_perf)) continue;
                coin_perf[coinKey] = algos_perf[alias];
                break;
            }
        });
        return coin_perf;
    };

    this.algoMainCheck = function algoMainCheck(algos) {
        return Object.keys(registry.mainAlgoSet).some(function hasMainAlgo(algo) {
            return algo in algos;
        });
    };

    this.algoPrevMainCheck = function algoPrevMainCheck(algos) {
        return Object.keys(registry.prevMainAlgoSet).some(function hasPrevMainAlgo(algo) {
            return algo in algos;
        });
    };

    this.algoCheck = function algoCheck(algos) {
        if (this.algoMainCheck(algos)) return true;
        for (const algo in all_algos) if (algo in algos) return true;
        return "algo array must include at least one supported pool algo: [" + Object.keys(algos).join(", ") + "]";
    };

    this.slowHashBuff = function slowHashBuff(convertedBlob, blockTemplate, nonce, mixhash) {
        const profile = resolveProfile(blockTemplate.port, blockTemplate.block_version, this);
        if (!profile || !profile.pow || typeof profile.pow.hashBuff !== "function") {
            console.error("Unknown " + blockTemplate.port + " port for Cryptonight PoW type");
            return powHash.cryptonight(convertedBlob, 13, blockTemplate.height);
        }
        return profile.pow.hashBuff({
            blockTemplate: blockTemplate,
            convertedBlob: convertedBlob,
            mixhash: mixhash,
            nonce: nonce,
            port: blockTemplate.port,
            profile: profile,
            runtime: createRuntime(this)
        });
    };

    this.slowHash = function slowHash(convertedBlob, blockTemplate, nonce, mixhash) {
        return this.slowHashBuff(convertedBlob, blockTemplate, nonce, mixhash).toString("hex");
    };

    this.slowHashAsync = function slowHashAsync(convertedBlob, blockTemplate, miner_address, cb) {
        if (!global.config.verify_shares_host) return cb(this.slowHash(convertedBlob, blockTemplate));
        if (miner_address in miner_address_verify) {
            if (miner_address_verify[miner_address] > 100) return cb(null);
            ++miner_address_verify[miner_address];
        } else {
            miner_address_verify[miner_address] = 1;
        }

        const profile = resolveProfile(blockTemplate.port, blockTemplate.block_version, this);
        let jsonInput = { algo: port2algo[blockTemplate.port], blob: convertedBlob.toString("hex") };
        if (profile && profile.pow && typeof profile.pow.verifyInput === "function") {
            jsonInput = profile.pow.verifyInput({
                algo: port2algo[blockTemplate.port],
                blockTemplate: blockTemplate,
                convertedBlob: convertedBlob,
                port: blockTemplate.port,
                profile: profile,
                runtime: createRuntime(this)
            });
        }

        const time_now = Date.now();
        let best_index = null;
        let min_queue_size = null;
        let max_noerr_time = null;

        shareVerifyQueue.forEach(function chooseQueue(queue_obj, index) {
            if (time_now - shareVerifyQueueErrorTime[index] < 60 * 1000 && shareVerifyQueueErrorCount[index] > 100 && global.config.verify_shares_host[index] !== "127.0.0.1") return;
            const qlength = queue_obj.length() + queue_obj.running();
            if (min_queue_size === null || qlength < min_queue_size) {
                best_index = index;
                min_queue_size = qlength;
            }
        });

        if (best_index === null) shareVerifyQueueErrorTime.forEach(function findLeastBad(last_error_time, index) {
            const noerr_time = time_now - last_error_time;
            if (max_noerr_time === null || noerr_time > max_noerr_time) {
                best_index = index;
                max_noerr_time = noerr_time;
            }
        });

        return shareVerifyQueue[best_index].unshift({
            jsonInput: jsonInput,
            cb: cb,
            time: time_now,
            miner_address: miner_address
        });
    };

    this.c29 = function c29(header, ring, port) {
        const profile = resolveProfile(port, undefined, this);
        if (!profile || !profile.pow || typeof profile.pow.c29 !== "function") return powHash.c29s(header, ring);
        return profile.pow.c29({ header: header, port: port, profile: profile, ring: ring, runtime: createRuntime(this) });
    };

    this.c29_packed_edges = function c29_packed_edges(ring, blob_type_num, hint) {
        const profile = getProfileByBlobType(blob_type_num,
            typeof hint === "number" ? { port: hint } :
                typeof hint === "string" ? { coin: hint } :
                    hint
        );
        if (!profile || !profile.pow || typeof profile.pow.packEdges !== "function") return powHash.c29s_packed_edges(ring);
        return profile.pow.packEdges({ blobType: blob_type_num, profile: profile, ring: ring, runtime: createRuntime(this) });
    };

    this.c29_cycle_hash = function c29_cycle_hash(packed_edges) {
        return powHash.c29_cycle_hash(packed_edges);
    };

    this.blobTypeStr = function blobTypeStr(port) {
        const profile = resolveProfile(port, undefined, this);
        return profile ? profile.blobTypeName : "cryptonote";
    };

    this.algoShortTypeStr = function algoShortTypeStr(port) {
        const profile = resolveProfile(port, undefined, this);
        if (profile) return profile.algo;
        console.error("Unknown " + port + " port for PoW type");
        return "rx/0";
    };

    this.isMinerSupportAlgo = function isMinerSupportAlgo(algo, algos) {
        if (algo in algos) return true;
        const aliases = registry.minerAlgoAliases[algo];
        if (!aliases) return false;
        return aliases.some(function hasAlias(alias) {
            return alias in algos;
        });
    };

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

    this.is_miner_agent_no_haven_support = function is_miner_agent_no_haven_support(agent) {
        return this.getUnsupportedAlgosForMiner(agent).length > 0;
    };

    this.get_miner_agent_not_supported_algo = function get_miner_agent_not_supported_algo(agent) {
        for (const profile of registry.profiles) {
            const unsupportedByMatcher = profile.agent && profile.agent.unsupportedByMatcher;
            if (!unsupportedByMatcher) continue;
            for (const matcher in unsupportedByMatcher) {
                if (versionMatches(agent, matcher)) return unsupportedByMatcher[matcher];
            }
        }
        return false;
    };

    this.getUnsupportedAlgosForMiner = function getUnsupportedAlgosForMiner(agent) {
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

    this.fixDaemonIssue = function fixDaemonIssue(height, top_height, port) {
        global.support.sendEmail(
            global.config.general.adminEmail,
            "Pool server " + global.config.hostname + " has stuck block template",
            "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " with current block height " +
            height + " is stuck compared to top height (" + top_height + ") amongst other leaf nodes for " +
            port + " port\nAttempting to fix..."
        );
        if (!fs.existsSync(fix_daemon_sh)) {
            console.error("No " + fix_daemon_sh + " script was found to fix stuff");
            return;
        }
        child_process.exec(fix_daemon_sh + " " + port, function callback(error, stdout, stderr) {
            console.log("> " + fix_daemon_sh + " " + port);
            console.log(stdout);
            console.error(stderr);
            if (error) console.error(fix_daemon_sh + " script returned error exit code: " + error.code);
        });
    };

    this.ethBlockCheck = function ethBlockCheck(port, miner_hex, nonce_hex, block_height_hex, callback) {
        const profile = resolveProfile(port, undefined, this);
        global.support.rpcPortDaemon2(port, "", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [block_height_hex, true] }, function onBlock(body) {
            if (!body || !body.result) return callback(null, null);
            if (body.result.miner === miner_hex && body.result.nonce == nonce_hex) return callback(body.result.hash);
            block_height_hex = body.result.number;
            findSeries(Array.from({ length: body.result.uncles.length }, function mapUncle(_value, index) {
                return index;
            }), function eachUncle(index, next) {
                global.support.rpcPortDaemon2(port, "", { jsonrpc: "2.0", id: 1, method: "eth_getUncleByBlockNumberAndIndex", params: [block_height_hex, "0x" + index.toString(16)] }, function onUncle(body_uncle) {
                    if (!body_uncle || !body_uncle.result) return next(null);
                    return next(body_uncle.result.miner === miner_hex && body_uncle.result.nonce == nonce_hex ? body_uncle.result.hash : null);
                });
            }, function onComplete(block_hash) {
                const block_height = parseInt(block_height_hex, 10);
                return callback(block_hash, block_height, profile);
            });
        });
    };

    this.ethBlockFind = function ethBlockFind(port, nonce_hex, callback) {
        const miner_hex = global.config.pool["address_" + port];
        global.coinFuncs.ethBlockCheck(port, miner_hex, nonce_hex, "latest", function onLatest(block_hash, block_height) {
            if (block_hash) return callback(block_hash);
            if (!block_height) return callback(null);
            findSeries(Array.from({ length: 32 }, function mapHeight(_value, index) {
                return block_height - index - 1;
            }), function eachHeight(nextHeight, next) {
                global.coinFuncs.ethBlockCheck(port, miner_hex, nonce_hex, "0x" + nextHeight.toString(16), function onCheck(found_hash) {
                    return next(found_hash);
                });
            }, function onDone(found_hash) {
                return callback(found_hash);
            });
        });
    };

    this.getPortBlockHeaderByID = function getPortBlockHeaderByID(port, blockId, callback, no_error_report) {
        return callProfileRpc(this, port, "getBlockHeaderById", callback, {
            extra: { blockId: blockId },
            noErrorReport: no_error_report
        });
    };

    this.getBlockHeaderByID = function getBlockHeaderByID(blockId, callback, no_error_report) {
        return this.getPortBlockHeaderByID(global.config.daemon.port, blockId, callback, no_error_report);
    };

    this.getPortAnyBlockHeaderByHash = function getPortAnyBlockHeaderByHash(port, blockHash, is_our_block, callback, no_error_report) {
        return callProfileRpc(this, port, "getAnyBlockHeaderByHash", callback, {
            extra: {
                blockHash: blockHash,
                isOurBlock: is_our_block
            },
            noErrorReport: no_error_report
        });
    };

    this.getPortBlockHeaderByHash = function getPortBlockHeaderByHash(port, blockHash, callback, no_error_report) {
        return this.getPortAnyBlockHeaderByHash(port, blockHash, true, callback, no_error_report);
    };

    this.getBlockHeaderByHash = function getBlockHeaderByHash(blockHash, callback, no_error_report) {
        return this.getPortBlockHeaderByHash(global.config.daemon.port, blockHash, callback, no_error_report);
    };

    this.getPortLastBlockHeader = function getPortLastBlockHeader(port, callback, no_error_report) {
        return callProfileRpc(this, port, "getLastBlockHeader", callback, {
            noErrorReport: no_error_report
        });
    };

    this.getLastBlockHeader = function getLastBlockHeader(callback, no_error_report) {
        return this.getPortLastBlockHeader(global.config.daemon.port, callback, no_error_report);
    };

    this.getPortLastBlockHeaderWithRewardDiff = function getPortLastBlockHeaderWithRewardDiff(port, callback, no_error_report) {
        const profile = resolveProfile(port, undefined, this);
        global.coinFuncs.getPortLastBlockHeader(port, function onHeader(is_err, body) {
            if (is_err) return callback(is_err, body);
            if (profile && profile.rpc && typeof profile.rpc.enrichLastBlockHeader === "function") {
                return profile.rpc.enrichLastBlockHeader({
                    callback: callback,
                    header: body,
                    port: port,
                    profile: profile,
                    runtime: createRuntime(global.coinFuncs || self)
                });
            }
            return callback(is_err, body);
        }, no_error_report);
    };

    this.getPortLastBlockHeaderMM = function getPortLastBlockHeaderMM(port, callback, no_error_report) {
        const profile = resolveProfile(port, undefined, this);
        global.coinFuncs.getPortLastBlockHeader(port, function onHeader(is_err, body) {
            if (is_err) return callback(is_err, body);
            const mmCoin = profile && profile.rpc ? profile.rpc.lastHeaderMmCoin : null;
            if (port === global.config.daemon.port && mmCoin) {
                const mmPort = coin2port[mmCoin];
                return global.coinFuncs.getPortLastBlockHeader(mmPort, function onMMHeader(mm_err, body2) {
                    if (mm_err) return callback(mm_err, body);
                    body.mm = body2;
                    return callback(null, body);
                }, no_error_report);
            }
            return callback(is_err, body);
        }, no_error_report);
    };

    this.getPortBlockTemplate = function getPortBlockTemplate(port, callback, no_error_report) {
        return callProfileRpc(this, port, "getBlockTemplate", callback, {
            noErrorReport: no_error_report,
            onMissing() {
                return callback(null, null);
            }
        });
    };

    this.getBlockTemplate = function getBlockTemplate(callback, no_error_report) {
        return this.getPortBlockTemplate(global.config.daemon.port, callback, no_error_report);
    };
}

module.exports = Coin;
