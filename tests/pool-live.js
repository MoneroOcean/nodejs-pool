"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const tls = require("node:tls");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

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
const ARCHIVE_PATH_ESCAPE_PATTERN = /(^|\/)\.\.(\/|$)/;
const USER_AGENT = "nodejs-pool-live-tests";
const DIFF_SCALE = { "": 1, h: 1e2, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 };
const HASHRATE_SCALE = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 };
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

const PROTOCOL_PROBES = {
    "eth-bad-share": {
        authorize({ user, password }, id) {
            return { id, method: "mining.authorize", params: [user, password] };
        },
        submit({ user }, metrics, id) {
            return { id, method: "mining.submit", params: buildBadEthSubmitParams(user, metrics.jobId) };
        },
        useSubscribe: true
    },
    "login-bad-share": {
        authorize({ config, password, worker }, id) {
            return {
                id,
                jsonrpc: "2.0",
                method: "login",
                params: {
                    login: config.wallet,
                    pass: password,
                    agent: "nodejs-pool-live-probe/1.0",
                    rigid: worker
                }
            };
        },
        submit(_context, metrics, id) {
            return { id, method: "submit", params: buildBadLoginSubmitParams(metrics.loginId, metrics.jobId) };
        },
        useSubscribe: false
    }
};

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

async function downloadToFile(url, destination, headers) {
    const response = await request(url, headers);
    if (!response.body) throw new Error(`Download body missing for ${url}`);

    await ensureDir(path.dirname(destination));
    const tmpPath = `${destination}.part`;
    const output = fs.createWriteStream(tmpPath, { mode: 0o644 });

    try {
        await pipeline(Readable.fromWeb(response.body), output);
        await fsp.rename(tmpPath, destination);
    } catch (error) {
        await fsp.rm(tmpPath, { force: true });
        throw error;
    }
}

