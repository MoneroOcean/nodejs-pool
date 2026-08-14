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
            POOL_GUARD_TEST_NOW: String(values.now ?? 0),
            POOL_GUARD_STATE_DIR: path.join(root, "state"),
            POOL_GUARD_CONNTRACK_COUNT_FILE: countFile,
            POOL_GUARD_CONNTRACK_MAX_FILE: maxFile
        }
    });
}

test("pool health guard leaves healthy pressure alone", function healthyNoop() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const healthyOutput = runGuard(root, { count: 69 });
        assert.doesNotMatch(healthyOutput, /TEST: pm2 (stop|restart) pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), false);

        const offlineOutput = runGuard(root, { count: 70, poolOnline: false });
        assert.doesNotMatch(offlineOutput, /TEST: pm2 (stop|restart) pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard quarantines pressure and recovers after two low-pressure probes", function pressureRecovery() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const tripOutput = runGuard(root, { count: 70, now: 100 });
        assert.match(tripOutput, /quarantining pool: reason=conntrack-pressure/);
        assert.match(tripOutput, /TEST: pm2 stop pool/);
        assert.match(fs.readFileSync(path.join(root, "state", "quarantine"), "utf8"), /conntrack-pressure/);

        const firstHealthyOutput = runGuard(root, { count: 55, now: 130 });
        assert.doesNotMatch(firstHealthyOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.readFileSync(path.join(root, "state", "recovery-successes"), "utf8"), "1\n");
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), true);

        const hysteresisOutput = runGuard(root, { count: 56, now: 145 });
        assert.match(hysteresisOutput, /node remains quarantined: conntrack=56%/);
        assert.doesNotMatch(hysteresisOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "recovery-successes")), false);

        const secondHealthyOutput = runGuard(root, { count: 55, now: 160 });
        assert.doesNotMatch(secondHealthyOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.readFileSync(path.join(root, "state", "recovery-successes"), "utf8"), "1\n");

        const thirdHealthyOutput = runGuard(root, { count: 55, now: 175 });
        assert.match(thirdHealthyOutput, /TEST: pm2 restart pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), false);
        assert.equal(fs.existsSync(path.join(root, "state", "recovery-successes")), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pool health guard never stops or recovers while conntrack counters are unavailable", function missingConntrack() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-guard-"));
    try {
        const firstOutput = runGuard(root, { missingCount: true });
        assert.match(firstOutput, /conntrack counters unavailable; skipping pressure decision/);
        assert.doesNotMatch(firstOutput, /TEST: pm2 (stop|restart) pool/);

        const repeatedOutput = runGuard(root, { missingCount: true });
        assert.doesNotMatch(repeatedOutput, /conntrack counters unavailable/);
        assert.doesNotMatch(repeatedOutput, /TEST: pm2 (stop|restart) pool/);

        runGuard(root, { count: 70 });
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), true);

        const quarantinedOutput = runGuard(root, { missingMax: true });
        assert.doesNotMatch(quarantinedOutput, /TEST: pm2 (stop|restart) pool/);
        assert.equal(fs.existsSync(path.join(root, "state", "quarantine")), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
