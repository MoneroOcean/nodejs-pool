"use strict";
const HISTORY_VERSION = 2;
const HISTORY_KIND = "worker-history-tiered";
const HISTORY_ENCODING = "base64-u32-f32-f32-le";
const DEFAULT_BASE_INTERVAL_SEC = 120;
const DEFAULT_TIER_RATIO = 3;
// Each point is a little-endian record: u32 timestamp (seconds) + f32 hs + f32 hs2.
const POINT_BYTES = 12;
const UINT32_MAX = 0xFFFFFFFF;

/** @typedef {{ts?: number | string | null, hs?: number | string | null, hs2?: number | string | null}} HistoryPointInput */
/** @typedef {{ts: number, hs: number, hs2: number}} HistoryPoint */
/** @typedef {{head: number, size: number, buffer: Buffer}} HistoryTier */
/** @typedef {{v: number, kind: string, encoding: string, baseIntervalSec: number, tierRatio: number, capacities: number[], tiers: HistoryTier[]}} History */
/** @typedef {{v: number, kind: string, maxPoints: number, targetSpanSec: number, baseIntervalSec: number, tierRatio: number, capacities: number[], intervalsSec: number[]}} HistoryLayout */
/** @typedef {{head?: number | string | null, size?: number | string | null, data?: string}} BinaryTierInput */
/** @typedef {{v?: number, kind?: string, encoding?: string, baseIntervalSec?: number | string | null, tierRatio?: number | string | null, capacities?: Array<number | string | null>, tiers?: Array<BinaryTierInput | null | undefined>}} SerializedHistory */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeTimestampMs(value) {
    const timestampMs = Math.round(normalizeFiniteNumber(value, 0));
    const timestampSec = Math.round(timestampMs / 1000);
    return Math.max(0, Math.min(UINT32_MAX, timestampSec)) * 1000;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeHashrate(value) { return Math.fround(normalizeFiniteNumber(value, 0)); }

/**
 * @param {number} totalPoints
 * @param {number} tierCount
 * @returns {number[]}
 */
function distributeCapacity(totalPoints, tierCount) {
    const base = Math.floor(totalPoints / tierCount);
    const remainder = totalPoints % tierCount;
    const capacities = [];

    for (let index = 0; index < tierCount; ++index) {
        capacities.push(base + (index < remainder ? 1 : 0));
    }

    return capacities;
}

/**
 * @param {number[]} capacities
 * @param {number} baseIntervalSec
 * @param {number} tierRatio
 * @returns {number}
 */
function calculateCoverage(capacities, baseIntervalSec, tierRatio) {
    let coverage = 0;
    for (let index = 0; index < capacities.length; ++index) {
        const capacity = capacities[index];
        if (typeof capacity === "undefined") continue;
        coverage += capacity * baseIntervalSec * Math.pow(tierRatio, index);
    }
    return coverage;
}

/**
 * @param {number} statsBufferLength
 * @param {number} statsBufferHours
 * @param {{baseIntervalSec?: unknown, tierRatio?: unknown} | undefined} options
 * @returns {HistoryLayout}
 */
function buildTierLayout(statsBufferLength, statsBufferHours, options) {
    const opts = options || {};
    const maxPoints = normalizePositiveInteger(statsBufferLength, 1);
    const baseIntervalSec = normalizePositiveInteger(opts.baseIntervalSec, DEFAULT_BASE_INTERVAL_SEC);
    const tierRatio = normalizePositiveInteger(opts.tierRatio, DEFAULT_TIER_RATIO);
    const targetSpanSec = Math.max(baseIntervalSec, Math.floor(normalizeFiniteNumber(statsBufferHours, 1) * 60 * 60));
    const maxTierCount = Math.max(1, Math.floor(maxPoints / tierRatio));

    // Use the fewest tiers whose combined time span still covers targetSpanSec.
    let capacities = [maxPoints];
    for (let tierCount = 1; tierCount <= maxTierCount; ++tierCount) {
        const candidate = distributeCapacity(maxPoints, tierCount);
        capacities = candidate;
        if (calculateCoverage(candidate, baseIntervalSec, tierRatio) >= targetSpanSec) break;
    }

    return {
        v: HISTORY_VERSION,
        kind: HISTORY_KIND,
        maxPoints,
        targetSpanSec,
        baseIntervalSec,
        tierRatio,
        capacities,
        intervalsSec: capacities.map(function (_capacity, index) {
            return baseIntervalSec * Math.pow(tierRatio, index);
        })
    };
}

/**
 * @param {number} capacity
 * @returns {HistoryTier}
 */
function createEmptyTier(capacity) {
    return {
        head: 0,
        size: 0,
        buffer: Buffer.alloc(capacity * POINT_BYTES)
    };
}

/**
 * @param {HistoryLayout} layout
 * @returns {History}
 */
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

/**
 * @param {number} slotIndex
 * @returns {number}
 */
function pointOffset(slotIndex) { return slotIndex * POINT_BYTES; }

/**
 * @param {HistoryTier} tier
 * @param {number} capacity
 * @param {number} logicalIndex
 * @returns {HistoryPoint}
 */
function getPoint(tier, capacity, logicalIndex) {
    const slotIndex = (tier.head + logicalIndex) % capacity;
    const offset = pointOffset(slotIndex);
    // Stored as u32 seconds to fit 4 bytes; exposed in milliseconds.
    return {
        ts: tier.buffer.readUInt32LE(offset) * 1000,
        hs: tier.buffer.readFloatLE(offset + 4),
        hs2: tier.buffer.readFloatLE(offset + 8)
    };
}

/**
 * @param {HistoryTier} tier
 * @param {number} capacity
 * @param {number} logicalIndex
 * @param {HistoryPoint} point
 * @returns {void}
 */
function setPoint(tier, capacity, logicalIndex, point) {
    const slotIndex = (tier.head + logicalIndex) % capacity;
    const offset = pointOffset(slotIndex);
    tier.buffer.writeUInt32LE(Math.round(normalizeTimestampMs(point["ts"]) / 1000), offset);
    tier.buffer.writeFloatLE(normalizeHashrate(point.hs), offset + 4);
    tier.buffer.writeFloatLE(normalizeHashrate(point["hs2"]), offset + 8);
}

/**
 * @param {HistoryTier} tier
 * @param {number} capacity
 * @param {number} count
 * @returns {void}
 */
function dropOldestPoints(tier, capacity, count) {
    if (count <= 0 || tier.size === 0) return;
    const removeCount = Math.min(count, tier.size);
    tier.head = (tier.head + removeCount) % capacity;
    tier.size -= removeCount;
}

/**
 * @param {unknown} point
 * @returns {HistoryPoint | null}
 */
function normalizePoint(point) {
    if (!isRecord(point)) return null;
    const ts = normalizeTimestampMs(point["ts"]);
    const hs = normalizeFiniteNumber(point["hs"], NaN);
    if (!Number.isFinite(hs)) return null;

    return {
        ts,
        hs: normalizeHashrate(hs),
        hs2: normalizeHashrate(point["hs2"])
    };
}

/**
 * @param {HistoryTier} tier
 * @param {number} capacity
 * @param {number} bucketSize
 * @returns {HistoryPoint}
 */
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

/**
 * @param {History} history
 * @param {number} tierIndex
 * @param {HistoryPoint} point
 * @returns {void}
 */
function appendToTier(history, tierIndex, point) {
    const capacity = history.capacities[tierIndex];
    const tier = history.tiers[tierIndex];
    if (typeof capacity === "undefined" || !tier) return;
    const lastTier = tierIndex === history.tiers.length - 1;

    // When a tier is full, the last tier discards its oldest point, while finer tiers
    // average their oldest bucket (tierRatio points) down into the next coarser tier.
    if (lastTier && tier.size === capacity) {
        dropOldestPoints(tier, capacity, 1);
    } else if (!lastTier && tier.size === capacity) {
        appendToTier(history, tierIndex + 1, compactOldestBucket(tier, capacity, history.tierRatio));
    }

    setPoint(tier, capacity, tier.size, point);
    tier.size += 1;
}

/**
 * @param {unknown} tier
 * @param {number} capacity
 * @returns {{head: number, size: number}}
 */
function normalizeTierMetadata(tier, capacity) {
    const size = Math.min(normalizeNonNegativeInteger(isRecord(tier) ? tier["size"] : null, 0), capacity);
    const head = size === 0 ? 0 : normalizeNonNegativeInteger(isRecord(tier) ? tier["head"] : null, 0) % capacity;
    return { head, size };
}

/**
 * @param {unknown} tier
 * @param {number} capacity
 * @returns {HistoryTier | null}
 */
function normalizeBinaryTier(tier, capacity) {
    if (!isRecord(tier) || typeof tier["data"] !== "string") return null;

    const metadata = normalizeTierMetadata(tier, capacity);
    const decoded = Buffer.from(tier["data"], "base64");
    if (decoded.length !== capacity * POINT_BYTES) return null;

    return {
        head: metadata.head,
        size: metadata.size,
        buffer: decoded
    };
}

/**
 * @param {unknown} payload
 * @returns {History | null}
 */
function normalizeTieredHistoryPayload(payload) {
    if (!isRecord(payload) || payload["v"] !== HISTORY_VERSION || payload["kind"] !== HISTORY_KIND) return null;
    if (payload["encoding"] !== HISTORY_ENCODING) return null;
    if (!Array.isArray(payload["capacities"]) || !Array.isArray(payload["tiers"])) return null;

    const capacities = payload["capacities"].map(function (capacity) {
        return normalizePositiveInteger(capacity, 0);
    }).filter(function (capacity) {
        return capacity > 0;
    });

    if (capacities.length === 0 || capacities.length !== payload["tiers"].length) return null;

    /** @type {HistoryTier[]} */
    const tiers = [];
    const history = {
        v: HISTORY_VERSION,
        kind: HISTORY_KIND,
        encoding: HISTORY_ENCODING,
        baseIntervalSec: normalizePositiveInteger(payload["baseIntervalSec"], DEFAULT_BASE_INTERVAL_SEC),
        tierRatio: normalizePositiveInteger(payload["tierRatio"], DEFAULT_TIER_RATIO),
        capacities,
        tiers
    };

    for (let index = 0; index < capacities.length; ++index) {
        const capacity = capacities[index];
        const rawTier = payload["tiers"][index];
        if (typeof capacity === "undefined") return null;
        const tier = normalizeBinaryTier(rawTier, capacity);
        if (!tier) return null;
        history.tiers.push(tier);
    }

    return history;
}

/**
 * @param {History | null} history
 * @param {HistoryLayout} layout
 * @returns {boolean}
 */
function layoutsMatch(history, layout) {
    if (!history) return false;
    if (history.baseIntervalSec !== layout.baseIntervalSec || history.tierRatio !== layout.tierRatio) return false;
    if (history.capacities.length !== layout.capacities.length) return false;

    for (let index = 0; index < history.capacities.length; ++index) {
        if (history.capacities[index] !== layout.capacities[index]) return false;
    }

    return true;
}

/**
 * @param {History} history
 * @param {number | undefined} [maxPoints]
 * @returns {HistoryPoint[]}
 */
function historyPoints(history, maxPoints) {
    const points = [];
    for (let tierIndex = 0; tierIndex < history.tiers.length; ++tierIndex) {
        const tier = history.tiers[tierIndex];
        const capacity = history.capacities[tierIndex];
        if (!tier || typeof capacity === "undefined") continue;
        for (let logicalIndex = tier.size - 1; logicalIndex >= 0; --logicalIndex) {
            points.push(getPoint(tier, capacity, logicalIndex));
            if (typeof maxPoints === "number" && points.length >= maxPoints) return points;
        }
    }

    return points;
}

/**
 * @param {unknown} payload
 * @param {number | undefined} [maxPoints]
 * @returns {HistoryPoint[]}
 */
function toHashHistory(payload, maxPoints) {
    if (!payload) return [];
    const normalized = normalizeTieredHistoryPayload(payload);
    return normalized ? historyPoints(normalized, maxPoints) : [];
}

/**
 * @param {unknown[]} points
 * @param {HistoryLayout} layout
 * @returns {History}
 */
function importHistoryPoints(points, layout) {
    const history = createEmptyHistory(layout);
    for (let index = points.length - 1; index >= 0; --index) {
        const point = normalizePoint(points[index]);
        if (point) appendToTier(history, 0, point);
    }
    return history;
}

/**
 * @param {unknown} payload
 * @param {HistoryLayout} layout
 * @returns {History}
 */
function getWorkerHistoryState(payload, layout) {
    const normalized = normalizeTieredHistoryPayload(payload);
    if (normalized && layoutsMatch(normalized, layout)) return normalized;
    // Layout changed (e.g. config reconfigured the buffer): replay points into the new layout.
    if (normalized) return importHistoryPoints(historyPoints(normalized, undefined), layout);
    return createEmptyHistory(layout);
}

/**
 * @param {History} history
 * @returns {SerializedHistory}
 */
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

/**
 * @param {unknown[]} points
 * @param {HistoryLayout} layout
 * @returns {SerializedHistory}
 */
function importHistoryPayload(points, layout) {
    return serializeHistory(importHistoryPoints(points, layout));
}

/**
 * @param {unknown} payload
 * @param {HistoryLayout} layout
 * @param {HistoryPointInput} point
 * @returns {SerializedHistory}
 */
function appendHistorySample(payload, layout, point) {
    const normalizedPoint = normalizePoint(point);
    const history = getWorkerHistoryState(payload, layout);
    if (!normalizedPoint) return serializeHistory(history);
    appendToTier(history, 0, normalizedPoint);
    return serializeHistory(history);
}

module.exports = {
    DEFAULT_BASE_INTERVAL_SEC,
    DEFAULT_TIER_RATIO,
    HISTORY_ENCODING,
    HISTORY_KIND,
    HISTORY_VERSION,
    appendHistorySample,
    appendWorkerHistorySample: appendHistorySample,
    buildTierLayout,
    createEmptyHistory,
    getWorkerHistoryState,
    importHistoryPayload,
    normalizeTieredHistoryPayload,
    serializeHistory,
    toHashHistory
};
