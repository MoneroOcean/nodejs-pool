"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const createConstants = require("../../../lib/coins/constants.js");
const helpers = require("../../../lib/coins/helpers.js");
const createPoolState = require("../../../lib/pool/state.js");
const createProtocolHandler = require("../../../lib/pool/protocol.js");
const createServerFactory = require("../../../lib/pool/servers.js");
const createTemplateManager = require("../../../lib/pool/templates.js");
const createShareProcessor = require("../../../lib/pool/shares.js");

function clearObject(target) {
    for (const key of Object.keys(target)) delete target[key];
}

test.describe("pool components: runtime", { concurrency: false }, () => {
test("missing rpc id warnings are summarized instead of logged on every malformed request", () => {
    const originalConfig = global.config;
    const originalWarn = console.warn;
    const originalDateNow = Date.now;
    const warnings = [];
    let timeNow = 1_000;

    try {
        global.config = { pool: {} };
        console.warn = function captureWarning(message) {
            warnings.push(message);
        };
        Date.now = function fakeNow() {
            return timeNow;
        };

        const state = {
            threadName: "(Test) ",
            activeConnectionsByIP: {},
            activeConnectionsBySubnet: {},
            activeMiners: new Map(),
            activeMinerSockets: new Map(),
            freeEthExtranonces: [],
            protocolWarningState: Object.create(null)
        };
        const serverFactory = createServerFactory({
            debug() {},
            fs: require("node:fs"),
            net: require("node:net"),
            tls: require("node:tls"),
            state,
            formatPoolEvent(label, fields) {
                const parts = [];
                Object.keys(fields || {}).forEach(function (key) {
                    if (fields[key] === undefined || fields[key] === null || fields[key] === "") return;
                    parts.push(`${key}=${fields[key]}`);
                });
                return parts.length ? `${label}: ${parts.join(" ")}` : label;
            },
            handleMinerData() {
                assert.fail("Malformed RPC requests should not reach the miner handler");
            },
            removeMiner() {}
        });
        const socket = new EventEmitter();
        socket.remoteAddress = "127.0.0.2";
        socket.writable = true;
        socket.finalizing = false;
        socket.setKeepAlive = function setKeepAlive() {};
        socket.setEncoding = function setEncoding() {};
        socket.write = function write() {};
        socket.end = function end() {
            socket.writable = false;
        };
        socket.destroy = function destroy() {
            socket.writable = false;
        };

        const handleSocket = serverFactory.createPoolSocketHandler({ port: 39001, portType: "pplns" });
        handleSocket(socket);

        socket.emit("data", `${JSON.stringify({ method: "login", params: { login: "wallet" } })}\n`);
        socket.emit("data", `${JSON.stringify({ method: "login", params: { login: "wallet" } })}\n`);
        timeNow += 5 * 60 * 1000;
        socket.emit("data", `${JSON.stringify({ method: "login", params: { login: "wallet" } })}\n`);
        socket.emit("close");

        assert.deepEqual(warnings, [
            "(Test) Miner RPC missing id: ip=127.0.0.2",
            "(Test) Miner RPC missing id: ip=127.0.0.2 (suppressed: count=1 lastIp=127.0.0.2)"
        ]);
    } finally {
        global.config = originalConfig;
        console.warn = originalWarn;
        Date.now = originalDateNow;
    }
});

test("eth-style nonces are deduped across miners on the same block template", () => {
    const originalConfig = global.config;
    const originalCoinFuncs = global.coinFuncs;

    try {
        global.config = {
            pool: {
                minerThrottleShareWindow: 10,
                minerThrottleSharePerSec: 1000,
                trustedMiners: false,
                targetTime: 30
            }
        };
        const sharedNonceProfile = {
            pool: {
                sharedTemplateNonces: true,
                submitSuccess: "boolean",
                parseMiningSubmitParams({ params }) {
                    params.nonce = params.raw_params[2];
                    return true;
                },
                validateSubmitParams({ job, normalizeExtraNonceSubmitNonce, params, state }) {
                    params.nonce = normalizeExtraNonceSubmitNonce(params.nonce, job.extraNonce);
                    return state.nonceCheck64.test(params.nonce);
                },
                submissionKey({ params }) {
                    return params.nonce;
                }
            }
        };
        global.coinFuncs = {
            getJobProfile(job) {
                return job && job.blob_type_num === 102 ? sharedNonceProfile : { pool: {} };
            },
            nonceSize() {
                return 8;
            },
            c29ProofSize() {
                return 0;
            }
        };

        const stateTools = createPoolState();
        const { state, retention, touchTimedEntry } = stateTools;
        state.activeBlockTemplates.ETH = {
            idHash: "eth-template-1",
            timeCreated: Date.now()
        };
        state.lastCoinHashFactorMM.ETH = 1;

        let shareCalls = 0;
        let invalidShareCalls = 0;
        const protocolHandler = createProtocolHandler({
            debug() {},
            retention,
            state,
            touchTimedEntry,
            utils: {
                getNewId() {
                    return "unused";
                },
                getNewEthExtranonceId() {
                    return 1;
                },
                ethExtranonce() {
                    return "0001";
                }
            },
            createMiner() {
                throw new Error("createMiner should not be called during direct submit tests");
            },
            addProxyMiner() {
                return true;
            },
            adjustMinerDiff() {
                return false;
            },
            shareProcessor: {
                processShare(_miner, _job, _blockTemplate, _params, callback) {
                    shareCalls += 1;
                    callback(true);
                }
            },
            removeMiner() {},
            processSend() {}
        });

        function createMiner(id, payout, extraNonce, jobId) {
            const job = {
                id: jobId,
                coin: "ETH",
                blob_type_num: 102,
                blockHash: "eth-template-1",
                extraNonce,
                difficulty: 1,
                coinHashFactor: 1
            };
            const miner = {
                id,
                payout,
                logString: `${payout}:${jobId}`,
                proxy: false,
                validJobs: {
                    toarray() {
                        return [job];
                    }
                },
                hasSubmittedValidShare: false,
                invalidJobIdCount: 0,
                touchProtocolActivity() {},
                touchValidShare() {
                    miner.hasSubmittedValidShare = true;
                },
                checkBan() {
                    return false;
                },
                storeInvalidShare() {
                    invalidShareCalls += 1;
                },
                sendSameCoinJob() {}
            };
            state.activeMiners.set(id, miner);
            return { miner, job };
        }

        const minerA = createMiner("miner-a", "wallet-a", "0008", "job-a");
        const minerB = createMiner("miner-b", "wallet-b", "0007", "job-b");

        function submitShare(minerId, jobId, nonce) {
            const replies = [];
            const finals = [];
            protocolHandler(
                {},
                `${minerId}-${jobId}`,
                "submit",
                {
                    id: minerId,
                    job_id: jobId,
                    nonce,
                    result: "f".repeat(64)
                },
                "127.0.0.2",
                { port: 39002, portType: "pplns" },
                function onReply(error, result) {
                    replies.push({ error, result });
                },
                function onFinal(error, timeout) {
                    finals.push({ error, timeout });
                },
                function onPush() {}
            );
            return { replies, finals };
        }

        const firstSubmit = submitShare(minerA.miner.id, minerA.job.id, "0x0008000000000001");
        const replaySubmit = submitShare(minerB.miner.id, minerB.job.id, "0x0008000000000001");

        assert.deepEqual(firstSubmit.finals, []);
        assert.deepEqual(firstSubmit.replies, [{ error: null, result: true }]);
        assert.deepEqual(replaySubmit.finals, []);
        assert.deepEqual(replaySubmit.replies, [{ error: "Duplicate share", result: undefined }]);
        assert.equal(shareCalls, 1);
        assert.equal(invalidShareCalls, 1);
        assert.equal(state.activeBlockTemplates.ETH.sharedNonceSubmissions.has("0008000000000001"), true);
    } finally {
        global.config = originalConfig;
        global.coinFuncs = originalCoinFuncs;
    }
});

test("share processor records accepted shares through the common verification path", async () => {
    const messages = [];
    const databaseShares = [];
    const walletTrust = { wallet: 0 };
    const walletLastSeeTime = {};
    const activeBlockTemplates = {
        "": { idHash: "active-template" }
    };
    const minerWallets = {
        wallet: {
            connectTime: Date.now(),
            count: 1,
            hashes: 0,
            last_ver_shares: 0
        }
    };
    const lastMinerLogTime = {};

    global.config = {
        pool: {
            shareAccTime: 60,
            targetTime: 30,
            trustThreshold: 1,
            trustMin: 0,
            trustedMiners: false,
            minerThrottleSharePerSec: 1000,
            minerThrottleShareWindow: 10
        },
        daemon: {
            port: 39001
        },
        pool_id: 7,
        general: {
            adminEmail: "admin@example.invalid"
        }
    };
    global.protos = {
        Share: {
            encode(payload) {
                return payload;
            }
        }
    };
    global.database = {
        storeShare(height, payload) {
            databaseShares.push({ height, payload });
        }
    };
    global.support = {
        sendEmail() {}
    };
    const defaultProfile = {
        pool: {}
    };
    global.coinFuncs = {
        constructNewBlob() {
            return Buffer.from("feedbeef", "hex");
        },
        convertBlob(buffer) {
            return Buffer.from(buffer);
        },
        slowHashBuff() {
            return Buffer.from("f".repeat(64), "hex");
        },
        slowHashAsync(_buffer, _blockTemplate, _wallet, callback) {
            callback("f".repeat(64));
        },
        constructMMChildBlockBlob() {
            throw new Error("MM path should not be used in this test");
        },
        getPoolProfile() {
            return defaultProfile;
        },
        getJobProfile() {
            return defaultProfile;
        }
    };

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = function unrefTimeout(callback, delay, ...args) {
        const timer = originalSetTimeout(callback, delay, ...args);
        if (timer && typeof timer.unref === "function") timer.unref();
        return timer;
    };

    const shareProcessor = createShareProcessor({
        crypto: require("node:crypto"),
        debug() {},
        divideBaseDiff() {
            return 10n;
        },
        bigIntFromBuffer() {
            return 1n;
        },
        bigIntToBuffer(value, options) {
            let hex = BigInt(value).toString(16);
            if (hex.length % 2) hex = `0${hex}`;
            if (options && options.size) hex = hex.padStart(options.size * 2, "0");
            const buffer = Buffer.from(hex, "hex");
            return options && options.endian === "little" ? Buffer.from(buffer).reverse() : buffer;
        },
        toBigInt(value) {
            return BigInt(value);
        },
        baseRavenDiff: 1,
        anchorState: { current: 101 },
        activeBlockTemplates,
        proxyMiners: {},
        minerWallets,
        walletTrust,
        walletLastSeeTime,
        processSend(message) {
            messages.push(message.type);
        },
        addProxyMiner() {
            return true;
        },
        adjustMinerDiff() {
            return false;
        },
        getThreadName() {
            return "(Test) ";
        },
        formatCoinPort(coin) {
            return coin === "" ? "XMR/39001" : `${coin}/39002`;
        },
        getLastMinerLogTime() {
            return lastMinerLogTime;
        },
        setLastMinerLogTime(nextValue) {
            clearObject(lastMinerLogTime);
            Object.assign(lastMinerLogTime, nextValue);
        }
    });

    try {
        const accepted = await new Promise((resolve) => {
            shareProcessor.processShare({
                payout: "wallet",
                address: "wallet",
                paymentID: null,
                wallet_key: "wallet-key ",
                poolTypeEnum: 0,
                identifier: "worker-a",
                logString: "wallet:worker-a",
                proxy: false,
                hashes: 0,
                sendSameCoinJob() {
                    throw new Error("sendSameCoinJob should not be called for a valid share");
                }
            }, {
                blob_type_num: 0,
                difficulty: 10,
                rewarded_difficulty: 10,
                rewarded_difficulty2: 10,
                norm_diff: 10,
                coinHashFactor: 1,
                extraNonce: 0,
                height: 101,
                coin: ""
            }, {
                port: 39001,
                coin: "",
                idHash: "active-template",
                buffer: Buffer.alloc(32),
                reserved_offset: 0,
                height: 101,
                difficulty: 1000
            }, {
                nonce: "00000001",
                result: "f".repeat(64)
            }, resolve);
        });

        assert.equal(accepted, true);
        assert.deepEqual(messages, ["normalShare"]);
        assert.equal(databaseShares.length, 0);
    } finally {
        shareProcessor.resetShareState();
        global.setTimeout = originalSetTimeout;
    }
});
});
