"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

for (const dependencies of ["monero.service", "monero.service xtm.service"]) {
    test(`Tari proxy unit decouples daemon restarts (${dependencies})`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-unit-test-"));
        try {
            const source = fs.readFileSync(path.join(__dirname, "../deployment/common.bash"), "utf8");
            const script = path.join(directory, "common.bash");
            // Redirect only the generated unit files; never touch the host service manager.
            fs.writeFileSync(script, source.replaceAll("/lib/systemd/system/", `${directory}/`));
            const result = spawnSync("bash", ["-eu", "-c", 'source "$COMMON_SCRIPT"; write_tari_service base-node-only; write_tari_merge_mining_service "$DEPENDENCY_UNITS"'], {
                encoding: "utf8",
                env: {
                    ...process.env,
                    COMMON_SCRIPT: script,
                    DEPENDENCY_UNITS: dependencies,
                    TARI_USER: "taridaemon",
                    TARI_HOME: "/home/taridaemon",
                    TARI_MEMORY_HIGH: "10G",
                    TARI_MEMORY_SWAP_MAX: "0",
                    TARI_MM_MEMORY_HIGH: "2G",
                    TARI_MM_MEMORY_SWAP_MAX: "0"
                }
            });
            assert.equal(result.status, 0, result.stderr);
            const proxy = fs.readFileSync(path.join(directory, "xtm_mm.service"), "utf8");
            assert.ok(proxy.includes(`After=network.target ${dependencies}\n`));
            assert.doesNotMatch(proxy, /^(?:PartOf|BindsTo|Requires|RuntimeMaxSec)=/m);
            assert.match(proxy, /^Restart=always$/m);
            const node = fs.readFileSync(path.join(directory, "xtm.service"), "utf8");
            assert.match(node, /^RuntimeMaxSec=6h$/m);
            assert.match(node, /^RuntimeRandomizedExtraSec=30min$/m);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
