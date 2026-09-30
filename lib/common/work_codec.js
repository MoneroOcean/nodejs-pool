"use strict";

// Work is already represented as a JavaScript Number throughout accounting.
// Preserve that precision when it no longer fits the legacy signed int64 wire
// fields. Ordinary messages retain their original encoding. Readers must be
// upgraded before producers send overflowing work: old readers ignore the new
// fields and will see the zero sentinel, not the original work.
const INT64_LIMIT = 0x8000000000000000;
const adaptedCodecs = new WeakSet();

/**
 * @template {import("../../types/runtime").ProtoMessage} T
 * @typedef {{encode: ((data: T, buffer?: Buffer, offset?: number) => Buffer) & {bytes: number}, decode: ((data: Buffer | null, offset?: number, end?: number) => T) & {bytes: number}, encodingLength: (data: T) => number}} WorkCodec
 */

/** @param {unknown} value @param {string} field @param {boolean} [integer] */
function validateWork(value, field, integer = true) {
    if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < 0) {
        throw new RangeError(`${field} must be a finite nonnegative${integer ? " integer" : " number"}`);
    }
}

/**
 * @template {import("../../types/runtime").ProtoMessage} T
 * @param {T} data
 * @param {string[]} fields
 * @returns {T}
 */
function prepareWire(data, fields) {
    const wire = { ...data };
    for (const field of fields) {
        const extension = `${field}_double`;
        delete wire[extension];
        const value = data[field];
        if (value === undefined || value === null) continue;
        // Some native difficulties are fractional; retain the legacy encoder's
        // truncation behavior while they fit the original field.
        validateWork(value, field, false);
        if (/** @type {number} */ (value) >= INT64_LIMIT) {
            // The required legacy field remains present; never pass an
            // overflowing value to the int64 encoder.
            /** @type {import("../../types/runtime").ProtoMessage} */ (wire)[field] = 0;
            /** @type {import("../../types/runtime").ProtoMessage} */ (wire)[extension] = value;
        }
    }
    return wire;
}

/**
 * Repair only unambiguously invalid legacy int64 work varints (over 64 bits).
 * Values in the signed-negative range remain invalid: the wire cannot tell a
 * positive overflow from a negative int64. Unrelated malformed fields are not
 * repaired. Bounds keep even adversarial varints finite and scanning linear.
 * @param {Buffer | null} buffer
 * @param {number | undefined} offset
 * @param {number | undefined} end
 * @param {Record<number, number>} tags Legacy work tag to double extension tag.
 * @returns {Buffer | null}
 */
function repairLegacyOverflow(buffer, offset, end, tags) {
    if (!Buffer.isBuffer(buffer)) return null;
    const source = buffer;
    const start = offset || 0;
    const limit = end || buffer.length;
    if (start < 0 || limit > buffer.length || start > limit) return null;
    let position = start;
    let repaired = false;
    let hasExtension = false;
    let duplicateWork = false;
    const seenWork = new Set();
    /** @type {Buffer[]} */
    const parts = [];
    const extensionTags = new Set(Object.values(tags));

    /** @param {number} maxBytes @returns {bigint | null} */
    function readVarint(maxBytes) {
        let value = 0n;
        for (let count = 0; count < maxBytes && position < limit; count += 1) {
            const byte = /** @type {number} */ (source[position++]);
            value |= BigInt(byte & 0x7f) << BigInt(count * 7);
            if (!(byte & 0x80)) {
                if (count > 0 && byte === 0) return null;
                return value;
            }
        }
        return null;
    }

    while (position < limit) {
        const fieldStart = position;
        const prefix = readVarint(5);
        if (prefix === null || prefix > 0xffffffffn) return null;
        const tag = Number(prefix >> 3n);
        const wireType = Number(prefix & 7n);
        if (!tag) return null;
        if (extensionTags.has(tag)) hasExtension = true;
        const extensionTag = tags[tag];
        if (extensionTag !== undefined) {
            if (seenWork.has(tag)) duplicateWork = true;
            seenWork.add(tag);
            if (wireType !== 0) return null;
        }
        if (wireType === 0) {
            const value = readVarint(extensionTag === undefined ? 10 : 147);
            if (value === null) return null;
            if (value > 0xffffffffffffffffn) {
                if (extensionTag === undefined) return null;
                const number = Number(value);
                if (!Number.isFinite(number)) return null;
                // All mapped tags fit two bytes; preserve the original field's
                // tag and replace only its value with the zero sentinel.
                const fieldPrefix = Number(prefix);
                const doublePrefix = extensionTag * 8 + 1;
                const sentinel = fieldPrefix < 128
                    ? Buffer.from([fieldPrefix, 0])
                    : Buffer.from([(fieldPrefix & 0x7f) | 0x80, fieldPrefix >> 7, 0]);
                const extension = Buffer.alloc(doublePrefix < 128 ? 9 : 10);
                let extensionOffset = 1;
                extension[0] = doublePrefix < 128 ? doublePrefix : (doublePrefix & 0x7f) | 0x80;
                if (doublePrefix >= 128) extension[extensionOffset++] = doublePrefix >> 7;
                extension.writeDoubleLE(number, extensionOffset);
                parts.push(sentinel, extension);
                repaired = true;
                continue;
            }
        } else if (wireType === 1) position += 8;
        else if (wireType === 2) {
            const length = readVarint(5);
            if (length === null || length > BigInt(limit - position)) return null;
            position += Number(length);
        } else if (wireType === 5) position += 4;
        else return null;
        if (position > limit) return null;
        parts.push(buffer.subarray(fieldStart, position));
    }
    return repaired && !hasExtension && !duplicateWork ? Buffer.concat(parts) : null;
}

