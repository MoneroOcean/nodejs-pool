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
    MOM_RELEASE_API,
    MOM_DOWNLOAD_PREFIX,
    USER_AGENT,
    commandExists,
    ensureDir,
    fileExistsSync,
    sanitizeName
} = require("./shared.js");

const ARCHIVE_WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const MAX_ARCHIVE_LINK_EXPANSIONS = 1024;
const XMRIG_DOWNLOAD_PREFIX = "https://github.com/MoneroOcean/xmrig/releases/download/";

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

function validateReleaseTag(tag) {
    const value = String(tag || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error(`Invalid release tag: ${value || "<empty>"}`);
    }
    return value;
}

function releaseApiForTag(apiUrl, tag) {
    if (!tag) return apiUrl;
    const releaseTag = validateReleaseTag(tag);
    if (!/\/latest(?:\?.*)?$/.test(apiUrl)) {
        throw new Error(`Release API does not support tag selection: ${apiUrl}`);
    }
    return apiUrl.replace(/\/latest(?=\?|$)/, `/tags/${encodeURIComponent(releaseTag)}`);
}

function selectRelease(release, requestedTag = "") {
    if (!release || typeof release !== "object" || !Array.isArray(release.assets)) {
        throw new Error("Release metadata is missing an asset list");
    }
    if (typeof release.tag_name !== "string" || !release.tag_name) {
        throw new Error("Release metadata is missing tag_name");
    }
    validateReleaseTag(release.tag_name);
    if (requestedTag && release.tag_name !== requestedTag) {
        throw new Error(`Release metadata tag mismatch: requested ${requestedTag}, received ${release.tag_name}`);
    }
    return release;
}

function normalizeAssetDigest(asset) {
    const value = asset && (asset.digest ?? asset.sha256);
    if (value === undefined || value === null || value === "") return null;
    const match = String(value).match(/^(?:sha256:)?([a-f0-9]{64})$/i);
    if (!match) throw new Error(`Unsupported release asset digest for ${asset.name || "unnamed asset"}`);
    return match[1].toLowerCase();
}

function assertSafeAssetName(asset) {
    if (!asset || typeof asset.name !== "string" || !asset.name || /[\\/:\0]/.test(asset.name)
        || asset.name === "." || asset.name === "..") {
        throw new Error("Release asset has an unsafe name");
    }
}

async function sha256File(filePath) {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const input = fs.createReadStream(filePath);
        input.on("error", reject);
        input.on("data", (chunk) => hash.update(chunk));
        input.on("end", () => resolve(hash.digest("hex")));
    });
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
        if (typeof entry !== "string" || !entry) {
            throw new Error(`Invalid archive member in ${archivePath}`);
        }
        if (entry.includes("\0")) {
            throw new Error(`Unsafe NUL byte in archive member in ${archivePath}`);
        }
        const normalized = entry.replace(/\\/g, "/");
        if (normalized.startsWith("/")) {
            throw new Error(`Unsafe absolute path in archive ${archivePath}`);
        }
        if (ARCHIVE_WINDOWS_DRIVE_PATTERN.test(normalized)) {
            throw new Error(`Unsafe drive path in archive ${archivePath}`);
        }
        if (normalized.split("/").includes("..")) {
            throw new Error(`Unsafe parent traversal path in archive ${archivePath}`);
        }
    }
}

