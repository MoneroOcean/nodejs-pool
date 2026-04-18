"use strict";

const ADVISORY_LOCK_NAME = "nodejs-pool:payments";
const SAFE_BATCH_STATUSES = new Set(["reserved", "retrying"]);

function createUnlockError(message, details) {
    const error = new Error(message);
    if (details && typeof details === "object") Object.assign(error, details);
    return error;
}

function exitWithError(message) {
    console.error(message);
    process.exit(1);
}

function parseBatchId(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) exitWithError("Batch id must be a positive integer");
    return parsed;
}

function nowSqlTimestamp(support, timestampMs) {
    if (support && typeof support.formatDate === "function") return support.formatDate(timestampMs);
    const date = new Date(timestampMs);
    const pad = function pad(value) { return String(value).padStart(2, "0"); };
    return date.getUTCFullYear() + "-" +
        pad(date.getUTCMonth() + 1) + "-" +
        pad(date.getUTCDate()) + " " +
        pad(date.getUTCHours()) + ":" +
        pad(date.getUTCMinutes()) + ":" +
        pad(date.getUTCSeconds());
}

function describeItem(item) {
    return item.payment_address;
}

function isPresent(value) {
    return value !== null && typeof value !== "undefined" && value !== "";
}

function collectUnsafeUnlockFlags(batch) {
    const flags = [];
    if (isPresent(batch.submit_started_at)) flags.push("submit_started_at is set");
    if (isPresent(batch.submitted_at)) flags.push("submitted_at is set");
    if (isPresent(batch.tx_hash)) flags.push("tx_hash is set");
    if (isPresent(batch.tx_key)) flags.push("tx_key is set");
    if (isPresent(batch.transaction_id)) flags.push("transaction_id is set");
    if (isPresent(batch.finalized_at)) flags.push("finalized_at is set");
    return flags;
}

function collectRiskFlags(batch, items, reservedBalances) {
    const flags = [];
    if (!SAFE_BATCH_STATUSES.has(batch.status)) flags.push("status is " + batch.status);
    if (isPresent(batch.released_at)) flags.push("released_at is already set");
    if (Array.isArray(items) && Array.isArray(reservedBalances) && reservedBalances.length !== items.length) {
        flags.push("reserved balance rows (" + reservedBalances.length + ") do not match batch items (" + items.length + ")");
    }
    return flags;
}

async function querySingleValue(connection, sql, params, key) {
    const rows = await connection.query(sql, params);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row !== "object") return null;
    if (key && Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
}

async function withPaymentsAdvisoryLock(mysql, work, lockName) {
    const advisoryLockName = lockName || ADVISORY_LOCK_NAME;
    const connection = await mysql.getConnection();
    let lockHeld = false;
    try {
        const connectionId = await querySingleValue(connection, "SELECT CONNECTION_ID() AS connection_id", [], "connection_id");
        const locked = await querySingleValue(connection, "SELECT GET_LOCK(?, 0) AS locked", [advisoryLockName], "locked");
        if (locked !== 1) {
            throw createUnlockError(
                "Payment advisory lock is busy for " + advisoryLockName + ". Stop the payments runtime before unlocking batches.",
                { code: "lock_busy", connectionId }
            );
        }
        lockHeld = true;
        return await work(connection);
    } finally {
        if (lockHeld) {
            try {
                await connection.query("SELECT RELEASE_LOCK(?) AS released", [advisoryLockName]);
            } catch (_releaseLockError) {}
        }
        try {
            connection.release();
        } catch (_releaseError) {}
    }
}

async function loadBatchState(connection, batchId) {
    const batches = await connection.query("SELECT * FROM payment_batches WHERE id = ?", [batchId]);
    if (!Array.isArray(batches) || batches.length === 0) {
        throw createUnlockError("Payment batch " + batchId + " was not found", { code: "missing_batch" });
    }
    const batch = batches[0];
    const items = await connection.query(
        "SELECT * FROM payment_batch_items WHERE batch_id = ? ORDER BY destination_order ASC",
        [batchId]
    );
    const reservedBalances = await connection.query(
        "SELECT id, payment_address, payment_id, amount FROM balance WHERE pending_batch_id = ? ORDER BY id ASC",
        [batchId]
    );
    return { batch, items, reservedBalances };
}

