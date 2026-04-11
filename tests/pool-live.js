"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const tls = require("node:tls");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn, spawnSync } = require("node:child_process");

const parseArgv = require("../parse_args.js");

const ROOT_DIR = path.join(__dirname, "..");
const DEFAULT_TARGET_HOST = "localhost";
const DEFAULT_TARGET_PORT = 443;
const DEFAULT_CACHE_DIR = path.join(ROOT_DIR, ".cache", "live-miners");
const DEFAULT_LOG_DIR = path.join(ROOT_DIR, "test-artifacts", "live-pool");
const DEFAULT_WALLET = "862wu9yae6qSUaUGz3KjjSeQ3xPKKxhzf8eYd9qXFx4eTpWm1qp6tvY9mzX4YiUQyYNdwZ9T8Muy1NfydEnExWkER25EfNj";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_THREADS = Math.max(1, os.availableParallelism());
const DEFAULT_DIFFICULTY = 1;
const DEFAULT_TARGET_ACCEPTED_SHARES = 1;
const XMRIG_RELEASE_API = "https://api.github.com/repos/MoneroOcean/xmrig/releases/latest";
const SRBMINER_RELEASE_API = "https://api.github.com/repos/doktor83/SRBMiner-Multi/releases/latest";
const SRBMINER_DOWNLOAD_PREFIX = "https://github.com/doktor83/SRBMiner-Multi/releases/download/";
const MOMINER_RELEASE_API = "https://api.github.com/repos/MoneroOcean/mominer/releases/latest";
const MOMINER_DOWNLOAD_PREFIX = "https://github.com/MoneroOcean/mominer/releases/download/";
const DEFAULT_SRBMINER_GPU_ID = "0";
const DEFAULT_SRBMINER_API_PORT = 21550;
const DEFAULT_MOMINER_C29_DEVICE = "gpu1*1";
const DEFAULT_MOMINER_DOCKER_IMAGE = "mominer-deploy";
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ARCHIVE_PATH_ESCAPE_PATTERN = /(^|\/)\.\.(\/|$)/;
const EMBEDDED_ACTIVE_ALGOS = [
    { algorithm: "etchash", protocolProbe: "eth-bad-share" },
    { algorithm: "kawpow", protocolProbe: "eth-bad-share" },
    { algorithm: "autolykos2", protocolProbe: "eth-bad-share" },
    { algorithm: "ghostrider" },
    { algorithm: "panthera" },
    { algorithm: "cn/gpu"/*, successCriterion: "job"*/ },
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
const SRBMINER_NICEHASH_STRATUM_ALGOS = new Set(["etchash"]);
const MOMINER_INTEL_ALGOS = new Set(["c29"]);
const GPU_PROTOCOL_PROBE_ALGOS = new Set(["autolykos2", "c29", "etchash", "kawpow"]);
const MOMINER_NO_BENCH_ALGOS = [
    "argon2/chukwa",
    "argon2/chukwav2",
    "argon2/wrkz",
    "c29",
    "cn-heavy/0",
    "cn-heavy/tube",
    "cn-heavy/xhv",
    "cn-lite/0",
    "cn-lite/1",
    "cn-pico/0",
    "cn-pico/tlo",
    "cn/0",
    "cn/1",
    "cn/2",
    "cn/ccx",
    "cn/double",
    "cn/fast",
    "cn/half",
    "cn/gpu",
    "cn/r",
    "cn/rto",
    "cn/rwz",
    "cn/upx2",
    "cn/xao",
    "cn/zls",
    "ghostrider",
    "panthera",
    "rx/0",
    "rx/arq",
    "rx/graft",
    "rx/sfx",
    "rx/wow",
    "rx/yada"
];
const XMRIG_CPU_ALGOS = new Set([
    "argon2/chukwav2",
    "cn-heavy/xhv",
    "cn/gpu",
    "cn-half",
    "cn/half",
    "cn/pico",
    "cn-pico/trtl",
    "cn/r",
    "ghostrider",
    "panthera",
    "rx/0",
    "rx/arq",
    "rx/graft",
    "rx/wow"
]);
const XMRIG_ALGO_PERF_SEED = {
    "argon2/chukwav2": 1,
    "cn-heavy/xhv": 1,
    "cn/half": 1,
    "cn-lite/1": 1,
    "cn/gpu": 1,
    "cn-pico": 1,
    "cn-pico/trtl": 1,
    "cn/r": 1,
    "cn/ccx": 1,
    "flex": 1,
    ghostrider: 1,
    kawpow: 1,
    panthera: 1,
    "rx/0": 1,
    "rx/arq": 1,
    "rx/graft": 1,
    "rx/wow": 1
};

function stripAnsi(value) {
    return typeof value === "string" ? value.replace(ANSI_ESCAPE_PATTERN, "") : "";
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function shortAlgoName(value) {
    return sanitizeName(value).replace(/\//g, "-");
}

function buildRunId() {
    return [
        new Date().toISOString().replace(/[:.]/g, "-"),
        crypto.randomBytes(4).toString("hex")
    ].join("-");
}

function fileExistsSync(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

function commandExists(command) {
    const check = process.platform === "win32"
        ? spawnSync("where", [command], { stdio: "ignore" })
        : spawnSync("which", [command], { stdio: "ignore" });
    return check.status === 0;
}

function detectIntelGpu() {
    if (!commandExists("clinfo")) return false;
    const result = spawnSync("clinfo", [], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    return result.status === 0 && /Device Type\s+GPU/i.test(output) && /\bIntel\b/i.test(output) && !/Device Available\s+No/i.test(output);
}

async function ensureDir(dirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, value) {
    await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

function emitProgress(message) {
    process.stdout.write(`${message}\n`);
}

function formatReadableTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    const hours = String(value.getHours()).padStart(2, "0");
    const minutes = String(value.getMinutes()).padStart(2, "0");
    const seconds = String(value.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
}

async function readTextFileIfExists(filePath) {
    try {
        return await fsp.readFile(filePath, "utf8");
    } catch (_error) {
        return "";
    }
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

    function event(type, payload) {
        stream.write(JSON.stringify({
            ts: new Date().toISOString(),
            type,
            ...payload
        }) + "\n");
    }

    async function close() {
        await new Promise((resolve) => stream.end(resolve));
    }

    return {
        eventPath,
        event,
        close
    };
}

async function fetchJson(url, headers) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json, application/json",
            "User-Agent": "nodejs-pool-live-tests",
            ...headers
        },
        redirect: "follow"
    });

    if (!response.ok) {
        throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
    }

    return await response.json();
}

async function downloadToFile(url, destination, headers) {
    const response = await fetch(url, {
        headers: {
            "User-Agent": "nodejs-pool-live-tests",
            ...headers
        },
        redirect: "follow"
    });

    if (!response.ok) {
        throw new Error(`Download failed for ${url}: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        throw new Error(`Download body missing for ${url}`);
    }

    await ensureDir(path.dirname(destination));
    const tmpPath = destination + ".part";
    const output = fs.createWriteStream(tmpPath, { mode: 0o644 });

    try {
        await pipeline(Readable.fromWeb(response.body), output);
        await fsp.rename(tmpPath, destination);
    } catch (error) {
        await fsp.rm(tmpPath, { force: true });
        throw error;
    }
}

async function runCommand(command, args, options) {
    const config = options || {};

    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: config.cwd,
            env: config.env,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code !== 0) {
                reject(new Error(`${command} ${args.join(" ")} failed with code ${code} signal ${signal || "none"} stderr=${stderr.trim()}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function validateArchiveEntries(entries, archivePath) {
    for (const entry of entries) {
        const normalized = entry.replace(/\\/g, "/");
        if (normalized === "" || normalized.endsWith("/")) continue;
        if (normalized.startsWith("/")) {
            throw new Error(`Unsafe absolute path in archive ${archivePath}: ${entry}`);
        }
        if (ARCHIVE_PATH_ESCAPE_PATTERN.test(normalized)) {
            throw new Error(`Unsafe parent traversal path in archive ${archivePath}: ${entry}`);
        }
    }
}

async function listArchiveEntries(archivePath) {
    if (archivePath.endsWith(".zip")) {
        const result = await runCommand("unzip", ["-Z1", archivePath]);
        return result.stdout.split(/\r?\n/).filter(Boolean);
    }
    const result = await runCommand("tar", tarArchiveArgs("list", archivePath));
    return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function extractArchive(archivePath, destination) {
    await ensureDir(destination);
    if (archivePath.endsWith(".zip")) {
        await runCommand("unzip", ["-oq", archivePath, "-d", destination]);
        return;
    }
    await runCommand("tar", [...tarArchiveArgs("extract", archivePath), "-C", destination]);
}

function tarArchiveArgs(action, archivePath) {
    const mode = action === "list" ? "-t" : "-x";
    const lowerPath = archivePath.toLowerCase();
    if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz")) return [`${mode}zf`, archivePath];
    if (lowerPath.endsWith(".tar.xz") || lowerPath.endsWith(".txz")) return [`${mode}Jf`, archivePath];
    if (lowerPath.endsWith(".tar.bz2") || lowerPath.endsWith(".tbz2")) return [`${mode}jf`, archivePath];
    return [`${mode}f`, archivePath];
}

async function refreshArchiveExtraction(archivePath, extractDir) {
    validateArchiveEntries(await listArchiveEntries(archivePath), archivePath);
    const tempExtractDir = extractDir + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.rm(tempExtractDir, { recursive: true, force: true });
    await extractArchive(archivePath, tempExtractDir);
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.rename(tempExtractDir, extractDir);
}

async function findFile(rootDir, matcher) {
    if (!fileExistsSync(rootDir)) return null;
    const queue = [rootDir];
    while (queue.length) {
        const current = queue.shift();
        const entries = await fsp.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (matcher(fullPath)) return fullPath;
        }
    }
    return null;
}

function resolveXmrigAsset(release) {
    const platform = process.platform;
    const arch = process.arch;
    const candidates = release.assets || [];

    function pick(predicate) {
        return candidates.find(predicate) || null;
    }

    if (platform === "linux" && arch === "x64") {
        return pick((asset) => asset.name.includes("lin64-compat")) ||
            pick((asset) => asset.name.includes("lin64.tar.gz"));
    }
    if (platform === "darwin" && arch === "arm64") {
        return pick((asset) => asset.name.includes("mac64"));
    }
    if (platform === "darwin" && arch === "x64") {
        return pick((asset) => asset.name.includes("mac-intel")) ||
            pick((asset) => asset.name.includes("mac64"));
    }
    if (platform === "win32" && arch === "x64") {
        return pick((asset) => asset.name.includes("win64.zip"));
    }

    return null;
}

function resolveSrbMinerAsset(release) {
    const platform = process.platform;
    const arch = process.arch;
    const candidates = release.assets || [];

    function pick(predicate) {
        return candidates.find(predicate) || null;
    }

    if (platform === "linux" && arch === "x64") {
        return pick((asset) => /^SRBMiner-Multi-.*-Linux\.tar\.(gz|xz)$/i.test(asset.name));
    }
    if (platform === "win32" && arch === "x64") {
        return pick((asset) => /^SRBMiner-Multi-.*-win64\.zip$/i.test(asset.name));
    }

    return null;
}

function resolveMoMinerAsset(release) {
    const platform = process.platform;
    const arch = process.arch;
    const candidates = release.assets || [];

    if (platform !== "linux" || arch !== "x64") return null;

    return candidates.find((asset) => {
        const name = String(asset.name || "");
        return /mominer/i.test(name) && /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(name);
    }) || candidates.find((asset) => /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(String(asset.name || ""))) || null;
}

function assertTrustedDownloadUrl(asset, expectedPrefix) {
    if (!asset || typeof asset.browser_download_url !== "string") {
        throw new Error("Release asset is missing browser_download_url");
    }
    if (!asset.browser_download_url.startsWith(expectedPrefix)) {
        throw new Error(`Unsafe release download URL for ${asset.name}: ${asset.browser_download_url}`);
    }
}

async function ensureXmrigBinary(config, logger) {
    if (!commandExists("tar")) {
        throw new Error("Missing required archive tool: tar");
    }
    if (process.platform === "win32" && !commandExists("unzip")) {
        throw new Error("Missing required archive tool: unzip");
    }

    const release = await fetchJson(XMRIG_RELEASE_API);
    const asset = resolveXmrigAsset(release);
    if (!asset) {
        throw new Error(`No MoneroOcean xmrig asset is available for ${process.platform}/${process.arch}`);
    }

    const versionDir = path.join(config.cacheDir, "xmrig-mo", release.tag_name);
    const archivePath = path.join(versionDir, asset.name);
    const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(/(\.tar\.gz|\.zip)$/i, "")));
    const binaryName = process.platform === "win32" ? "xmrig.exe" : "xmrig";
    const binaryPath = await findFile(extractDir, (candidate) => path.basename(candidate) === binaryName);

    if (binaryPath) {
        logger.event("miner.binary.cached", {
            miner: "xmrig-mo",
            release: release.tag_name,
            asset: asset.name,
            binaryPath
        });
        return {
            binaryPath,
            source: "cache",
            release,
            asset
        };
    }

    await ensureDir(versionDir);
    logger.event("miner.binary.download.start", {
        miner: "xmrig-mo",
        release: release.tag_name,
        asset: asset.name,
        url: asset.browser_download_url
    });

    if (!fileExistsSync(archivePath)) {
        await downloadToFile(asset.browser_download_url, archivePath);
    }

    await refreshArchiveExtraction(archivePath, extractDir);

    const extractedBinaryPath = await findFile(extractDir, (candidate) => path.basename(candidate) === binaryName);
    if (!extractedBinaryPath) {
        throw new Error(`Could not find ${binaryName} after extracting ${asset.name}`);
    }
    if (process.platform !== "win32") {
        await fsp.chmod(extractedBinaryPath, 0o755);
    }

    logger.event("miner.binary.ready", {
        miner: "xmrig-mo",
        release: release.tag_name,
        asset: asset.name,
        binaryPath: extractedBinaryPath
    });

    return {
        binaryPath: extractedBinaryPath,
        source: "download",
        release,
        asset
    };
}

async function ensureSrbMinerBinary(config, logger) {
    if (!commandExists("tar")) {
        throw new Error("Missing required archive tool: tar");
    }
    if (process.platform === "win32" && !commandExists("unzip")) {
        throw new Error("Missing required archive tool: unzip");
    }

    const release = await fetchJson(SRBMINER_RELEASE_API);
    const asset = resolveSrbMinerAsset(release);
    if (!asset) {
        throw new Error(`No SRBMiner-Multi asset is available for ${process.platform}/${process.arch}`);
    }
    assertTrustedDownloadUrl(asset, SRBMINER_DOWNLOAD_PREFIX);

    const versionDir = path.join(config.cacheDir, "srbminer-multi", release.tag_name);
    const archivePath = path.join(versionDir, asset.name);
    const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(/(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2|\.zip)$/i, "")));
    const binaryName = process.platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI";
    const binaryPath = await findFile(extractDir, (candidate) => path.basename(candidate) === binaryName);

    if (binaryPath) {
        logger.event("miner.binary.cached", {
            miner: "srbminer-multi",
            release: release.tag_name,
            asset: asset.name,
            binaryPath
        });
        return {
            binaryPath,
            source: "cache",
            release,
            asset
        };
    }

    await ensureDir(versionDir);
    logger.event("miner.binary.download.start", {
        miner: "srbminer-multi",
        release: release.tag_name,
        asset: asset.name,
        url: asset.browser_download_url
    });

    if (!fileExistsSync(archivePath)) {
        await downloadToFile(asset.browser_download_url, archivePath);
    }

    await refreshArchiveExtraction(archivePath, extractDir);

    const extractedBinaryPath = await findFile(extractDir, (candidate) => path.basename(candidate) === binaryName);
    if (!extractedBinaryPath) {
        throw new Error(`Could not find ${binaryName} after extracting ${asset.name}`);
    }
    if (process.platform !== "win32") {
        await fsp.chmod(extractedBinaryPath, 0o755);
    }

    logger.event("miner.binary.ready", {
        miner: "srbminer-multi",
        release: release.tag_name,
        asset: asset.name,
        binaryPath: extractedBinaryPath
    });

    return {
        binaryPath: extractedBinaryPath,
        source: "download",
        release,
        asset
    };
}

async function ensureMoMinerRoot(config, logger) {
    if (!commandExists("tar")) {
        throw new Error("Missing required archive tool: tar");
    }

    const release = await fetchJson(MOMINER_RELEASE_API);
    const asset = resolveMoMinerAsset(release);
    if (!asset) {
        throw new Error(`No MoMiner Linux x64 archive asset is available in ${release.tag_name || "latest release"}`);
    }
    assertTrustedDownloadUrl(asset, MOMINER_DOWNLOAD_PREFIX);

    const versionDir = path.join(config.cacheDir, "mominer", release.tag_name);
    const archivePath = path.join(versionDir, asset.name);
    const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(/(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2)$/i, "")));
    const scriptPath = await findFile(extractDir, (candidate) => path.basename(candidate) === "mominer.js");

    if (scriptPath) {
        logger.event("miner.binary.cached", {
            miner: "mominer",
            release: release.tag_name,
            asset: asset.name,
            rootDir: path.dirname(scriptPath)
        });
        return {
            rootDir: path.dirname(scriptPath),
            scriptPath,
            source: "cache",
            release,
            asset
        };
    }

    await ensureDir(versionDir);
    logger.event("miner.binary.download.start", {
        miner: "mominer",
        release: release.tag_name,
        asset: asset.name,
        url: asset.browser_download_url
    });

    if (!fileExistsSync(archivePath)) {
        await downloadToFile(asset.browser_download_url, archivePath);
    }

    await refreshArchiveExtraction(archivePath, extractDir);

    const extractedScriptPath = await findFile(extractDir, (candidate) => path.basename(candidate) === "mominer.js");
    if (!extractedScriptPath) {
        throw new Error(`Could not find mominer.js after extracting ${asset.name}`);
    }

    logger.event("miner.binary.ready", {
        miner: "mominer",
        release: release.tag_name,
        asset: asset.name,
        rootDir: path.dirname(extractedScriptPath)
    });

    return {
        rootDir: path.dirname(extractedScriptPath),
        scriptPath: extractedScriptPath,
        source: "download",
        release,
        asset
    };
}

