"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const { scanRepository } = require("../../scripts/lint-sensitive-data.js");

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "lint-sensitive-data.js");

function address(...octets) {
    return octets.join(".");
}

function git(root, ...args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function makeRepository(files) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sensitive-data-lint-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "security-lint@example.invalid");
    git(root, "config", "user.name", "security-lint");
    for (const [relativePath, content] of Object.entries(files)) {
        const absolutePath = path.join(root, relativePath);
        await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
        await fsp.writeFile(absolutePath, content);
    }
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "fixture");
    return root;
}

async function removeRepository(root) {
    await fsp.rm(root, { recursive: true, force: true });
}

test("reports public IPv4 literals while ignoring reserved and documentation ranges", async (t) => {
    const publicAddress = address(8, 8, 8, 8);
    const adjacentToProtocolAssignment = address(192, 0, 1, 1);
    const adjacentToDocumentation = address(198, 51, 99, 1);
    const fixture = [
        `public=${publicAddress}`,
        `public=${adjacentToProtocolAssignment}`,
        `public=${adjacentToDocumentation}`,
        `loopback=${address(127, 0, 0, 1)}`,
        `private=${address(10, 1, 2, 3)}`,
        `carrierNat=${address(100, 64, 0, 1)}`,
        `linkLocal=${address(169, 254, 1, 1)}`,
        `documentation=${address(192, 0, 2, 10)}`,
        `documentation=${address(198, 51, 100, 10)}`,
        `documentation=${address(203, 0, 113, 7)}`,
        `multicast=${address(224, 0, 0, 1)}`,
        `benchmark=${address(198, 18, 0, 1)}`
    ].join("\n");
    const root = await makeRepository({ "fixtures/addresses.txt": fixture });
    t.after(() => removeRepository(root));

    const result = scanRepository(root);
    assert.deepEqual(result.findings.map(({ kind, line }) => ({ kind, line })), [
        { kind: "ipv4", line: 1 },
        { kind: "ipv4", line: 2 },
        { kind: "ipv4", line: 3 }
    ]);
    assert.ok(result.findings.every((finding) => !Object.hasOwn(finding, "value")));
});

test("reports high-confidence token and private-key markers without scanning untracked files or binary data", async (t) => {
    const accessKey = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const privateKeyHeader = ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join("");
    const genericSecret = ["fixture", "-long-value-123456"].join("");
    const sqlSecret = ["sql", "-fixture-value-654321"].join("");
    const root = await makeRepository({
        "fixtures/secrets.txt": [
            `access=${accessKey}`,
            privateKeyHeader,
            `service_password = "${genericSecret}"`,
            `"client_secret": "${genericSecret}-json"`,
            `CREATE USER fixture IDENTIFIED BY '${sqlSecret}'`
        ].join("\n"),
        "fixtures/binary.bin": Buffer.from([0, 65, 75, 73, 65, 46, 49, 50, 51])
    });
    t.after(() => removeRepository(root));
    await fsp.writeFile(path.join(root, "untracked.txt"), `untracked=${address(8, 8, 4, 4)}`);

    const result = scanRepository(root);
    assert.equal(result.binaryFilesSkipped, 1);
    assert.equal(result.findings.length, 5);
    assert.deepEqual(result.findings.map((finding) => finding.name).sort(), [
        "aws-access-key",
        "generic-secret-assignment",
        "generic-secret-assignment",
        "private-key-marker",
        "sql-password"
    ]);
});

test("CLI returns a failing status and does not print the matched value", async (t) => {
    const publicAddress = address(9, 9, 9, 9);
    const root = await makeRepository({ "fixtures/network.txt": `resolver=${publicAddress}\n` });
    t.after(() => removeRepository(root));

    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixtures\/network\.txt:1:10: ipv4 \(public-ipv4\)/);
    assert.doesNotMatch(result.stderr, new RegExp(publicAddress.replaceAll(".", "\\.")));
});

test("the scanner itself contains no non-reserved IPv4 literals", () => {
    const result = scanRepository(path.join(__dirname, "..", ".."));
    const ownFindings = result.findings.filter((finding) => finding.path === "scripts/lint-sensitive-data.js" || finding.path === "tests/security/lint-sensitive-data.js");
    assert.deepEqual(ownFindings, []);
});
