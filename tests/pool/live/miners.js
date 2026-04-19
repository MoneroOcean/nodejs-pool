"use strict";

const path = require("node:path");

const {
    DEFAULT_MOMINER_DOCKER_IMAGE,
    DIFF_SCALE,
    HASHRATE_SCALE,
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
    sanitizeName,
    shortAlgoName,
    commandExists,
    fileExistsSync,
    writeJson
} = require("./shared.js");
const { runCommand } = require("./downloads.js");

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

module.exports = {
    buildXmrigMiner,
    buildSrbMiner,
    buildMoMiner,
    writeXmrigSeedConfig,
    getActiveAlgorithms,
    buildCoveragePlan,
    makeWorkerName,
    stopProcess,
    summarizeLatency,
    hasMetSuccessCriterion,
    determineFailureReason
};
