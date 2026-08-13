"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "..", "pool_health_guard.sh");

function runGuard(root, values = {}) {
    const countFile = path.join(root, "count");
    const maxFile = path.join(root, "max");
    if (!values.missingCount) fs.writeFileSync(countFile, String(values.count ?? 10));
    else fs.rmSync(countFile, { force: true });
    if (!values.missingMax) fs.writeFileSync(maxFile, String(values.max ?? 100));
    else fs.rmSync(maxFile, { force: true });
    return childProcess.execFileSync(script, [], {
        encoding: "utf8",
        env: {
            ...process.env,
            POOL_GUARD_TEST_MODE: "1",
            POOL_GUARD_TEST_POOL_ONLINE: values.poolOnline === false ? "0" : "1",
            POOL_GUARD_TEST_RPC_HEALTHY: values.rpcHealthy === false ? "0" : "1",
            POOL_GUARD_TEST_NOW: String(values.now ?? 0),
            POOL_GUARD_TEST_LAST_BLOCK_TIMESTAMP: String(values.lastBlockTimestamp ?? values.now ?? 0),
            POOL_GUARD_TEST_AUX_BLOCK_TIMESTAMP: String(values.auxBlockTimestamp ?? values.lastBlockTimestamp ?? values.now ?? 0),
            POOL_GUARD_DAEMON_FAILURE_SHUTDOWN_SEC: String(values.daemonFailureShutdownSec ?? 3600),
            POOL_GUARD_MAX_BLOCK_AGE_SEC: String(values.maxBlockAgeSec ?? 10800),
            POOL_GUARD_STATE_DIR: path.join(root, "state"),
            POOL_GUARD_CONNTRACK_COUNT_FILE: countFile,
            POOL_GUARD_CONNTRACK_MAX_FILE: maxFile
        }
    });
}

test("pool health guard quarantines conntrack pressure and recovers after two healthy probes", function guardRecovery() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const healthyOutput = runGuard(root, { count: 69 });
        assert.doesNotMatch(healthyOutput, /quarantining pool/);

        const tripOutput = runGuard(root, { count: 70 });
        assert.match(tripOutput, /quarantining pool: reason=conntrack-pressure/);
        assert.match(tripOutput, /TEST: pm2 stop pool/);
        assert.ok(fs.existsSync(path.join(root, "state", "quarantine")));
        assert.equal(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")), false);

        runGuard(root, { count: 55 });
        assert.ok(fs.existsSync(path.join(root, "state", "quarantine")));
        const recoverOutput = runGuard(root, { count: 55 });
        assert.match(recoverOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard does not restart daemons or stop the pool during a short outage", function rpcFailures() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const output = runGuard(root, {
            rpcHealthy: false,
            now: 100
        });
        assert.doesNotMatch(output, /fix_daemon\.sh|systemctl restart/);
        assert.doesNotMatch(output, /TEST: pm2 stop pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "daemon-unhealthy-since")), false);
        assert.equal(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard stops after a continuous one-hour stale daemon outage and auto-recovers", function daemonOutageShutdown() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        runGuard(root, {
            now: 14_400,
            lastBlockTimestamp: 0,
            auxBlockTimestamp: 0,
            daemonFailureShutdownSec: 3600
        });
        const output = runGuard(root, {
            now: 18_000,
            lastBlockTimestamp: 0,
            auxBlockTimestamp: 0,
            daemonFailureShutdownSec: 3600
        });
        assert.match(output, /shutting down pool: no fresh daemon block for 3600s/);
        assert.match(output, /TEST: pm2 stop pool/);
        const quarantine = fs.readFileSync(path.join(root, "state", "quarantine"), "utf8");
        assert.match(quarantine, /daemon-outage/);
        assert.equal(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")), false);

        runGuard(root, { rpcHealthy: true, now: 4000, lastBlockTimestamp: 4000 });
        const laterOutput = runGuard(root, { rpcHealthy: true, now: 4015, lastBlockTimestamp: 4015 });
        assert.match(laterOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard considers any chain block older than three hours unhealthy", function staleBlock() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        runGuard(root, {
            now: 14_400,
            auxBlockTimestamp: 0,
            daemonFailureShutdownSec: 3600
        });
        const output = runGuard(root, {
            now: 18_000,
            auxBlockTimestamp: 0,
            daemonFailureShutdownSec: 3600
        });
        assert.match(output, /shutting down pool: no fresh daemon block for 3600s/);
        assert.match(output, /TEST: pm2 stop pool/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard does not stop or recover the pool when conntrack counters are unavailable", function missingConntrack() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const firstOutput = runGuard(root, { missingCount: true });
        assert.match(firstOutput, /conntrack counters unavailable; skipping pressure decision/);
        assert.doesNotMatch(firstOutput, /TEST: pm2 (stop|restart) pool/);

        const repeatedOutput = runGuard(root, { missingCount: true });
        assert.doesNotMatch(repeatedOutput, /conntrack counters unavailable/);

        runGuard(root, { count: 70 });
        assert.ok(fs.existsSync(path.join(root, "state", "quarantine")));
        const quarantinedOutput = runGuard(root, { missingMax: true });
        assert.doesNotMatch(quarantinedOutput, /TEST: pm2 restart pool/);
        assert.ok(fs.existsSync(path.join(root, "state", "quarantine")));

        runGuard(root, { count: 55 });
        const recoveredOutput = runGuard(root, { count: 55 });
        assert.match(recoveredOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
