"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_SRBMINER_GPU_INTENSITY,
    DEFAULT_SRBMINER_CN_GPU_INTENSITY,
    MOM_INTEL_ALGOS,
    MOM_NO_BENCH_ALGOS,
    commandExists
} = require("./live/shared.js");
const {
    assertSafeAssetName,
    normalizeAssetDigest,
    releaseApiForTag,
    resolveMoMinerAsset,
    resolveXmrigAsset,
    ensureXmrigBinary,
    sha256File,
    selectRelease,
    ensureReleaseAsset,
    runCommand,
    validateArchiveEntries
} = require("./live/downloads.js");
const {
    buildSrbMiner,
    buildMoMinerNoBenchConfig,
    getActiveAlgorithms,
    captureOwnedProcessTree,
    refreshOwnedProcessTree
} = require("./live/miners.js");
const { executeScenario } = require("./live/attempts.js");
const {
    buildDefaultBlockSubmitPayload,
    buildEthBlockSubmitParams,
    CRYPTONOTE_HIGH_DIFF_RESULT_HEX,
    ETHASH_HIGH_DIFF_RESULT_HEX,
    matchesBlockSubmitExpectation,
    summarizeBlockSubmitLog
} = require("./live/protocol.js");
const { BLOCK_SUBMIT_LIVE_CASES } = require("./live/block_submit.js");
const {
    expectedLiveMinerSkipReason,
    expectedLiveProtocolProbeSkipReason
} = require("./live/skips.js");

function patchTarLinkTarget(archivePath, memberName, target) {
    const archive = fs.readFileSync(archivePath);
    let patched = false;
    for (let offset = 0; offset + 512 <= archive.length; offset += 512) {
        const name = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/, "");
        if (name !== memberName) continue;
        assert.ok(Buffer.byteLength(target) < 100);
        archive.fill(0, offset + 157, offset + 257);
        archive.write(target, offset + 157, "utf8");
        archive.fill(0x20, offset + 148, offset + 156);
        let checksum = 0;
        for (let index = 0; index < 512; index += 1) checksum += archive[offset + index];
        archive.write(`${checksum.toString(8).padStart(6, "0")}\0 `, offset + 148, 8, "ascii");
        patched = true;
        break;
    }
    assert.equal(patched, true);
    fs.writeFileSync(archivePath, archive);
}

function patchZipToDos(archivePath) {
    const archive = fs.readFileSync(archivePath);
    let centralDirectoryCount = 0;
    for (let offset = 0; offset + 46 <= archive.length; offset += 1) {
        if (archive.readUInt32LE(offset) !== 0x02014b50) continue;
        archive.writeUInt16LE(20, offset + 4);
        archive.writeUInt32LE(0, offset + 38);
        centralDirectoryCount += 1;
    }
    assert.ok(centralDirectoryCount > 0);
    fs.writeFileSync(archivePath, archive);
}

