"use strict";

const HISTORY_VERSION = 2;
const HISTORY_KIND = "worker-history-tiered";
const HISTORY_ENCODING = "base64-u32-f32-f32-le";
const DEFAULT_BASE_INTERVAL_SEC = 120;
const DEFAULT_TIER_RATIO = 3;
const POINT_WIDTH = 3;
const POINT_BYTES = 12;
const UINT32_MAX = 0xFFFFFFFF;

function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTimestampMs(value) {
    const timestampMs = Math.round(normalizeFiniteNumber(value, 0));
    const timestampSec = Math.round(timestampMs / 1000);
    return Math.max(0, Math.min(UINT32_MAX, timestampSec)) * 1000;
}

function normalizeHashrate(value) {
    return Math.fround(normalizeFiniteNumber(value, 0));
}

function distributeCapacity(totalPoints, tierCount) {
    const base = Math.floor(totalPoints / tierCount);
    const remainder = totalPoints % tierCount;
    const capacities = [];

    for (let index = 0; index < tierCount; ++index) {
        capacities.push(base + (index < remainder ? 1 : 0));
    }

    return capacities;
}

function calculateCoverage(capacities, baseIntervalSec, tierRatio) {
    let coverage = 0;
    for (let index = 0; index < capacities.length; ++index) {
        coverage += capacities[index] * baseIntervalSec * Math.pow(tierRatio, index);
    }
    return coverage;
}

function buildTierLayout(statsBufferLength, statsBufferHours, options) {
    options = options || {};
    const maxPoints = normalizePositiveInteger(statsBufferLength, 1);
    const baseIntervalSec = normalizePositiveInteger(options.baseIntervalSec, DEFAULT_BASE_INTERVAL_SEC);
    const tierRatio = normalizePositiveInteger(options.tierRatio, DEFAULT_TIER_RATIO);
    const targetSpanSec = Math.max(baseIntervalSec, Math.floor(normalizeFiniteNumber(statsBufferHours, 1) * 60 * 60));
    const maxTierCount = Math.max(1, Math.floor(maxPoints / tierRatio));

    let capacities = [maxPoints];
    for (let tierCount = 1; tierCount <= maxTierCount; ++tierCount) {
        const candidate = distributeCapacity(maxPoints, tierCount);
        capacities = candidate;
        if (calculateCoverage(candidate, baseIntervalSec, tierRatio) >= targetSpanSec) break;
    }

    return {
        v: HISTORY_VERSION,
        kind: HISTORY_KIND,
        maxPoints: maxPoints,
        targetSpanSec: targetSpanSec,
        baseIntervalSec: baseIntervalSec,
        tierRatio: tierRatio,
        capacities: capacities,
        intervalsSec: capacities.map(function (_capacity, index) {
            return baseIntervalSec * Math.pow(tierRatio, index);
        })
    };
}

function createEmptyTier(capacity) {
    return {
        head: 0,
        size: 0,
        buffer: Buffer.alloc(capacity * POINT_BYTES)
    };
}

function createEmptyHistory(layout) {
    return {
        v: HISTORY_VERSION,
        kind: HISTORY_KIND,
        encoding: HISTORY_ENCODING,
        baseIntervalSec: layout.baseIntervalSec,
        tierRatio: layout.tierRatio,
        capacities: layout.capacities.slice(),
        tiers: layout.capacities.map(function (capacity) {
            return createEmptyTier(capacity);
        })
    };
}

function pointOffset(slotIndex) {
    return slotIndex * POINT_BYTES;
}

function getPoint(tier, capacity, logicalIndex) {
    const slotIndex = (tier.head + logicalIndex) % capacity;
    const offset = pointOffset(slotIndex);
    return {
        ts: tier.buffer.readUInt32LE(offset) * 1000,
        hs: tier.buffer.readFloatLE(offset + 4),
        hs2: tier.buffer.readFloatLE(offset + 8)
    };
}

function setPoint(tier, capacity, logicalIndex, point) {
    const slotIndex = (tier.head + logicalIndex) % capacity;
    const offset = pointOffset(slotIndex);
    tier.buffer.writeUInt32LE(Math.round(normalizeTimestampMs(point.ts) / 1000), offset);
    tier.buffer.writeFloatLE(normalizeHashrate(point.hs), offset + 4);
    tier.buffer.writeFloatLE(normalizeHashrate(point.hs2), offset + 8);
}

