"use strict";

const AMBIGUOUS_BATCH_STATUSES = new Set(["reserved", "submitting", "submitted"]);
const MIN_SUCCESS_FEE_ATOMIC = 10;
const RETRYABLE_PRE_SUBMIT_ERRORS = new Set([
    "not enough money",
    "not enough unlocked money"
]);
const REJECTED_BY_DAEMON_ERROR = "transaction was rejected by daemon";
const RECONCILE_POLL_INTERVAL_MS = 10 * 60 * 1000;
const SUBMIT_SEARCH_DELAYS_MS = [1, 5, 10, 30, 60].map(function toMs(seconds) { return seconds * 1000; });
const TRANSACTION_COLUMNS = ["address", "payment_id", "xmr_amt", "transaction_hash", "mixin", "fees", "payees"];
const PAYMENT_COLUMNS = ["unlocked_time", "paid_time", "pool_type", "payment_address", "transaction_id", "amount", "payment_id", "transfer_fee"];

module.exports = function createPaymentsProcessor(ctx, state, deps) {
    const { mysqlPool, support, config, now } = ctx;
    const { common, planner, enterFailStop, verifyExclusiveAccess } = deps;
    const {
        assertAffectedRows,
        buildWalletTransferParams,
        callWallet,
        coinCode,
        coinToDecimal,
        describeWalletReply,
        formatError,
        logBatchBlock,
        logError,
        logInfo,
        logWarn,
        makeProofUrl,
        namedValues,
        normalizeHash,
        normalizeInteger,
        nowSqlTimestamp,
        placeholders,
        pickValue,
        sqlTimestampToUnix,
        transferMatchesBatch,
        updateBatchStatus,
        withTransaction
    } = common;

    function currentTime() {
        return nowSqlTimestamp(support, now());
    }

    function hasPlausibleWalletFee(totalFee) {
        return normalizeInteger(totalFee) !== null && normalizeInteger(totalFee) > MIN_SUCCESS_FEE_ATOMIC;
    }

    async function checkExclusiveAccess() {
        if (!state.lockConnection || typeof verifyExclusiveAccess !== "function") return true;
        return await verifyExclusiveAccess();
    }

    function nextReconcileDelayMs(batch) {
        const lastReconciledAt = sqlTimestampToUnix(batch.last_reconciled_at);
        if (!lastReconciledAt) return 0;
        const elapsedMs = Math.max(0, now() - lastReconciledAt * 1000);
        return elapsedMs >= RECONCILE_POLL_INTERVAL_MS ? 0 : RECONCILE_POLL_INTERVAL_MS - elapsedMs;
    }

    function nextReconcileAt(batch) {
        const delayMs = nextReconcileDelayMs(batch);
        return delayMs ? nowSqlTimestamp(support, now() + delayMs) : currentTime();
    }

    async function sleepMs(delayMs) {
        if (support && typeof support.sleep === "function") {
            await support.sleep(delayMs);
            return;
        }
        await new Promise(function wait(resolve) {
            setTimeout(resolve, delayMs);
        });
    }

    async function retryPostSubmitSearch(search, shouldRetry) {
        let result = null;
        for (const delayMs of SUBMIT_SEARCH_DELAYS_MS) {
            await sleepMs(delayMs);
            result = await search();
            if (!shouldRetry(result)) return result;
        }
        return result;
    }

    async function sendPendingBatchFyi(batch, items, message) {
        if (!support || typeof support.sendEmail !== "function" || !config || !config.general || !config.general.adminEmail) return;
        const destinations = items.map(function describeItem(item) {
            return pickValue(item, "paymentAddress", "payment_address");
        }).join(", ");
        const body = [
            "Payment batch " + batch.id + " is waiting for an exact wallet match before payouts can continue.",
            "Status: " + batch.status,
            "Reason: " + message,
            "Next reconcile not before: " + nextReconcileAt(batch),
            batch.submit_started_at ? "Submit started at: " + batch.submit_started_at : null,
            batch.tx_hash ? "Known tx_hash: " + batch.tx_hash : null,
            "Destinations (" + items.length + "): " + destinations,
            ""
        ].filter(Boolean).join("\n") + "\n";
        support.sendEmail(
            config.general.adminEmail,
            "FYI: Payment batch " + batch.id + " awaiting wallet confirmation",
            body
        );
    }

    async function holdBatch(batch, items, message, warningMessage, extraFields) {
        // "Hold" keeps the reservation intact. This is used once a batch may
        // already correspond to a wallet-side transaction, so later planning
        // must stay blocked until reconcile or manual review settles it.
        await updateBatchStatus(batch, Object.assign({
            last_reconciled_at: currentTime(),
            updated_at: currentTime(),
            last_error_text: message
        }, extraFields));
        logWarn("batch#" + batch.id, warningMessage || message);
        await sendPendingBatchFyi(batch, items, message);
        return "unresolved";
    }

    async function holdBatchForRetry(batch, items, message, warningMessage) {
        // "Retrying" is the conservative pre-submit failure path: nothing in
        // wallet history matched yet, but we keep the exact balances pinned so
        // the next cycle retries the same batch instead of replanning around it.
        await updateBatchStatus(batch, {
            status: "retrying",
            submit_started_at: null,
            submitted_at: null,
            updated_at: currentTime(),
            last_reconciled_at: currentTime(),
            last_error_text: message,
            tx_hash: null,
            tx_key: null
        });
        logWarn("batch#" + batch.id, warningMessage || message);
        await sendPendingBatchFyi(batch, items, message);
        return "unresolved";
    }

    async function holdAfterReconcile(batch, items, message, warningMessage, incrementHealthyPass, extraFields) {
        // Reconcile holds also count attempts/clean passes so operators can see
        // whether the wallet is steadily making progress or just staying stuck.
        await recordBatchReconcileState(batch, message, incrementHealthyPass, extraFields);
        logWarn("batch#" + batch.id, warningMessage || message);
        await sendPendingBatchFyi(batch, items, message);
        return "unresolved";
    }

    function matchResultDetails(matchResult) {
        const details = {};
        if (matchResult.txHash) details.txHash = matchResult.txHash;
        if (typeof matchResult.txKey === "string") details.txKey = matchResult.txKey;
        if (normalizeInteger(matchResult.totalFee) !== null) details.totalFee = matchResult.totalFee;
        return details;
    }

    async function markBatchManualReview(batch, items, message, details) {
        const fields = {
            status: "manual_review",
            updated_at: currentTime(),
            last_error_text: message
        };
        if (details && details.txHash) fields.tx_hash = details.txHash;
        if (details && typeof details.txKey === "string") fields.tx_key = details.txKey;
        if (details && normalizeInteger(details.totalFee) !== null) fields.total_fee = details.totalFee;
        await updateBatchStatus(batch, fields);
        logBatchBlock(batch, items, "manual-review");
        // Manual review escalates to runtime fail-stop because continuing to pay
        // while one batch is ambiguous would make later reconciliation unsafe.
        await enterFailStop("batch#" + batch.id, message, batch.id);
    }

    async function resolveTxKey(txHash) {
        const reply = await callWallet("get_tx_key", { txid: txHash }, true);
        if (reply instanceof Error || typeof reply === "string") {
            // Transport/availability failures are retriable. A wallet-level error
            // response is handled separately below as a likely permanent absence.
            return { status: "retry", message: describeWalletReply(reply) };
        }
        if (reply && reply.error) {
            return { status: "missing", message: describeWalletReply(reply) };
        }
        const txKey = reply && reply.result && typeof reply.result.tx_key === "string" ? reply.result.tx_key : "";
        return txKey ? { status: "ok", txKey } : { status: "missing", message: "wallet returned no tx_key for " + txHash };
    }

    async function loadWalletTransfers() {
        const reply = await callWallet("get_transfers", { out: true, pending: true, pool: true }, true);
        if (reply instanceof Error || typeof reply === "string" || !reply || typeof reply !== "object" || !reply.result) {
            return { status: "wallet_unavailable", message: describeWalletReply(reply) };
        }

        const transfers = [];
        // Recovery is willing to look in out/pending/pool because the wallet can
        // surface the same submission at different visibility stages between the
        // RPC success and the final ledger write.
        for (const key of ["out", "pending", "pool"]) {
            if (Array.isArray(reply.result[key])) transfers.push.apply(transfers, reply.result[key]);
        }
        return { status: "ok", transfers };
    }

    async function loadBatchById(batchId) {
        const rows = await mysqlPool.query("SELECT * FROM payment_batches WHERE id = ? LIMIT 1", [batchId]);
        return Array.isArray(rows) && rows.length ? rows[0] : null;
    }

    async function claimBatchForSubmit(batch, expectedStatus) {
        const submitStartedAt = currentTime();
        const result = await mysqlPool.query(
            "UPDATE payment_batches SET status = ?, submit_started_at = ?, updated_at = ?, last_error_text = ? WHERE id = ? AND status = ?",
            ["submitting", submitStartedAt, submitStartedAt, null, batch.id, expectedStatus]
        );
        if (result && result.affectedRows === 1) {
            Object.assign(batch, {
                status: "submitting",
                submit_started_at: submitStartedAt,
                updated_at: submitStartedAt,
                last_error_text: null
            });
            return true;
        }
        const refreshedBatch = await loadBatchById(batch.id);
        if (refreshedBatch) Object.assign(batch, refreshedBatch);
        return false;
    }

    async function handleLostSubmitClaim(batch, items, expectedStatus) {
        const observedStatus = batch && batch.status ? batch.status : "missing";
        logWarn("batch#" + batch.id, "submit claim lost from " + expectedStatus + "; observed status " + observedStatus);
        if (observedStatus === "finalized") return "cleared";
        if (observedStatus === "manual_review") {
            await enterFailStop("batch#" + batch.id, "manual-review batch " + batch.id + " blocks payout after submit-claim loss", batch.id);
            return "manual_review";
        }
        // Another runtime already owns this batch once the status has moved to
        // submitting/submitted. Standing down here avoids racing its reconcile
        // path and potentially rewriting finalized state back to submitted.
        if (observedStatus === "submitting" || observedStatus === "submitted") return "unresolved";
        return "unresolved";
    }

    async function findWalletTransferMatch(batch, items) {
        const loadedTransfers = await loadWalletTransfers();
        if (loadedTransfers.status !== "ok") return loadedTransfers;
        const transfers = loadedTransfers.transfers;
        const matches = transfers.filter(function filterTransfer(transfer) {
            return transferMatchesBatch(batch, items, transfer);
        });
        // Auto-recovery only proceeds on a single exact match. Zero matches means
        // "keep holding", more than one match means "stop and escalate".
        if (matches.length > 1) return { status: "multiple_matches" };
        if (matches.length === 0) return { status: "no_match" };

        const match = matches[0];
        const txHash = normalizeHash(match.txid);
        const totalFee = normalizeInteger(match.fee);
        if (!txHash || !hasPlausibleWalletFee(totalFee)) return { status: "incomplete_match" };

        const txKeyResult = await resolveTxKey(txHash);
        if (txKeyResult.status === "retry") {
            return {
                status: "matched_waiting_tx_key",
                message: txKeyResult.message,
                totalFee,
                txHash
            };
        }
        if (txKeyResult.status === "missing") return { status: "matched_missing_tx_key", totalFee, txHash };

        return {
            status: "matched",
            totalFee,
            txHash,
            txKey: txKeyResult.txKey
        };
    }

    async function findSubmittedTransferVisibility(batch, items) {
        const loadedTransfers = await loadWalletTransfers();
        if (loadedTransfers.status !== "ok") return loadedTransfers;
        const txHash = normalizeHash(batch.tx_hash);
        // Once we already know the tx hash, visibility requires both the same
        // hash and the same destination set. That keeps a reused hash-shaped
        // field or malformed wallet row from finalizing the wrong batch.
        const visible = loadedTransfers.transfers.some(function hasExactSubmittedTransfer(transfer) {
            return normalizeHash(transfer && transfer.txid) === txHash && transferMatchesBatch(batch, items, transfer);
        });
        return visible ? { status: "visible" } : { status: "tx_not_found" };
    }

    async function findWalletTransferMatchAfterSubmit(batch, items) {
        return await retryPostSubmitSearch(
            function searchWalletTransfers() {
                return findWalletTransferMatch(batch, items);
            },
            function shouldRetry(result) {
                return result && (result.status === "wallet_unavailable" || result.status === "no_match");
            }
        );
    }

    async function findSubmittedTransferVisibilityAfterSubmit(batch, items) {
        return await retryPostSubmitSearch(
            function searchSubmittedTransfer() {
                return findSubmittedTransferVisibility(batch, items);
            },
            function shouldRetry(result) {
                return result && (result.status === "wallet_unavailable" || result.status === "tx_not_found");
            }
        );
    }

    async function finalizeMatchedTransfer(batch, items, reason, matchResult, lastErrorText) {
        await persistSubmittedBatch(batch, matchResult.txHash, matchResult.txKey, matchResult.totalFee, lastErrorText);
        logBatchBlock(batch, items, "reconciled");
        return await finalizeBatch(batch, items, reason) ? "cleared" : "unresolved";
    }

    async function reconcileRejectedSubmit(batch, items, errorMessage) {
        // A daemon rejection is treated specially. If the wallet already shows a
        // matching transfer we escalate, because the daemon may have accepted it
        // far enough that an operator needs to inspect the final wallet state.
        // If nothing landed in wallet history, we retry the exact reserved batch.
        const matchResult = await findWalletTransferMatchAfterSubmit(batch, items);
        if (matchResult.status === "wallet_unavailable") {
            return await holdBatch(
                batch,
                items,
                "wallet rejected submit but history check is unavailable: " + matchResult.message,
                "wallet rejected submit; holding until history can be checked"
            );
        }
        if (matchResult.status === "no_match") {
            return await holdBatchForRetry(
                batch,
                items,
                "wallet pre-submit failure with no wallet match: " + errorMessage,
                "wallet rejected submit without a wallet match; holding exact batch for retry"
            );
        }
        const reviewMessages = {
            incomplete_match: "wallet history shows a plausible transfer for batch " + batch.id + " after daemon rejection but transfer data is incomplete",
            matched: "wallet history shows a matching transfer for batch " + batch.id + " after daemon rejection",
            matched_missing_tx_key: "wallet history shows a matching transfer for batch " + batch.id + " after daemon rejection but tx_key is unavailable",
            matched_waiting_tx_key: "wallet history shows a matching transfer for batch " + batch.id + " after daemon rejection but tx_key is not available yet",
            multiple_matches: "batch " + batch.id + " has multiple plausible wallet matches after daemon rejection"
        };
        const reviewMessage = reviewMessages[matchResult.status];
        if (!reviewMessage) throw new Error("Unhandled rejected submit match status: " + matchResult.status);
        await markBatchManualReview(batch, items, reviewMessage, matchResultDetails(matchResult));
        return "manual_review";
    }

    async function sendBatchNotifications(batch, items) {
        for (const item of items) {
            const address = pickValue(item, "paymentAddress", "payment_address");
            const username = address;
            try {
                const rows = await mysqlPool.query(
                    "SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1",
                    [username]
                );
                if (!Array.isArray(rows) || rows.length === 0 || !rows[0].email) continue;
                const emailData = {
                    address: address,
                    address2: username,
                    payment_amount: coinToDecimal(pickValue(item, "netAmount", "net_amount")),
                    amount: coinToDecimal(pickValue(item, "grossAmount", "gross_amount")),
                    fee: coinToDecimal(pickValue(item, "feeAmount", "fee_amount")),
                    tx_hash: batch.tx_hash,
                    tx_key: batch.tx_key
                };
                support.sendEmail(
                    rows[0].email,
                    support.formatTemplate("Your %(payment_amount)s " + coinCode() + " payment was just performed", emailData),
                    support.formatTemplate(
                        "Your payment of %(payment_amount)s " + coinCode() + " (with tx fee %(fee)s " + coinCode() + ") to %(address2)s wallet was just performed and total due was decreased by %(amount)s " + coinCode() + ".\n" +
                        (batch.tx_hash && batch.tx_key
                            ? "Your payment tx_hash (tx_id) is %(tx_hash)s and tx_key is %(tx_key)s.\n" +
                              "Here is link to verify that this payment was made: " + makeProofUrl(batch.tx_hash, address, batch.tx_key) + "\n"
                            : ""
                        ),
                        emailData
                    ),
                    username
                );
            } catch (error) {
                logError("notify", "email lookup failed for " + username + ": " + formatError(error));
            }
        }
    }

    async function finalizeBatch(batch, items, reason) {
        let txKey = batch.tx_key || null;
        if (!txKey) {
            const txKeyResult = await resolveTxKey(batch.tx_hash);
            if (txKeyResult.status === "retry") {
                await holdBatch(
                    batch,
                    items,
                    "waiting for tx_key: " + txKeyResult.message,
                    "finalize wait for tx_key after " + reason + ": " + txKeyResult.message
                );
                return false;
            }
            if (txKeyResult.status === "missing") {
                await markBatchManualReview(
                    batch,
                    items,
                    "wallet send proven for batch " + batch.id + " but tx_key is unavailable",
                    { txHash: batch.tx_hash, totalFee: batch.total_fee }
                );
                return false;
            }
            txKey = txKeyResult.txKey;
            batch.tx_key = txKey;
        }

        try {
            const finalizedAt = currentTime();
            await withTransaction(async function finalizeTransaction(connection) {
                const batchType = pickValue(batch, "batchType", "batch_type");
                // In-flight state lives in payment_batches/payment_batch_items so finalized
                // ledger rows are only written once the exact wallet submission is known.
                const transactionRecord = {
                    address: batchType === "bulk" ? null : pickValue(items[0], "paymentAddress", "payment_address"),
                    payment_id: null,
                    xmr_amt: batch.total_gross,
                    transaction_hash: batch.tx_hash,
                    mixin: config.payout.mixIn,
                    fees: batch.total_fee,
                    payees: items.length
                };
                const transactionResult = await connection.query(
                    "INSERT INTO transactions (" + TRANSACTION_COLUMNS.join(", ") + ") VALUES (" +
                        placeholders(TRANSACTION_COLUMNS.length) + ")",
                    namedValues(TRANSACTION_COLUMNS, transactionRecord)
                );
                assertAffectedRows(transactionResult, 1, "transactions insert failed for batch " + batch.id);

                const paymentRows = items.map(function buildPaymentRow(item) {
                    return namedValues(PAYMENT_COLUMNS, {
                        unlocked_time: finalizedAt,
                        paid_time: finalizedAt,
                        pool_type: item.pool_type,
                        payment_address: item.payment_address,
                        transaction_id: transactionResult.insertId,
                        amount: item.net_amount,
                        payment_id: null,
                        transfer_fee: item.fee_amount
                    });
                });
                const paymentInsert = await connection.query(
                    "INSERT INTO payments (" + PAYMENT_COLUMNS.join(", ") + ") VALUES ?",
                    [paymentRows]
                );
                assertAffectedRows(paymentInsert, paymentRows.length, "payments insert failed for batch " + batch.id);

                const ids = items.map(function getId(item) { return item.balance_id; });
                const params = [];
                const clauses = [];
                for (const item of items) {
                    clauses.push("WHEN ? THEN ?");
                    params.push(item.balance_id, item.gross_amount);
                }
                params.push(batch.id, ...ids);
                // The balance decrement is guarded by pending_batch_id so only the
                // balances reserved for this batch can be consumed during finalization.
                const balanceUpdate = await connection.query(
                    "UPDATE balance SET amount = amount - CASE id " + clauses.join(" ") + " ELSE 0 END, pending_batch_id = NULL " +
                    "WHERE pending_batch_id = ? AND id IN (" + placeholders(ids.length, ",") + ")",
                    params
                );
                assertAffectedRows(balanceUpdate, ids.length, "balance finalize mismatch for batch " + batch.id);

                const batchUpdate = await connection.query(
                    "UPDATE payment_batches SET status = ?, finalized_at = ?, updated_at = ?, transaction_id = ?, tx_hash = ?, tx_key = ?, total_fee = ?, last_error_text = NULL WHERE id = ?",
                    ["finalized", finalizedAt, finalizedAt, transactionResult.insertId, batch.tx_hash, txKey, batch.total_fee, batch.id]
                );
                assertAffectedRows(batchUpdate, 1, "batch finalize update failed for batch " + batch.id);
                batch.transaction_id = transactionResult.insertId;
            });
            Object.assign(batch, { status: "finalized", finalized_at: finalizedAt, tx_key: txKey });
            logBatchBlock(batch, items, "finalized");
            sendBatchNotifications(batch, items).catch(function onNotificationError(error) {
                logError("notify", "batch " + batch.id + " notification failed: " + formatError(error));
            });
            return true;
        } catch (error) {
            await updateBatchStatus(batch, {
                last_reconciled_at: currentTime(),
                updated_at: currentTime(),
                last_error_text: "finalize failed: " + formatError(error)
            });
            logError("batch#" + batch.id, "finalize failed after " + reason + ": " + formatError(error));
            await sendPendingBatchFyi(batch, items, "finalize failed after " + reason + ": " + formatError(error));
            return false;
        }
    }

    async function releaseBatchReservation(batch, reason) {
        const releasedAt = currentTime();
        await withTransaction(async function releaseTransaction(connection) {
            await connection.query(
                "UPDATE balance SET pending_batch_id = NULL WHERE pending_batch_id = ?",
                [batch.id]
            );
            const result = await connection.query(
                "UPDATE payment_batches SET status = ?, released_at = ?, updated_at = ?, last_error_text = ? WHERE id = ?",
                ["retryable", releasedAt, releasedAt, reason, batch.id]
            );
            assertAffectedRows(result, 1, "batch release failed for batch " + batch.id);
        });
        Object.assign(batch, { status: "retryable", released_at: releasedAt });
        logInfo("batch#" + batch.id, "released reservation: " + reason);
    }

    async function persistSubmittedBatch(batch, txHash, txKey, totalFee, lastErrorText) {
        const submittedAt = currentTime();
        // This is the durable boundary between "wallet accepted something" and
        // "SQL ledger has been finalized". Recovery can resume safely from here
        // after a crash without re-submitting the transfer.
        await updateBatchStatus(batch, {
            status: "submitted",
            submitted_at: submittedAt,
            updated_at: submittedAt,
            tx_hash: txHash,
            tx_key: txKey || null,
            total_fee: totalFee,
            last_error_text: lastErrorText || null
        });
    }

    async function recordBatchReconcileState(batch, message, incrementHealthyPass, extraFields) {
        const attempts = (normalizeInteger(batch.reconcile_attempts) || 0) + 1;
        const healthyPasses = incrementHealthyPass ? (normalizeInteger(batch.reconcile_clean_passes) || 0) + 1 : normalizeInteger(batch.reconcile_clean_passes) || 0;
        const fields = {
            reconcile_attempts: attempts,
            reconcile_clean_passes: healthyPasses,
            last_reconciled_at: currentTime(),
            updated_at: currentTime(),
            last_error_text: message
        };
        if (extraFields && typeof extraFields === "object") Object.assign(fields, extraFields);
        await updateBatchStatus(batch, fields);
    }

    async function reconcileAmbiguousSubmit(batch, items, message) {
        await updateBatchStatus(batch, {
            updated_at: currentTime(),
            last_error_text: message
        });
        logBatchBlock(batch, items, "ambiguous-submit");
        // Reconcile immediately in the same process so obvious wallet success can
        // be discovered without waiting for the next timer-driven recovery pass.
        return await reconcileBatch(batch, items, "same-process submit", true) === "cleared" ? "cleared" : "unresolved";
    }

    async function reconcileBatch(batch, items, reason, isPostSubmit) {
        logInfo("batch#" + batch.id, "reconcile start from " + reason + " with status " + batch.status);
        const reconcileDelayMs = nextReconcileDelayMs(batch);
        if (reconcileDelayMs > 0) {
            const throttleMessage = "reconcile throttled until " + nextReconcileAt(batch);
            logInfo("batch#" + batch.id, throttleMessage);
            await sendPendingBatchFyi(batch, items, throttleMessage);
            return "unresolved";
        }
        if (batch.status === "submitted" && batch.tx_hash) {
            if (!hasPlausibleWalletFee(batch.total_fee)) {
                await markBatchManualReview(
                    batch,
                    items,
                    "submitted batch " + batch.id + " has an implausible wallet fee",
                    { txHash: batch.tx_hash, totalFee: normalizeInteger(batch.total_fee) }
                );
                return "manual_review";
            }
            // Once submit has produced a durable tx hash we do not try to find a
            // "best" wallet match anymore. We wait for that exact transfer to be
            // visible, then finalize it.
            const submittedVisibility = isPostSubmit
                ? await findSubmittedTransferVisibilityAfterSubmit(batch, items)
                : await findSubmittedTransferVisibility(batch, items);
            if (submittedVisibility.status === "wallet_unavailable") {
                const message = "wallet reconcile unavailable while waiting for submitted tx " + batch.tx_hash + ": " + submittedVisibility.message;
                return await holdAfterReconcile(batch, items, message, "reconcile blocked while waiting for submitted tx: " + submittedVisibility.message, false);
            }
            if (submittedVisibility.status === "tx_not_found") {
                const message = "submitted tx " + batch.tx_hash + " is not visible in wallet history yet; holding batch";
                return await holdAfterReconcile(batch, items, message, "submitted tx is not visible in wallet history yet", true);
            }
            const finalized = await finalizeBatch(batch, items, reason);
            return finalized ? "cleared" : "unresolved";
        }

        // The MySQL and wallet boundaries are not atomic. Once a batch is ambiguous we
        // never resubmit it; we reconcile it against wallet history or fail-stop.
        const matchResult = isPostSubmit
            ? await findWalletTransferMatchAfterSubmit(batch, items)
            : await findWalletTransferMatch(batch, items);
        if (matchResult.status === "wallet_unavailable") {
            const message = "wallet reconcile unavailable: " + matchResult.message;
            return await holdAfterReconcile(batch, items, message, "reconcile blocked: " + matchResult.message, false);
        }
        if (matchResult.status === "multiple_matches") {
            await markBatchManualReview(batch, items, "batch " + batch.id + " has multiple plausible wallet matches after reconcile", {});
            return "manual_review";
        }
        if (matchResult.status === "no_match") {
            return await holdAfterReconcile(
                batch,
                items,
                "no wallet match found after reconcile; holding reservation",
                "reconcile found no match; holding reservation",
                true
            );
        }
        if (matchResult.status === "incomplete_match") {
            return await holdAfterReconcile(
                batch,
                items,
                "wallet reconcile returned incomplete transfer data",
                "reconcile returned incomplete transfer data",
                false
            );
        }
        if (matchResult.status === "matched_waiting_tx_key") {
            const message = "wallet match found but waiting for tx_key";
            // Persist the tx hash and fee immediately so future recovery knows
            // the batch already corresponds to a concrete wallet transfer.
            await persistSubmittedBatch(batch, matchResult.txHash, null, matchResult.totalFee, message);
            return await holdBatch(
                batch,
                items,
                message,
                "reconcile found wallet match but tx_key is not available yet"
            );
        }
        if (matchResult.status === "matched_missing_tx_key") {
            await markBatchManualReview(
                batch,
                items,
                "wallet match found for batch " + batch.id + " but tx_key is unavailable",
                matchResultDetails(matchResult)
            );
            return "manual_review";
        }
        return await finalizeMatchedTransfer(batch, items, "reconcile", matchResult, "reconciled from wallet history");
    }

    async function recoverPendingBatches(source) {
        // Recovery always runs before new planning so stale reservations or known submits
        // are resolved before another payout cycle can reserve fresh balances.
        const batches = await mysqlPool.query(
            "SELECT * FROM payment_batches WHERE status IN ('manual_review', 'reserved', 'retrying', 'submitting', 'submitted') ORDER BY id ASC"
        );
        if (!batches.length) return true;
        for (const batch of batches) {
            if (!await checkExclusiveAccess()) return false;
            const items = await mysqlPool.query(
                "SELECT * FROM payment_batch_items WHERE batch_id = ? ORDER BY destination_order ASC",
                [batch.id]
            );
            if (batch.status === "manual_review") {
                return await enterFailStop("recovery", "manual-review batch " + batch.id + " blocks new payouts", batch.id);
            }
            if (batch.status === "retrying") {
                // "Retrying" means the batch never got a wallet-side match, so
                // we can safely attempt the same reserved transfer again.
                batch.items = items;
                const retryOutcome = await submitReservedBatch(batch);
                if (retryOutcome !== "cleared") return false;
                continue;
            }
            if (batch.status === "reserved" && !batch.submit_started_at) {
                // A pure reservation with no submit timestamp never crossed the
                // wallet boundary, so it can be released on restart.
                logInfo("batch#" + batch.id, "startup recovery releasing reserved batch before submit");
                await releaseBatchReservation(batch, "released by " + source + " before submit");
                continue;
            }
            if (!AMBIGUOUS_BATCH_STATUSES.has(batch.status)) continue;
            const outcome = await reconcileBatch(batch, items, source);
            if (outcome !== "cleared") return false;
        }
        return true;
    }

    async function submitReservedBatch(batch) {
        const items = batch.items;
        state.activeBatchId = batch.id;
        if (!await checkExclusiveAccess()) return "unresolved";
        const preflight = await planner.preflightWalletBalance(batch);
        if (!preflight.ok) {
            return await holdBatchForRetry(
                batch,
                items,
                preflight.reason,
                "pre-submit blocked; holding exact batch for retry: " + preflight.reason
            );
        }

        if (!await checkExclusiveAccess()) return "unresolved";
        const expectedStatus = batch.status;
        // submit_started_at is committed before transfer so a crash after this point is
        // always recovered through reconcile rather than another submission attempt.
        if (!await claimBatchForSubmit(batch, expectedStatus)) return await handleLostSubmitClaim(batch, items, expectedStatus);
        logBatchBlock(batch, items, "submit", preflight);
        const transferReply = await callWallet("transfer", buildWalletTransferParams(items), true);
        if (transferReply && transferReply.error) {
            const errorMessage = describeWalletReply(transferReply);
            // These errors are treated as "nothing was submitted yet" unless
            // wallet history proves otherwise, so the batch stays pinned for an
            // exact retry instead of being replanned.
            if (RETRYABLE_PRE_SUBMIT_ERRORS.has(errorMessage)) {
                return await holdBatchForRetry(
                    batch,
                    items,
                    "wallet pre-submit failure: " + errorMessage,
                    "wallet pre-submit failure; holding exact batch for retry"
                );
            }
            if (errorMessage === REJECTED_BY_DAEMON_ERROR) return await reconcileRejectedSubmit(batch, items, errorMessage);
            // Anything else is ambiguous: the wallet RPC reported an error, but
            // we cannot assume the transfer did not reach wallet history.
            return await reconcileAmbiguousSubmit(batch, items, "wallet submit returned an ambiguous error: " + errorMessage);
        }
        if (transferReply instanceof Error || typeof transferReply === "string" || !transferReply || !transferReply.result) {
            return await reconcileAmbiguousSubmit(batch, items, "ambiguous wallet submit: " + describeWalletReply(transferReply));
        }

        const txHash = normalizeHash(transferReply.result.tx_hash);
        const totalFee = normalizeInteger(transferReply.result.fee);
        if (!txHash || !hasPlausibleWalletFee(totalFee)) {
            return await reconcileAmbiguousSubmit(batch, items, "wallet returned implausible transfer success payload");
        }

        let txKey = typeof transferReply.result.tx_key === "string" && transferReply.result.tx_key ? transferReply.result.tx_key : null;
        if (!txKey) {
            const txKeyResult = await resolveTxKey(txHash);
            if (txKeyResult.status === "ok") txKey = txKeyResult.txKey;
            else if (txKeyResult.status === "missing") {
                await persistSubmittedBatch(batch, txHash, null, totalFee, "wallet transfer succeeded but tx_key missing");
                await markBatchManualReview(
                    batch,
                    items,
                    "wallet transfer for batch " + batch.id + " succeeded but tx_key is unavailable",
                    { txHash, totalFee }
                );
                return "manual_review";
            }
        }

        await persistSubmittedBatch(batch, txHash, txKey, totalFee, null);
        const submittedVisibility = await findSubmittedTransferVisibilityAfterSubmit(batch, items);
        if (submittedVisibility.status === "wallet_unavailable") {
            return await holdBatch(
                batch,
                items,
                "wallet transfer succeeded but tx search is unavailable: " + submittedVisibility.message,
                "wallet transfer succeeded; waiting for submitted tx to become visible in wallet history"
            );
        }
        if (submittedVisibility.status === "tx_not_found") {
            // Successful transfer RPC does not always mean the tx is immediately
            // visible in wallet history, so finalization waits for that signal.
            return await holdBatch(
                batch,
                items,
                "wallet transfer succeeded but tx " + txHash + " is not visible in wallet history yet",
                "wallet transfer succeeded; waiting for submitted tx to become visible in wallet history"
            );
        }
        return await finalizeBatch(batch, items, "submit") ? "cleared" : "unresolved";
    }

    return {
        recoverPendingBatches,
        submitReservedBatch
    };
};