function parseDiffToken(token) {
    if (!token) return null;
    const match = String(token).trim().match(/^([0-9]+(?:\.[0-9]+)?)([kmgthp]?)(?:\+)?$/i);
    if (!match) return null;

    const suffix = match[2].toLowerCase();
    const scale = {
        "": 1,
        k: 1e3,
        m: 1e6,
        g: 1e9,
        t: 1e12,
        p: 1e15,
        h: 1e2
    };

    return Number(match[1]) * (scale[suffix] || 1);
}

function parseHashrateToken(token) {
    if (!token || /^n\/a$/i.test(token)) return null;
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
}

function createXmrigParser() {
    return function parseXmrigLine(line, metrics) {
        const cleanLine = stripAnsi(line);
        let matched = false;

        if (/\bnew job from\b/i.test(cleanLine)) {
            metrics.connected = true;
            metrics.jobReceived = true;
            metrics.connectedAtMs = metrics.connectedAtMs || Date.now();
            metrics.jobAtMs = metrics.jobAtMs || Date.now();

            const algoMatch = cleanLine.match(/\balgo\s+([^\s]+)/i);
            if (algoMatch) metrics.reportedAlgorithm = algoMatch[1];
            const diffMatch = cleanLine.match(/\bdiff\s+([^\s]+)/i);
            if (diffMatch) {
                const diff = parseDiffToken(diffMatch[1]);
                if (diff !== null) metrics.assignedDifficulties.push(diff);
            }
            matched = true;
        }

        if (/\buse pool\b/i.test(cleanLine) || /\bconnected to\b/i.test(cleanLine)) {
            metrics.connected = true;
            metrics.connectedAtMs = metrics.connectedAtMs || Date.now();
            matched = true;
        }

        if (/\baccepted\b/i.test(cleanLine)) {
            metrics.acceptedShares += 1;
            metrics.firstAcceptedAtMs = metrics.firstAcceptedAtMs || Date.now();
            const latencyMatch = cleanLine.match(/\((\d+(?:\.\d+)?)\s*ms\)/i);
            if (latencyMatch) {
                const latency = Number(latencyMatch[1]);
                if (Number.isFinite(latency)) metrics.latenciesMs.push(latency);
            }
            matched = true;
        }

        if (/\brejected\b/i.test(cleanLine)) {
            metrics.rejectedShares += 1;
            metrics.lastErrorLine = cleanLine;
            matched = true;
        }

        if (/\binvalid\b/i.test(cleanLine) && /\bshare\b/i.test(cleanLine)) {
            metrics.invalidShares += 1;
            metrics.lastErrorLine = cleanLine;
            matched = true;
        }

        if (/\b(no active pools|connect error|connection refused|net error|read error|TLS|SSL|failed to resolve|retry in|job timeout)\b/i.test(cleanLine)) {
            metrics.lastErrorLine = cleanLine;
            if (/\bretry in\b/i.test(cleanLine)) metrics.retriesObserved += 1;
            matched = true;
        }

        if (/\b(connection closed|disconnect|retry in|reconnect)\b/i.test(cleanLine)) {
            metrics.disconnects += 1;
            matched = true;
        }

        const speedMatch = cleanLine.match(/\bspeed\s+10s\/60s\/15m\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+H\/s(?:\s+max\s+([^\s]+))?/i);
        if (speedMatch) {
            metrics.hashrate = {
                tenSeconds: parseHashrateToken(speedMatch[1]),
                sixtySeconds: parseHashrateToken(speedMatch[2]),
                fifteenMinutes: parseHashrateToken(speedMatch[3]),
                max: parseHashrateToken(speedMatch[4])
            };
            matched = true;
        }

        return matched;
    };
}