function dropOldestPoints(tier, capacity, count) {
    if (count <= 0 || tier.size === 0) return;
    const removeCount = Math.min(count, tier.size);
    tier.head = (tier.head + removeCount) % capacity;
    tier.size -= removeCount;
}

function normalizePoint(point) {
    if (!point || typeof point !== "object") return null;
    const ts = normalizeTimestampMs(point.ts);
    const hs = normalizeFiniteNumber(point.hs, NaN);
    if (!Number.isFinite(hs)) return null;

    return {
        ts: ts,
        hs: normalizeHashrate(hs),
        hs2: normalizeHashrate(point.hs2)
    };
}

function compactOldestBucket(tier, capacity, bucketSize) {
    let newestTimestamp = 0;
    let totalHs = 0;
    let totalHs2 = 0;

    for (let index = 0; index < bucketSize; ++index) {
        const point = getPoint(tier, capacity, index);
        newestTimestamp = point.ts;
        totalHs += point.hs;
        totalHs2 += point.hs2;
    }

    dropOldestPoints(tier, capacity, bucketSize);

    return {
        ts: newestTimestamp,
        hs: normalizeHashrate(totalHs / bucketSize),
        hs2: normalizeHashrate(totalHs2 / bucketSize)
    };
}

function appendToTier(history, tierIndex, point) {
    const capacity = history.capacities[tierIndex];
    const tier = history.tiers[tierIndex];
    const lastTier = tierIndex === history.tiers.length - 1;

    if (lastTier && tier.size === capacity) {
        dropOldestPoints(tier, capacity, 1);
    } else if (!lastTier && tier.size === capacity) {
        appendToTier(history, tierIndex + 1, compactOldestBucket(tier, capacity, history.tierRatio));
    }

    setPoint(tier, capacity, tier.size, point);
    tier.size += 1;
}

function normalizeTierMetadata(tier, capacity) {
    const size = Math.min(normalizeNonNegativeInteger(tier && tier.size, 0), capacity);
    const head = size === 0 ? 0 : normalizeNonNegativeInteger(tier && tier.head, 0) % capacity;
    return { head: head, size: size };
}

function normalizeBinaryTier(tier, capacity) {
    if (!tier || typeof tier !== "object" || typeof tier.data !== "string") return null;

    const metadata = normalizeTierMetadata(tier, capacity);
    const decoded = Buffer.from(tier.data, "base64");
    if (decoded.length !== capacity * POINT_BYTES) return null;

    return {
        head: metadata.head,
        size: metadata.size,
        buffer: decoded
    };
}

function normalizeArrayTier(tier, capacity) {
    const normalized = createEmptyTier(capacity);
    if (!tier || typeof tier !== "object") return normalized;

    const metadata = normalizeTierMetadata(tier, capacity);
    normalized.head = metadata.head;
    normalized.size = metadata.size;
    if (!Array.isArray(tier.points)) return normalized;

    const limit = Math.min(capacity * POINT_WIDTH, tier.points.length);
    for (let slotIndex = 0, sourceIndex = 0; sourceIndex + 2 < limit; ++slotIndex, sourceIndex += POINT_WIDTH) {
        const point = normalizePoint({
            ts: tier.points[sourceIndex],
            hs: tier.points[sourceIndex + 1],
            hs2: tier.points[sourceIndex + 2]
        });
        if (!point) continue;
        const offset = pointOffset(slotIndex);
        normalized.buffer.writeUInt32LE(Math.round(point.ts / 1000), offset);
        normalized.buffer.writeFloatLE(point.hs, offset + 4);
        normalized.buffer.writeFloatLE(point.hs2, offset + 8);
    }

    return normalized;
}

function normalizeTieredHistoryPayload(payload) {
    if (!payload || payload.v !== HISTORY_VERSION || payload.kind !== HISTORY_KIND) return null;
    if (!Array.isArray(payload.capacities) || !Array.isArray(payload.tiers)) return null;

    const capacities = payload.capacities.map(function (capacity) {
        return normalizePositiveInteger(capacity, 0);
    }).filter(function (capacity) {
        return capacity > 0;
    });

    if (capacities.length === 0 || capacities.length !== payload.tiers.length) return null;

    const history = {
        v: HISTORY_VERSION,
        kind: HISTORY_KIND,
        encoding: HISTORY_ENCODING,
        baseIntervalSec: normalizePositiveInteger(payload.baseIntervalSec, DEFAULT_BASE_INTERVAL_SEC),
        tierRatio: normalizePositiveInteger(payload.tierRatio, DEFAULT_TIER_RATIO),
        capacities: capacities,
        tiers: []
    };

    const useBinaryFastPath = payload.encoding === HISTORY_ENCODING;
    for (let index = 0; index < capacities.length; ++index) {
        const tier = useBinaryFastPath
            ? normalizeBinaryTier(payload.tiers[index], capacities[index])
            : normalizeArrayTier(payload.tiers[index], capacities[index]);
        if (!tier) return null;
        history.tiers.push(tier);
    }

    return history;
}

