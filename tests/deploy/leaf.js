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

async function assertStratumLogin(context) {
    const script = `
const net = require("node:net");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const login = ${JSON.stringify({
        id: 1,
        method: "login",
        params: { login: XMR_MINER_ADDRESS, pass: "deploy-test", agent: "nodejs-pool-deploy-test", rigid: "probe" }
    })};
const once = () => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: 3333 });
  let buffer = "";
  const done = (error, value) => { socket.destroy(); error ? reject(error) : resolve(value); };
  const timer = setTimeout(() => done(new Error("Stratum probe timed out")), 10000);
  socket.on("connect", () => socket.write(JSON.stringify(login) + "\\n"));
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.result?.job?.job_id) { clearTimeout(timer); return done(null, parsed); }
        if (parsed?.error) { clearTimeout(timer); return done(new Error(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error))); }
      } catch (error) { clearTimeout(timer); return done(error); }
    }
  });
  socket.on("error", (error) => { clearTimeout(timer); done(error); });
});
(async () => {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.stdout.write(JSON.stringify(await once(), null, 2) + "\\n"); return; }
    catch (error) { lastError = error; await wait(1000); }
  }
  throw lastError || new Error("Stratum login failed");
})().catch((error) => { process.stderr.write((error && error.stack) || String(error)); process.exit(1); });`;
    const result = await runNodeInContainer(context, script, { logFile: artifactPath(context, "leaf-pool-login.json") });
    const parsed = JSON.parse(result.stdoutTail);
    await appendCheckData(context, "stratum login result", {
        id: parsed.id,
        jobId: parsed.result?.job?.job_id,
        status: parsed.result?.status
    });
}

async function startLeafMysqlSidecar(context) {
    context.mysqlContainerName = `${context.containerName}-mysql`;
    await appendCheckData(context, "starting leaf mysql sidecar", { mysqlContainerName: context.mysqlContainerName, networkName: context.networkName });
    await runCommand("docker", [
        "run",
        "-d",
        "--rm",
        "--name", context.mysqlContainerName,
        "--network", context.networkName,
        "-e", "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
        "-e", "MYSQL_ROOT_HOST=%",
        "mysql:8.0",
        "--default-authentication-plugin=mysql_native_password"
    ], { logFile: artifactPath(context, "mysql-sidecar.log") });

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const result = await runCommand("docker", ["exec", context.mysqlContainerName, "mysqladmin", "ping", "--silent"], {
            check: false
        });
        if (result.code === 0) {
            await appendCheckLog(context, "leaf mysql sidecar is accepting connections");
            return;
        }
        await delay(1000);
    }
    throw new Error("Timed out waiting for leaf MySQL sidecar");
}