function createSrbMinerParser() {
    return function parseSrbMinerLine(line, metrics) {
        const cleanLine = stripAnsi(line);
        let matched = false;

        if (/\b(connected|logged in|authorized|subscribed|set difficulty)\b/i.test(cleanLine)) {
            metrics.connected = true;
            metrics.connectedAtMs = metrics.connectedAtMs || Date.now();
            matched = true;
        }

        if (/\b(new job|job received|job from|set difficulty|difficulty)\b/i.test(cleanLine) && !/\b(no job|job timeout)\b/i.test(cleanLine)) {
            metrics.jobReceived = true;
            metrics.jobAtMs = metrics.jobAtMs || Date.now();
            const algoMatch = cleanLine.match(/\balgo(?:rithm)?\s+([^\s,]+)/i);
            if (algoMatch) metrics.reportedAlgorithm = algoMatch[1];
            const diffMatch = cleanLine.match(/\bdiff(?:iculty)?\s+([^\s,]+)/i);
            if (diffMatch) {
                const diff = parseDiffToken(diffMatch[1]);
                if (diff !== null) metrics.assignedDifficulties.push(diff);
            }
            matched = true;
        }

        if (/\b(share|result)\s+accepted\b|\baccepted\s+(share|result)\b/i.test(cleanLine)) {
            metrics.acceptedShares += 1;
            metrics.firstAcceptedAtMs = metrics.firstAcceptedAtMs || Date.now();
            matched = true;
        }

        if (/\b(share|result)\s+rejected\b|\brejected\s+(share|result)\b/i.test(cleanLine)) {
            metrics.rejectedShares += 1;
            metrics.lastErrorLine = cleanLine;
            matched = true;
        }

        if (/\binvalid\b/i.test(cleanLine) && /\bshare\b/i.test(cleanLine)) {
            metrics.invalidShares += 1;
            metrics.lastErrorLine = cleanLine;
            matched = true;
        }

        if (/\b(no active pools|connect error|connection refused|socket error|network error|failed to resolve|retry|job timeout)\b/i.test(cleanLine)) {
            metrics.lastErrorLine = cleanLine;
            if (/\bretry\b/i.test(cleanLine)) metrics.retriesObserved += 1;
            matched = true;
        }

        if (/\b(disconnect|connection closed|reconnect)\b/i.test(cleanLine)) {
            metrics.disconnects += 1;
            matched = true;
        }

        const speedMatch = cleanLine.match(/\b([0-9]+(?:\.[0-9]+)?)\s*([kmg]?h\/s)\b/i);
        if (speedMatch) {
            const value = Number(speedMatch[1]);
            const unit = speedMatch[2].toLowerCase();
            const scale = unit.startsWith("g") ? 1e9 : (unit.startsWith("m") ? 1e6 : (unit.startsWith("k") ? 1e3 : 1));
            metrics.hashrate = {
                tenSeconds: Number.isFinite(value) ? value * scale : null,
                sixtySeconds: null,
                fifteenMinutes: null,
                max: null
            };
            matched = true;
        }

        return matched;
    };
}

