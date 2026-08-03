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
    fs.writeFileSync(countFile, String(values.count ?? 10));
    fs.writeFileSync(maxFile, String(values.max ?? 100));
    return childProcess.execFileSync(script, [], {
        encoding: "utf8",
        env: {
            ...process.env,
            POOL_GUARD_TEST_MODE: "1",
            POOL_GUARD_TEST_POOL_ONLINE: values.poolOnline === false ? "0" : "1",
            POOL_GUARD_TEST_RPC_HEALTHY: values.rpcHealthy === false ? "0" : "1",
            POOL_GUARD_POOL_DIR: root,
            POOL_GUARD_STATE_DIR: path.join(root, "state"),
            POOL_GUARD_MARKER: path.join(root, "pool_health_guard_unhealthy"),
            POOL_GUARD_CONNTRACK_COUNT_FILE: countFile,
            POOL_GUARD_CONNTRACK_MAX_FILE: maxFile
        }
    });
}

test("pool health guard quarantines conntrack pressure and recovers after two healthy probes", function guardRecovery() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const tripOutput = runGuard(root, { count: 80 });
        assert.match(tripOutput, /quarantining pool: reason=conntrack-pressure/);
        assert.match(tripOutput, /TEST: pm2 stop pool/);
        assert.ok(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")));

        runGuard(root, { count: 40 });
        assert.ok(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")));
        const recoverOutput = runGuard(root, { count: 40 });
        assert.match(recoverOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard quarantines three consecutive merged RPC failures", function rpcFailures() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        runGuard(root, { rpcHealthy: false });
        runGuard(root, { rpcHealthy: false });
        assert.equal(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")), false);
        const output = runGuard(root, { rpcHealthy: false });
        assert.match(output, /quarantining pool: reason=merged-rpc-unhealthy/);
        assert.ok(fs.existsSync(path.join(root, "pool_health_guard_unhealthy")));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
