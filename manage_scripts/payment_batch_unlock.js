"use strict";
const createPaymentsCommon = require("../lib/payments/common.js");

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** @typedef {import("../types/runtime").SqlRow & {id: number|string, status: string, submit_started_at?: string | Date | null, submitted_at?: string | Date | null, tx_hash?: string | null, tx_key?: string | null, transaction_id?: number | null, finalized_at?: string | Date | null, released_at?: string | Date | null}} PaymentBatch */
/** @typedef {import("../types/runtime").SqlRow & {payment_address: string}} PaymentItem */
/** @typedef {{batch: PaymentBatch, items: PaymentItem[], reservedBalances: import("../types/runtime").SqlRows}} BatchState */
/** @typedef {{support: import("../types/runtime").SupportRuntime, config: import("../types/runtime").PoolConfig}} WalletDeps */
/** @typedef {{status: "no_match"} | {status: "match_found", txid: string} | {status: "wallet_unavailable", message: string}} WalletMatch */
/** @typedef {(batch: PaymentBatch, items: PaymentItem[], deps: WalletDeps) => Promise<WalletMatch>} WalletMatchChecker */
/** @typedef {{batchId?: unknown, force?: unknown, confirmWalletHistoryChecked?: unknown, nowMs?: number, mysql?: import("../types/runtime").SqlPool, support?: import("../types/runtime").SupportRuntime, config?: import("../types/runtime").PoolConfig, walletMatchChecker?: WalletMatchChecker, advisoryLockName?: string}} UnlockOptions */
/** @typedef {{code: string, flags?: string[], items?: PaymentItem[], reservedBalances?: import("../types/runtime").SqlRows, connectionId?: unknown, txid?: string}} UnlockDetails */

const ADVISORY_LOCK_NAME = "nodejs-pool:payments";
const SAFE_BATCH_STATUSES = new Set(["reserved", "retrying"]);
// Mirror the runtime reconcile lookback so the operator-side wallet check scans
// the same recent-transfer window rather than the whole wallet history.
const RECENT_TRANSFER_LOOKBACK_BLOCKS = 31 * 24 * 30;

/** @param {unknown} value */
function isBooleanOption(value) {
    return value === true || value === "true" || value === "1";
}

class UnlockError extends Error {
    /** @param {string} message @param {UnlockDetails} details */
    constructor(message, details) {
        super(message);
        this.code = details.code;
        this.flags = details.flags ?? [];
        this.items = details.items ?? [];
        this.reservedBalances = details.reservedBalances ?? [];
        this.connectionId = details.connectionId ?? null;
        this.txid = details.txid ?? null;
    }
}

/** @param {string} message @returns {never} */
function exitWithError(message) {
    console.error(message);
    process.exit(1);
}

/** @param {unknown} value */
function parseBatchId(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) exitWithError("Batch id must be a positive integer");
    return parsed;
}

/** @param {Pick<import("../types/runtime").SupportRuntime, "formatDate"> | null} support @param {number} timestampMs */
function nowSqlTimestamp(support, timestampMs) {
    if (support && typeof support.formatDate === "function") return support.formatDate(timestampMs);
    const date = new Date(timestampMs);
    /** @param {number} value */
    const pad = function pad(value) { return String(value).padStart(2, "0"); };
    return `${date.getUTCFullYear()  }-${ 
        pad(date.getUTCMonth() + 1)  }-${ 
        pad(date.getUTCDate())  } ${ 
        pad(date.getUTCHours())  }:${ 
        pad(date.getUTCMinutes())  }:${ 
        pad(date.getUTCSeconds())}`;
}

/** @param {PaymentItem} item */
function describeItem(item) { return item.payment_address; }

/** @param {unknown} value */
function isPresent(value) { return value !== null && typeof value !== "undefined" && value !== ""; }

/** @param {PaymentBatch} batch @param {boolean} confirmWalletHistoryChecked @returns {string[]} */
function collectUnsafeUnlockFlags(batch, confirmWalletHistoryChecked) {
    const flags = [];
    if (!confirmWalletHistoryChecked && isPresent(batch.submit_started_at)) {
        flags.push("submit_started_at is set");
    }
    if (isPresent(batch.submitted_at)) flags.push("submitted_at is set");
    if (isPresent(batch.tx_hash)) flags.push("tx_hash is set");
    if (isPresent(batch.tx_key)) flags.push("tx_key is set");
    if (isPresent(batch.transaction_id)) flags.push("transaction_id is set");
    if (isPresent(batch.finalized_at)) flags.push("finalized_at is set");
    return flags;
}

