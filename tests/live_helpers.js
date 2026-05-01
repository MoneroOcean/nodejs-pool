"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    DEFAULT_SRBMINER_GPU_INTENSITY,
    DEFAULT_SRBMINER_CN_GPU_INTENSITY
} = require("./live/shared.js");
const {
    buildSrbMiner,
    getActiveAlgorithms
} = require("./live/miners.js");

test.describe("live miner helpers", { concurrency: false }, () => {
    test("SRBMiner cn/gpu args include conservative stability controls", () => {
        const miner = buildSrbMiner("/tmp/SRBMiner-MULTI");
        const args = miner.buildArgs({
            algorithm: "cn/gpu",
            host: "jp.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~cn/gpu",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerLogPath: "/tmp/srbminer.log",
            srbMinerGpuIntensity: "8",
            srbMinerApiPort: 21550,
            timeoutMs: 180000
        });

        assert.equal(args[args.indexOf("--log-file") + 1], "/tmp/srbminer.log");
        assert.equal(args[args.indexOf("--log-file-mode") + 1], "0");
        assert.equal(args[args.indexOf("--gpu-intensity") + 1], "8");
        assert.equal(args.includes("--enable-workers-ramp-up"), true);
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
            host: "jp.moneroocean.stream",
            port: 20001,
            walletWithDifficulty: "wallet",
            password: "x~autolykos2",
            worker: "worker",
            tls: true,
            srbMinerGpuId: "0",
            srbMinerGpuIntensity: "",
            srbMinerApiPort: 21550,
            timeoutMs: 180000
        });

        assert.equal(args.includes("--gpu-intensity"), false);
        assert.equal(args.includes("--enable-workers-ramp-up"), true);
        assert.equal(args.includes("--gpu-disable-interleaving"), false);
        assert.equal(args.includes("--disable-gpu-dual-kernels"), false);
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
});
