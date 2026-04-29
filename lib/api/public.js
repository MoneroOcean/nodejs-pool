"use strict";
const workerHistory = require("../common/worker_history");

const INVALID_POOL_TYPE = { error: "Invalid pool type" };
const MAX_PAGE = 1000;

function defaultTsCompare(left, right) { return left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0; }

function sortByTsDesc(items, support) { return items.sort(support && typeof support.tsCompare === "function" ? support.tsCompare : defaultTsCompare); }

function normalizePoolType(poolType) { return poolType === "pplns" ? "pplns" : "legacy"; }

function normalizeInteger(value, fallback, minimum, maximum) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    if (typeof maximum === "number" && parsed > maximum) return maximum;
    return parsed;
}

function getPagination(query, defaultLimit, maxLimit) {
    return { limit: normalizeInteger(query.limit, defaultLimit, 0, maxLimit), page: normalizeInteger(query.page, 0, 0, MAX_PAGE) };
}

function parseAddress(value) {
    const raw = String(value || "");
    const separatorIndex = raw.indexOf(".");
    return separatorIndex === -1 ? { address: raw, paymentId: undefined } : { address: raw.slice(0, separatorIndex), paymentId: raw.slice(separatorIndex + 1) };
}

function getAmount(rows) {
    if (!Array.isArray(rows) || rows.length === 0 || rows[0].amt === null || typeof rows[0].amt === "undefined") return 0;
    return rows[0].amt;
}

function createPlaceholders(count) { return Array.from({ length: count }, function build() { return "?"; }).join(", "); }

function safeDecodeAddress(blockTemplate, address) {
    try { return blockTemplate.address_decode(Buffer.from(String(address || ""))); } catch (_error) { return null; }
}