function createMoMinerParser() {
    return function parseMoMinerLine(line, metrics) {
        const cleanLine = stripAnsi(line);
        let matched = false;

        if (/\bConnecting to\b.*\bpool\b|\bConnected to\b/i.test(cleanLine)) {
            metrics.connected = true;
            metrics.connectedAtMs = metrics.connectedAtMs || Date.now();
            matched = true;
        }

        const jobMatch = cleanLine.match(/\bGot new\s+([^\s]+)\s+algo job\b/i);
        if (jobMatch) {
            metrics.connected = true;
            metrics.jobReceived = true;
            metrics.connectedAtMs = metrics.connectedAtMs || Date.now();
            metrics.jobAtMs = metrics.jobAtMs || Date.now();
            metrics.reportedAlgorithm = jobMatch[1];
            const diffMatch = cleanLine.match(/\bwith\s+([^\s]+)\s+diff\b/i);
            if (diffMatch) {
                const diff = parseDiffToken(diffMatch[1]);
                if (diff !== null) metrics.assignedDifficulties.push(diff);
            }
            matched = true;
        }

        if (/\bShare accepted by the pool\b/i.test(cleanLine)) {
            metrics.acceptedShares += 1;
            metrics.firstAcceptedAtMs = metrics.firstAcceptedAtMs || Date.now();
            matched = true;
        }

        if (/\b(Share rejected|rejected by the pool)\b/i.test(cleanLine)) {
            metrics.rejectedShares += 1;
            metrics.lastErrorLine = cleanLine;
            matched = true;
        }

        if (/\b(ERROR|invalid|failed|timeout|disconnected|connection refused)\b/i.test(cleanLine)) {
            metrics.lastErrorLine = cleanLine;
            if (/\b(disconnected|reconnect)\b/i.test(cleanLine)) metrics.disconnects += 1;
            matched = true;
        }

        const speedMatch = cleanLine.match(/\bAlgo\s+([^\s]+).*?\bhashrate:\s+([0-9]+(?:\.[0-9]+)?)\s+H\/s/i);
        if (speedMatch) {
            metrics.reportedAlgorithm = speedMatch[1];
            metrics.hashrate = {
                tenSeconds: Number(speedMatch[2]),
                sixtySeconds: null,
                fifteenMinutes: null,
                max: null
            };
            matched = true;
        }

        return matched;
    };
}

function buildXmrigMiner(binaryPath) {
    const parser = createXmrigParser();

    return {
        name: "xmrig-mo",
        binaryPath,
        algorithms: new Set(XMRIG_CPU_ALGOS),
        buildArgs(context) {
            const args = [
                "-c", context.configPath,
                "-o", `${context.host}:${context.port}`,
                "-u", context.walletWithDifficulty,
                "-p", context.password,
                "--rig-id", context.worker,
                "-t", String(context.threads),
                "--cpu-priority", "0",
                "--donate-level", "0",
                "--bench-algo-time", "0",
                "--print-time", "1",
                "--tls",
                "--keepalive"
            ];

            if (!context.tls) {
                const tlsIndex = args.indexOf("--tls");
                if (tlsIndex !== -1) args.splice(tlsIndex, 1);
            }

            return args;
        },
        parser,
        style: "xmrig"
    };
}

function buildSrbMiner(binaryPath) {
    const parser = createSrbMinerParser();

    return {
        name: "srbminer-multi",
        binaryPath,
        algorithms: new Set(Object.keys(SRBMINER_INTEL_ALGORITHM_MAP)),
        buildArgs(context) {
            const args = [
                "--algorithm", SRBMINER_INTEL_ALGORITHM_MAP[context.algorithm] || context.algorithm,
                "--disable-cpu",
                "--disable-gpu-amd",
                "--disable-gpu-nvidia",
                "--pool", `${context.host}:${context.port}`,
                "--wallet", context.walletWithDifficulty,
                "--password", context.password,
                "--worker", context.worker,
                "--tls", context.tls ? "true" : "false",
                "--gpu-id", context.srbMinerGpuId,
                "--api-enable",
                "--api-port", String(context.srbMinerApiPort),
                "--api-rig-name", context.worker,
                "--keepalive", "true",
                "--max-no-share-sent", String(Math.ceil(context.timeoutMs / 1000)),
                "--give-up-limit", "1"
            ];

            if (SRBMINER_NICEHASH_STRATUM_ALGOS.has(context.algorithm)) {
                args.push(
                    "--esm", "2",
                    "--nicehash", "true"
                );
            }

            return args;
        },
        parser,
        style: "srbminer"
    };
}

function buildMoMinerNoBenchConfig(context) {
    const algoParams = {};
    for (const algorithm of MOMINER_NO_BENCH_ALGOS) {
        let dev = "cpu";
        if (algorithm === "c29" || algorithm === "cn/gpu") dev = context.moMinerC29Device;
        algoParams[algorithm] = {
            dev,
            perf: 1
        };
    }

    return {
        pool_time: {
            stats: 30,
            connect_throttle: 5,
            primary_reconnect: 30,
            first_job_wait: Math.max(5, Math.ceil(context.timeoutMs / 3000)),
            close_wait: 2,
            donate_interval: 86400,
            donate_length: 0,
            keepalive: 30
        },
        pools: [{
            url: context.host,
            port: context.port,
            is_tls: context.tls,
            is_nicehash: false,
            is_keepalive: true,
            login: context.walletWithDifficulty,
            pass: context.password
        }],
        pool_ids: {
            primary: 0,
            donate: null
        },
        algo_params: algoParams,
        default_msrs: {},
        log_level: 0
    };
}

function buildMoMiner(rootDir, scriptPath) {
    const parser = createMoMinerParser();
    const dockerfilePath = path.join(rootDir, "deploy.dockerfile");
    const useDocker = process.platform === "linux" && commandExists("docker") && fileExistsSync(dockerfilePath);

    return {
        name: "mominer",
        binaryPath: useDocker ? "docker" : process.execPath,
        rootDir,
        scriptPath,
        dockerfilePath,
        dockerImage: DEFAULT_MOMINER_DOCKER_IMAGE,
        useDocker,
        dockerPrepared: false,
        algorithms: new Set(MOMINER_INTEL_ALGOS),
        async prepare(context) {
            const configPath = path.join(context.attemptDir, "mominer-config.json");
            await writeJson(configPath, buildMoMinerNoBenchConfig(context));
            context.moMinerConfigPath = configPath;
            context.moMinerConfigArg = configPath;

            if (!this.useDocker) return;
            if (!this.dockerPrepared) {
                await runCommand("docker", ["build", "-q", "-t", this.dockerImage, "-f", this.dockerfilePath, this.rootDir], {
                    cwd: this.rootDir
                });
                this.dockerPrepared = true;
            }
            context.moMinerContainerName = sanitizeName(`mominer-${context.worker}`).slice(0, 63);
            context.moMinerConfigArg = "/root/mominer-live/mominer-config.json";
        },
        buildArgs(context) {
            const mominerArgs = [
                "mine",
                context.moMinerConfigArg
            ];

            if (this.useDocker) {
                context.moMinerContainerName = context.moMinerContainerName || sanitizeName(`mominer-${context.worker}`).slice(0, 63);
                return [
                    "run",
                    "--privileged",
                    "--rm",
                    "--name", context.moMinerContainerName,
                    "--hostname", context.moMinerContainerName,
                    "--mount", `type=bind,source=${this.rootDir},target=/root/mominer`,
                    "--mount", `type=bind,source=${context.attemptDir},target=/root/mominer-live`,
                    "--workdir", "/root/mominer",
                    this.dockerImage,
                    "node",
                    "mominer.js",
                    ...mominerArgs
                ];
            }

            return [
                this.scriptPath,
                ...mominerArgs
            ];
        },
        buildEnv(context) {
            if (this.useDocker) return {};
            const libraryPaths = [
                this.rootDir,
                path.join(this.rootDir, "lib"),
                path.join(this.rootDir, "lib64"),
                process.env.LD_LIBRARY_PATH || ""
            ].filter(Boolean);

            return {
                LD_LIBRARY_PATH: libraryPaths.join(":"),
                MOMINER_CONFIG_DIR: context.attemptDir
            };
        },
        async cleanup(context) {
            if (!this.useDocker || !context.moMinerContainerName) return;
            await runCommand("docker", ["rm", "-f", context.moMinerContainerName]).catch(() => {});
        },
        parser,
        style: "mominer"
    };
}

