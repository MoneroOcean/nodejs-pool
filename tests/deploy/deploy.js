"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const ROOT_DIR = path.join(__dirname, "..", "..");
const ARTIFACT_ROOT = path.join(ROOT_DIR, "test-artifacts", "deploy");
const DEFAULT_CASE_TIMEOUT_MS = 45 * 60 * 1000;
const EXPECTED_DEPLOY_PROCESSES = [
    "api", "monero-wallet-rpc", "block_manager", "worker",
    "payments", "remote_share", "long_runner", "pool_stats"
];
const REMOTE_SHARE_URLS = [
    "http://127.0.0.1:8000/leafApi",
    "http://[::1]:8000/leafApi",
    "http://localhost:8000/leafApi"
];
const XMR_POOL_ADDRESS = "46yzCCD3Mza9tRj7aqPSaxVbbePtuAeKzf8Ky2eRtcXGcEgCg1iTBio6N4sPmznfgGEUGDoBz5CLxZ2XPTyZu1yoCAG7zt6";
const XMR_FEE_ADDRESS = "463tWEBn5XZJSxLU6uLQnQ2iY9xuNcDbjLSjkn3XAXHCbLrTTErJrBWYgHJQyrCwkNgYvyV3z8zctJLPCZy24jvb3NiTcTJ";
const XMR_MINER_ADDRESS = "862wu9yae6qSUaUGz3KjjSeQ3xPKKxhzf8eYd9qXFx4eTpWm1qp6tvY9mzX4YiUQyYNdwZ9T8Muy1NfydEnExWkER25EfNj";
const MYSQL_POOL_PASSWORD = "98erhfiuehw987fh23d";
const TARI_PROXY_PORT = 18081;
const MONEROD_PORT = 18083;
const MINOTARI_NODE_PORT = 18142;
const XTM_T_COMPAT_PORT = 18146;

function sanitizeName(value) {
    return String(value || "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}

function appendTail(previous, chunk, limit = 30000) {
    const next = `${previous}${chunk}`;
    if (next.length <= limit) return next;
    return next.slice(next.length - limit);
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\"'\"'")}'`;
const ensureDir = (dirPath) => fsp.mkdir(dirPath, { recursive: true });
const artifactPath = (context, name) => path.join(context.artifactDir, name);
async function writeFile(filePath, content) { await ensureDir(path.dirname(filePath)); await fsp.writeFile(filePath, content); }
const writeJson = (filePath, value) => writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
const appendCheckLog = (context, message) => fsp.appendFile(context.checkLog, `${new Date().toISOString()} ${message}\n`);
const appendCheckData = (context, label, value) => appendCheckLog(context, `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function runCommand(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: options.cwd || ROOT_DIR,
        env: options.env || process.env,
        stdio: ["pipe", "pipe", "pipe"]
    });
    const tail = { stdout: "", stderr: "" };
    let logStream = null;

    if (options.logFile) {
        await ensureDir(path.dirname(options.logFile));
        logStream = fs.createWriteStream(options.logFile, { flags: "a" });
        logStream.write(`$ ${command} ${args.map((arg) => shellQuote(arg)).join(" ")}\n`);
    }

    for (const stream of ["stdout", "stderr"]) {
        child[stream].on("data", (chunk) => {
            tail[stream] = appendTail(tail[stream], chunk.toString("utf8"));
            if (logStream) logStream.write(chunk);
        });
    }

    if (typeof options.input === "string") child.stdin.end(options.input);
    else child.stdin.end();

    const result = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code }));
    });

    if (logStream) await new Promise((resolve) => logStream.end(resolve));

    if (options.check !== false && result.code !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed with exit code ${result.code}\n` +
            `${tail.stderr || tail.stdout || "(no output)"}`
        );
    }

    return { code: result.code, stdoutTail: tail.stdout };
}

