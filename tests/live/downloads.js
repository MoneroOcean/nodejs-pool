"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const {
    XMRIG_RELEASE_API,
    SRBMINER_RELEASE_API,
    SRBMINER_DOWNLOAD_PREFIX,
    MOMINER_RELEASE_API,
    MOMINER_DOWNLOAD_PREFIX,
    USER_AGENT,
    commandExists,
    ensureDir,
    fileExistsSync,
    sanitizeName
} = require("./shared.js");

const ARCHIVE_PATH_ESCAPE_PATTERN = /(^|\/)\.\.(\/|$)/;

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

module.exports = {
    runCommand,
    ensureXmrigBinary,
    ensureSrbMinerBinary,
    ensureMoMinerRoot
};