async function writeXmrigSeedConfig(configPath, algorithm) {
    const algoPerf = {
        ...XMRIG_ALGO_PERF_SEED,
        [algorithm]: XMRIG_ALGO_PERF_SEED[algorithm] || 1
    };

    await writeJson(configPath, {
        autosave: false,
        "algo-min-time": 0,
        "algo-perf": algoPerf
    });
}

function getActiveAlgorithms(logger) {
    const selected = EMBEDDED_ACTIVE_ALGOS
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.algorithm.localeCompare(right.algorithm));

    logger.event("algorithms.discovered", {
        source: "embedded",
        algorithms: selected.map((entry) => entry.algorithm)
    });

    return selected;
}

function buildCoveragePlan(algorithms, miners, options) {
    const config = options || {};
    return algorithms.flatMap((definition) => {
        const miner = miners.find((candidate) => candidate.algorithms.has(definition.algorithm));
        const suppressProtocolProbe = config.suppressGpuProtocolProbes && GPU_PROTOCOL_PROBE_ALGOS.has(definition.algorithm);

        return [{
            algorithm: definition.algorithm,
            miner: miner || null,
            protocolProbe: miner || suppressProtocolProbe ? "" : (definition.protocolProbe || ""),
            successCriterion: definition && definition.successCriterion ? definition.successCriterion : "accepted-share"
        }];
    });
}

function makeWorkerName(config, algorithm, side, attempt) {
    const base = [
        "itest",
        sanitizeName(config.runId).slice(0, 12),
        shortAlgoName(algorithm).slice(0, 16),
        side,
        String(attempt)
    ].filter(Boolean).join("-");

    return base.substring(0, 63);
}

async function stopProcess(processHandle) {
    if (!processHandle || processHandle.exitCode !== null || processHandle.killed) return;

    processHandle.kill("SIGINT");
    await sleep(1000);
    if (processHandle.exitCode !== null) return;
    processHandle.kill("SIGTERM");
    await sleep(1500);
    if (processHandle.exitCode !== null) return;
    processHandle.kill("SIGKILL");
}

function summarizeLatency(latenciesMs) {
    if (!latenciesMs.length) return null;
    const min = Math.min(...latenciesMs);
    const max = Math.max(...latenciesMs);
    const sum = latenciesMs.reduce((total, current) => total + current, 0);

    return {
        min,
        max,
        avg: sum / latenciesMs.length,
        count: latenciesMs.length,
        last: latenciesMs[latenciesMs.length - 1]
    };
}

function hasMetSuccessCriterion(plan, metrics) {
    if (plan.successCriterion === "job") {
        return metrics.jobReceived && metrics.rejectedShares === 0 && metrics.invalidShares === 0;
    }

    return metrics.acceptedShares >= metrics.targetAcceptedShares && metrics.rejectedShares === 0 && metrics.invalidShares === 0;
}

function determineFailureReason(plan, metrics) {
    if (hasMetSuccessCriterion(plan, metrics)) {
        return "";
    }
    if (!metrics.connected) return "connection-failure";
    if (!metrics.jobReceived) return "job-timeout";
    if (metrics.invalidShares > 0) return "invalid-share";
    if (metrics.rejectedShares > 0) return "rejected-share";
    return "no-accepted-share";
}

function createProbeSocket(config, target) {
    if (config.tls) {
        return tls.connect({
            host: target.host,
            port: target.port,
            servername: target.host,
            rejectUnauthorized: false
        });
    }

    return net.createConnection({
        host: target.host,
        port: target.port
    });
}

function writeProtocolLine(stream, direction, message) {
    stream.write(`${direction} ${message}\n`);
}

function sendProtocolJson(socket, stream, payload) {
    const line = JSON.stringify(payload);
    writeProtocolLine(stream, ">", line);
    socket.write(line + "\n");
}

function parseProtocolLines(buffer, chunk) {
    const combined = buffer + chunk;
    const lines = combined.split(/\r?\n/);
    return {
        lines: lines.slice(0, -1).filter(Boolean),
        buffer: lines[lines.length - 1] || ""
    };
}

function buildBadEthSubmitParams(user, jobId) {
    return [
        user,
        jobId,
        "0x" + crypto.randomBytes(8).toString("hex"),
        "0x" + "11".repeat(32),
        "0x" + "22".repeat(32)
    ];
}

function buildBadLoginSubmitParams(loginId, jobId) {
    return {
        id: loginId || "",
        job_id: jobId || "",
        nonce: crypto.randomBytes(4).toString("hex"),
        result: "00".repeat(32)
    };
}

function hasGpuProtocolProbe(plan) {
    return !plan.miner && !!plan.protocolProbe;
}

