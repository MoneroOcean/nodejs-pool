"use strict";

const SLOT_VERSION = 1;
const SLOT_KIND = "recent-share-window-slot";
const CACHE_KEY_PREFIX = "recent_stats:";
const SLOT_INTERVAL_MS = 20 * 1000;
const HASH_WINDOW_MS = 10 * 60 * 1000;
const IDENTIFIER_WINDOW_MS = 20 * 60 * 1000;
const TAIL_RESCAN_MS = 2 * 60 * 1000;
const SLOT_RING_SIZE = Math.ceil((IDENTIFIER_WINDOW_MS + TAIL_RESCAN_MS) / SLOT_INTERVAL_MS) + 2;

function normalizeFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTimestampMs(value) {
    return Math.max(0, Math.round(normalizeFiniteNumber(value, 0)));
}

function normalizePositiveInteger(value, fallback) {
    const parsed = Math.floor(normalizeFiniteNumber(value, fallback));
    return parsed > 0 ? parsed : fallback;
}

function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}

function alignTimestampToSlot(timestampMs) {
    const normalized = normalizeTimestampMs(timestampMs);
    return normalized - (normalized % SLOT_INTERVAL_MS);
}

function getSlotId(timestampMs) {
    return Math.floor(normalizeTimestampMs(timestampMs) / SLOT_INTERVAL_MS);
}

function getSlotStart(slotId) {
    return slotId * SLOT_INTERVAL_MS;
}

function getSlotCacheKey(slotId) {
    return CACHE_KEY_PREFIX + positiveModulo(slotId, SLOT_RING_SIZE);
}

function createEmptySlot(slotId) {
    return {
        v: SLOT_VERSION,
        kind: SLOT_KIND,
        slot: slotId,
        intervalMs: SLOT_INTERVAL_MS,
        globalShares2: 0,
        pplnsShares2: 0,
        globalLastHash: 0,
        pplnsLastHash: 0,
        portHashes: Object.create(null),
        miners: Object.create(null),
        identifiers: Object.create(null)
    };
}

function normalizeIdentifierMap(value) {
    const normalized = Object.create(null);
    if (!value || typeof value !== "object") return normalized;

    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; ++index) {
            if (typeof value[index] === "string" && value[index].length > 0) normalized[value[index]] = 1;
        }
        return normalized;
    }

    Object.keys(value).forEach(function (identifier) {
        if (identifier.length > 0) normalized[identifier] = 1;
    });
    return normalized;
}

function normalizeMinerEntry(value) {
    if (!Array.isArray(value) || value.length < 5) return null;
    const rawShares = normalizeFiniteNumber(value[0], 0);
    const shares2 = normalizeFiniteNumber(value[1], 0);
    const lastHash = normalizeTimestampMs(value[2]);
    const port = normalizePositiveInteger(value[3], 0);
    const isPplns = value[4] ? 1 : 0;

    if (rawShares === 0 && shares2 === 0 && lastHash === 0 && port === 0 && isPplns === 0) return null;
    return [rawShares, shares2, lastHash, port, isPplns];
}

function normalizeSlotPayload(payload, expectedSlotId) {
    if (!payload || payload.v !== SLOT_VERSION || payload.kind !== SLOT_KIND) return null;
    if (normalizePositiveInteger(payload.intervalMs, 0) !== SLOT_INTERVAL_MS) return null;
    if (payload.slot !== expectedSlotId) return null;

    const normalized = createEmptySlot(expectedSlotId);
    normalized.globalShares2 = normalizeFiniteNumber(payload.globalShares2, 0);
    normalized.pplnsShares2 = normalizeFiniteNumber(payload.pplnsShares2, 0);
    normalized.globalLastHash = normalizeTimestampMs(payload.globalLastHash);
    normalized.pplnsLastHash = normalizeTimestampMs(payload.pplnsLastHash);

    if (payload.portHashes && typeof payload.portHashes === "object") {
        Object.keys(payload.portHashes).forEach(function (port) {
            const value = normalizeFiniteNumber(payload.portHashes[port], 0);
            if (value !== 0) normalized.portHashes[port] = value;
        });
    }

    if (payload.miners && typeof payload.miners === "object") {
        Object.keys(payload.miners).forEach(function (miner) {
            const entry = normalizeMinerEntry(payload.miners[miner]);
            if (entry) normalized.miners[miner] = entry;
        });
    }

    if (payload.identifiers && typeof payload.identifiers === "object") {
        Object.keys(payload.identifiers).forEach(function (address) {
            const identifierMap = normalizeIdentifierMap(payload.identifiers[address]);
            if (Object.keys(identifierMap).length > 0) normalized.identifiers[address] = identifierMap;
        });
    }

    return normalized;
}

function getWritableSlotPayload(payload, slotId) {
    return normalizeSlotPayload(payload, slotId) || createEmptySlot(slotId);
}

function getMinerId(share) {
    return typeof share.paymentID !== "undefined" && share.paymentID.length > 10
        ? share.paymentAddress + "." + share.paymentID
        : share.paymentAddress;
}