function pathIsWithin(rootDir, candidatePath) {
    const relative = path.relative(rootDir, candidatePath);
    return relative === ""
        || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function tarVerboseArchiveArgs(archivePath) {
    const [flags, archive] = tarArchiveArgs("list", archivePath);
    return [`${flags[0]}v${flags.slice(1)}`, archive, "--quoting-style=escape"];
}

function tarPlainVerboseArchiveArgs(archivePath) {
    const [flags, archive] = tarArchiveArgs("list", archivePath);
    return [`${flags[0]}v${flags.slice(1)}`, archive];
}

function parseTarLink(line, archivePath, archiveEntries = null) {
    const type = line[0];
    if (type !== "l" && type !== "h") return null;

    const marker = type === "l" ? " -> " : " link to ";
    const markerIndex = line.lastIndexOf(marker);
    if (markerIndex <= 0) throw new Error(`Unparseable archive link in ${archivePath}`);

    const left = line.slice(0, markerIndex).trim();
    const target = line.slice(markerIndex + marker.length).trim();
    let name;
    if (archiveEntries) {
        const candidates = archiveEntries
            .map((entry) => entry.replace(/\\/g, "/"))
            .filter((entry) => left === entry || left.endsWith(` ${entry}`));
        const longestLength = candidates.reduce((length, entry) => Math.max(length, entry.length), 0);
        const longest = candidates.filter((entry) => entry.length === longestLength);
        if (longest.length !== 1) throw new Error(`Unparseable archive link in ${archivePath}`);
        name = longest[0];
    } else {
        name = left.slice(left.lastIndexOf(" ") + 1);
    }
    if (!name || !target || name.includes("\\") || target.includes("\\")) {
        throw new Error(`Unparseable archive link in ${archivePath}`);
    }
    return { type, name, target };
}

function zipEntryTypes(output, entryCount, archivePath) {
    const types = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^(\S+)\s+/);
        if (!match) continue;
        const mode = match[1];
        if (/^[bcdlps-][^\s]{9}$/.test(mode)) types.push(mode[0]);
        else if (/^\?[^\s]{9}$/.test(mode)) types.push("-");
        else if (/^[d-][rwx-]{6}$/.test(mode)) types.push(mode[0] === "d" ? "d" : "-");
    }
    if (types.length !== entryCount) {
        throw new Error(`Unparseable ZIP entry metadata in ${archivePath}`);
    }
    return types;
}

async function listArchiveLinks(archivePath, archiveEntries = null) {
    if (archivePath.toLowerCase().endsWith(".zip")) {
        const entries = archiveEntries || await listArchiveEntries(archivePath);
        const output = (await runCommand("unzip", ["-Z", "-l", archivePath])).stdout;
        const types = zipEntryTypes(output, entries.length, archivePath);
        const links = [];
        for (let index = 0; index < entries.length; index += 1) {
            if (types[index] !== "l" && types[index] !== "h") continue;
            const target = (await runCommand("unzip", ["-p", archivePath, entries[index]])).stdout;
            links.push({ type: types[index], name: entries[index], target });
        }
        return links;
    }

    let output;
    try {
        output = (await runCommand("tar", tarVerboseArchiveArgs(archivePath))).stdout;
    } catch (_error) {
        output = (await runCommand("tar", tarPlainVerboseArchiveArgs(archivePath))).stdout;
    }
    return output.split(/\r?\n/).filter(Boolean)
        .map((line) => parseTarLink(line, archivePath, archiveEntries))
        .filter(Boolean);
}

function archivePathEscapesRoot(candidate) {
    return candidate === ".." || candidate.startsWith("../") || candidate.startsWith("/");
}

function splitArchivePath(candidate, archivePath) {
    const value = String(candidate).replace(/\\/g, "/");
    if (value.startsWith("/") || ARCHIVE_WINDOWS_DRIVE_PATTERN.test(value)) {
        throw new Error(`Unsafe archive link target in ${archivePath}`);
    }
    return value.split("/").filter((part) => part !== "");
}

function joinArchivePath(parent, target) {
    return parent === "." ? target : `${parent}/${target}`;
}

function resolveArchiveLinkPath(candidate, links, archivePath) {
    const resolveParts = (parts, stack, steps) => {
        let resolved = [];
        let pending = [...parts];
        while (pending.length) {
            const part = pending.shift();
            if (part === ".") continue;
            if (part === "..") {
                if (!resolved.length) throw new Error(`Unsafe archive link target in ${archivePath}`);
                resolved.pop();
                continue;
            }
            resolved.push(part);
            const prefix = resolved.join("/");
            const link = links.get(prefix);
            if (!link) continue;
            if (stack.includes(prefix) || steps.value >= MAX_ARCHIVE_LINK_EXPANSIONS) {
                throw new Error(`Unsafe archive link cycle in ${archivePath}`);
            }
            steps.value += 1;
            const targetParts = splitArchivePath(link.target, archivePath);
            const targetResolved = resolveParts(
                resolved.slice(0, -1).concat(targetParts),
                [...stack, prefix],
                steps
            );
            pending = targetResolved.concat(pending);
            resolved = [];
        }
        return resolved;
    };
    const resolved = resolveParts(splitArchivePath(candidate, archivePath), [], { value: 0 });
    return resolved.join("/") || ".";
}