async function runCommand(command, args, options = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
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

function ensureArchiveTools(includeUnzipOnWindows) {
    if (!commandExists("tar")) throw new Error("Missing required archive tool: tar");
    if (includeUnzipOnWindows && process.platform === "win32" && !commandExists("unzip")) {
        throw new Error("Missing required archive tool: unzip");
    }
}

function tarArchiveArgs(action, archivePath) {
    const mode = action === "list" ? "-t" : "-x";
    const lowerPath = archivePath.toLowerCase();
    if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz")) return [`${mode}zf`, archivePath];
    if (lowerPath.endsWith(".tar.xz") || lowerPath.endsWith(".txz")) return [`${mode}Jf`, archivePath];
    if (lowerPath.endsWith(".tar.bz2") || lowerPath.endsWith(".tbz2")) return [`${mode}jf`, archivePath];
    return [`${mode}f`, archivePath];
}

function validateArchiveEntries(entries, archivePath) {
    for (const entry of entries) {
        const normalized = entry.replace(/\\/g, "/");
        if (!normalized || normalized.endsWith("/")) continue;
        if (normalized.startsWith("/")) throw new Error(`Unsafe absolute path in archive ${archivePath}: ${entry}`);
        if (ARCHIVE_PATH_ESCAPE_PATTERN.test(normalized)) {
            throw new Error(`Unsafe parent traversal path in archive ${archivePath}: ${entry}`);
        }
    }
}

async function listArchiveEntries(archivePath) {
    if (archivePath.endsWith(".zip")) {
        return (await runCommand("unzip", ["-Z1", archivePath])).stdout.split(/\r?\n/).filter(Boolean);
    }
    return (await runCommand("tar", tarArchiveArgs("list", archivePath))).stdout.split(/\r?\n/).filter(Boolean);
}

async function extractArchive(archivePath, destination) {
    await ensureDir(destination);
    if (archivePath.endsWith(".zip")) {
        await runCommand("unzip", ["-oq", archivePath, "-d", destination]);
        return;
    }
    await runCommand("tar", [...tarArchiveArgs("extract", archivePath), "-C", destination]);
}

async function refreshArchiveExtraction(archivePath, extractDir) {
    validateArchiveEntries(await listArchiveEntries(archivePath), archivePath);
    const tempExtractDir = `${extractDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    await fsp.rm(tempExtractDir, { recursive: true, force: true });
    await extractArchive(archivePath, tempExtractDir);
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.rename(tempExtractDir, extractDir);
}

async function findFile(rootDir, matcher) {
    if (!fileExistsSync(rootDir)) return null;
    const queue = [rootDir];
    while (queue.length) {
        const current = queue.pop();
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

const findNamedFile = async (rootDir, basename) => await findFile(rootDir, (candidate) => path.basename(candidate) === basename);
function pickAsset(candidates, predicates) {
    for (const predicate of predicates) {
        const match = candidates.find(predicate);
        if (match) return match;
    }
    return null;
}

function resolveXmrigAsset(release) {
    const candidates = release.assets || [];
    if (process.platform === "linux" && process.arch === "x64") {
        return pickAsset(candidates, [
            (asset) => asset.name.includes("lin64-compat"),
            (asset) => asset.name.includes("lin64.tar.gz")
        ]);
    }
    if (process.platform === "darwin" && process.arch === "arm64") {
        return pickAsset(candidates, [(asset) => asset.name.includes("mac64")]);
    }
    if (process.platform === "darwin" && process.arch === "x64") {
        return pickAsset(candidates, [
            (asset) => asset.name.includes("mac-intel"),
            (asset) => asset.name.includes("mac64")
        ]);
    }
    if (process.platform === "win32" && process.arch === "x64") {
        return pickAsset(candidates, [(asset) => asset.name.includes("win64.zip")]);
    }
    return null;
}

function resolveSrbMinerAsset(release) {
    const candidates = release.assets || [];
    if (process.platform === "linux" && process.arch === "x64") {
        return pickAsset(candidates, [(asset) => /^SRBMiner-Multi-.*-Linux\.tar\.(gz|xz)$/i.test(asset.name)]);
    }
    if (process.platform === "win32" && process.arch === "x64") {
        return pickAsset(candidates, [(asset) => /^SRBMiner-Multi-.*-win64\.zip$/i.test(asset.name)]);
    }
    return null;
}

function resolveMoMinerAsset(release) {
    const candidates = release.assets || [];
    if (process.platform !== "linux" || process.arch !== "x64") return null;
    return pickAsset(candidates, [
        (asset) => /mominer/i.test(String(asset.name || "")) && /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(String(asset.name || "")),
        (asset) => /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(String(asset.name || ""))
    ]);
}

function assertTrustedDownloadUrl(asset, expectedPrefix) {
    if (!asset || typeof asset.browser_download_url !== "string") {
        throw new Error("Release asset is missing browser_download_url");
    }
    if (!asset.browser_download_url.startsWith(expectedPrefix)) {
        throw new Error(`Unsafe release download URL for ${asset.name}: ${asset.browser_download_url}`);
    }
}

async function ensureReleaseAsset(config, logger, spec) {
    ensureArchiveTools(spec.includeUnzipOnWindows);

    const release = await fetchJson(spec.releaseApi);
    const asset = spec.resolveAsset(release);
    if (!asset) throw new Error(spec.missingAsset(release));
    if (spec.downloadPrefix) assertTrustedDownloadUrl(asset, spec.downloadPrefix);

    const versionDir = path.join(config.cacheDir, spec.cacheKey, release.tag_name);
    const archivePath = path.join(versionDir, asset.name);
    const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(spec.archiveSuffixPattern, "")));
    const located = await spec.locate(extractDir);

    if (located) {
        logger.event("miner.binary.cached", spec.logPayload(located, release, asset));
        return spec.result(located, release, asset, "cache");
    }

    await ensureDir(versionDir);
    logger.event("miner.binary.download.start", {
        miner: spec.miner,
        release: release.tag_name,
        asset: asset.name,
        url: asset.browser_download_url
    });

    if (!fileExistsSync(archivePath)) {
        await downloadToFile(asset.browser_download_url, archivePath);
    }

    await refreshArchiveExtraction(archivePath, extractDir);
    const extracted = await spec.locate(extractDir);
    if (!extracted) throw new Error(spec.missingExtracted(asset));

    const chmodPath = spec.chmodPath ? spec.chmodPath(extracted) : "";
    if (chmodPath && process.platform !== "win32") {
        await fsp.chmod(chmodPath, 0o755);
    }

    logger.event("miner.binary.ready", spec.logPayload(extracted, release, asset));
    return spec.result(extracted, release, asset, "download");
}

async function ensureXmrigBinary(config, logger) {
    const binaryName = process.platform === "win32" ? "xmrig.exe" : "xmrig";
    return await ensureReleaseAsset(config, logger, {
        miner: "xmrig-mo",
        cacheKey: "xmrig-mo",
        releaseApi: XMRIG_RELEASE_API,
        resolveAsset: resolveXmrigAsset,
        archiveSuffixPattern: /(\.tar\.gz|\.zip)$/i,
        includeUnzipOnWindows: true,
        async locate(extractDir) {
            const binaryPath = await findNamedFile(extractDir, binaryName);
            return binaryPath ? { binaryPath } : null;
        },
        missingAsset() {
            return `No MoneroOcean xmrig asset is available for ${process.platform}/${process.arch}`;
        },
        missingExtracted(asset) {
            return `Could not find ${binaryName} after extracting ${asset.name}`;
        },
        chmodPath(located) {
            return located.binaryPath;
        },
        logPayload(located, release, asset) {
            return { miner: "xmrig-mo", release: release.tag_name, asset: asset.name, binaryPath: located.binaryPath };
        },
        result(located, release, asset, source) {
            return { ...located, source, release, asset };
        }
    });
}

async function ensureSrbMinerBinary(config, logger) {
    const binaryName = process.platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI";
    return await ensureReleaseAsset(config, logger, {
        miner: "srbminer-multi",
        cacheKey: "srbminer-multi",
        releaseApi: SRBMINER_RELEASE_API,
        resolveAsset: resolveSrbMinerAsset,
        archiveSuffixPattern: /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2|\.zip)$/i,
        downloadPrefix: SRBMINER_DOWNLOAD_PREFIX,
        includeUnzipOnWindows: true,
        async locate(extractDir) {
            const binaryPath = await findNamedFile(extractDir, binaryName);
            return binaryPath ? { binaryPath } : null;
        },
        missingAsset() {
            return `No SRBMiner-Multi asset is available for ${process.platform}/${process.arch}`;
        },
        missingExtracted(asset) {
            return `Could not find ${binaryName} after extracting ${asset.name}`;
        },
        chmodPath(located) {
            return located.binaryPath;
        },
        logPayload(located, release, asset) {
            return { miner: "srbminer-multi", release: release.tag_name, asset: asset.name, binaryPath: located.binaryPath };
        },
        result(located, release, asset, source) {
            return { ...located, source, release, asset };
        }
    });
}

async function ensureMoMinerRoot(config, logger) {
    return await ensureReleaseAsset(config, logger, {
        miner: "mominer",
        cacheKey: "mominer",
        releaseApi: MOMINER_RELEASE_API,
        resolveAsset: resolveMoMinerAsset,
        archiveSuffixPattern: /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2)$/i,
        downloadPrefix: MOMINER_DOWNLOAD_PREFIX,
        includeUnzipOnWindows: false,
        async locate(extractDir) {
            const scriptPath = await findNamedFile(extractDir, "mominer.js");
            return scriptPath ? { rootDir: path.dirname(scriptPath), scriptPath } : null;
        },
        missingAsset(release) {
            return `No MoMiner Linux x64 archive asset is available in ${release.tag_name || "latest release"}`;
        },
        missingExtracted(asset) {
            return `Could not find mominer.js after extracting ${asset.name}`;
        },
        logPayload(located, release, asset) {
            return { miner: "mominer", release: release.tag_name, asset: asset.name, rootDir: located.rootDir };
        },
        result(located, release, asset, source) {
            return { ...located, source, release, asset };
        }
    });
}

function parseDiffToken(token) {
    if (!token) return null;
    const match = String(token).trim().match(/^([0-9]+(?:\.[0-9]+)?)([kmgthp]?)(?:\+)?$/i);
    if (!match) return null;
    return Number(match[1]) * (DIFF_SCALE[match[2].toLowerCase()] || 1);
}

function parseHashrateToken(token) {
    if (!token || /^n\/a$/i.test(token)) return null;
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
}

const parseScaledHashrate = (value, unit) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric * (HASHRATE_SCALE[String(unit || "").trim().toLowerCase().replace(/h\/s$/, "")] || 1);
};
const markConnected = (metrics) => {
    metrics.connected = true;
    metrics.connectedAtMs = metrics.connectedAtMs || Date.now();
};

function markJob(metrics, algorithm, diffToken) {
    markConnected(metrics);
    metrics.jobReceived = true;
    metrics.jobAtMs = metrics.jobAtMs || Date.now();
    if (algorithm) metrics.reportedAlgorithm = algorithm;
    const diff = parseDiffToken(diffToken);
    if (diff !== null) metrics.assignedDifficulties.push(diff);
}

function recordAccepted(metrics, line, latencyPattern) {
    metrics.acceptedShares += 1;
    metrics.firstAcceptedAtMs = metrics.firstAcceptedAtMs || Date.now();
    if (!latencyPattern) return;
    const latency = Number(line.match(latencyPattern)?.[1]);
    if (Number.isFinite(latency)) metrics.latenciesMs.push(latency);
}

const recordRejected = (metrics, line) => {
    metrics.rejectedShares += 1;
    metrics.lastErrorLine = line;
};
const recordInvalid = (metrics, line) => {
    metrics.invalidShares += 1;
    metrics.lastErrorLine = line;
};
const recordError = (metrics, line, retryPattern) => {
    metrics.lastErrorLine = line;
    if (retryPattern && retryPattern.test(line)) metrics.retriesObserved += 1;
};
const recordDisconnect = (metrics) => {
    metrics.disconnects += 1;
};

function createMinerParser(spec) {
    return function parseMinerLine(line, metrics) {
        const cleanLine = stripAnsi(line);
        let matched = false;

        if (spec.connect && spec.connect.test(cleanLine)) {
            markConnected(metrics);
            matched = true;
        }

        if (spec.job && spec.job.test(cleanLine) && !(spec.jobExclude && spec.jobExclude.test(cleanLine))) {
            markJob(
                metrics,
                spec.extractAlgorithm ? spec.extractAlgorithm(cleanLine) : "",
                spec.extractDifficulty ? spec.extractDifficulty(cleanLine) : ""
            );
            matched = true;
        }

        if (spec.accepted && spec.accepted.test(cleanLine)) {
            recordAccepted(metrics, cleanLine, spec.acceptedLatency);
            matched = true;
        }

        if (spec.rejected && spec.rejected.test(cleanLine)) {
            recordRejected(metrics, cleanLine);
            matched = true;
        }

        if (spec.invalid && spec.invalid.test(cleanLine)) {
            recordInvalid(metrics, cleanLine);
            matched = true;
        }

        if (spec.error && spec.error.test(cleanLine)) {
            recordError(metrics, cleanLine, spec.retry);
            matched = true;
        }

        if (spec.disconnect && spec.disconnect.test(cleanLine)) {
            recordDisconnect(metrics);
            matched = true;
        }

        if (spec.hashrate) {
            const parsed = spec.hashrate(cleanLine);
            if (parsed) {
                if (parsed.reportedAlgorithm) metrics.reportedAlgorithm = parsed.reportedAlgorithm;
                metrics.hashrate = parsed.hashrate || parsed;
                matched = true;
            }
        }

        return matched;
    };
}

function parseXmrigHashrate(line) {
    const match = line.match(/\bspeed\s+10s\/60s\/15m\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+H\/s(?:\s+max\s+([^\s]+))?/i);
    if (!match) return null;
    return {
        tenSeconds: parseHashrateToken(match[1]),
        sixtySeconds: parseHashrateToken(match[2]),
        fifteenMinutes: parseHashrateToken(match[3]),
        max: parseHashrateToken(match[4])
    };
}

function parseSrbMinerHashrate(line) {
    const match = line.match(/\b([0-9]+(?:\.[0-9]+)?)\s*([kmg]?h\/s)\b/i);
    if (!match) return null;
    return {
        tenSeconds: parseScaledHashrate(match[1], match[2]),
        sixtySeconds: null,
        fifteenMinutes: null,
        max: null
    };
}

function parseMoMinerHashrate(line) {
    const match = line.match(/\bAlgo\s+([^\s]+).*?\bhashrate:\s+([0-9]+(?:\.[0-9]+)?)\s+H\/s/i);
    if (!match) return null;
    return {
        reportedAlgorithm: match[1],
        hashrate: {
            tenSeconds: Number(match[2]),
            sixtySeconds: null,
            fifteenMinutes: null,
            max: null
        }
    };
}

function createXmrigParser() {
    return createMinerParser({
        connect: /\buse pool\b|\bconnected to\b/i,
        job: /\bnew job from\b/i,
        extractAlgorithm: (line) => line.match(/\balgo\s+([^\s]+)/i)?.[1] || "",
        extractDifficulty: (line) => line.match(/\bdiff\s+([^\s]+)/i)?.[1] || "",
        accepted: /\baccepted\b/i,
        acceptedLatency: /\((\d+(?:\.\d+)?)\s*ms\)/i,
        rejected: /\brejected\b/i,
        invalid: /\binvalid\b.*\bshare\b|\bshare\b.*\binvalid\b/i,
        error: /\b(no active pools|connect error|connection refused|net error|read error|TLS|SSL|failed to resolve|retry in|job timeout)\b/i,
        retry: /\bretry in\b/i,
        disconnect: /\b(connection closed|disconnect|retry in|reconnect)\b/i,
        hashrate: parseXmrigHashrate
    });
}

function createSrbMinerParser() {
    return createMinerParser({
        connect: /\b(connected|logged in|authorized|subscribed|set difficulty)\b/i,
        job: /\b(new job|job received|job from|set difficulty|difficulty)\b/i,
        jobExclude: /\b(no job|job timeout)\b/i,
        extractAlgorithm: (line) => line.match(/\balgo(?:rithm)?\s+([^\s,]+)/i)?.[1] || "",
        extractDifficulty: (line) => line.match(/\bdiff(?:iculty)?\s+([^\s,]+)/i)?.[1] || "",
        accepted: /\b(share|result)\s+accepted\b|\baccepted\s+(share|result)\b/i,
        rejected: /\b(share|result)\s+rejected\b|\brejected\s+(share|result)\b/i,
        invalid: /\binvalid\b.*\bshare\b|\bshare\b.*\binvalid\b/i,
        error: /\b(no active pools|connect error|connection refused|socket error|network error|failed to resolve|retry|job timeout)\b/i,
        retry: /\bretry\b/i,
        disconnect: /\b(disconnect|connection closed|reconnect)\b/i,
        hashrate: parseSrbMinerHashrate
    });
}

function createMoMinerParser() {
    return createMinerParser({
        connect: /\bConnecting to\b.*\bpool\b|\bConnected to\b/i,
        job: /\bGot new\s+[^\s]+\s+algo job\b/i,
        extractAlgorithm: (line) => line.match(/\bGot new\s+([^\s]+)\s+algo job\b/i)?.[1] || "",
        extractDifficulty: (line) => line.match(/\bwith\s+([^\s]+)\s+diff\b/i)?.[1] || "",
        accepted: /\bShare accepted by the pool\b/i,
        rejected: /\b(Share rejected|rejected by the pool)\b/i,
        error: /\b(ERROR|invalid|failed|timeout|disconnected|connection refused)\b/i,
        disconnect: /\b(disconnected|reconnect)\b/i,
        hashrate: parseMoMinerHashrate
    });
}

function buildXmrigMiner(binaryPath) {
    return {
        name: "xmrig-mo",
        binaryPath,
        algorithms: new Set(XMRIG_CPU_ALGOS),
        parser: createXmrigParser(),
        style: "xmrig",
        buildArgs(context) {
            return [
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
                ...(context.tls ? ["--tls"] : []),
                "--keepalive"
            ];
        }
    };
}

function buildSrbMiner(binaryPath) {
    return {
        name: "srbminer-multi",
        binaryPath,
        algorithms: new Set(Object.keys(SRBMINER_INTEL_ALGORITHM_MAP)),
        parser: createSrbMinerParser(),
        style: "srbminer",
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
                args.push("--esm", "2", "--nicehash", "true");
            }

            return args;
        }
    };
}

function buildMoMinerNoBenchConfig(context) {
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
        pool_ids: { primary: 0, donate: null },
        algo_params: Object.fromEntries(MOMINER_NO_BENCH_ALGOS.map((algorithm) => [algorithm, {
            dev: algorithm === "c29" || algorithm === "cn/gpu" ? context.moMinerC29Device : "cpu",
            perf: 1
        }])),
        default_msrs: {},
        log_level: 0
    };
}

function buildMoMiner(rootDir, scriptPath) {
    const dockerfilePath = path.join(rootDir, "deploy.dockerfile");
    const useDocker = process.platform === "linux" && commandExists("docker") && fileExistsSync(dockerfilePath);

    return {
        name: "mominer",
        binaryPath: useDocker ? "docker" : process.execPath,
        rootDir,
        scriptPath,
        dockerfilePath,
        dockerImage: DEFAULT_MOMINER_DOCKER_IMAGE,
        dockerPrepared: false,
        useDocker,
        algorithms: new Set(MOMINER_INTEL_ALGOS),
        parser: createMoMinerParser(),
        style: "mominer",
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
            const args = ["mine", context.moMinerConfigArg];
            if (!this.useDocker) return [this.scriptPath, ...args];

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
                ...args
            ];
        },
        buildEnv(context) {
            if (this.useDocker) return {};
            return {
                LD_LIBRARY_PATH: [
                    this.rootDir,
                    path.join(this.rootDir, "lib"),
                    path.join(this.rootDir, "lib64"),
                    process.env.LD_LIBRARY_PATH || ""
                ].filter(Boolean).join(":"),
                MOMINER_CONFIG_DIR: context.attemptDir
            };
        },
        async cleanup(context) {
            if (!this.useDocker || !context.moMinerContainerName) return;
            await runCommand("docker", ["rm", "-f", context.moMinerContainerName]).catch(() => {});
        }
    };
}

async function writeXmrigSeedConfig(configPath, algorithm) {
    await writeJson(configPath, {
        autosave: false,
        "algo-min-time": 0,
        "algo-perf": { ...XMRIG_ALGO_PERF_SEED, [algorithm]: XMRIG_ALGO_PERF_SEED[algorithm] || 1 }
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

function buildCoveragePlan(algorithms, miners, options = {}) {
    return algorithms.flatMap((definition) => {
        const miner = miners.find((candidate) => candidate.algorithms.has(definition.algorithm)) || null;
        const suppressProbe = options.suppressGpuProtocolProbes && GPU_PROTOCOL_PROBE_ALGOS.has(definition.algorithm);
        return [{
            algorithm: definition.algorithm,
            miner,
            protocolProbe: miner || suppressProbe ? "" : (definition.protocolProbe || ""),
            successCriterion: definition.successCriterion || "accepted-share"
        }];
    });
}

function makeWorkerName(config, algorithm, side, attempt) {
    return ["itest", sanitizeName(config.runId).slice(0, 12), shortAlgoName(algorithm).slice(0, 16), side, String(attempt)]
        .filter(Boolean)
        .join("-")
        .slice(0, 63);
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
    return { min, max, avg: sum / latenciesMs.length, count: latenciesMs.length, last: latenciesMs[latenciesMs.length - 1] };
}

function hasMetSuccessCriterion(plan, metrics) {
    if (plan.successCriterion === "job") {
        return metrics.jobReceived && metrics.rejectedShares === 0 && metrics.invalidShares === 0;
    }
    return metrics.acceptedShares >= metrics.targetAcceptedShares && metrics.rejectedShares === 0 && metrics.invalidShares === 0;
}

function determineFailureReason(plan, metrics) {
    if (hasMetSuccessCriterion(plan, metrics)) return "";
    if (!metrics.connected) return "connection-failure";
    if (!metrics.jobReceived) return "job-timeout";
    if (metrics.invalidShares > 0) return "invalid-share";
    if (metrics.rejectedShares > 0) return "rejected-share";
    return "no-accepted-share";
}

function createProbeSocket(config, target) {
    return config.tls
        ? tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false })
        : net.createConnection({ host: target.host, port: target.port });
}

function writeProtocolLine(stream, direction, message) {
    stream.write(`${direction} ${message}\n`);
}

function sendProtocolJson(socket, stream, payload) {
    const line = JSON.stringify(payload);
    writeProtocolLine(stream, ">", line);
    socket.write(`${line}\n`);
}

function parseProtocolLines(buffer, chunk) {
    const lines = `${buffer}${chunk}`.split(/\r?\n/);
    return { lines: lines.slice(0, -1).filter(Boolean), buffer: lines[lines.length - 1] || "" };
}

function buildBadEthSubmitParams(user, jobId) {
    return [
        user,
        jobId,
        `0x${crypto.randomBytes(8).toString("hex")}`,
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`
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

const hasGpuProtocolProbe = (plan) => !plan.miner && !!plan.protocolProbe;
function createDeferred() {
    let resolve;
    return { promise: new Promise((innerResolve) => { resolve = innerResolve; }), resolve };
}

function createAttemptFiles(run, plan, target, attempt, protocolProbe) {
    const attemptId = protocolProbe
        ? `${shortAlgoName(plan.algorithm)}-protocol-${target.name}-attempt-${attempt}`
        : `${shortAlgoName(plan.algorithm)}-${sanitizeName(plan.miner.name)}-${target.name}-attempt-${attempt}`;

    return {
        attemptDir: path.join(run.runDir, "attempts", attemptId),
        rawStdoutPath: path.join(run.runDir, "attempts", attemptId, "stdout.log"),
        rawStderrPath: path.join(run.runDir, "attempts", attemptId, "stderr.log"),
        worker: makeWorkerName(run.config, plan.algorithm, target.name, attempt),
        password: `x~${plan.algorithm}`,
        startedAtMs: Date.now()
    };
}

function createAttemptBase(plan, target, attempt, files, minerName) {
    return {
        algorithm: plan.algorithm,
        miner: minerName,
        target: target.name,
        host: target.host,
        port: target.port,
        attempt,
        rawStdoutPath: files.rawStdoutPath,
        rawStderrPath: files.rawStderrPath
    };
}

function createMinerMetrics(targetAcceptedShares) {
    return {
        targetAcceptedShares,
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
}

function openLogStreams(stdoutPath, stderrPath) {
    return { stdout: fs.createWriteStream(stdoutPath, { flags: "a" }), stderr: fs.createWriteStream(stderrPath, { flags: "a" }) };
}
const closeStreams = async (...streams) => await Promise.all(streams.filter(Boolean).map((stream) => new Promise((resolve) => stream.end(resolve))));

function attachAttemptStream(run, plan, target, attempt, name, stream, sink, onLine) {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
        const cleanLine = stripAnsi(line);
        sink.write(`${cleanLine}\n`);
        onLine(cleanLine);
        run.logger.event("attempt.output", {
            algorithm: plan.algorithm,
            miner: plan.miner.name,
            target: target.name,
            attempt,
            stream: name,
            line: cleanLine
        });
    });
    return rl;
}

async function waitForMinerAttempt(child, metrics, plan, timeoutMs, getProcessError) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (getProcessError()) break;
        if (hasMetSuccessCriterion(plan, metrics)) break;
        if (child.exitCode !== null) break;
        await sleep(1000);
    }
}

