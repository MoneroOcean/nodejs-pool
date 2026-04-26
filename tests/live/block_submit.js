"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const {
    ROOT_DIR,
    DEFAULT_TARGET_HOST,
    DEFAULT_TARGET_PORT,
    BLOCK_SUBMIT_TEST_MARKER_PATH,
    BLOCK_SUBMIT_TEST_MODE_WAIT_MS,
    ensureDir,
    sleep,
    emitLiveStatus,
    firstLine,
    fileExistsSync,
    readTextFileIfExists,
    sanitizeName
} = require("./shared.js");
const { runCommand } = require("./downloads.js");
const { makeWorkerName } = require("./miners.js");
const {
    JsonLineSocketClient,
    BLOCK_SUBMIT_ATTEMPT_TIMEOUT_MS,
    parseLatestTemplateSnapshot,
    buildCandidateMatrix,
    buildXmrOnlyResultHexes,
    buildLowDiffResultHexes,
    readLocalXmrTemplateMetadata,
    getBlockSubmitOutcomeEntries,
    matchesBlockSubmitExpectation,
    summarizeBlockSubmitLog,
    isSuccessfulSubmitResponse,
    buildDefaultBlockSubmitPayload,
    buildC29BlockSubmitPayload,
    buildEthBlockSubmitParams,
    buildRavenBlockSubmitParams
} = require("./protocol.js");

const BLOCK_SUBMIT_LOGIN_DIFF_CANDIDATES = Object.freeze([null, 10, 100, 1000, 10000, 100000, 1000000]);
const BLOCK_SUBMIT_LIVE_CASES = Object.freeze([
    {
        name: "xmr-main-xmr-only",
        protocol: "default-standard",
        algo: "rx/0",
        expectation: { exactFailureCount: 1, includeChains: ["XMR/"], excludeChains: ["XTM/"] },
        buildCandidates(context) { return buildCandidateMatrix(buildXmrOnlyResultHexes(context.xmrTemplate), BLOCK_SUBMIT_LOGIN_DIFF_CANDIDATES); }
    },
    { name: "xmr-main-dual", protocol: "default-standard", algo: "rx/0", expectation: { exactFailureCount: 2, includeChains: ["XMR/", "XTM/"] }, buildCandidates() { return buildCandidateMatrix(["00".repeat(32)], BLOCK_SUBMIT_LOGIN_DIFF_CANDIDATES); } },
    {
        name: "xmr-main-low-diff",
        protocol: "default-standard",
        algo: "rx/0",
        expectation: { exactFailureCount: 2, includeChains: ["XMR/", "XTM/"] },
        skipReason(context) {
            if (!context || !context.xmrMainDifficulty) return "missing main difficulty";
            if (context.xmrMainDifficulty >= context.xmrTemplate.primaryDiff) return "current template has no low-diff fallback window";
            return "";
        },
        buildCandidates(context) { return buildCandidateMatrix(buildLowDiffResultHexes(context.xmrTemplate), BLOCK_SUBMIT_LOGIN_DIFF_CANDIDATES); }
    },
    { name: "cryptonote-submitblock", protocol: "default-standard", algo: "rx/arq", expectation: { exactFailureCount: 1, includeAnyChains: ["ARQ/", "SAL/", "ZEPH/", "RYO/", "XLA/"] }, buildCandidates() { return buildCandidateMatrix(["00".repeat(32)], [null]); } },
    { name: "btc-submitblock", protocol: "raven", algo: "kawpow", expectation: { exactFailureCount: 1, includeAnyChains: ["RVN/", "XNA/"] }, buildCandidates() { return buildCandidateMatrix(["00".repeat(32)], [null]); } },
    { name: "xtm-c-submitblock", protocol: "default-c29", algo: "c29", expectation: { exactFailureCount: 1, includeChains: ["XTM-C/"] }, buildCandidates() { return buildCandidateMatrix(["00".repeat(32)], [null]); } },
    { name: "eth-submitwork", protocol: "eth", algo: "etchash", expectation: { exactFailureCount: 1, includeChains: ["ETC/"] }, buildCandidates() { return buildCandidateMatrix(["00".repeat(32)], [null]); } },
    { name: "erg-submitblock", protocol: "eth", algo: "autolykos2", expectation: { exactFailureCount: 1, includeChains: ["ERG/"] }, buildCandidates() { return buildCandidateMatrix(["00".repeat(32)], [null]); } }
]);