function createProtocolProbeSession(config, run, plan, target, attempt) {
    const attemptDir = path.join(
        run.runDir,
        "attempts",
        `${shortAlgoName(plan.algorithm)}-protocol-${target.name}-attempt-${attempt}`
    );

    const rawStdoutPath = path.join(attemptDir, "stdout.log");
    const rawStderrPath = path.join(attemptDir, "stderr.log");
    const startedAtMs = Date.now();
    const worker = makeWorkerName(config, plan.algorithm, target.name, attempt);
    const user = `${config.wallet}.${worker}`;
    const password = `x~${plan.algorithm}`;
    const metrics = {
        connected: false,
        authorized: false,
        jobReceived: false,
        badShareRejected: false,
        badShareAccepted: false,
        rejectionError: "",
        jobId: "",
        loginId: "",
        lastError: ""
    };

    let lineBuffer = "";
    let nextId = 1;
    let authId = 0;
    let submitId = 0;
    let finished = false;
    let ready = false;
    let socketError = null;
    let socket = null;
    let stdoutStream = null;
    let stderrStream = null;
    let resolveReady = null;
    let resolveDone = null;
    const readyPromise = new Promise((resolve) => {
        resolveReady = resolve;
    });
    const donePromise = new Promise((resolve) => {
        resolveDone = resolve;
    });

    function markReady() {
        if (ready) return;
        ready = true;
        resolveReady();
    }

    function markFinished() {
        if (finished) return;
        finished = true;
        markReady();
        resolveDone();
    }

    function submitBadShare() {
        if (submitId || !metrics.jobId) return;
        submitId = nextId++;
        if (plan.protocolProbe === "login-bad-share") {
            sendProtocolJson(socket, stdoutStream, {
                id: submitId,
                method: "submit",
                params: buildBadLoginSubmitParams(metrics.loginId, metrics.jobId)
            });
            return;
        }

        sendProtocolJson(socket, stdoutStream, {
            id: submitId,
            method: "mining.submit",
            params: buildBadEthSubmitParams(user, metrics.jobId)
        });
    }

    function handleMessage(message) {
        run.logger.event("probe.message", {
            algorithm: plan.algorithm,
            protocolProbe: plan.protocolProbe,
            target: target.name,
            attempt,
            message
        });

        if (message.id === authId) {
            if (message.error) {
                metrics.lastError = message.error.message || JSON.stringify(message.error);
                markFinished();
                return;
            }
            metrics.authorized = true;
            const loginResult = message.result || {};
            metrics.loginId = loginResult.id || metrics.loginId;
            if (loginResult.job && loginResult.job.job_id) {
                metrics.jobReceived = true;
                metrics.jobId = loginResult.job.job_id;
                markReady();
            }
        }

        if (message.method === "mining.notify") {
            metrics.jobReceived = true;
            metrics.jobId = Array.isArray(message.params) ? String(message.params[0] || "") : "";
            markReady();
        }

        if (message.method === "job" && message.params && message.params.job_id) {
            metrics.jobReceived = true;
            metrics.jobId = message.params.job_id;
            markReady();
        }

        if (message.id === submitId) {
            if (message.error || message.result === false) {
                metrics.badShareRejected = true;
                metrics.rejectionError = message.error ? (message.error.message || JSON.stringify(message.error)) : "false";
                markFinished();
                return;
            }
            if (message.result === true || (message.result && message.result.status === "OK")) {
                metrics.badShareAccepted = true;
                markFinished();
            }
        }
    }

    async function start() {
        await ensureDir(attemptDir);
        stdoutStream = fs.createWriteStream(rawStdoutPath, { flags: "a" });
        stderrStream = fs.createWriteStream(rawStderrPath, { flags: "a" });
        socket = createProbeSocket(config, target);
        socket.setEncoding("utf8");
        socket.setTimeout(config.timeoutMs);

        if (config.emitStartLines) {
            emitProgress(`[${formatReadableTime(new Date())}] start ${plan.algorithm} protocol probe on ${target.host}:${target.port}`);
        }

        run.logger.event("probe.start", {
            algorithm: plan.algorithm,
            protocolProbe: plan.protocolProbe,
            target: target.name,
            host: target.host,
            port: target.port,
            attempt
        });

        socket.once(config.tls ? "secureConnect" : "connect", () => {
            metrics.connected = true;
            if (plan.protocolProbe === "login-bad-share") {
                authId = nextId++;
                sendProtocolJson(socket, stdoutStream, {
                    id: authId,
                    jsonrpc: "2.0",
                    method: "login",
                    params: {
                        login: config.wallet,
                        pass: password,
                        agent: "nodejs-pool-live-probe/1.0",
                        rigid: worker
                    }
                });
                return;
            }

            sendProtocolJson(socket, stdoutStream, {
                id: nextId++,
                method: "mining.subscribe",
                params: []
            });
            authId = nextId++;
            setTimeout(() => {
                if (socket.destroyed || finished) return;
                sendProtocolJson(socket, stdoutStream, {
                    id: authId,
                    method: "mining.authorize",
                    params: [user, password]
                });
            }, 250);
        });

        socket.on("data", (chunk) => {
            const parsed = parseProtocolLines(lineBuffer, chunk);
            lineBuffer = parsed.buffer;
            for (const line of parsed.lines) {
                writeProtocolLine(stdoutStream, "<", line);
                let message;
                try {
                    message = JSON.parse(line);
                } catch (error) {
                    metrics.lastError = `invalid-json: ${error.message}`;
                    continue;
                }
                handleMessage(message);
            }
        });

        socket.once("timeout", () => {
            metrics.lastError = "timeout";
            markFinished();
        });
        socket.once("error", (error) => {
            socketError = error;
            metrics.lastError = error.message;
            if (stderrStream) stderrStream.write(error.stack || error.message);
            markFinished();
        });
    }

    function submit() {
        submitBadShare();
        if (!submitId && !metrics.jobId) {
            metrics.lastError = "no-job";
            markFinished();
        }
    }

    async function stop() {
        if (socket) socket.destroy();
        await Promise.all([
            stdoutStream ? new Promise((resolve) => stdoutStream.end(resolve)) : undefined,
            stderrStream ? new Promise((resolve) => stderrStream.end(resolve)) : undefined
        ].filter(Boolean));
    }

    function result() {
        let failureReason = "";
        if (socketError || !metrics.connected) failureReason = "connection-failure";
        else if (!metrics.authorized) failureReason = "authorization-failure";
        else if (!metrics.jobReceived) failureReason = "job-timeout";
        else if (metrics.badShareAccepted) failureReason = "bad-share-accepted";
        else if (!metrics.badShareRejected) failureReason = "rejection-timeout";

        return {
            algorithm: plan.algorithm,
            miner: "protocol-probe",
            target: target.name,
            host: target.host,
            port: target.port,
            attempt,
            success: failureReason === "",
            failureReason,
            protocolProbe: plan.protocolProbe,
            connected: metrics.connected,
            jobReceived: metrics.jobReceived,
            acceptedShares: 0,
            rejectedShares: metrics.badShareRejected ? 1 : 0,
            invalidShares: 0,
            disconnects: 0,
            retriesObserved: 0,
            assignedDifficulty: null,
            assignedDifficulties: [],
            reportedAlgorithm: plan.algorithm,
            hashrate: null,
            latency: null,
            durationMs: Math.max(0, Date.now() - startedAtMs),
            exitCode: null,
            exitSignal: null,
            error: metrics.rejectionError || metrics.lastError,
            rawStdoutPath,
            rawStderrPath
        };
    }

    return {
        plan,
        target,
        start,
        submit,
        stop,
        result,
        readyPromise,
        donePromise,
        isFinished() {
            return finished;
        }
    };
}