async function prepareContainer(context) {
    await appendCheckLog(context, "runner image includes baked-in harness shims");

    if (context.script === "leaf") {
        await startLeafMysqlSidecar(context);
        await execInContainer(
            context.containerName,
            `nohup socat TCP-LISTEN:3306,bind=127.0.0.1,reuseaddr,fork TCP:${context.mysqlContainerName}:3306 >/tmp/codex-leaf-mysql-proxy.log 2>&1 &`
        );
        await appendCheckLog(context, "started leaf mysql proxy on 127.0.0.1:3306");
    }
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
async function runMysqlSidecarSql(context, sql, options = {}) {
    const args = ["exec", "-i", context.mysqlContainerName, "mysql", "-u", "root"];
    if (options.database) args.push("-D", options.database);
    await runCommand("docker", args, { input: `${sql}\n`, logFile: options.logFile });
}

async function bootstrapLeafPool(context) {
    await appendCheckData(context, "leaf bootstrap config", {
        bindIp: "127.0.0.1",
        dbStoragePath: "/home/user/pool_db/",
        hostname: "leaf-test.local",
        mysqlHost: "127.0.0.1",
        mysqlUser: "pool", poolId: 101,
        stratumPort: 3333
    });
    const bootstrapLog = artifactPath(context, "leaf-bootstrap.log");
    const sqlLog = artifactPath(context, "leaf-bootstrap.sql.log");
    const configScript = `
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("/home/user/nodejs-pool/config_example.json", "utf8"));
config.db_storage_path = "/home/user/pool_db/";
config.hostname = "leaf-test.local";
config.bind_ip = "127.0.0.1";
config.pool_id = 101;
fs.writeFileSync("/home/user/nodejs-pool/config.json", JSON.stringify(config, null, 2) + "\\n");`;
    await execInContainer(context.containerName, [
        "mkdir -p /home/user/pool_db",
        "chown -R user:user /home/user/pool_db",
        `/usr/bin/node -e ${shellQuote(configScript)}`,
        "chown user:user /home/user/nodejs-pool/config.json"
    ].join(" && "), { logFile: bootstrapLog });
    await runMysqlSidecarSql(
        context,
        await fsp.readFile(path.join(ROOT_DIR, "deployment", "base.sql"), "utf8"),
        { logFile: sqlLog }
    );
    await runMysqlSidecarSql(
        context,
        `CREATE USER IF NOT EXISTS pool@'%' IDENTIFIED WITH mysql_native_password BY '${MYSQL_POOL_PASSWORD}'; GRANT ALL ON pool.* TO pool@'%'; FLUSH PRIVILEGES;`,
        { logFile: sqlLog }
    );
    await runMysqlSidecarSql(
        context,
        `UPDATE config SET item_value = '${XMR_POOL_ADDRESS}' WHERE module = 'pool' AND item = 'address'; UPDATE config SET item_value = '${XMR_FEE_ADDRESS}' WHERE module = 'payout' AND item = 'feeAddress'; UPDATE config SET item_value = 'ops@example.com' WHERE module = 'general' AND item = 'adminEmail';`,
        { database: "pool", logFile: sqlLog }
    );
    await appendCheckData(context, "leaf bootstrap artifacts", {
        bootstrapLog: "leaf-bootstrap.log",
        poolPidFile: "/home/user/nodejs-pool/.codex-pool.pid",
        configPath: "/home/user/nodejs-pool/config.json",
        sqlSeed: "/home/user/nodejs-pool/deployment/base.sql"
    });
    await execInContainer(
        context.containerName,
        "su user -l -c '. ~/.nvm/nvm.sh >/dev/null 2>&1; cd ~/nodejs-pool && nohup node init.js --module=pool > .codex-pool.out 2> .codex-pool.err < /dev/null & echo $! > .codex-pool.pid'",
        { logFile: bootstrapLog }
    );
}

async function verifyLeafInstall(context) {
    await verifyRequiredFiles(context, "leaf checks", [
        "/home/user/nodejs-pool/init.js", "/home/user/nodejs-pool/cert.pem",
        "/home/user/nodejs-pool/cert.key", "/lib/systemd/system/monero.service"
    ]);
    await execInContainer(context.containerName, "su user -l -c '. ~/.nvm/nvm.sh >/dev/null 2>&1; command -v pm2'");
    await appendCheckLog(context, "verified pm2 installation");

    await appendCheckLog(context, "leaf checks: bootstrap pool");
    await bootstrapLeafPool(context);
    await appendCheckLog(context, "leaf pool bootstrap launched");
    await appendCheckLog(context, "leaf checks: stratum login");
    await assertStratumLogin(context);
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
async function runLeafCase(caseConfig) {
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
        mysqlContainerName: "",
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

        await verifyLeafInstall(context);
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

test.describe("leaf.bash matrix", { concurrency: false }, () => {
    test("deployment leaf.bash matrix in Docker", { timeout: 2 * 60 * 60 * 1000 }, async (t) => {
        if (spawnSync("docker", ["--version"], { stdio: "ignore" }).status !== 0) {
            throw new Error("Docker is required for test:deploy");
        }

        for (const caseConfig of getRequestedCases().filter(({ script }) => script === "leaf")) {
            await t.test(`${caseConfig.script}.bash on ${caseConfig.distro}`, { timeout: caseConfig.timeoutMs }, async (t) => {
                try {
                    const context = await runLeafCase(caseConfig);
                    printLogs(t, context);
                } catch (error) {
                    if (error && error.context) printLogs(t, error.context);
                    throw error;
                }
            });
        }
    });
});