function openLogStreams(stdoutPath, stderrPath) { return { stdout: fs.createWriteStream(stdoutPath, { flags: "a" }), stderr: fs.createWriteStream(stderrPath, { flags: "a" }) }; }
const closeStreams = async (...streams) => await Promise.all(streams.filter(Boolean).map((stream) => new Promise((resolve) => stream.end(resolve))));

function createBlockSubmitAttemptFiles(run, caseName) {
    const attemptId = `block-submit-${sanitizeName(caseName)}`;
    return {
        attemptId,
        attemptDir: path.join(run.runDir, "attempts", attemptId),
        rawStdoutPath: path.join(run.runDir, "attempts", attemptId, "stdout.log"),
        rawStderrPath: path.join(run.runDir, "attempts", attemptId, "stderr.log"),
        poolStderrPath: path.join(run.runDir, "attempts", attemptId, "pool-stderr.log"),
        poolStdoutPath: path.join(run.runDir, "attempts", attemptId, "pool-stdout.log"),
        wallet: run.allocateWallet(attemptId),
        worker: makeWorkerName(run.config, attemptId, "block", 1),
        startedAtMs: Date.now()
    };
}

async function readFileBytesFromOffset(filePath, offset = 0) { return (await fsp.readFile(filePath).catch(() => Buffer.alloc(0))).subarray(Math.max(0, offset)); }
async function getFileSize(filePath) { return await fsp.stat(filePath).then((stats) => stats.size, () => 0); }

async function resolvePm2PoolProcess() {
    const output = await runCommand("pm2", ["jlist"], { cwd: ROOT_DIR });
    let processes;
    try {
        processes = JSON.parse(output.stdout);
    } catch (error) {
        throw new Error(`Failed to parse pm2 jlist output: ${error.message}`);
    }

    const poolProcess = Array.isArray(processes) ? processes.find((entry) => entry && entry.name === "pool") : null;
    if (!poolProcess) throw new Error("Could not find pm2 process named 'pool'.");

    const errLogPath = poolProcess.pm2_env && poolProcess.pm2_env.pm_err_log_path;
    if (typeof errLogPath !== "string" || !errLogPath) {
        throw new Error("pm2 'pool' process did not expose pm_err_log_path.");
    }
    const outLogPath = poolProcess.pm2_env && poolProcess.pm2_env.pm_out_log_path;
    if (typeof outLogPath !== "string" || !outLogPath) {
        throw new Error("pm2 'pool' process did not expose pm_out_log_path.");
    }

    return { errLogPath, outLogPath, cwd: poolProcess.pm2_env && poolProcess.pm2_env.pm_cwd ? poolProcess.pm2_env.pm_cwd : ROOT_DIR };
}

async function waitForPoolErrorLog(logPath, startOffset, predicate, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    while (Date.now() < deadline) {
        lastText = (await readFileBytesFromOffset(logPath, startOffset)).toString("utf8");
        if (predicate(lastText)) return lastText;
        await sleep(250);
    }
    throw new Error(`${description}\n${lastText.slice(-4000)}`);
}

async function readPm2LogBundle(logPaths, startOffsets) {
    const [stderrText, stdoutText] = await Promise.all([
        logPaths.err ? readFileBytesFromOffset(logPaths.err, startOffsets.err || 0).then((buffer) => buffer.toString("utf8")) : "",
        logPaths.out ? readFileBytesFromOffset(logPaths.out, startOffsets.out || 0).then((buffer) => buffer.toString("utf8")) : ""
    ]);
    return {
        stderrText,
        stdoutText,
        text: [stderrText, stdoutText].filter(Boolean).join("\n")
    };
}