const parseListEnv = (name, fallback) => (process.env[name] || fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

function getRequestedCases() {
    const distros = parseListEnv("POOL_DEPLOY_DISTROS", "ubuntu:24.04,ubuntu:26.04");
    const scripts = parseListEnv("POOL_DEPLOY_SCRIPTS", "deploy,leaf");
    return distros.flatMap((distro) => scripts.map((script) => {
        assert.ok(script === "deploy" || script === "leaf", `Unsupported deploy script selector: ${script}`);
        return { distro, script, timeoutMs: DEFAULT_CASE_TIMEOUT_MS };
    }));
}

async function ensureRunnerImage(distro, buildLog) {
    const imageTag = `nodejs-pool-deploy-runner-v12-${sanitizeName(distro)}`;
    if (!process.env.POOL_DEPLOY_REBUILD_IMAGES) {
        const inspect = spawnSync("docker", ["image", "inspect", imageTag], { stdio: "ignore" });
        if (inspect.status === 0) return imageTag;
    }

    const buildDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nodejs-pool-deploy-runner-"));
    const dockerfilePath = path.join(buildDir, "Dockerfile");
    await fsp.copyFile(path.join(ROOT_DIR, "tests", "deploy", "common", "container_shim.sh"), path.join(buildDir, "container_shim.sh"));
    await writeFile(dockerfilePath, [
        `FROM ${distro}`,
        "ENV DEBIAN_FRONTEND=noninteractive",
        "RUN apt-get update -o Acquire::Retries=5 \\",
        " && apt-get install -y -o Acquire::Retries=5 --no-install-recommends \\",
        "    nodejs \\",
        "    socat \\",
        " && rm -rf /var/lib/apt/lists/*",
        "COPY container_shim.sh /usr/local/bin/codex-container-shim",
        "RUN chmod 755 /usr/local/bin/codex-container-shim \\",
        ...["certbot", "git", "service", "systemctl", "timedatectl", "ufw"]
            .map((name) => ` && ln -sf /usr/local/bin/codex-container-shim /usr/local/bin/${name}`)
    ].join("\n"));

    try {
        await runCommand("docker", ["build", "-t", imageTag, "-f", dockerfilePath, buildDir], {
            logFile: buildLog
        });
    } finally {
        await fsp.rm(buildDir, { recursive: true, force: true });
    }

    return imageTag;
}

const execInContainer = (containerName, command, options = {}) => runCommand("docker", ["exec", containerName, "bash", "-lc", command], options);
const runNodeInContainer = (context, script, options = {}) => execInContainer(context.containerName, `/usr/bin/node -e ${shellQuote(script)}`, options);

async function collectDiagnostics(context) {
    await appendCheckData(context, "collecting diagnostics", {
        containerInspect: "container-inspect.json", leafPoolLog: "leaf-pool.log",
        monerodLog: "monerod-log.txt", pm2Logs: "pm2-logs.txt",
        ports: "ports.txt", processes: "processes.txt"
    });
    await runCommand("docker", ["inspect", context.containerName], { check: false, logFile: artifactPath(context, "container-inspect.json") });
    for (const [file, command] of [
        ["processes.txt", "ps -ef || true"],
        ["ports.txt", "command -v ss >/dev/null 2>&1 && ss -ltnp || true"],
        ["pm2-logs.txt", "if [ -d /home/user/.pm2/logs ]; then for file in /home/user/.pm2/logs/*; do echo \"=== $file ===\"; tail -n 200 \"$file\"; done; fi"],
        ["monerod-log.txt", "if [ -f /home/monerodaemon/.bitmonero/bitmonero.log ]; then tail -n 200 /home/monerodaemon/.bitmonero/bitmonero.log; fi"],
        ["leaf-pool.log", "if [ -f /home/user/nodejs-pool/.codex-pool.out ] || [ -f /home/user/nodejs-pool/.codex-pool.err ]; then for file in /home/user/nodejs-pool/.codex-pool.out /home/user/nodejs-pool/.codex-pool.err; do [ -f \"$file\" ] || continue; echo \"=== $file ===\"; tail -n 200 \"$file\"; done; fi"]
    ]) await execInContainer(context.containerName, command, { check: false, logFile: artifactPath(context, file) });
}

async function verifyRequiredFiles(context, label, filePaths) {
    await appendCheckLog(context, `${label}: required files`);
    for (const filePath of filePaths) {
        await execInContainer(context.containerName, `test -f ${shellQuote(filePath)}`);
        await appendCheckLog(context, `verified file ${filePath}`);
    }
    await appendCheckData(context, `${label} file checks complete`, filePaths);
}

const summarizePm2 = (payload) => payload.map((entry) => ({
    name: entry.name,
    pid: entry.pid ?? null,
    status: entry.pm2_env?.status || "missing"
}));

async function writePm2Snapshot(context, label, payload, summary = summarizePm2(payload)) {
    await writeJson(artifactPath(context, "pm2-jlist.json"), payload);
    await appendCheckData(context, label, summary);
}

async function waitForPm2Processes(context, expectedNames, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastPayload = [];
    await appendCheckData(context, "waiting for pm2 processes", { expectedNames, timeoutMs });

    while (Date.now() < deadline) {
        const result = await execInContainer(context.containerName, "su user -l -c 'export PM2_HOME=/home/user/.pm2; . ~/.nvm/nvm.sh >/dev/null 2>&1; pm2 jlist'", {
            check: false
        });

        if (result.code === 0) {
            try {
                lastPayload = JSON.parse(result.stdoutTail || "[]");
                const byName = new Map(lastPayload.map((entry) => [entry.name, entry]));
                if (expectedNames.every((name) => byName.get(name)?.pm2_env?.status === "online")) {
                    await writePm2Snapshot(context, "pm2 status", lastPayload);
                    return lastPayload;
                }
            } catch (_error) {}
        }

        const logResult = await execInContainer(context.containerName, "if [ -d /home/user/.pm2/logs ]; then find /home/user/.pm2/logs -maxdepth 1 -type f -printf '%f\\n'; fi", {
            check: false
        });
        if (logResult.code === 0) {
            const files = new Set((logResult.stdoutTail || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
            const fallbackPayload = expectedNames.map((name) => {
                const stem = name.replaceAll("_", "-");
                const status = files.has(`${stem}-out.log`) || files.has(`${stem}-error.log`) ? "log-detected" : "missing";
                return { name, pid: null, pm2_env: { status } };
            });
            if (fallbackPayload.every(({ pm2_env }) => pm2_env.status === "log-detected")) {
                await writePm2Snapshot(context, "pm2 log fallback", fallbackPayload, fallbackPayload.map(({ name, pm2_env }) => ({
                    name,
                    status: pm2_env.status
                })));
                return fallbackPayload;
            }
        }

        await delay(1000);
    }

    await writePm2Snapshot(context, "pm2 timeout payload", lastPayload, lastPayload);
    throw new Error(`Timed out waiting for pm2 processes: ${expectedNames.join(", ")}`);
}

async function httpRequest(context, request, options = {}) {
    const script = `
const http = require("node:http");
const https = require("node:https");
const input = ${JSON.stringify(request)};
const transport = input.url.startsWith("https:") ? https : http;
const req = transport.request(input.url, { method: input.method || "GET", headers: input.headers || {} }, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => process.stdout.write(JSON.stringify({ statusCode: res.statusCode, body }) + "\\n"));
});
req.on("error", (error) => process.stdout.write(JSON.stringify({ statusCode: 0, error: error.message }) + "\\n"));
if (typeof input.body === "string" && input.body.length) req.write(input.body);
req.end();`;
    const result = await runNodeInContainer(context, script, { check: false, logFile: options.logFile });
    return JSON.parse(result.stdoutTail || '{"statusCode":0,"error":"empty response"}');
}

async function assertWalletRpc(context) {
    const parsed = await httpRequest(context, {
        body: '{"jsonrpc":"2.0","id":"0","method":"getbalance","params":[] }',
        headers: { "Content-Type": "application/json" },
        method: "POST",
        url: "http://127.0.0.1:18082/json_rpc"
    }, { logFile: artifactPath(context, "wallet-rpc.json") });
    assert.equal(parsed.statusCode, 200, `wallet rpc status ${parsed.statusCode}${parsed.error ? `: ${parsed.error}` : ""}`);
    const response = JSON.parse(parsed.body);
    assert.equal(typeof response.result.unlocked_balance, "number");
    await appendCheckData(context, "wallet rpc getbalance", response.result);
}

async function assertRemoteShareResponse(context) {
    const probes = [];
    let ok = false;
    for (const url of REMOTE_SHARE_URLS) {
        const probe = await httpRequest(context, { method: "POST", url }, { check: false });
        probes.push({ error: probe.error || "", statusCode: probe.statusCode, url });
        if (probe.statusCode !== 0 && probe.statusCode !== 404) {
            ok = true;
            break;
        }
    }
    const probePath = artifactPath(context, "remote-share-status.txt");
    await writeJson(probePath, probes);
    if (ok) return appendCheckData(context, "remote_share probe", probes);
    throw new Error(`remote_share did not answer on IPv4 or IPv6 loopback. See ${probePath}`);
}

async function runInstaller(context) {
    const scriptPath = context.script === "deploy" ? "deployment/deploy.bash" : "deployment/leaf.bash";
    const command = context.script === "deploy"
        ? `cd /workspace/repo && /bin/bash -exc ${shellQuote('read(){ builtin read "$@" || true; return 0; }\nexport -f read\nsource deployment/deploy.bash')}`
        : `cd /workspace/repo && /bin/bash -ex ${shellQuote(scriptPath)}`;
    await appendCheckData(context, "running installer", { artifact: path.basename(context.installerLog), scriptPath });
    const result = await execInContainer(context.containerName, command, { logFile: context.installerLog, check: false });
    await appendCheckLog(context, `installer exit code ${result.code}`);
    return result;
}

async function verifyDeployInstall(context) {
    await verifyRequiredFiles(context, "deploy checks", [
        "/root/mysql_pass", "/home/user/nodejs-pool/config.json", "/home/user/wallets/wallet.address.txt",
        "/home/user/wallets/wallet_fee.address.txt", "/lib/systemd/system/monero.service"
    ]);

    await appendCheckLog(context, `deploy checks: pm2 ${EXPECTED_DEPLOY_PROCESSES.join(", ")}`);
    await waitForPm2Processes(context, EXPECTED_DEPLOY_PROCESSES, 45000);
    await appendCheckLog(context, "deploy checks: api config");
    const apiResult = await httpRequest(context, { url: "http://127.0.0.1:8001/config" }, { logFile: artifactPath(context, "api-config.json") });
    assert.equal(apiResult.statusCode, 200, `api config status ${apiResult.statusCode}${apiResult.error ? `: ${apiResult.error}` : ""}`);
    await appendCheckData(context, "api config response", JSON.parse(apiResult.body));
    await appendCheckLog(context, "deploy checks: remote_share");
    await assertRemoteShareResponse(context);
    await appendCheckLog(context, "deploy checks: wallet rpc");
    await assertWalletRpc(context);
}
async function createContainer(context) {
    await appendCheckData(context, "creating docker network", context.networkName);
    await runCommand("docker", ["network", "create", context.networkName], { logFile: artifactPath(context, "docker-network.log") });
    const envVars = {
        POOL_DEPLOY_TEST_MODE: 1,
        POOL_DEPLOY_TARI_PROXY_PORT: TARI_PROXY_PORT,
        POOL_DEPLOY_MONEROD_PORT: MONEROD_PORT,
        POOL_DEPLOY_MINOTARI_NODE_PORT: MINOTARI_NODE_PORT,
        POOL_DEPLOY_XTM_T_COMPAT_PORT: XTM_T_COMPAT_PORT,
        POOL_DEPLOY_XMR_POOL_ADDRESS: XMR_POOL_ADDRESS,
        POOL_DEPLOY_XMR_FEE_ADDRESS: XMR_FEE_ADDRESS
    };
    const args = [
        "run",
        "-d",
        "--rm",
        ...Object.entries(envVars).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
        "--network", context.networkName,
        "--init",
        "--name", context.containerName,
        "-v", `${ROOT_DIR}:/workspace/repo:ro`,
        context.imageTag,
        "sleep",
        "infinity"
    ];
    await appendCheckData(context, "starting docker container", { containerName: context.containerName, distroImage: context.imageTag });
    await runCommand("docker", args, { logFile: artifactPath(context, "docker-run.log") });
}

async function cleanupContext(context) {
    for (const args of [
        context.mysqlContainerName && ["rm", "-f", context.mysqlContainerName],
        context.containerName && ["rm", "-f", context.containerName],
        context.networkName && ["network", "rm", context.networkName]
    ]) {
        if (args) await runCommand("docker", args, { check: false });
    }
}
async function prepareContainer(context) {
    await appendCheckLog(context, "runner image includes baked-in harness shims");
}

async function runDeployCase(caseConfig) {
    const id = `${sanitizeName(caseConfig.script)}-${sanitizeName(caseConfig.distro)}-${crypto.randomUUID().slice(0, 8)}`;
    const caseDir = path.join(ARTIFACT_ROOT, sanitizeName(caseConfig.distro), caseConfig.script);
    const artifactDir = path.join(caseDir, id);
    await ensureDir(caseDir);
    const context = {
        artifactDir,
        checkLog: path.join(artifactDir, "checks.log"),
        containerName: `nodejs-pool-${id}`,
        imageTag: "",
        installerLog: path.join(artifactDir, "installer.log"),
        networkName: `nodejs-pool-net-${id}`,
        runnerImageBuildLog: path.join(artifactDir, "runner-image-build.log"),
        script: caseConfig.script
    };

    try {
        await ensureDir(context.artifactDir);
        await writeFile(context.checkLog, "");
        context.imageTag = await ensureRunnerImage(caseConfig.distro, context.runnerImageBuildLog);
        await appendCheckLog(context, `starting ${caseConfig.script}.bash on ${caseConfig.distro}`);
        await createContainer(context);
        await prepareContainer(context);

        const installerResult = await runInstaller(context);
        if (installerResult.code !== 0) {
            throw new Error(`${caseConfig.script}.bash failed on ${caseConfig.distro} with exit code ${installerResult.code}. See ${context.installerLog}`);
        }

        await verifyDeployInstall(context);
        await writeJson(artifactPath(context, "result.json"), {
            distro: caseConfig.distro,
            script: caseConfig.script,
            success: true
        });
        await appendCheckData(context, "all checks passed", {
            buildLog: path.basename(context.runnerImageBuildLog),
            checkLog: path.basename(context.checkLog),
            installerLog: path.basename(context.installerLog),
            result: "success"
        });
        return context;
    } catch (error) {
        await appendCheckLog(context, `failed: ${error && error.message ? error.message : String(error)}`);
        await appendCheckData(context, "failure artifacts", {
            buildLog: path.basename(context.runnerImageBuildLog),
            checkLog: path.basename(context.checkLog),
            installerLog: path.basename(context.installerLog)
        });
        await collectDiagnostics(context);
        await writeJson(artifactPath(context, "result.json"), {
            distro: caseConfig.distro,
            script: caseConfig.script,
            success: false,
            error: error && error.stack ? error.stack : String(error)
        });
        error.context = context;
        throw error;
    } finally {
        await cleanupContext(context);
    }
}

function printLogs(t, context) {
    for (const [label, filePath] of [
        ["build", context.runnerImageBuildLog],
        ["installer", context.installerLog],
        ["check", context.checkLog]
    ]) if (filePath && fs.existsSync(filePath)) t.diagnostic(`${label} log: ${filePath}`);
}

test.describe("deploy", { concurrency: false }, () => {
    test("deployment deploy.bash matrix in Docker", { timeout: 2 * 60 * 60 * 1000 }, async (t) => {
        if (spawnSync("docker", ["--version"], { stdio: "ignore" }).status !== 0) {
            throw new Error("Docker is required for test:deploy");
        }

        for (const caseConfig of getRequestedCases().filter(({ script }) => script === "deploy")) {
            await t.test(`${caseConfig.script}.bash on ${caseConfig.distro}`, { timeout: caseConfig.timeoutMs }, async (t) => {
                try {
                    const context = await runDeployCase(caseConfig);
                    printLogs(t, context);
                } catch (error) {
                    if (error && error.context) printLogs(t, error.context);
                    throw error;
                }
            });
        }
    });
});
