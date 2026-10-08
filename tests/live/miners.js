"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");

const {
    DIFF_SCALE,
    HASHRATE_SCALE,
    EMBEDDED_ACTIVE_ALGOS,
    OPTIONAL_ACTIVE_ALGOS,
    SRBMINER_INTEL_ALGORITHM_MAP,
    MOM_NO_BENCH_ALGOS,
    XMRIG_CPU_ALGOS,
    XMRIG_ALGO_PERF_SEED,
    SRBMINER_NICEHASH_STRATUM_ALGOS,
    MOM_INTEL_ALGOS,
    GPU_PROTOCOL_PROBE_ALGOS,
    stripAnsi,
    sleep,
    sanitizeName,
    shortAlgoName,
    writeJson
} = require("./shared.js");

const PROCESS_TREE_SUPPORTED = process.platform === "linux";
const PROCESS_TREE_MAX = 128;
const PROCESS_SIGNAL_GRACE_MS = 1000;
const PROCESS_TERM_GRACE_MS = 1500;
const PROCESS_POLL_MS = 50;

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
    const baseParser = createMinerParser({
        connect: /\b(connected|logged in|authorized|subscribed|set difficulty)\b/i,
        job: /\b(new job|job received|job from|set difficulty|difficulty)\b/i,
        jobExclude: /\b(no job|job timeout)\b/i,
        extractAlgorithm: (line) => line.match(/\balgo(?:rithm)?\s+([^\s,]+)/i)?.[1] || "",
        extractDifficulty: (line) => line.match(/\bdiff(?:iculty)?\s+([^\s,]+)/i)?.[1] || "",
        accepted: /\b(share|result)\s+accepted\b|\baccepted\s+(share|result)\b/i,
        rejected: /\b(share|result)\s+rejected\b|\brejected\s+(share|result)\b/i,
        invalid: /\binvalid\b.*\bshare\b|\bshare\b.*\binvalid\b/i,
        error: /\b(no active pools|connect error|connection refused|socket error|network error|failed to resolve|retry|job timeout|parse error)\b/i,
        retry: /\bretry\b/i,
        disconnect: /\b(disconnect|connection closed|reconnect)\b/i,
        hashrate: parseSrbMinerHashrate
    });
    return function parseSrbMinerLine(line, metrics) {
        const matched = baseParser(line, metrics);
        return parseSrbMinerShareTable(line, metrics) || matched;
    };
}

function parseSrbMinerShareTable(line, metrics) {
    const cleanLine = stripAnsi(line);
    const match = cleanLine.match(/\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
    if (!match || !/\b(?:Total|GPU\d+)\b/i.test(cleanLine)) return false;
    const accepted = Number.parseInt(match[1], 10);
    const rejected = Number.parseInt(match[2], 10);
    const invalid = Number.parseInt(match[3], 10);
    if (Number.isFinite(accepted) && accepted > metrics.acceptedShares) {
        metrics.acceptedShares = accepted;
        metrics.firstAcceptedAtMs = metrics.firstAcceptedAtMs || Date.now();
    }
    if (Number.isFinite(rejected) && rejected > metrics.rejectedShares) metrics.rejectedShares = rejected;
    if (Number.isFinite(invalid) && invalid > metrics.invalidShares) metrics.invalidShares = invalid;
    return true;
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
                "--enable-workers-ramp-up",
                "--api-enable",
                "--api-port", String(context.srbMinerApiPort),
                "--api-rig-name", context.worker,
                "--keepalive", "true",
                "--max-no-share-sent", String(Math.ceil(context.timeoutMs / 1000)),
                "--give-up-limit", "1"
            ];

            if (context.srbMinerGpuIntensity) {
                args.push("--gpu-intensity", context.srbMinerGpuIntensity);
            }

            if (context.algorithm === "cn/gpu") {
                const srbMinerLogPath = context.srbMinerLogPath || path.join(context.attemptDir || process.cwd(), "srbminer.log");
                args.push(
                    "--log-file", srbMinerLogPath,
                    "--log-file-mode", "0",
                    "--gpu-disable-interleaving",
                    "--disable-gpu-dual-kernels",
                    "--autotune-no-load",
                    "--busy-wait-recheck", "0.01",
                    "--extended-log"
                );
            }

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
            donate_length: 60,
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
        algo_params: Object.fromEntries(MOM_NO_BENCH_ALGOS.map((algorithm) => [algorithm, {
            dev: algorithm === "c29" || algorithm === "cn/gpu" || algorithm === "pearlhash"
                ? context.moMinerC29Device
                : "cpu",
            perf: 1
        }])),
        default_msrs: {},
        log_level: 0,
        // The default benchmark mode includes active GPU algorithms (including PearlHash) and can
        // delay or destabilize a short live probe. 0 skips all benchmarking and goes straight to
        // the pool job.
        bench_algo_params: 0
    };
}