function createProtocolProbeSession(config, run, plan, target, attempt) {
    const files = createAttemptFiles(run, plan, target, attempt, true);
    const probe = PROTOCOL_PROBES[plan.protocolProbe];
    const base = createAttemptBase(plan, target, attempt, files, "protocol-probe");
    const readyDeferred = createDeferred();
    const doneDeferred = createDeferred();
    const context = {
        config,
        user: `${config.wallet}.${files.worker}`,
        password: files.password,
        worker: files.worker
    };
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

    let socket = null;
    let socketError = null;
    let stdoutStream = null;
    let stderrStream = null;
    let lineBuffer = "";
    let nextId = 1;
    let authId = 0;
    let submitId = 0;
    let ready = false;
    let finished = false;

    function markReady() {
        if (ready) return;
        ready = true;
        readyDeferred.resolve();
    }

    function markFinished() {
        if (finished) return;
        finished = true;
        markReady();
        doneDeferred.resolve();
    }

    function rememberJob(jobId) {
        if (!jobId) return;
        metrics.jobReceived = true;
        metrics.jobId = jobId;
        markReady();
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
            metrics.loginId = message.result?.id || metrics.loginId;
            rememberJob(message.result?.job?.job_id || "");
        }

        if (message.method === "mining.notify") {
            rememberJob(Array.isArray(message.params) ? String(message.params[0] || "") : "");
        }

        if (message.method === "job" && message.params?.job_id) {
            rememberJob(message.params.job_id);
        }

        if (message.id === submitId) {
            if (message.error || message.result === false) {
                metrics.badShareRejected = true;
                metrics.rejectionError = message.error ? (message.error.message || JSON.stringify(message.error)) : "false";
                markFinished();
                return;
            }
            if (message.result === true || message.result?.status === "OK") {
                metrics.badShareAccepted = true;
                markFinished();
            }
        }
    }

    return {
        plan,
        target,
        readyPromise: readyDeferred.promise,
        donePromise: doneDeferred.promise,
        isFinished() {
            return finished;
        },
        async start() {
            await ensureDir(files.attemptDir);
            ({ stdout: stdoutStream, stderr: stderrStream } = openLogStreams(files.rawStdoutPath, files.rawStderrPath));
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

                if (probe.useSubscribe) {
                    sendProtocolJson(socket, stdoutStream, { id: nextId++, method: "mining.subscribe", params: [] });
                    authId = nextId++;
                    setTimeout(() => {
                        if (!socket.destroyed && !finished) {
                            sendProtocolJson(socket, stdoutStream, probe.authorize(context, authId));
                        }
                    }, 250);
                    return;
                }

                authId = nextId++;
                sendProtocolJson(socket, stdoutStream, probe.authorize(context, authId));
            });

            socket.on("data", (chunk) => {
                const parsed = parseProtocolLines(lineBuffer, chunk);
                lineBuffer = parsed.buffer;
                for (const line of parsed.lines) {
                    writeProtocolLine(stdoutStream, "<", line);
                    try {
                        handleMessage(JSON.parse(line));
                    } catch (error) {
                        metrics.lastError = `invalid-json: ${error.message}`;
                    }
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
        },
        submit() {
            if (submitId || !metrics.jobId) {
                if (!metrics.jobId) {
                    metrics.lastError = "no-job";
                    markFinished();
                }
                return;
            }

            submitId = nextId++;
            sendProtocolJson(socket, stdoutStream, probe.submit(context, metrics, submitId));
        },
        async stop() {
            if (socket) socket.destroy();
            await closeStreams(stdoutStream, stderrStream);
        },
        result() {
            let failureReason = "";
            if (socketError || !metrics.connected) failureReason = "connection-failure";
            else if (!metrics.authorized) failureReason = "authorization-failure";
            else if (!metrics.jobReceived) failureReason = "job-timeout";
            else if (metrics.badShareAccepted) failureReason = "bad-share-accepted";
            else if (!metrics.badShareRejected) failureReason = "rejection-timeout";

            return {
                ...base,
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
                durationMs: Math.max(0, Date.now() - files.startedAtMs),
                exitCode: null,
                exitSignal: null,
                error: metrics.rejectionError || metrics.lastError
            };
        }
    };
}

