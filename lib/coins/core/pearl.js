"use strict";

const net = require("node:net");

const PEARL_PORT = 44109;
const PEARL_GATEWAY_PORT = 44111;
const PEARL_BLOB_TYPE = 108;
const PEARL_ALGO = "pearlhash";
const PEARL_CERT_VERSION = 3;
const PEARL_HEADER_BYTES = 76;
const PEARL_HASHES_PER_DIFFICULTY = 1_000_000;
const PEARL_MAX_PROOF_BYTES = 8 * 1024 * 1024;
const PEARL_MAX_PROOF_BASE64_CHARS = Math.ceil(PEARL_MAX_PROOF_BYTES / 3) * 4;
const PEARL_MAX_GATEWAY_REQUEST_BYTES = 12 * 1024 * 1024;
const PEARL_MAX_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const PEARL_GATEWAY_TIMEOUT_MS = 10 * 1000;
const PEARL_GATEWAY_SUBMIT_TIMEOUT_MS = 60 * 1000;
const UINT256_MAX = (1n << 256n) - 1n;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** @param {unknown} value @returns {value is string} */
function isCanonicalBase64(value) {
    if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return false;
    try { return Buffer.from(value, "base64").toString("base64") === value; } catch (_error) { return false; }
}

/** @param {unknown} value @param {number} expectedBytes @returns {Buffer|null} */
function decodeCanonicalBase64(value, expectedBytes) {
    if (!isCanonicalBase64(value) || value.length > Math.ceil(expectedBytes / 3) * 4) return null;
    const decoded = Buffer.from(value, "base64");
    return decoded.length === expectedBytes ? decoded : null;
}

/** @param {unknown} value @returns {Buffer|null} */
function decodePearlHeader(value) { return decodeCanonicalBase64(value, PEARL_HEADER_BYTES); }

/** @param {unknown} value @returns {Buffer|null} */
function decodePearlProof(value) {
    if (!isCanonicalBase64(value) || value.length > PEARL_MAX_PROOF_BASE64_CHARS) return null;
    let encoded;
    try { encoded = Buffer.from(value, "base64"); } catch (_error) { return null; }
    if (encoded.length === 0 || encoded.length > PEARL_MAX_PROOF_BYTES) return null;
    return encoded;
}

/** @param {bigint} value @returns {number} */
function bitLength(value) { return value === 0n ? 0 : value.toString(2).length; }

/** @param {bigint} target @returns {number|null} */
function targetToCompact(target) {
    if (typeof target !== "bigint" || target <= 0n || target > UINT256_MAX) return null;
    let size = Math.ceil(bitLength(target) / 8);
    let compact;
    if (size <= 3) compact = Number(target << BigInt(8 * (3 - size)));
    else compact = Number(target >> BigInt(8 * (size - 3)));
    if ((compact & 0x00800000) !== 0) {
        compact >>>= 8;
        ++size;
    }
    return ((size << 24) | (compact & 0x007fffff)) >>> 0;
}

/** @param {number} compact @returns {{target: bigint, compact: number}|null} */
function compactToTarget(compact) {
    if (!Number.isInteger(compact) || compact < 0 || compact > 0xffffffff) return null;
    const exponent = compact >>> 24;
    const mantissa = compact & 0x007fffff;
    if ((compact & 0x00800000) !== 0 || mantissa === 0 || exponent === 0 || exponent > 32) return null;
    const shift = 8 * (exponent - 3);
    const target = shift >= 0 ? BigInt(mantissa) << BigInt(shift) : BigInt(mantissa) >> BigInt(-shift);
    if (target <= 0n || target > UINT256_MAX || targetToCompact(target) !== compact) return null;
    return { target, compact };
}

/** @param {Buffer} header @returns {{target: bigint, targetDecimal: string, targetHex: string, compact: number}|null} */
function targetFromPearlHeader(header) {
    if (!Buffer.isBuffer(header) || header.length !== PEARL_HEADER_BYTES) return null;
    const compact = header.readUInt32LE(72);
    const parsed = compactToTarget(compact);
    if (!parsed) return null;
    return {
        target: parsed.target,
        targetDecimal: parsed.target.toString(10),
        targetHex: toLittleEndianHex(parsed.target, 32),
        compact: parsed.compact
    };
}

/** @param {bigint} value @param {number} size @returns {string} */
function toLittleEndianHex(value, size) {
    if (typeof value !== "bigint" || value < 0n || value >= (1n << BigInt(size * 8))) throw new RangeError("value does not fit in target buffer");
    return Buffer.from(value.toString(16).padStart(size * 2, "0"), "hex").reverse().toString("hex");
}

