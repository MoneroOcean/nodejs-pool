"use strict";

const crypto = require("node:crypto");
const { blob, createProfile, pool, template } = require("./core/factories.js");
const pearl = require("./core/pearl.js");

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** @param {unknown} body @returns {Record<string, unknown>|null} */
function rpcResultRecord(body) {
    if (!isRecord(body) || !isRecord(body["result"])) return null;
    return body["result"];
}

/** @param {unknown} body @returns {unknown} */
function rpcError(body) { return isRecord(body) ? body["error"] : undefined; }

/** @param {unknown} value @returns {number|null} */
function safeHeight(value) {
    const height = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(height) && height >= 0 ? height : null;
}

/** @param {unknown} value @returns {number|undefined} */
function optionalReward(value) {
    const reward = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(reward) && reward >= 0 ? reward : undefined;
}

/** @param {string} method @param {unknown[]} params @returns {{id: string, jsonrpc: string, method: string, params: unknown[]}} */
function daemonRequest(method, params) {
    return { id: "0", jsonrpc: "2.0", method, params };
}

/** @param {unknown} body @param {string} fallbackHash @returns {(Record<string, unknown> & {height: number, hash: string})|null} */
function normalizeDaemonHeader(body, fallbackHash) {
    const result = rpcResultRecord(body);
    if (!result) return null;
    const source = isRecord(result["header"]) ? result["header"] : result;
    const height = safeHeight(source["height"]);
    if (!source || height === null) return null;
    const hash = typeof source["hash"] === "string" && /^[0-9a-fA-F]{64}$/.test(source["hash"])
        ? source["hash"].toLowerCase()
        : fallbackHash;
    if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) return null;
    /** @type {Record<string, unknown> & {height: number, hash: string}} */
    const normalized = { ...source, height, hash };
    const reward = optionalReward(source["reward"]);
    if (reward !== undefined) normalized["reward"] = reward;
    return normalized;
}

/** @param {{targetHex: string}} target @returns {string} */
function targetBase64(target) { return Buffer.from(target.targetHex, "hex").toString("base64"); }

/** @typedef {{target: bigint, targetDecimal: string, targetHex: string, prevHash: string, difficulty: number, compact: number}} ParsedPearlHeader */
/** @typedef {Record<string, unknown> & {height: number, hash: string}} NormalizedPearlHeader */

/** @param {{runtime: import("../../types/coin_profiles").ProfileRuntime, port: number, callback: import("../../types/coin_profiles").RpcCallback, noErrorReport?: boolean, profile: import("../../types/coin_profiles").CoinProfile}} ctx @param {(error: unknown, info?: {header: string, parsed: ParsedPearlHeader, previous: NormalizedPearlHeader, reward?: number}) => void} callback */
function getMiningInfo(ctx, callback) {
    pearl.gatewayRequest("getMiningInfo", {}, function onMiningInfo(error, body) {
        if (error) return callback(error);
        const result = pearl.gatewayResult(body);
        if (!isRecord(result) || result["cert_version"] !== pearl.PEARL_CERT_VERSION ||
            typeof result["incomplete_header_bytes"] !== "string") {
            return callback(new Error("invalid Pearl mining info"));
        }
        const header = result["incomplete_header_bytes"];
        const parsed = pearl.parseMiningHeader(header);
        if (!parsed) return callback(new Error("invalid Pearl mining header"));
        if (result["target_decimal"] !== undefined && result["target_decimal"] !== parsed.targetDecimal) {
            return callback(new Error("Pearl target does not match header"));
        }
        ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockheader", [parsed.prevHash, true]), function onPreviousHeader(reply) {
            /** @type {NormalizedPearlHeader|null} */
            const previous = normalizeDaemonHeader(reply, parsed.prevHash);
            if (!previous) return callback(rpcError(reply) || new Error("invalid Pearl previous header"));
            // pearld reports difficulty relative to its compact consensus PoW limit. Pool
            // accounting instead defines one PRL difficulty as 1,000,000 rank-128 MACs, so
            // derive the network difficulty from the exact template target in those units.
            previous["difficulty"] = parsed.difficulty;
            const reward = optionalReward(result["expected_reward"]);
            if (reward !== undefined) {
                previous["reward"] = reward;
                previous["expected_reward"] = reward;
            }
            return callback(null, { header, parsed, previous, ...(reward === undefined ? {} : { reward }) });
        }, ctx.noErrorReport);
    }, { timeoutMs: pearl.PEARL_GATEWAY_TIMEOUT_MS });
}