async function runMinerAttempt(config, run, plan, target, attempt) {
    const files = createAttemptFiles(run, plan, target, attempt, false);
    const base = createAttemptBase(plan, target, attempt, files, plan.miner.name);

    await ensureDir(files.attemptDir);
    const streams = openLogStreams(files.rawStdoutPath, files.rawStderrPath);
    const metrics = createMinerMetrics(config.targetAcceptedShares);
    const context = {
        attemptDir: files.attemptDir,
        configPath: path.join(files.attemptDir, "xmrig-config.json"),
        host: target.host,
        port: target.port,
        wallet: config.wallet,
        walletWithDifficulty: config.wallet,
        password: files.password,
        worker: files.worker,
        algorithm: plan.algorithm,
        threads: config.threads,
        tls: config.tls,
        timeoutMs: config.timeoutMs,
        srbMinerGpuId: config.srbMinerGpuId,
        srbMinerApiPort: config.srbMinerApiPort + attempt - 1,
        moMinerC29Device: config.moMinerC29Device
    };

    await writeXmrigSeedConfig(context.configPath, plan.algorithm);

    let args = [];
    try {
        if (typeof plan.miner.prepare === "function") await plan.miner.prepare(context);
        args = plan.miner.buildArgs(context);
    } catch (error) {
        await closeStreams(streams.stdout, streams.stderr);
        return { ...base, success: false, failureReason: "launch-failure", error: error.message };
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
        cwd: files.attemptDir,
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

    attachAttemptStream(run, plan, target, attempt, "stdout", child.stdout, streams.stdout, (line) => {
        plan.miner.parser(line, metrics);
    });
    attachAttemptStream(run, plan, target, attempt, "stderr", child.stderr, streams.stderr, (line) => {
        plan.miner.parser(line, metrics);
    });

    await waitForMinerAttempt(child, metrics, plan, config.timeoutMs, () => processError);
    await stopProcess(child);

    const exitState = await childClosed;
    if (typeof plan.miner.cleanup === "function") {
        await plan.miner.cleanup(context);
    }

    await closeStreams(streams.stdout, streams.stderr);

    if (processError) {
        return { ...base, success: false, failureReason: "launch-failure", error: processError.message };
    }

    const failureReason = determineFailureReason(plan, metrics);
    const success = failureReason === "";
    const endAtMs = metrics.firstAcceptedAtMs || metrics.jobAtMs || Date.now();

    return {
        ...base,
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
        durationMs: Math.max(0, endAtMs - metrics.startedAtMs),
        exitCode: exitState.code,
        exitSignal: exitState.signal,
        error: metrics.lastErrorLine
    };
}

async function executeScenario(run, plan, target) {
    const chosen = plan.miner
        ? await runMinerAttempt(run.config, run, plan, target, 1)
        : await runProtocolProbeAttempt(run.config, run, plan, target, 1);

    run.logger.event("attempt.finish", chosen);
    return { ...chosen, attempts: [chosen] };
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
        return { ...chosen, attempts: [chosen] };
    });
}