function validateArchiveLinks(links, archivePath, archiveEntries = []) {
    const entryNames = new Set(archiveEntries.map((entry) => entry.replace(/\\/g, "/")));
    const logicalSymlinks = new Map();
    const hardlinks = new Map();
    const allLinks = new Set();

    for (const link of links) {
        if (!link || (link.type !== "l" && link.type !== "h")) {
            throw new Error(`Unparseable archive link in ${archivePath}`);
        }
        const { name, target, type } = link;
        if (typeof name !== "string" || typeof target !== "string" || !name || !target) {
            throw new Error(`Unparseable archive link in ${archivePath}`);
        }
        const normalizedName = name.replace(/\\/g, "/");
        const normalizedTarget = target.replace(/\\/g, "/");
        if (entryNames.size && !entryNames.has(normalizedName)) {
            throw new Error(`Unparseable archive link in ${archivePath}`);
        }
        if (target.includes("\0") || normalizedName.includes("\0")) {
            throw new Error(`Unsafe NUL byte in archive link in ${archivePath}`);
        }
        if (normalizedTarget.startsWith("/") || ARCHIVE_WINDOWS_DRIVE_PATTERN.test(normalizedTarget)) {
            throw new Error(`Unsafe absolute archive link in ${archivePath}`);
        }
        const linksByName = type === "l" ? logicalSymlinks : hardlinks;
        if (allLinks.has(normalizedName)) {
            throw new Error(`Duplicate archive link in ${archivePath}`);
        }
        allLinks.add(normalizedName);
        linksByName.set(normalizedName, { type, target: normalizedTarget });
    }

    const physicalSymlinks = new Map();
    for (const [name, link] of logicalSymlinks) {
        const parent = resolveArchiveLinkPath(path.posix.dirname(name), logicalSymlinks, archivePath);
        const physicalName = path.posix.normalize(path.posix.join(parent, path.posix.basename(name)));
        if (physicalName === "." || physicalSymlinks.has(physicalName)) {
            throw new Error(`Unsafe archive link collision in ${archivePath}`);
        }
        physicalSymlinks.set(physicalName, link);
    }

    for (const [name, link] of logicalSymlinks) {
        const parent = resolveArchiveLinkPath(path.posix.dirname(name), physicalSymlinks, archivePath);
        resolveArchiveLinkPath(joinArchivePath(parent, link.target), physicalSymlinks, archivePath);
    }
    for (const [name, link] of hardlinks) {
        const resolved = resolveArchiveLinkPath(link.target, new Map(), archivePath);
        if (archivePathEscapesRoot(resolved)) {
            throw new Error(`Unsafe archive link target in ${archivePath}`);
        }
        if (entryNames.size && !entryNames.has(resolved)) {
            throw new Error(`Unsafe archive link target in ${archivePath}`);
        }
        resolveArchiveLinkPath(resolved, physicalSymlinks, archivePath);
        resolveArchiveLinkPath(name, physicalSymlinks, archivePath);
    }
    for (const entry of archiveEntries) {
        resolveArchiveLinkPath(entry.replace(/\\/g, "/"), physicalSymlinks, archivePath);
    }
}

