"use strict";
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function getPoolNumber(key, fallback) {
    const value = global.config && global.config.pool ? global.config.pool[key] : undefined;
    return Number.isFinite(value) ? value : fallback;
}

function normalizeRemoteAddress(ip) {
    if (typeof ip !== "string") return "";
    if (ip.startsWith("::ffff:")) return ip.substring(7);
    if (ip === "::1") return "127.0.0.1";
    return ip;
}

function getSubnet24(ip) {
    const normalized = normalizeRemoteAddress(ip);
    if (!IPV4_RE.test(normalized)) return normalized;
    const parts = normalized.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function getPoolSecurityConfig() {
    return {
        socketAuthTimeoutMs: getPoolNumber("socketAuthTimeout", 15) * 1000,
        minerFirstShareTimeoutMs: getPoolNumber("minerFirstShareTimeout", 180) * 1000,
        maxConnectionsPerIP: getPoolNumber("maxConnectionsPerIP", 256),
        maxConnectionsPerSubnet: getPoolNumber("maxConnectionsPerSubnet", 1024),
        loginRateLimitPerSecond: getPoolNumber("loginRateLimitPerSecond", 5),
        loginRateLimitBurst: getPoolNumber("loginRateLimitBurst", 100),
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

function pruneRateBuckets(rateBuckets, now, config) {
    if (!(rateBuckets instanceof Map)) return;
    const idleMs = config.rpcRateLimitBucketIdleMs;
    const maxEntries = config.rpcRateLimitBucketMaxEntries;
    for (const [key, bucket] of rateBuckets) {
        if (!bucket || now - bucket.lastRefillAt > idleMs) rateBuckets.delete(key);
    }
    if (rateBuckets.size <= maxEntries) return;

    const entries = Array.from(rateBuckets.entries()).sort(function compare(left, right) {
        return left[1].lastRefillAt - right[1].lastRefillAt;
    });
    for (let index = 0; index < entries.length - maxEntries; ++index) {
        rateBuckets.delete(entries[index][0]);
    }
}

function consumeRateLimitToken(rateBuckets, key, perSecond, burst, now, config) {
    if (!(rateBuckets instanceof Map) || perSecond <= 0 || burst <= 0) return true;
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
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
}

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
    getSubnet24,
    getPoolSecurityConfig,
    pruneRateBuckets,
    consumeRateLimitToken,
    getMinerSessionActivity
};
