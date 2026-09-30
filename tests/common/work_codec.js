"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const protobuf = require("protocol-buffers");
const adaptWorkCodecs = require("../../lib/common/work_codec.js");
const schema = fs.readFileSync(path.join(__dirname, "../../lib/common/data.proto"));
const raw = protobuf(schema);
const adapted = adaptWorkCodecs(protobuf(schema));
const legacy = protobuf(Buffer.from(schema.toString().replace(/^\s*optional double .*_double = \d+;\n/gm, "")));
const overflow = 9319591960411500 * 1e6;
const int64Limit = 0x8000000000000000;

function block() {
    return { hash: "a".repeat(64), difficulty: 123, shares: 456, timestamp: 1790000000000,
        poolType: 0, unlocked: false, valid: true };
}
function altBlock() { return { ...block(), port: 10001, height: 123456, anchor_height: 345678 }; }
function share() {
    return { shares: 123, shares2: 456, blockDiff: 789, paymentAddress: "test-address",
        foundBlock: false, trustedShare: false, poolType: 0, poolID: 1,
        blockHeight: 345678, timestamp: 1790000000000, identifier: "test", raw_shares: 1 };
}
const fixtures = [
    ["Share", share, ["shares", "shares2", "blockDiff"]],
    ["Block", block, ["difficulty", "shares"]],
    ["AltBlock", altBlock, ["difficulty", "shares"]]
];

