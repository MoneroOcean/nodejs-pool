"use strict";
const workerHistory = require("../common/worker_history");

/** @typedef {import("../../types/runtime").PoolConfig} PoolConfig */
/** @typedef {import("../../types/runtime").LocalDatabaseRuntime} LocalDatabaseRuntime */
/** @typedef {import("../../types/runtime").SqlParam} SqlParam */
/** @typedef {import("../../types/runtime").SqlRow} SqlRow */
/** @typedef {import("../../types/runtime").SqlRows} SqlRows */
/** @typedef {import("../../types/runtime").SupportRuntime} SupportRuntime */
/** @typedef {import("../../types/runtime").ExpressApp} ExpressApp */
/** @typedef {import("../../types/runtime").ExpressRequest} ExpressRequest */
/** @typedef {import("../../types/runtime").ExpressResponse} ExpressResponse */
/** @typedef {{address_decode: (address: Buffer) => number}} BlockTemplateApi */
/** @typedef {{limit: number, page: number}} Pagination */
/** @typedef {{address: string, paymentId: string | undefined}} ParsedAddress */
/** @typedef {{ts: number, [key: string]: unknown}} Timestamped */
/** @typedef {{lts?: number | false, hash: unknown, hash2: unknown, identifier?: string, identifer?: string, lastHash?: number | false, lastShareAlgo: unknown, totalHash?: unknown, totalHashes?: unknown, validShares: number | false, invalidShares: number | false, amtPaid?: unknown, amtDue?: unknown, txnCount?: unknown}} StatsEntry */
/** @typedef {{[key: string]: StatsEntry}} StatsMap */
/** @typedef {{[key: string]: Array<{ts: number, hs: number, hs2: number}>}} HashHistoryMap */
/** @typedef {{config: PoolConfig, database: LocalDatabaseRuntime, getCacheValue: (key: string, fallback: unknown) => unknown, now: () => number, query: (sql: string, params?: readonly SqlParam[]) => Promise<SqlRows>, support: SupportRuntime}} PublicCore */
/** @typedef {{app: ExpressApp, registerCachedGet: (path: string, ttlMs: number, scope: string, keyFn: (request: ExpressRequest) => string, handler: (request: ExpressRequest, response: ExpressResponse) => unknown | Promise<unknown>, fallback?: unknown) => void}} PublicHttp */
/** @typedef {{blockTemplate?: BlockTemplateApi, cnUtil?: BlockTemplateApi, core: PublicCore, http: PublicHttp, poolList: string[]}} PublicContext */
/** @typedef {{path: string, ttlMs: number, scope: string, key: (request: ExpressRequest) => string, handler: (request: ExpressRequest, response?: ExpressResponse) => unknown | Promise<unknown>, fallback?: unknown}} CachedRoute */
/** @typedef {{id: unknown, hash: unknown, mixins: unknown, payees: unknown, fee: unknown, value: unknown, ts: number}} TransactionOutput */
/** @typedef {{id: unknown, ts: number, ts_found: number, port: unknown, hash: unknown, value_percent: number, value: number}} BlockPaymentOutput */

const INVALID_POOL_TYPE = { error: "Invalid pool type" };
const PAGE_LIMITS = [15, 50, 100];
const MAX_PAGE = 1000;
const PAID_BLOCKS_MEMO_TTL_MS = 10 * 1000;
const PAID_BLOCKS_MEMO_MAX = 64;
// Explicit column list (never SELECT *) so internal columns such as the payee
// address and payment_id are not exposed even if a mapper later changes.
const TRANSACTIONS_SELECT = "SELECT id, transaction_hash, mixin, fees, payees, xmr_amt, submitted_time FROM transactions";

/** @param {Timestamped} left @param {Timestamped} right @returns {number} */
function defaultTsCompare(left, right) { return left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0; }

/** @template {Timestamped} T @param {T[]} items @param {SupportRuntime | undefined} support @returns {T[]} */
function sortByTsDesc(items, support) {
    const comparator = support && typeof support.tsCompare === "function"
        ? /** @param {Timestamped} left @param {Timestamped} right @returns {number} */ function compare(left, right) { return support.tsCompare(left, right); }
        : defaultTsCompare;
    return items.sort(comparator);
}

