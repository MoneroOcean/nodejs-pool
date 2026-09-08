"use strict";
const createTransactionRunner = require("../common/mysql_transaction.js");
const DEFAULT_SAFE_WALLET_FEE_XMR = 0.001;
const ZERO_PAYMENT_ID = "0000000000000000";

/** @typedef {import("../../types/runtime").PoolConfig} PoolConfig */
/** @typedef {import("../../types/runtime").SupportRuntime} SupportRuntime */
/** @typedef {import("../../types/runtime").SqlPool} SqlPool */
/** @typedef {import("../../types/runtime").SqlConnection} SqlConnection */
/** @typedef {import("../../types/runtime").SqlParam} SqlParam */
/** @typedef {import("../../types/runtime").RpcResponse} RpcResponse */
/** @typedef {import("../../types/runtime").RpcOptions} RpcOptions */
/** @typedef {Record<string, unknown>} UnknownRecord */
/** @typedef {{[key: string]: unknown, balanceId?: number|string, balance_id?: number|string, poolType?: string, pool_type?: string, paymentAddress?: string, payment_address?: string, paymentId?: string|null, payment_id?: string|null, grossAmount?: number|string, gross_amount?: number|string, netAmount?: number|string, net_amount?: number|string, feeAmount?: number|string, fee_amount?: number|string, destinationOrder?: number|string, destination_order?: number|string}} PaymentItem */
/** @typedef {{[key: string]: unknown, id: number|string, status: string, batchType?: string, batch_type?: string, totalGross?: number|string|null, total_gross?: number|string|null, totalNet?: number|string|null, total_net?: number|string|null, totalFee?: number|string|null, total_fee?: number|string|null, submit_started_at?: number|string|Date|null, submitted_at?: number|string|Date|null, finalized_at?: number|string|Date|null, last_reconciled_at?: number|string|Date|null, tx_hash?: string|null, tx_key?: string|null, transaction_id?: number|string|null, reconcile_attempts?: number|string|null, reconcile_clean_passes?: number|string|null, items?: PaymentItem[]}} PaymentBatch */
/** @typedef {{[key: string]: unknown, address?: string, amount?: number|string|null}} WalletDestination */
/** @typedef {{[key: string]: unknown, timestamp?: number|string|null, payment_id?: string|null, txid?: string|null, fee?: number|string|null, type?: string, destinations?: WalletDestination[], address?: string, amount?: number|string|null, double_spend_seen?: boolean}} WalletTransfer */
/** @typedef {{mysqlPool: SqlPool, support: SupportRuntime, config: PoolConfig, now: () => number}} PaymentsContext */
/** @typedef {{executor?: SqlPool|SqlConnection, expectedStatuses?: string[], requireNullFields?: string[]}} StatusUpdateOptions */

/** @param {unknown} value @returns {value is UnknownRecord} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is SqlParam} */
function isSqlParam(value) {
    if (value === null || typeof value === "undefined" || typeof value === "string" ||
        typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ||
        value instanceof Date || Buffer.isBuffer(value)) return true;
    return Array.isArray(value) && value.every(isSqlParam);
}

/** @param {unknown} value @returns {number|string} */
function numericOrZero(value) {
    return typeof value === "number" || typeof value === "string" ? value : 0;
}

/** @param {PaymentBatch|number|string} value @returns {number|string} */
function getBatchId(value) {
    if (typeof value === "number" || typeof value === "string") return value;
    return value.id;
}

/**
 * @param {PaymentsContext} ctx
 */