async function validateExtractedTree(extractDir, archivePath) {
    const groups = new Map();
    const visit = async (currentDir) => {
        const entries = await fsp.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const stat = await fsp.lstat(fullPath);
            if (stat.isSymbolicLink()) {
                let resolved;
                try {
                    resolved = await fsp.realpath(fullPath);
                } catch (_error) {
                    throw new Error(`Broken archive link in ${archivePath}`);
                }
                if (!pathIsWithin(extractDir, resolved)) {
                    throw new Error(`Archive link escapes extraction root in ${archivePath}`);
                }
                continue;
            }
            if (stat.isDirectory()) {
                await visit(fullPath);
                continue;
            }
            if (!stat.isFile()) throw new Error(`Unsupported archive member type in ${archivePath}`);

            const key = `${stat.dev}:${stat.ino}`;
            const group = groups.get(key) || { count: 0, linkCount: stat.nlink };
            group.count += 1;
            group.linkCount = Math.max(group.linkCount, stat.nlink);
            groups.set(key, group);
        }
    };

    const rootStat = await fsp.lstat(extractDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Unsafe extraction root in ${archivePath}`);
    }
    await visit(extractDir);
    for (const group of groups.values()) {
        if (group.linkCount > group.count) throw new Error(`Archive hardlink escapes extraction root in ${archivePath}`);
    }
}

async function validateLocatedBinary(located, extractDir, archivePath) {
    if (!located || typeof located.binaryPath !== "string") {
        if (!located) return;
        throw new Error(`Selected archive binary path is missing in ${archivePath}`);
    }
    if (!pathIsWithin(extractDir, located.binaryPath)) {
        throw new Error(`Selected archive binary escapes extraction root in ${archivePath}`);
    }
    const stat = await fsp.lstat(located.binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Selected archive binary is not a regular file in ${archivePath}`);
    }
    const resolvedRoot = await fsp.realpath(extractDir);
    const resolvedBinary = await fsp.realpath(located.binaryPath);
    if (!pathIsWithin(resolvedRoot, resolvedBinary)) {
        throw new Error(`Selected archive binary escapes extraction root in ${archivePath}`);
    }
}

async function listArchiveEntries(archivePath) {
    if (archivePath.toLowerCase().endsWith(".zip")) {
        return (await runCommand("unzip", ["-Z1", archivePath])).stdout.split(/\r?\n/).filter(Boolean);
    }
    return (await runCommand("tar", tarArchiveArgs("list", archivePath))).stdout.split(/\r?\n/).filter(Boolean);
}

async function extractArchive(archivePath, destination) {
    await ensureDir(destination);
    if (archivePath.toLowerCase().endsWith(".zip")) {
        await runCommand("unzip", ["-oq", archivePath, "-d", destination]);
        return;
    }
    await runCommand("tar", [...tarArchiveArgs("extract", archivePath), "-C", destination]);
}