/**
 * @template {import("../../types/runtime").ProtoMessage} T
 * @param {import("../../types/runtime").ProtoCodec<T>} codec
 * @param {string[]} fields
 * @param {Record<number, number>} tags
 */
function wrapCodec(codec, fields, tags) {
    if (adaptedCodecs.has(codec)) return;
    const raw = /** @type {WorkCodec<T>} */ (codec);
    const originalEncode = raw.encode;
    const originalDecode = raw.decode;
    const originalEncodingLength = raw.encodingLength;

    /** @param {T} data @param {Buffer} [buffer] @param {number} [offset] */
    function encode(data, buffer, offset) {
        const result = originalEncode(prepareWire(data, fields), buffer, offset);
        encode.bytes = originalEncode.bytes;
        return result;
    }
    encode.bytes = 0;

    /** @param {Buffer | null} buffer @param {number} [offset] @param {number} [end] */
    function decode(buffer, offset, end) {
        let data;
        try {
            data = originalDecode(buffer, offset, end);
            decode.bytes = originalDecode.bytes;
        } catch (error) {
            const repaired = repairLegacyOverflow(buffer, offset, end, tags);
            if (!repaired) throw error;
            data = originalDecode(repaired);
            decode.bytes = (end || /** @type {Buffer} */ (buffer).length) - (offset || 0);
        }
        for (const field of fields) {
            const extension = `${field}_double`;
            const value = data[extension];
            // The protobuf implementation initializes missing doubles to zero.
            if (value !== undefined && value !== null && value !== 0) {
                validateWork(value, extension);
                if (/** @type {number} */ (value) < INT64_LIMIT || data[field] !== 0) {
                    throw new RangeError(`Invalid ${extension} work extension`);
                }
                /** @type {import("../../types/runtime").ProtoMessage} */ (data)[field] = value;
            }
            delete data[extension];
            if (data[field] !== undefined && data[field] !== null) validateWork(data[field], field, false);
        }
        return data;
    }
    decode.bytes = 0;

    raw.encode = encode;
    raw.decode = decode;
    raw.encodingLength = (data) => originalEncodingLength(prepareWire(data, fields));
    adaptedCodecs.add(codec);
}

/** @param {import("../../types/runtime").ProtoTypes} protos @returns {import("../../types/runtime").ProtoTypes} */
function adaptWorkCodecs(protos) {
    if (protos.Share) wrapCodec(protos.Share, ["shares", "shares2", "blockDiff"], { 1: 17, 14: 18, 8: 19 });
    if (protos.Block) wrapCodec(protos.Block, ["difficulty", "shares"], { 2: 10, 3: 11 });
    if (protos.AltBlock) wrapCodec(protos.AltBlock, ["difficulty", "shares"], { 2: 16, 3: 17 });
    return protos;
}

module.exports = adaptWorkCodecs;
