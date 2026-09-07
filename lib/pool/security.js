"use strict";

/** @typedef {import("../../types/runtime").PoolConfig} PoolConfig */

/**
 * @typedef {object} SecurityConfig
 * @property {number} socketAuthTimeoutMs
 * @property {number} tlsHandshakeTimeoutMs
 * @property {number} minerFirstShareTimeoutMs
 * @property {number} maxConnectionsPerIP
 * @property {number} maxConnectionsPerSubnet
 * @property {number} loginRateLimitPerSecond
 * @property {number} loginRateLimitBurst
 * @property {number} loginRateLimitLoopbackPerSecond
 * @property {number} loginRateLimitLoopbackBurst
 * @property {number} submitRateLimitPerSecond
 * @property {number} submitRateLimitBurst
 * @property {number} keepaliveRateLimitPerSecond
 * @property {number} keepaliveRateLimitBurst
 * @property {number} jobRequestRateLimitPerSecond
 * @property {number} jobRequestRateLimitBurst
 * @property {number} rpcRateLimitBucketIdleMs
 * @property {number} rpcRateLimitBucketMaxEntries
 * @property {number} protocolErrorLimit
 * @property {number} invalidJobIdLimitBeforeShare
 */

/** @typedef {{tokens: number, lastRefillAt: number}} RateBucket */
/** @typedef {Map<string, RateBucket>} RateBuckets */