module.exports = function createPaymentsCommon(ctx) {
    const { mysqlPool, support, config } = ctx;
    // Payment state changes commit or roll back together because wallet RPCs
    // are deliberately handled outside SQL transactions.
    const withTransaction = createTransactionRunner(
        mysqlPool,
        "MySQL pool does not support payments transactions"
    );

    /** @param {unknown} error @returns {string} */
    function formatError(error) {
        if (error instanceof Error) return String(error);
        if (typeof error === "string") return error;
        try {
            return JSON.stringify(error);
        } catch (_error) {
            return String(error);
        }
    }

    /** @param {unknown} paymentId @returns {string|null} */
    function normalizePaymentId(paymentId) {
        if (paymentId === null || typeof paymentId === "undefined") return null;
        const normalized = String(paymentId).trim();
        // The legacy payout tables use NULL and all-zero placeholders
        // interchangeably to mean "no standalone payment id".
        if (!normalized || normalized === ZERO_PAYMENT_ID) return null;
        return normalized;
    }

    /** @param {unknown} value @returns {string|null} */
    function normalizeHash(value) {
        if (typeof value !== "string") return null;
        // A Monero tx hash is exactly 32 bytes / 64 hex chars. Require the whole
        // string to match rather than extracting the first hex run, so a malformed
        // or partial value can never normalize to a prefix that collides with a
        // different transaction's hash during reconcile matching.
        const trimmed = value.trim();
        return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
    }

    /** @param {unknown} value @returns {number|null} */
    function normalizeInteger(value) {
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "string" && value.length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    /** @param {SupportRuntime|null|undefined} supportRef @param {number} timestampMs @returns {string} */
    function nowSqlTimestamp(supportRef, timestampMs) {
        if (supportRef && typeof supportRef.formatDate === "function") return supportRef.formatDate(timestampMs);
        const date = new Date(timestampMs);
        /** @param {number} value @returns {string} */
        const pad = function pad(value) { return String(value).padStart(2, "0"); };
        return `${date.getUTCFullYear()  }-${ 
            pad(date.getUTCMonth() + 1)  }-${ 
            pad(date.getUTCDate())  } ${ 
            pad(date.getUTCHours())  }:${ 
            pad(date.getUTCMinutes())  }:${ 
            pad(date.getUTCSeconds())}`;
    }

    /** @param {unknown} value @returns {number} */
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
            : Date.parse(String(value));
        return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
    }

    /** @param {string|null|undefined} txHash @param {string|null|undefined} address @param {string|null|undefined} txKey @returns {string} */
    function makeProofUrl(txHash, address, txKey) {
        if (!txHash || !address || !txKey) return "";
        return `https://xmrchain.net/prove/${  txHash  }/${  address  }/${  txKey}`;
    }

    /** @param {unknown} address @returns {boolean} */
    function isIntegratedAddress(address) {
        return typeof address === "string" && address.length === 106;
    }

    /** @param {UnknownRecord} source @param {string} camelKey @param {string} snakeKey @returns {unknown} */
    function pickValue(source, camelKey, snakeKey) {
        return typeof source[camelKey] !== "undefined" ? source[camelKey] : source[snakeKey];
    }

    /** @param {string[]} columns @param {UnknownRecord} record @returns {SqlParam[]} */
    function namedValues(columns, record) {
        return columns.map(function getValue(column) {
            const value = record[column];
            // SQL rows are built from plain scalar fields. Converting an invalid
            // object to NULL keeps malformed input out of the driver boundary.
            return isSqlParam(value) ? value : null;
        });
    }

    /** @param {number} count @param {string} [separator] @returns {string} */
    function placeholders(count, separator) {
        return Array(count).fill("?").join(typeof separator === "string" ? separator : ", ");
    }

    /** @param {readonly unknown[]} items @param {string} key @returns {number} */
    function sumBy(items, key) {
        let total = 0;
        for (const item of items) {
            total += isRecord(item) ? normalizeInteger(item[key]) || 0 : 0;
        }
        return total;
    }

    /** @param {unknown} batchType @returns {string} */
    function batchTypeLabel(batchType) {
        if (batchType === "integrated") return "single-integrated";
        return "bulk";
    }

    /** @param {"log"|"warn"|"error"} method @param {string} scope @param {string} message @returns {void} */
    function log(method, scope, message) {
        console[method](`Payments ${  scope  }: ${  message}`);
    }

    /** @param {string} scope @param {string} message @returns {void} */
    function logInfo(scope, message) {
        log("log", scope, message);
    }

    /** @param {string} scope @param {string} message @returns {void} */
    function logWarn(scope, message) {
        log("warn", scope, message);
    }

    /** @param {string} scope @param {string} message @returns {void} */
    function logError(scope, message) {
        log("error", scope, message);
    }

    /** @param {unknown} amount @returns {number} */
    function coinToDecimal(amount) {
        const value = numericOrZero(amount);
        if (support && typeof support.coinToDecimal === "function") return support.coinToDecimal(value);
        if (config && config.coin && config.coin.sigDigits) return Number(value) / config.coin.sigDigits;
        return Number(value);
    }

    /** @returns {string} */
    function coinCode() {
        return config && config.general && config.general.coinCode ? config.general.coinCode : "XMR";
    }

    /** @param {string} key @returns {number} */
    function payoutAtomic(key) {
        if (!support || typeof support.decimalToCoin !== "function") return 0;
        return support.decimalToCoin(Number(config.payout[key]));
    }

    /** @returns {number} */
    function denomAtomic() {
        return Math.round(config.payout.denom * Number(config.general.sigDivisor));
    }

    /** @param {unknown} amount @returns {string} */
    function amountText(amount) {
        return `${coinToDecimal(amount)  } ${  coinCode()}`;
    }

    /** @returns {number} */
    function safeWalletFeeAtomic() {
        const configured = config && config.payout && typeof config.payout.safeWalletFee !== "undefined"
            ? Number(config.payout.safeWalletFee)
            : DEFAULT_SAFE_WALLET_FEE_XMR;
        const feeXmr = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SAFE_WALLET_FEE_XMR;
        if (support && typeof support.decimalToCoin === "function") return support.decimalToCoin(feeXmr);
        if (config && config.general && Number.isFinite(Number(config.general.sigDivisor))) return Math.round(feeXmr * Number(config.general.sigDivisor));
        if (config && config.coin && Number.isFinite(Number(config.coin.sigDigits))) return Math.round(feeXmr * config.coin.sigDigits);
        return 0;
    }

    /** @param {unknown} balance @param {unknown} unlocked @param {unknown} requiredNet @param {unknown} requiredTotal @returns {string} */
    function balanceSnapshotText(balance, unlocked, requiredNet, requiredTotal) {
        const fields = [];
        if (normalizeInteger(balance) !== null) fields.push(`wallet_balance=${  amountText(balance)}`);
        if (normalizeInteger(unlocked) !== null) fields.push(`wallet_unlocked=${  amountText(unlocked)}`);
        if (normalizeInteger(requiredNet) !== null) fields.push(`required_net=${  amountText(requiredNet)}`);
        if (normalizeInteger(requiredTotal) !== null && normalizeInteger(requiredTotal) !== normalizeInteger(requiredNet)) {
            fields.push(`required_total=${  amountText(requiredTotal)}`);
        }
        return fields.length ? ` ${  fields.join(" ")}` : "";
    }

    /** @param {unknown} reply @returns {string} */
    function describeWalletReply(reply) {
        if (isRecord(reply) && isRecord(reply["error"]) && reply["error"]["message"]) return String(reply["error"]["message"]);
        return formatError(reply);
    }

    /** @param {PaymentItem[]} items @returns {Record<string, unknown>} */
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

    /** @param {WalletTransfer} transfer @returns {Array<{address: string, amount: number|null}>} */
    function normalizeTransferDestinations(transfer) {
        if (Array.isArray(transfer.destinations) && transfer.destinations.length) {
            return transfer.destinations.map(function normalizeDestination(destination) {
                const address = typeof destination.address === "string" ? destination.address : "";
                return {
                    address,
                    amount: normalizeInteger(destination.amount)
                };
            }).filter(function isValid(destination) {
                return Boolean(destination.address) && destination.amount !== null;
            });
        }
        const amount = normalizeInteger(transfer.amount);
        return transfer.address && amount !== null
            ? [{ address: transfer.address, amount }]
            : [];
    }

    /** @param {PaymentItem[]} items @returns {Map<string, number>} */
    function destinationMultiset(items) {
        const expected = new Map();
        for (const item of items) {
            const key = `${pickValue(item, "paymentAddress", "payment_address")  }|${  pickValue(item, "netAmount", "net_amount")}`;
            expected.set(key, (expected.get(key) || 0) + 1);
        }
        return expected;
    }

    /** @param {PaymentBatch} batch @param {PaymentItem[]} items @param {WalletTransfer} transfer @returns {boolean} */
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
            isIntegratedAddress(items[0] ? pickValue(items[0], "paymentAddress", "payment_address") : null);
        // The refactored path only auto-reconciles address-only payouts, but
        // integrated addresses are reported back from wallet history with their
        // embedded short payment_id broken out into transfer.payment_id.
        if (normalizePaymentId(transfer.payment_id) !== null && !isSingleIntegratedBatch) return false;

        const destinations = normalizeTransferDestinations(transfer);
        if (destinations.length !== items.length) return false;
        if (batchType !== "bulk" && destinations.length !== 1) return false;

        // Match as a multiset of destination+amount pairs so duplicate recipients
        // remain safe: each expected output must be consumed exactly once.
        const expected = destinationMultiset(items);
        for (const destination of destinations) {
            const key = `${destination.address  }|${  destination.amount}`;
            const count = expected.get(key);
            if (!count) return false;
            if (count === 1) expected.delete(key);
            else expected.set(key, count - 1);
        }
        return expected.size === 0;
    }

    // This block is emitted before wallet transfer so operators can recover a payout
    // manually even if the host dies immediately after submission or during submission.
    /** @param {PaymentBatch} batch @param {PaymentItem[]} items @param {string} phase @param {UnknownRecord} [context] @returns {void} */
    function logBatchBlock(batch, items, phase, context) {
        const batchType = batchTypeLabel(pickValue(batch, "batchType", "batch_type"));
        const totalGross = pickValue(batch, "totalGross", "total_gross");
        const totalNet = pickValue(batch, "totalNet", "total_net");
        const totalFee = pickValue(batch, "totalFee", "total_fee");
        const txHash = batch.tx_hash ? ` tx_hash=${  batch.tx_hash}` : "";
        const txKey = batch.tx_key ? ` tx_key=${  batch.tx_key}` : "";
        const chargedFee = items.reduce(function sumFees(total, item) {
            return total + (normalizeInteger(pickValue(item, "feeAmount", "fee_amount")) || 0);
        }, 0);
        const balanceSnapshot = phase === "submit" && context
            ? balanceSnapshotText(context["walletBalance"], context["walletUnlocked"], context["requiredNet"] || totalNet, context["requiredTotal"])
            : "";
        logInfo(
            `batch#${  batch.id}`,
            `${phase  } status=${  batch.status 
            } type=${  batchType 
            } destinations=${  items.length 
            } gross=${  amountText(totalGross) 
            } net=${  amountText(totalNet) 
            } fee=${  amountText(totalFee) 
            }${balanceSnapshot 
            }${txHash 
            }${txKey}`
        );
        for (const item of items) {
            const address = pickValue(item, "paymentAddress", "payment_address");
            const proofUrl = makeProofUrl(batch.tx_hash, typeof address === "string" ? address : null, batch.tx_key);
            logInfo(
                `batch#${  batch.id}`,
                `item order=${  pickValue(item, "destinationOrder", "destination_order") 
                } address=${  address 
                } pool_type=${  pickValue(item, "poolType", "pool_type") 
                } gross=${  amountText(pickValue(item, "grossAmount", "gross_amount")) 
                } net=${  amountText(pickValue(item, "netAmount", "net_amount")) 
                } fee=${  amountText(pickValue(item, "feeAmount", "fee_amount")) 
                } mode=${  batchType 
                }${proofUrl ? ` proof=${  proofUrl}` : ""}`
            );
        }
        if (phase === "submit" || phase === "ambiguous-submit") {
            logInfo(`batch#${  batch.id}`, `fee-plan charged=${  amountText(chargedFee)}`);
            return;
        }
        const walletFee = normalizeInteger(batch.total_fee);
        if ((phase === "reconciled" || phase === "finalized" || phase === "manual-review") && walletFee !== null) {
            logInfo(
                `batch#${  batch.id}`,
                `fee-summary charged=${  amountText(chargedFee) 
                } wallet=${  amountText(batch.total_fee) 
                } retained=${  amountText(chargedFee - walletFee)}`
            );
        }
    }

    /** @param {string} method @param {unknown} params @param {boolean} suppressErrorLog @param {RpcOptions} [options] @returns {Promise<RpcResponse>} */
    async function callWallet(method, params, suppressErrorLog, options) {
        const rpcOptions = options && typeof options === "object"
            ? Object.assign({ suppressErrorLog: Boolean(suppressErrorLog) }, options)
            : suppressErrorLog;
        return await new Promise(function resolveWalletCall(resolve) {
            support.rpcWallet(method, params, resolve, rpcOptions);
        });
    }

    /** @param {SqlPool|SqlConnection} executor @param {string} sql @param {readonly SqlParam[]} params @param {string} [key] @returns {Promise<number|null>} */
    async function querySingleValue(executor, sql, params, key) {
        const rows = await executor.query(sql, params);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row || typeof row !== "object") return null;
        if (key && Object.prototype.hasOwnProperty.call(row, key)) return normalizeInteger(row[key]);
        const firstKey = Object.keys(row)[0];
        return firstKey ? normalizeInteger(row[firstKey]) : null;
    }

    /** @param {{affectedRows?: number}|null|undefined} result @param {number} expected @param {string} message @returns {void} */
    function assertAffectedRows(result, expected, message) {
        if (!result || result.affectedRows !== expected) throw new Error(message);
    }

    /** @param {PaymentBatch|number|string} batchOrId @param {Record<string, SqlParam>} fields @returns {Promise<void>} */
    async function updateBatchStatus(batchOrId, fields) {
        const batch = isRecord(batchOrId) ? batchOrId : null;
        const columns = [];
        const params = [];
        for (const entry of Object.entries(fields)) {
            columns.push(`${entry[0]  } = ?`);
            params.push(entry[1]);
        }
        params.push(getBatchId(batchOrId));
        await mysqlPool.query(`UPDATE payment_batches SET ${  columns.join(", ")  } WHERE id = ?`, params);
        // Most processor code carries an in-memory batch object forward through
        // several decisions. Mutating it here keeps later branches consistent
        // with the database row we just persisted.
        if (batch) Object.assign(batch, fields);
    }

    /** @param {string[]} sqlParts @param {SqlParam[]} params @param {string[]} expectedStatuses @returns {void} */
    function appendExpectedStatusFilter(sqlParts, params, expectedStatuses) {
        if (expectedStatuses.length === 1) {
            sqlParts.push("status = ?");
            params.push(expectedStatuses[0]);
        } else if (expectedStatuses.length > 1) {
            sqlParts.push(`status IN (${  placeholders(expectedStatuses.length, ",")  })`);
            params.push.apply(params, expectedStatuses);
        }
    }

    /** @param {PaymentBatch|null|undefined} batch @param {Record<string, SqlParam>} fields @param {boolean} updated @param {SqlPool|SqlConnection} executor @returns {Promise<void>} */
    async function refreshBatchObject(batch, fields, updated, executor) {
        if (!batch) return;
        if (updated) {
            Object.assign(batch, fields);
            return;
        }
        const rows = await executor.query("SELECT * FROM payment_batches WHERE id = ? LIMIT 1", [batch.id]);
        if (Array.isArray(rows) && rows.length) Object.assign(batch, rows[0]);
    }

    /** @param {PaymentBatch|number|string} batchOrId @param {Record<string, SqlParam>} fields @param {StatusUpdateOptions} [options] @returns {Promise<boolean>} */
    async function updateBatchStatusIfCurrent(batchOrId, fields, options) {
        const batch = isRecord(batchOrId) ? batchOrId : null;
        const opts = options || {};
        const executor = opts.executor || mysqlPool;
        const expectedStatuses = Array.isArray(opts.expectedStatuses) ? opts.expectedStatuses.filter(Boolean) : [];
        const requireNullFields = Array.isArray(opts.requireNullFields) ? opts.requireNullFields : [];
        const columns = [];
        const params = [];
        for (const entry of Object.entries(fields)) {
            columns.push(`${entry[0]  } = ?`);
            params.push(entry[1]);
        }
        params.push(getBatchId(batchOrId));
        const sqlParts = ["id = ?"];
        appendExpectedStatusFilter(sqlParts, params, expectedStatuses);
        for (const field of requireNullFields) sqlParts.push(`${field  } IS NULL`);
        const sql = `UPDATE payment_batches SET ${  columns.join(", ")  } WHERE ${  sqlParts.join(" AND ")}`;

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
        const updated = Boolean(result) && result.affectedRows === 1;
        await refreshBatchObject(batch, fields, updated, executor);
        return updated;
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