/** @param {PaymentBatch} batch @param {PaymentItem[]} items @param {import("../types/runtime").SqlRows} reservedBalances @returns {string[]} */
function collectRiskFlags(batch, items, reservedBalances) {
    const flags = [];
    if (!SAFE_BATCH_STATUSES.has(batch.status)) flags.push(`status is ${  batch.status}`);
    if (isPresent(batch.released_at)) flags.push("released_at is already set");
    if (Array.isArray(items) && Array.isArray(reservedBalances) && reservedBalances.length !== items.length) {
        flags.push(`reserved balance rows (${  reservedBalances.length  }) do not match batch items (${  items.length  })`);
    }
    return flags;
}

/** @param {import("../types/runtime").SqlConnection} connection @param {string} sql @param {import("../types/runtime").SqlParam[]} params @param {string} key @returns {Promise<import("../types/runtime").Scalar>} */
async function querySingleValue(connection, sql, params, key) {
    const rows = await connection.query(sql, params);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row !== "object") return null;
    if (key && Object.prototype.hasOwnProperty.call(row, key)) return row[key] ?? null;
    const keys = Object.keys(row);
    const firstKey = keys[0];
    return firstKey === undefined ? null : row[firstKey] ?? null;
}

/** @template T @param {import("../types/runtime").SqlPool} mysql @param {(connection: import("../types/runtime").SqlConnection) => Promise<T>} work @param {string} [lockName] @returns {Promise<T>} */
async function withPaymentsAdvisoryLock(mysql, work, lockName) {
    const advisoryLockName = lockName || ADVISORY_LOCK_NAME;
    const connection = await mysql.getConnection();
    let lockHeld = false;
    try {
        const connectionId = await querySingleValue(connection, "SELECT CONNECTION_ID() AS connection_id", [], "connection_id");
        const locked = await querySingleValue(connection, "SELECT GET_LOCK(?, 0) AS locked", [advisoryLockName], "locked");
        if (locked !== 1) {
            throw new UnlockError(
                `Payment advisory lock is busy for ${  advisoryLockName  }. Stop the payments runtime before unlocking batches.`,
                { code: "lock_busy", connectionId }
            );
        }
        lockHeld = true;
        return await work(connection);
    } finally {
        if (lockHeld) {
            try {
                await connection.query("SELECT RELEASE_LOCK(?) AS released", [advisoryLockName]);
            } catch (_releaseLockError) { /* best-effort advisory lock release; ignore errors */ }
        }
        try {
            connection.release();
        } catch (_releaseError) { /* best-effort connection release; ignore errors */ }
    }
}