async function runMinerAttempt(config, run, plan, target, attempt) {
    const attemptDir = path.join(
        run.runDir,
        "attempts",
        `${shortAlgoName(plan.algorithm)}-${sanitizeName(plan.miner.name)}-${target.name}-attempt-${attempt}`
    );

    await ensureDir(attemptDir);

    const worker = makeWorkerName(config, plan.algorithm, target.name, attempt);
    const password = `x~${plan.algorithm}`;
    const walletWithDifficulty = config.wallet;
    const xmrigConfigPath = path.join(attemptDir, "xmrig-config.json");
    const rawStdoutPath = path.join(attemptDir, "stdout.log");
    const rawStderrPath = path.join(attemptDir, "stderr.log");
    const stdoutStream = fs.createWriteStream(rawStdoutPath, { flags: "a" });
    const stderrStream = fs.createWriteStream(rawStderrPath, { flags: "a" });
    const metrics = {
        targetAcceptedShares: config.targetAcceptedShares,
        startedAtMs: Date.now(),
        connected: false,
        jobReceived: false,
        acceptedShares: 0,
        rejectedShares: 0,
        invalidShares: 0,
        disconnects: 0,
        retriesObserved: 0,
        assignedDifficulties: [],
        latenciesMs: [],
        connectedAtMs: 0,
        jobAtMs: 0,
        firstAcceptedAtMs: 0,
        hashrate: null,
        reportedAlgorithm: null,
        lastErrorLine: ""
    };
    const context = {
        attemptDir,
        configPath: xmrigConfigPath,
        host: target.host,
        port: target.port,
        wallet: config.wallet,
        walletWithDifficulty,
        password,
        worker,
        algorithm: plan.algorithm,
        threads: config.threads,
        tls: config.tls,
        timeoutMs: config.timeoutMs,
        srbMinerGpuId: config.srbMinerGpuId,
        srbMinerApiPort: config.srbMinerApiPort + attempt - 1,
        moMinerC29Device: config.moMinerC29Device
    };
    await writeXmrigSeedConfig(xmrigConfigPath, plan.algorithm);
    let args;
    try {
        if (typeof plan.miner.prepare === "function") {
            await plan.miner.prepare(context);
        }
        args = plan.miner.buildArgs(context);
    } catch (error) {
        await Promise.all([
            new Promise((resolve) => stdoutStream.end(resolve)),
            new Promise((resolve) => stderrStream.end(resolve))
        ]);
        return {
            algorithm: plan.algorithm,
            miner: plan.miner.name,
            target: target.name,
            host: target.host,
            port: target.port,
            attempt,
            success: false,
            failureReason: "launch-failure",
            error: error.message,
            rawStdoutPath,
            rawStderrPath
        };
    }
    if (config.emitStartLines) {
        emitProgress(`[${formatReadableTime(new Date())}] start ${plan.algorithm} algo on ${target.host}:${target.port}`);
    }

    run.logger.event("attempt.start", {
        algorithm: plan.algorithm,
        miner: plan.miner.name,
        target: target.name,
        host: target.host,
        port: target.port,
        attempt,
        args
    });

    let processError = null;
    const child = spawn(plan.miner.binaryPath, args, {
        cwd: attemptDir,
        env: {
            ...process.env,
            ...(typeof plan.miner.buildEnv === "function" ? plan.miner.buildEnv(context) : {}),
            NO_COLOR: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const childClosed = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
    });

    child.on("error", (error) => {
        processError = error;
    });

    const interfaces = [
        { name: "stdout", stream: child.stdout, sink: stdoutStream },
        { name: "stderr", stream: child.stderr, sink: stderrStream }
    ];

    for (const entry of interfaces) {
        const rl = readline.createInterface({ input: entry.stream });
        rl.on("line", (line) => {
            const cleanLine = stripAnsi(line);
            entry.sink.write(cleanLine + "\n");
            plan.miner.parser(cleanLine, metrics);
            run.logger.event("attempt.output", {
                algorithm: plan.algorithm,
                miner: plan.miner.name,
                target: target.name,
                attempt,
                stream: entry.name,
                line: cleanLine
            });
        });
    }

    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
        if (processError) break;
        if (hasMetSuccessCriterion(plan, metrics)) break;
        if (child.exitCode !== null) break;
        await sleep(1000);
    }

    await stopProcess(child);

    const exitState = await childClosed;
    if (typeof plan.miner.cleanup === "function") {
        await plan.miner.cleanup(context);
    }
    await Promise.all([
        new Promise((resolve) => stdoutStream.end(resolve)),
        new Promise((resolve) => stderrStream.end(resolve))
    ]);

    if (processError) {
        return {
            algorithm: plan.algorithm,
            miner: plan.miner.name,
            target: target.name,
            host: target.host,
            port: target.port,
            attempt,
            success: false,
            failureReason: "launch-failure",
            error: processError.message,
            rawStdoutPath,
            rawStderrPath
        };
    }

    const failureReason = determineFailureReason(plan, metrics);
    const success = failureReason === "";
    const endAtMs = metrics.firstAcceptedAtMs || metrics.jobAtMs || Date.now();
    const durationMs = Math.max(0, endAtMs - metrics.startedAtMs);

    return {
        algorithm: plan.algorithm,
        miner: plan.miner.name,
        target: target.name,
        host: target.host,
        port: target.port,
        attempt,
        success,
        failureReason,
        connected: metrics.connected,
        jobReceived: metrics.jobReceived,
        acceptedShares: metrics.acceptedShares,
        rejectedShares: metrics.rejectedShares,
        invalidShares: metrics.invalidShares,
        disconnects: metrics.disconnects,
        retriesObserved: metrics.retriesObserved,
        assignedDifficulty: metrics.assignedDifficulties.length ? metrics.assignedDifficulties[metrics.assignedDifficulties.length - 1] : null,
        assignedDifficulties: metrics.assignedDifficulties,
        reportedAlgorithm: metrics.reportedAlgorithm,
        hashrate: metrics.hashrate,
        latency: summarizeLatency(metrics.latenciesMs),
        durationMs,
        exitCode: exitState.code,
        exitSignal: exitState.signal,
        error: metrics.lastErrorLine,
        rawStdoutPath,
        rawStderrPath
    };
}

async function executeScenario(run, plan, target) {
    const chosen = plan.miner
        ? await runMinerAttempt(run.config, run, plan, target, 1)
        : await runProtocolProbeAttempt(run.config, run, plan, target, 1);
    run.logger.event("attempt.finish", chosen);
    return {
        ...chosen,
        attempts: [chosen]
    };
}

async function runProtocolProbeAttempt(config, run, plan, target, attempt) {
    const session = createProtocolProbeSession(config, run, plan, target, attempt);
    await session.start();
    await waitWithTimeout(session.readyPromise, config.timeoutMs);
    if (!session.isFinished()) {
        session.submit();
        await waitWithTimeout(session.donePromise, config.timeoutMs);
    }
    await session.stop();
    return session.result();
}

async function executeProtocolProbeBatch(run, plans, target) {
    const sessions = plans.map((plan) => createProtocolProbeSession(run.config, run, plan, target, 1));

    await Promise.all(sessions.map((session) => session.start()));
    await waitWithTimeout(Promise.all(sessions.map((session) => session.readyPromise)), run.config.timeoutMs);

    for (const session of sessions) {
        if (!session.isFinished()) session.submit();
    }

    await waitWithTimeout(Promise.all(sessions.map((session) => session.donePromise)), run.config.timeoutMs);

    await Promise.all(sessions.map((session) => session.stop()));

    return sessions.map((session) => {
        const chosen = session.result();
        run.logger.event("attempt.finish", chosen);
        return {
            ...chosen,
            attempts: [chosen]
        };
    });
}

function buildSummary(run, coveredResults) {
    const { config, miners, algorithms, coveragePlan, unsupportedAlgorithms } = run;
    const comparisons = coveredResults.map((result) => ({
        algorithm: result.algorithm,
        miner: result.miner,
        target: result.target
    }));
    const failures = comparisons.filter((entry) => !entry.target.success);

    let exitCode = 0;
    if (failures.length || unsupportedAlgorithms.length > 0) exitCode = 1;

    return {
        runId: config.runId,
        generatedAt: new Date().toISOString(),
        algorithms: algorithms.map((entry) => entry.algorithm),
        configuration: {
            targetHost: config.targetHost,
            targetPort: config.targetPort,
            tls: config.tls,
            difficulty: config.difficulty,
            threads: config.threads,
            wallet: config.wallet,
            timeoutMs: config.timeoutMs
        },
        hardware: run.hardware || {},
        minerInventory: miners.map((miner) => ({
            name: miner.name,
            binaryPath: miner.scriptPath || miner.binaryPath,
            algorithms: Array.from(miner.algorithms).sort()
        })),
        coveragePlan: coveragePlan.map((entry) => ({
            algorithm: entry.algorithm,
            covered: !!entry.miner || !!entry.protocolProbe,
            miner: entry.miner ? entry.miner.name : null,
            protocolProbe: entry.protocolProbe || null
        })),
        results: comparisons,
        unsupportedAlgorithms,
        failureCount: failures.length,
        unsupportedAlgorithmCount: unsupportedAlgorithms.length,
        exitCode
    };
}

function formatSummary(summary) {
    const lines = [];
    lines.push(`runId: ${summary.runId}`);
    const algorithms = Array.isArray(summary.algorithms) ? summary.algorithms : [];
    const unsupportedAlgorithms = Array.isArray(summary.unsupportedAlgorithms) ? summary.unsupportedAlgorithms : [];
    lines.push(`active algorithms (${algorithms.length}): ${algorithms.join(", ") || "none"}`);
    lines.push(`unsupported algorithms (${summary.unsupportedAlgorithmCount || 0}): ${unsupportedAlgorithms.map((entry) => entry.algorithm).join(", ") || "none"}`);
    lines.push(`target failures: ${summary.failureCount}`);
    lines.push(`logs: ${summary.logDir || "see summary.json"}`);

    if (summary.error) lines.push(`error: ${summary.error}`);

    return lines.join("\n");
}

async function formatFailureDetails(summary) {
    if (!summary || !Array.isArray(summary.results)) return "";

    const sections = [];
    for (const result of summary.results) {
        if (result.target && result.target.success) continue;
        const stdoutText = await readTextFileIfExists(result.target.rawStdoutPath);
        const stderrText = await readTextFileIfExists(result.target.rawStderrPath);
        sections.push([
            `[${result.algorithm}]`,
            stdoutText ? stdoutText.trimEnd() : "<stdout empty>",
            stderrText ? `stderr:\n${stderrText.trimEnd()}` : ""
        ].filter(Boolean).join("\n"));
    }

    return sections.join("\n\n");
}