/** @param {import("../../types/coin_profiles").RpcSettings} config */
function createPearlRpc(config) {
    config.getLastBlockHeader = function getLastBlockHeader(ctx) {
        getMiningInfo(ctx, function onMiningInfo(error, info) {
            if (error || !info) return ctx.callback(error || true, null);
            return ctx.callback(null, info.previous);
        });
    };

    config.getBlockTemplate = function getBlockTemplate(ctx) {
        getMiningInfo(ctx, function onMiningInfo(error, info) {
            if (error || !info) return ctx.callback(null, error || "invalid Pearl mining info");
            const parsed = info.parsed;
            const templateRecord = {
                hash: info.header,
                header: info.header,
                cert_version: pearl.PEARL_CERT_VERSION,
                target: parsed.targetDecimal,
                pearl_target: parsed.targetDecimal,
                target_hex: parsed.targetHex,
                target_compact: parsed.compact,
                incomplete_header_bytes: info.header,
                gateway_target: Number(parsed.targetDecimal),
                difficulty: parsed.difficulty,
                height: info.previous.height + 1,
                ...(info.reward === undefined ? {} : { expected_reward: info.reward })
            };
            return ctx.callback(templateRecord, null);
        });
    };

    config.getBlockHeaderById = function getBlockHeaderById(ctx) {
        const height = safeHeight(ctx.blockId);
        if (height === null) return ctx.callback(true, { error: "invalid Pearl block height" });
        return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockhash", [height]), function onHash(body) {
            const hashResult = isRecord(body) ? body["result"] : undefined;
            if (typeof hashResult !== "string" || !/^[0-9a-fA-F]{64}$/.test(hashResult)) return ctx.callback(true, body);
            return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockheader", [hashResult, true]), function onHeader(headerBody) {
                const header = normalizeDaemonHeader(headerBody, hashResult);
                if (!header) return ctx.callback(true, headerBody);
                return ctx.callback(null, header);
            }, ctx.noErrorReport);
        }, ctx.noErrorReport);
    };

    config.getAnyBlockHeaderByHash = function getAnyBlockHeaderByHash(ctx) {
        const hash = typeof ctx.blockHash === "string" && /^[0-9a-fA-F]{64}$/.test(ctx.blockHash)
            ? ctx.blockHash.toLowerCase()
            : null;
        if (!hash) return ctx.callback(true, { error: "invalid Pearl block hash" });
        return ctx.runtime.support.rpcPortDaemon2(ctx.port, "", daemonRequest("getblockheader", [hash, true]), function onHeader(body) {
            const header = normalizeDaemonHeader(body, hash);
            if (!header) return ctx.callback(true, body);
            return ctx.callback(null, header);
        }, ctx.noErrorReport);
    };
    return config;
}

/** @param {import("../../types/pool_profiles").PoolAuthorizeAlgoContext} _ctx */
function authorizeAlgoState(_ctx) {
    return { algos: [pearl.PEARL_ALGO], algosPerf: { [pearl.PEARL_ALGO]: 1 }, algoMinTime: 60 };
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams}} ctx @returns {boolean} */
function validateNamedProof(ctx) {
    return typeof ctx.params.job_id === "string" || typeof ctx.params.job_id === "number"
        ? typeof ctx.params.plain_proof === "string" && pearl.isCanonicalBase64(ctx.params.plain_proof)
            && ctx.params.plain_proof.length <= pearl.PEARL_MAX_PROOF_BASE64_CHARS
            && (ctx.params.proof_encoding === undefined || ctx.params.proof_encoding === "none")
        : false;
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams, wireParams: unknown}} ctx @returns {boolean} */
function normalizeNamedSubmitParams(ctx) {
    if (!isRecord(ctx.wireParams) || !validateNamedProof(ctx)) return false;
    if (typeof ctx.params.job_id === "number") ctx.params.job_id = String(ctx.params.job_id);
    const decoded = pearl.decodePearlProof(ctx.params.plain_proof);
    if (!decoded) return false;
    ctx.params.plain_proof = decoded.toString("base64");
    delete ctx.params.proof_encoding;
    return true;
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams}} ctx @returns {boolean} */
function parseNamedSubmitParams(ctx) { return validateNamedProof(ctx); }

/** @param {import("../../types/pool_profiles").PoolSubmissionKeyContext} ctx @returns {string} */
function buildPearlSubmissionKey(ctx) {
    const proof = typeof ctx.params.plain_proof === "string" ? ctx.params.plain_proof : "";
    return crypto.createHash("sha256").update(String(ctx.job.id)).update(":").update(proof).digest("hex");
}

