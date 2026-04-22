"use strict";

const test = require("node:test");

const {
    BLOCK_SUBMIT_LIVE_CASES,
    isDefaultTargetReachable,
    buildConfig,
    cleanupLiveBlockSubmitCoverage,
    createLivePoolRun,
    executeScenario,
    executeLiveBlockSubmitCoverageCase,
    executeProtocolProbeBatch,
    finalizeLivePoolRun,
    formatFailureDetails,
    setupLiveBlockSubmitCoverage
} = require("./live/runner.js");

const LIVE_TARGET_HOST = process.env.NODEJS_POOL_LIVE_TARGET_HOST || "";
const liveReachable = async () => LIVE_TARGET_HOST ? true : await isDefaultTargetReachable();
const liveConfig = () => buildConfig({ emitStartLines: false, targetHost: LIVE_TARGET_HOST || undefined });

test.describe("live miner integration suite", { concurrency: false }, () => {
    const state = {
        skipReason: null,
        run: null,
        target: null,
        blockSubmitCoverage: null,
        blockSubmitFailure: false,
        coveredResults: [],
        fatalError: null,
        summary: null,
        printedFailureDetails: false
    };
    const skipIf = (t, reason) => !!(reason && (t.skip(reason), true));
    const liveSkipReason = () => state.skipReason || (state.fatalError ? "Aborted after earlier live-suite failure." : "");
    const blockSubmitSkipReason = () => state.skipReason
        || (state.fatalError && !state.blockSubmitCoverage ? "Aborted after earlier block submit coverage setup failure." : "")
        || (!state.blockSubmitCoverage ? "Block submit coverage runs only against the default localhost pool." : "");
    const postCoverageSkipReason = () => liveSkipReason() || (state.blockSubmitFailure ? "Skipped after block submit coverage failure." : "");
    const recordCoveredResult = (algorithm, miner, target) => state.coveredResults.push({ algorithm, miner, target });
    const fail = (error, { blockSubmit = false, fatal = false } = {}) => {
        if (blockSubmit) state.blockSubmitFailure = true;
        if (fatal) state.fatalError = error;
        throw error;
    };

    const finalizeRun = async () => {
        if (!state.run || state.summary) return state.summary;
        if (!state.fatalError && state.blockSubmitFailure) {
            state.fatalError = new Error("Block submit coverage failed. See the failing block submit coverage subtests above.");
        }
        state.summary = await finalizeLivePoolRun(state.run, state.coveredResults, state.fatalError);
        return state.summary;
    };
    const showSummary = async () => {
        const summary = await finalizeRun();
        if (summary && summary.failureCount > 0 && !state.printedFailureDetails) {
            const details = await formatFailureDetails(summary);
            if (details) process.stdout.write(`\nLive miner logs\n${details}\n`);
            state.printedFailureDetails = true;
        }
        return summary;
    };

    test("setup", { timeout: 5 * 60 * 1000 }, async (t) => {
        if (!(await liveReachable())) {
            state.skipReason = "No live TLS pool endpoint responded on localhost:20001.";
            t.skip(state.skipReason);
            return;
        }

        state.run = await createLivePoolRun(liveConfig());
        state.target = {
            name: state.run.config.targetName,
            host: state.run.config.targetHost,
            port: state.run.config.targetPort
        };
    });

    test.describe("block submit coverage", { concurrency: false }, () => {
        test("enable test mode", { timeout: 10 * 60 * 1000 }, async (t) => {
            if (skipIf(t, liveSkipReason())) return;

            try {
                state.blockSubmitCoverage = await setupLiveBlockSubmitCoverage(state.run);
                if (!state.blockSubmitCoverage) t.skip("Block submit coverage runs only against the default localhost pool.");
            } catch (error) {
                fail(error, { blockSubmit: true, fatal: true });
            }
        });

        for (const testCase of BLOCK_SUBMIT_LIVE_CASES) {
            test(testCase.name, { timeout: 10 * 60 * 1000 }, async (t) => {
                if (skipIf(t, blockSubmitSkipReason()
                    || (typeof testCase.skipReason === "function" ? testCase.skipReason(state.blockSubmitCoverage.context) : ""))) return;

                try {
                    await executeLiveBlockSubmitCoverageCase(state.run, state.target, state.blockSubmitCoverage, testCase);
                } catch (error) {
                    fail(error, { blockSubmit: true });
                }
            });
        }

        test("disable test mode", { timeout: 10 * 60 * 1000 }, async (t) => {
            if (skipIf(t, state.skipReason || (!state.blockSubmitCoverage ? "Block submit coverage was not enabled." : ""))) return;

            try {
                await cleanupLiveBlockSubmitCoverage(state.run, state.target, state.blockSubmitCoverage);
            } catch (error) {
                fail(error, { blockSubmit: true });
            }
        });

        test.after(async () => {
            if (state.blockSubmitCoverage && !state.blockSubmitCoverage.cleanedUp) {
                try {
                    await cleanupLiveBlockSubmitCoverage(state.run, state.target, state.blockSubmitCoverage);
                } catch (error) {
                    fail(error, { blockSubmit: true });
                }
            }
        });
    });

    test("miners", { timeout: 45 * 60 * 1000 }, async (t) => {
        if (skipIf(t, postCoverageSkipReason())) return;

        try {
            const minerPlans = state.run.coveredPlans.filter((plan) => plan.miner);
            for (const plan of minerPlans) {
                await t.test(plan.algorithm, { timeout: state.run.config.timeoutMs + 60 * 1000 }, async () => {
                    const target = await executeScenario(state.run, plan, state.target);
                    recordCoveredResult(plan.algorithm, plan.miner ? plan.miner.name : "protocol-probe", target);

                    if (!target.success) {
                        throw target.failureReason || "failed";
                    }
                }).catch(() => {});
            }
        } catch (error) {
            fail(error, { fatal: true });
        }
    });

    test("protocol probes", { timeout: 20 * 60 * 1000 }, async (t) => {
        if (skipIf(t, postCoverageSkipReason())) return;

        try {
            const protocolPlans = state.run.coveredPlans.filter((plan) => !plan.miner && plan.protocolProbe);
            if (!protocolPlans.length) return void t.skip("No protocol probe plans matched the active live algorithms.");

            const targets = await executeProtocolProbeBatch(state.run, protocolPlans, state.target);
            for (const target of targets) {
                recordCoveredResult(target.algorithm, target.miner, target);

                await t.test(target.algorithm, async () => {
                    if (!target.success) {
                        throw target.failureReason || "failed";
                    }
                }).catch(() => {});
            }
        } catch (error) {
            fail(error, { fatal: true });
        }
    });

    test("summary", { timeout: 10 * 60 * 1000 }, async (t) => {
        if (skipIf(t, state.skipReason)) return;
        await showSummary();
    });

    test.after(async () => {
        await showSummary();
    });
});
