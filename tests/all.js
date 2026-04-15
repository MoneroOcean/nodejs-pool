"use strict";

const test = require("node:test");

const {
    isDefaultTargetReachable,
    buildConfig,
    createLivePoolRun,
    executeScenario,
    executeProtocolProbeBatch,
    finalizeLivePoolRun,
    formatFailureDetails
} = require("./pool_live.js");

require("./pool_components.js");
require("./pool_coin.js");
require("./block_manager.js");
require("./long_runner.js");
require("./stats.js");
require("./worker.js");
require("./pool_protocol.js");
require("./pool_remote_uplink.js");
require("./pool_validation.js");
require("./pool_runtime.js");
require("./remote_share.js");
require("./support.js");

test("live miner integration suite", { timeout: 60 * 60 * 1000 }, async (t) => {
    if (!(await isDefaultTargetReachable())) {
        t.skip("No live TLS pool endpoint responded on localhost:20001.");
        return;
    }

    const run = await createLivePoolRun(buildConfig());
    const coveredResults = [];

    try {
        const minerPlans = run.coveredPlans.filter((plan) => plan.miner);
        const protocolPlans = run.coveredPlans.filter((plan) => !plan.miner && plan.protocolProbe);

        for (const plan of minerPlans) {
            await t.test(plan.algorithm, { timeout: run.config.timeoutMs + 60 * 1000 }, async () => {
                const target = await executeScenario(run, plan, {
                    name: run.config.targetName,
                    host: run.config.targetHost,
                    port: run.config.targetPort
                });
                coveredResults.push({
                    algorithm: plan.algorithm,
                    miner: plan.miner ? plan.miner.name : "protocol-probe",
                    target
                });

                if (!target.success) {
                    throw target.failureReason || "failed";
                }
            }).catch(() => {});
        }

        if (protocolPlans.length) {
            const targets = await executeProtocolProbeBatch(run, protocolPlans, {
                name: run.config.targetName,
                host: run.config.targetHost,
                port: run.config.targetPort
            });

            for (const target of targets) {
                coveredResults.push({
                    algorithm: target.algorithm,
                    miner: target.miner,
                    target
                });

                await t.test(target.algorithm, async () => {
                    if (!target.success) {
                        throw target.failureReason || "failed";
                    }
                }).catch(() => {});
            }
        }

        const summary = await finalizeLivePoolRun(run, coveredResults, null);
        if (summary.failureCount > 0) {
            const details = await formatFailureDetails(summary);
            if (details) process.stdout.write(`\nLive miner logs\n${details}\n`);
        }
        if (summary.error) throw String(summary.error);
    } catch (error) {
        const summary = await finalizeLivePoolRun(run, coveredResults, error);
        const details = await formatFailureDetails(summary);
        if (details) process.stdout.write(`\nLive miner logs\n${details}\n`);
        throw String(summary.error || error.message || error);
    }
});