/** @param {{params: import("../../types/pool_profiles").PoolSubmitParams}} ctx @returns {Record<string, unknown>} */
function sanitizePearlSubmitParams(ctx) {
    return { job_id: ctx.params.job_id };
}

/** @param {import("../../types/pool_profiles").BuildJobContext} ctx @returns {import("../../types/pool_profiles").PoolJobPayload} */
function buildPearlJobPayload(ctx) {
    const target = pearl.targetForDifficulty(ctx.coinDiff);
    if (!target) throw new Error("invalid Pearl share difficulty");
    const incompleteHeader = ctx.blockTemplate.incomplete_header_bytes || ctx.blockTemplate.header;
    const parsedHeader = typeof incompleteHeader === "string" ? pearl.parseMiningHeader(incompleteHeader) : null;
    if (typeof incompleteHeader !== "string" || !parsedHeader ||
        ctx.blockTemplate.cert_version !== pearl.PEARL_CERT_VERSION) {
        throw new Error("invalid Pearl block template");
    }
    const targetWire = targetBase64(target);
    ctx.newJob.target = targetWire;
    ctx.newJob.targetHex = target.targetHex;
    ctx.newJob.targetDecimal = target.targetDecimal;
    ctx.newJob.gatewayTarget = Number(target.targetDecimal);
    ctx.newJob.incomplete_header_bytes = incompleteHeader;
    ctx.newJob.cert_version = ctx.blockTemplate.cert_version;
    return {
        header: parsedHeader.header.toString("hex"),
        height: ctx.blockTemplate.height,
        job_id: ctx.newJob.id,
        target: targetWire,
        difficulty: ctx.coinDiff,
        cert_version: ctx.blockTemplate.cert_version
    };
}

/** @param {import("../../types/pool_profiles").PushJobContext} ctx */
function pushPearlJob(ctx) {
    ctx.miner.pushMessage({ method: "mining.notify", params: ctx.job, id: null });
}

/** @param {import("../../types/pool_profiles").PoolLoginContext} ctx */
function sendPearlLoginResult(ctx) {
    ctx.sendReply(null, true);
    ctx.miner.sendBestCoinJob();
}

/** @param {import("../../types/pool_profiles").PoolSpecialShareContext} ctx @returns {boolean} */
function verifyPearlShare(ctx) {
    const header = typeof ctx.blockTemplate.header === "string" ? ctx.blockTemplate.header : "";
    const parsed = pearl.parseMiningHeader(header);
    const proof = ctx.params.plain_proof;
    const targetHex = ctx.job.targetHex;
    if (!parsed || typeof proof !== "string" || !pearl.isCanonicalBase64(proof) || proof.length > pearl.PEARL_MAX_PROOF_BASE64_CHARS ||
        typeof targetHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(targetHex)) {
        return ctx.processShareCB(ctx.invalidShare(ctx.miner)), true;
    }
    if (typeof ctx.startAsyncVerification === "function") ctx.startAsyncVerification();
    if (typeof ctx.coinFuncs.verifyPearlAsync !== "function") return ctx.processShareCB(null), true;
    ctx.coinFuncs.verifyPearlAsync(parsed.header.toString("hex"), proof, targetHex, ctx.miner.payout, function onVerified(result, errorKind) {
        if (errorKind || result === null || typeof result === "undefined") return ctx.processShareCB(null);
        const verified = pearl.parsePearlVerifierResult(result);
        if (!verified) return ctx.processShareCB(null);
        if (!verified.valid) return ctx.processShareCB(ctx.invalidShare(ctx.miner));
        if (!verified.candidate) return ctx.processShareCB(ctx.invalidShare(ctx.miner));
        if (verified.proof_id) ctx.params["pearl_proof_id"] = verified.proof_id;
        const isCandidate = pearl.isPearlNetworkCandidate(
            verified.jackpot, ctx.blockTemplate.target, verified.config.adjustment_factor
        );
        if (!isCandidate) return ctx.verifyShareCB(ctx.job.difficulty, null, null, false, false, false);
        const rawProof = pearl.decodePearlProof(proof);
        if (!rawProof) return ctx.processShareCB(null);
        return ctx.verifyShareCB(ctx.job.difficulty, null, rawProof.toString("base64"), false, true, true);
    });
    return true;
}