/** @param {number} difficulty @returns {{work: bigint, target: bigint, targetDecimal: string, targetHex: string}|null} */
function targetForDifficulty(difficulty) {
    if (typeof difficulty !== "number" || !Number.isFinite(difficulty) || difficulty <= 0) return null;
    const workNumber = Math.ceil(difficulty * PEARL_HASHES_PER_DIFFICULTY);
    if (!Number.isSafeInteger(workNumber) || workNumber <= 0) return null;
    const work = BigInt(workNumber);
    const target = UINT256_MAX / work;
    if (target <= 0n) return null;
    return { work, target, targetDecimal: target.toString(10), targetHex: toLittleEndianHex(target, 32) };
}

/** @param {string} headerBase64 @returns {{header: Buffer, target: bigint, targetDecimal: string, targetHex: string, compact: number, prevHash: string, difficulty: number}|null} */
function parseMiningHeader(headerBase64) {
    const header = decodePearlHeader(headerBase64);
    if (!header) return null;
    const target = targetFromPearlHeader(header);
    if (!target) return null;
    const previousHash = Buffer.from(header.subarray(4, 36)).reverse().toString("hex");
    const difficulty = Number(UINT256_MAX / target.target) / PEARL_HASHES_PER_DIFFICULTY;
    if (!Number.isFinite(difficulty) || difficulty <= 0) return null;
    return {
        header,
        target: target.target,
        targetDecimal: target.targetDecimal,
        targetHex: target.targetHex,
        compact: target.compact,
        prevHash: previousHash,
        difficulty
    };
}

/** @param {unknown} value @returns {bigint|null} */
function parseUint256Decimal(value) {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
    try {
        const parsed = BigInt(value);
        return parsed > 0n && parsed <= UINT256_MAX ? parsed : null;
    } catch (_error) { return null; }
}

/** @param {unknown} value @returns {bigint|null} */
function parseAdjustmentFactor(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
    return BigInt(value);
}

/** @param {unknown} targetDecimal @param {unknown} adjustmentFactor @returns {bigint|null} */
function adjustedNetworkTarget(targetDecimal, adjustmentFactor) {
    const target = parseUint256Decimal(targetDecimal);
    const factor = parseAdjustmentFactor(adjustmentFactor);
    if (target === null || factor === null) return null;
    const adjusted = target * factor;
    return adjusted > UINT256_MAX ? null : adjusted;
}

/** @param {unknown} jackpotLittleEndian @param {unknown} networkTargetDecimal @param {unknown} adjustmentFactor @returns {boolean} */
function isPearlNetworkCandidate(jackpotLittleEndian, networkTargetDecimal, adjustmentFactor) {
    if (typeof jackpotLittleEndian !== "string" || !/^[0-9a-fA-F]{64}$/.test(jackpotLittleEndian)) return false;
    const adjusted = adjustedNetworkTarget(networkTargetDecimal, adjustmentFactor);
    if (adjusted === null) return false;
    const jackpot = BigInt(`0x${Buffer.from(jackpotLittleEndian, "hex").reverse().toString("hex")}`);
    return jackpot <= adjusted;
}

/** @param {unknown} value @returns {boolean} */
function isSafeNonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** @param {unknown} value @returns {value is Record<string, unknown> & {adjustment_factor: number}} */
function isValidVerifierConfig(value) {
    if (!isRecord(value)) return false;
    const numericFields = ["m", "n", "k", "rank", "experts", "top_k", "expert_index", "t_rows", "t_cols", "adjustment_factor"];
    return numericFields.every(field => isSafeNonNegativeInteger(value[field])) && typeof value["moe"] === "boolean";
}

/** @param {unknown} value @returns {{valid: false}|{valid: true, candidate: boolean, jackpot: string, config: Record<string, unknown> & {adjustment_factor: number}, proof_id?: string}|null} */
function parsePearlVerifierResult(value) {
    if (!isRecord(value) || typeof value["valid"] !== "boolean") return null;
    if (!value["valid"]) return { valid: false };
    const jackpot = value["jackpot"];
    const config = value["config"];
    const proofId = value["proof_id"];
    if (typeof value["candidate"] !== "boolean" || typeof jackpot !== "string" || !/^[0-9a-fA-F]{64}$/.test(jackpot) ||
        (proofId !== undefined && (typeof proofId !== "string" || !/^[0-9a-fA-F]{64}$/.test(proofId))) || !isValidVerifierConfig(config)) return null;
    return {
        valid: true,
        candidate: value["candidate"],
        jackpot: jackpot.toLowerCase(),
        config,
        ...(proofId === undefined ? {} : { proof_id: proofId.toLowerCase() })
    };
}