async function waitForBlockSubmitAttemptLog(logPaths, startOffsets, expectation, timeoutMs, caseName, worker) {
    const deadline = Date.now() + timeoutMs;
    let lastBundle = { stderrText: "", stdoutText: "", text: "" };

    while (Date.now() < deadline) {
        lastBundle = await readPm2LogBundle(logPaths, startOffsets);
        if (matchesBlockSubmitExpectation(lastBundle.text, expectation, worker)) {
            await sleep(500);
            return await readPm2LogBundle(logPaths, startOffsets);
        }
        await sleep(250);
    }

    throw new Error(`Timed out waiting for pool pm2 confirmation for ${caseName}.\n${lastBundle.text.slice(-4000)}`);
}

async function writeBlockSubmitPm2Logs(files, bundle) {
    if (bundle.stderrText) await fsp.writeFile(files.poolStderrPath, bundle.stderrText);
    if (bundle.stdoutText) await fsp.writeFile(files.poolStdoutPath, bundle.stdoutText);
}

async function waitForBlockSubmitAttemptFromPm2(run, files, logPaths, startOffsets, testCase) {
    const bundle = await waitForBlockSubmitAttemptLog(
        logPaths,
        startOffsets,
        testCase.expectation,
        Math.min(run.config.timeoutMs, BLOCK_SUBMIT_ATTEMPT_TIMEOUT_MS),
        testCase.name,
        files.worker
    );
    await writeBlockSubmitPm2Logs(files, bundle);
    return { logText: bundle.text, worker: files.worker, summary: summarizeBlockSubmitLog(bundle.text, files.worker) };
}

function withFixedDifficulty(wallet, loginDiff) { return loginDiff ? `${wallet}+${loginDiff}` : wallet; }

async function withBlockSubmitAttemptClient(run, target, logPaths, testCase, candidate, fn) {
    const files = createBlockSubmitAttemptFiles(run, `${testCase.name}-${candidate.loginDiff || "auto"}-${candidate.resultHex.slice(0, 8)}`);
    await ensureDir(files.attemptDir);
    const streams = openLogStreams(files.rawStdoutPath, files.rawStderrPath);
    const startOffsets = { err: logPaths.err ? await getFileSize(logPaths.err) : 0, out: logPaths.out ? await getFileSize(logPaths.out) : 0 };
    const client = new JsonLineSocketClient(run.config, target, streams.stdout, streams.stderr);
    const user = withFixedDifficulty(files.wallet, candidate.loginDiff);

    try {
        await client.connect(run.config.timeoutMs);
        return await fn({ client, files, startOffsets, user });
    } finally {
        await client.close();
        await closeStreams(streams.stdout, streams.stderr);
    }
}

async function requestDefaultBlockSubmitLogin(run, testCase, client, files, user) {
    const loginReply = await client.request({ id: 1, jsonrpc: "2.0", method: "login", params: { login: user, pass: `${files.worker}~${testCase.algo}`, agent: "nodejs-pool-live-block-submit/1.0", rigid: files.worker } }, run.config.timeoutMs);
    if (loginReply.error || loginReply.result?.status !== "OK") {
        throw new Error(`Default login failed: ${JSON.stringify(loginReply.error || loginReply.result)}`);
    }
    return loginReply;
}

async function authorizeStratumBlockSubmit(run, testCase, client, files, user) {
    const subscribeReply = await client.request({ id: 1, method: "mining.subscribe", params: [] }, run.config.timeoutMs);
    if (subscribeReply.error) {
        throw new Error(`mining.subscribe failed for ${testCase.name}: ${JSON.stringify(subscribeReply.error)}`);
    }

    const authorizeReply = await client.request({ id: 2, method: "mining.authorize", params: [user, `${files.worker}~${testCase.algo}`] }, run.config.timeoutMs);
    if (authorizeReply.error || authorizeReply.result !== true) {
        throw new Error(`mining.authorize failed: ${JSON.stringify(authorizeReply.error || authorizeReply.result)}`);
    }
}

