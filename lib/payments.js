"use strict";

const debug = require("debug")("payments");
const createPaymentsCommon = require("./payments/common");
const createPaymentsPlanner = require("./payments/planner");
const createPaymentsProcessor = require("./payments/processor");

const ADVISORY_LOCK_NAME = "nodejs-pool:payments";
const WALLET_STORE_INTERVAL_MS = 60 * 1000;

/*
Runtime-level payout flow
-------------------------
One process at a time owns the MySQL advisory lock, and one cycle at a time runs
inside that process. Every cycle follows the same order:

1. Verify or acquire exclusive access.
2. Recover every durable in-flight batch before planning new work.
3. Plan new candidate batches from balances with no `pending_batch_id`.
4. Reserve and submit batches until one becomes unresolved or manual review is
   required.
5. Advance `lastPaymentCycle` only when the pass stayed completely clean.

That ordering is part of the state machine contract. Planning never runs while
older `reserved`/`retrying`/`submitting`/`submitted` work is unsettled, because
those rows may still own balance reservations or correspond to wallet transfers
that have not been finalized into SQL yet.
*/
function createPaymentsRuntime(options) {
    const opts = options || {};
    const mysqlPool = opts.mysql || global.mysql;
    const database = opts.database || global.database;
    const support = opts.support || global.support;
    const config = opts.config || global.config;
    const setTimeoutFn = opts.setTimeout || setTimeout;
    const clearTimeoutFn = opts.clearTimeout || clearTimeout;
    const now = opts.now || Date.now;
    const advisoryLockName = opts.advisoryLockName || ADVISORY_LOCK_NAME;
    const ctx = { config, debug, mysqlPool, now, support };
    const state = {
        activeBatchId: null,
        cyclePromise: null,
        failStopReason: null,
        isFailStop: false,
        lockConnection: null,
        lockConnectionId: null,
        storeTimer: null,
        started: false,
        timer: null
    };
    const common = createPaymentsCommon(ctx);
    const planner = createPaymentsPlanner(ctx, common);
    const processor = createPaymentsProcessor(ctx, state, { common, planner, enterFailStop, verifyExclusiveAccess: verifyAdvisoryLock });
    const { formatError, logError, logInfo, logWarn, normalizeInteger, querySingleValue } = common;

    function renderEmailTemplate(item, values, fallback) {
        if (support && typeof support.renderEmailTemplate === "function") return support.renderEmailTemplate(item, values, fallback);
        const template = config && config.email && typeof config.email[item] === "string" ? config.email[item] : fallback;
        return support && typeof support.formatTemplate === "function"
            ? support.formatTemplate(template || "", values || {})
            : String(template || "");
    }

    async function fetchConnectionId(connection) {
        if (normalizeInteger(connection.threadId) !== null) return normalizeInteger(connection.threadId);
        return await querySingleValue(connection, "SELECT CONNECTION_ID() AS connection_id", [], "connection_id");
    }

    async function enterFailStop(scope, message, batchId) {
        if (batchId) state.activeBatchId = batchId;
        // Fail-stop is a latch, not a transient error state. Once we decide the
        // runtime can no longer reason safely about payouts we stop scheduling
        // fresh work and require an operator restart after review.
        if (state.isFailStop) return false;
        state.isFailStop = true;
        state.failStopReason = message;
        logError(scope, message);
        if (support && typeof support.sendEmail === "function" && config && config.general && config.general.adminEmail) {
            const values = { message: message };
            support.sendEmail(
                config.general.adminEmail,
                renderEmailTemplate("paymentFailStopSubject", values, "Payment runtime fail-stop"),
                renderEmailTemplate("paymentFailStopBody", values, "The payment runtime entered fail-stop: %(message)s.\nPlease review batches and restart payments after resolving the issue.")
            );
        }
        return false;
    }

    async function ensureAdvisoryLock() {
        if (state.lockConnection) return await verifyAdvisoryLock();
        if (typeof mysqlPool.getConnection !== "function") return await enterFailStop("lock", "mysql pool cannot acquire advisory lock");
        try {
            // GET_LOCK is tied to the specific MySQL connection, so we keep one
            // dedicated connection open for the full runtime and verify that the
            // same thread still owns the lock before each critical phase.
            state.lockConnection = await mysqlPool.getConnection();
            state.lockConnectionId = await fetchConnectionId(state.lockConnection);
            const locked = await querySingleValue(
                state.lockConnection,
                "SELECT GET_LOCK(?, 0) AS locked",
                [advisoryLockName],
                "locked"
            );
            if (locked !== 1) {
                await releaseAdvisoryLock();
                return await enterFailStop("lock", "advisory lock busy for " + advisoryLockName);
            }
            logInfo("lock", "acquired advisory lock " + advisoryLockName + " on connection " + state.lockConnectionId);
            return true;
        } catch (error) {
            return await enterFailStop("lock", "failed to acquire advisory lock: " + formatError(error));
        }
    }

    async function verifyAdvisoryLock() {
        if (!state.lockConnection) return false;
        try {
            // If another process owns the advisory lock, or the connection died,
            // we can no longer assume exclusive control of payout submission.
            const ownerId = await querySingleValue(
                state.lockConnection,
                "SELECT IS_USED_LOCK(?) AS owner_id",
                [advisoryLockName],
                "owner_id"
            );
            if (ownerId === null || ownerId !== state.lockConnectionId) {
                return await enterFailStop(
                    "lock",
                    "lost advisory lock " + advisoryLockName + " (expected " + state.lockConnectionId + ", got " + ownerId + ")"
                );
            }
            return true;
        } catch (error) {
            return await enterFailStop("lock", "advisory lock check failed: " + formatError(error));
        }
    }

    async function releaseAdvisoryLock() {
        if (!state.lockConnection) return;
        try {
            await state.lockConnection.query("SELECT RELEASE_LOCK(?) AS released", [advisoryLockName]);
        } catch (_error) {}
        try {
            if (typeof state.lockConnection.release === "function") state.lockConnection.release();
        } catch (_error) {}
        state.lockConnection = null;
        state.lockConnectionId = null;
    }

    function callWalletStore() {
        if (!support || typeof support.rpcWallet !== "function") return;
        try {
            support.rpcWallet("store", [], function ignoreReply() {}, true);
        } catch (error) {
            logWarn("store", "wallet store heartbeat failed: " + formatError(error));
        }
    }

    function scheduleWalletStore(delayMs) {
        if (!state.started || !support || typeof support.rpcWallet !== "function") return;
        state.storeTimer = setTimeoutFn(function onStoreTimer() {
            state.storeTimer = null;
            if (!state.started) return;
            try {
                callWalletStore();
            } finally {
                if (state.started) scheduleWalletStore(WALLET_STORE_INTERVAL_MS);
            }
        }, delayMs);
        if (state.storeTimer && typeof state.storeTimer.unref === "function") state.storeTimer.unref();
    }

    async function runCycle() {
        try {
            if (state.isFailStop) return { clean: false };
            if (!await ensureAdvisoryLock()) return { clean: false };
            // Recovery always runs before new planning so every durable in-flight
            // batch is settled, retried, or escalated before we reserve more
            // balances from the same wallet.
            if (!await verifyAdvisoryLock() || !await processor.recoverPendingBatches("startup-recovery")) return { clean: false };

            const batches = await planner.planBatches();
            let createdUnresolvedBatch = false;
            let hadRetryableBatch = false;
            for (const batchPlan of batches) {
                if (!await verifyAdvisoryLock()) return { clean: false };
                const batch = await planner.reserveBatch(batchPlan);
                logInfo("batch#" + batch.id, "reserved " + batch.items.length + " destinations");
                const outcome = await processor.submitReservedBatch(batch);
                if (outcome === "retryable") {
                    hadRetryableBatch = true;
                    continue;
                }
                // Any held or manual-review batch stops the cycle immediately so
                // we do not plan around an unresolved payout while it still owns
                // balance reservations or requires operator judgment.
                if (outcome !== "cleared" && outcome !== "retryable") {
                    createdUnresolvedBatch = true;
                    break;
                }
            }

            // lastPaymentCycle is only advanced after a fully clean pass. If any
            // batch is waiting for retry or reconcile, external monitors should
            // continue seeing the cycle as incomplete.
            if (!createdUnresolvedBatch && !hadRetryableBatch && !state.isFailStop && database && typeof database.setCache === "function") {
                database.setCache("lastPaymentCycle", Math.floor(now() / 1000));
                logInfo("cycle", "completed cleanly");
                return { clean: true };
            }
            if (hadRetryableBatch) logInfo("cycle", "retryable payout issues detected; lastPaymentCycle not advanced");
            return { clean: false };
        } catch (error) {
            logError("cycle", "retry later after error: " + formatError(error));
            return { clean: false };
        }
    }

    async function runSerializedCycle() {
        if (state.cyclePromise) return await state.cyclePromise;
        // Timer ticks can overlap if a cycle runs long. Promise reuse keeps the
        // runtime single-threaded inside one process even before MySQL locking.
        state.cyclePromise = (async function executeCycle() {
            try {
                return await runCycle();
            } finally {
                state.activeBatchId = null;
                state.cyclePromise = null;
            }
        })();
        return await state.cyclePromise;
    }

    function scheduleNextCycle(delayMs) {
        if (!state.started || state.isFailStop) return;
        state.timer = setTimeoutFn(async function onTimer() {
            state.timer = null;
            try {
                await runSerializedCycle();
            } catch (error) {
                await enterFailStop("cycle", "payment cycle failed: " + formatError(error), state.activeBatchId);
            } finally {
                // The next timer is scheduled after the current cycle finishes,
                // so a slow wallet extends the interval instead of queueing up
                // overlapping payout attempts.
                if (state.started && !state.isFailStop) scheduleNextCycle(config.payout.timer * 60 * 1000);
            }
        }, delayMs);
        if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    }

    return {
        start() {
            if (state.started) return this;
            state.started = true;
            scheduleNextCycle(0);
            if (support && typeof support.rpcWallet === "function") {
                callWalletStore();
                scheduleWalletStore(WALLET_STORE_INTERVAL_MS);
            }
            return this;
        },

        async stop() {
            state.started = false;
            if (state.timer !== null) {
                clearTimeoutFn(state.timer);
                state.timer = null;
            }
            if (state.storeTimer !== null) {
                clearTimeoutFn(state.storeTimer);
                state.storeTimer = null;
            }
            if (state.cyclePromise) {
                try {
                    await state.cyclePromise;
                } catch (_error) {}
            }
            await releaseAdvisoryLock();
        },

        inspectState() {
            return {
                activeBatchId: state.activeBatchId,
                failStopReason: state.failStopReason,
                isFailStop: state.isFailStop,
                lockConnectionId: state.lockConnectionId,
                started: state.started
            };
        },

        planBatches: planner.planBatches,
        recoverPendingBatches: processor.recoverPendingBatches,
        runCycle: runSerializedCycle
    };
}

const runtime = global.__paymentsAutostart === false ? null : createPaymentsRuntime();
if (runtime) runtime.start();

module.exports = runtime || {};
module.exports.createPaymentsRuntime = createPaymentsRuntime;