function buildSummary(run, coveredResults) {
    const failures = coveredResults.filter((entry) => !entry.target.success);
    return {
        runId: run.config.runId,
        generatedAt: new Date().toISOString(),
        algorithms: run.algorithms.map((entry) => entry.algorithm),
        configuration: {
            targetHost: run.config.targetHost,
            targetPort: run.config.targetPort,
            tls: run.config.tls,
            difficulty: run.config.difficulty,
            threads: run.config.threads,
            wallet: run.config.wallet,
            timeoutMs: run.config.timeoutMs
        },
        hardware: run.hardware || {},
        minerInventory: run.miners.map((miner) => ({
            name: miner.name,
            binaryPath: miner.scriptPath || miner.binaryPath,
            algorithms: Array.from(miner.algorithms).sort()
        })),
        coveragePlan: run.coveragePlan.map((entry) => ({
            algorithm: entry.algorithm,
            covered: !!entry.miner || !!entry.protocolProbe,
            miner: entry.miner ? entry.miner.name : null,
            protocolProbe: entry.protocolProbe || null
        })),
        results: coveredResults,
        unsupportedAlgorithms: run.unsupportedAlgorithms,
        failureCount: failures.length,
        unsupportedAlgorithmCount: run.unsupportedAlgorithms.length,
        exitCode: failures.length || run.unsupportedAlgorithms.length ? 1 : 0
    };
}

