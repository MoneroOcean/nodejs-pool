#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const IPV4_PATTERN = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const PRIVATE_KEY_PATTERN = new RegExp(
    `${"-".repeat(5)}BEGIN(?: [A-Z0-9][A-Z0-9 _-]*)? PRIVATE KEY-{5}|${"-".repeat(5)}BEGIN PGP PRIVATE KEY BLOCK-{5}`,
    "g"
);
const SECRET_PATTERNS = [
    ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
    ["stripe-secret-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
    ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
    ["npm-token", /\bnpm_[A-Za-z0-9]{20,}\b/g]
];
const GENERIC_SECRET_PATTERN = /["'`]?(?:[a-z0-9]+[_-])*(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)["'`]?\s*(?:=|:)\s*(["'`])([^"'`\r\n]{12,})\1/gi;
const SQL_PASSWORD_PATTERN = /\bIDENTIFIED(?:\s+WITH\s+[A-Z0-9_]+)?\s+BY\s+(['"`])([^'"`\r\n]{12,})\1/gi;

// These are non-routable, private, documentation, benchmark, multicast, or
// otherwise reserved IPv4 ranges. Public literals remain findings by design.
function isReservedIPv4(value) {
    const octets = value.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;

    const [first, second, third] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 0 && third === 0) return true;
    if (first === 192 && second === 168) return true;
    if (first === 192 && second === 0 && third === 2) return true;
    if (first === 192 && second === 88 && third === 99) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first === 198 && second === 51 && third === 100) return true;
    if (first === 203 && second === 0 && third === 113) return true;
    return false;
}

function isPlaceholder(value) {
    const normalized = value.trim().toLowerCase();
    return normalized.length === 0 ||
        /\s/.test(value) ||
        value.includes("${") ||
        normalized.startsWith("x~") ||
        /^(?:<[^>]+>|\$\{?[a-z0-9_.-]+\}?|\*+|x+=*|example(?:[-_ ]value)?|changeme|replace[-_ ]me|redacted|dummy|fake|test|your[-_ ](?:password|token|secret|key))$/i.test(normalized) ||
        normalized.startsWith("process.env.") ||
        normalized.startsWith("os.environ[");
}

function positionAt(text, offset) {
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    return { line, column: offset - lastNewline };
}

function normalizeRelativePath(filePath) {
    return filePath.split(path.sep).join("/");
}

function addFinding(findings, kind, name, text, offset, filePath) {
    const position = positionAt(text, offset);
    findings.push({
        kind,
        name,
        path: filePath,
        line: position.line,
        column: position.column
    });
}

function scanText(text, filePath) {
    const findings = [];
    for (const match of text.matchAll(IPV4_PATTERN)) {
        const value = match[0];
        if (!isReservedIPv4(value)) addFinding(findings, "ipv4", "public-ipv4", text, match.index, filePath);
    }
    for (const [name, pattern] of [["private-key-marker", PRIVATE_KEY_PATTERN], ...SECRET_PATTERNS]) {
        for (const match of text.matchAll(pattern)) addFinding(findings, "secret", name, text, match.index, filePath);
    }
    for (const [name, pattern] of [["generic-secret-assignment", GENERIC_SECRET_PATTERN], ["sql-password", SQL_PASSWORD_PATTERN]]) {
        for (const match of text.matchAll(pattern)) {
            const value = match[2];
            if (!isPlaceholder(value)) addFinding(findings, "secret", name, text, match.index, filePath);
        }
    }
    return findings;
}

function repositoryRoot(startPath) {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: startPath, encoding: "utf8" }).trim();
}

function trackedFiles(root) {
    const output = execFileSync("git", ["ls-files", "-z", "--"], { cwd: root, encoding: "buffer" });
    return output.toString("utf8").split("\0").filter(Boolean);
}

function scanRepository(startPath = process.cwd()) {
    const root = repositoryRoot(path.resolve(startPath));
    const findings = [];
    let filesScanned = 0;
    let binaryFilesSkipped = 0;
    for (const relativePath of trackedFiles(root)) {
        const absolutePath = path.join(root, relativePath);
        let file;
        try {
            if (!fs.lstatSync(absolutePath).isFile()) continue;
            file = fs.readFileSync(absolutePath);
        } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
        }
        if (file.includes(0)) {
            binaryFilesSkipped += 1;
            continue;
        }
        filesScanned += 1;
        findings.push(...scanText(file.toString("utf8"), normalizeRelativePath(relativePath)));
    }
    return { root, filesScanned, binaryFilesSkipped, findings };
}

function usage() {
    return "Usage: node scripts/lint-sensitive-data.js [--root PATH]";
}

function parseArguments(argv) {
    const options = { root: process.cwd() };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--root") {
            if (!argv[index + 1]) throw new Error(`${argument} requires a path\n${usage()}`);
            options.root = argv[index + 1];
            index += 1;
        } else if (argument === "--help" || argument === "-h") {
            console.log(usage());
            return null;
        } else {
            throw new Error(`Unknown argument: ${argument}\n${usage()}`);
        }
    }
    return options;
}

function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArguments(argv);
        if (!options) return 0;
        const result = scanRepository(options.root);
        if (result.findings.length === 0) {
            console.log(`Sensitive-data scan passed (${result.filesScanned} text files checked).`);
            return 0;
        }
        for (const finding of result.findings) {
            console.error(`${finding.path}:${finding.line}:${finding.column}: ${finding.kind} (${finding.name})`);
        }
        console.error(`Sensitive-data scan failed: ${result.findings.length} finding(s).`);
        return 1;
    } catch (error) {
        console.error(error.message);
        return 2;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = {
    isReservedIPv4,
    scanRepository,
    scanText
};