function printSummary(summary) {
    process.stdout.write(formatSummary(summary) + "\n");
}

async function createLivePoolRun(input) {
    const config = buildConfig(input);
    const runDir = path.join(config.logDir, config.runId);

    await ensureDir(runDir);
    await ensureDir(path.join(runDir, "attempts"));

    const logger = createLogger(runDir);
    logger.event("suite.start", {
        runId: config.runId,
        targetHost: config.targetHost
    });

    try {
        const intelGpuDetected = detectIntelGpu();
        const algorithms = getActiveAlgorithms(logger);
        const activeAlgorithmSet = new Set(algorithms.map((entry) => entry.algorithm));
        const xmrig = await ensureXmrigBinary(config, logger);
        const miners = [];

        logger.event("hardware.intel-gpu.detect", { detected: intelGpuDetected });

        if (intelGpuDetected && Object.keys(SRBMINER_INTEL_ALGORITHM_MAP).some((algorithm) => activeAlgorithmSet.has(algorithm))) {
            const srbminer = await ensureSrbMinerBinary(config, logger);
            miners.push(buildSrbMiner(srbminer.binaryPath));
        }

        if (intelGpuDetected && Array.from(MOMINER_INTEL_ALGOS).some((algorithm) => activeAlgorithmSet.has(algorithm))) {
            const mominer = await ensureMoMinerRoot(config, logger);
            miners.push(buildMoMiner(mominer.rootDir, mominer.scriptPath));
        }

        miners.push(buildXmrigMiner(xmrig.binaryPath));

        const coveragePlan = buildCoveragePlan(algorithms, miners, {
            suppressGpuProtocolProbes: intelGpuDetected
        });
        const unsupportedAlgorithms = coveragePlan
            .filter((entry) => !entry.miner && !entry.protocolProbe)
            .map((entry) => ({
                algorithm: entry.algorithm,
                reason: intelGpuDetected && GPU_PROTOCOL_PROBE_ALGOS.has(entry.algorithm)
                    ? "no-real-intel-gpu-miner"
                    : "no-suitable-miner"
            }));
        const minerPlans = coveragePlan.filter((entry) => entry.miner);
        const protocolProbePlans = coveragePlan.filter((entry) => !entry.miner && entry.protocolProbe);

        return {
            config,
            runDir,
            logger,
            hardware: {
                intelGpuDetected
            },
            miners,
            algorithms,
            coveragePlan,
            unsupportedAlgorithms,
            coveredPlans: [...minerPlans, ...protocolProbePlans]
        };
    } catch (error) {
        await logger.close();
        throw error;
    }
}

async function finalizeLivePoolRun(run, coveredResults, error) {
    const { config, runDir, logger, unsupportedAlgorithms } = run;

    try {
        let summary;
        if (error) {
            logger.event("suite.error", {
                runId: config.runId,
                message: error.message,
                stack: error.stack
            });
            summary = {
                runId: config.runId,
                generatedAt: new Date().toISOString(),
                logDir: runDir,
                error: error.message,
                failureCount: 1,
                unsupportedAlgorithmCount: unsupportedAlgorithms.length,
                exitCode: 1
            };
        } else {
            summary = buildSummary(run, coveredResults);
            summary.logDir = runDir;
            logger.event("suite.finish", {
                runId: config.runId,
                exitCode: summary.exitCode,
                unsupportedAlgorithmCount: summary.unsupportedAlgorithmCount,
                failureCount: summary.failureCount
            });
        }

        await writeJson(path.join(runDir, "summary.json"), summary);
        return summary;
    } finally {
        await logger.close();
    }
}

async function isDefaultTargetReachable() {
    return await isTcpReachable(DEFAULT_TARGET_HOST, DEFAULT_TARGET_PORT);
}

function buildConfig(input) {
    const options = input || {};
    return {
        runId: options.runId || buildRunId(),
        cacheDir: DEFAULT_CACHE_DIR,
        logDir: DEFAULT_LOG_DIR,
        wallet: DEFAULT_WALLET,
        targetHost: options.targetHost || DEFAULT_TARGET_HOST,
        targetPort: DEFAULT_TARGET_PORT,
        tls: true,
        difficulty: DEFAULT_DIFFICULTY,
        threads: DEFAULT_THREADS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        targetAcceptedShares: DEFAULT_TARGET_ACCEPTED_SHARES,
        srbMinerGpuId: DEFAULT_SRBMINER_GPU_ID,
        srbMinerApiPort: DEFAULT_SRBMINER_API_PORT,
        moMinerC29Device: DEFAULT_MOMINER_C29_DEVICE,
        targetName: "target",
        emitStartLines: true
    };
}

function parseCliOptions(argv) {
    const parsed = parseArgv(argv, {});
    return { help: !!(parsed.help || parsed.h), targetHost: parsed["target-host"] };
}

function renderCliHelp() {
    return [
        "Usage: node ./tests/pool-live.js [options]",
        "",
        "Runs live miner checks against a target pool.",
        "",
        "Options:",
        "  --target-host <host>        Pool under test host or IP",
        "  --help                      Show this message"
    ].join("\n");
}

async function runLivePoolSuite(input) {
    let run = null;
    const coveredResults = [];
    try {
        run = await createLivePoolRun(input);
        for (const plan of run.coveredPlans.filter((entry) => !hasGpuProtocolProbe(entry))) {
            const target = await executeScenario(run, plan, {
                name: run.config.targetName,
                host: run.config.targetHost,
                port: run.config.targetPort
            });
            coveredResults.push({
                algorithm: plan.algorithm,
                miner: plan.miner ? plan.miner.name : "protocol-probe",
                target
            });
        }
        const protocolPlans = run.coveredPlans.filter(hasGpuProtocolProbe);
        if (protocolPlans.length) {
            const targets = await executeProtocolProbeBatch(run, protocolPlans, {
                name: run.config.targetName,
                host: run.config.targetHost,
                port: run.config.targetPort
            });
            for (const target of targets) {
                coveredResults.push({
                    algorithm: target.algorithm,
                    miner: target.miner,
                    target
                });
            }
        }
        return await finalizeLivePoolRun(run, coveredResults, null);
    } catch (error) {
        if (!run) {
            const config = buildConfig(input);
            const runDir = path.join(config.logDir, config.runId);
            await ensureDir(runDir);
            await writeJson(path.join(runDir, "summary.json"), {
                runId: config.runId,
                generatedAt: new Date().toISOString(),
                logDir: runDir,
                error: error.message,
                failureCount: 1,
                unsupportedAlgorithmCount: 0,
                exitCode: 1
            });
            return {
                runId: config.runId,
                generatedAt: new Date().toISOString(),
                logDir: runDir,
                error: error.message,
                failureCount: 1,
                unsupportedAlgorithmCount: 0,
                exitCode: 1
            };
        }

        return await finalizeLivePoolRun(run, coveredResults, error);
    }
}

async function runFromCli(argv) {
    const options = parseCliOptions(argv);
    if (options.help) {
        process.stdout.write(renderCliHelp() + "\n");
        return 0;
    }

    const summary = await runLivePoolSuite(options);
    printSummary(summary);
    const failureDetails = await formatFailureDetails(summary);
    if (failureDetails) process.stdout.write("\n" + failureDetails + "\n");
    return summary.exitCode;
}

module.exports = {
    DEFAULT_TARGET_HOST,
    DEFAULT_WALLET,
    EMBEDDED_ACTIVE_ALGOS,
    buildConfig,
    createLivePoolRun,
    executeScenario,
    executeProtocolProbeBatch,
    finalizeLivePoolRun,
    formatReadableTime,
    formatFailureDetails,
    formatSummary,
    isDefaultTargetReachable,
    isTcpReachable,
    renderCliHelp,
    runFromCli,
    runLivePoolSuite
};

if (require.main === module) {
    runFromCli(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