module.exports = function registerPublicRoutes(ctx) {
    const blockTemplate = ctx.blockTemplate || ctx.cnUtil;
    const { core, http, poolList } = ctx;
    const { config, database, getCacheValue, query, support } = core;
    const { registerCachedGet } = http;

    function getHashHistory(key) {
        return workerHistory.toHashHistory(getCacheValue(key, null));
    }

    function getCacheArray(key, field) {
        const value = field ? getCacheValue(key, {})[field] : getCacheValue(key, []);
        return Array.isArray(value) ? value : [];
    }

    function getIdentifiers(address) {
        return getCacheArray("identifiers:" + address).slice().sort();
    }

    function getWorkerStatsEntry(baseKey, identifier) {
        const cachedData = getCacheValue(baseKey, null);
        const cachedStats = getCacheValue("stats:" + baseKey, null);
        return {
            lts: cachedStats && Number.isFinite(Number(cachedStats.lastHash)) ? Math.floor(Number(cachedStats.lastHash) / 1000) : false,
            identifer: identifier,
            hash: cachedStats ? cachedStats.hash : false,
            hash2: cachedStats ? cachedStats.hash2 : false,
            totalHash: cachedData ? cachedData.totalHashes : false,
            validShares: cachedData ? Number(cachedData.goodShares || 0) : false,
            invalidShares: cachedData ? Number(cachedData.badShares || 0) : false
        };
    }

    function getAddressStatsEntry(address) {
        const cachedData = getCacheValue(address, null);
        const cachedStats = getCacheValue("stats:" + address, null);
        return {
            hash: cachedStats ? cachedStats.hash : false,
            hash2: cachedStats ? cachedStats.hash2 : false,
            identifier: "global",
            lastHash: cachedStats && Number.isFinite(Number(cachedStats.lastHash)) ? Math.floor(Number(cachedStats.lastHash) / 1000) : false,
            totalHashes: cachedData ? cachedData.totalHashes : false,
            validShares: cachedData ? Number(cachedData.goodShares || 0) : false,
            invalidShares: cachedData ? Number(cachedData.badShares || 0) : false
        };
    }

    function getAllWorkerStats(address) {
        const response = { global: getWorkerStatsEntry(address, "global") };
        const identifiers = getIdentifiers(address);
        for (const identifier of identifiers) response[identifier] = getWorkerStatsEntry(address + "_" + identifier, identifier);
        return response;
    }

    function getAllWorkerHashCharts(address) {
        const response = { global: getHashHistory("history:" + address) };
        const identifiers = getIdentifiers(address);
        for (const identifier of identifiers) response[identifier] = getHashHistory("history:" + address + "_" + identifier);
        return response;
    }

    function getCacheKey(parts) { return parts.join("|"); }

    function paramKey(prefix) {
        const names = Array.prototype.slice.call(arguments, 1);
        return function buildParamKey(req) {
            return getCacheKey([prefix].concat(names.map(function map(name) { return req.params[name]; })));
        };
    }

    function staticKey(key) { return function keyFn() { return key; }; }

    function withPagination(defaultLimit, maxLimit, handler) {
        return function handleWithPagination(req) {
            return handler(req, getPagination(req.query, defaultLimit, maxLimit));
        };
    }

    function pagedCacheKey(prefix, defaultLimit, maxLimit, extraPartsFn) {
        return function buildPagedCacheKey(req) {
            const pagination = getPagination(req.query, defaultLimit, maxLimit);
            const extraParts = typeof extraPartsFn === "function" ? extraPartsFn(req) : [];
            return getCacheKey([prefix].concat(extraParts, [pagination.limit, pagination.page]));
        };
    }

    function pageBounds(pagination) { return [pagination.page * pagination.limit, (pagination.page + 1) * pagination.limit]; }

    function addressQuery(parsed, withPaymentIdSql, withoutPaymentIdSql) {
        return parsed.paymentId === undefined
            ? [withoutPaymentIdSql, [parsed.address]]
            : [withPaymentIdSql, [parsed.address, parsed.paymentId]];
    }

    function sortMapped(rows, mapper) {
        return sortByTsDesc(rows.map(mapper), support);
    }

    function cachedRoute(path, ttlMs, scope, key, handler, fallback) {
        return { path: path, ttlMs: ttlMs, scope: scope, key: key, handler: handler, fallback: fallback };
    }

    function poolTypeOnly(handler) { return function poolTypeHandler(req) { return req.params.pool_type === "pplns" ? handler(req) : INVALID_POOL_TYPE; }; }

    function cachePoolStats(cacheKey, extra) {
        const value = getCacheValue(cacheKey, {});
        const output = Object.assign({}, value, extra);
        delete output.minerHistory;
        delete output.hashHistory;
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

    async function getPoolPayments(limit, page) {
        const rows = await query("SELECT * FROM transactions ORDER BY id DESC LIMIT ? OFFSET ?", [limit, page * limit]);
        if (rows.length === 0) return [];

        return sortMapped(rows, function build(txnRow) {
            return {
                id: txnRow.id,
                hash: txnRow.transaction_hash,
                mixins: txnRow.mixin,
                payees: txnRow.payees,
                fee: txnRow.fees,
                value: txnRow.xmr_amt,
                ts: new Date(txnRow.submitted_time).getTime()
            };
        });
    }

    async function getRecentPayments(limit, page) {
        const rows = await query("SELECT * FROM transactions ORDER BY id DESC LIMIT ? OFFSET ?", [limit, page * limit]);
        if (rows.length === 0) return [];

        let poolTypes = {};
        if (poolList.length === 1) {
            poolTypes = rows.reduce(function assign(result, row) {
                result[row.id] = normalizePoolType(poolList[0]);
                return result;
            }, {});
        } else {
            const ids = rows.map(function map(row) { return row.id; });
            const typeRows = await query(
                "SELECT transaction_id, MIN(pool_type) AS pool_type FROM payments WHERE transaction_id IN (" +
                createPlaceholders(ids.length) + ") GROUP BY transaction_id",
                ids
            );
            poolTypes = typeRows.reduce(function assign(result, row) {
                result[row.transaction_id] = normalizePoolType(row.pool_type);
                return result;
            }, {});
        }

        return sortMapped(rows, function build(row) {
            return {
                id: row.id,
                hash: row.transaction_hash,
                mixins: row.mixin,
                payees: row.payees,
                fee: row.fees,
                value: row.xmr_amt,
                ts: new Date(row.submitted_time).getTime(),
                pool_type: poolTypes[row.id] || "?"
            };
        });
    }

    async function getMinerPayments(addressParam, limit, page) {
        const parsed = parseAddress(addressParam);
        const paymentQuery = addressQuery(
            parsed,
            "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM payments WHERE payment_address = ? AND payment_id = ? ORDER BY paid_time DESC LIMIT ? OFFSET ?",
            "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM payments WHERE payment_address = ? AND payment_id IS NULL ORDER BY paid_time DESC LIMIT ? OFFSET ?"
        );
        const rows = await query(paymentQuery[0], paymentQuery[1].concat([limit, page * limit]));
        if (rows.length === 0) return [];

        const ids = Array.from(new Set(rows.map(function map(row) { return row.transaction_id; })));
        const txnRows = await query(
            "SELECT id, transaction_hash, mixin FROM transactions WHERE id IN (" + createPlaceholders(ids.length) + ") ORDER BY id DESC",
            ids
        );
        const txMap = txnRows.reduce(function assign(result, row) {
            result[row.id] = row;
            return result;
        }, {});
        const response = [];
        for (const row of rows) {
            const txn = txMap[row.transaction_id];
            if (!txn) continue;
            response.push({
                pt: normalizePoolType(row.pool_type),
                ts: Math.ceil(row.ts),
                amount: row.amt,
                txnHash: txn.transaction_hash,
                mixin: txn.mixin
            });
        }
        return sortByTsDesc(response, support);
    }

    async function getMinerBlockPayments(addressParam, limit, page) {
        const parsed = parseAddress(addressParam);
        const blocks = await query(
            "SELECT * FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 7 DAY) ORDER BY id DESC LIMIT ? OFFSET ?",
            [limit, page * limit]
        );
        if (blocks.length === 0) return [];

        const hexes = blocks.map(function map(row) { return row.hex; });
        const balanceQuery = addressQuery(
            parsed,
            "SELECT hex, amount FROM block_balance WHERE payment_address = ? AND payment_id = ? AND hex IN (" + createPlaceholders(hexes.length) + ")",
            "SELECT hex, amount FROM block_balance WHERE payment_address = ? AND (payment_id IS NULL OR payment_id = '') AND hex IN (" + createPlaceholders(hexes.length) + ")"
        );
        const shares = await query(balanceQuery[0], balanceQuery[1].concat(hexes));
        const shareMap = shares.reduce(function assign(result, row) {
            result[row.hex] = row.amount;
            return result;
        }, {});

        return sortMapped(blocks, function build(row) {
            const share = row.hex in shareMap ? shareMap[row.hex] : 0;
            return {
                id: row.id,
                ts: new Date(row.paid_time).getTime() / 1000,
                ts_found: new Date(row.found_time).getTime() / 1000,
                port: row.port,
                hash: row.hex,
                value_percent: share * 100,
                value: share * row.amount / config.general.sigDivisor
            };
        });
    }

    const addressBase58Prefix = safeDecodeAddress(blockTemplate, config && config.pool ? config.pool.address : "");
    const routes = [
        cachedRoute("/config", 5 * 60 * 1000, "config", staticKey("config"), function configRoute() {
            return {
                pplns_fee: config.payout.pplnsFee,
                min_wallet_payout: config.payout.walletMin * config.general.sigDivisor,
                min_exchange_payout: config.payout.exchangeMin * config.general.sigDivisor,
                dev_donation: config.payout.devDonation,
                pool_dev_donation: config.payout.poolDevDonation,
                maturity_depth: config.payout.blocksRequired,
                min_denom: config.payout.denom * config.general.sigDivisor,
                coin_code: config.general.coinCode,
                payout_policy: payoutPolicy()
            };
        }),
        cachedRoute("/pool/address_type/:address", 10 * 1000, "pool address type",
            paramKey("pool-address", "address"),
            function addressTypeRoute(req) {
                const decoded = safeDecodeAddress(blockTemplate, req.params.address);
                return decoded !== null && decoded === addressBase58Prefix ? { valid: true, address_type: config.general.coinCode } : { valid: false };
            }
        ),
        cachedRoute("/pool/motd", 60 * 1000, "pool motd", staticKey("pool-motd"), function motdRoute() {
            const news = getCacheValue("news", {});
            return { created: news.created, subject: news.subject, body: news.body };
        }),
        cachedRoute("/pool/stats", 10 * 1000, "pool stats", staticKey("pool-stats"), function poolStatsRoute() {
            return { pool_list: poolList, pool_statistics: cachePoolStats("pool_stats_global"), last_payment: getCacheValue("lastPaymentCycle", 0) || 0 };
        }),
        cachedRoute("/pool/chart/hashrate", 10 * 1000, "pool chart hashrate", staticKey("pool-chart-hashrate"), function hashrateRoute() {
            return getHashHistory("global_stats");
        }),
        cachedRoute("/pool/chart/miners", 10 * 1000, "pool chart miners", staticKey("pool-chart-miners"), function minersRoute() {
            return getCacheArray("global_stats", "minerHistory");
        }),
        cachedRoute("/pool/chart/hashrate/:pool_type", 10 * 1000, "pool chart hashrate pool type",
            paramKey("pool-chart-hashrate", "pool_type"),
            poolTypeOnly(function poolHashrateTypeRoute() { return getHashHistory("pplns_stats"); })
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
            pagedCacheKey("pool-blocks", 25, undefined, function poolBlockParts(req) { return [req.params.pool_type]; }),
            withPagination(25, undefined, function poolBlocksRoute(req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getBlockList(req.params.pool_type, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/altblocks/:pool_type", 10 * 1000, "pool altblocks",
            pagedCacheKey("pool-altblocks", 25, undefined, function poolAltBlockParts(req) { return [req.params.pool_type]; }),
            withPagination(25, undefined, function poolAltBlocksRoute(req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getAltBlockList(req.params.pool_type, null, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/blocks", 10 * 1000, "pool blocks all", pagedCacheKey("pool-blocks-all", 25),
            withPagination(25, undefined, function poolBlocksAllRoute(req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getBlockList(null, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/altblocks", 10 * 1000, "pool altblocks all", pagedCacheKey("pool-altblocks-all", 25),
            withPagination(25, undefined, function poolAltBlocksAllRoute(req, pagination) {
                const bounds = pageBounds(pagination);
                return database.getAltBlockList(null, null, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/coin_altblocks/:coin_port", 10 * 1000, "pool coin altblocks",
            pagedCacheKey("pool-coin-altblocks", 25, undefined, function poolCoinAltBlockParts(req) { return [req.params.coin_port]; }),
            withPagination(25, undefined, function poolCoinAltBlocksRoute(req, pagination) {
                const coinPort = normalizeInteger(req.params.coin_port, 0, 1);
                if (coinPort === 0) return [];
                const bounds = pageBounds(pagination);
                return database.getAltBlockList(null, coinPort, bounds[0], bounds[1]);
            })
        ),
        cachedRoute("/pool/payments/:pool_type", 60 * 1000, "pool payments",
            pagedCacheKey("pool-payments", 10, undefined, function poolPaymentParts(req) { return [req.params.pool_type]; }),
            withPagination(10, undefined, function poolPaymentsRoute(req, pagination) {
                return req.params.pool_type === "pplns" ? getPoolPayments(pagination.limit, pagination.page) : INVALID_POOL_TYPE;
            }),
            { error: "Issue getting pool payments" }
        ),
        cachedRoute("/pool/payments", 60 * 1000, "pool payments all", pagedCacheKey("pool-payments-all", 10),
            withPagination(10, undefined, function poolPaymentsAllRoute(req, pagination) {
                return getRecentPayments(pagination.limit, pagination.page);
            }),
            { error: "Issue getting pool payments" }
        ),
        cachedRoute("/network/stats", 10 * 1000, "network stats", staticKey("network-stats"), function networkStatsRoute() { return getCacheValue("networkBlockInfo", {}); }),
        cachedRoute("/miner/:address/identifiers", 10 * 1000, "miner identifiers", paramKey("miner-identifiers", "address"), function minerIdentifiersRoute(req) { return getIdentifiers(req.params.address); }),
        cachedRoute("/miner/:address/payments", 60 * 1000, "miner payments", pagedCacheKey("miner-payments", 25, undefined, function minerPaymentParts(req) { return [req.params.address]; }),
            withPagination(25, undefined, function minerPaymentsRoute(req, pagination) { return getMinerPayments(req.params.address, pagination.limit, pagination.page); }),
            { error: "Issue getting miner payments" }
        ),
        cachedRoute("/miner/:address/block_payments", 60 * 1000, "miner block payments", pagedCacheKey("miner-block-payments", 10, 100, function minerBlockPaymentParts(req) { return [req.params.address]; }),
            withPagination(10, 100, function minerBlockPaymentsRoute(req, pagination) { return getMinerBlockPayments(req.params.address, pagination.limit, pagination.page); }),
            { error: "Issue getting block payments" }
        ),
        cachedRoute("/miner/:address/stats/allWorkers", 10 * 1000, "miner stats all workers", paramKey("miner-stats-all", "address"), function minerStatsAllRoute(req) { return getAllWorkerStats(req.params.address); }),
        cachedRoute("/miner/:address/stats/:identifier", 10 * 1000, "miner stats", paramKey("miner-stats", "address", "identifier"), function minerStatsRoute(req) { return getWorkerStatsEntry(req.params.address + "_" + req.params.identifier, req.params.identifier); }),
        cachedRoute("/miner/:address/chart/hashrate", 10 * 1000, "miner chart hashrate", paramKey("miner-chart-hashrate", "address"), function minerHashrateRoute(req) { return getHashHistory("history:" + req.params.address); }),
        cachedRoute("/miner/:address/chart/hashrate/allWorkers", 10 * 1000, "miner chart hashrate all workers", paramKey("miner-chart-hashrate-all", "address"), function minerHashrateAllRoute(req) { return getAllWorkerHashCharts(req.params.address); }),
        cachedRoute("/miner/:address/chart/hashrate/:identifier", 10 * 1000, "miner chart hashrate worker", paramKey("miner-chart-hashrate", "address", "identifier"), function minerHashrateWorkerRoute(req) { return getHashHistory("history:" + req.params.address + "_" + req.params.identifier); }),
        cachedRoute("/miner/:address/stats", 60 * 1000, "miner stats address", paramKey("miner-stats-address", "address"), function minerAddressStatsRoute(req) { return getAddressStats(req.params.address); })
    ];

    for (const route of routes) {
        registerCachedGet(route.path, route.ttlMs, route.scope, route.key, route.handler, route.fallback);
    }
};