function assertUnlockAllowed(batchId, batch, items, reservedBalances, force) {
    const unsafeFlags = collectUnsafeUnlockFlags(batch);
    if (unsafeFlags.length) {
        throw createUnlockError(
            "Refusing to unlock payment batch " + batchId + " because it may already have crossed the wallet submit boundary.",
            { code: "unsafe_batch", flags: unsafeFlags, items, reservedBalances }
        );
    }
    const riskFlags = collectRiskFlags(batch, items, reservedBalances);
    if (riskFlags.length && !force) {
        throw createUnlockError(
            "Refusing to unlock payment batch " + batchId + " without --force.",
            { code: "force_required", flags: riskFlags, items, reservedBalances }
        );
    }
    return riskFlags;
}

async function unlockBatch(options) {
    const opts = options || {};
    const mysql = opts.mysql || global.mysql;
    const support = opts.support || global.support;
    const batchId = parseBatchId(opts.batchId);
    const force = opts.force === true;
    const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();

    if (!mysql || typeof mysql.getConnection !== "function") {
        throw new Error("MySQL pool does not support connections required for advisory locking");
    }

    return await withPaymentsAdvisoryLock(mysql, async function runUnlock(connection) {
        const loaded = await loadBatchState(connection, batchId);
        const riskFlags = assertUnlockAllowed(batchId, loaded.batch, loaded.items, loaded.reservedBalances, force);
        const releasedAt = nowSqlTimestamp(support, nowMs);
        const note = "manually released for retry by manage_scripts/payment_unlock_batch.js at " + releasedAt;

        await connection.beginTransaction();
        try {
            const balanceResult = await connection.query(
                "UPDATE balance SET pending_batch_id = NULL WHERE pending_batch_id = ?",
                [batchId]
            );
            const batchResult = await connection.query(
                "UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND submit_started_at IS NULL AND status IN (?, ?)",
                ["retryable", releasedAt, releasedAt, note, batchId, "reserved", "retrying"]
            );
            if (!batchResult || batchResult.affectedRows !== 1) {
                throw new Error("Payment batch " + batchId + " changed while unlocking; re-read it before retrying");
            }
            await connection.commit();
            return {
                batch: loaded.batch,
                clearedPendingRows: balanceResult.affectedRows,
                items: loaded.items,
                releasedAt,
                reservedBalances: loaded.reservedBalances,
                riskFlags
            };
        } catch (error) {
            try {
                await connection.rollback();
            } catch (_rollbackError) {}
            throw error;
        }
    }, opts.advisoryLockName);
}

function printUnlockError(error, batchId) {
    if (!error || typeof error !== "object") {
        exitWithError("Failed to unlock payment batch " + batchId + ": " + String(error));
        return;
    }
    if (error.code === "force_required" || error.code === "unsafe_batch") {
        console.error(error.message);
        console.error(error.code === "unsafe_batch" ? "Unsafe flags:" : "Risk flags:");
        (error.flags || []).forEach(function printFlag(flag) {
            console.error(" - " + flag);
        });
        const items = Array.isArray(error.items) ? error.items : [];
        console.error("Destinations: " + (items.length ? items.map(describeItem).join(", ") : "(none)"));
        process.exit(1);
    }
    exitWithError("Failed to unlock payment batch " + batchId + ": " + (error.message || String(error)));
}

function runCli() {
    const cli = require("../script_utils.js")();
    const batchIdRaw = cli.arg("batch_id", "Please specify payment batch id to unlock");
    const force = cli.get("force", false);

    cli.init(function initScript() {
        (async function main() {
            const batchId = parseBatchId(batchIdRaw);
            try {
                const result = await unlockBatch({
                    batchId,
                    force,
                    mysql: global.mysql,
                    support: global.support
                });
                console.log("Unlocked payment batch " + batchId + " for retry.");
                console.log("Previous status: " + result.batch.status);
                console.log("Cleared pending balance rows: " + result.clearedPendingRows);
                console.log("Batch destinations: " + (result.items.length ? result.items.map(describeItem).join(", ") : "(none)"));
                if (result.riskFlags.length) {
                    console.log("Forced despite risk flags: " + result.riskFlags.join("; "));
                }
                process.exit(0);
            } catch (error) {
                printUnlockError(error, batchId);
            }
        })().catch(function onError(error) {
            exitWithError("Script failed: " + (error && error.message ? error.message : String(error)));
        });
    });
}

module.exports = {
    ADVISORY_LOCK_NAME,
    SAFE_BATCH_STATUSES,
    collectRiskFlags,
    collectUnsafeUnlockFlags,
    nowSqlTimestamp,
    parseBatchId,
    unlockBatch
};

if (require.main === module) runCli();
