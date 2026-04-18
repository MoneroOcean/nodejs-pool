"use strict";

const cli = require("../script_utils.js")();

const batchIdRaw = cli.arg("batch_id", "Please specify payment batch id to unlock");
const force = cli.get("force", false);
const SAFE_BATCH_STATUSES = new Set(["reserved", "retrying", "submitting"]);

function exitWithError(message) {
    console.error(message);
    process.exit(1);
}

function parseBatchId(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) exitWithError("Batch id must be a positive integer");
    return parsed;
}

function nowSqlTimestamp() {
    if (global.support && typeof global.support.formatDate === "function") return global.support.formatDate(Date.now());
    const date = new Date();
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

function collectRiskFlags(batch) {
    const flags = [];
    if (!SAFE_BATCH_STATUSES.has(batch.status)) flags.push("status is " + batch.status);
    if (batch.submitted_at) flags.push("submitted_at is set");
    if (batch.tx_hash) flags.push("tx_hash is set");
    if (batch.tx_key) flags.push("tx_key is set");
    if (batch.transaction_id !== null && typeof batch.transaction_id !== "undefined") flags.push("transaction_id is set");
    if (batch.finalized_at) flags.push("finalized_at is set");
    if (batch.released_at) flags.push("released_at is already set");
    return flags;
}

cli.init(function initScript() {
    (async function main() {
        const batchId = parseBatchId(batchIdRaw);
        const batches = await global.mysql.query("SELECT * FROM payment_batches WHERE id = ?", [batchId]);
        if (!Array.isArray(batches) || batches.length === 0) exitWithError("Payment batch " + batchId + " was not found");

        const batch = batches[0];
        const items = await global.mysql.query(
            "SELECT * FROM payment_batch_items WHERE batch_id = ? ORDER BY destination_order ASC",
            [batchId]
        );
        const reservedBalances = await global.mysql.query(
            "SELECT id, payment_address, payment_id, amount FROM balance WHERE pending_batch_id = ? ORDER BY id ASC",
            [batchId]
        );

        const riskFlags = collectRiskFlags(batch);
        if (riskFlags.length && !force) {
            console.error("Refusing to unlock payment batch " + batchId + " without --force.");
            console.error("Risk flags:");
            riskFlags.forEach(function printFlag(flag) {
                console.error(" - " + flag);
            });
            console.error("Destinations: " + (items.length ? items.map(describeItem).join(", ") : "(none)"));
            process.exit(1);
        }

        const releasedAt = nowSqlTimestamp();
        const note = "manually released for retry by manage_scripts/payment_unlock_batch.js at " + releasedAt;
        const connection = await global.mysql.getConnection();
        try {
            await connection.beginTransaction();
            const balanceResult = await connection.query(
                "UPDATE balance SET pending_batch_id = NULL WHERE pending_batch_id = ?",
                [batchId]
            );
            await connection.query(
                "UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, last_error_text = ? WHERE id = ?",
                ["retryable", releasedAt, releasedAt, note, batchId]
            );
            await connection.commit();

            console.log("Unlocked payment batch " + batchId + " for retry.");
            console.log("Previous status: " + batch.status);
            console.log("Cleared pending balance rows: " + balanceResult.affectedRows);
            console.log("Batch destinations: " + (items.length ? items.map(describeItem).join(", ") : "(none)"));
            if (reservedBalances.length !== items.length) {
                console.log(
                    "Warning: reserved balance rows (" + reservedBalances.length + ") do not match batch items (" + items.length + ")."
                );
            }
            if (riskFlags.length) {
                console.log("Forced despite risk flags: " + riskFlags.join("; "));
            }
        } catch (error) {
            try {
                await connection.rollback();
            } catch (_rollbackError) {}
            exitWithError("Failed to unlock payment batch " + batchId + ": " + (error && error.message ? error.message : String(error)));
        } finally {
            try {
                connection.release();
            } catch (_releaseError) {}
        }

        process.exit(0);
    })().catch(function onError(error) {
        exitWithError("Script failed: " + (error && error.message ? error.message : String(error)));
    });
});
