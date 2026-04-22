"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const CryptoJS = require("crypto-js");

const ROOT_DIR = path.join(__dirname, "..", "..");
const DEFAULT_TARGET_HOST = "localhost";
const DEFAULT_TARGET_PORT = 20001;
const DEFAULT_CACHE_DIR = path.join(ROOT_DIR, ".cache", "live-miners");
const DEFAULT_LOG_DIR = path.join(ROOT_DIR, "test-artifacts", "live-pool");
const DEFAULT_WALLET = "499fS1Phq64hGeqV8p2AfXbf6Ax7gP6FybcMJq6Wbvg8Hw6xms8tCmdYpPsTLSaTNuLEtW4kF2DDiWCFcw4u7wSvFD8wFWE";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_THREADS = Math.max(1, os.availableParallelism());
const DEFAULT_DIFFICULTY = 1;
const DEFAULT_TARGET_ACCEPTED_SHARES = 1;
const DEFAULT_SRBMINER_GPU_ID = "0";
const DEFAULT_SRBMINER_API_PORT = 21550;
const DEFAULT_MOMINER_C29_DEVICE = "gpu1*1";
const DEFAULT_MOMINER_DOCKER_IMAGE = "mominer-deploy";

const XMRIG_RELEASE_API = "https://api.github.com/repos/MoneroOcean/xmrig/releases/latest";
const SRBMINER_RELEASE_API = "https://api.github.com/repos/doktor83/SRBMiner-Multi/releases/latest";
const SRBMINER_DOWNLOAD_PREFIX = "https://github.com/doktor83/SRBMiner-Multi/releases/download/";
const MOMINER_RELEASE_API = "https://api.github.com/repos/MoneroOcean/mominer/releases/latest";
const MOMINER_DOWNLOAD_PREFIX = "https://github.com/MoneroOcean/mominer/releases/download/";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const USER_AGENT = "nodejs-pool-live-tests";
const DIFF_SCALE = { "": 1, h: 1e2, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 };
const HASHRATE_SCALE = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 };
const MONERO_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MONERO_FULL_BLOCK_ENCODED_SIZE = 11;
const MONERO_FULL_BLOCK_DECODED_SIZE = 8;
const MONERO_ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const MONERO_DECODED_BLOCK_SIZES = Object.freeze({ 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 });
const BLOCK_SUBMIT_TEST_MARKER_PATH = path.join(ROOT_DIR, ".pool-live-block-submit-test");
const BLOCK_SUBMIT_TEST_MODE_WAIT_MS = 5500;
const BASE_DIFF = (1n << 256n) - 1n;
const words = (value) => value.trim().split(/\s+/).filter(Boolean);

const EMBEDDED_ACTIVE_ALGOS = [
    { algorithm: "etchash", protocolProbe: "eth-bad-share" },
    { algorithm: "kawpow", protocolProbe: "eth-bad-share" },
    { algorithm: "autolykos2", protocolProbe: "eth-bad-share" },
    { algorithm: "ghostrider" },
    { algorithm: "panthera" },
    { algorithm: "cn/gpu" },
    { algorithm: "rx/0" },
    { algorithm: "c29", protocolProbe: "login-bad-share" },
    { algorithm: "rx/arq" }
];

const SRBMINER_INTEL_ALGORITHM_MAP = {
    autolykos2: "autolykos2",
    "cn/gpu": "cryptonight_gpu",
    etchash: "etchash",
    kawpow: "kawpow"
};

const MOMINER_NO_BENCH_ALGOS = words(`
    argon2/chukwa argon2/chukwav2 argon2/wrkz c29 cn-heavy/0 cn-heavy/tube cn-heavy/xhv
    cn-lite/0 cn-lite/1 cn-pico/0 cn-pico/tlo cn/0 cn/1 cn/2 cn/ccx cn/double cn/fast
    cn/half cn/gpu cn/r cn/rto cn/rwz cn/upx2 cn/xao cn/zls ghostrider panthera
    rx/0 rx/arq rx/graft rx/sfx rx/wow rx/yada
`);
const XMRIG_CPU_ALGOS = new Set(words(`
    argon2/chukwav2 cn-heavy/xhv cn/gpu cn-half cn/half cn/pico cn-pico/trtl cn/r
    ghostrider panthera rx/0 rx/arq rx/graft rx/wow
`));
const XMRIG_ALGO_PERF_SEED = Object.fromEntries(words(`
    argon2/chukwav2 cn-heavy/xhv cn/half cn-lite/1 cn/gpu cn-pico cn-pico/trtl cn/r
    cn/ccx flex ghostrider kawpow panthera rx/0 rx/arq rx/graft rx/wow
`).map((algorithm) => [algorithm, 1]));

const SRBMINER_NICEHASH_STRATUM_ALGOS = new Set(["etchash"]);
const MOMINER_INTEL_ALGOS = new Set(["c29"]);
const GPU_PROTOCOL_PROBE_ALGOS = new Set(["autolykos2", "c29", "etchash", "kawpow"]);

