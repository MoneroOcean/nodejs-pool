"use strict";
const cluster = require("cluster");
const express = require("express");
const os = require("os");
const { createConsoleLogger, formatThreadName } = require("./common/logging.js");
const isPrimaryProcess = require("./common/is_primary_process.js");

const blockTemplateLib = require("node-blocktemplate");

const registerAccountRoutes = require("./api/account");
const registerPublicRoutes = require("./api/public");

/** @typedef {{worker?: ClusterWorker, isPrimary: boolean, isMaster: boolean, fork: () => ClusterWorker, disconnect: (callback?: () => void) => void, on: (eventName: string, listener: ClusterListener) => void, off?: (eventName: string, listener: ClusterListener) => void, removeListener: (eventName: string, listener: ClusterListener) => void}} ClusterApi */
/** @typedef {import("node:cluster").Worker} ClusterWorker */
/** @typedef {import("node:http").Server} HttpServer */
/** @typedef {import("../types/runtime").PoolConfig} PoolConfig */
/** @typedef {import("../types/runtime").DatabaseRuntime} DatabaseRuntime */
/** @typedef {import("../types/runtime").SqlPool} SqlPool */
/** @typedef {import("../types/runtime").SqlParam} SqlParam */
/** @typedef {import("../types/runtime").SupportRuntime} SupportRuntime */
/** @typedef {import("../types/runtime").ExpressApp} ExpressApp */
/** @typedef {import("../types/runtime").ExpressRequest} ExpressRequest */
/** @typedef {import("../types/runtime").ExpressResponse} ExpressResponse */
/** @typedef {import("../types/runtime").ExpressNext} ExpressNext */
/** @typedef {import("../types/runtime").ExpressError} ExpressError */

const DEFAULT_PORT = 8001;
const SUMMARY_INTERVAL_MS = 60 * 1000;
const JSON_LIMIT = "32kb";
const URLENCODED_LIMIT = "16kb";
const URLENCODED_PARAMETER_LIMIT = 20;
const RESPONSE_CACHE_MAX_ENTRIES = 256;
const RESPONSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
// Sentinel a route handler returns to signal it already wrote the response, so the
// registration helpers skip auto-serializing the return value.
const NO_RESPONSE = Symbol("no-response");
const METRIC_TEMPLATE = {
    requests: 0,
    ok: 0,
    status400: 0,
    status401: 0,
    status403: 0,
    status413: 0,
    other4xx: 0,
    status500: 0,
    other5xx: 0,
    cacheHits: 0,
    cacheMisses: 0,
    dbQueries: 0,
    dbErrors: 0,
    bodyTooLarge: 0,
    latencyTotalMs: 0,
    latencyMaxMs: 0
};
/** @type {Array<[keyof Metrics, string]>} */
const FAILURE_FIELDS = [
    ["status400", "400"],
    ["status401", "401"],
    ["status403", "403"],
    ["status413", "413"],
    ["other4xx", "4xx"],
    ["status500", "500"],
    ["other5xx", "5xx"]
];

/** @typedef {typeof METRIC_TEMPLATE} Metrics */
/** @typedef {{body: string, size: number, expiresAt: number}} CacheEntry */
/** @typedef {{maxEntries: number, maxBytes: number, now: () => number}} ResponseCacheOptions */
/** @typedef {{get: (key: string) => string | null, set: (key: string, ttlMs: number, body: string) => boolean, clear: () => void}} ResponseCache */
/** @typedef {{config?: PoolConfig, cluster?: ClusterApi, os?: typeof os, mysql?: SqlPool, database?: DatabaseRuntime, support?: SupportRuntime, blockTemplate?: typeof blockTemplateLib, cnUtil?: typeof blockTemplateLib, now?: () => number, summaryIntervalMs?: number, clusterEnabled?: boolean, responseCacheMaxEntries?: number, responseCacheMaxBytes?: number, port?: number, host?: string, numWorkers?: number}} ApiOptions */
/** @typedef {{opts: ApiOptions, clusterApi: ClusterApi, osApi: typeof os, mysql: SqlPool, database: DatabaseRuntime, support: SupportRuntime, config: PoolConfig, blockTemplate: typeof blockTemplateLib, now: () => number, summaryIntervalMs: number, clusterEnabled: boolean, poolList: string[]}} ApiRuntimeDeps */
/** @typedef {{path: string, ttlMs: number, scope: string, key: (request: ExpressRequest) => string, handler: RouteHandler, fallback?: unknown}} CachedRoute */
/** @typedef {(request: ExpressRequest, response: ExpressResponse) => unknown | Promise<unknown>} RouteHandler */
/** @typedef {(...args: never[]) => void} ClusterListener */
/** @typedef {{eventName: string, listener: ClusterListener}} StoredClusterListener */
/** @typedef {{attachedWorkers: Set<ClusterWorker>, clusterListeners: StoredClusterListener[], metrics: Metrics, server: HttpServer | null, started: boolean, summaryInterval: NodeJS.Timeout | null}} ApiState */
/** @typedef {{start: () => ApiRuntime, stop: () => Promise<void>, address: () => ReturnType<HttpServer["address"]>}} ApiRuntime */