function layoutsMatch(history, layout) {
    if (!history) return false;
    if (history.baseIntervalSec !== layout.baseIntervalSec || history.tierRatio !== layout.tierRatio) return false;
    if (history.capacities.length !== layout.capacities.length) return false;

    for (let index = 0; index < history.capacities.length; ++index) {
        if (history.capacities[index] !== layout.capacities[index]) return false;
    }

    return true;
}

function toHashHistory(payload, maxPoints) {
    if (!payload) return [];

    if (Array.isArray(payload.hashHistory)) {
        const points = [];
        for (let index = 0; index < payload.hashHistory.length; ++index) {
            const point = normalizePoint(payload.hashHistory[index]);
            if (point) points.push(point);
            if (typeof maxPoints === "number" && points.length >= maxPoints) break;
        }
        return points;
    }

    const normalized = normalizeTieredHistoryPayload(payload);
    if (!normalized) return [];

    const points = [];
    for (let tierIndex = 0; tierIndex < normalized.tiers.length; ++tierIndex) {
        const tier = normalized.tiers[tierIndex];
        const capacity = normalized.capacities[tierIndex];
        for (let logicalIndex = tier.size - 1; logicalIndex >= 0; --logicalIndex) {
            points.push(getPoint(tier, capacity, logicalIndex));
            if (typeof maxPoints === "number" && points.length >= maxPoints) return points;
        }
    }

    return points;
}

function importHistoryPoints(points, layout) {
    const history = createEmptyHistory(layout);
    for (let index = points.length - 1; index >= 0; --index) {
        const point = normalizePoint(points[index]);
        if (point) appendToTier(history, 0, point);
    }
    return history;
}

function importLegacyHistory(hashHistory, layout) {
    return importHistoryPoints(Array.isArray(hashHistory) ? hashHistory : [], layout);
}

function getWorkerHistoryState(payload, layout) {
    const normalized = normalizeTieredHistoryPayload(payload);
    if (normalized && layoutsMatch(normalized, layout)) return normalized;
    if (normalized) return importHistoryPoints(toHashHistory(normalized), layout);
    if (payload && Array.isArray(payload.hashHistory)) return importLegacyHistory(payload.hashHistory, layout);
    return createEmptyHistory(layout);
}

function serializeHistory(history) {
    return {
        v: HISTORY_VERSION,
        kind: HISTORY_KIND,
        encoding: HISTORY_ENCODING,
        baseIntervalSec: history.baseIntervalSec,
        tierRatio: history.tierRatio,
        capacities: history.capacities.slice(),
        tiers: history.tiers.map(function (tier) {
            return {
                head: tier.head,
                size: tier.size,
                data: tier.buffer.toString("base64")
            };
        })
    };
}

function appendHistorySample(payload, layout, point) {
    const normalizedPoint = normalizePoint(point);
    const history = getWorkerHistoryState(payload, layout);
    if (!normalizedPoint) return serializeHistory(history);
    appendToTier(history, 0, normalizedPoint);
    return serializeHistory(history);
}

module.exports = {
    DEFAULT_BASE_INTERVAL_SEC: DEFAULT_BASE_INTERVAL_SEC,
    DEFAULT_TIER_RATIO: DEFAULT_TIER_RATIO,
    HISTORY_ENCODING: HISTORY_ENCODING,
    HISTORY_KIND: HISTORY_KIND,
    HISTORY_VERSION: HISTORY_VERSION,
    appendHistorySample: appendHistorySample,
    appendWorkerHistorySample: appendHistorySample,
    buildTierLayout: buildTierLayout,
    createEmptyHistory: createEmptyHistory,
    getWorkerHistoryState: getWorkerHistoryState,
    importLegacyHistory: importLegacyHistory,
    normalizeTieredHistoryPayload: normalizeTieredHistoryPayload,
    serializeHistory: serializeHistory,
    toHashHistory: toHashHistory
};