function mergeMinerEntry(target, minerKey, rawShares, shares2, lastHash, port, isPplns) {
    let current = target[minerKey];
    if (!current) {
        current = [0, 0, 0, port, isPplns ? 1 : 0];
        target[minerKey] = current;
    }

    current[0] += rawShares;
    current[1] += shares2;
    if (lastHash >= current[2]) {
        current[2] = lastHash;
        current[3] = port;
    }
    if (isPplns) current[4] = 1;
}

function appendShareToSlot(slot, share, options) {
    options = options || {};
    const shareTimestamp = normalizeTimestampMs(share.timestamp);
    if (!shareTimestamp) return;

    const defaultPort = normalizePositiveInteger(options.defaultPort, 0);
    const pplnsPoolType = options.pplnsPoolType;
    const rawShares = normalizeFiniteNumber(share.raw_shares, 0);
    const shares2 = normalizeFiniteNumber(share.shares2, 0);
    const isPplns = share.poolType === pplnsPoolType;
    const port = normalizePositiveInteger(share.port, defaultPort);
    const minerId = getMinerId(share);
    const identifier = typeof share.identifier === "string" ? share.identifier : "";

    if (slot.globalLastHash < shareTimestamp) slot.globalLastHash = shareTimestamp;
    if (isPplns && slot.pplnsLastHash < shareTimestamp) slot.pplnsLastHash = shareTimestamp;
    if (rawShares !== 0) slot.portHashes[port] = (slot.portHashes[port] || 0) + rawShares;

    if (identifier.length > 0) {
        if (!slot.identifiers[minerId]) slot.identifiers[minerId] = Object.create(null);
        slot.identifiers[minerId][identifier] = 1;
    }

    if (!shares2) return;

    slot.globalShares2 += shares2;
    if (isPplns) slot.pplnsShares2 += shares2;

    mergeMinerEntry(slot.miners, minerId, rawShares, shares2, shareTimestamp, port, isPplns);
    if (identifier.length > 0) {
        mergeMinerEntry(slot.miners, minerId + "_" + identifier, rawShares, shares2, shareTimestamp, port, isPplns);
    }
}

function buildSlotUpdates(shares, options) {
    const updates = new Map();

    for (let index = 0; index < shares.length; ++index) {
        const share = shares[index];
        if (!share || typeof share.raw_shares !== "number") continue;

        const slotId = getSlotId(share.timestamp);
        let slot = updates.get(slotId);
        if (!slot) {
            slot = createEmptySlot(slotId);
            updates.set(slotId, slot);
        }
        appendShareToSlot(slot, share, options);
    }

    return updates;
}

function mergeSlotPayload(target, source) {
    target.globalShares2 += source.globalShares2;
    target.pplnsShares2 += source.pplnsShares2;
    if (target.globalLastHash < source.globalLastHash) target.globalLastHash = source.globalLastHash;
    if (target.pplnsLastHash < source.pplnsLastHash) target.pplnsLastHash = source.pplnsLastHash;

    Object.keys(source.portHashes).forEach(function (port) {
        target.portHashes[port] = (target.portHashes[port] || 0) + source.portHashes[port];
    });

    Object.keys(source.miners).forEach(function (miner) {
        const entry = source.miners[miner];
        mergeMinerEntry(target.miners, miner, entry[0], entry[1], entry[2], entry[3], entry[4] === 1);
    });

    Object.keys(source.identifiers).forEach(function (address) {
        if (!target.identifiers[address]) target.identifiers[address] = Object.create(null);
        Object.keys(source.identifiers[address]).forEach(function (identifier) {
            target.identifiers[address][identifier] = 1;
        });
    });

    return target;
}

function getHybridWindowBounds(currentTime) {
    const alignedNow = alignTimestampToSlot(currentTime);
    const tailStart = Math.max(0, alignedNow - TAIL_RESCAN_MS);
    const hashStart = Math.max(0, alignedNow - HASH_WINDOW_MS);
    const identifierStart = Math.max(0, alignedNow - IDENTIFIER_WINDOW_MS);
    const slotWindowEnd = tailStart;

    return {
        alignedNow: alignedNow,
        tailStart: tailStart,
        hashStart: hashStart,
        identifierStart: identifierStart,
        startSlotId: getSlotId(identifierStart),
        endSlotId: slotWindowEnd > identifierStart ? getSlotId(slotWindowEnd - 1) : -1
    };
}

module.exports = {
    CACHE_KEY_PREFIX,
    HASH_WINDOW_MS,
    IDENTIFIER_WINDOW_MS,
    SLOT_INTERVAL_MS,
    SLOT_KIND,
    SLOT_RING_SIZE,
    SLOT_VERSION,
    TAIL_RESCAN_MS,
    alignTimestampToSlot,
    appendShareToSlot,
    buildSlotUpdates,
    createEmptySlot,
    getHybridWindowBounds,
    getMinerId,
    getSlotCacheKey,
    getSlotId,
    getSlotStart,
    getWritableSlotPayload,
    mergeSlotPayload,
    normalizeSlotPayload
};