async function runDefaultBlockSubmitAttempt(run, target, logPaths, testCase, candidate) {
    return withBlockSubmitAttemptClient(run, target, logPaths, testCase, candidate, async ({ client, files, startOffsets, user }) => {
        const loginReply = await requestDefaultBlockSubmitLogin(run, testCase, client, files, user);
        const submitReply = await client.request({
            id: 2,
            jsonrpc: "2.0",
            method: "submit",
            params: testCase.protocol === "default-c29"
                ? buildC29BlockSubmitPayload(loginReply, candidate.resultHex)
                : buildDefaultBlockSubmitPayload(loginReply, candidate.resultHex)
        }, run.config.timeoutMs);

        if (!isSuccessfulSubmitResponse(submitReply)) throw new Error(`Submit was not accepted: ${JSON.stringify(submitReply)}`);
        return waitForBlockSubmitAttemptFromPm2(run, files, logPaths, startOffsets, testCase);
    });
}

async function runEthBlockSubmitAttempt(run, target, logPaths, testCase, candidate) {
    return withBlockSubmitAttemptClient(run, target, logPaths, testCase, candidate, async ({ client, files, startOffsets, user }) => {
        await authorizeStratumBlockSubmit(run, testCase, client, files, user);
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify", run.config.timeoutMs);
        const submitReply = await client.request({
            id: 3,
            method: "mining.submit",
            params: buildEthBlockSubmitParams(user, Array.isArray(notifyPush.params) ? String(notifyPush.params[0] || "") : "", candidate.resultHex)
        }, run.config.timeoutMs);

        if (!isSuccessfulSubmitResponse(submitReply)) throw new Error(`Submit was not accepted: ${JSON.stringify(submitReply)}`);
        return waitForBlockSubmitAttemptFromPm2(run, files, logPaths, startOffsets, testCase);
    });
}

async function runRavenBlockSubmitAttempt(run, target, logPaths, testCase, candidate) {
    return withBlockSubmitAttemptClient(run, target, logPaths, testCase, candidate, async ({ client, files, startOffsets, user }) => {
        await authorizeStratumBlockSubmit(run, testCase, client, files, user);
        await client.waitFor((message) => message.method === "mining.set_target", run.config.timeoutMs);
        const notifyPush = await client.waitFor((message) => message.method === "mining.notify", run.config.timeoutMs);
        const notifyParams = Array.isArray(notifyPush.params) ? notifyPush.params : [];
        const submitReply = await client.request({
            id: 3,
            method: "mining.submit",
            params: buildRavenBlockSubmitParams(user, String(notifyParams[0] || ""), String(notifyParams[1] || ""), candidate.resultHex)
        }, run.config.timeoutMs);

        if (!isSuccessfulSubmitResponse(submitReply)) throw new Error(`Submit was not accepted: ${JSON.stringify(submitReply)}`);
        return waitForBlockSubmitAttemptFromPm2(run, files, logPaths, startOffsets, testCase);
    });
}

async function runLiveBlockSubmitCase(run, target, logPaths, testCase, context) {
    const candidates = testCase.buildCandidates(context);
    let lastFailure = null;

    for (const candidate of candidates) {
        if (run.config.emitStartLines) {
            emitLiveStatus("try", `block submit ${testCase.name}`, `diff=${candidate.loginDiff || "auto"} result=${candidate.resultHex.slice(0, 8)}`);
        }
        run.logger.event("block-submit-coverage.case.candidate", {
            name: testCase.name,
            loginDiff: candidate.loginDiff,
            resultHex: candidate.resultHex
        });

        try {
            const attempt = testCase.protocol === "eth"
                ? await runEthBlockSubmitAttempt(run, target, logPaths, testCase, candidate)
                : testCase.protocol === "raven"
                    ? await runRavenBlockSubmitAttempt(run, target, logPaths, testCase, candidate)
                    : await runDefaultBlockSubmitAttempt(run, target, logPaths, testCase, candidate);
            if (matchesBlockSubmitExpectation(attempt.logText, testCase.expectation, attempt.worker)) return attempt.logText;
            lastFailure = `unexpected-log ${JSON.stringify(attempt.summary)}\n${attempt.logText.trimEnd()}`;
        } catch (error) {
            lastFailure = error.stack || error.message;
        }
    }

    throw new Error(`No candidate matched ${testCase.name}.\n${lastFailure || "No attempts were executed."}`);
}