/** @param {unknown} poolType @returns {"pplns" | "legacy"} */
function normalizePoolType(poolType) { return poolType === "pplns" ? "pplns" : "legacy"; }

/** @param {unknown} value @param {number} fallback @param {number} minimum @param {number | undefined} [maximum] @returns {number} */
function normalizeInteger(value, fallback, minimum, maximum) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    if (typeof maximum === "number" && parsed > maximum) return maximum;
    return parsed;
}

/** @param {unknown} value @returns {value is string | number} */
function isSqlId(value) { return typeof value === "string" || typeof value === "number"; }

/** @param {Record<string, string | string[] | undefined>} query @param {number} defaultLimit @param {number | undefined} [maxLimit] @returns {Pagination} */
function getPagination(query, defaultLimit, maxLimit) {
    const requestedLimit = normalizeInteger(query["limit"], defaultLimit, 1, maxLimit);
    const normalizedLimit = PAGE_LIMITS.indexOf(requestedLimit) === -1 ? defaultLimit : requestedLimit;
    return { limit: normalizedLimit, page: normalizeInteger(query["page"], 0, 0, MAX_PAGE) };
}

/** @param {unknown} value @returns {ParsedAddress} */
function parseAddress(value) {
    const raw = String(value || "");
    const separatorIndex = raw.indexOf(".");
    return separatorIndex === -1 ? { address: raw, paymentId: undefined } : { address: raw.slice(0, separatorIndex), paymentId: raw.slice(separatorIndex + 1) };
}

/** @param {SqlRows} rows @returns {unknown} */
function getAmount(rows) {
    const row = rows[0];
    if (!row || row["amt"] === null || typeof row["amt"] === "undefined") return 0;
    return row["amt"];
}

/** @param {number} count @returns {string} */
function createPlaceholders(count) { return Array.from({ length: count }, function build() { return "?"; }).join(", "); }

