"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const {
    stripAnsi,
    sleep,
    waitWithTimeout,
    ensureDir,
    emitLiveStatus
} = require("./shared.js");
const {
    writeXmrigSeedConfig,
    makeWorkerName,
    stopProcess,
    summarizeLatency,
    hasMetSuccessCriterion,
    determineFailureReason
} = require("./miners.js");
const {
    PROTOCOL_PROBES,
    createProbeSocket,
    writeProtocolLine,
    sendProtocolJson,
    parseProtocolLines
} = require("./protocol.js");

function createDeferred() { let resolve; return { promise: new Promise((innerResolve) => { resolve = innerResolve; }), resolve }; }

function createAttemptFiles(run, plan, target, attempt, protocolProbe) {
    const attemptId = protocolProbe
        ? `${plan.algorithm.replace(/\//g, "-")}-protocol-${target.name}-attempt-${attempt}`
        : `${plan.algorithm.replace(/\//g, "-")}-${plan.miner.name}-${target.name}-attempt-${attempt}`;

    return {
        attemptId,
        attemptDir: path.join(run.runDir, "attempts", attemptId),
        rawStdoutPath: path.join(run.runDir, "attempts", attemptId, "stdout.log"),
        rawStderrPath: path.join(run.runDir, "attempts", attemptId, "stderr.log"),
        wallet: run.allocateWallet(attemptId),
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

function openLogStreams(stdoutPath, stderrPath) { return { stdout: fs.createWriteStream(stdoutPath, { flags: "a" }), stderr: fs.createWriteStream(stderrPath, { flags: "a" }) }; }
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
        wallet: files.wallet,
        user: `${files.wallet}.${files.worker}`,
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
                emitLiveStatus("start", `probe ${plan.algorithm}`);
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
        wallet: files.wallet,
        walletWithDifficulty: files.wallet,
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
        emitLiveStatus("start", `algo ${plan.algorithm}`);
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

module.exports = {
    executeScenario,
    executeProtocolProbeBatch
};