test.describe("live miner helpers", { concurrency: false }, () => {
    test("release selection is deterministic for an explicit tag", () => {
        const release = {
            tag_name: "v-fixture",
            assets: [{ name: "mom-v-fixture-lin.tar.gz" }]
        };

        assert.equal(
            releaseApiForTag("https://api.github.com/repos/example/project/releases/latest", "v-fixture"),
            "https://api.github.com/repos/example/project/releases/tags/v-fixture"
        );
        assert.equal(selectRelease(release, "v-fixture"), release);
        assert.throws(
            () => selectRelease(release, "v-other"),
            /Release metadata tag mismatch/
        );
        assert.throws(
            () => releaseApiForTag("https://api.github.com/repos/example/project/releases/latest", "../v-fixture"),
            /Invalid release tag/
        );
    });

    test("release asset digests and archive names are validated", () => {
        const digest = "ab".repeat(32);
        const asset = { name: "mom-v-fixture-lin.tar.gz", digest: `sha256:${digest}` };

        assert.equal(normalizeAssetDigest(asset), digest);
        assert.equal(normalizeAssetDigest({ name: asset.name }), null);
        assert.throws(
            () => normalizeAssetDigest({ name: asset.name, digest: "sha512:bad" }),
            /Unsupported release asset digest/
        );
        assert.throws(() => assertSafeAssetName({ name: "../archive.tgz" }), /unsafe name/);
        assert.throws(() => assertSafeAssetName({ name: "archive:fixture.tgz" }), /unsafe name/);
        assert.throws(() => assertSafeAssetName({ name: "archive\0fixture.tgz" }), /unsafe name/);
    });

    test("XMRig release assets stay on the official download owner", async () => {
        if (process.platform !== "linux" || process.arch !== "x64") return;

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-xmrig-url-"));
        const previousFetch = global.fetch;
        const fetchCalls = [];
        const digest = "ab".repeat(32);
        const release = {
            tag_name: "v-fixture",
            assets: [{
                name: "xmrig-v-fixture-lin64.tar.gz",
                browser_download_url: "https://downloads.invalid/xmrig.tar.gz",
                digest: `sha256:${digest}`
            }]
        };

        global.fetch = async (url) => {
            fetchCalls.push(url);
            return { ok: true, json: async () => release };
        };
        try {
            await assert.rejects(
                () => ensureXmrigBinary({ cacheDir: tempDir }, { event() {} }),
                /Unsafe release download URL/
            );
            assert.equal(fetchCalls.length, 1);
        } finally {
            global.fetch = previousFetch;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test("archive member validation covers directories and platform escapes", () => {
        assert.doesNotThrow(() => validateArchiveEntries(["bin/", "bin/mom"], "fixture.tar.gz"));

        for (const entry of [
            "../escape/",
            "nested/../../escape/",
            "/absolute/",
            "C:/drive/",
            "C:\\drive\\",
            "safe/\0/child"
        ]) {
            assert.throws(
                () => validateArchiveEntries([entry], "fixture.tar.gz"),
                /Unsafe/
            );
        }
    });

    test("archive links stay internal and cached binaries stay regular", async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-links-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const outsidePath = path.join(tempDir, "outside-target");
        const payloadDir = path.join(tempDir, "payload");
        const sourceArchive = path.join(tempDir, "source.tar.gz");
        fs.writeFileSync(outsidePath, "outside\n");
        fs.mkdirSync(payloadDir);
        fs.writeFileSync(path.join(payloadDir, "binary"), "fixture executable\n");
        fs.writeFileSync(path.join(payloadDir, "target name"), "fixture target\n");
        fs.symlinkSync("binary", path.join(payloadDir, "internal-alias"));
        fs.symlinkSync("target name", path.join(payloadDir, "link name"));
        fs.linkSync(path.join(payloadDir, "binary"), path.join(payloadDir, "internal-hardlink"));
        await runCommand("tar", [
            "-czf", sourceArchive, "-C", payloadDir,
            "binary", "target name", "internal-alias", "link name", "internal-hardlink"
        ]);

        const archiveBytes = fs.readFileSync(sourceArchive);
        const releaseApi = "fixture:metadata";
        const downloadUrl = "fixture:download";
        const release = {
            tag_name: "v-fixture",
            assets: [{
                name: "fixture.tar.gz",
                browser_download_url: downloadUrl,
                digest: `sha256:${await sha256File(sourceArchive)}`
            }]
        };
        const previousFetch = global.fetch;
        global.fetch = async (url) => {
            if (url === releaseApi) return { ok: true, json: async () => release };
            if (url === downloadUrl) return new Response(archiveBytes);
            throw new Error("unexpected fixture URL");
        };

        const spec = {
            miner: "fixture",
            cacheKey: "fixture",
            releaseApi,
            resolveAsset: (currentRelease) => currentRelease.assets[0],
            archiveSuffixPattern: /(\.tar\.gz)$/i,
            includeUnzipOnWindows: false,
            async locate(extractDir) {
                const binaryPath = path.join(extractDir, "binary");
                return fs.existsSync(binaryPath) ? { binaryPath } : null;
            },
            missingAsset: () => "missing fixture asset",
            missingExtracted: () => "missing fixture binary",
            logPayload: () => ({}),
            result: (located) => located
        };
        const config = { cacheDir: path.join(tempDir, "cache") };

        try {
            const first = await ensureReleaseAsset(config, { event() {} }, spec);
            assert.equal(fs.lstatSync(first.binaryPath).isFile(), true);
            assert.equal(
                fs.readlinkSync(path.join(path.dirname(first.binaryPath), "link name")),
                "target name"
            );

            fs.rmSync(first.binaryPath);
            fs.symlinkSync(outsidePath, first.binaryPath);
            await assert.rejects(
                () => ensureReleaseAsset(config, { event() {} }, spec),
                /Archive link escapes extraction root|regular file/
            );

            fs.rmSync(first.binaryPath);
            fs.rmSync(path.join(path.dirname(first.binaryPath), "internal-alias"));
            fs.linkSync(outsidePath, first.binaryPath);
            await assert.rejects(
                () => ensureReleaseAsset(config, { event() {} }, spec),
                /Archive hardlink escapes extraction root/
            );

            const evilPayloadDir = path.join(tempDir, "evil-payload");
            const evilArchive = path.join(tempDir, "evil.tar.gz");
            fs.mkdirSync(evilPayloadDir);
            fs.symlinkSync("../outside-target", path.join(evilPayloadDir, "binary"));
            await runCommand("tar", ["-czf", evilArchive, "-C", evilPayloadDir, "binary"]);
            const evilBytes = fs.readFileSync(evilArchive);
            release.tag_name = "v-evil";
            release.assets = [{
                name: "evil.tar.gz",
                browser_download_url: downloadUrl,
                digest: `sha256:${await sha256File(evilArchive)}`
            }];
            global.fetch = async (url) => {
                if (url === releaseApi) return { ok: true, json: async () => release };
                if (url === downloadUrl) return new Response(evilBytes);
                throw new Error("unexpected fixture URL");
            };
            await assert.rejects(
                () => ensureReleaseAsset(config, { event() {} }, {
                    ...spec,
                    resolveAsset: (currentRelease) => currentRelease.assets[0]
                }),
                /Unsafe archive link target/
            );
            assert.equal(fs.readFileSync(outsidePath, "utf8"), "outside\n");
        } finally {
            global.fetch = previousFetch;
        }
    });

    test("archive link preflight rejects root escapes and cycles before extraction", async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-link-graph-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const config = { cacheDir: path.join(tempDir, "cache") };
        const previousFetch = global.fetch;
        const assertRejectedArchive = async ({ tag, name, archivePath, suffixPattern }) => {
            const releaseApi = `fixture:${tag}:metadata`;
            const downloadUrl = `fixture:${tag}:download`;
            const release = {
                tag_name: tag,
                assets: [{
                    name,
                    browser_download_url: downloadUrl,
                    digest: `sha256:${await sha256File(archivePath)}`
                }]
            };
            const archiveBytes = fs.readFileSync(archivePath);
            global.fetch = async (url) => {
                if (url === releaseApi) return { ok: true, json: async () => release };
                if (url === downloadUrl) return new Response(archiveBytes);
                throw new Error("unexpected fixture URL");
            };
            const spec = {
                miner: "fixture",
                cacheKey: "fixture-link-graph",
                releaseApi,
                resolveAsset: (currentRelease) => currentRelease.assets[0],
                archiveSuffixPattern: suffixPattern,
                includeUnzipOnWindows: false,
                async locate(extractDir) {
                    return { binaryPath: path.join(extractDir, "binary") };
                },
                missingAsset: () => "missing fixture asset",
                missingExtracted: () => "missing fixture binary",
                logPayload: () => ({}),
                result: (located) => located
            };
            await assert.rejects(
                () => ensureReleaseAsset(config, { event() {} }, spec),
                /Unsafe archive link/
            );
            const extractedName = name.replace(suffixPattern, "");
            assert.equal(
                fs.existsSync(path.join(config.cacheDir, "fixture-link-graph", tag, extractedName)),
                false
            );
        };

        try {
            const hardPayloadDir = path.join(tempDir, "hard-payload");
            const hardArchive = path.join(tempDir, "hard.tar");
            fs.mkdirSync(path.join(hardPayloadDir, "dir"), { recursive: true });
            fs.writeFileSync(path.join(hardPayloadDir, "binary"), "fixture executable\n");
            fs.linkSync(
                path.join(hardPayloadDir, "binary"),
                path.join(hardPayloadDir, "dir", "internal-hardlink")
            );
            await runCommand("tar", [
                "-cf", hardArchive, "-C", hardPayloadDir, "binary", "dir/internal-hardlink"
            ]);
            patchTarLinkTarget(hardArchive, "dir/internal-hardlink", "../outside-target");
            await assertRejectedArchive({
                tag: "v-hardlink-escape",
                name: "hard.tar",
                archivePath: hardArchive,
                suffixPattern: /(\.tar)$/i
            });

            const cyclePayloadDir = path.join(tempDir, "cycle-payload");
            const cycleArchive = path.join(tempDir, "cycle.tar.gz");
            fs.mkdirSync(cyclePayloadDir);
            fs.symlinkSync("b", path.join(cyclePayloadDir, "a"));
            fs.symlinkSync("a", path.join(cyclePayloadDir, "b"));
            await runCommand("tar", ["-czf", cycleArchive, "-C", cyclePayloadDir, "a", "b"]);
            await assertRejectedArchive({
                tag: "v-symlink-cycle",
                name: "cycle.tar.gz",
                archivePath: cycleArchive,
                suffixPattern: /(\.tar\.gz)$/i
            });

            const orderedPayloadDir = path.join(tempDir, "ordered-payload");
            const orderedArchive = path.join(tempDir, "ordered.tar.gz");
            fs.mkdirSync(path.join(orderedPayloadDir, "pkg"), { recursive: true });
            fs.symlinkSync("..", path.join(orderedPayloadDir, "pkg", "a"));
            fs.symlinkSync("a/../outside", path.join(orderedPayloadDir, "pkg", "b"));
            await runCommand("tar", [
                "-czf", orderedArchive, "-C", orderedPayloadDir, "pkg/a", "pkg/b"
            ]);
            await assertRejectedArchive({
                tag: "v-symlink-ordered-parent",
                name: "ordered.tar.gz",
                archivePath: orderedArchive,
                suffixPattern: /(\.tar\.gz)$/i
            });

            const budgetPayloadDir = path.join(tempDir, "budget-payload");
            const budgetArchive = path.join(tempDir, "budget.tar.gz");
            const budgetNames = Array.from(
                { length: 1025 },
                (_value, index) => `chain-${String(index).padStart(4, "0")}`
            );
            fs.mkdirSync(budgetPayloadDir);
            fs.writeFileSync(path.join(budgetPayloadDir, "binary"), "fixture executable\n");
            for (let index = 0; index < budgetNames.length; index += 1) {
                const target = index + 1 < budgetNames.length ? budgetNames[index + 1] : "binary";
                fs.symlinkSync(target, path.join(budgetPayloadDir, budgetNames[index]));
            }
            await runCommand("tar", [
                "-czf", budgetArchive, "-C", budgetPayloadDir, "binary", ...budgetNames
            ]);
            await assertRejectedArchive({
                tag: "v-symlink-expansion-budget",
                name: "budget.tar.gz",
                archivePath: budgetArchive,
                suffixPattern: /(\.tar\.gz)$/i
            });

            let supportsTransform = false;
            try {
                supportsTransform = (await runCommand("tar", ["--help"])).stdout.includes("--transform");
            } catch (_error) {
                supportsTransform = false;
            }
            if (supportsTransform) {
                const composedPayloadDir = path.join(tempDir, "composed-payload");
                const composedArchive = path.join(tempDir, "composed.tar.gz");
                fs.mkdirSync(composedPayloadDir);
                fs.symlinkSync(".", path.join(composedPayloadDir, "alias"));
                fs.symlinkSync("..", path.join(composedPayloadDir, "up"));
                fs.writeFileSync(path.join(composedPayloadDir, "escape"), "fixture\n");
                await runCommand("tar", [
                    "-czf", composedArchive, "-C", composedPayloadDir,
                    "--transform=s#^up$#alias/up#;s#^escape$#alias/up/escape#",
                    "alias", "up", "escape"
                ]);
                await assertRejectedArchive({
                    tag: "v-symlink-composed",
                    name: "composed.tar.gz",
                    archivePath: composedArchive,
                    suffixPattern: /(\.tar\.gz)$/i
                });
            }
        } finally {
            global.fetch = previousFetch;
        }
    });

    test("ZIP link targets are validated before extraction", async (t) => {
        if (!commandExists("zip") || !commandExists("unzip")) {
            t.skip("ZIP fixture tools unavailable");
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-zip-links-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const outsidePath = path.join(tempDir, "outside-target");
        const payloadDir = path.join(tempDir, "payload");
        const sourceArchive = path.join(tempDir, "source.zip");
        fs.writeFileSync(outsidePath, "outside\n");
        fs.mkdirSync(payloadDir);
        fs.writeFileSync(path.join(payloadDir, "binary"), "fixture executable\n");
        fs.symlinkSync("binary", path.join(payloadDir, "internal-alias"));
        await runCommand("zip", ["-q", "-y", sourceArchive, "binary", "internal-alias"], { cwd: payloadDir });

        const archiveBytes = fs.readFileSync(sourceArchive);
        const releaseApi = "fixture:zip-metadata";
        const downloadUrl = "fixture:zip-download";
        const release = {
            tag_name: "v-zip-fixture",
            assets: [{
                name: "fixture.zip",
                browser_download_url: downloadUrl,
                digest: `sha256:${await sha256File(sourceArchive)}`
            }]
        };
        const previousFetch = global.fetch;
        const spec = {
            miner: "fixture",
            cacheKey: "fixture-zip",
            releaseApi,
            resolveAsset: (currentRelease) => currentRelease.assets[0],
            archiveSuffixPattern: /(\.zip)$/i,
            includeUnzipOnWindows: true,
            async locate(extractDir) {
                const binaryPath = path.join(extractDir, "binary");
                return fs.existsSync(binaryPath) ? { binaryPath } : null;
            },
            missingAsset: () => "missing ZIP fixture asset",
            missingExtracted: () => "missing ZIP fixture binary",
            logPayload: () => ({}),
            result: (located) => located
        };

        global.fetch = async (url) => {
            if (url === releaseApi) return { ok: true, json: async () => release };
            if (url === downloadUrl) return new Response(archiveBytes);
            throw new Error("unexpected fixture URL");
        };

        try {
            const config = { cacheDir: path.join(tempDir, "cache") };
            const first = await ensureReleaseAsset(config, { event() {} }, spec);
            assert.equal(fs.lstatSync(first.binaryPath).isFile(), true);

            const dosPayloadDir = path.join(tempDir, "dos-payload");
            const dosArchive = path.join(tempDir, "dos.zip");
            fs.mkdirSync(dosPayloadDir);
            fs.writeFileSync(path.join(dosPayloadDir, "binary"), "fixture executable\n");
            await runCommand("zip", ["-q", dosArchive, "binary"], { cwd: dosPayloadDir });
            patchZipToDos(dosArchive);
            const dosBytes = fs.readFileSync(dosArchive);
            release.tag_name = "v-dos-zip";
            release.assets = [{
                name: "dos.zip",
                browser_download_url: "fixture:dos-zip-download",
                digest: `sha256:${await sha256File(dosArchive)}`
            }];
            global.fetch = async (url) => {
                if (url === releaseApi) return { ok: true, json: async () => release };
                if (url === "fixture:dos-zip-download") return new Response(dosBytes);
                throw new Error("unexpected fixture URL");
            };
            const dos = await ensureReleaseAsset(
                { cacheDir: path.join(tempDir, "dos-cache") },
                { event() {} },
                { ...spec, cacheKey: "fixture-dos-zip" }
            );
            assert.equal(fs.lstatSync(dos.binaryPath).isFile(), true);

            const evilPayloadDir = path.join(tempDir, "evil-payload");
            const evilArchive = path.join(tempDir, "evil.zip");
            fs.mkdirSync(evilPayloadDir);
            fs.symlinkSync("../outside-target", path.join(evilPayloadDir, "binary"));
            await runCommand("zip", ["-q", "-y", evilArchive, "binary"], { cwd: evilPayloadDir });
            const evilBytes = fs.readFileSync(evilArchive);
            release.tag_name = "v-evil-zip-fixture";
            release.assets = [{
                name: "evil.zip",
                browser_download_url: downloadUrl,
                digest: `sha256:${await sha256File(evilArchive)}`
            }];
            global.fetch = async (url) => {
                if (url === releaseApi) return { ok: true, json: async () => release };
                if (url === downloadUrl) return new Response(evilBytes);
                throw new Error("unexpected fixture URL");
            };
            await assert.rejects(
                () => ensureReleaseAsset(config, { event() {} }, spec),
                /Unsafe archive link target/
            );
            assert.equal(
                fs.existsSync(path.join(config.cacheDir, "fixture-zip", "v-evil-zip-fixture", "evil")),
                false
            );
            assert.equal(fs.readFileSync(outsidePath, "utf8"), "outside\n");
        } finally {
            global.fetch = previousFetch;
        }
    });

    test("release cache verifies the current metadata before reusing an archive", async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-release-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const payloadDir = path.join(tempDir, "payload");
        const sourceArchive = path.join(tempDir, "source.tar.gz");
        fs.mkdirSync(payloadDir);
        fs.writeFileSync(path.join(payloadDir, "mom"), "fixture executable\n");
        await runCommand("tar", ["-czf", sourceArchive, "-C", payloadDir, "mom"]);
        const archiveBytes = fs.readFileSync(sourceArchive);
        const releaseApi = "https://example.invalid/releases/latest";
        const downloadUrl = "https://example.invalid/releases/download/v-fixture/mom-v-fixture-lin.tar.gz";
        const asset = {
            name: "mom-v-fixture-lin.tar.gz",
            browser_download_url: downloadUrl,
            digest: `sha256:${await sha256File(sourceArchive)}`
        };
        const release = { tag_name: "v-fixture", assets: [asset] };
        const fetchCalls = [];
        const previousFetch = global.fetch;
        global.fetch = async (url) => {
            fetchCalls.push(url);
            if (url === releaseApi) return { ok: true, json: async () => release };
            if (url === downloadUrl) return new Response(archiveBytes);
            throw new Error(`Unexpected fixture URL: ${url}`);
        };

        const spec = {
            miner: "fixture",
            cacheKey: "fixture",
            releaseApi,
            resolveAsset: (currentRelease) => currentRelease.assets[0],
            archiveSuffixPattern: /(\.tar\.gz)$/i,
            downloadPrefix: "https://example.invalid/releases/download/",
            includeUnzipOnWindows: false,
            async locate(extractDir) {
                const binaryPath = path.join(extractDir, "mom");
                return fs.existsSync(binaryPath) ? { binaryPath } : null;
            },
            missingAsset: () => "fixture asset missing",
            missingExtracted: () => "fixture executable missing",
            logPayload: () => ({}),
            result: (located, currentRelease, currentAsset, source) => ({
                ...located,
                source,
                release: currentRelease,
                asset: currentAsset
            })
        };

        try {
            const config = { cacheDir: path.join(tempDir, "cache") };
            const first = await ensureReleaseAsset(config, { event: () => {} }, spec);
            assert.equal(first.source, "download");
            assert.deepEqual(fetchCalls, [releaseApi, downloadUrl]);

            fetchCalls.length = 0;
            const cached = await ensureReleaseAsset(config, { event: () => {} }, spec);
            assert.equal(cached.source, "cache");
            assert.deepEqual(fetchCalls, [releaseApi]);

            const fixtureArchivePath = path.join(config.cacheDir, "fixture", "v-fixture", asset.name);
            fs.rmSync(fixtureArchivePath);
            fetchCalls.length = 0;
            const redownloaded = await ensureReleaseAsset(config, { event: () => {} }, spec);
            assert.equal(redownloaded.source, "download");
            assert.deepEqual(fetchCalls, [releaseApi, downloadUrl]);

            release.tag_name = "v-next";
            fetchCalls.length = 0;
            const newRelease = await ensureReleaseAsset(config, { event: () => {} }, spec);
            assert.equal(newRelease.source, "download");
            assert.equal(
                fs.existsSync(path.join(config.cacheDir, "fixture", "v-next", asset.name)),
                true
            );
            assert.deepEqual(fetchCalls, [releaseApi, downloadUrl]);

            const archivePath = path.join(config.cacheDir, "fixture", "v-next", asset.name);
            const extractedBinaryPath = path.join(
                config.cacheDir,
                "fixture",
                "v-next",
                "mom-v-fixture-lin",
                "mom"
            );
            assert.equal(fs.existsSync(extractedBinaryPath), true);

            fs.writeFileSync(archivePath, "tampered cached archive\n");
            global.fetch = async (url) => {
                fetchCalls.push(url);
                if (url === releaseApi) return { ok: true, json: async () => release };
                if (url === downloadUrl) throw new Error("fixture download unavailable");
                throw new Error(`Unexpected fixture URL: ${url}`);
            };
            fetchCalls.length = 0;
            await assert.rejects(
                () => ensureReleaseAsset(config, { event: () => {} }, spec),
                /fixture download unavailable/
            );
            assert.equal(fs.existsSync(extractedBinaryPath), true);
            assert.deepEqual(fetchCalls, [releaseApi, downloadUrl]);

            fs.rmSync(archivePath);
            global.fetch = async (url) => {
                fetchCalls.push(url);
                if (url === releaseApi) return { ok: true, json: async () => release };
                if (url === downloadUrl) return new Response(Buffer.from("wrong downloaded archive\n"));
                throw new Error(`Unexpected fixture URL: ${url}`);
            };
            fetchCalls.length = 0;
            await assert.rejects(
                () => ensureReleaseAsset(config, { event: () => {} }, spec),
                /failed SHA-256 validation/
            );
            assert.equal(fs.existsSync(archivePath), false);
            assert.equal(fs.existsSync(extractedBinaryPath), true);
            assert.deepEqual(fetchCalls, [releaseApi, downloadUrl]);

            global.fetch = async (url) => {
                fetchCalls.push(url);
                throw new Error("fixture latest metadata unavailable");
            };
            fetchCalls.length = 0;
            await assert.rejects(
                () => ensureReleaseAsset(config, { event: () => {} }, spec),
                /latest metadata unavailable/
            );
            assert.equal(fs.existsSync(extractedBinaryPath), true);
            assert.deepEqual(fetchCalls, [releaseApi]);

            const originalDigest = asset.digest;
            delete asset.digest;
            try {
                global.fetch = async (url) => {
                    fetchCalls.push(url);
                    if (url === releaseApi) return { ok: true, json: async () => release };
                    throw new Error(`Unexpected fixture URL: ${url}`);
                };
                fetchCalls.length = 0;
                await assert.rejects(
                    () => ensureReleaseAsset(config, { event: () => {} }, spec),
                    /missing a SHA-256 digest/
                );
                assert.equal(fs.existsSync(extractedBinaryPath), true);
                assert.deepEqual(fetchCalls, [releaseApi]);
            } finally {
                asset.digest = originalDigest;
            }
        } finally {
            global.fetch = previousFetch;
        }
    });

    test("MoM fixture asset selection stays Linux x64-only", () => {
        const release = {
            assets: [
                { name: "mom-v0.9.0-win.zip" },
                { name: "other-v0.9.0-lin.tar.gz" },
                { name: "mom-v0.9.0-source.tar.gz" },
                { name: "mom-v0.9.0-lin.tar.gz" }
            ]
        };

        assert.equal(resolveMoMinerAsset(release, "linux", "x64").name, "mom-v0.9.0-lin.tar.gz");
        assert.equal(resolveMoMinerAsset(release, "win32", "x64"), null);
        assert.equal(resolveMoMinerAsset({
            assets: [
                { name: "generic-source.tar.gz" },
                { name: "mom-v0.9.0-source.tar.gz" }
            ]
        }, "linux", "x64"), null);
    });

    test("PearlHash is an explicit MoM Intel loopback plan", () => {
        assert.equal(MOM_INTEL_ALGOS.has("c29"), true);
        assert.equal(MOM_INTEL_ALGOS.has("pearlhash"), true);
        assert.equal(MOM_NO_BENCH_ALGOS.includes("pearlhash"), true);

        const previous = process.env.NODEJS_POOL_LIVE_ALGOS;
        delete process.env.NODEJS_POOL_LIVE_ALGOS;
        try {
            assert.equal(getActiveAlgorithms({ event: () => {} }).some((entry) => entry.algorithm === "pearlhash"), false);
            process.env.NODEJS_POOL_LIVE_ALGOS = "pearlhash";
            assert.deepEqual(
                getActiveAlgorithms({ event: () => {} }).map((entry) => entry.algorithm),
                ["pearlhash"]
            );
        } finally {
            if (typeof previous === "undefined") delete process.env.NODEJS_POOL_LIVE_ALGOS;
            else process.env.NODEJS_POOL_LIVE_ALGOS = previous;
        }
    });

    test("MoM no-bench fixture routes PearlHash to the configured GPU device", () => {
        const config = buildMoMinerNoBenchConfig({
            host: "localhost",
            port: 20001,
            tls: true,
            walletWithDifficulty: "fixture-wallet",
            password: "x~pearlhash",
            timeoutMs: DEFAULT_TIMEOUT_MS,
            moMinerC29Device: "gpu1"
        });

        assert.equal(config.bench_algo_params, 0);
        assert.equal(config.pool_time.donate_length, 60);
        assert.equal(config.algo_params.pearlhash.dev, "gpu1");
    });

    test("XMRig release resolver prefers unified compatible Linux assets", () => {
        const release = {
            assets: [
                { name: "xmrig-v6.26.0-mo4-lin.tar.gz" },
                { name: "xmrig-v6.26.0-mo4-lin-compat.tar.gz" }
            ]
        };

        assert.equal(
            resolveXmrigAsset(release, "linux", "x64").name,
            "xmrig-v6.26.0-mo4-lin-compat.tar.gz"
        );
    });

    test("XMRig release resolver keeps legacy artifact compatibility", () => {
        const release = {
            assets: [
                { name: "xmrig-v6.26.0-mo3-lin64.tar.gz" },
                { name: "xmrig-v6.26.0-mo3-lin64-compat.tar.gz" },
                { name: "xmrig-v6.26.0-mo3-mac64.tar.gz" },
                { name: "xmrig-v6.26.0-mo3-win64.zip" }
            ]
        };

        assert.equal(
            resolveXmrigAsset(release, "linux", "x64").name,
            "xmrig-v6.26.0-mo3-lin64-compat.tar.gz"
        );
        assert.equal(
            resolveXmrigAsset(release, "darwin", "arm64").name,
            "xmrig-v6.26.0-mo3-mac64.tar.gz"
        );
        assert.equal(
            resolveXmrigAsset(release, "win32", "x64").name,
            "xmrig-v6.26.0-mo3-win64.zip"
        );
    });

    test("XMRig release resolver recognizes unified macOS and Windows assets", () => {
        const release = {
            assets: [
                { name: "xmrig-v6.26.0-mo4-mac.tar.gz" },
                { name: "xmrig-v6.26.0-mo4-mac-intel.tar.gz" },
                { name: "xmrig-v6.26.0-mo4-win.zip" }
            ]
        };

        assert.equal(resolveXmrigAsset(release, "darwin", "arm64").name, "xmrig-v6.26.0-mo4-mac.tar.gz");
        assert.equal(resolveXmrigAsset(release, "darwin", "x64").name, "xmrig-v6.26.0-mo4-mac-intel.tar.gz");
        assert.equal(resolveXmrigAsset(release, "win32", "x64").name, "xmrig-v6.26.0-mo4-win.zip");
    });

    test("SRBMiner cn/gpu args include conservative stability controls", () => {
        const miner = buildSrbMiner("/tmp/SRBMiner-MULTI");
        const args = miner.buildArgs({
            algorithm: "cn/gpu",
            host: "sg.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~cn/gpu",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerLogPath: "/tmp/srbminer.log",
            srbMinerGpuIntensity: "8",
            srbMinerApiPort: 21550,
            timeoutMs: DEFAULT_TIMEOUT_MS
        });

        assert.equal(args[args.indexOf("--log-file") + 1], "/tmp/srbminer.log");
        assert.equal(args[args.indexOf("--log-file-mode") + 1], "0");
        assert.equal(args[args.indexOf("--gpu-intensity") + 1], "8");
        assert.equal(args.includes("--enable-workers-ramp-up"), true);
        assert.equal(args[args.indexOf("--max-no-share-sent") + 1], String(DEFAULT_TIMEOUT_MS / 1000));
        assert.equal(args.includes("--gpu-disable-interleaving"), true);
        assert.equal(args.includes("--disable-gpu-dual-kernels"), true);
        assert.equal(args.includes("--autotune-no-load"), true);
        assert.equal(args[args.indexOf("--busy-wait-recheck") + 1], "0.01");
        assert.equal(args.includes("--extended-log"), true);
    });

    test("SRBMiner non-cn/gpu args keep default intensity", () => {
        const miner = buildSrbMiner("/tmp/SRBMiner-MULTI");
        const args = miner.buildArgs({
            algorithm: "autolykos2",
            host: "sg.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~autolykos2",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerGpuIntensity: "",
            srbMinerApiPort: 21550,
            timeoutMs: DEFAULT_TIMEOUT_MS
        });

        assert.equal(args.includes("--gpu-intensity"), false);
        assert.equal(args.includes("--enable-workers-ramp-up"), true);
        assert.equal(args.includes("--gpu-disable-interleaving"), false);
        assert.equal(args.includes("--disable-gpu-dual-kernels"), false);
    });

    test("SRBMiner live default intensity is only conservative for cn/gpu", () => {
        assert.equal(DEFAULT_SRBMINER_GPU_INTENSITY, "");
        assert.equal(DEFAULT_SRBMINER_CN_GPU_INTENSITY, "1");
    });

    test("live algorithms can be narrowed for hardware-safe retries", () => {
        const previous = process.env.NODEJS_POOL_LIVE_ALGOS;
        process.env.NODEJS_POOL_LIVE_ALGOS = "rx/0, rx/arq";
        try {
            const events = [];
            const selected = getActiveAlgorithms({ event: (...args) => events.push(args) });
            assert.deepEqual(selected.map((entry) => entry.algorithm), ["rx/0", "rx/arq"]);
            assert.equal(events[0][1].source, "env");
        } finally {
            if (typeof previous === "undefined") delete process.env.NODEJS_POOL_LIVE_ALGOS;
            else process.env.NODEJS_POOL_LIVE_ALGOS = previous;
        }
    });

    test("live algorithm filters reject unknown names", () => {
        const previous = process.env.NODEJS_POOL_LIVE_ALGOS;
        process.env.NODEJS_POOL_LIVE_ALGOS = "rx/0,missing";
        try {
            assert.throws(
                () => getActiveAlgorithms({ event: () => {} }),
                /Unknown live algorithm filter: missing/
            );
        } finally {
            if (typeof previous === "undefined") delete process.env.NODEJS_POOL_LIVE_ALGOS;
            else process.env.NODEJS_POOL_LIVE_ALGOS = previous;
        }
    });

    test("eth block-submit params use the subscribed extranonce prefix", () => {
        const resultHex = "aa".repeat(32);
        const params = buildEthBlockSubmitParams("wallet", "job-1", resultHex, "ff7e");

        assert.equal(params[0], "wallet");
        assert.equal(params[1], "job-1");
        assert.match(params[2], /^0xff7e[0-9a-f]{12}$/);
        assert.equal(params[5], `0x${resultHex}`);
    });

    test("eth block-submit params reject missing subscribed extranonce", () => {
        assert.throws(
            () => buildEthBlockSubmitParams("wallet", "job-1", "aa".repeat(32), ""),
            /Eth subscribe did not return an extranonce/
        );
    });

    test("default block-submit payload carries an explicit synthetic result", () => {
        const payload = buildDefaultBlockSubmitPayload({
            result: {
                id: "miner-1",
                job: { job_id: "job-1" }
            }
        }, CRYPTONOTE_HIGH_DIFF_RESULT_HEX);

        assert.equal(payload.result, CRYPTONOTE_HIGH_DIFF_RESULT_HEX);
        assert.equal(payload.block_submit_test_result, CRYPTONOTE_HIGH_DIFF_RESULT_HEX);
    });

    test("block-submit synthetic high-difficulty hashes are non-zero and endian-specific", () => {
        assert.equal(CRYPTONOTE_HIGH_DIFF_RESULT_HEX, `01${  "00".repeat(31)}`);
        assert.equal(ETHASH_HIGH_DIFF_RESULT_HEX, `${"00".repeat(31)  }01`);
        assert.notEqual(CRYPTONOTE_HIGH_DIFF_RESULT_HEX, "00".repeat(32));
        assert.notEqual(ETHASH_HIGH_DIFF_RESULT_HEX, "00".repeat(32));
    });

    test("live block-submit fixed candidates avoid all-zero synthetic hashes", () => {
        const zeroResult = "00".repeat(32);
        const fixedCases = new Set([
            "xmr-main-dual",
            "cryptonote-submitblock",
            "btc-submitblock",
            "xtm-c-submitblock",
            "eth-submitwork",
            "erg-submitblock"
        ]);

        for (const testCase of BLOCK_SUBMIT_LIVE_CASES.filter((entry) => fixedCases.has(entry.name))) {
            const candidates = testCase.buildCandidates({});
            assert.ok(candidates.length > 0, testCase.name);
            assert.equal(candidates.some((candidate) => candidate.resultHex === zeroResult), false, testCase.name);
        }
    });

    test("cryptonote block-submit candidates prefer stable non-ARQ coins", () => {
        const testCase = BLOCK_SUBMIT_LIVE_CASES.find((entry) => entry.name === "cryptonote-submitblock");
        assert.ok(testCase);
        const candidates = testCase.buildCandidates({});

        assert.deepEqual(candidates.map((candidate) => candidate.coin), ["RYO/CCX", "XLA", "ARQ"]);
        assert.deepEqual(candidates.map((candidate) => candidate.algo), ["cn/gpu", "panthera", "rx/arq"]);
        assert.deepEqual(candidates[0].expectation.includeAnyChains, ["RYO/", "CCX/"]);
    });

    test("xtm-c block-submit coverage skips live SubmitBlock response stalls", () => {
        const testCase = BLOCK_SUBMIT_LIVE_CASES.find((entry) => entry.name === "xtm-c-submitblock");
        assert.ok(testCase);
        assert.equal(
            testCase.expectedNoCandidateSkipReason({
                failures: [{
                    detail: "Error: Timed out waiting for submit response for xtm-c-submitblock from localhost:20001"
                }]
            }),
            "live XTM-C daemon did not return a synthetic SubmitBlock response"
        );
    });

    test("cryptonote block-submit coverage skips live no-template logins", () => {
        const testCase = BLOCK_SUBMIT_LIVE_CASES.find((entry) => entry.name === "cryptonote-submitblock");
        assert.ok(testCase);
        assert.equal(
            testCase.expectedNoCandidateSkipReason({
                failures: [{
                    detail: 'Error: Default login failed: {"code":-1,"message":"No block template yet. Please wait."}'
                }]
            }),
            "live pool did not have a Cryptonote altcoin block template ready"
        );
        assert.equal(
            testCase.expectedNoCandidateSkipReason({
                failures: [{
                    detail: "Error: Timed out waiting for login response for cryptonote-submitblock from localhost:20001"
                }]
            }),
            "live pool did not have a Cryptonote altcoin block template ready"
        );
        assert.equal(
            testCase.expectedNoCandidateSkipReason({
                failures: [
                    { detail: 'Error: Default login failed: {"code":-1,"message":"No block template yet. Please wait."}' },
                    { detail: "Error: Submit was not accepted: synthetic failure" }
                ]
            }),
            ""
        );
    });

    test("protocol probes skip live no-job windows", () => {
        assert.equal(
            expectedLiveProtocolProbeSkipReason({
                algorithm: "autolykos2",
                protocolProbe: "eth-bad-share",
                failureReason: "job-timeout",
                connected: true,
                jobReceived: false
            }),
            "live pool did not send a protocol-probe job for autolykos2"
        );
        assert.equal(
            expectedLiveProtocolProbeSkipReason({
                algorithm: "etchash",
                protocolProbe: "eth-bad-share",
                failureReason: "job-timeout",
                connected: true,
                jobReceived: false
            }),
            "live pool did not send a protocol-probe job for etchash"
        );
        assert.equal(
            expectedLiveProtocolProbeSkipReason({
                algorithm: "etchash",
                protocolProbe: "eth-bad-share",
                failureReason: "rejection-timeout",
                connected: true,
                jobReceived: true
            }),
            ""
        );
    });

    test("rx/arq miner coverage skips live no-template windows", (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-skip-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const stdoutPath = path.join(tempDir, "stdout.log");
        fs.writeFileSync(stdoutPath, [
            'net localhost:20001 error: "No block template yet. Please wait.", code: -1',
            'net localhost:20001 read error: "end of file"'
        ].join("\n"));

        assert.equal(
            expectedLiveMinerSkipReason({
                algorithm: "rx/arq",
                failureReason: "connection-failure",
                jobReceived: false,
                rawStdoutPath: stdoutPath,
                error: 'net localhost:20001 read error: "end of file"'
            }),
            "live pool did not have an rx/arq block template ready"
        );
    });

    test("MoM no-accepted-share results fail instead of being skipped", () => {
        const failedMoM = {
            algorithm: "pearlhash",
            miner: "mom",
            success: false,
            failureReason: "no-accepted-share",
            acceptedShares: 0
        };
        assert.equal(expectedLiveMinerSkipReason(failedMoM), "");
        assert.equal(expectedLiveMinerSkipReason({
            ...failedMoM,
            algorithm: "future-mom-algo"
        }), "");
        assert.equal(expectedLiveMinerSkipReason({
            ...failedMoM,
            miner: "srbminer"
        }), "no accepted share before timeout on this host");
        assert.equal(expectedLiveMinerSkipReason({
            ...failedMoM,
            success: true,
            acceptedShares: 1
        }), "");
    });

    test("miner attempt duration measures the wall-clock bounded run", async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-duration-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const fixtureCode = [
            "process.stdout.write('Connected to fixture pool\\n');",
            "process.stdout.write('Got new pearlhash algo job with 1 TH/share target\\n');",
            "process.on('SIGINT', () => process.exit(0));",
            "setInterval(() => {}, 1000);"
        ].join("");
        const miner = {
            name: "mom",
            binaryPath: process.execPath,
            parser(line, metrics) {
                if (line.includes("Connected to")) metrics.connected = true;
                if (line.includes("Got new pearlhash algo job")) {
                    metrics.jobReceived = true;
                    metrics.jobAtMs = metrics.jobAtMs || Date.now();
                }
            },
            buildArgs: () => ["-e", fixtureCode]
        };
        const config = {
            runId: "duration-fixture",
            targetAcceptedShares: 1,
            timeoutMs: 40
        };
        const result = await executeScenario({
            config,
            runDir: tempDir,
            logger: { event() {} },
            allocateWallet: () => "fixture"
        }, {
            algorithm: "pearlhash",
            miner,
            successCriterion: "accepted-share"
        }, {
            name: "fixture",
            host: "fixture.invalid",
            port: 1
        });

        assert.equal(result.success, false);
        assert.equal(result.failureReason, "no-accepted-share");
        assert.equal(result.connected, true);
        assert.equal(result.jobReceived, true);
        assert.ok(result.durationMs >= 900, `expected wall duration, got ${result.durationMs}ms`);
    });

    test("owned-tree refresh rejects a reused parent PID", async (t) => {
        if (process.platform !== "linux") {
            t.skip("Linux process identity fixture required");
            return;
        }

        let phase = "initial";
        let root = { pid: 501, ppid: 1, startTicks: "old", state: "S" };
        let childrenReads = 0;
        const readers = {
            async readIdentity(pid) {
                if (pid === root.pid) return root;
                if (pid === 601) return { pid, ppid: 501, startTicks: "child", state: "S" };
                return null;
            },
            async readChildren() {
                childrenReads += 1;
                return phase === "initial" ? [] : [601];
            }
        };
        const ownership = await captureOwnedProcessTree(root.pid, readers);
        phase = "reused";
        root = { ...root, startTicks: "new" };
        await refreshOwnedProcessTree(ownership);

        assert.equal(ownership.processes.size, 1);
        assert.equal(childrenReads, 1);
        assert.equal(ownership.launcherExitedBeforeSnapshot, true);
    });

    test("miner stop closes owned descendants and logs only scalar start fields", async (t) => {
        if (process.platform !== "linux") {
            t.skip("Linux process identity fixture required");
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodejs-pool-live-descendants-"));
        t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
        const markerPath = path.join(tempDir, "descendant.pid");
        let descendantPid = 0;
        let descendantStartTicks = "";
        const readStartTicks = (pid) => {
            try {
                const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
                const closeParen = stat.lastIndexOf(") ");
                return closeParen < 0 ? "" : stat.slice(closeParen + 2).trim().split(/\s+/)[19] || "";
            } catch (_error) {
                return "";
            }
        };
        t.after(() => {
            if (descendantPid && descendantStartTicks && readStartTicks(descendantPid) === descendantStartTicks) {
                try {
                    process.kill(descendantPid, "SIGKILL");
                } catch (_error) {
                    // The owned fixture may already have exited.
                }
            }
        });

        const descendantCode = "process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);";
        const fixtureCode = [
            "const fs = require('node:fs');",
            "const { spawn } = require('node:child_process');",
            `const marker = ${JSON.stringify(markerPath)};`,
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' });`,
            "fs.writeFileSync(marker, String(child.pid));",
            "process.stdout.write('Connected to fixture pool\\n');",
            "process.stdout.write('Accepted share\\n');",
            "process.on('SIGINT', () => process.exit(0));",
            "setInterval(() => {}, 1000);"
        ].join("");
        const events = [];
        const miner = {
            name: "fixture-miner",
            binaryPath: process.execPath,
            parser(line, metrics) {
                if (line.includes("Connected to")) metrics.connected = true;
                if (line.includes("Accepted share")) metrics.acceptedShares = 1;
            },
            buildArgs: () => ["-e", fixtureCode]
        };
        const result = await executeScenario({
            config: {
                runId: "descendant-fixture",
                targetAcceptedShares: 1,
                timeoutMs: 3000
            },
            runDir: tempDir,
            logger: { event: (name, payload) => events.push({ name, payload }) },
            allocateWallet: () => "fixture"
        }, {
            algorithm: "fixture-algo",
            miner,
            successCriterion: "accepted-share"
        }, {
            name: "fixture-target",
            host: "fixture.invalid",
            port: 1
        });

        descendantPid = Number(fs.readFileSync(markerPath, "utf8"));
        descendantStartTicks = readStartTicks(descendantPid);
        assert.equal(result.success, true);
        assert.equal(result.processCleanupComplete, true);
        assert.equal(result.processCleanupNatural, true);
        assert.equal(result.processCleanupForced, false);
        assert.equal(result.closeObserved, true);
        assert.ok(result.ownedProcessCount >= 2);
        assert.equal(result.remainingProcessCount, 0);
        assert.equal(result.processCleanupQueryFailures, 0);
        assert.equal(readStartTicks(descendantPid), "");

        const startEvent = events.find((entry) => entry.name === "attempt.start");
        assert.ok(startEvent);
        assert.deepEqual(Object.keys(startEvent.payload).sort(), [
            "algorithm",
            "attempt",
            "miner",
            "successCriterion",
            "targetAcceptedShares",
            "timeoutMs"
        ]);
        for (const forbidden of ["args", "wallet", "password", "host", "port", "target"]) {
            assert.equal(Object.hasOwn(startEvent.payload, forbidden), false, forbidden);
        }
    });

    test("xmr dual block-submit expectation allows daemon retry outcomes", () => {
        const worker = "itest-worker";
        const logText = [
            `2026-05-01 [S1] Block submit failed: chain=XMR/18081 height=1 miner="abc:${worker} (127.0.0.1)" trusted=true`,
            `2026-05-01 [S1] Block submit unknown: chain=XTM/18144 height=1 miner="abc:${worker} (127.0.0.1)" trusted=true`,
            `2026-05-01 [S1] Block submit rpc-error: chain=XTM/18144 height=1 miner="abc:${worker} (127.0.0.1)" trusted=true`
        ].join("\n");

        assert.equal(matchesBlockSubmitExpectation(logText, { minOutcomeCount: 2, includeChains: ["XMR/", "XTM/"] }, worker), true);
        assert.equal(matchesBlockSubmitExpectation(logText, { exactFailureCount: 2, includeChains: ["XMR/", "XTM/"] }, worker), false);
        assert.deepEqual(summarizeBlockSubmitLog(logText, worker), {
            outcomeCount: 3,
            failureCount: 1,
            unknownCount: 1,
            rpcErrorCount: 1,
            unresolvedHashCount: 0,
            rejectedCount: 0,
            chains: ["XMR/18081", "XTM/18144", "XTM/18144"]
        });
    });
});