/** @param {import("../types/runtime").SqlConnection} connection @param {number} batchId @returns {Promise<BatchState>} */
async function loadBatchState(connection, batchId) {
    /** @type {PaymentBatch[]} */
    const batches = await connection.query("SELECT * FROM payment_batches WHERE id = ?", [batchId]);
    if (!Array.isArray(batches) || batches.length === 0 || !batches[0]) {
        throw new UnlockError(`Payment batch ${  batchId  } was not found`, { code: "missing_batch" });
    }
    const batch = batches[0];
    /** @type {PaymentItem[]} */
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

/** @param {number} batchId @param {PaymentBatch} batch @param {PaymentItem[]} items @param {import("../types/runtime").SqlRows} reservedBalances @param {boolean} force @param {boolean} confirmWalletHistoryChecked @returns {string[]} */
function assertUnlockAllowed(batchId, batch, items, reservedBalances, force, confirmWalletHistoryChecked) {
    const unsafeFlags = collectUnsafeUnlockFlags(batch, confirmWalletHistoryChecked);
    if (unsafeFlags.length) {
        throw new UnlockError(
            `Refusing to unlock payment batch ${  batchId  } because it may already have crossed the wallet submit boundary.`,
            { code: "unsafe_batch", flags: unsafeFlags, items, reservedBalances }
        );
    }
    const riskFlags = collectRiskFlags(batch, items, reservedBalances);
    if (riskFlags.length && !force) {
        throw new UnlockError(
            `Refusing to unlock payment batch ${  batchId  } without --force.`,
            { code: "force_required", flags: riskFlags, items, reservedBalances }
        );
    }
    return riskFlags;
}

/** @param {import("../types/runtime").SupportRuntime} support @param {string} method @param {Record<string, unknown>} params @returns {Promise<unknown>} */
function rpcWalletCall(support, method, params) {
    return new Promise(function resolveCall(resolve) {
        support.rpcWallet(method, params, resolve, true);
    });
}

// Crossing the wallet submit boundary on operator attestation alone is unsafe: a
// 'submitting' batch may have already broadcast its transfer. Instead of trusting
// the human "I checked wallet history" claim, the tool checks it itself using the
// exact same matching the runtime uses to auto-reconcile, and fails closed if the
// wallet cannot be reached. Returns one of:
//   { status: "no_match" }            -> safe to unlock
//   { status: "match_found", txid }   -> a real transfer matches; refuse
//   { status: "wallet_unavailable" }  -> cannot prove safety; refuse
/** @param {PaymentBatch} batch @param {PaymentItem[]} items @param {WalletDeps} deps @returns {Promise<WalletMatch>} */
async function defaultWalletMatchChecker(batch, items, deps) {
    const support = deps && deps.support;
    const config = deps && deps.config;
    if (!support || typeof support.rpcWallet !== "function") {
        return { status: "wallet_unavailable", message: "wallet RPC is not available" };
    }
    const common = createPaymentsCommon({ mysqlPool: global.mysql, support, config, now: Date.now });
    const heightReply = await rpcWalletCall(support, "get_height", {});
    const heightResult = isRecord(heightReply) && isRecord(heightReply["result"]) ? heightReply["result"] : null;
    const walletHeight = heightResult ? Number(heightResult["height"]) : null;
    if (walletHeight === null || !Number.isFinite(walletHeight)) {
        return { status: "wallet_unavailable", message: "wallet height lookup failed" };
    }
    const reply = await rpcWalletCall(support, "get_transfers", {
        out: true,
        pending: true,
        pool: true,
        filter_by_height: true,
        min_height: Math.max(0, walletHeight - RECENT_TRANSFER_LOOKBACK_BLOCKS),
        max_height: walletHeight
    });
    if (!isRecord(reply) || !isRecord(reply["result"])) {
        return { status: "wallet_unavailable", message: "wallet get_transfers failed" };
    }
    /** @type {Record<string, unknown>[]} */
    const transfers = [];
    for (const key of ["out", "pending", "pool"]) {
        const entries = reply["result"][key];
        if (entries === undefined) continue;
        if (!Array.isArray(entries) || entries.some((entry) => !isRecord(entry))) {
            return { status: "wallet_unavailable", message: "wallet returned malformed transfer history" };
        }
        transfers.push(...entries.filter(isRecord));
    }
    const match = transfers.find(function matches(transfer) {
        return common.transferMatchesBatch(batch, items, transfer);
    });
    if (!match) return { status: "no_match" };
    const txid = match["txid"];
    return typeof txid === "string"
        ? { status: "match_found", txid }
        : { status: "wallet_unavailable", message: "matching transfer has no transaction ID" };
}

/** @param {number} batchId @param {BatchState} loaded @param {WalletMatchChecker} walletMatchChecker @param {WalletDeps} deps @returns {Promise<void>} */
async function assertWalletHistoryClear(batchId, loaded, walletMatchChecker, deps) {
    const matchResult = await walletMatchChecker(loaded.batch, loaded.items, deps);
    if (matchResult && matchResult.status === "no_match") return;
    if (matchResult && matchResult.status === "match_found") {
        throw new UnlockError(
            `Refusing to unlock payment batch ${  batchId  }: wallet history shows a matching transfer (${ 
                matchResult.txid  }); the batch was already sent.`,
            { code: "wallet_tx_match", txid: matchResult.txid, items: loaded.items, reservedBalances: loaded.reservedBalances }
        );
    }
    throw new UnlockError(
        `Refusing to unlock payment batch ${  batchId  }: could not verify wallet history (${ 
            matchResult.status === "wallet_unavailable" ? matchResult.message : "no result" 
            }). Re-run once the wallet is reachable.`,
        { code: "wallet_unavailable", items: loaded.items, reservedBalances: loaded.reservedBalances }
    );
}

/** @param {UnlockOptions} [options] */
async function unlockBatch(options) {
    const opts = options || {};
    const mysql = opts.mysql || global.mysql;
    const support = opts.support || global.support;
    const config = opts.config || global.config;
    const walletMatchChecker = opts.walletMatchChecker || defaultWalletMatchChecker;
    const batchId = parseBatchId(opts.batchId);
    const force = isBooleanOption(opts.force);
    const confirmWalletHistoryChecked = isBooleanOption(opts.confirmWalletHistoryChecked);
    const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();

    if (!mysql || typeof mysql.getConnection !== "function") {
        throw new Error("MySQL pool does not support connections required for advisory locking");
    }

    return await withPaymentsAdvisoryLock(mysql, async function runUnlock(connection) {
        const loaded = await loadBatchState(connection, batchId);
        const riskFlags = assertUnlockAllowed(batchId, loaded.batch, loaded.items, loaded.reservedBalances, force, confirmWalletHistoryChecked);
        // The only way past the submit boundary is the operator attestation flag.
        // Verify that attestation against the wallet ourselves (fail closed) so a
        // wrong "no matching tx" judgment cannot free a batch that actually sent.
        if (confirmWalletHistoryChecked && isPresent(loaded.batch.submit_started_at)) {
            await assertWalletHistoryClear(batchId, loaded, walletMatchChecker, { support, config });
        }
        const releasedAt = nowSqlTimestamp(support, nowMs);
        const note = `manually released for retry by manage_scripts/payment_batch_unlock.js at ${  releasedAt 
            }${confirmWalletHistoryChecked ? " (wallet history checked and confirmed no tx match)" : ""}`;

        await connection.beginTransaction();
        try {
            const balanceResult = await connection.query(
                "UPDATE balance SET pending_batch_id = NULL WHERE pending_batch_id = ?",
                [batchId]
            );
            // Operator attestation that the wallet shows no matching tx lets us unlock past the submit
            // boundary (status 'submitting', submit_started_at set); otherwise we only unlock pre-submit batches.
            const batchResult = confirmWalletHistoryChecked
                ? await connection.query(
                    "UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, submit_started_at = NULL, last_error_text = ? WHERE id = ? AND status IN ('reserved', 'retrying', 'submitting')",
                    ["retryable", releasedAt, releasedAt, note, batchId]
                )
                : await connection.query(
                    "UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND submit_started_at IS NULL AND status IN (?, ?)",
                    ["retryable", releasedAt, releasedAt, note, batchId, "reserved", "retrying"]
                );
            if (!batchResult || batchResult.affectedRows !== 1) {
                throw new Error(`Payment batch ${  batchId  } changed while unlocking; re-read it before retrying`);
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
            } catch (_rollbackError) { /* swallow so the original error is the one thrown */ }
            throw error;
        }
    }, opts.advisoryLockName);
}

/** @param {unknown} error @param {number} batchId @returns {never} */
function printUnlockError(error, batchId) {
    if (error instanceof UnlockError && (error.code === "force_required" || error.code === "unsafe_batch")) {
        console.error(error.message);
        console.error(error.code === "unsafe_batch" ? "Unsafe flags:" : "Risk flags:");
        error.flags.forEach(function printFlag(flag) {
            console.error(` - ${  flag}`);
        });
        const items = error.items;
        console.error(`Destinations: ${  items.length ? items.map(describeItem).join(", ") : "(none)"}`);
        process.exit(1);
    }
    exitWithError(`Failed to unlock payment batch ${  batchId  }: ${  (error instanceof Error ? error.message : String(error))}`);
}

function runCli() {
    const cli = require("../script_utils.js")();
    const batchIdRaw = cli.arg("batch_id", "Please specify payment batch id to unlock");
    const force = cli.get("force", false);
    const confirmWalletHistoryChecked = cli.get("confirm-wallet-history-checked", false);

    cli.init(function initScript() {
        (async function main() {
            const batchId = parseBatchId(batchIdRaw);
            try {
                const result = await unlockBatch({
                    batchId,
                    force,
                    confirmWalletHistoryChecked,
                    mysql: global.mysql,
                    support: global.support
                });
                console.log(`Unlocked payment batch ${  batchId  } for retry.`);
                console.log(`Previous status: ${  result.batch.status}`);
                console.log(`Cleared pending balance rows: ${  result.clearedPendingRows}`);
                console.log(`Batch destinations: ${  result.items.length ? result.items.map(describeItem).join(", ") : "(none)"}`);
                if (result.riskFlags.length) {
                    console.log(`Forced despite risk flags: ${  result.riskFlags.join("; ")}`);
                }
                process.exit(0);
            } catch (error) {
                printUnlockError(error, batchId);
            }
        })().catch(function onError(error) {
            exitWithError(`Script failed: ${  error instanceof Error ? error.message : String(error)}`);
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