function buildMoMiner(rootDir, binaryPath) {
    return {
        name: "mom",
        binaryPath,
        rootDir,
        algorithms: new Set(MOM_INTEL_ALGOS),
        parser: createMoMinerParser(),
        style: "mom",
        async prepare(context) {
            const configPath = path.join(context.attemptDir, "mom-config.json");
            await writeJson(configPath, buildMoMinerNoBenchConfig(context));
            context.momConfigPath = configPath;
            context.momConfigArg = configPath;
        },
        buildArgs(context) {
            return ["mine", context.momConfigArg];
        },
        buildEnv(context) {
            return {
                LD_LIBRARY_PATH: [
                    this.rootDir,
                    path.join(this.rootDir, "lib"),
                    path.join(this.rootDir, "lib64"),
                    process.env.LD_LIBRARY_PATH || ""
                ].filter(Boolean).join(":"),
                MOM_CONFIG_DIR: context.attemptDir
            };
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
    const requestedAlgorithms = new Set((process.env.NODEJS_POOL_LIVE_ALGOS || "")
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean));
    const definitions = [...EMBEDDED_ACTIVE_ALGOS, ...OPTIONAL_ACTIVE_ALGOS];
    const knownAlgorithms = new Set(definitions.map((entry) => entry.algorithm));
    const unknownAlgorithms = Array.from(requestedAlgorithms).filter((algorithm) => !knownAlgorithms.has(algorithm)).sort();
    if (unknownAlgorithms.length) {
        throw new Error(`Unknown live algorithm filter: ${unknownAlgorithms.join(", ")}`);
    }
    const selected = definitions
        .map((entry) => ({ ...entry }))
        .filter((entry) => requestedAlgorithms.size
            ? requestedAlgorithms.has(entry.algorithm)
            : !entry.optional)
        .sort((left, right) => left.algorithm.localeCompare(right.algorithm));

    logger.event("algorithms.discovered", {
        source: requestedAlgorithms.size ? "env" : "embedded",
        algorithms: selected.map((entry) => entry.algorithm),
        requestedAlgorithms: requestedAlgorithms.size ? Array.from(requestedAlgorithms).sort() : undefined
    });

    return selected;
}

function buildCoveragePlan(algorithms, miners, options = {}) {
    return algorithms.flatMap((definition) => {
        const miner = miners.find((candidate) => !candidate.supplementalCoverage && candidate.algorithms.has(definition.algorithm)) || null;
        const suppressProbe = options.suppressGpuProtocolProbes && GPU_PROTOCOL_PROBE_ALGOS.has(definition.algorithm);
        const plans = [{
            algorithm: definition.algorithm,
            miner,
            protocolProbe: miner || suppressProbe ? "" : (definition.protocolProbe || ""),
            successCriterion: definition.successCriterion || "accepted-share"
        }];
        for (const supplementalMiner of miners) {
            if (!supplementalMiner.supplementalCoverage || !supplementalMiner.algorithms.has(definition.algorithm)) continue;
            plans.push({
                algorithm: definition.algorithm,
                miner: supplementalMiner,
                protocolProbe: "",
                successCriterion: definition.successCriterion || "accepted-share"
            });
        }
        return plans;
    });
}

function makeWorkerName(config, algorithm, side, attempt) {
    return ["itest", sanitizeName(config.runId).slice(0, 12), shortAlgoName(algorithm).slice(0, 16), side, String(attempt)]
        .filter(Boolean)
        .join("-")
        .slice(0, 63);
}

function processIdentityKey(identity) {
    return `${identity.pid}:${identity.startTicks}`;
}

function createProcessOwnership(readers = null) {
    return {
        supported: PROCESS_TREE_SUPPORTED,
        readers: readers || { readIdentity: readProcessIdentity, readChildren: readProcessChildren },
        processes: new Map(),
        knownPids: new Map(),
        queryFailures: 0,
        truncated: false,
        rootKey: "",
        launcherExitedBeforeSnapshot: false
    };
}

async function readProcessIdentity(pid) {
    if (!PROCESS_TREE_SUPPORTED || !Number.isInteger(pid) || pid <= 0) return null;
    try {
        const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(") ");
        if (closeParen < 0) return undefined;
        const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
        const state = fields[0];
        const ppid = Number(fields[1]);
        const startTicks = fields[19];
        if (!/^[A-Z]$/.test(state || "") || !Number.isInteger(ppid) || !/^\d+$/.test(startTicks || "")) {
            return undefined;
        }
        return { pid, ppid, startTicks, state };
    } catch (error) {
        if (error.code === "ENOENT") return null;
        return undefined;
    }
}

async function readProcessChildren(pid) {
    if (!PROCESS_TREE_SUPPORTED) return [];
    try {
        const text = await fsp.readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
        const children = text.trim() ? text.trim().split(/\s+/).map(Number) : [];
        return children.every((childPid) => Number.isInteger(childPid) && childPid > 0) ? children : null;
    } catch (error) {
        if (error.code === "ENOENT") return [];
        return null;
    }
}

function registerOwnedProcess(ownership, identity, queue) {
    const knownStartTicks = ownership.knownPids.get(identity.pid);
    if (knownStartTicks && knownStartTicks !== identity.startTicks) return;
    const key = processIdentityKey(identity);
    if (ownership.processes.has(key)) return;
    if (ownership.processes.size >= PROCESS_TREE_MAX) {
        ownership.truncated = true;
        return;
    }
    ownership.knownPids.set(identity.pid, identity.startTicks);
    ownership.processes.set(key, identity);
    queue.push(identity);
}

async function expandProcessOwnership(ownership) {
    if (!ownership.supported) return;
    const queue = Array.from(ownership.processes.values());
    const visited = new Set();
    while (queue.length) {
        const parent = queue.shift();
        const parentKey = processIdentityKey(parent);
        if (visited.has(parentKey)) continue;
        visited.add(parentKey);

        const currentParent = await ownership.readers.readIdentity(parent.pid);
        if (currentParent === undefined) {
            ownership.queryFailures += 1;
            continue;
        }
        if (!currentParent || currentParent.startTicks !== parent.startTicks || currentParent.state === "Z") {
            if (parentKey === ownership.rootKey && ownership.processes.size === 1) {
                ownership.launcherExitedBeforeSnapshot = true;
            }
            continue;
        }

        const children = await ownership.readers.readChildren(parent.pid);
        if (!Array.isArray(children)) {
            ownership.queryFailures += 1;
            continue;
        }
        const verifiedParent = await ownership.readers.readIdentity(parent.pid);
        if (verifiedParent === undefined) {
            ownership.queryFailures += 1;
            continue;
        }
        if (!verifiedParent || verifiedParent.startTicks !== parent.startTicks || verifiedParent.state === "Z") {
            if (parentKey === ownership.rootKey && ownership.processes.size === 1) {
                ownership.launcherExitedBeforeSnapshot = true;
            }
            continue;
        }
        for (const childPid of children) {
            const child = await ownership.readers.readIdentity(childPid);
            if (child === undefined) {
                ownership.queryFailures += 1;
                continue;
            }
            if (!child || child.ppid !== parent.pid) continue;
            registerOwnedProcess(ownership, child, queue);
        }
    }
}

async function captureOwnedProcessTree(pid, readers = null) {
    const ownership = createProcessOwnership(readers);
    if (!ownership.supported) return ownership;
    const root = await ownership.readers.readIdentity(pid);
    if (root === undefined) ownership.queryFailures += 1;
    else if (root) {
        ownership.rootKey = processIdentityKey(root);
        registerOwnedProcess(ownership, root, []);
    } else ownership.launcherExitedBeforeSnapshot = true;
    await expandProcessOwnership(ownership);
    return ownership;
}

async function refreshOwnedProcessTree(ownership) {
    await expandProcessOwnership(ownership);
    return ownership;
}

async function processState(identity, readers = { readIdentity: readProcessIdentity }) {
    const current = await readers.readIdentity(identity.pid);
    if (current === undefined) return "unknown";
    if (!current || current.startTicks !== identity.startTicks || current.state === "Z") return "gone";
    return "live";
}

async function ownedProcessState(ownership) {
    let live = 0;
    let unknown = 0;
    for (const identity of ownership.processes.values()) {
        const state = await processState(identity, ownership.readers);
        if (state === "live") live += 1;
        else if (state === "unknown") unknown += 1;
    }
    return { live, unknown };
}

async function waitForOwnedProcessExit(ownership, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let state = { live: 0, unknown: 0 };
    do {
        await expandProcessOwnership(ownership);
        state = await ownedProcessState(ownership);
        if (state.live === 0 && state.unknown === 0) return state;
        if (Date.now() >= deadline) return state;
        await sleep(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return state;
}

async function signalOwnedProcesses(ownership, signal) {
    await expandProcessOwnership(ownership);
    for (const identity of ownership.processes.values()) {
        if (await processState(identity, ownership.readers) !== "live") continue;
        try {
            process.kill(identity.pid, signal);
        } catch (error) {
            if (error.code !== "ESRCH") ownership.queryFailures += 1;
        }
    }
}

function cleanupResult(ownership, state, natural, forced) {
    return {
        processCleanupComplete: state.live === 0 && state.unknown === 0
            && ownership.supported && ownership.queryFailures === 0 && !ownership.truncated
            && !ownership.launcherExitedBeforeSnapshot,
        processCleanupNatural: natural,
        processCleanupForced: forced,
        ownedProcessCount: ownership.processes.size,
        remainingProcessCount: state.live + state.unknown,
        processCleanupQueryFailures: ownership.queryFailures + state.unknown,
        processCleanupTruncated: ownership.truncated,
        processCleanupLauncherExitBeforeSnapshot: ownership.launcherExitedBeforeSnapshot
    };
}

async function stopProcess(processHandle, ownership = null) {
    if (!processHandle || !Number.isInteger(processHandle.pid)) {
        return cleanupResult(createProcessOwnership(), { live: 0, unknown: 1 }, false, false);
    }

    const tracked = ownership || await captureOwnedProcessTree(processHandle.pid);
    if (!tracked.supported) {
        if (processHandle.exitCode !== null) return cleanupResult(tracked, { live: 0, unknown: 0 }, true, false);
        processHandle.kill("SIGINT");
        if (processHandle.exitCode === null) await sleep(PROCESS_SIGNAL_GRACE_MS);
        if (processHandle.exitCode !== null) return cleanupResult(tracked, { live: 0, unknown: 0 }, true, false);
        processHandle.kill("SIGTERM");
        await sleep(PROCESS_TERM_GRACE_MS);
        if (processHandle.exitCode !== null) return cleanupResult(tracked, { live: 0, unknown: 0 }, false, true);
        processHandle.kill("SIGKILL");
        return cleanupResult(tracked, { live: 1, unknown: 0 }, false, true);
    }

    if (!tracked.processes.size && processHandle.exitCode === null) {
        const retry = await captureOwnedProcessTree(processHandle.pid);
        if (retry.processes.size) return await stopProcess(processHandle, retry);
        tracked.queryFailures += retry.queryFailures + 1;
    }

    let state = await ownedProcessState(tracked);
    if (state.live === 0 && state.unknown === 0) return cleanupResult(tracked, state, true, false);

    await signalOwnedProcesses(tracked, "SIGINT");
    state = await waitForOwnedProcessExit(tracked, PROCESS_SIGNAL_GRACE_MS);
    if (state.live === 0 && state.unknown === 0) return cleanupResult(tracked, state, true, false);

    await signalOwnedProcesses(tracked, "SIGTERM");
    state = await waitForOwnedProcessExit(tracked, PROCESS_TERM_GRACE_MS);
    if (state.live === 0 && state.unknown === 0) return cleanupResult(tracked, state, false, true);

    await signalOwnedProcesses(tracked, "SIGKILL");
    state = await waitForOwnedProcessExit(tracked, PROCESS_SIGNAL_GRACE_MS);
    return cleanupResult(tracked, state, false, true);
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
    buildMoMinerNoBenchConfig,
    writeXmrigSeedConfig,
    getActiveAlgorithms,
    buildCoveragePlan,
    makeWorkerName,
    captureOwnedProcessTree,
    refreshOwnedProcessTree,
    stopProcess,
    summarizeLatency,
    hasMetSuccessCriterion,
    determineFailureReason
};