async function verifyBlockSubmitTestModeDisabled(run, target, logPath, disableOffset) {
    if (fileExistsSync(BLOCK_SUBMIT_TEST_MARKER_PATH)) {
        throw new Error(`Block-submit marker file still exists after cleanup: ${BLOCK_SUBMIT_TEST_MARKER_PATH}`);
    }

    const disableLog = await waitForPoolErrorLog(
        logPath,
        disableOffset,
        (text) => text.includes("Block submit test mode: enabled=0"),
        run.config.timeoutMs,
        "Timed out waiting for the pool to log block-submit test mode disable."
    );

    await withBlockSubmitAttemptClient(run, target, { err: logPath }, { name: "marker-removed-check" }, { loginDiff: null, resultHex: "00".repeat(32) }, async ({ client, files, startOffsets, user }) => {
        const loginReply = await client.request({
            id: 1,
            jsonrpc: "2.0",
            method: "login",
            params: {
                login: user,
                pass: `${files.worker}~rx/0`,
                agent: "nodejs-pool-live-block-submit/1.0",
                rigid: files.worker
            }
        }, run.config.timeoutMs);
        if (loginReply.error || loginReply.result?.status !== "OK") {
            throw new Error(`Post-marker login failed: ${JSON.stringify(loginReply.error || loginReply.result)}`);
        }
        const submitReply = await client.request({
            id: 2,
            jsonrpc: "2.0",
            method: "submit",
            params: buildDefaultBlockSubmitPayload(loginReply, "00".repeat(32))
        }, run.config.timeoutMs);

        if (isSuccessfulSubmitResponse(submitReply)) {
            throw new Error(`Post-marker submit unexpectedly succeeded: ${JSON.stringify(submitReply)}`);
        }
        await sleep(500);
        const logText = (await readFileBytesFromOffset(logPath, startOffsets.err)).toString("utf8");
        if (logText.includes("Block submit failed:")) {
            throw new Error(`Pool still attempted block submission after marker removal:\n${logText.trimEnd()}`);
        }
        await fsp.writeFile(files.poolStderrPath, `${disableLog}${logText}`);
    });
}

async function runPostBlockSubmitCoverageLoginSanityCheck(run, target) {
    await withBlockSubmitAttemptClient(run, target, {}, { name: "post-block-submit-coverage-login" }, { loginDiff: null, resultHex: "00".repeat(32) }, async ({ client, files, user }) => {
        const loginReply = await client.request({
            id: 1,
            jsonrpc: "2.0",
            method: "login",
            params: {
                login: user,
                pass: `${files.worker}~rx/0`,
                agent: "nodejs-pool-live-sanity/1.0",
                rigid: files.worker
            }
        }, run.config.timeoutMs);

        if (loginReply.error || loginReply.result?.status !== "OK") {
            throw new Error(`Post-block-submit coverage sanity login failed: ${JSON.stringify(loginReply.error || loginReply.result)}`);
        }
    });
}