/**
 * @typedef {object} MinerActivity
 * @property {number|undefined} [lastProtocolActivity]
 * @property {number|undefined} [lastValidShareTimeMs]
 * @property {number|undefined} [lastContact]
 */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function getPoolNumber(key, fallback) {
    const value = global.config && global.config.pool ? global.config.pool[key] : undefined;
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Collapse equivalent address forms (IPv4-mapped IPv6 and IPv6 loopback) to a
// canonical IPv4 string so per-IP/subnet limits and rate buckets key consistently.
/** @param {unknown} ip @returns {string} */
function normalizeRemoteAddress(ip) {
    if (typeof ip !== "string") return "";
    const normalized = ip.toLowerCase();
    if (normalized.startsWith("::ffff:")) return normalized.substring(7);
    if (normalized === "::1") return "127.0.0.1";
    return normalized;
}

/** @param {unknown} ip @returns {boolean} */
function isLoopbackAddress(ip) {
    return normalizeRemoteAddress(ip) === "127.0.0.1";
}

/** @param {unknown} ip @returns {string} */
function getSubnet24(ip) {
    const normalized = normalizeRemoteAddress(ip);
    if (!IPV4_RE.test(normalized)) return normalized;
    const parts = normalized.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** @returns {SecurityConfig} */
function getPoolSecurityConfig() {
    const socketAuthTimeoutMs = getPoolNumber("socketAuthTimeout", 15) * 1000;
    // TLS handshakes happen before the application-level auth timer can be
    // installed. Keep the pre-auth phase bounded independently of the auth
    // timeout so an unusually long socketAuthTimeout cannot pin TLS state.
    const tlsHandshakeTimeoutMs = Math.max(1000, Math.min(socketAuthTimeoutMs, 30 * 1000));
    return {
        socketAuthTimeoutMs,
        tlsHandshakeTimeoutMs,
        minerFirstShareTimeoutMs: getPoolNumber("minerFirstShareTimeout", 600) * 1000,
        maxConnectionsPerIP: getPoolNumber("maxConnectionsPerIP", 256),
        maxConnectionsPerSubnet: getPoolNumber("maxConnectionsPerSubnet", 1024),
        loginRateLimitPerSecond: getPoolNumber("loginRateLimitPerSecond", 5),
        loginRateLimitBurst: getPoolNumber("loginRateLimitBurst", 100),
        loginRateLimitLoopbackPerSecond: getPoolNumber("loginRateLimitLoopbackPerSecond", 100),
        loginRateLimitLoopbackBurst: getPoolNumber("loginRateLimitLoopbackBurst", 2000),
        submitRateLimitPerSecond: getPoolNumber("submitRateLimitPerSecond", 250),
        submitRateLimitBurst: getPoolNumber("submitRateLimitBurst", 5000),
        keepaliveRateLimitPerSecond: getPoolNumber("keepaliveRateLimitPerSecond", 2),
        keepaliveRateLimitBurst: getPoolNumber("keepaliveRateLimitBurst", 20),
        jobRequestRateLimitPerSecond: getPoolNumber("jobRequestRateLimitPerSecond", 5),
        jobRequestRateLimitBurst: getPoolNumber("jobRequestRateLimitBurst", 20),
        rpcRateLimitBucketIdleMs: getPoolNumber("rpcRateLimitBucketIdle", 10 * 60) * 1000,
        rpcRateLimitBucketMaxEntries: getPoolNumber("rpcRateLimitBucketMaxEntries", 20000),
        protocolErrorLimit: getPoolNumber("protocolErrorLimit", 4),
        invalidJobIdLimitBeforeShare: getPoolNumber("invalidJobIdLimitBeforeShare", 4)
    };
}

/**
 * @param {unknown} value
 * @returns {value is RateBuckets}
 */
function isRateBuckets(value) {
    return value instanceof Map;
}

/**
 * @param {unknown} rateBuckets
 * @param {number} now
 * @param {SecurityConfig} config
 * @returns {void}
 */
function pruneRateBuckets(rateBuckets, now, config) {
    if (!isRateBuckets(rateBuckets)) return;
    const idleMs = config.rpcRateLimitBucketIdleMs;
    const maxEntries = config.rpcRateLimitBucketMaxEntries;
    while (rateBuckets.size > 0) {
        const oldest = rateBuckets.keys().next();
        if (oldest.done) break;
        const oldestKey = oldest.value;
        const oldestBucket = rateBuckets.get(oldestKey);
        const expired = !oldestBucket || now - oldestBucket.lastRefillAt > idleMs;
        if (!expired && rateBuckets.size <= maxEntries) break;
        rateBuckets.delete(oldestKey);
    }
}

/**
 * @param {unknown} rateBuckets
 * @param {string} key
 * @param {number} perSecond
 * @param {number} burst
 * @param {number|undefined} now
 * @param {SecurityConfig} config
 * @returns {boolean}
 */
function consumeRateLimitToken(rateBuckets, key, perSecond, burst, now, config) {
    if (!isRateBuckets(rateBuckets) || perSecond <= 0 || burst <= 0) return true;
    const timeNow = typeof now === "number" ? now : Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket) {
        bucket = { tokens: burst, lastRefillAt: timeNow };
        rateBuckets.set(key, bucket);
        if (rateBuckets.size > config.rpcRateLimitBucketMaxEntries) pruneRateBuckets(rateBuckets, timeNow, config);
    } else {
        const elapsedSeconds = Math.max(0, (timeNow - bucket.lastRefillAt) / 1000);
        bucket.tokens = Math.min(burst, bucket.tokens + elapsedSeconds * perSecond);
        bucket.lastRefillAt = timeNow;
        // Keep Map iteration in least-recently-used order for bounded eviction.
        rateBuckets.delete(key);
        rateBuckets.set(key, bucket);
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
}

/** @param {MinerActivity|null|undefined} miner @returns {number} */
function getMinerSessionActivity(miner) {
    if (!miner) return 0;
    return Math.max(
        typeof miner.lastProtocolActivity === "number" ? miner.lastProtocolActivity : 0,
        typeof miner.lastValidShareTimeMs === "number" ? miner.lastValidShareTimeMs : 0,
        typeof miner.lastContact === "number" ? miner.lastContact : 0
    );
}

module.exports = {
    normalizeRemoteAddress,
    isLoopbackAddress,
    getSubnet24,
    getPoolSecurityConfig,
    pruneRateBuckets,
    consumeRateLimitToken,
    getMinerSessionActivity
};
