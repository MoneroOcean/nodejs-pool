"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const DEPLOYMENT_DIR = path.join(__dirname, "..", "..", "deployment");
const COMMON_PATH = path.join(DEPLOYMENT_DIR, "common.bash");
const ENTRYPOINTS = ["deploy.bash", "leaf.bash"];

function runBash(args, options = {}) {
    return spawnSync("bash", args, {
        cwd: path.join(__dirname, "..", ".."),
        encoding: "utf8",
        ...options
    });
}

test("deployment entrypoints have valid shell syntax and production-safe shebangs", () => {
    for (const entrypoint of ENTRYPOINTS) {
        const scriptPath = path.join(DEPLOYMENT_DIR, entrypoint);
        const syntax = runBash(["-n", scriptPath]);
        assert.equal(syntax.status, 0, `${entrypoint}: ${syntax.stderr}`);
        const source = fs.readFileSync(scriptPath, "utf8");
        assert.match(source, /COMMON_BASH_URL=/, `${entrypoint} should load the shared helper`);
        assert.doesNotMatch(source.split("\n", 1)[0], /bash.*-[^ ]*x/, `${entrypoint} shebang must not enable xtrace`);
    }
});

test("common deployment helper exposes the versioned source-only API", () => {
    const command = [
        `source ${JSON.stringify(COMMON_PATH)}`,
        "test \"$MONEROOCEAN_COMMON_API_VERSION\" = 1",
        "declare -F retry_command configure_monero_hugepages write_monero_service write_tari_service write_tari_merge_mining_service >/dev/null",
        "test \"$(type -t retry_command)\" = function"
    ].join(" && ");
    const result = runBash(["-c", command]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("entrypoints can load the sibling helper without executing deployment", () => {
    for (const entrypoint of ENTRYPOINTS) {
        const scriptPath = path.join(DEPLOYMENT_DIR, entrypoint);
        const result = runBash([scriptPath], {
            env: { ...process.env, POOL_DEPLOY_LOAD_COMMON_ONLY: "1" }
        });
        assert.equal(result.status, 0, `${entrypoint}: ${result.stderr || result.stdout}`);
    }
});

test("leaf staged sync modes and P2P source rules stay narrowly scoped", () => {
    const script = fs.readFileSync(path.join(DEPLOYMENT_DIR, "leaf.bash"), "utf8");
    assert.match(script, /LEAF_SKIP_SYNC_WAIT="\$\{LEAF_SKIP_SYNC_WAIT:-0\}"/);
    assert.match(script, /LEAF_FINALIZE_SYNC_ONLY="\$\{LEAF_FINALIZE_SYNC_ONLY:-0\}"/);
    assert.match(script, /validate_binary_flag "\$LEAF_SKIP_SYNC_WAIT" LEAF_SKIP_SYNC_WAIT/);
    assert.match(script, /validate_binary_flag "\$LEAF_FINALIZE_SYNC_ONLY" LEAF_FINALIZE_SYNC_ONLY/);
    assert.match(script, /LEAF_SKIP_SYNC_WAIT and LEAF_FINALIZE_SYNC_ONLY are mutually exclusive/);
    assert.match(script, /validate_ipv4_source_list MONERO_P2P_SOURCE_IPV4S "\$MONERO_P2P_SOURCE_IPV4S"/);
    assert.match(script, /ufw allow from "\$source" to any port 18080 proto tcp/);
    assert.match(script, /ufw --force delete allow from "\$\{BASH_REMATCH\[1\]\}" to any proto tcp/);
    assert.match(script, /ufw --force delete allow from "\$\{BASH_REMATCH\[1\]\}" to any port 18080 proto tcp/);
    assert.match(script, /Wants=network-online\.target[\s\S]*?After=network-online\.target[\s\S]*?ExecStartPre=\/bin\/sleep 10/);
    assert.match(script, /if \[ "\$LEAF_SKIP_SYNC_WAIT" = 1 \]; then\s+systemctl disable xtm_mm/);
    assert.match(script, /finalize_leaf_after_sync\(\) \{[\s\S]*?systemctl enable xtm_mm[\s\S]*?systemctl start xtm_mm/);

    const skipBranch = script.indexOf('if [ "$LEAF_SKIP_SYNC_WAIT" = 1 ]; then');
    const preSyncMergeMining = script.indexOf('systemctl start xtm xtm_mm');
    const waitForMonero = script.indexOf("wait_for_monero_sync\n");
    assert.ok(skipBranch >= 0 && skipBranch < preSyncMergeMining, "skip mode must precede pre-sync merge-mining start");
    assert.ok(skipBranch < waitForMonero, "skip mode must precede sync waits");
    assert.match(script, /if \[ "\$LEAF_FINALIZE_SYNC_ONLY" = 1 \]; then[\s\S]*?require_local_daemons_synced[\s\S]*?finalize_leaf_after_sync/);
    assert.match(script, /require_local_daemons_synced\(\) \{[\s\S]*?rpc_synced http:\/\/127\.0\.0\.1:18083\/json_rpc get_info[\s\S]*?rpc_synced http:\/\/127\.0\.0\.1:18146\/json_rpc GetTipInfo/);
});

test("pool deployment prepare mode is non-mutating and architecture-aware", () => {
    const script = fs.readFileSync(path.join(DEPLOYMENT_DIR, "deploy.bash"), "utf8");
    assert.match(script, /POOL_DEPLOY_PREPARE="\$\{POOL_DEPLOY_PREPARE:-0\}"/);
    assert.match(script, /POOL_DEPLOY_PREPARE must be 0 or 1/);
    assert.match(script, /Skipping Monero sync wait in prepare mode/);
    assert.match(script, /Skipping Tari sync wait in prepare mode/);
    assert.match(script, /\[ "\$POOL_DEPLOY_PREPARE" != 1 \]; then\s+pm2 describe api/);
    assert.match(script, /--daemon-address 127\.0\.0\.1:18083/);
    assert.match(script, /\.moneroocean-build-arch/);
    assert.match(script, /uname -m >build\/release\/\.moneroocean-build-arch/);
    assert.match(script, /POOL_DEPLOY_PREPARE" = 1[\s\S]*skipping wallet generation/);
    assert.match(script, /TARI_WALLET_PAYMENT_ADDRESS must be set/);
    assert.match(script, /TARI_HOME\/\.tari\/\$TARI_NETWORK\/config\/config\.toml/);
    assert.match(script, /install -d -m 755 \/etc\/sudoers\.d/);
    assert.match(script, /visudo -cf \/etc\/sudoers/);
    assert.match(script, /sshd -t/);
});