async function refreshArchiveExtraction(archivePath, extractDir) {
    const archiveEntries = await listArchiveEntries(archivePath);
    validateArchiveEntries(archiveEntries, archivePath);
    validateArchiveLinks(await listArchiveLinks(archivePath, archiveEntries), archivePath, archiveEntries);
    const tempExtractDir = `${extractDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    await fsp.rm(tempExtractDir, { recursive: true, force: true });
    await extractArchive(archivePath, tempExtractDir);
    await validateExtractedTree(tempExtractDir, archivePath);
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

function resolveXmrigAsset(release, platform = process.platform, arch = process.arch) {
    const candidates = release.assets || [];
    if (platform === "linux" && arch === "x64") {
        return pickAsset(candidates, [
            (asset) => /-lin(?:64)?-compat\.tar\.gz$/i.test(asset.name),
            (asset) => /-lin(?:64)?\.tar\.gz$/i.test(asset.name)
        ]);
    }
    if (platform === "darwin" && arch === "arm64") {
        return pickAsset(candidates, [
            (asset) => /-mac(?:64)?\.tar\.gz$/i.test(asset.name)
        ]);
    }
    if (platform === "darwin" && arch === "x64") {
        return pickAsset(candidates, [
            (asset) => /-mac-intel\.tar\.gz$/i.test(asset.name),
            (asset) => /-mac64\.tar\.gz$/i.test(asset.name)
        ]);
    }
    if (platform === "win32" && arch === "x64") {
        return pickAsset(candidates, [
            (asset) => /-win(?:64)?\.zip$/i.test(asset.name)
        ]);
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

function resolveMoMinerAsset(release, platform = process.platform, arch = process.arch) {
    const candidates = release.assets || [];
    if (platform !== "linux" || arch !== "x64") return null;
    return pickAsset(candidates, [
        (asset) => /^mom-v\d+\.\d+\.\d+-lin\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(String(asset.name || ""))
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

    const requestedTag = spec.releaseTag || "";
    const release = selectRelease(
        await fetchJson(releaseApiForTag(spec.releaseApi, requestedTag)),
        requestedTag
    );
    const asset = spec.resolveAsset(release);
    if (!asset) throw new Error(spec.missingAsset(release));
    assertSafeAssetName(asset);

    const versionDir = path.join(config.cacheDir, spec.cacheKey, release.tag_name);
    const archivePath = path.join(versionDir, asset.name);
    const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(spec.archiveSuffixPattern, "")));
    const expectedDigest = normalizeAssetDigest(asset);
    if (!expectedDigest) throw new Error(`Release asset ${asset.name} is missing a SHA-256 digest`);
    const loggerEvent = typeof logger?.event === "function" ? logger.event.bind(logger) : () => {};
    let archiveDigest = fileExistsSync(archivePath) ? await sha256File(archivePath) : "";
    const cacheValid = archiveDigest === expectedDigest;

    if (cacheValid) {
        if (fileExistsSync(extractDir)) {
            await validateExtractedTree(extractDir, archivePath);
            const located = await spec.locate(extractDir);
            if (located) {
                await validateLocatedBinary(located, extractDir, archivePath);
                loggerEvent("miner.binary.cached", spec.logPayload(located, release, asset));
                return spec.result(located, release, asset, "cache");
            }
        }
    }

    await ensureDir(versionDir);
    if (!cacheValid) {
        if (spec.downloadPrefix) assertTrustedDownloadUrl(asset, spec.downloadPrefix);
        loggerEvent("miner.binary.download.start", {
            miner: spec.miner,
            release: release.tag_name,
            asset: asset.name,
            url: asset.browser_download_url
        });

        await downloadToFile(asset.browser_download_url, archivePath);
        archiveDigest = await sha256File(archivePath);
        if (expectedDigest && archiveDigest !== expectedDigest) {
            await fsp.rm(archivePath, { force: true });
            throw new Error(`Downloaded ${asset.name} failed SHA-256 validation`);
        }
    }

    await refreshArchiveExtraction(archivePath, extractDir);
    const extracted = await spec.locate(extractDir);
    if (!extracted) throw new Error(spec.missingExtracted(asset));
    await validateLocatedBinary(extracted, extractDir, archivePath);

    const chmodPath = spec.chmodPath ? spec.chmodPath(extracted) : "";
    if (chmodPath && process.platform !== "win32") {
        await fsp.chmod(chmodPath, 0o755);
    }

    loggerEvent("miner.binary.ready", spec.logPayload(extracted, release, asset));
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
        downloadPrefix: XMRIG_DOWNLOAD_PREFIX,
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
        miner: "mom",
        cacheKey: "mom",
        releaseApi: MOM_RELEASE_API,
        releaseTag: config.momReleaseTag || "",
        resolveAsset: resolveMoMinerAsset,
        archiveSuffixPattern: /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2)$/i,
        downloadPrefix: MOM_DOWNLOAD_PREFIX,
        includeUnzipOnWindows: false,
        async locate(extractDir) {
            const binaryPath = await findNamedFile(extractDir, "mom");
            return binaryPath ? { rootDir: path.dirname(binaryPath), binaryPath } : null;
        },
        missingAsset(release) {
            return `No mom Linux x64 archive asset is available in ${release.tag_name || "latest release"}`;
        },
        missingExtracted(asset) {
            return `Could not find mom executable after extracting ${asset.name}`;
        },
        logPayload(located, release, asset) {
            return {
                miner: "mom",
                release: release.tag_name,
                asset: asset.name,
                rootDir: located.rootDir,
                binaryPath: located.binaryPath
            };
        },
        result(located, release, asset, source) {
            return { ...located, source, release, asset };
        }
    });
}

module.exports = {
    runCommand,
    releaseApiForTag,
    selectRelease,
    normalizeAssetDigest,
    assertSafeAssetName,
    sha256File,
    ensureReleaseAsset,
    validateArchiveEntries,
    resolveXmrigAsset,
    resolveMoMinerAsset,
    ensureXmrigBinary,
    ensureSrbMinerBinary,
    ensureMoMinerRoot
};