async function setupLiveBlockSubmitCoverage(run) {
    if (run.config.targetHost !== DEFAULT_TARGET_HOST || run.config.targetPort !== DEFAULT_TARGET_PORT) return null;
    const pm2Pool = await resolvePm2PoolProcess();
    if (path.resolve(pm2Pool.cwd) !== ROOT_DIR) {
        throw new Error(`pm2 'pool' process cwd did not match ${ROOT_DIR}: ${pm2Pool.cwd}`);
    }
    const xmrTemplate =
        parseLatestTemplateSnapshot(await readTextFileIfExists(pm2Pool.outLogPath), "XMR/") ||
        parseLatestTemplateSnapshot(await readTextFileIfExists(pm2Pool.errLogPath), "XMR/");
    if (!xmrTemplate) {
        throw new Error(`Could not find an XMR template line in the pool pm2 logs: stdout=${pm2Pool.outLogPath} stderr=${pm2Pool.errLogPath}`);
    }
    const xmrTemplateMetadata = await readLocalXmrTemplateMetadata();
    const context = { xmrTemplate, xmrMainDifficulty: xmrTemplateMetadata.mainDifficulty };
    if (run.config.emitStartLines) emitLiveStatus("start", "block submit coverage");
    run.logger.event("block-submit-coverage.start", {
        markerPath: BLOCK_SUBMIT_TEST_MARKER_PATH,
        templateLogPath: pm2Pool.outLogPath,
        rejectLogPath: pm2Pool.errLogPath
    });
    await fsp.writeFile(BLOCK_SUBMIT_TEST_MARKER_PATH, `${new Date().toISOString()}\n`);
    await sleep(BLOCK_SUBMIT_TEST_MODE_WAIT_MS);

    return { context, pm2Pool, logPaths: { err: pm2Pool.errLogPath, out: pm2Pool.outLogPath }, cleanedUp: false };
}

async function executeLiveBlockSubmitCoverageCase(run, target, coverage, testCase) {
    const skipReason = typeof testCase.skipReason === "function" ? testCase.skipReason(coverage.context) : "";
    if (skipReason) {
        if (run.config.emitStartLines) emitLiveStatus("skip", `block submit ${testCase.name}`, skipReason);
        run.logger.event("block-submit-coverage.case.skip", { name: testCase.name, protocol: testCase.protocol, algo: testCase.algo, reason: skipReason });
        return { skipped: true, skipReason };
    }

    if (run.config.emitStartLines) emitLiveStatus("start", `block submit ${testCase.name}`, `algo=${testCase.algo}`);
    run.logger.event("block-submit-coverage.case.start", { name: testCase.name, protocol: testCase.protocol, algo: testCase.algo });
    try {
        const logText = await runLiveBlockSubmitCase(run, target, coverage.logPaths, testCase, coverage.context);
        if (run.config.emitStartLines) emitLiveStatus("pass", `block submit ${testCase.name}`);
        run.logger.event("block-submit-coverage.case.finish", { name: testCase.name });
        return { skipped: false, logText };
    } catch (error) {
        if (run.config.emitStartLines) emitLiveStatus("fail", `block submit ${testCase.name}`, firstLine(error.message || error.stack));
        throw error;
    }
}

async function cleanupLiveBlockSubmitCoverage(run, target, coverage) {
    if (!coverage || coverage.cleanedUp) return;

    try {
        const disableOffset = await getFileSize(coverage.pm2Pool.errLogPath);
        await fsp.rm(BLOCK_SUBMIT_TEST_MARKER_PATH, { force: true });
        if (fileExistsSync(BLOCK_SUBMIT_TEST_MARKER_PATH)) throw new Error(`Failed to delete block-submit marker file: ${BLOCK_SUBMIT_TEST_MARKER_PATH}`);
        await sleep(BLOCK_SUBMIT_TEST_MODE_WAIT_MS);
        await verifyBlockSubmitTestModeDisabled(run, target, coverage.pm2Pool.errLogPath, disableOffset);
        await runPostBlockSubmitCoverageLoginSanityCheck(run, target);
        if (run.config.emitStartLines) emitLiveStatus("pass", "block submit coverage");
        run.logger.event("block-submit-coverage.finish", {});
    } finally {
        coverage.cleanedUp = true;
    }
}

module.exports = {
    BLOCK_SUBMIT_LIVE_CASES,
    cleanupLiveBlockSubmitCoverage,
    executeLiveBlockSubmitCoverageCase,
    getBlockSubmitOutcomeEntries,
    matchesBlockSubmitExpectation,
    setupLiveBlockSubmitCoverage,
    summarizeBlockSubmitLog
};