/** @param {unknown} error @returns {string} */
function formatError(error) { return error instanceof Error && error.message ? error.message : String(error); }

/** @returns {Metrics} */
function createMetrics() { return Object.assign({}, METRIC_TEMPLATE); }

/** @param {ResponseCacheOptions} options @returns {ResponseCache} */
function createResponseCache(options) {
    /** @type {Map<string, CacheEntry>} */
    const entries = new Map();
    const maxEntries = options.maxEntries;
    const maxBytes = options.maxBytes;
    const now = options.now;
    let totalBytes = 0;

    /** @param {string} key @returns {void} */
    function deleteKey(key) {
        const entry = entries.get(key);
        if (!entry) return;
        totalBytes -= entry.size;
        entries.delete(key);
    }

    /** @param {number} timeNow @returns {void} */
    function pruneExpired(timeNow) {
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= timeNow) deleteKey(key);
        }
    }

    return {
        /** @param {string} key @returns {string | null} */
        get(key) {
            const entry = entries.get(key);
            if (!entry) return null;

            const timeNow = now();
            if (entry.expiresAt <= timeNow) {
                deleteKey(key);
                return null;
            }

            // Re-insert to move this key to the newest end (Map iteration is insertion-ordered, giving LRU eviction).
            entries.delete(key);
            entries.set(key, entry);
            return entry.body;
        },

        /** @param {string} key @param {number} ttlMs @param {string} body @returns {boolean} */
        set(key, ttlMs, body) {
            if (typeof body !== "string" || maxEntries <= 0 || maxBytes <= 0) return false;

            const timeNow = now();
            const size = Buffer.byteLength(body);
            deleteKey(key);
            pruneExpired(timeNow);
            if (size > maxBytes) return false;

            while (entries.size >= maxEntries || totalBytes + size > maxBytes) {
                const oldest = entries.keys().next();
                if (oldest.done) break;
                deleteKey(oldest.value);
            }
            if (entries.size >= maxEntries || totalBytes + size > maxBytes) return false;

            entries.set(key, { body, size, expiresAt: timeNow + ttlMs });
            totalBytes += size;
            return true;
        },

        /** @returns {void} */
        clear() {
            entries.clear();
            totalBytes = 0;
        }
    };
}

/** @param {PoolConfig | undefined} config @returns {string[]} */
function getEnabledPoolList(config) {
    return config && config.pplns && config.pplns.enable === true ? ["pplns"] : [];
}

/** @param {ApiOptions | undefined} options @returns {ApiRuntimeDeps} */
function resolveApiRuntimeDeps(options) {
    /** @type {ApiOptions} */
    const opts = options || {};
    const config = opts.config || global.config;
    return {
        opts,
        // The CommonJS cluster export is the runtime singleton; keep its small
        // surface explicit because Node's declaration models the ESM default.
        clusterApi: /** @type {ClusterApi} */ (/** @type {unknown} */ (opts.cluster || cluster)),
        osApi: opts.os || os,
        mysql: opts.mysql || global.mysql,
        database: opts.database || global.database,
        support: opts.support || global.support,
        config,
        blockTemplate: opts.blockTemplate || opts.cnUtil || blockTemplateLib,
        now: opts.now || Date.now,
        summaryIntervalMs: opts.summaryIntervalMs || SUMMARY_INTERVAL_MS,
        clusterEnabled: opts.clusterEnabled !== false,
        poolList: getEnabledPoolList(config)
    };
}