/** @param {unknown} rpcResult @returns {(Record<string, unknown> & {block_hash: string})|null} */
function acceptedPearlResult(rpcResult) {
    const result = isRecord(rpcResult) && isRecord(rpcResult["result"]) ? rpcResult["result"] : null;
    if (!result || result["status"] !== "accepted" || typeof result["block_hash"] !== "string" || !/^[0-9a-fA-F]{64}$/.test(result["block_hash"])) return null;
    return /** @type {Record<string, unknown> & {block_hash: string}} */ (result);
}

/** @param {import("../../types/pool_profiles").PoolBlockAcceptanceContext} ctx @returns {boolean} */
function acceptPearlBlock(ctx) {
    return acceptedPearlResult(ctx.rpcResult) !== null;
}

/** @param {import("../../types/pool_profiles").PoolBlockHashContext} ctx @param {(blockHash: string) => void} callback */
function resolvePearlBlockHash(ctx, callback) {
    const result = acceptedPearlResult(ctx.rpcResult);
    callback(result ? result.block_hash.toLowerCase() : "0".repeat(64));
}

/** @this {import("../../types/pool_profiles").PoolProfileSettings} @param {import("../../types/pool_profiles").PoolSubmitBlockContext} ctx */
function submitPearlBlock(ctx) {
    if (typeof ctx.blockData !== "string" || typeof ctx.job.targetDecimal !== "string") {
        return ctx.replyFn({ error: { code: -1, message: "Invalid Pearl proof submission" } }, 0);
    }
    pearl.gatewayRequest("submitPlainProof", {
        plain_proof: ctx.blockData,
        mining_job: {
            incomplete_header_bytes: ctx.job.incomplete_header_bytes,
            target: ctx.job.gatewayTarget,
            target_decimal: ctx.job.targetDecimal,
            cert_version: ctx.job.cert_version
        }
    }, function onReply(error, reply) {
        if (error) return ctx.replyFn({ error: { code: -1, message: error.message } }, 0);
        if (!acceptedPearlResult(reply)) {
            return ctx.replyFn({ error: { code: -1, message: "Pearl gateway did not accept the proof" } }, 200);
        }
        return ctx.replyFn(reply, 200);
    }, { timeoutMs: pearl.PEARL_GATEWAY_SUBMIT_TIMEOUT_MS });
}

const pearlPool = pool.standard({
    minDifficulty: "config",
    hashesPerDifficulty: pearl.PEARL_HASHES_PER_DIFFICULTY,
    disableProxyNonce: true,
    sharedTemplateSubmissions: true,
    authorizeAlgoState,
    sendLoginResult: sendPearlLoginResult,
    sendNamedLoginResult: sendPearlLoginResult,
    normalizeNamedAuthorizeParams: function normalizeNamedAuthorize(ctx) {
        const params = ctx.params;
        if (!isRecord(params) || typeof params["wallet"] !== "string" || !params["wallet"] || typeof params["worker"] !== "string" ||
            typeof params["pass"] !== "string" || typeof params["agent"] !== "string") return false;
        params["login"] = params["wallet"];
        params["rigid"] = params["worker"];
        const state = authorizeAlgoState({ coinFuncs: global.coinFuncs, port: ctx.port, profile: ctx.profile });
        params["algo"] = state.algos;
        params["algo-perf"] = state.algosPerf;
        params["algo-min-time"] = state.algoMinTime;
        return true;
    },
    normalizeNamedSubmitParams,
    parseMiningSubmitParams: parseNamedSubmitParams,
    validateSubmitParams: function validatePearlSubmit(ctx) { return validateNamedProof(ctx); },
    submissionKey: buildPearlSubmissionKey,
    sanitizeSubmitParams: sanitizePearlSubmitParams,
    sensitiveSubmitData: true,
    verifySpecialShare: verifyPearlShare,
    acceptSubmittedBlock: acceptPearlBlock,
    resolveSubmittedBlockHash: resolvePearlBlockHash,
    submitBlockRpc: submitPearlBlock,
    submitSuccess: "status",
    buildJobPayload: buildPearlJobPayload,
    buildProxyJobPayload: buildPearlJobPayload,
    pushJob: pushPearlJob
});

module.exports = createProfile({
    port: pearl.PEARL_PORT,
    coin: "PRL",
    displayCoin: "PRL",
    blobType: pearl.PEARL_BLOB_TYPE,
    algo: pearl.PEARL_ALGO,
    minerAlgoAliases: { [pearl.PEARL_ALGO]: ["pearl"] },
    perf: { aliases: [pearl.PEARL_ALGO, "pearl"] },
    blobTypeName: "pearl",
    blob: blob.identity(),
    pool: pearlPool,
    template: template.hashOnly(),
    rpc: createPearlRpc({})
});