const stripAnsi = (value) => typeof value === "string" ? value.replace(ANSI_ESCAPE_PATTERN, "") : "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitWithTimeout(promise, timeoutMs) {
    let timeoutHandle;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timeoutHandle = setTimeout(resolve, timeoutMs);
            })
        ]);
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

function sanitizeName(value) {
    return String(value || "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}

const shortAlgoName = (value) => sanitizeName(value).replace(/\//g, "-");
const buildRunId = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;

function fileExistsSync(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

function commandExists(command) {
    const checker = process.platform === "win32" ? "where" : "which";
    return spawnSync(checker, [command], { stdio: "ignore" }).status === 0;
}

function detectIntelGpu() {
    if (!commandExists("clinfo")) return false;
    const result = spawnSync("clinfo", [], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    return result.status === 0 && /Device Type\s+GPU/i.test(output) && /\bIntel\b/i.test(output) && !/Device Available\s+No/i.test(output);
}

const ensureDir = async (dirPath) => await fsp.mkdir(dirPath, { recursive: true });
const writeJson = async (filePath, value) => await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
const emitProgress = (message) => process.stdout.write(`${message}\n`);

function formatReadableTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    return [value.getHours(), value.getMinutes(), value.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}

function emitLiveStatus(status, label, detail = "") {
    emitProgress(`[${formatReadableTime(new Date())}] ${status} ${label}${detail ? ` ${detail}` : ""}`);
}

function firstLine(value) {
    return String(value || "").split(/\r?\n/, 1)[0] || "";
}

function tailText(value, maxChars = 4000) {
    const text = String(value || "").trim();
    if (!text || text.length <= maxChars) return text;
    return `...${text.slice(-maxChars)}`;
}

async function readTextFileIfExists(filePath) {
    try {
        return await fsp.readFile(filePath, "utf8");
    } catch (_error) {
        return "";
    }
}

function keccak256(buffer) {
    const hash = CryptoJS.SHA3(CryptoJS.lib.WordArray.create(buffer), { outputLength: 256 });
    return Buffer.from(hash.toString(CryptoJS.enc.Hex), "hex");
}

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

function decodeVarint(buffer, offset = 0) {
    let value = 0n;
    let shift = 0n;
    let index = offset;
    for (; index < buffer.length; ++index) {
        const byte = BigInt(buffer[index]);
        value |= (byte & 0x7fn) << shift;
        if ((byte & 0x80n) === 0n) {
            return { value: Number(value), size: index - offset + 1 };
        }
        shift += 7n;
    }
    throw new Error("Invalid Monero varint encoding");
}

function moneroBase58Decode(value) {
    const alphabetMap = new Map(Array.from(MONERO_BASE58_ALPHABET).map((character, index) => [character, BigInt(index)]));
    const chunks = [];

    for (let offset = 0; offset < value.length; ) {
        const encodedSize = Math.min(MONERO_FULL_BLOCK_ENCODED_SIZE, value.length - offset);
        const decodedSize = MONERO_DECODED_BLOCK_SIZES[encodedSize];
        if (!decodedSize) throw new Error(`Unsupported Monero base58 block size: ${encodedSize}`);

        let numericValue = 0n;
        for (const character of value.slice(offset, offset + encodedSize)) {
            const digit = alphabetMap.get(character);
            if (typeof digit === "undefined") throw new Error(`Invalid Monero base58 character: ${character}`);
            numericValue = numericValue * 58n + digit;
        }

        const limit = 1n << BigInt(decodedSize * 8);
        if (numericValue >= limit) throw new Error(`Monero base58 block overflow for ${encodedSize}-char chunk`);

        const block = Buffer.alloc(decodedSize);
        for (let index = decodedSize - 1; index >= 0; --index) {
            block[index] = Number(numericValue & 0xffn);
            numericValue >>= 8n;
        }
        chunks.push(block);
        offset += encodedSize;
    }

    return Buffer.concat(chunks);
}

function moneroBase58Encode(buffer) {
    let encoded = "";

    for (let offset = 0; offset < buffer.length; offset += MONERO_FULL_BLOCK_DECODED_SIZE) {
        const decodedSize = Math.min(MONERO_FULL_BLOCK_DECODED_SIZE, buffer.length - offset);
        const encodedSize = MONERO_ENCODED_BLOCK_SIZES[decodedSize];
        if (!encodedSize) throw new Error(`Unsupported Monero decoded block size: ${decodedSize}`);

        let numericValue = 0n;
        for (const byte of buffer.subarray(offset, offset + decodedSize)) {
            numericValue = (numericValue << 8n) + BigInt(byte);
        }

        let blockEncoded = "";
        while (numericValue > 0n) {
            const remainder = Number(numericValue % 58n);
            numericValue /= 58n;
            blockEncoded = MONERO_BASE58_ALPHABET[remainder] + blockEncoded;
        }

        encoded += blockEncoded.padStart(encodedSize, "1");
    }

    return encoded;
}

function decodeMoneroSeedAddress(seedAddress) {
    const decoded = moneroBase58Decode(seedAddress);
    if (decoded.length < 1 + 32 + 32 + 4) throw new Error("Seed address is too short");

    const payload = decoded.subarray(0, decoded.length - 4);
    const checksum = decoded.subarray(decoded.length - 4);
    const expectedChecksum = keccak256(payload).subarray(0, 4);
    if (!checksum.equals(expectedChecksum)) throw new Error("Seed address checksum mismatch");

    const prefix = decodeVarint(decoded);
    const spendKeyOffset = prefix.size;
    const viewKeyOffset = spendKeyOffset + 32;
    const checksumOffset = decoded.length - 4;
    if (viewKeyOffset + 32 !== checksumOffset) throw new Error("Seed address does not look like a standard XMR address");

    return {
        plainPrefix: prefix.value,
        integratedPrefix: prefix.value + 1,
        spendKey: decoded.subarray(spendKeyOffset, spendKeyOffset + 32),
        viewKey: decoded.subarray(viewKeyOffset, viewKeyOffset + 32)
    };
}

function createRandomWalletAllocator(seedAddress, logger) {
    const decodedSeed = decodeMoneroSeedAddress(seedAddress);

    return function allocateWallet(label) {
        const paymentId = crypto.randomBytes(8);
        const payload = Buffer.concat([
            encodeVarint(decodedSeed.integratedPrefix),
            decodedSeed.spendKey,
            decodedSeed.viewKey,
            paymentId
        ]);
        const address = moneroBase58Encode(Buffer.concat([payload, keccak256(payload).subarray(0, 4)]));
        if (logger) {
            logger.event("wallet.generated", {
                label,
                address,
                paymentId: paymentId.toString("hex")
            });
        }
        return address;
    };
}

async function isTcpReachable(host, port, timeoutMs = 750) {
    return await new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const finish = (value) => {
            socket.destroy();
            resolve(value);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

function createLogger(runDir) {
    const eventPath = path.join(runDir, "events.jsonl");
    const stream = fs.createWriteStream(eventPath, { flags: "a" });

    return {
        eventPath,
        event(type, payload) {
            stream.write(`${JSON.stringify({ ts: new Date().toISOString(), type, ...payload })}\n`);
        },
        async close() {
            await new Promise((resolve) => stream.end(resolve));
        }
    };
}

async function request(url, headers) {
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        redirect: "follow"
    });

    if (!response.ok) {
        throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
    }

    return response;
}

async function fetchJson(url, headers) {
    return await (await request(url, {
        Accept: "application/vnd.github+json, application/json",
        ...headers
    })).json();
}

async function postJson(url, body, headers) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...headers
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
    }

    return await response.json();
}

module.exports = {
    ROOT_DIR,
    DEFAULT_TARGET_HOST,
    DEFAULT_TARGET_PORT,
    DEFAULT_CACHE_DIR,
    DEFAULT_LOG_DIR,
    DEFAULT_WALLET,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_THREADS,
    DEFAULT_DIFFICULTY,
    DEFAULT_TARGET_ACCEPTED_SHARES,
    DEFAULT_SRBMINER_GPU_ID,
    DEFAULT_SRBMINER_API_PORT,
    DEFAULT_MOMINER_C29_DEVICE,
    DEFAULT_MOMINER_DOCKER_IMAGE,
    XMRIG_RELEASE_API,
    SRBMINER_RELEASE_API,
    SRBMINER_DOWNLOAD_PREFIX,
    MOMINER_RELEASE_API,
    MOMINER_DOWNLOAD_PREFIX,
    USER_AGENT,
    DIFF_SCALE,
    HASHRATE_SCALE,
    BLOCK_SUBMIT_TEST_MARKER_PATH,
    BLOCK_SUBMIT_TEST_MODE_WAIT_MS,
    BASE_DIFF,
    EMBEDDED_ACTIVE_ALGOS,
    SRBMINER_INTEL_ALGORITHM_MAP,
    MOMINER_NO_BENCH_ALGOS,
    XMRIG_CPU_ALGOS,
    XMRIG_ALGO_PERF_SEED,
    SRBMINER_NICEHASH_STRATUM_ALGOS,
    MOMINER_INTEL_ALGOS,
    GPU_PROTOCOL_PROBE_ALGOS,
    stripAnsi,
    sleep,
    waitWithTimeout,
    sanitizeName,
    shortAlgoName,
    buildRunId,
    fileExistsSync,
    commandExists,
    detectIntelGpu,
    ensureDir,
    writeJson,
    emitProgress,
    formatReadableTime,
    emitLiveStatus,
    firstLine,
    tailText,
    readTextFileIfExists,
    keccak256,
    encodeVarint,
    decodeVarint,
    moneroBase58Decode,
    moneroBase58Encode,
    decodeMoneroSeedAddress,
    createRandomWalletAllocator,
    isTcpReachable,
    createLogger,
    request,
    postJson,
    fetchJson
};