/** @param {ApiOptions} [options] @returns {ApiRuntime} */
function createApiRuntime(options) {
    const {
        opts,
        clusterApi,
        osApi,
        mysql,
        database,
        support,
        config,
        blockTemplate,
        now,
        summaryIntervalMs,
        clusterEnabled,
        poolList
    } = resolveApiRuntimeDeps(options);
    const isPrimary = clusterEnabled ? isPrimaryProcess(clusterApi) : true;
    const app = express();
    const cache = createResponseCache({
        maxEntries: opts.responseCacheMaxEntries || RESPONSE_CACHE_MAX_ENTRIES,
        maxBytes: opts.responseCacheMaxBytes || RESPONSE_CACHE_MAX_BYTES,
        now
    });
    /** @type {ApiState} */
    const state = {
        attachedWorkers: new Set(),
        clusterListeners: [],
        metrics: createMetrics(),
        server: null,
        started: false,
        summaryInterval: null
    };

    function threadName() {
        return formatThreadName({
            single: !clusterEnabled,
            primary: clusterEnabled && isPrimary,
            workerId: clusterApi.worker && clusterApi.worker.id,
            pid: process.pid
        });
    }
    const logger = createConsoleLogger(console, threadName);

    /** @param {string} scope @param {unknown} error @returns {void} */
    function logRouteError(scope, error) {
        logger.logError(`API ${  scope  } failed`, formatError(error));
    }

    /** @param {string} scope @param {unknown} error @returns {void} */
    function logWarning(scope, error) {
        logger.logError(`API ${  scope}`, formatError(error));
    }

    /** @param {number} statusCode @returns {void} */
    function recordStatus(statusCode) {
        if (statusCode >= 200 && statusCode < 300) {
            state.metrics.ok += 1;
            return;
        }
        if (statusCode === 400) state.metrics.status400 += 1;
        else if (statusCode === 401) state.metrics.status401 += 1;
        else if (statusCode === 403) state.metrics.status403 += 1;
        else if (statusCode === 413) state.metrics.status413 += 1;
        else if (statusCode >= 400 && statusCode < 500) state.metrics.other4xx += 1;
        else if (statusCode === 500) state.metrics.status500 += 1;
        else if (statusCode >= 500) state.metrics.other5xx += 1;
    }

    function logSummary() {
        const metrics = state.metrics;
        if (!Object.values(metrics).some(function hasActivity(value) { return value !== 0; })) return;

        const avgLatencyMs = metrics.requests === 0 ? 0 : Math.round(metrics.latencyTotalMs / metrics.requests);
        const failures = FAILURE_FIELDS.reduce(function collect(result, entry) {
            if (metrics[entry[0]] > 0) result.push(`${entry[1]  }:${  metrics[entry[0]]}`);
            return result;
        }, /** @type {string[]} */ ([]));
        logger.logInfo("API summary", {
            req: metrics.requests,
            ok: metrics.ok,
            fail: failures.length === 0 ? "0" : failures.join(","),
            cache: `${metrics.cacheHits  }/${  metrics.cacheMisses}`,
            db: `${metrics.dbQueries  }q/${  metrics.dbErrors  }err`,
            body: metrics.bodyTooLarge,
            avg: `${avgLatencyMs  }ms`,
            max: `${metrics.latencyMaxMs  }ms`
        });
        state.metrics = createMetrics();
    }

    /** @template T @param {string} key @param {T} fallback @returns {T | unknown} */
    function getCacheValue(key, fallback) {
        if (!database || typeof database.getCache !== "function") return fallback;
        const value = database.getCache(key);
        // database.getCache returns false on a miss or read error; a stored JSON null
        // would otherwise crash callers that index/iterate the result, so treat both
        // false and null/undefined as absent.
        return value === false || value == null ? fallback : value;
    }

    /** @param {ExpressResponse} res @param {number} statusCode @param {unknown} payload @returns {typeof NO_RESPONSE} */
    function sendJson(res, statusCode, payload) { res.status(statusCode).json(payload); return NO_RESPONSE; }

    /** @param {ExpressResponse} res @param {number} statusCode @param {string} body @returns {typeof NO_RESPONSE} */
    function sendJsonBody(res, statusCode, body) { res.status(statusCode).type("application/json").send(body); return NO_RESPONSE; }

    /** @param {string} sql @param {readonly SqlParam[] | undefined} [params] @returns {Promise<import("../types/runtime").SqlRows>} */
    async function query(sql, params) {
        // Every bound value must be a scalar. The mysql driver expands a plain object
        // param into `col = val` SQL fragments and an array into a value list, so an
        // un-coerced request field (object/array) could change a statement's semantics
        // (extra SET assignments, mass WHERE matches). Reject those before they reach SQL.
        if (Array.isArray(params)) {
            for (const param of params) {
                if (param !== null && typeof param === "object" && !Buffer.isBuffer(param) && !(param instanceof Date)) {
                    throw new Error("Invalid SQL parameter type");
                }
            }
        }
        state.metrics.dbQueries += 1;
        try {
            return await mysql.query(sql, params);
        } catch (error) {
            state.metrics.dbErrors += 1;
            throw error;
        }
    }

    /** @param {string} scope @param {ExpressResponse} res @param {unknown} error @param {unknown | ((error: unknown) => unknown) | undefined} fallback @returns {typeof NO_RESPONSE} */
    function handleRouteError(scope, res, error, fallback) {
        logRouteError(scope, error);
        if (res.headersSent) return NO_RESPONSE;
        const payload = typeof fallback === "function" ? fallback(error) : fallback;
        res.json(typeof payload === "undefined" ? {} : payload);
        return NO_RESPONSE;
    }

    /** @param {ExpressApp} target @param {"get" | "post"} method @param {string} path @param {string} scope @param {RouteHandler} handler @param {unknown | ((error: unknown) => unknown) | undefined} [fallback] @returns {void} */
    function registerJsonRoute(target, method, path, scope, handler, fallback) {
        const register = method === "get" ? target.get.bind(target) : target.post.bind(target);
        register(path, async function onRoute(req, res) {
            try {
                const result = await handler(req, res);
                if (!res.headersSent && result !== NO_RESPONSE && typeof result !== "undefined") res.json(result);
            } catch (error) {
                handleRouteError(scope, res, error, fallback);
            }
        });
    }

    /** @param {string} path @param {number} ttlMs @param {string} scope @param {(request: ExpressRequest) => string} keyFn @param {RouteHandler} handler @param {unknown | ((error: unknown) => unknown) | undefined} [fallback] @returns {void} */
    function registerCachedGet(path, ttlMs, scope, keyFn, handler, fallback) {
        app.get(path, async function onRoute(req, res) {
            const cacheKey = keyFn(req);
            const cached = cacheKey ? cache.get(cacheKey) : null;
            if (cached !== null) {
                state.metrics.cacheHits += 1;
                sendJsonBody(res, 200, cached);
                return;
            }

            if (cacheKey) state.metrics.cacheMisses += 1;
            try {
                const payload = await handler(req, res);
                if (res.headersSent || payload === NO_RESPONSE || typeof payload === "undefined") return;
                const body = JSON.stringify(payload);
                if (cacheKey) cache.set(cacheKey, ttlMs, body);
                sendJsonBody(res, 200, body);
            } catch (error) {
                handleRouteError(scope, res, error, fallback);
            }
        });
    }

    app.disable("x-powered-by");
    app.use(function trackRequest(_req, res, next) {
        const startedAt = now();
        res.on("finish", function onFinish() {
            state.metrics.requests += 1;
            recordStatus(res.statusCode);
            const latencyMs = Math.max(0, now() - startedAt);
            state.metrics.latencyTotalMs += latencyMs;
            if (latencyMs > state.metrics.latencyMaxMs) state.metrics.latencyMaxMs = latencyMs;
        });
        next();
    });
    app.use(function cors(req, res, next) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            res.sendStatus(204);
            return;
        }
        next();
    });
    app.use(express.urlencoded({
        extended: false,
        limit: URLENCODED_LIMIT,
        parameterLimit: URLENCODED_PARAMETER_LIMIT
    }));
    app.use(express.json({ limit: JSON_LIMIT }));

    const sharedContext = {
        core: {
            config,
            database,
            getCacheValue,
            now,
            query,
            support
        },
        http: {
            app,
            registerCachedGet,
            registerJsonRoute,
            sendJson
        }
    };

    registerPublicRoutes(Object.assign({
        blockTemplate,
        poolList,
        cnUtil: blockTemplate
    }, sharedContext));
    registerAccountRoutes(sharedContext);

    app.use(/** @param {ExpressError} error @param {ExpressRequest} _req @param {ExpressResponse} res @param {ExpressNext} next */ function parserErrorHandler(error, _req, res, next) {
        if (!error) return next();
        if (res.headersSent) return next(error);
        if (error.type === "entity.too.large" || error.status === 413) {
            state.metrics.bodyTooLarge += 1;
            return res.status(413).json({ error: "Request body too large" });
        }
        logWarning("parser rejected request body", error);
        res.status(400).json({ error: "Invalid request body" });
    });

    /** @returns {void} */
    function listenServer() {
        if (state.server !== null) return;
        const listenPort = opts.port ?? DEFAULT_PORT;
        const host = Object.prototype.hasOwnProperty.call(opts, "host") ? opts.host : undefined;
        const onListen = function onListen() {
            const address = state.server ? state.server.address() : null;
            const hostLabel = address && typeof address === "object" && address.address ? address.address : (typeof host === "string" && host.length > 0 ? host : "0.0.0.0");
            const portLabel = address && typeof address === "object" && typeof address.port === "number" ? address.port : listenPort;
            logger.logInfo("Listen", { service: "api", host: hostLabel, port: portLabel });
        };
        state.server = host === undefined
            ? app.listen(listenPort, onListen)
            : app.listen(listenPort, host, onListen);
    }

    /** @param {ClusterWorker} worker @returns {void} */
    function attachWorker(worker) {
        state.attachedWorkers.add(worker);
    }

    /** @param {ClusterWorker} worker @returns {void} */
    function detachWorker(worker) {
        state.attachedWorkers.delete(worker);
    }

    /** @param {string} eventName @param {ClusterListener} listener @returns {void} */
    function addClusterListener(eventName, listener) {
        clusterApi.on(eventName, listener);
        state.clusterListeners.push({ eventName, listener });
    }

    /** @returns {Promise<void>} */
    function closeServer() {
        const server = state.server;
        if (server === null) return Promise.resolve();
        return new Promise(function onClose(resolve) {
            server.close(function closed() {
                if (state.server === server) state.server = null;
                resolve();
            });
        });
    }

    /** @returns {Promise<void>} */
    function disconnectWorkers() {
        if (!clusterEnabled || !isPrimary || typeof clusterApi.disconnect !== "function") return Promise.resolve();
        return new Promise(function onDisconnect(resolve) {
            try {
                clusterApi.disconnect(resolve);
            } catch (_error) {
                resolve();
            }
        });
    }

    return {
        start() {
            if (state.started) return this;
            state.started = true;
            if (database) database.thread_id = threadName();

            if (!clusterEnabled || !isPrimary) {
                state.summaryInterval = setInterval(logSummary, summaryIntervalMs);
                if (typeof state.summaryInterval.unref === "function") state.summaryInterval.unref();
            }

            if (!clusterEnabled) {
                listenServer();
                return this;
            }

            if (isPrimary) {
                const numWorkers = opts.numWorkers || osApi.cpus().length;
                logger.logInfo("IMPORTANT: Cluster start", { workers: numWorkers });
                for (let index = 0; index < numWorkers; ++index) attachWorker(clusterApi.fork());
                addClusterListener("online", /** @param {ClusterWorker} worker */ function onOnline(worker) {
                    logger.logInfo("Worker online", { pid: worker.process.pid });
                });
                addClusterListener("exit", /** @param {ClusterWorker} worker @param {number} code @param {string} signal */ function onExit(worker, code, signal) {
                    detachWorker(worker);
                    logger.logError("Worker exit", { pid: worker.process.pid, code, signal });
                    if (!state.started) return;
                    attachWorker(clusterApi.fork());
                });
                return this;
            }

            listenServer();
            return this;
        },

        async stop() {
            if (!state.started) return;
            state.started = false;
            if (state.summaryInterval !== null) {
                clearInterval(state.summaryInterval);
                state.summaryInterval = null;
            }
            cache.clear();
            await closeServer();
            await disconnectWorkers();
            for (const worker of state.attachedWorkers) detachWorker(worker);
            state.attachedWorkers.clear();
            for (const listener of state.clusterListeners) {
                if (!clusterApi || !listener.listener) continue;
                if (typeof clusterApi.off === "function") clusterApi.off(listener.eventName, listener.listener);
                else clusterApi.removeListener(listener.eventName, listener.listener);
            }
            state.clusterListeners.length = 0;
        },

        address() {
            return state.server ? state.server.address() : null;
        }
    };
}

const runtime = global.__apiAutostart === false ? null : createApiRuntime();
if (runtime) runtime.start();

/** @type {Partial<ApiRuntime> & {createApiRuntime: typeof createApiRuntime}} */
const exported = { createApiRuntime };
if (runtime) {
    exported.start = runtime.start;
    exported.stop = runtime.stop;
    exported.address = runtime.address;
}
module.exports = exported;
