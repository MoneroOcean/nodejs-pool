"use strict";

const DEFAULT_SAFE_WALLET_FEE_XMR = 0.001;
const ZERO_PAYMENT_ID = "0000000000000000";

module.exports = function createPaymentsCommon(ctx) {
    const { mysqlPool, support, config } = ctx;

    function formatError(error) {
        if (error instanceof Error) return error.stack || error.message || String(error);
        if (typeof error === "string") return error;
        try {
            return JSON.stringify(error);
        } catch (_error) {
            return String(error);
        }
    }

    function normalizePaymentId(paymentId) {
        if (paymentId === null || typeof paymentId === "undefined") return null;
        const normalized = String(paymentId).trim();
        // The legacy payout tables use NULL and all-zero placeholders
        // interchangeably to mean "no standalone payment id".
        if (!normalized || normalized === ZERO_PAYMENT_ID) return null;
        return normalized;
    }

    function normalizeHash(value) {
        if (typeof value !== "string") return null;
        const match = value.match(/[0-9a-f]+/i);
        return match ? match[0].toLowerCase() : null;
    }

    function normalizeInteger(value) {
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "string" && value.length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    function nowSqlTimestamp(supportRef, timestampMs) {
        if (supportRef && typeof supportRef.formatDate === "function") return supportRef.formatDate(timestampMs);
        const date = new Date(timestampMs);
        const pad = function pad(value) { return String(value).padStart(2, "0"); };
        return date.getUTCFullYear() + "-" +
            pad(date.getUTCMonth() + 1) + "-" +
            pad(date.getUTCDate()) + " " +
            pad(date.getUTCHours()) + ":" +
            pad(date.getUTCMinutes()) + ":" +
            pad(date.getUTCSeconds());
    }

    function sqlTimestampToUnix(value) {
        if (!value) return 0;
        if (typeof value === "number") return Math.floor(value);
        const sqlTimestamp = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
        const time = sqlTimestamp
            ? Date.UTC(
                Number(sqlTimestamp[1]),
                Number(sqlTimestamp[2]) - 1,
                Number(sqlTimestamp[3]),
                Number(sqlTimestamp[4]),
                Number(sqlTimestamp[5]),
                Number(sqlTimestamp[6])
            )
            : Date.parse(value);
        return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
    }

    function makeProofUrl(txHash, address, txKey) {
        if (!txHash || !address || !txKey) return "";
        return "https://xmrchain.net/prove/" + txHash + "/" + address + "/" + txKey;
    }

    function isIntegratedAddress(address) {
        return typeof address === "string" && address.length === 106;
    }

    function pickValue(source, camelKey, snakeKey) {
        return typeof source[camelKey] !== "undefined" ? source[camelKey] : source[snakeKey];
    }

    function namedValues(columns, record) {
        return columns.map(function getValue(column) {
            return record[column];
        });
    }

    function placeholders(count, separator) {
        return Array(count).fill("?").join(typeof separator === "string" ? separator : ", ");
    }

    function sumBy(items, key) {
        return items.reduce(function sum(total, item) {
            return total + (item[key] || 0);
        }, 0);
    }

    function batchTypeLabel(batchType) {
        if (batchType === "integrated") return "single-integrated";
        return "bulk";
    }

    function log(method, scope, message) {
        console[method]("Payments " + scope + ": " + message);
    }

    function logInfo(scope, message) {
        log("log", scope, message);
    }

    function logWarn(scope, message) {
        log("warn", scope, message);
    }

    function logError(scope, message) {
        log("error", scope, message);
    }

    function coinToDecimal(amount) {
        if (support && typeof support.coinToDecimal === "function") return support.coinToDecimal(amount);
        if (config && config.coin && config.coin.sigDigits) return amount / config.coin.sigDigits;
        return amount;
    }

    function coinCode() {
        return config && config.general && config.general.coinCode ? config.general.coinCode : "XMR";
    }

    function payoutAtomic(key) {
        if (!support || typeof support.decimalToCoin !== "function") return 0;
        return support.decimalToCoin(config.payout[key]);
    }

    function denomAtomic() {
        return Math.round(config.payout.denom * config.general.sigDivisor);
    }

    function amountText(amount) {
        return coinToDecimal(amount) + " " + coinCode();
    }

    function safeWalletFeeAtomic() {
        const configured = config && config.payout && typeof config.payout.safeWalletFee !== "undefined"
            ? Number(config.payout.safeWalletFee)
            : DEFAULT_SAFE_WALLET_FEE_XMR;
        const feeXmr = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SAFE_WALLET_FEE_XMR;
        if (support && typeof support.decimalToCoin === "function") return support.decimalToCoin(feeXmr);
        if (config && config.general && Number.isFinite(Number(config.general.sigDivisor))) return Math.round(feeXmr * config.general.sigDivisor);
        if (config && config.coin && Number.isFinite(Number(config.coin.sigDigits))) return Math.round(feeXmr * config.coin.sigDigits);
        return 0;
    }

    function balanceSnapshotText(balance, unlocked, requiredNet, requiredTotal) {
        const fields = [];
        if (normalizeInteger(balance) !== null) fields.push("wallet_balance=" + amountText(balance));
        if (normalizeInteger(unlocked) !== null) fields.push("wallet_unlocked=" + amountText(unlocked));
        if (normalizeInteger(requiredNet) !== null) fields.push("required_net=" + amountText(requiredNet));
        if (normalizeInteger(requiredTotal) !== null && normalizeInteger(requiredTotal) !== normalizeInteger(requiredNet)) {
            fields.push("required_total=" + amountText(requiredTotal));
        }
        return fields.length ? " " + fields.join(" ") : "";
    }

    function describeWalletReply(reply) {
        if (reply && typeof reply === "object" && reply.error && reply.error.message) return String(reply.error.message);
        return formatError(reply);
    }

    function buildWalletTransferParams(items) {
        // The refactor only submits address-only payouts here. Explicit payment-id
        // payouts are filtered earlier, and integrated addresses already encode
        // their short payment id inside the address itself.
        return {
            destinations: items.map(function buildDestination(item) {
                return {
                    amount: pickValue(item, "netAmount", "net_amount"),
                    address: pickValue(item, "paymentAddress", "payment_address")
                };
            }),
            priority: config.payout.priority,
            mixin: config.payout.mixIn,
            get_tx_key: true
        };
    }

    function transferMatchesBatch(batch, items, transfer) {
        if (!transfer || typeof transfer !== "object") return false;
        const timestamp = normalizeInteger(transfer.timestamp);
        // submit_started_at is the lower bound for recovery matching. Anything
        // older belongs to a previous payment cycle and must never satisfy this
        // batch just because the destinations happen to look similar.
        if (timestamp === null || timestamp < sqlTimestampToUnix(batch.submit_started_at)) return false;

        const batchType = pickValue(batch, "batchType", "batch_type");
        const isSingleIntegratedBatch = batchType !== "bulk" &&
            items.length === 1 &&
            isIntegratedAddress(pickValue(items[0], "paymentAddress", "payment_address"));
        // The refactored path only auto-reconciles address-only payouts, but
        // integrated addresses are reported back from wallet history with their
        // embedded short payment_id broken out into transfer.payment_id.
        if (normalizePaymentId(transfer.payment_id) !== null && !isSingleIntegratedBatch) return false;

        const destinations = Array.isArray(transfer.destinations) && transfer.destinations.length
            ? transfer.destinations.map(function normalizeDestination(destination) {
                return {
                    address: destination.address,
                    amount: normalizeInteger(destination.amount)
                };
            }).filter(function isValid(destination) {
                return destination.address && destination.amount !== null;
            })
            // Single-destination wallet entries sometimes expose only top-level
            // address/amount fields, so recovery accepts that reduced shape for
            // one-payee batches.
            : transfer.address && normalizeInteger(transfer.amount) !== null
                ? [{ address: transfer.address, amount: normalizeInteger(transfer.amount) }]
                : [];
        if (destinations.length !== items.length) return false;
        if (batchType !== "bulk" && destinations.length !== 1) return false;

        // Match as a multiset of destination+amount pairs so duplicate recipients
        // remain safe: each expected output must be consumed exactly once.
        const expected = new Map();
        for (const item of items) {
            const key = pickValue(item, "paymentAddress", "payment_address") + "|" + pickValue(item, "netAmount", "net_amount");
            expected.set(key, (expected.get(key) || 0) + 1);
        }
        for (const destination of destinations) {
            const key = destination.address + "|" + destination.amount;
            const count = expected.get(key);
            if (!count) return false;
            if (count === 1) expected.delete(key);
            else expected.set(key, count - 1);
        }
        return expected.size === 0;
    }

    // This block is emitted before wallet transfer so operators can recover a payout
    // manually even if the host dies immediately after submission or during submission.
    function logBatchBlock(batch, items, phase, context) {
        const batchType = batchTypeLabel(pickValue(batch, "batchType", "batch_type"));
        const totalGross = pickValue(batch, "totalGross", "total_gross");
        const totalNet = pickValue(batch, "totalNet", "total_net");
        const totalFee = pickValue(batch, "totalFee", "total_fee");
        const txHash = batch.tx_hash ? " tx_hash=" + batch.tx_hash : "";
        const txKey = batch.tx_key ? " tx_key=" + batch.tx_key : "";
        const chargedFee = items.reduce(function sumFees(total, item) {
            return total + (pickValue(item, "feeAmount", "fee_amount") || 0);
        }, 0);
        const balanceSnapshot = phase === "submit" && context
            ? balanceSnapshotText(context.walletBalance, context.walletUnlocked, context.requiredNet || totalNet, context.requiredTotal)
            : "";
        logInfo(
            "batch#" + batch.id,
            phase + " status=" + batch.status +
            " type=" + batchType +
            " destinations=" + items.length +
            " gross=" + amountText(totalGross) +
            " net=" + amountText(totalNet) +
            " fee=" + amountText(totalFee) +
            balanceSnapshot +
            txHash +
            txKey
        );
        for (const item of items) {
            const address = pickValue(item, "paymentAddress", "payment_address");
            const proofUrl = makeProofUrl(batch.tx_hash, address, batch.tx_key);
            logInfo(
                "batch#" + batch.id,
                "item order=" + pickValue(item, "destinationOrder", "destination_order") +
                " address=" + address +
                " pool_type=" + pickValue(item, "poolType", "pool_type") +
                " gross=" + amountText(pickValue(item, "grossAmount", "gross_amount")) +
                " net=" + amountText(pickValue(item, "netAmount", "net_amount")) +
                " fee=" + amountText(pickValue(item, "feeAmount", "fee_amount")) +
                " mode=" + batchType +
                (proofUrl ? " proof=" + proofUrl : "")
            );
        }
        if (phase === "submit" || phase === "ambiguous-submit") {
            logInfo("batch#" + batch.id, "fee-plan charged=" + amountText(chargedFee));
            return;
        }
        if ((phase === "reconciled" || phase === "finalized" || phase === "manual-review") && normalizeInteger(batch.total_fee) !== null) {
            logInfo(
                "batch#" + batch.id,
                "fee-summary charged=" + amountText(chargedFee) +
                " wallet=" + amountText(batch.total_fee) +
                " retained=" + amountText(chargedFee - batch.total_fee)
            );
        }
    }

    async function callWallet(method, params, suppressErrorLog, options) {
        const rpcOptions = options && typeof options === "object"
            ? Object.assign({ suppressErrorLog: !!suppressErrorLog }, options)
            : suppressErrorLog;
        return await new Promise(function resolveWalletCall(resolve) {
            support.rpcWallet(method, params, resolve, rpcOptions);
        });
    }

    async function withTransaction(work) {
        if (typeof mysqlPool.getConnection !== "function") {
            throw new Error("MySQL pool does not support payments transactions");
        }
        const connection = await mysqlPool.getConnection();
        let inTransaction = false;
        try {
            // Payment state changes must commit or roll back together because the
            // wallet RPC boundary is handled outside SQL transactions.
            await connection.beginTransaction();
            inTransaction = true;
            const result = await work(connection);
            await connection.commit();
            inTransaction = false;
            return result;
        } catch (error) {
            if (inTransaction) {
                try {
                    await connection.rollback();
                } catch (_rollbackError) {}
            }
            throw error;
        } finally {
            try {
                if (typeof connection.release === "function") connection.release();
            } catch (_releaseError) {}
        }
    }

    async function querySingleValue(executor, sql, params, key) {
        const rows = await executor.query(sql, params);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row || typeof row !== "object") return null;
        if (key && Object.prototype.hasOwnProperty.call(row, key)) return normalizeInteger(row[key]);
        return normalizeInteger(row[Object.keys(row)[0]]);
    }

    function assertAffectedRows(result, expected, message) {
        if (!result || result.affectedRows !== expected) throw new Error(message);
    }

    async function updateBatchStatus(batchOrId, fields) {
        const batch = batchOrId && typeof batchOrId === "object" ? batchOrId : null;
        const columns = [];
        const params = [];
        for (const entry of Object.entries(fields)) {
            columns.push(entry[0] + " = ?");
            params.push(entry[1]);
        }
        params.push(batch ? batch.id : batchOrId);
        await mysqlPool.query("UPDATE payment_batches SET " + columns.join(", ") + " WHERE id = ?", params);
        // Most processor code carries an in-memory batch object forward through
        // several decisions. Mutating it here keeps later branches consistent
        // with the database row we just persisted.
        if (batch) Object.assign(batch, fields);
    }

    async function updateBatchStatusIfCurrent(batchOrId, fields, options) {
        const batch = batchOrId && typeof batchOrId === "object" ? batchOrId : null;
        const opts = options || {};
        const executor = opts.executor || mysqlPool;
        const expectedStatuses = Array.isArray(opts.expectedStatuses) ? opts.expectedStatuses.filter(Boolean) : [];
        const requireNullFields = Array.isArray(opts.requireNullFields) ? opts.requireNullFields : [];
        const columns = [];
        const params = [];
        for (const entry of Object.entries(fields)) {
            columns.push(entry[0] + " = ?");
            params.push(entry[1]);
        }
        params.push(batch ? batch.id : batchOrId);
        let sql = "UPDATE payment_batches SET " + columns.join(", ") + " WHERE id = ?";
        if (expectedStatuses.length === 1) {
            sql += " AND status = ?";
            params.push(expectedStatuses[0]);
        } else if (expectedStatuses.length > 1) {
            sql += " AND status IN (" + placeholders(expectedStatuses.length, ",") + ")";
            params.push.apply(params, expectedStatuses);
        }
        for (const field of requireNullFields) sql += " AND " + field + " IS NULL";

        // This helper is the shared compare-and-swap write path for critical
        // payment_batches transitions. It only updates the row when the caller's
        // view of the batch still matches the database row, for example the
        // expected status is unchanged and selected settlement fields are still
        // NULL.
        //
        // The payments runtime already uses a global MySQL advisory lock as the
        // first coordination fence, but that lock lives on a single connection
        // and disappears if that connection dies. These guarded writes are the
        // second fence: if split-brain overlap happens after lock loss, a stale
        // runtime must fail harmlessly instead of reopening, regressing, or
        // overwriting a batch another runtime has already finalized or escalated.
        const result = await executor.query(sql, params);
        const updated = !!result && result.affectedRows === 1;
        if (updated) {
            if (batch) Object.assign(batch, fields);
            return true;
        }
        if (batch) {
            const rows = await executor.query("SELECT * FROM payment_batches WHERE id = ? LIMIT 1", [batch.id]);
            if (Array.isArray(rows) && rows.length) Object.assign(batch, rows[0]);
        }
        return false;
    }

    return Object.freeze({
        amountText,
        assertAffectedRows,
        balanceSnapshotText,
        batchTypeLabel,
        buildWalletTransferParams,
        callWallet,
        coinCode,
        coinToDecimal,
        denomAtomic,
        describeWalletReply,
        formatError,
        isIntegratedAddress,
        logBatchBlock,
        logError,
        logInfo,
        logWarn,
        makeProofUrl,
        namedValues,
        normalizeHash,
        normalizeInteger,
        normalizePaymentId,
        nowSqlTimestamp,
        pickValue,
        placeholders,
        payoutAtomic,
        querySingleValue,
        safeWalletFeeAtomic,
        sqlTimestampToUnix,
        sumBy,
        transferMatchesBatch,
        updateBatchStatus,
        updateBatchStatusIfCurrent,
        withTransaction
    });
};
