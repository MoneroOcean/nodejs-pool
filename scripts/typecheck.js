"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const compiler = require.resolve("typescript/bin/tsc");
const projects = [path.join(root, "tsconfig.json")];
const privateProject = path.join(root, "lib2", "tsconfig.json");
// Public checkouts have no lib2; installed peer repositories must pass too.
if (fs.existsSync(privateProject)) projects.push(privateProject);

for (const project of projects) {
    const result = spawnSync(process.execPath, [compiler, "--project", project], { stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
}
