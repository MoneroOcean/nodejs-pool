"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLogger, ensureDir, writeJson } = require("./live/shared");
const { finalizeLivePoolRun, formatFailureDetails, formatSummary } = require("./live/runner");
const { openLogStreams } = require("./live/attempts");

test.describe("Live diagnostic privacy", () => {
    test("structured events omit private values and nested payloads", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pool-live-privacy-"));
        try {
            const logger = createLogger(dir);
            logger.event("miner_start", {
                algorithm: "c29", acceptedShares: 2, success: true,
                args: ["private-canary"], wallet: "private-canary", host: "private-canary",
                port: 12345, line: "private-canary", error: "private-canary",
                nested: { algorithm: "private-canary" },
                miner: { command: "private-canary" }
            });
            await logger.close();
            const text = await fs.readFile(logger.eventPath, "utf8");
            assert.equal(text.includes("private-canary"), false);
            const entry = JSON.parse(text);
            assert.equal(entry.algorithm, "c29");
            assert.equal(entry.acceptedShares, 2);
            assert.equal(entry.success, true);
            assert.equal(Object.hasOwn(entry, "port"), false);
            assert.equal(Object.hasOwn(entry, "miner"), false);
            if (process.platform !== "win32") assert.equal((await fs.stat(logger.eventPath)).mode & 0o777, 0o600);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    test("failure output never echoes raw errors or miner captures", async () => {
        const summary = {
            exitCode: 1, failureCount: 1, unsupportedAlgorithmCount: 0,
            error: "private-canary", errorDetail: "private-canary",
            results: [{ miner: "private-canary", algorithm: "private-canary", target: {
                success: false, acceptedShares: 1, rejectedShares: 2, invalidShares: 3,
                rawStdoutPath: "private-canary", rawStderrPath: "private-canary"
            } }]
        };
        const output = formatSummary(summary) + await formatFailureDetails(summary);
        assert.equal(output.includes("private-canary"), false);
        assert.match(output, /accepted=1, rejected=2, invalid=3/);
        assert.equal(await formatFailureDetails(null), "");
        assert.equal(await formatFailureDetails({ results: [{ target: { success: true } }] }), "");
    });

    test("run summaries omit wallet and endpoint configuration", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pool-live-summary-"));
        try {
            const logger = createLogger(dir);
            const summary = await finalizeLivePoolRun({
                runDir: dir, logger, config: {
                    runId: "fixture", wallet: "private-canary", targetHost: "private-canary",
                    targetPort: 12345, tls: true, difficulty: 1, threads: 1, timeoutMs: 100
                }, algorithms: [], miners: [], coveragePlan: [], unsupportedAlgorithms: []
            }, [], null);
            assert.equal(JSON.stringify(summary.configuration).includes("private-canary"), false);
            assert.equal(Object.hasOwn(summary.configuration, "targetPort"), false);
            assert.equal(summary.configuration.tls, true);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    test("new run directories and JSON evidence are private", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pool-live-modes-"));
        try {
            const leaf = path.join(dir, "run");
            await ensureDir(leaf);
            const file = path.join(leaf, "receipt.json");
            await writeJson(file, { passed: true });
            if (process.platform !== "win32") {
                assert.equal((await fs.stat(leaf)).mode & 0o777, 0o700);
                assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
            }
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    test("raw attempt captures are private under a permissive umask", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pool-live-attempt-modes-"));
        const previousUmask = process.umask(0o000);
        try {
            const streams = openLogStreams(path.join(dir, "stdout.raw"), path.join(dir, "stderr.raw"));
            await Promise.all(Object.values(streams).map((stream) => new Promise((resolve) => stream.end(resolve))));
            assert.equal((await fs.stat(path.join(dir, "stdout.raw"))).mode & 0o777, 0o600);
            assert.equal((await fs.stat(path.join(dir, "stderr.raw"))).mode & 0o777, 0o600);
        } finally {
            process.umask(previousUmask);
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