/** @param {unknown} body @returns {unknown|null} */
function gatewayResult(body) {
    if (!isRecord(body) || (body["error"] !== undefined && body["error"] !== null) || !Object.hasOwn(body, "result")) return null;
    return body["result"];
}

/**
 * Send one newline-delimited JSON-RPC request on one TCP socket.
 * The callback receives an error and parsed reply, never the request body.
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {(error: Error|null, reply?: unknown) => void} callback
 * @param {{host?: string, port?: number, timeoutMs?: number, maxRequestBytes?: number, maxResponseBytes?: number}} [options]
 */
function gatewayRequest(method, params, callback, options) {
    const opts = options || {};
    const host = typeof opts.host === "string" && opts.host.length ? opts.host : global.config?.daemon?.address;
    const port = Number(opts.port ?? global.config?.daemon?.["pearlGatewayPort"] ?? PEARL_GATEWAY_PORT);
    const timeoutMs = Number(opts.timeoutMs ?? PEARL_GATEWAY_TIMEOUT_MS);
    const maxRequestBytes = Number(opts.maxRequestBytes ?? PEARL_MAX_GATEWAY_REQUEST_BYTES);
    const maxResponseBytes = Number(opts.maxResponseBytes ?? PEARL_MAX_GATEWAY_RESPONSE_BYTES);
    if (typeof host !== "string" || !host || !Number.isInteger(port) || port <= 0 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return callback(new Error("invalid Pearl gateway endpoint"));
    }
    let requestBody;
    try { requestBody = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`; } catch (_error) { return callback(new Error("invalid Pearl gateway request")); }
    if (Buffer.byteLength(requestBody) > maxRequestBytes) return callback(new Error("Pearl gateway request exceeds limit"));

    const socket = net.createConnection({ host, port });
    let done = false;
    let response = Buffer.alloc(0);
    /** @param {Error|null} error @param {unknown} [reply] */
    const finish = function finish(error, reply) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        socket.destroy();
        callback(error, reply);
    };
    const timer = setTimeout(() => finish(new Error("Pearl gateway timeout")), timeoutMs);
    socket.setNoDelay(true);
    socket.on("connect", () => socket.write(requestBody));
    socket.on("data", function onData(chunk) {
        if (done) return;
        response = Buffer.concat([response, Buffer.from(chunk)]);
        if (response.length > maxResponseBytes) return finish(new Error("Pearl gateway response exceeds limit"));
        const newline = response.indexOf(0x0a);
        if (newline < 0) return;
        const firstLine = response.subarray(0, newline);
        const trailing = response.subarray(newline + 1);
        if (trailing.some(byte => byte !== 0x0d && byte !== 0x0a && byte !== 0x20 && byte !== 0x09)) return finish(new Error("Pearl gateway returned multiple replies"));
        try { return finish(null, JSON.parse(firstLine.toString("utf8"))); } catch (_error) { return finish(new Error("Pearl gateway returned malformed JSON")); }
    });
    socket.on("end", function onEnd() {
        if (!done) finish(new Error("Pearl gateway reply missing newline"));
    });
    socket.on("timeout", () => finish(new Error("Pearl gateway timeout")));
    socket.on("error", () => finish(new Error("Pearl gateway transport failure")));
    return undefined;
}

module.exports = {
    PEARL_ALGO,
    PEARL_BLOB_TYPE,
    PEARL_CERT_VERSION,
    PEARL_GATEWAY_PORT,
    PEARL_GATEWAY_SUBMIT_TIMEOUT_MS,
    PEARL_GATEWAY_TIMEOUT_MS,
    PEARL_HASHES_PER_DIFFICULTY,
    PEARL_HEADER_BYTES,
    PEARL_MAX_GATEWAY_REQUEST_BYTES,
    PEARL_MAX_GATEWAY_RESPONSE_BYTES,
    PEARL_MAX_PROOF_BASE64_CHARS,
    PEARL_MAX_PROOF_BYTES,
    PEARL_PORT,
    UINT256_MAX,
    adjustedNetworkTarget,
    compactToTarget,
    decodeCanonicalBase64,
    decodePearlHeader,
    decodePearlProof,
    gatewayRequest,
    gatewayResult,
    isCanonicalBase64,
    isPearlNetworkCandidate,
    parseMiningHeader,
    parsePearlVerifierResult,
    targetForDifficulty,
    targetFromPearlHeader,
    targetToCompact,
    toLittleEndianHex
};
