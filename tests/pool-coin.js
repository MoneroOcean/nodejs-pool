"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
    MAIN_PORT,
    createBaseTemplate,
    installTestGlobals
} = require("./pool-harness.js");

const REAL_ETH_STYLE_PORT = 8645;

test.describe("pool coin helpers", { concurrency: false }, () => {
test.beforeEach(() => {
    installTestGlobals();
});

test("hasTemplateBlob distinguishes hash-only extra-nonce templates from missing standard blobs", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;

    assert.equal(
        coinFuncs.hasTemplateBlob({ hash: "34".repeat(32) }, REAL_ETH_STYLE_PORT),
        true
    );
    assert.equal(
        coinFuncs.hasTemplateBlob({ reserved_offset: 17 }, MAIN_PORT),
        false
    );
});

test("BlockTemplate keeps main-template nonce layout stable across nextBlobHex calls", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const template = createBaseTemplate({
        coin: "",
        port: MAIN_PORT,
        idHash: "coin-helper-main-template",
        height: 301
    });
    const blockTemplate = new coinFuncs.BlockTemplate(template);
    const initialBuffer = Buffer.from(blockTemplate.buffer);
    const expectedIdHash = crypto
        .createHash("md5")
        .update(template.blocktemplate_blob)
        .digest("hex");

    assert.equal(blockTemplate.idHash, expectedIdHash);
    assert.equal(blockTemplate.reserved_offset, template.reserved_offset);
    assert.equal(blockTemplate.clientPoolLocation, template.reserved_offset + 8);
    assert.equal(blockTemplate.clientNonceLocation, template.reserved_offset + 12);

    blockTemplate.nextBlobHex();
    const firstBuffer = Buffer.from(blockTemplate.buffer);
    blockTemplate.nextBlobHex();
    const secondBuffer = Buffer.from(blockTemplate.buffer);

    assert.equal(blockTemplate.extraNonce, 2);
    assert.equal(firstBuffer.readUInt32BE(blockTemplate.reserved_offset), 1);
    assert.equal(secondBuffer.readUInt32BE(blockTemplate.reserved_offset), 2);
    assert.equal(
        firstBuffer.subarray(blockTemplate.reserved_offset + 4, blockTemplate.reserved_offset + 8).equals(
            initialBuffer.subarray(blockTemplate.reserved_offset + 4, blockTemplate.reserved_offset + 8)
        ),
        true
    );
    assert.equal(
        secondBuffer.subarray(blockTemplate.clientPoolLocation, blockTemplate.clientPoolLocation + 4).equals(
            initialBuffer.subarray(blockTemplate.clientPoolLocation, blockTemplate.clientPoolLocation + 4)
        ),
        true
    );
});

test("BlockTemplate uses hash-only fast path for extra-nonce templates without a blob payload", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const hash = "56".repeat(32);
    const blockTemplate = new coinFuncs.BlockTemplate({
        coin: "ETH",
        port: REAL_ETH_STYLE_PORT,
        height: 401,
        difficulty: 100,
        seed_hash: "78".repeat(32),
        hash,
        hash2: "9a".repeat(32)
    });

    assert.equal(blockTemplate.idHash, hash);
    assert.equal(blockTemplate.block_version, 0);
    assert.equal(blockTemplate.nextBlobHex(), hash);
});

test("convertAlgosToCoinPerf preserves the expected per-coin algo aliases", () => {
    const coinFuncs = global.coinFuncs.__realCoinFuncs;
    const perf = coinFuncs.convertAlgosToCoinPerf({
        "rx/0": 100,
        "cn-pico/trtl": 200,
        c29: 300,
        kawpow4: 400,
        etchash: 500
    });

    assert.equal(perf[""], 100);
    assert.equal(perf["SAL"], 100);
    assert.equal(perf["IRD"], 200);
    assert.equal(perf["XTM-C"], 300);
    assert.equal(perf["XNA"], 400);
    assert.equal(perf["CLORE"], 400);
    assert.equal(perf["ETC"], 500);
});
});