/** @param {BlockTemplateApi | undefined} blockTemplate @param {unknown} address @returns {number | null} */
function safeDecodeAddress(blockTemplate, address) {
    if (!blockTemplate) return null;
    try { return blockTemplate.address_decode(Buffer.from(String(address || ""))); } catch (_error) { return null; }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** @param {unknown} value @param {number} fallback @returns {number} */
function asNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** @param {unknown} value @returns {string | number | Date} */
function asDateInput(value) {
    return value instanceof Date || typeof value === "string" || typeof value === "number" ? value : 0;
}

/** @param {ExpressRequest} request @param {string} name @returns {string} */
function routeParam(request, name) {
    const value = request.params[name];
    return typeof value === "string" ? value : "";
}

/** @param {PublicContext} ctx @returns {void} */
module.exports = function registerPublicRoutes(ctx) {
    const blockTemplate = ctx.blockTemplate || ctx.cnUtil;
    const { core, http, poolList } = ctx;
    const { config, database, getCacheValue, now, query, support } = core;
    const { registerCachedGet } = http;
    const sigDivisor = asNumber(config.general.sigDivisor, 1);

    /** @param {string} key @returns {Array<{ts: number, hs: number, hs2: number}>} */
    function getHashHistory(key) {
        return workerHistory.toHashHistory(getCacheValue(key, null));
    }

    /** @param {string} key @returns {Array<{ts: number, hs: number, hs2: number}>} */
    function getPoolHashHistory(key) {
        const cachedData = getCacheValue(key, {});
        const hashHistory = isRecord(cachedData) ? cachedData["hashHistory"] : null;
        return Array.isArray(hashHistory) ? hashHistory : workerHistory.toHashHistory(hashHistory);
    }

    /** @param {string} key @param {string | undefined} [field] @returns {unknown[]} */
    function getCacheArray(key, field) {
        const cached = getCacheValue(key, {});
        const value = field ? (isRecord(cached) ? cached[field] : undefined) : getCacheValue(key, []);
        return Array.isArray(value) ? value : [];
    }

    /** @param {string} address @returns {string[]} */
    function getIdentifiers(address) {
        return getCacheArray(`identifiers:${  address}`).filter(function isIdentifier(value) {
            return typeof value === "string";
        }).sort();
    }

    /** @param {string} baseKey @param {string} identifier @returns {StatsEntry} */
    function getWorkerStatsEntry(baseKey, identifier) {
        const cachedData = getCacheValue(baseKey, null);
        const cachedStats = getCacheValue(`stats:${  baseKey}`, null);
        const data = isRecord(cachedData) ? cachedData : null;
        const stats = isRecord(cachedStats) ? cachedStats : null;
        return {
            lts: stats && Number.isFinite(Number(stats["lastHash"])) ? Math.floor(Number(stats["lastHash"]) / 1000) : false,
            identifer: identifier,
            hash: stats ? stats["hash"] : false,
            hash2: stats ? stats["hash2"] : false,
            lastShareAlgo: stats ? stats["lastShareAlgo"] || false : false,
            totalHash: data ? data["totalHashes"] : false,
            validShares: data ? Number(data["goodShares"] || 0) : false,
            invalidShares: data ? Number(data["badShares"] || 0) : false
        };
    }

    /** @param {string} address @returns {StatsEntry} */
    function getAddressStatsEntry(address) {
        const cachedData = getCacheValue(address, null);
        const cachedStats = getCacheValue(`stats:${  address}`, null);
        const data = isRecord(cachedData) ? cachedData : null;
        const stats = isRecord(cachedStats) ? cachedStats : null;
        return {
            hash: stats ? stats["hash"] : false,
            hash2: stats ? stats["hash2"] : false,
            identifier: "global",
            lastHash: stats && Number.isFinite(Number(stats["lastHash"])) ? Math.floor(Number(stats["lastHash"]) / 1000) : false,
            lastShareAlgo: stats ? stats["lastShareAlgo"] || false : false,
            totalHashes: data ? data["totalHashes"] : false,
            validShares: data ? Number(data["goodShares"] || 0) : false,
            invalidShares: data ? Number(data["badShares"] || 0) : false
        };
    }

    /** @param {string} address @returns {StatsMap} */
    function getAllWorkerStats(address) {
        /** @type {StatsMap} */
        const response = { global: getWorkerStatsEntry(address, "global") };
        const identifiers = getIdentifiers(address);
        for (const identifier of identifiers) response[identifier] = getWorkerStatsEntry(`${address  }_${  identifier}`, identifier);
        return response;
    }

    /** @param {string} address @returns {HashHistoryMap} */
    function getAllWorkerHashCharts(address) {
        /** @type {HashHistoryMap} */
        const response = { global: getHashHistory(`history:${  address}`) };
        const identifiers = getIdentifiers(address);
        for (const identifier of identifiers) response[identifier] = getHashHistory(`history:${  address  }_${  identifier}`);
        return response;
    }

    // Percent-encode each part before joining so a value containing the "|" separator
    // (or "%") cannot be crafted to collide with a different (prefix, params) key.
    /** @param {unknown[]} parts @returns {string} */
    function getCacheKey(parts) { return parts.map(function encodePart(part) { return encodeURIComponent(part == null ? "" : String(part)); }).join("|"); }

    /** @param {string} prefix @param {...string} names @returns {(request: ExpressRequest) => string} */
    function paramKey(prefix, ...names) {
        return function buildParamKey(req) {
            return getCacheKey([prefix, ...names.map(function map(name) { return req.params[name] || ""; })]);
        };
    }

    /** @param {string} key @returns {(request: ExpressRequest) => string} */
    function staticKey(key) { return function keyFn() { return key; }; }

    /** @param {number} defaultLimit @param {number | undefined} maxLimit @param {(request: ExpressRequest, pagination: Pagination) => unknown | Promise<unknown>} handler @returns {(request: ExpressRequest) => unknown | Promise<unknown>} */
    function withPagination(defaultLimit, maxLimit, handler) {
        return function handleWithPagination(req) {
            return handler(req, getPagination(req.query, defaultLimit, maxLimit));
        };
    }

    /** @param {string} prefix @param {number} defaultLimit @param {number | undefined} [maxLimit] @param {((request: ExpressRequest) => unknown[]) | undefined} [extraPartsFn] @returns {(request: ExpressRequest) => string} */
    function pagedCacheKey(prefix, defaultLimit, maxLimit, extraPartsFn) {
        return function buildPagedCacheKey(req) {
            const pagination = getPagination(req.query, defaultLimit, maxLimit);
            const extraParts = typeof extraPartsFn === "function" ? extraPartsFn(req) : [];
            return getCacheKey([prefix, ...extraParts, pagination.limit, pagination.page]);
        };
    }

    /** @param {Pagination} pagination @returns {[number, number]} */
    function pageBounds(pagination) { return [pagination.page * pagination.limit, (pagination.page + 1) * pagination.limit]; }

    /** @param {ParsedAddress} parsed @param {string} withPaymentIdSql @param {string} withoutPaymentIdSql @returns {[string, SqlParam[]]} */
    function addressQuery(parsed, withPaymentIdSql, withoutPaymentIdSql) {
        return parsed.paymentId === undefined
            ? [withoutPaymentIdSql, [parsed.address]]
            : [withPaymentIdSql, [parsed.address, parsed.paymentId]];
    }

    /** @template T @template {Timestamped} U @param {T[]} rows @param {(row: T) => U} mapper @returns {U[]} */
    function sortMapped(rows, mapper) {
        return sortByTsDesc(rows.map(mapper), support);
    }

    /** @param {string} path @param {number} ttlMs @param {string} scope @param {(request: ExpressRequest) => string} key @param {(request: ExpressRequest, response?: ExpressResponse) => unknown | Promise<unknown>} handler @param {unknown} [fallback] @returns {CachedRoute} */
    function cachedRoute(path, ttlMs, scope, key, handler, fallback) {
        return { path, ttlMs, scope, key, handler, fallback };
    }

    /** @param {(request: ExpressRequest) => unknown | Promise<unknown>} handler @returns {(request: ExpressRequest) => unknown | Promise<unknown>} */
    function poolTypeOnly(handler) { return function poolTypeHandler(req) { return req.params["pool_type"] === "pplns" ? handler(req) : INVALID_POOL_TYPE; }; }

    /** @param {string} cacheKey @param {Record<string, unknown>} [extra] @returns {Record<string, unknown>} */
    function cachePoolStats(cacheKey, extra) {
        const value = getCacheValue(cacheKey, {});
        const output = Object.assign({}, isRecord(value) ? value : {}, extra || {});
        delete output["minerHistory"];
        delete output["hashHistory"];
        return output;
    }

    function payoutPolicy() {
        return {
            minimumThreshold: config.payout.walletMin,
            defaultThreshold: config.payout.defaultPay,
            exchangeMinimumThreshold: config.payout.exchangeMin,
            denomination: config.payout.denom,
            maturityDepth: config.payout.blocksRequired,
            feeFormula: {
                maxFee: typeof config.payout.safeWalletFee !== "undefined" ? config.payout.safeWalletFee : 0.0004,
                zeroFeeThreshold: typeof config.payout.feeSlewEnd !== "undefined" ? config.payout.feeSlewEnd : 4
            }
        };
    }

    /** @param {string} address @returns {Promise<StatsEntry>} */
    async function getAddressStats(address) {
        const parsed = parseAddress(address);
        const response = getAddressStatsEntry(address);
        const paidQuery = addressQuery(
            parsed,
            "SELECT SUM(amount) as amt FROM payments WHERE payment_address = ? AND payment_id = ?",
            "SELECT SUM(amount) as amt FROM payments WHERE payment_address = ? AND payment_id IS NULL"
        );
        const unpaidQuery = addressQuery(
            parsed,
            "SELECT SUM(amount) as amt FROM balance WHERE payment_address = ? AND payment_id = ?",
            "SELECT SUM(amount) as amt FROM balance WHERE payment_address = ? AND payment_id IS NULL"
        );
        const txnQuery = addressQuery(
            parsed,
            "SELECT count(id) as amt FROM payments WHERE payment_address = ? AND payment_id = ?",
            "SELECT count(id) as amt FROM payments WHERE payment_address = ? AND payment_id IS NULL"
        );
        const [paidRows, unpaidRows, txnRows] = await Promise.all([
            query(paidQuery[0], paidQuery[1]),
            query(unpaidQuery[0], unpaidQuery[1]),
            query(txnQuery[0], txnQuery[1])
        ]);

        response.amtPaid = getAmount(paidRows);
        response.amtDue = getAmount(unpaidRows);
        response.txnCount = getAmount(txnRows);
        return response;
    }

    /** @param {SqlRow} row @returns {TransactionOutput} */
    function mapTransactionRow(row) {
        return {
            id: row["id"],
            hash: row["transaction_hash"],
            mixins: row["mixin"],
            payees: row["payees"],
            fee: row["fees"],
            value: row["xmr_amt"],
            ts: new Date(asDateInput(row["submitted_time"])).getTime()
        };
    }

    /** @param {number} limit @param {number} page @returns {Promise<TransactionOutput[]>} */
    async function getPoolPayments(limit, page) {
        const rows = await query(`${TRANSACTIONS_SELECT  } ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, page * limit]);
        if (rows.length === 0) return [];

        return sortMapped(rows, mapTransactionRow);
    }

    /** @param {number} limit @param {number} page @returns {Promise<Array<TransactionOutput & {pool_type: string}>>} */
    async function getRecentPayments(limit, page) {
        const rows = await query(`${TRANSACTIONS_SELECT  } ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, page * limit]);
        if (rows.length === 0) return [];

        /** @type {Record<string, string>} */
        const poolTypes = {};
        if (poolList.length === 1) {
            const poolType = normalizePoolType(poolList[0]);
            for (const row of rows) poolTypes[String(row["id"])] = poolType;
        } else {
            const ids = rows.map(function map(row) { return row["id"]; }).filter(isSqlId);
            const typeRows = await query(
                `SELECT transaction_id, MIN(pool_type) AS pool_type FROM payments WHERE transaction_id IN (${ 
                createPlaceholders(ids.length)  }) GROUP BY transaction_id`,
                ids
            );
            for (const row of typeRows) poolTypes[String(row["transaction_id"])] = normalizePoolType(row["pool_type"]);
        }

        return sortMapped(rows, function build(row) {
            return Object.assign(mapTransactionRow(row), { pool_type: poolTypes[String(row["id"])] || "?" });
        });
    }

    /** @param {string} addressParam @param {number} limit @param {number} page @returns {Promise<Timestamped[]>} */
    async function getMinerPayments(addressParam, limit, page) {
        const parsed = parseAddress(addressParam);
        const paymentQuery = addressQuery(
            parsed,
            "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM payments WHERE payment_address = ? AND payment_id = ? ORDER BY paid_time DESC LIMIT ? OFFSET ?",
            "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM payments WHERE payment_address = ? AND payment_id IS NULL ORDER BY paid_time DESC LIMIT ? OFFSET ?"
        );
        const rows = await query(paymentQuery[0], paymentQuery[1].concat([limit, page * limit]));
        if (rows.length === 0) return [];

        const ids = Array.from(new Set(rows.map(function map(row) { return row["transaction_id"]; }))).filter(isSqlId);
        const txnRows = await query(
            `SELECT id, transaction_hash, mixin FROM transactions WHERE id IN (${  createPlaceholders(ids.length)  }) ORDER BY id DESC`,
            ids
        );
        const txMap = txnRows.reduce(function assign(result, row) {
            result[String(row["id"])] = row;
            return result;
        }, /** @type {Record<string, SqlRow>} */ ({}));
        const response = [];
        for (const row of rows) {
            const txn = txMap[String(row["transaction_id"])]
            if (!txn) continue;
            response.push({
                pt: normalizePoolType(row["pool_type"]),
                ts: Math.ceil(asNumber(row["ts"], 0)),
                amount: row["amt"],
                txnHash: txn["transaction_hash"],
                mixin: txn["mixin"]
            });
        }
        return sortByTsDesc(response, support);
    }

    // The recent-paid-blocks list is identical for every miner, so memoize it briefly:
    // otherwise each distinct address re-runs the same 7-day paid_blocks scan. The cached
    // rows are only read (never mutated) by callers, so sharing the array is safe.
    /** @type {Map<string, {value: SqlRows, expiresAt: number}>} */
    const recentPaidBlocksMemo = new Map();
    /** @param {number} limit @param {number} page @returns {Promise<SqlRows>} */
    async function getRecentPaidBlocks(limit, page) {
        const memoKey = `${limit  }|${  page}`;
        const timeNow = typeof now === "function" ? now() : Date.now();
        const cached = recentPaidBlocksMemo.get(memoKey);
        if (cached && cached.expiresAt > timeNow) return cached.value;
        const rows = await query(
            "SELECT id, paid_time, found_time, port, hex, amount FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 7 DAY) ORDER BY id DESC LIMIT ? OFFSET ?",
            [limit, page * limit]
        );
        recentPaidBlocksMemo.set(memoKey, { value: rows, expiresAt: timeNow + PAID_BLOCKS_MEMO_TTL_MS });
        if (recentPaidBlocksMemo.size > PAID_BLOCKS_MEMO_MAX) {
            for (const [key, entry] of recentPaidBlocksMemo) {
                if (entry.expiresAt <= timeNow) recentPaidBlocksMemo.delete(key);
            }
            while (recentPaidBlocksMemo.size > PAID_BLOCKS_MEMO_MAX) {
                const oldest = recentPaidBlocksMemo.keys().next();
                if (oldest.done) break;
                recentPaidBlocksMemo.delete(oldest.value);
            }
        }
        return rows;
    }

    /** @param {string} addressParam @param {number} limit @param {number} page @returns {Promise<BlockPaymentOutput[]>} */
    async function getMinerBlockPayments(addressParam, limit, page) {
        const parsed = parseAddress(addressParam);
        const blocks = await getRecentPaidBlocks(limit, page);
        if (blocks.length === 0) return [];

        const hexes = blocks.map(function map(row) { return row["hex"]; }).filter(isSqlId);
        // block_balance stores missing payment IDs as '' as well as NULL, so the no-paymentId branch matches both.
        const balanceQuery = addressQuery(
            parsed,
            `SELECT hex, amount FROM block_balance WHERE payment_address = ? AND payment_id = ? AND hex IN (${  createPlaceholders(hexes.length)  })`,
            `SELECT hex, amount FROM block_balance WHERE payment_address = ? AND (payment_id IS NULL OR payment_id = '') AND hex IN (${  createPlaceholders(hexes.length)  })`
        );
        const shares = await query(balanceQuery[0], balanceQuery[1].concat(hexes));
        /** @type {Record<string, number>} */
        const shareMap = {};
        for (const row of shares) shareMap[String(row["hex"])] = asNumber(row["amount"], 0);

        return sortMapped(blocks, function build(row) {
            const share = shareMap[String(row["hex"])] || 0;
            return {
                id: row["id"],
                ts: new Date(asDateInput(row["paid_time"])).getTime() / 1000,
                ts_found: new Date(asDateInput(row["found_time"])).getTime() / 1000,
                port: row["port"],
                hash: row["hex"],
                value_percent: share * 100,
                value: share * asNumber(row["amount"], 0) / sigDivisor
            };
        });
    }

    const addressBase58Prefix = safeDecodeAddress(blockTemplate, config && config.pool ? config.pool.address : "");
    const routes = [
        cachedRoute("/config", 5 * 60 * 1000, "config", staticKey("config"), function configRoute() {
            return {
                pplns_fee: config.payout.pplnsFee,
                min_wallet_payout: config.payout.walletMin * sigDivisor,
                min_exchange_payout: config.payout.exchangeMin * sigDivisor,
                dev_donation: config.payout.devDonation,
                pool_dev_donation: config.payout.poolDevDonation,
                maturity_depth: config.payout.blocksRequired,
                min_denom: config.payout.denom * sigDivisor,
                coin_code: config.general.coinCode,
                payout_policy: payoutPolicy()
            };
        }),
        cachedRoute("/pool/address_type/:address", 10 * 1000, "pool address type",
            paramKey("pool-address", "address"),
            function addressTypeRoute(req) {
                const decoded = safeDecodeAddress(blockTemplate, routeParam(req, "address"));
                return decoded !== null && decoded === addressBase58Prefix ? { valid: true, address_type: config.general.coinCode } : { valid: false };
            }
        ),
        cachedRoute("/pool/motd", 60 * 1000, "pool motd", staticKey("pool-motd"), function motdRoute() {
            const news = getCacheValue("news", {});
            const newsRecord = isRecord(news) ? news : {};
            return { created: newsRecord["created"], subject: newsRecord["subject"], body: newsRecord["body"] };
        }),
        cachedRoute("/pool/stats", 10 * 1000, "pool stats", staticKey("pool-stats"), function poolStatsRoute() {
            return { pool_list: poolList, pool_statistics: cachePoolStats("pool_stats_global"), last_payment: getCacheValue("lastPaymentCycle", 0) || 0 };
        }),
        cachedRoute("/pool/chart/hashrate", 10 * 1000, "pool chart hashrate", staticKey("pool-chart-hashrate"), function hashrateRoute() {
            return getPoolHashHistory("global_stats");
        }),
        cachedRoute("/pool/chart/miners", 10 * 1000, "pool chart miners", staticKey("pool-chart-miners"), function minersRoute() {
            return getCacheArray("global_stats", "minerHistory");
        }),
        cachedRoute("/pool/chart/hashrate/:pool_type", 10 * 1000, "pool chart hashrate pool type",
            paramKey("pool-chart-hashrate", "pool_type"),
            poolTypeOnly(function poolHashrateTypeRoute() { return getPoolHashHistory("pplns_stats"); })
        ),
        cachedRoute("/pool/chart/miners/:pool_type", 10 * 1000, "pool chart miners pool type",
            paramKey("pool-chart-miners", "pool_type"),
            poolTypeOnly(function poolMinersTypeRoute() { return getCacheArray("stats_pplns", "minerHistory"); })
        ),
        cachedRoute("/pool/stats/:pool_type", 10 * 1000, "pool stats pool type",
            paramKey("pool-stats", "pool_type"),
            poolTypeOnly(function poolStatsTypeRoute() { return { pool_statistics: cachePoolStats("pool_stats_pplns", { fee: config.payout.pplnsFee }) }; })
        ),
        cachedRoute("/pool/ports", 10 * 1000, "pool ports", staticKey("pool-ports"), function poolPortsRoute() { return getCacheValue("poolPorts", []); }),
        cachedRoute("/pool/blocks/:pool_type", 10 * 1000, "pool blocks",
            pagedCacheKey("pool-blocks", 15, undefined, function poolBlockParts(req) { return [routeParam(req, "pool_type")]; }),
            withPagination(15, undefined, function poolBlocksRoute(req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getBlockList(routeParam(req, "pool_type"), bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/altblocks/:pool_type", 10 * 1000, "pool altblocks",
            pagedCacheKey("pool-altblocks", 15, undefined, function poolAltBlockParts(req) { return [routeParam(req, "pool_type")]; }),
            withPagination(15, undefined, function poolAltBlocksRoute(req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getAltBlockList(routeParam(req, "pool_type"), null, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/blocks", 10 * 1000, "pool blocks all", pagedCacheKey("pool-blocks-all", 15),
            withPagination(15, undefined, function poolBlocksAllRoute(_req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getBlockList(null, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/altblocks", 10 * 1000, "pool altblocks all", pagedCacheKey("pool-altblocks-all", 15),
            withPagination(15, undefined, function poolAltBlocksAllRoute(_req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getAltBlockList(null, null, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/coin_altblocks/:coin_port", 10 * 1000, "pool coin altblocks",
            pagedCacheKey("pool-coin-altblocks", 15, undefined, function poolCoinAltBlockParts(req) { return [normalizeInteger(routeParam(req, "coin_port"), 0, 1)]; }),
            withPagination(15, undefined, function poolCoinAltBlocksRoute(req, pagination) {
                const coinPort = normalizeInteger(routeParam(req, "coin_port"), 0, 1);
                if (coinPort === 0) return [];
                const bounds = pageBounds(pagination);
                return database.getAltBlockList(null, coinPort, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/payments/:pool_type", 60 * 1000, "pool payments",
            pagedCacheKey("pool-payments", 15, undefined, function poolPaymentParts(req) { return [routeParam(req, "pool_type")]; }),
            withPagination(15, undefined, function poolPaymentsRoute(req, pagination) {
                return routeParam(req, "pool_type") === "pplns" ? getPoolPayments(pagination.limit, pagination.page) : INVALID_POOL_TYPE;
            }),
            { error: "Issue getting pool payments" }
        ),
        cachedRoute("/pool/payments", 60 * 1000, "pool payments all", pagedCacheKey("pool-payments-all", 15),
            withPagination(15, undefined, function poolPaymentsAllRoute(_req, pagination) {
                return getRecentPayments(pagination.limit, pagination.page);
            }),
            { error: "Issue getting pool payments" }
        ),
        cachedRoute("/network/stats", 10 * 1000, "network stats", staticKey("network-stats"), function networkStatsRoute() { return getCacheValue("networkBlockInfo", {}); }),
        cachedRoute("/miner/:address/identifiers", 10 * 1000, "miner identifiers", paramKey("miner-identifiers", "address"), function minerIdentifiersRoute(req) { return getIdentifiers(routeParam(req, "address")); }),
        cachedRoute("/miner/:address/payments", 60 * 1000, "miner payments", pagedCacheKey("miner-payments", 15, undefined, function minerPaymentParts(req) { return [routeParam(req, "address")]; }),
            withPagination(15, undefined, function minerPaymentsRoute(req, pagination) { return getMinerPayments(routeParam(req, "address"), pagination.limit, pagination.page); }),
            { error: "Issue getting miner payments" }
        ),
        cachedRoute("/miner/:address/block_payments", 60 * 1000, "miner block payments", pagedCacheKey("miner-block-payments", 15, 100, function minerBlockPaymentParts(req) { return [routeParam(req, "address")]; }),
            withPagination(15, 100, function minerBlockPaymentsRoute(req, pagination) { return getMinerBlockPayments(routeParam(req, "address"), pagination.limit, pagination.page); }),
            { error: "Issue getting block payments" }
        ),
        cachedRoute("/miner/:address/stats/allWorkers", 10 * 1000, "miner stats all workers", paramKey("miner-stats-all", "address"), function minerStatsAllRoute(req) { return getAllWorkerStats(routeParam(req, "address")); }),
        cachedRoute("/miner/:address/stats/:identifier", 10 * 1000, "miner stats", paramKey("miner-stats", "address", "identifier"), function minerStatsRoute(req) {
            const address = routeParam(req, "address");
            const identifier = routeParam(req, "identifier");
            return getWorkerStatsEntry(`${address  }_${  identifier}`, identifier);
        }),
        cachedRoute("/miner/:address/chart/hashrate", 10 * 1000, "miner chart hashrate", paramKey("miner-chart-hashrate", "address"), function minerHashrateRoute(req) { return getHashHistory(`history:${  routeParam(req, "address")}`); }),
        cachedRoute("/miner/:address/chart/hashrate/allWorkers", 10 * 1000, "miner chart hashrate all workers", paramKey("miner-chart-hashrate-all", "address"), function minerHashrateAllRoute(req) { return getAllWorkerHashCharts(routeParam(req, "address")); }),
        cachedRoute("/miner/:address/chart/hashrate/:identifier", 10 * 1000, "miner chart hashrate worker", paramKey("miner-chart-hashrate", "address", "identifier"), function minerHashrateWorkerRoute(req) {
            return getHashHistory(`history:${  routeParam(req, "address")  }_${  routeParam(req, "identifier")}`);
        }),
        cachedRoute("/miner/:address/stats", 60 * 1000, "miner stats address", paramKey("miner-stats-address", "address"), function minerAddressStatsRoute(req) { return getAddressStats(routeParam(req, "address")); })
    ];

    for (const route of routes) {
        registerCachedGet(route.path, route.ttlMs, route.scope, route.key, route.handler, route.fallback);
    }
};
