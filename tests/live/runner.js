"use strict";

const path = require("node:path");

const parseArgv = require("../../parse_args.js");

const {
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
    EMBEDDED_ACTIVE_ALGOS,
    SRBMINER_INTEL_ALGORITHM_MAP,
    MOMINER_INTEL_ALGOS,
    GPU_PROTOCOL_PROBE_ALGOS,
    buildRunId,
    ensureDir,
    writeJson,
    formatReadableTime,
    emitLiveStatus,
    firstLine,
    tailText,
    readTextFileIfExists,
    detectIntelGpu,
    createLogger,
    createRandomWalletAllocator
} = require("./shared.js");
const {
    ensureXmrigBinary,
    ensureSrbMinerBinary,
    ensureMoMinerRoot
} = require("./downloads.js");
const {
    buildXmrigMiner,
    buildSrbMiner,
    buildMoMiner,
    getActiveAlgorithms,
    buildCoveragePlan
} = require("./miners.js");
const {
    isPoolEndpointReachable,
    hasGpuProtocolProbe
} = require("./protocol.js");
const {
    executeScenario,
    executeProtocolProbeBatch
} = require("./attempts.js");
const {
    BLOCK_SUBMIT_LIVE_CASES,
    cleanupLiveBlockSubmitCoverage,
    executeLiveBlockSubmitCoverageCase,
    getBlockSubmitOutcomeEntries,
    matchesBlockSubmitExpectation,
    setupLiveBlockSubmitCoverage,
    summarizeBlockSubmitLog
} = require("./block_submit.js");

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
    const failureCount = summary.failureCount || 0;
    const unsupportedCount = summary.unsupportedAlgorithmCount || 0;
    if ((summary.exitCode || 0) === 0) return "live suite passed";

    const parts = [];
    if (failureCount) parts.push(`${failureCount} ${failureCount === 1 ? "failure" : "failures"}`);
    if (unsupportedCount) parts.push(`${unsupportedCount} unsupported ${unsupportedCount === 1 ? "algorithm" : "algorithms"}`);
    return [
        `live suite failed: ${parts.join(", ") || "unknown error"}`,
        summary.error ? `reason: ${summary.error}` : ""
    ].filter(Boolean).join("\n");
}

async function formatFailureDetails(summary) {
    if (!summary) return "";
    const sections = [];
    if (summary.errorDetail) sections.push(tailText(summary.errorDetail, 8000));
    if (!Array.isArray(summary.results)) return sections.join("\n\n");
    for (const result of summary.results) {
        if (result.target?.success) continue;
        const stdoutText = await readTextFileIfExists(result.target.rawStdoutPath);
        const stderrText = await readTextFileIfExists(result.target.rawStderrPath);
        sections.push([
            `[${result.algorithm}] ${result.target.failureReason || result.target.error || "failed"}`,
            stdoutText ? tailText(stdoutText, 4000) : "<stdout empty>",
            stderrText ? `stderr:\n${tailText(stderrText, 4000)}` : ""
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

    if (!(await isPoolEndpointReachable(config.targetHost, config.targetPort, config.tls))) {
        throw new Error(`No live pool endpoint responded on ${config.targetHost}:${config.targetPort}.`);
    }

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
        const allocateWallet = createRandomWalletAllocator(config.wallet, logger);

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
            allocateWallet,
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
                algorithms: run.algorithms.map((entry) => entry.algorithm),
                unsupportedAlgorithms,
                results: coveredResults,
                error: firstLine(error.message || error.stack),
                errorDetail: error.stack || error.message,
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
        emitStartLines: typeof options.emitStartLines === "boolean" ? options.emitStartLines : true
    };
}

const isDefaultTargetReachable = () => isPoolEndpointReachable(DEFAULT_TARGET_HOST, DEFAULT_TARGET_PORT, buildConfig().tls);

function parseCliOptions(argv) {
    const parsed = parseArgv(argv, {});
    return { help: !!(parsed.help || parsed.h), targetHost: parsed["target-host"] };
}

function renderCliHelp() {
    return [
        "Usage: node ./tests/live.js [options]",
        "",
        "Runs live miner checks against a target pool.",
        "",
        "Options:",
        "  --target-host <host>        Pool under test host or IP",
        "  --help                      Show this message"
    ].join("\n");
}

async function writeStandaloneFailureSummary(input, error) {
    const config = buildConfig(input);
    const runDir = path.join(config.logDir, config.runId);
    const summary = {
        runId: config.runId,
        generatedAt: new Date().toISOString(),
        logDir: runDir,
        error: firstLine(error.message || error.stack),
        errorDetail: error.stack || error.message,
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
        const target = { name: run.config.targetName, host: run.config.targetHost, port: run.config.targetPort };
        const blockSubmitCoverage = await setupLiveBlockSubmitCoverage(run);
        if (blockSubmitCoverage) {
            try {
                for (const testCase of BLOCK_SUBMIT_LIVE_CASES) {
                    await executeLiveBlockSubmitCoverageCase(run, target, blockSubmitCoverage, testCase);
                }
            } finally {
                await cleanupLiveBlockSubmitCoverage(run, target, blockSubmitCoverage);
            }
        }
        if (run.config.emitStartLines) {
            emitLiveStatus("start", "coverage");
        }

        for (const plan of run.coveredPlans.filter((entry) => !hasGpuProtocolProbe(entry))) {
            const result = await executeScenario(run, plan, target);
            if (run.config.emitStartLines) {
                emitLiveStatus(result.success ? "pass" : "fail", `algo ${plan.algorithm}`, result.success ? "" : (result.failureReason || result.error || "failed"));
            }
            coveredResults.push({ algorithm: plan.algorithm, miner: plan.miner ? plan.miner.name : "protocol-probe", target: result });
        }

        const protocolPlans = run.coveredPlans.filter(hasGpuProtocolProbe);
        if (protocolPlans.length) {
            for (const result of await executeProtocolProbeBatch(run, protocolPlans, target)) {
                if (run.config.emitStartLines) {
                    emitLiveStatus(result.success ? "pass" : "fail", `probe ${result.algorithm}`, result.success ? "" : (result.failureReason || result.error || "failed"));
                }
                coveredResults.push({ algorithm: result.algorithm, miner: result.miner, target: result });
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
    renderCliHelp,
    runFromCli,
    BLOCK_SUBMIT_LIVE_CASES,
    cleanupLiveBlockSubmitCoverage,
    executeLiveBlockSubmitCoverageCase,
    getBlockSubmitOutcomeEntries,
    matchesBlockSubmitExpectation,
    summarizeBlockSubmitLog,
    setupLiveBlockSubmitCoverage,
    runLivePoolSuite
};
