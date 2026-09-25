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
            assert.match(node, /^ExecStopPost=-\/bin\/sh -c .*peers\.db\.last-purge.*-mmin -10080.*peers\.db-wal.*peers\.db-shm/m);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}

test("local Tari service exposes all XTM JSON compatibility ports", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-unit-test-local-"));
    try {
        const source = fs.readFileSync(path.join(__dirname, "../deployment/common.bash"), "utf8");
        const script = path.join(directory, "common.bash");
        fs.writeFileSync(script, source.replaceAll("/lib/systemd/system/", `${directory}/`));
        const result = spawnSync("bash", ["-eu", "-c", 'source "$COMMON_SCRIPT"; write_tari_service with-json-bridges'], {
            encoding: "utf8",
            env: {
                ...process.env,
                COMMON_SCRIPT: script,
                TARI_USER: "taridaemon",
                TARI_HOME: "/home/taridaemon",
                TARI_MEMORY_HIGH: "10G",
                TARI_MEMORY_MAX: "12G",
                TARI_MEMORY_SWAP_MAX: "0"
            }
        });
        assert.equal(result.status, 0, result.stderr);
        const node = fs.readFileSync(path.join(directory, "xtm.service"), "utf8");
        for (const port of [18144, 18146, 18148]) {
            assert.match(node, new RegExp(`base_node\\.proto ${port} 18142 --max-body-bytes 16777216`));
        }
        assert.match(node, /minotari_node --non-interactive-mode --watch status --disable-splash-screen/);
        assert.match(node, /^ExecStopPost=-\/bin\/sh -c .*peers\.db\.last-purge.*-mmin -10080.*peers\.db-wal.*peers\.db-shm/m);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("inline Tari peer purge removes the SQLite set at most once per interval", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-tari-inline-purge-"));
    try {
        const source = fs.readFileSync(path.join(__dirname, "../deployment/common.bash"), "utf8");
        const script = path.join(directory, "common.bash");
        fs.writeFileSync(script, source.replaceAll("/lib/systemd/system/", `${directory}/`));
        const result = spawnSync("bash", ["-eu", "-c", 'source "$COMMON_SCRIPT"; write_tari_service base-node-only'], {
            encoding: "utf8",
            env: {
                ...process.env,
                COMMON_SCRIPT: script,
                TARI_USER: process.env.USER || "nobody",
                TARI_HOME: directory,
                TARI_NETWORK: "mainnet",
                TARI_PEER_PURGE_INTERVAL_SECONDS: "604800",
                TARI_MEMORY_HIGH: "10G",
                TARI_MEMORY_MAX: "12G",
                TARI_MEMORY_SWAP_MAX: "0"
            }
        });
        assert.equal(result.status, 0, result.stderr);

        const unit = fs.readFileSync(path.join(directory, "xtm.service"), "utf8");
        const line = unit.split("\n").find((entry) => entry.startsWith("ExecStopPost=-"));
        assert.ok(line);
        // systemd turns $$ into a literal $ before executing the command.
        const command = line.slice("ExecStopPost=-".length).replaceAll("$$", "$");
        const peerDb = path.join(directory, ".tari/mainnet/peer_db/base_node/peers.db");
        fs.mkdirSync(path.dirname(peerDb), { recursive: true });

        for (const suffix of ["", "-wal", "-shm"]) fs.writeFileSync(`${peerDb}${suffix}`, suffix || "db");
        let purge = spawnSync("bash", ["-c", command], { encoding: "utf8" });
        assert.equal(purge.status, 0, purge.stderr);
        for (const suffix of ["", "-wal", "-shm"]) assert.equal(fs.existsSync(`${peerDb}${suffix}`), false);

        fs.writeFileSync(peerDb, "new-db");
        purge = spawnSync("bash", ["-c", command], { encoding: "utf8" });
        assert.equal(purge.status, 0, purge.stderr);
        assert.equal(fs.existsSync(peerDb), true, "the new DB must survive until the weekly interval expires");

        fs.utimesSync(`${peerDb}.last-purge`, 0, 0);
        purge = spawnSync("bash", ["-c", command], { encoding: "utf8" });
        assert.equal(purge.status, 0, purge.stderr);
        assert.equal(fs.existsSync(peerDb), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("daemon updater installs the same inline Tari peer purge without restarting services", () => {
    const updater = fs.readFileSync(path.join(__dirname, "../deployment/update_daemons.bash"), "utf8");
    assert.match(updater, /xtm\.service\.d\/60-peer-purge\.conf/);
    assert.match(updater, /ExecStopPost=-\/bin\/sh -c .*\$peer_db\.last-purge.*\$peer_db-wal.*\$peer_db-shm/);
    assert.match(updater, /systemctl daemon-reload/);
    assert.doesNotMatch(updater, /systemctl (?:restart|start|stop) xtm/);
});
