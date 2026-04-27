"use strict";
const RESERVED_BATCH_COLUMNS = ["status", "batch_type", "total_gross", "total_net", "total_fee", "destination_count", "created_at", "updated_at"];
const RESERVED_BATCH_ITEM_COLUMNS = ["batch_id", "balance_id", "destination_order", "pool_type", "payment_address", "gross_amount", "net_amount", "fee_amount", "created_at"];

module.exports = function createPaymentsPlanner(ctx, common) {
    const { mysqlPool, support, config, now } = ctx;
    const {
        amountText,
        assertAffectedRows,
        balanceSnapshotText,
        callWallet,
        coinCode,
        denomAtomic,
        describeWalletReply,
        isIntegratedAddress,
        logInfo,
        namedValues,
        normalizeInteger,
        normalizePaymentId,
        nowSqlTimestamp,
        placeholders,
        payoutAtomic,
        pickValue,
        sumBy,
        safeWalletFeeAtomic,
        withTransaction
    } = common;

    function currentTime() {
        return nowSqlTimestamp(support, now());
    }

    function calculateChargeFee(grossAmount) {
        let fee = 0;
        const baseFee = payoutAtomic("feeSlewAmount");
        const walletMin = payoutAtomic("walletMin");
        const feeSlewEnd = payoutAtomic("feeSlewEnd");
        // Preserve the historical fee-slew behavior: small payouts carry the
        // full configured fee, then the charged fee tapers down linearly until
        // feeSlewEnd, after which the pool absorbs the transfer fee entirely.
        if (grossAmount <= walletMin) {
            fee = baseFee;
        } else if (grossAmount <= feeSlewEnd && feeSlewEnd > walletMin) {
            const feeValue = baseFee / (feeSlewEnd - walletMin);
            fee = baseFee - ((grossAmount - walletMin) * feeValue);
        }
        fee = Math.floor(fee);
        return fee < 0 ? 0 : fee;
    }

    async function reserveBatch(batchPlan) {
        return await withTransaction(async function reserveTransaction(connection) {
            const createdAt = currentTime();
            const batchRecord = {
                status: "reserved",
                batch_type: batchPlan.batchType,
                total_gross: batchPlan.totalGross,
                total_net: batchPlan.totalNet,
                total_fee: batchPlan.totalFee,
                destination_count: batchPlan.items.length,
                created_at: createdAt,
                updated_at: createdAt
            };
            const batchResult = await connection.query(
                "INSERT INTO payment_batches (" + RESERVED_BATCH_COLUMNS.join(", ") + ", reconcile_attempts, reconcile_clean_passes, last_error_text) VALUES (" +
                    placeholders(RESERVED_BATCH_COLUMNS.length) + ", 0, 0, NULL)",
                namedValues(RESERVED_BATCH_COLUMNS, batchRecord)
            );
            assertAffectedRows(batchResult, 1, "batch reservation insert failed");

            const batchId = batchResult.insertId;
            const itemRecords = batchPlan.items.map(function buildItemRecord(item, index) {
                return {
                    batch_id: batchId,
                    balance_id: item.balanceId,
                    destination_order: index,
                    pool_type: item.poolType,
                    payment_address: item.paymentAddress,
                    gross_amount: item.grossAmount,
                    net_amount: item.netAmount,
                    fee_amount: item.feeAmount,
                    created_at: createdAt
                };
            });
            const itemRows = itemRecords.map(function buildItemRow(item) {
                return namedValues(RESERVED_BATCH_ITEM_COLUMNS, item);
            });
            const itemResult = await connection.query(
                "INSERT INTO payment_batch_items (" + RESERVED_BATCH_ITEM_COLUMNS.join(", ") + ") VALUES ?",
                [itemRows]
            );
            assertAffectedRows(itemResult, itemRows.length, "batch item reservation failed");

            // pending_batch_id is the durable reservation pointer that keeps these exact
            // balances out of future planning without holding a SQL transaction open
            // across wallet RPC.
            const ids = batchPlan.items.map(function getId(item) { return item.balanceId; });
            const updateResult = await connection.query(
                "UPDATE balance SET pending_batch_id = ? WHERE pending_batch_id IS NULL AND id IN (" + placeholders(ids.length, ",") + ")",
                [batchId].concat(ids)
            );
            assertAffectedRows(updateResult, ids.length, "balance reservation mismatch for batch " + batchId);

            return {
                id: batchId,
                status: "reserved",
                batchType: batchPlan.batchType,
                batch_type: batchPlan.batchType,
                totalGross: batchPlan.totalGross,
                totalNet: batchPlan.totalNet,
                totalFee: batchPlan.totalFee,
                total_gross: batchPlan.totalGross,
                total_net: batchPlan.totalNet,
                total_fee: batchPlan.totalFee,
                items: itemRecords
            };
        });
    }

    async function preflightWalletBalance(batch) {
        const reply = await callWallet("getbalance", {}, true);
        if (reply instanceof Error || typeof reply === "string" || !reply || typeof reply !== "object" || !reply.result) {
            return { ok: false, reason: "wallet getbalance failed: " + describeWalletReply(reply) };
        }
        const balance = normalizeInteger(reply.result.balance);
        const unlocked = normalizeInteger(reply.result.unlocked_balance);
        const totalNet = pickValue(batch, "totalNet", "total_net");
        const walletFeeBuffer = safeWalletFeeAtomic();
        const requiredTotal = totalNet + walletFeeBuffer;
        // Preflight is a soft gate before we move into "submitting". It avoids
        // known-insufficient submits, but the durable protection is still the
        // batch status machine because wallet state can change immediately after.
        if (unlocked === null || unlocked < requiredTotal) {
            return {
                ok: false,
                reason: "wallet preflight insufficient balance" + balanceSnapshotText(balance, unlocked, totalNet, requiredTotal)
            };
        }
        return {
            ok: true,
            requiredNet: totalNet,
            requiredTotal,
            walletBalance: balance,
            walletUnlocked: unlocked
        };
    }

    function buildPayoutItem(row) {
        const threshold = normalizeInteger(row.payout_threshold) || payoutAtomic("defaultPay");
        const customThreshold = normalizeInteger(row.payout_threshold) > 0;
        const integratedAddressThreshold = payoutAtomic("exchangeMin");
        let grossAmount = normalizeInteger(row.amount) || 0;
        if (row.pool_type === "fees" && row.payment_address === config.payout.feeAddress) {
            const feesForTxn = payoutAtomic("feesForTXN");
            grossAmount = grossAmount >= feesForTxn + integratedAddressThreshold ? grossAmount - feesForTxn : 0;
        }
        const remainder = denomAtomic() ? grossAmount % denomAtomic() : 0;
        if (remainder) grossAmount -= remainder;
        if (grossAmount <= 0) return null;
        const feeAmount = calculateChargeFee(grossAmount);
        const netAmount = grossAmount - feeAmount;
        if (netAmount <= 0) return null;
        return {
            item: { balanceId: row.id, poolType: row.pool_type, paymentAddress: row.payment_address, grossAmount, netAmount, feeAmount },
            threshold,
            customThreshold,
            integratedAddressThreshold
        };
    }

    function shouldSkipPayoutRow(row, seenRecipients) {
        if (row.payment_id !== null && typeof row.payment_id !== "undefined") return true;
        if (normalizePaymentId(row.payment_id) !== null) return true;
        if (seenRecipients.has(row.payment_address)) return true;
        seenRecipients.add(row.payment_address);
        return false;
    }

    function integratedBatchFor(item, threshold, customThreshold, integratedAddressThreshold) {
        const grossAmount = item.grossAmount;
        if (grossAmount < threshold) return null;
        if (grossAmount < integratedAddressThreshold && (!customThreshold || grossAmount <= threshold)) return null;
        return { batchType: "integrated", items: [item], totalGross: grossAmount, totalNet: item.netAmount, totalFee: item.feeAmount };
    }

    async function planBatches() {
        const rows = await mysqlPool.query(
            "SELECT balance.id, balance.payment_address, balance.payment_id, balance.pool_type, balance.amount, users.payout_threshold " +
            "FROM balance " +
            "LEFT JOIN users ON users.username = balance.payment_address " +
            "WHERE balance.amount >= ? AND balance.pending_batch_id IS NULL " +
            "ORDER BY balance.id ASC",
            [payoutAtomic("walletMin")]
        );
        const seenRecipients = new Set();
        const bulkItems = [];
        const integratedBatches = [];
        for (const row of rows) {
            if (shouldSkipPayoutRow(row, seenRecipients)) continue;
            const payout = buildPayoutItem(row);
            if (!payout) continue;
            const { item, threshold, customThreshold, integratedAddressThreshold } = payout;
            const grossAmount = item.grossAmount;
            if (isIntegratedAddress(row.payment_address)) {
                const batch = integratedBatchFor(item, threshold, customThreshold, integratedAddressThreshold);
                if (batch) integratedBatches.push(batch);
                continue;
            }
            if (grossAmount >= threshold) {
                bulkItems.push(item);
            }
        }

        const batches = [];
        for (let index = 0; index < bulkItems.length; index += config.payout.maxPaymentTxns) {
            const items = bulkItems.slice(index, index + config.payout.maxPaymentTxns);
            // Normal addresses are grouped into bulk transactions up to the
            // configured wallet limit; integrated addresses were split out above.
            batches.push({
                batchType: "bulk",
                items,
                totalGross: sumBy(items, "grossAmount"),
                totalNet: sumBy(items, "netAmount"),
                totalFee: sumBy(items, "feeAmount")
            });
        }
        batches.push.apply(batches, integratedBatches);

        const candidateCount = batches.reduce(function sum(total, batch) { return total + batch.items.length; }, 0);
        const totalGross = sumBy(batches, "totalGross");
        const totalNet = sumBy(batches, "totalNet");
        const totalFee = sumBy(batches, "totalFee");
        if (!batches.length) {
            logInfo("cycle", "plan candidates=0 batches=0 gross=0 " + coinCode() + " net=0 " + coinCode() + " fee=0 " + coinCode());
            return batches;
        }

        const typeCounts = Object.create(null);
        for (const batch of batches) {
            typeCounts[batch.batchType] = (typeCounts[batch.batchType] || 0) + 1;
        }
        logInfo(
            "cycle",
            "plan candidates=" + candidateCount +
            " batches=" + batches.length +
            " gross=" + amountText(totalGross) +
            " net=" + amountText(totalNet) +
            " fee=" + amountText(totalFee) +
            " types=" + Object.keys(typeCounts).sort().map(function formatCount(key) {
                return key + ":" + typeCounts[key];
            }).join(",")
        );
        return batches;
    }

    return {
        planBatches,
        preflightWalletBalance,
        reserveBatch
    };
};