function formatSummary(summary) {
    const algorithms = Array.isArray(summary.algorithms) ? summary.algorithms : [];
    const unsupportedAlgorithms = Array.isArray(summary.unsupportedAlgorithms) ? summary.unsupportedAlgorithms : [];
    return [
        `runId: ${summary.runId}`,
        `active algorithms (${algorithms.length}): ${algorithms.join(", ") || "none"}`,
        `unsupported algorithms (${summary.unsupportedAlgorithmCount || 0}): ${unsupportedAlgorithms.map((entry) => entry.algorithm).join(", ") || "none"}`,
        `target failures: ${summary.failureCount}`,
        `logs: ${summary.logDir || "see summary.json"}`,
        summary.error ? `error: ${summary.error}` : ""
    ].filter(Boolean).join("\n");
}

async function formatFailureDetails(summary) {
    if (!summary || !Array.isArray(summary.results)) return "";
    const sections = [];
    for (const result of summary.results) {
        if (result.target?.success) continue;
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

const printSummary = (summary) => process.stdout.write(`${formatSummary(summary)}\n`);
function usesAny(activeAlgorithmSet, algorithms) {
    for (const algorithm of algorithms) {
        if (activeAlgorithmSet.has(algorithm)) return true;
    }
    return false;
}

async function createLivePoolRun(input) {
    const config = buildConfig(input);
    const runDir = path.join(config.logDir, config.runId);

    await ensureDir(runDir);
    await ensureDir(path.join(runDir, "attempts"));

    const logger = createLogger(runDir);
    logger.event("suite.start", { runId: config.runId, targetHost: config.targetHost });

    try {
        const intelGpuDetected = detectIntelGpu();
        const algorithms = getActiveAlgorithms(logger);
        const activeAlgorithmSet = new Set(algorithms.map((entry) => entry.algorithm));
        const miners = [];

        logger.event("hardware.intel-gpu.detect", { detected: intelGpuDetected });

        if (intelGpuDetected && usesAny(activeAlgorithmSet, Object.keys(SRBMINER_INTEL_ALGORITHM_MAP))) {
            miners.push(buildSrbMiner((await ensureSrbMinerBinary(config, logger)).binaryPath));
        }

        if (intelGpuDetected && usesAny(activeAlgorithmSet, MOMINER_INTEL_ALGOS)) {
            const mominer = await ensureMoMinerRoot(config, logger);
            miners.push(buildMoMiner(mominer.rootDir, mominer.scriptPath));
        }

        miners.push(buildXmrigMiner((await ensureXmrigBinary(config, logger)).binaryPath));

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

        return {
            config,
            runDir,
            logger,
            hardware: { intelGpuDetected },
            miners,
            algorithms,
            coveragePlan,
            unsupportedAlgorithms,
            coveredPlans: coveragePlan.filter((entry) => entry.miner || entry.protocolProbe)
        };
    } catch (error) {
        await logger.close();
        throw error;
    }
}

async function finalizeLivePoolRun(run, coveredResults, error) {
    const { config, runDir, logger, unsupportedAlgorithms } = run;

    try {
        const summary = error
            ? {
                runId: config.runId,
                generatedAt: new Date().toISOString(),
                logDir: runDir,
                error: error.message,
                failureCount: 1,
                unsupportedAlgorithmCount: unsupportedAlgorithms.length,
                exitCode: 1
            }
            : buildSummary(run, coveredResults);

        if (error) {
            logger.event("suite.error", { runId: config.runId, message: error.message, stack: error.stack });
        } else {
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

const isDefaultTargetReachable = async () => await isTcpReachable(DEFAULT_TARGET_HOST, DEFAULT_TARGET_PORT);

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

const buildTarget = (config) => ({ name: config.targetName, host: config.targetHost, port: config.targetPort });
const pushCoveredResult = (coveredResults, algorithm, miner, target) => coveredResults.push({ algorithm, miner, target });

async function writeStandaloneFailureSummary(input, error) {
    const config = buildConfig(input);
    const runDir = path.join(config.logDir, config.runId);
    const summary = {
        runId: config.runId,
        generatedAt: new Date().toISOString(),
        logDir: runDir,
        error: error.message,
        failureCount: 1,
        unsupportedAlgorithmCount: 0,
        exitCode: 1
    };

    await ensureDir(runDir);
    await writeJson(path.join(runDir, "summary.json"), summary);
    return summary;
}

async function runLivePoolSuite(input) {
    let run = null;
    const coveredResults = [];

    try {
        run = await createLivePoolRun(input);
        const target = buildTarget(run.config);

        for (const plan of run.coveredPlans.filter((entry) => !hasGpuProtocolProbe(entry))) {
            const result = await executeScenario(run, plan, target);
            pushCoveredResult(coveredResults, plan.algorithm, plan.miner ? plan.miner.name : "protocol-probe", result);
        }

        const protocolPlans = run.coveredPlans.filter(hasGpuProtocolProbe);
        if (protocolPlans.length) {
            for (const result of await executeProtocolProbeBatch(run, protocolPlans, target)) {
                pushCoveredResult(coveredResults, result.algorithm, result.miner, result);
            }
        }

        return await finalizeLivePoolRun(run, coveredResults, null);
    } catch (error) {
        return run
            ? await finalizeLivePoolRun(run, coveredResults, error)
            : await writeStandaloneFailureSummary(input, error);
    }
}

async function runFromCli(argv) {
    const options = parseCliOptions(argv);
    if (options.help) {
        process.stdout.write(`${renderCliHelp()}\n`);
        return 0;
    }

    const summary = await runLivePoolSuite(options);
    printSummary(summary);
    const failureDetails = await formatFailureDetails(summary);
    if (failureDetails) process.stdout.write(`\n${failureDetails}\n`);
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
