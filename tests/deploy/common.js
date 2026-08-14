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