test.describe("work codec signed-int64 overflow compatibility", () => {
    for (const [name, fixture, fields] of fixtures) {
        test(`${name} ordinary and fractional messages retain legacy bytes`, () => {
            for (const value of [0, 123, 123.75, 0x20000000000000, int64Limit - 1024]) {
                const data = fixture();
                for (const field of fields) data[field] = value;
                const bytes = adapted[name].encode(data);
                assert.deepEqual(bytes, legacy[name].encode(data));
                assert.deepEqual(adapted[name].decode(bytes), legacy[name].decode(bytes));
                assert.equal(adapted[name].encodingLength(data), bytes.length);
            }
        });

        test(`${name} overflowing work round-trips without mutating input`, () => {
            for (const value of [int64Limit, overflow, Number.MAX_VALUE]) {
                const data = fixture();
                for (const field of fields) data[field] = value;
                const before = { ...data };
                const bytes = adapted[name].encode(data);
                const decoded = adapted[name].decode(bytes);
                assert.deepEqual(data, before);
                for (const field of fields) {
                    assert.equal(decoded[field], value);
                    assert.equal(legacy[name].decode(bytes)[field], 0);
                    assert.equal(Object.hasOwn(decoded, `${field}_double`), false);
                }
                // Native hashing may alter floating-point rounding inherited
                // by the legacy varint decoder; retain its existing semantics.
                assert.equal(decoded.timestamp, legacy[name].decode(legacy[name].encode(fixture())).timestamp);
                const redecoded = adapted[name].decode(adapted[name].encode(decoded));
                for (const field of fields) assert.equal(redecoded[field], value);
                assert.equal(adapted[name].encodingLength(data), bytes.length);
            }
        });

        test(`${name} buffer offsets and byte counts are preserved`, () => {
            const data = fixture();
            data[fields[0]] = overflow;
            const length = adapted[name].encodingLength(data);
            const buffer = Buffer.alloc(length + 8);
            adapted[name].encode(data, buffer, 4);
            assert.equal(adapted[name].encode.bytes, length);
            const decoded = adapted[name].decode(buffer, 4, length + 4);
            assert.equal(decoded[fields[0]], overflow);
            assert.equal(adapted[name].decode.bytes, length);
        });

        test(`${name} old overflowing frames are repaired only in mapped work fields`, () => {
            const data = fixture();
            for (const field of fields) data[field] = overflow;
            // The legacy allocator caps varint length at ten bytes. Use a
            // sufficiently large buffer to distinguish repairable overflow
            // from irrecoverable trailing-field truncation.
            const allocated = Buffer.alloc(1024);
            legacy[name].encode(data, allocated);
            const bytes = allocated.subarray(0, legacy[name].encode.bytes);
            assert.throws(() => legacy[name].decode(bytes));
            const decoded = adapted[name].decode(bytes);
            for (const field of fields) assert.equal(decoded[field], overflow);
            assert.equal(decoded.timestamp, legacy[name].decode(legacy[name].encode(fixture())).timestamp);
            if (name === "AltBlock") assert.equal(decoded.anchor_height, data.anchor_height);
            assert.equal(adapted[name].decode.bytes, bytes.length);
            const framed = Buffer.concat([Buffer.alloc(4), bytes, Buffer.alloc(4)]);
            assert.equal(adapted[name].decode(framed, 4, bytes.length + 4)[fields[0]], overflow);
            assert.throws(() => adapted[name].decode(bytes.subarray(0, bytes.length - 1)));
            const unrelated = fixture();
            unrelated.timestamp = overflow;
            assert.throws(() => adapted[name].decode(legacy[name].encode(unrelated)));
        });

        test(`${name} invalid work and conflicting extensions are rejected`, () => {
            const field = fields[0];
            for (const value of [-1, NaN, Infinity, -Infinity]) {
                const data = fixture();
                data[field] = value;
                assert.throws(() => adapted[name].encode(data), /finite nonnegative/);
                assert.throws(() => adapted[name].encodingLength(data), /finite nonnegative/);
            }
            for (const value of [-1, Infinity, 1]) {
                const data = fixture();
                data[field] = 0;
                data[`${field}_double`] = value;
                assert.throws(() => adapted[name].decode(raw[name].encode(data)));
            }
            const conflicting = fixture();
            conflicting[`${field}_double`] = overflow;
            assert.throws(() => adapted[name].decode(raw[name].encode(conflicting)), /Invalid .* work extension/);
            const negative = fixture();
            negative[field] = -1;
            assert.throws(() => adapted[name].decode(legacy[name].encode(negative)));
        });
    }

    test("bounded overflow repair rejects nonfinite and ambiguous frames", () => {
        const bytes = legacy.AltBlock.encode({ ...altBlock(), difficulty: overflow });
        const tagAt = bytes.indexOf(Buffer.from([0x10]), 65);
        assert.ok(tagAt > 0);
        let valueEnd = tagAt + 1;
        while (bytes[valueEnd++] & 0x80) { /* find the legacy work varint boundary */ }
        const tooLong = Buffer.concat([bytes.subarray(0, tagAt + 1), Buffer.alloc(147, 0x80), Buffer.from([0x01]), bytes.subarray(valueEnd)]);
        assert.throws(() => adapted.AltBlock.decode(tooLong));
        const nonfinite = Buffer.concat([bytes.subarray(0, tagAt + 1), Buffer.alloc(146, 0xff), Buffer.from([0x7f]), bytes.subarray(valueEnd)]);
        assert.throws(() => adapted.AltBlock.decode(nonfinite));
        const duplicate = Buffer.concat([bytes, Buffer.from([0x10, 0])]);
        assert.throws(() => adapted.AltBlock.decode(duplicate));
        const extension = Buffer.alloc(10);
        extension[0] = 0x81;
        extension[1] = 0x01;
        extension.writeDoubleLE(overflow, 2);
        assert.throws(() => adapted.AltBlock.decode(Buffer.concat([bytes, extension])));
    });

    test("adapting an existing codec twice preserves overflowing work", () => {
        const protos = adaptWorkCodecs(protobuf(schema));
        adaptWorkCodecs(protos);
        const data = { ...altBlock(), difficulty: overflow };
        assert.equal(protos.AltBlock.decode(protos.AltBlock.encode(data)).difficulty, overflow);
    });

    test("autoallocated old overflow payloads with truncated metadata remain rejected", () => {
        const data = { ...altBlock(), difficulty: overflow };
        const bytes = legacy.AltBlock.encode(data);
        assert.equal(legacy.AltBlock.encode.bytes, bytes.length + 1);
        assert.throws(() => adapted.AltBlock.decode(bytes));
    });
});
