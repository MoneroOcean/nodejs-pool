"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_SRBMINER_GPU_INTENSITY,
    DEFAULT_SRBMINER_CN_GPU_INTENSITY
} = require("./live/shared.js");
const {
    buildSrbMiner,
    buildSrbMinerEthProxy,
    buildCoveragePlan,
    getActiveAlgorithms
} = require("./live/miners.js");
const {
    buildEthBlockSubmitParams,
    matchesBlockSubmitExpectation,
    summarizeBlockSubmitLog
} = require("./live/protocol.js");

test.describe("live miner helpers", { concurrency: false }, () => {
    test("SRBMiner cn/gpu args include conservative stability controls", () => {
        const miner = buildSrbMiner("/tmp/SRBMiner-MULTI");
        const args = miner.buildArgs({
            algorithm: "cn/gpu",
            host: "sg.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~cn/gpu",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerLogPath: "/tmp/srbminer.log",
            srbMinerGpuIntensity: "8",
            srbMinerApiPort: 21550,
            timeoutMs: DEFAULT_TIMEOUT_MS
        });

        assert.equal(args[args.indexOf("--log-file") + 1], "/tmp/srbminer.log");
        assert.equal(args[args.indexOf("--log-file-mode") + 1], "0");
        assert.equal(args[args.indexOf("--gpu-intensity") + 1], "8");
        assert.equal(args.includes("--enable-workers-ramp-up"), true);
        assert.equal(args[args.indexOf("--max-no-share-sent") + 1], String(DEFAULT_TIMEOUT_MS / 1000));
        assert.equal(args.includes("--gpu-disable-interleaving"), true);
        assert.equal(args.includes("--disable-gpu-dual-kernels"), true);
        assert.equal(args.includes("--autotune-no-load"), true);
        assert.equal(args[args.indexOf("--busy-wait-recheck") + 1], "0.01");
        assert.equal(args.includes("--extended-log"), true);
    });

    test("SRBMiner non-cn/gpu args keep default intensity", () => {
        const miner = buildSrbMiner("/tmp/SRBMiner-MULTI");
        const args = miner.buildArgs({
            algorithm: "autolykos2",
            host: "sg.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~autolykos2",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerGpuIntensity: "",
            srbMinerApiPort: 21550,
            timeoutMs: DEFAULT_TIMEOUT_MS
        });

        assert.equal(args.includes("--gpu-intensity"), false);
        assert.equal(args.includes("--enable-workers-ramp-up"), true);
        assert.equal(args.includes("--gpu-disable-interleaving"), false);
        assert.equal(args.includes("--disable-gpu-dual-kernels"), false);
    });

    test("SRBMiner eth-proxy args force getWork mode for etchash", () => {
        const miner = buildSrbMinerEthProxy("/tmp/SRBMiner-MULTI");
        const args = miner.buildArgs({
            algorithm: "etchash",
            host: "sg.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~etchash",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerApiPort: 21550,
            timeoutMs: DEFAULT_TIMEOUT_MS
        });

        assert.equal(miner.supplementalCoverage, true);
        assert.equal(args[args.indexOf("--esm") + 1], "0");
        assert.equal(args[args.indexOf("--max-no-share-sent") + 1], String(DEFAULT_TIMEOUT_MS / 1000));
        assert.equal(args.includes("--nicehash"), false);
        assert.equal(args[args.indexOf("--algorithm") + 1], "etchash");
    });

    test("live coverage keeps regular SRBMiner and adds eth-proxy etchash coverage", () => {
        const regular = buildSrbMiner("/tmp/SRBMiner-MULTI");
        const ethProxy = buildSrbMinerEthProxy("/tmp/SRBMiner-MULTI");
        const plan = buildCoveragePlan([{ algorithm: "etchash" }, { algorithm: "kawpow" }], [regular, ethProxy]);

        assert.deepEqual(plan.map((entry) => [entry.algorithm, entry.miner.name]), [
            ["etchash", "srbminer-multi"],
            ["etchash", "srbminer-multi-ethproxy"],
            ["kawpow", "srbminer-multi"]
        ]);
    });

    test("SRBMiner live default intensity is only conservative for cn/gpu", () => {
        assert.equal(DEFAULT_SRBMINER_GPU_INTENSITY, "");
        assert.equal(DEFAULT_SRBMINER_CN_GPU_INTENSITY, "1");
    });

    test("live algorithms can be narrowed for hardware-safe retries", () => {
        const previous = process.env.NODEJS_POOL_LIVE_ALGOS;
        process.env.NODEJS_POOL_LIVE_ALGOS = "rx/0, rx/arq";
        try {
            const events = [];
            const selected = getActiveAlgorithms({ event: (...args) => events.push(args) });
            assert.deepEqual(selected.map((entry) => entry.algorithm), ["rx/0", "rx/arq"]);
            assert.equal(events[0][1].source, "env");
        } finally {
            if (typeof previous === "undefined") delete process.env.NODEJS_POOL_LIVE_ALGOS;
            else process.env.NODEJS_POOL_LIVE_ALGOS = previous;
        }
    });

    test("live algorithm filters reject unknown names", () => {
        const previous = process.env.NODEJS_POOL_LIVE_ALGOS;
        process.env.NODEJS_POOL_LIVE_ALGOS = "rx/0,missing";
        try {
            assert.throws(
                () => getActiveAlgorithms({ event: () => {} }),
                /Unknown live algorithm filter: missing/
            );
        } finally {
            if (typeof previous === "undefined") delete process.env.NODEJS_POOL_LIVE_ALGOS;
            else process.env.NODEJS_POOL_LIVE_ALGOS = previous;
        }
    });

    test("eth block-submit params use the subscribed extranonce prefix", () => {
        const resultHex = "aa".repeat(32);
        const params = buildEthBlockSubmitParams("wallet", "job-1", resultHex, "ff7e");

        assert.equal(params[0], "wallet");
        assert.equal(params[1], "job-1");
        assert.match(params[2], /^0xff7e[0-9a-f]{12}$/);
        assert.equal(params[5], `0x${resultHex}`);
    });

    test("eth block-submit params reject missing subscribed extranonce", () => {
        assert.throws(
            () => buildEthBlockSubmitParams("wallet", "job-1", "aa".repeat(32), ""),
            /Eth subscribe did not return an extranonce/
        );
    });

    test("xmr dual block-submit expectation allows daemon retry outcomes", () => {
        const worker = "itest-worker";
        const logText = [
            `2026-05-01 [S1] Block submit failed: chain=XMR/18081 height=1 miner="abc:${worker} (127.0.0.1)" trusted=true`,
            `2026-05-01 [S1] Block submit unknown: chain=XTM/18144 height=1 miner="abc:${worker} (127.0.0.1)" trusted=true`,
            `2026-05-01 [S1] Block submit rpc-error: chain=XTM/18144 height=1 miner="abc:${worker} (127.0.0.1)" trusted=true`
        ].join("\n");

        assert.equal(matchesBlockSubmitExpectation(logText, { minOutcomeCount: 2, includeChains: ["XMR/", "XTM/"] }, worker), true);
        assert.equal(matchesBlockSubmitExpectation(logText, { exactFailureCount: 2, includeChains: ["XMR/", "XTM/"] }, worker), false);
        assert.deepEqual(summarizeBlockSubmitLog(logText, worker), {
            outcomeCount: 3,
            failureCount: 1,
            unknownCount: 1,
            rpcErrorCount: 1,
            unresolvedHashCount: 0,
            rejectedCount: 0,
            chains: ["XMR/18081", "XTM/18144", "XTM/18144"]
        });
    });
});
