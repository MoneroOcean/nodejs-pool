"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const protobuf = require("protocol-buffers");
const blockTemplate = require("node-blocktemplate");
const powHash = require("node-powhash");

const supportFactory = require("../../../lib/common/support.js");

function allocateTestPorts() {
    const script = `
        const net = require("node:net");

        async function open() {
            return await new Promise((resolve, reject) => {
                const server = net.createServer();
                server.unref();
                server.listen(0, "127.0.0.1", () => resolve(server));
                server.once("error", reject);
            });
        }

        (async () => {
            const main = await open();
            const eth = await open();
            const ports = [main.address().port, eth.address().port];
            process.stdout.write(JSON.stringify(ports));
            await Promise.all([
                new Promise((resolve) => main.close(resolve)),
                new Promise((resolve) => eth.close(resolve))
            ]);
        })().catch((error) => {
            console.error(error.stack || error.message);
            process.exit(1);
        });
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8"
    });

    if (result.status !== 0) {
        throw new Error(`Failed to allocate free test ports: ${result.stderr || result.stdout}`);
    }

    const ports = JSON.parse(result.stdout);
    if (!Array.isArray(ports) || ports.length !== 2) {
        throw new Error(`Unexpected free test port allocation result: ${result.stdout}`);
    }

    return ports;
}

const [MAIN_PORT, ETH_PORT] = allocateTestPorts();
const MAIN_WALLET = "4".repeat(95);
const ETH_WALLET = "5".repeat(95);
const ALT_WALLET = "6".repeat(95);
const THIRD_WALLET = "7".repeat(95);
const VALID_RESULT = "f".repeat(64);
const VALID_RESULT_BUFFER = Buffer.from(VALID_RESULT, "hex");
const RAVEN_RESULT_BUFFER = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([10])]);
const ETH_RESULT_BUFFER = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([16])]);
const ETH_MIXHASH_BUFFER = Buffer.from("cd".repeat(32), "hex");
const REAL_MAIN_PROFILE_PORT = 18081;
const REAL_RAVEN_PROFILE_PORT = 8766;
const REAL_ETH_PROFILE_PORT = 8545;
const REAL_PROTOS = protobuf(fs.readFileSync(path.join(__dirname, "..", "..", "..", "lib", "common", "data.proto")));
const TEST_RAVEN_ADDRESS = "16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf";

function encodeVarint(value) {
    let current = BigInt(value);
    const bytes = [];
    do {
        let byte = Number(current & 0x7fn);
        current >>= 7n;
        if (current > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (current > 0n);
    return Buffer.from(bytes);
}

function createCryptonoteFixture(height) {
    const extra = Buffer.concat([
        Buffer.from([0x01]),
        Buffer.alloc(32, 0x33),
        Buffer.from([0x02, 17]),
        Buffer.alloc(17, 0)
    ]);

    const blob = Buffer.concat([
        encodeVarint(1),
        encodeVarint(1),
        encodeVarint(0),
        Buffer.alloc(32, 0x11),
        Buffer.alloc(4, 0),
        encodeVarint(1),
        encodeVarint(0),
        encodeVarint(1),
        Buffer.from([0xff]),
        encodeVarint(height),
        encodeVarint(1),
        encodeVarint(0),
        Buffer.from([0x02]),
        Buffer.alloc(32, 0x22),
        encodeVarint(extra.length),
        extra,
        encodeVarint(0)
    ]);

    const reserveTag = Buffer.concat([Buffer.from([0x02, 17]), Buffer.alloc(17, 0)]);
    const reserveTagOffset = blob.indexOf(reserveTag);
    const reservedOffset = reserveTagOffset + 2;

    return {
        blocktemplate_blob: blob.toString("hex"),
        reserved_offset: reservedOffset,
        clientPoolLocation: reservedOffset + 8,
        clientNonceLocation: reservedOffset + 12
    };
}

function createSupportHarness() {
    const support = supportFactory();
    support.emails = [];
    support.rpcPortDaemonCalls = [];
    support.rpcPortDaemon2Calls = [];

    support.sendEmail = function sendEmail(to, subject, body) {
        this.emails.push({ to, subject, body });
    };
    support.rpcPortDaemon = function rpcPortDaemon(port, method, params, callback) {
        this.rpcPortDaemonCalls.push({ port, method, params });
        callback({ result: { status: "OK", block_hash: "11".repeat(32) } }, 200);
    };
    support.rpcPortDaemon2 = function rpcPortDaemon2(port, method, params, callback) {
        this.rpcPortDaemon2Calls.push({ port, method, params });
        callback({ result: true }, 200);
    };

    return support;
}

function createMysqlStub() {
    return {
        queries: [],
        query(sql, params) {
            this.queries.push({ sql, params });

            if (sql.includes("FROM bans")) return Promise.resolve([]);
            if (sql.includes("FROM notifications")) return Promise.resolve([]);
            if (sql.includes("FROM users")) return Promise.resolve([]);
            if (sql.includes("FROM pool_workers")) return Promise.resolve([{ id: 1 }]);
            if (sql.includes("MAX(id) as maxId")) return Promise.resolve([{ maxId: 1 }]);
            if (sql.includes("coinHashFactor")) return Promise.resolve([{ item_value: "1" }]);

            return Promise.resolve([]);
        }
    };
}

function decodePayload(type, payload) {
    if (!Buffer.isBuffer(payload)) return payload;
    try {
        return global.protos[type].decode(payload);
    } catch (_error) {
        return payload;
    }
}

function createDatabaseStub() {
    return {
        thread_id: "",
        shares: [],
        invalidShares: [],
        blocks: [],
        altBlocks: [],
        sendQueue: [],
        initEnv() {},
        storeShare(height, payload) {
            this.shares.push({ height, payload: decodePayload("Share", payload) });
        },
        storeInvalidShare(payload) {
            this.invalidShares.push(decodePayload("InvalidShare", payload));
        },
        storeBlock(height, payload) {
            this.blocks.push({ height, payload: decodePayload("Block", payload) });
        },
        storeAltBlock(height, payload) {
            this.altBlocks.push({ height, payload: decodePayload("AltBlock", payload) });
        }
    };
}

function createCoinFuncsStub() {
    const Coin = require("../../../lib/coins/index.js");
    const realCoinFuncs = new Coin({});
    const portToCoin = {
        [MAIN_PORT]: "",
        [ETH_PORT]: "ETH"
    };
    const coinToPort = {
        "": MAIN_PORT,
        ETH: ETH_PORT
    };
    const portToAlgo = {
        [MAIN_PORT]: "rx/0",
        [ETH_PORT]: "kawpow"
    };
    const portToBlob = {
        [MAIN_PORT]: 0,
        [ETH_PORT]: 101
    };

    function resolvePortBlobType(context, port, version) {
        if (context && typeof context.portBlobType === "function") return context.portBlobType(port, version);
        if (global.coinFuncs && typeof global.coinFuncs.portBlobType === "function") return global.coinFuncs.portBlobType(port, version);
        return portToBlob[port];
    }

    function mapRealPort(context, port, version) {
        if (port === MAIN_PORT) return REAL_MAIN_PROFILE_PORT;
        const blobType = resolvePortBlobType(context, port, version);
        if (blobType === 102) return REAL_ETH_PROFILE_PORT;
        if (blobType === 101) return REAL_RAVEN_PROFILE_PORT;
        return port;
    }

    const realConvertBlob = realCoinFuncs.convertBlob.bind(realCoinFuncs);
    const realConstructNewBlob = realCoinFuncs.constructNewBlob.bind(realCoinFuncs);
    const realGetBlockID = realCoinFuncs.getBlockID.bind(realCoinFuncs);

    realCoinFuncs.convertBlob = function convertBlob(blobBuffer, port) {
        return realConvertBlob(blobBuffer, mapRealPort(global.coinFuncs || this, port, blobBuffer && blobBuffer[0]));
    };
    realCoinFuncs.constructNewBlob = function constructNewBlob(blockTemplateBuffer, params, port) {
        return realConstructNewBlob(blockTemplateBuffer, params, mapRealPort(global.coinFuncs || this, port, blockTemplateBuffer && blockTemplateBuffer[0]));
    };
    realCoinFuncs.getBlockID = function getBlockID(blockBuffer, port) {
        return realGetBlockID(blockBuffer, mapRealPort(global.coinFuncs || this, port, blockBuffer && blockBuffer[0]));
    };

    function resolveStubProfile(context, key) {
        if (key === "") return realCoinFuncs.getPoolProfile("");
        if (typeof key === "string" && key in coinToPort) return resolveStubProfile(context, coinToPort[key]);
        if (typeof key === "number" || (typeof key === "string" && /^\d+$/.test(key))) {
            const port = Number(key);
            return realCoinFuncs.getPoolProfile(mapRealPort(context, port));
        }
        return realCoinFuncs.getPoolProfile(key);
    }

    function resolveStubJobProfile(context, job) {
        if (job && (typeof job.blob_type_num === "number" || typeof job.blob_type_num === "string")) {
            const blobType = Number(job.blob_type_num);
            const jobPort = job && typeof job.coin === "string" && job.coin in coinToPort ? coinToPort[job.coin] : undefined;
            const mappedPort = typeof jobPort === "number" ? mapRealPort(context, jobPort, blobType) : null;
            const matchingProfile = realCoinFuncs.getProfilesByBlobType(blobType).find((profile) => profile.port === mappedPort);
            if (matchingProfile) return matchingProfile;
        }
        return resolveStubProfile(context, job && typeof job.coin === "string" ? job.coin : (job ? job.blob_type_num : undefined));
    }

    return {
        ...realCoinFuncs,
        __realCoinFuncs: realCoinFuncs,
        __testUseRealMainPow: false,
        __testMainPowVectors: null,
        uniqueWorkerId: 0,
        uniqueWorkerIdBits: 0,
        blockedAddresses: [],
        niceHashDiff: 1000,
        baseDiff() {
            return BigInt("0x" + "f".repeat(64));
        },
        baseRavenDiff() {
            return 100;
        },
        getCOINS() {
            return ["ETH"];
        },
        getMM_PORTS() {
            return {};
        },
        getMM_CHILD_PORTS() {
            return {};
        },
        getPoolProfile(key) {
            return resolveStubProfile(this, key);
        },
        getResolvedProfile(key) {
            return resolveStubProfile(this, key);
        },
        getPoolSettings(key) {
            const profile = resolveStubProfile(this, key);
            return profile && profile.pool ? profile.pool : null;
        },
        getJobProfile(job) {
            return resolveStubJobProfile(this, job);
        },
        COIN2PORT(coin) {
            return coinToPort[coin];
        },
        PORT2COIN(port) {
            return portToCoin[port];
        },
        getAuxChainXTM() {
            return null;
        },
        getPortLastBlockHeader(_port, callback) {
            callback(null, { height: 0 });
        },
        BlockTemplate: function TestBlockTemplate(template) {
            const mappedPort = mapRealPort(this, template.port);
            const blockTemplate = new realCoinFuncs.BlockTemplate({ ...template, port: mappedPort });
            blockTemplate.port = template.port;
            blockTemplate.coin = template.coin;
            if (template.idHash) blockTemplate.idHash = template.idHash;
            if (template.clientPoolLocation !== undefined) blockTemplate.clientPoolLocation = template.clientPoolLocation;
            if (template.clientNonceLocation !== undefined) blockTemplate.clientNonceLocation = template.clientNonceLocation;
            return blockTemplate;
        },
        validatePlainAddress(address) {
            return typeof address === "string" && address.length === 95;
        },
        validateAddress(address) {
            return typeof address === "string" && address.length === 95;
        },
        algoShortTypeStr(port) {
            const profile = resolveStubProfile(this, port);
            return profile ? profile.algo : portToAlgo[port];
        },
        algoCheck: realCoinFuncs.algoCheck,
        algoMainCheck: realCoinFuncs.algoMainCheck,
        algoPrevMainCheck: realCoinFuncs.algoPrevMainCheck,
        getDefaultAlgos: realCoinFuncs.getDefaultAlgos,
        getDefaultAlgosPerf: realCoinFuncs.getDefaultAlgosPerf,
        getPrevAlgosPerf: realCoinFuncs.getPrevAlgosPerf,
        convertAlgosToCoinPerf(algosPerf) {
            const coinPerf = {};
            if ("rx/0" in algosPerf) coinPerf[""] = algosPerf["rx/0"];
            if ("kawpow" in algosPerf) coinPerf.ETH = algosPerf.kawpow;
            if ("ethash" in algosPerf) coinPerf.ETH = algosPerf.ethash;
            if ("etchash" in algosPerf) coinPerf.ETH = algosPerf.etchash;
            return coinPerf;
        },
        get_miner_agent_not_supported_algo: realCoinFuncs.get_miner_agent_not_supported_algo,
        get_miner_agent_warning_notification: realCoinFuncs.get_miner_agent_warning_notification,
        is_miner_agent_no_haven_support: realCoinFuncs.is_miner_agent_no_haven_support,
        getUnsupportedAlgosForMiner: realCoinFuncs.getUnsupportedAlgosForMiner,
        normalizeMinerAlgos: realCoinFuncs.normalizeMinerAlgos,
        isMinerSupportAlgo: realCoinFuncs.isMinerSupportAlgo,
        portBlobType(port) {
            return portToBlob[port];
        },
        getCoinMinDifficulty(key) {
            const profile = resolveStubProfile(this, key);
            if (!profile || !profile.pool || profile.pool.minDifficulty === "config" || profile.pool.minDifficulty === undefined) {
                return global.config.pool.minDifficulty;
            }
            return profile.pool.minDifficulty;
        },
        getNiceHashMinimumDifficulty(key) {
            const profile = resolveStubProfile(this, key);
            const multiplier = profile && profile.pool && profile.pool.niceHashDiffMultiplier ? profile.pool.niceHashDiffMultiplier : 1;
            return this.niceHashDiff * multiplier;
        },
        nonceSize: realCoinFuncs.nonceSize,
        c29ProofSize: realCoinFuncs.c29ProofSize,
        blobTypeStr(port) {
            return this.portBlobType(port).toString();
        },
        convertBlob(blobBuffer, port) {
            const blobType = this.portBlobType(port, blobBuffer[0]);
            if (!(port === ETH_PORT && blobType === 102)) {
                try {
                    return realCoinFuncs.convertBlob.call(this, blobBuffer, mapRealPort(this, port, blobBuffer[0]));
                } catch (_error) {
                }
            }
            return Buffer.from(blobBuffer);
        },
        constructNewBlob(blockTemplateBuffer, params, port) {
            const next = Buffer.from(blockTemplateBuffer);
            if (port === ETH_PORT) return next;
            if (typeof params.nonce === "string") {
                const nonceBytes = Buffer.from(params.nonce, "hex");
                nonceBytes.copy(next, 4);
            }
            return next;
        },
        slowHashBuff(buffer, blockTemplate, nonce, mixhash) {
            if (this.__testUseRealMainPow && blockTemplate.port === MAIN_PORT) {
                const powVectorMap = this.__testMainPowVectors || {};
                const vectorNonce = Buffer.from(buffer.subarray(4, 8)).toString("hex");
                if (vectorNonce in powVectorMap) {
                    const vector = powVectorMap[vectorNonce];
                    return powHash.randomx(
                        Buffer.from(vector.input, vector.inputEncoding || "utf8"),
                        Buffer.from(vector.seed, vector.seedEncoding || "utf8"),
                        0
                    );
                }
                return realCoinFuncs.slowHashBuff.call(this, buffer, { ...blockTemplate, port: 18081 }, nonce, mixhash);
            }
            if (blockTemplate.port === ETH_PORT) {
                if (this.portBlobType(blockTemplate.port, blockTemplate.block_version) === 102) {
                    return [ETH_RESULT_BUFFER, ETH_MIXHASH_BUFFER];
                }
                return RAVEN_RESULT_BUFFER;
            }
            return Buffer.from(VALID_RESULT_BUFFER);
        },
        slowHashAsync(buffer, blockTemplate, _wallet, callback) {
            if (this.__testUseRealMainPow && blockTemplate.port === MAIN_PORT) {
                callback(this.slowHashBuff(buffer, blockTemplate).toString("hex"));
                return;
            }
            callback(VALID_RESULT);
        },
        getBlockID() {
            return Buffer.from("aa".repeat(32), "hex");
        }
    };
}

function createBaseTemplate({ coin, port, idHash, height }) {
    if (port === ETH_PORT) {
        const template = blockTemplate.RavenBlockTemplate({
            height,
            bits: "1d00ffff",
            curtime: 1234567890,
            previousblockhash: "11".repeat(32),
            version: 1,
            transactions: [],
            coinbasevalue: 5000000000,
            target: "00000000ff000000000000000000000000000000000000000000000000000000"
        }, TEST_RAVEN_ADDRESS);

        return {
            coin,
            idHash,
            height: template.height,
            difficulty: 100,
            block_version: 1,
            port,
            coinHashFactor: 1,
            isHashFactorChange: false,
            seed_hash: template.seed_hash,
            hash: "34".repeat(32),
            bits: template.bits,
            blocktemplate_blob: template.blocktemplate_blob,
            reserved_offset: template.reserved_offset,
            clientPoolLocation: template.reserved_offset + 8,
            clientNonceLocation: template.reserved_offset + 12
        };
    }

    const fixture = createCryptonoteFixture(height);
    return {
        coin,
        idHash,
        height,
        difficulty: 100,
        block_version: 1,
        port,
        coinHashFactor: 1,
        isHashFactorChange: false,
        seed_hash: "12".repeat(32),
        hash: "34".repeat(32),
        bits: "1d00ffff",
        blocktemplate_blob: fixture.blocktemplate_blob,
        reserved_offset: fixture.reserved_offset,
        clientPoolLocation: fixture.clientPoolLocation,
        clientNonceLocation: fixture.clientNonceLocation
    };
}

module.exports = {
    MAIN_PORT,
    ETH_PORT,
    MAIN_WALLET,
    ETH_WALLET,
    ALT_WALLET,
    THIRD_WALLET,
    VALID_RESULT,
    REAL_PROTOS,
    createSupportHarness,
    createMysqlStub,
    createDatabaseStub,
    createCoinFuncsStub,
    createBaseTemplate
};
