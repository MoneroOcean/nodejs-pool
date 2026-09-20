"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const pearl = require("../../../lib/coins/core/pearl.js");
const pearlProfile = require("../../../lib/coins/pearl.js");

function validPearlVerifierConfig(adjustment_factor) {
    return {
        m: 1, n: 1, k: 128, rank: 128, experts: 0, top_k: 0,
        expert_index: 0, t_rows: 1, t_cols: 1, adjustment_factor, moe: false
    };
}

function pearlShareFixture({ claim = {}, verifier, networkDifficulty = 2, shareDifficulty = 1 }) {
    const networkTarget = pearl.targetForDifficulty(networkDifficulty);
    const shareTarget = pearl.targetForDifficulty(shareDifficulty);
    assert.ok(networkTarget);
    assert.ok(shareTarget);
    const proof = Buffer.from("pearl-proof");
    const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
    header.writeUInt32LE(pearl.targetToCompact(networkTarget.target), 72);
    const calls = { invalid: [], trusted: 0, verifier: 0, verified: [] };
    const context = {
        blockTemplate: { header: header.toString("base64"), target: networkTarget.targetDecimal },
        params: { plain_proof: proof.toString("base64"), ...claim },
        job: {
            target: Buffer.from(shareTarget.targetHex, "hex").toString("base64"),
            targetHex: shareTarget.targetHex,
            targetDecimal: shareTarget.targetDecimal,
            difficulty: shareDifficulty
        },
        miner: { payout: "miner" },
        coinFuncs: {
            verifyPearlAsync(_header, _proof, _target, _miner, callback) {
                calls.verifier += 1;
                callback(verifier);
            }
        },
        invalidShare() { return "invalid"; },
        processShareCB(result) { calls.invalid.push(result); },
        verifyShareCB(...args) { calls.verified.push(args); }
    };
    return { calls, context, networkTarget, proof, shareTarget };
}

test.describe("pool coin helpers: Pearl", { concurrency: false }, () => {
    test("uses the contiguous daemon RPC and mining gateway ports", () => {
        assert.equal(pearl.PEARL_PORT, 44109);
        assert.equal(pearl.PEARL_GATEWAY_PORT, 44111);
    });

    test("maps the established fixed-coin selector to canonical PearlHash accounting", () => {
        assert.deepEqual(pearlProfile.minerAlgoAliases, { pearlhash: ["pearl"] });
        assert.deepEqual(pearlProfile.perf.aliases, ["pearlhash", "pearl"]);
        assert.equal(pearlProfile.pool.hashesPerDifficulty, 1_000_000);
    });

    test("accepts bounded uncompressed proofs without magic-byte guessing", () => {
        const rawWithGzipMagic = Buffer.from([0x1f, 0x8b, 0, 0]);
        assert.deepEqual(pearl.decodePearlProof(rawWithGzipMagic.toString("base64")), rawWithGzipMagic);

        const proof = Buffer.from("pearl-proof");
        assert.deepEqual(pearl.decodePearlProof(proof.toString("base64")), proof);
        assert.equal(pearl.decodePearlProof("not-base64"), null);
    });

    test("accepts omitted or none encoding and rejects compression labels", () => {
        const proof = Buffer.from("pearl-proof").toString("base64");
        for (const proof_encoding of [undefined, "none"]) {
            const params = { job_id: 7, plain_proof: proof, ...(proof_encoding ? { proof_encoding } : {}) };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), true);
            assert.deepEqual(params, { job_id: "7", plain_proof: proof });
        }
        for (const proof_encoding of ["raw", "gzip", "zlib"]) {
            const params = { job_id: "7", plain_proof: proof, proof_encoding };
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), false);
        }
    });

    test("normalizes and validates optional Pearl claim fields", () => {
        const proof = Buffer.from("pearl-proof").toString("base64");
        const jackpot = "ab".repeat(32).toUpperCase();
        const params = { job_id: 7, plain_proof: proof, jackpot, adjustment_factor: 7 };
        assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({ params, wireParams: {} }), true);
        assert.equal(params.jackpot, jackpot.toLowerCase());
        assert.equal(params.adjustment_factor, 7);

        const invalidClaims = [
            { jackpot },
            { adjustment_factor: 1 },
            { jackpot: "a".repeat(63), adjustment_factor: 1 },
            { jackpot: "gg".repeat(32), adjustment_factor: 1 },
            { jackpot: "00".repeat(32), adjustment_factor: 0 },
            { jackpot: "00".repeat(32), adjustment_factor: 0x1_0000_0000 }
        ];
        for (const claim of invalidClaims) {
            assert.equal(pearlProfile.pool.normalizeNamedSubmitParams({
                params: { job_id: "7", plain_proof: proof, ...claim }, wireParams: {}
            }), false);
        }
    });

    test("normalizes the standard Pearl object authorize shape", () => {
        const params = { wallet: "wallet", worker: "worker", pass: "x~pearl" };
        assert.equal(pearlProfile.pool.normalizeNamedAuthorizeParams({
            params,
            port: pearl.PEARL_PORT,
            profile: pearlProfile
        }), true);
        assert.equal(params.login, "wallet");
        assert.equal(params.rigid, "worker");
        assert.deepEqual(params.algo, ["pearlhash"]);
    });

    test("normalizes the SRBMiner Pearl authorize variant without a password", () => {
        const params = { wallet: "wallet", worker: "worker", agent: "SRBMiner-MULTI/3.6.7", type: "pearlhash" };
        assert.equal(pearlProfile.pool.normalizeNamedAuthorizeParams({
            params,
            port: pearl.PEARL_PORT,
            profile: pearlProfile
        }), true);
        assert.equal(params.pass, "x");
        assert.equal(params.login, "wallet");
        assert.equal(params.rigid, "worker");
        assert.equal(params.type, undefined);
    });

    test("derives exact little-endian share targets from normalized difficulty", () => {
        const result = pearl.targetForDifficulty(2);
        assert.ok(result);
        assert.equal(result.work, 2_000_000n);
        assert.equal(BigInt(`0x${Buffer.from(result.targetHex, "hex").reverse().toString("hex")}`), result.target);
        assert.equal(result.targetDecimal, result.target.toString(10));
    });

    test("builds the established Pearl miner wire job from the gateway template", () => {
        const networkTarget = pearl.targetForDifficulty(1);
        assert.ok(networkTarget);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        header.writeUInt32LE(pearl.targetToCompact(networkTarget.target), 72);
        const headerBase64 = header.toString("base64");
        const newJob = { id: "pearl-job" };
        const payload = pearlProfile.pool.buildJobPayload({
            blockTemplate: {
                header: headerBase64,
                incomplete_header_bytes: headerBase64,
                cert_version: pearl.PEARL_CERT_VERSION,
                height: 123
            },
            coinDiff: 2,
            newJob
        });
        const shareTarget = pearl.targetForDifficulty(2);
        assert.ok(shareTarget);
        assert.deepEqual(payload, {
            header: header.toString("hex"),
            job_id: "pearl-job",
            target: shareTarget.target.toString(16).padStart(64, "0"),
            cert_version: pearl.PEARL_CERT_VERSION
        });
        assert.equal(newJob.targetHex, shareTarget.targetHex);
        assert.equal(payload.target, Buffer.from(newJob.targetHex, "hex").reverse().toString("hex"));
        assert.equal(newJob.incomplete_header_bytes, headerBase64);
        assert.equal(newJob.cert_version, pearl.PEARL_CERT_VERSION);
    });

    test("fails closed when adjustment would overflow a 256-bit target", () => {
        assert.equal(pearl.adjustedNetworkTarget(pearl.UINT256_MAX.toString(10), 2), null);
        assert.equal(pearl.isPearlNetworkCandidate("00".repeat(32), pearl.UINT256_MAX.toString(10), 2), false);
    });

    test("normalizes daemon difficulty from the exact Pearl target for hash-factor accounting", async () => {
        const target = pearl.targetForDifficulty(2);
        assert.ok(target);
        const compact = pearl.targetToCompact(target.target);
        assert.ok(compact);
        const previousHash = "12".repeat(32);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        Buffer.from(previousHash, "hex").reverse().copy(header, 4);
        header.writeUInt32LE(compact, 72);
        const parsed = pearl.parseMiningHeader(header.toString("base64"));
        assert.ok(parsed);
        const originalGatewayRequest = pearl.gatewayRequest;
        pearl.gatewayRequest = function mockGatewayRequest(method, params, callback) {
            assert.equal(method, "getMiningInfo");
            assert.deepEqual(params, {});
            callback(null, { result: {
                cert_version: pearl.PEARL_CERT_VERSION,
                incomplete_header_bytes: header.toString("base64"),
                target_decimal: parsed.targetDecimal,
                expected_reward: 50
            } });
        };
        try {
            const normalized = await new Promise((resolve, reject) => {
                pearlProfile.rpc.getLastBlockHeader({
                    port: pearl.PEARL_PORT,
                    profile: pearlProfile,
                    noErrorReport: true,
                    runtime: { support: { rpcPortDaemon2(port, path, request, callback) {
                        assert.equal(port, pearl.PEARL_PORT);
                        assert.equal(path, "");
                        assert.deepEqual(request, {
                            id: "0", jsonrpc: "2.0", method: "getblockheader", params: [previousHash, true]
                        });
                        callback({ result: { height: 99, hash: previousHash, difficulty: 1 } });
                    } } },
                    callback(error, result) { if (error) reject(error); else resolve(result); }
                });
            });
            assert.equal(normalized.difficulty, parsed.difficulty);
            assert.equal(normalized.reward, 50);
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
    });

    test("uses complete JSON-RPC envelopes for pearld header lookups", async () => {
        const blockHash = "34".repeat(32);
        const calls = [];
        const support = { rpcPortDaemon2(port, path, request, callback) {
            assert.equal(port, pearl.PEARL_PORT);
            assert.equal(path, "");
            calls.push(request);
            if (request.method === "getblockhash") return callback({ result: blockHash });
            return callback({ result: { height: 7, hash: blockHash } });
        } };
        const context = {
            port: pearl.PEARL_PORT,
            profile: pearlProfile,
            noErrorReport: true,
            runtime: { support }
        };
        const byHeight = await new Promise((resolve, reject) => pearlProfile.rpc.getBlockHeaderById({
            ...context,
            blockId: 7,
            callback(error, result) { if (error) reject(error); else resolve(result); }
        }));
        const byHash = await new Promise((resolve, reject) => pearlProfile.rpc.getAnyBlockHeaderByHash({
            ...context,
            blockHash,
            callback(error, result) { if (error) reject(error); else resolve(result); }
        }));
        assert.equal(byHeight.height, 7);
        assert.equal(byHash.height, 7);
        assert.deepEqual(calls, [
            { id: "0", jsonrpc: "2.0", method: "getblockhash", params: [7] },
            { id: "0", jsonrpc: "2.0", method: "getblockheader", params: [blockHash, true] },
            { id: "0", jsonrpc: "2.0", method: "getblockheader", params: [blockHash, true] }
        ]);
    });

    test("accepts a claimed ordinary share through the trusted-share path", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: pearl.targetForDifficulty(1).targetHex, adjustment_factor: 1 },
            verifier: { valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1) }
        });
        fixture.context.tryTrustedShare = onTrustedShare => {
            fixture.calls.trusted += 1;
            onTrustedShare();
            return true;
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.trusted, 1);
        assert.equal(fixture.calls.verifier, 0);
        assert.deepEqual(fixture.calls.verified, [[1, null, null, true, false, false]]);
        assert.deepEqual(fixture.calls.invalid, []);
    });

    test("fully verifies a claimed network candidate without trying trusted shares", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: "00".repeat(32), adjustment_factor: 1 },
            verifier: {
                valid: true,
                candidate: true,
                jackpot: "00".repeat(32),
                config: validPearlVerifierConfig(1)
            }
        });
        fixture.context.tryTrustedShare = () => {
            fixture.calls.trusted += 1;
            assert.fail("network candidates must be fully verified");
        };

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.trusted, 0);
        assert.equal(fixture.calls.verifier, 1);
        assert.deepEqual(fixture.calls.verified, [[1, null, fixture.proof.toString("base64"), false, true, true]]);
        assert.deepEqual(fixture.calls.invalid, []);
    });

    test("rejects claims outside the assigned share target before verification", () => {
        const fixture = pearlShareFixture({
            claim: { jackpot: "ff".repeat(32), adjustment_factor: 1 },
            verifier: { valid: true, candidate: true, jackpot: "ff".repeat(32), config: validPearlVerifierConfig(1) }
        });

        assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
        assert.equal(fixture.calls.verifier, 0);
        assert.deepEqual(fixture.calls.invalid, ["invalid"]);
        assert.deepEqual(fixture.calls.verified, []);
    });

    test("invalidates verifier results whose jackpot or factor differs from the claim", () => {
        const networkTarget = pearl.targetForDifficulty(2);
        assert.ok(networkTarget);
        const cases = [
            {
                claim: { jackpot: networkTarget.targetHex, adjustment_factor: 1 },
                verifier: {
                    valid: true, candidate: true, jackpot: "00".repeat(32), config: validPearlVerifierConfig(1)
                }
            },
            {
                claim: { jackpot: networkTarget.targetHex, adjustment_factor: 2 },
                verifier: {
                    valid: true, candidate: true, jackpot: networkTarget.targetHex, config: validPearlVerifierConfig(1)
                }
            }
        ];
        for (const { claim, verifier } of cases) {
            const fixture = pearlShareFixture({ claim, verifier });
            fixture.context.tryTrustedShare = () => {
                fixture.calls.trusted += 1;
                assert.fail("claimed network candidates must not use trusted shares");
            };
            assert.equal(pearlProfile.pool.verifySpecialShare(fixture.context), true);
            assert.equal(fixture.calls.trusted, 0);
            assert.equal(fixture.calls.verifier, 1);
            assert.deepEqual(fixture.calls.invalid, ["invalid"]);
            assert.deepEqual(fixture.calls.verified, []);
        }
    });

    test("rejects a valid proof that does not meet the assigned share target", () => {
        const parsed = pearl.targetForDifficulty(1);
        assert.ok(parsed);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        header.writeUInt32LE(pearl.targetToCompact(parsed.target), 72);
        let invalidCalls = 0;
        let verifiedCalls = 0;
        let verifierWire;
        const context = {
            blockTemplate: { header: header.toString("base64"), target: parsed.targetDecimal },
            params: { plain_proof: Buffer.from("proof").toString("base64") },
            job: { target: Buffer.from(parsed.targetHex, "hex").toString("base64"), targetHex: parsed.targetHex, difficulty: 1 },
            miner: { payout: "miner" },
            coinFuncs: {
                verifyPearlAsync(wireHeader, _proof, wireTarget, _miner, callback) {
                    verifierWire = { wireHeader, wireTarget };
                    callback({
                        valid: true,
                        candidate: false,
                        jackpot: "ff".repeat(32),
                        config: {
                            m: 1, n: 1, k: 128, rank: 128, experts: 0, top_k: 0,
                            expert_index: 0, t_rows: 1, t_cols: 1, adjustment_factor: 128, moe: false
                        }
                    });
                }
            },
            invalidShare() { return "invalid"; },
            processShareCB(result) { assert.equal(result, "invalid"); invalidCalls += 1; },
            verifyShareCB() { verifiedCalls += 1; }
        };
        assert.equal(pearlProfile.pool.verifySpecialShare(context), true);
        assert.equal(verifierWire.wireHeader, header.toString("hex"));
        assert.equal(verifierWire.wireTarget, parsed.targetHex);
        assert.equal(invalidCalls, 1);
        assert.equal(verifiedCalls, 0);
    });

    test("marks an independently verified network winner for block submission", () => {
        const parsed = pearl.targetForDifficulty(1);
        assert.ok(parsed);
        const header = Buffer.alloc(pearl.PEARL_HEADER_BYTES);
        header.writeUInt32LE(pearl.targetToCompact(parsed.target), 72);
        const proof = Buffer.from("winning-proof");
        let verifiedArgs;
        const context = {
            blockTemplate: { header: header.toString("base64"), target: parsed.targetDecimal },
            params: { plain_proof: proof.toString("base64") },
            job: { targetHex: parsed.targetHex, difficulty: 1 },
            miner: { payout: "miner" },
            coinFuncs: {
                verifyPearlAsync(_header, _proof, _target, _miner, callback) {
                    callback({
                        valid: true,
                        candidate: true,
                        jackpot: "00".repeat(32),
                        proof_id: "12".repeat(32),
                        config: {
                            m: 1, n: 1, k: 128, rank: 128, experts: 0, top_k: 0,
                            expert_index: 0, t_rows: 1, t_cols: 1, adjustment_factor: 128, moe: false
                        }
                    });
                }
            },
            invalidShare() { return "invalid"; },
            processShareCB() { assert.fail("winning proof must reach the verified-share path"); },
            verifyShareCB(...args) { verifiedArgs = args; }
        };
        assert.equal(pearlProfile.pool.verifySpecialShare(context), true);
        assert.deepEqual(verifiedArgs, [1, null, proof.toString("base64"), false, true, true]);
        assert.equal(context.params.pearl_proof_id, "12".repeat(32));
    });

    test("preserves bounded Pearl gateway rejection diagnostics without logging the proof", () => {
        const proof = Buffer.from("winning-proof");
        const proofBase64 = proof.toString("base64");
        const originalGatewayRequest = pearl.gatewayRequest;
        let request;
        let response;
        pearl.gatewayRequest = function mockGatewayRequest(method, params, callback) {
            request = { method, params };
            callback(null, { error: { code: 17, message: "target mismatch", detail: "x".repeat(5000) } });
        };
        try {
            pearlProfile.pool.submitBlockRpc.call(pearlProfile.pool, {
                blockData: proofBase64,
                job: {
                    id: "pearl-job",
                    incomplete_header_bytes: Buffer.alloc(pearl.PEARL_HEADER_BYTES, 7).toString("base64"),
                    gatewayTarget: Number.MAX_VALUE,
                    targetDecimal: "123456789012345678901234567890",
                    cert_version: pearl.PEARL_CERT_VERSION
                },
                params: {
                    jackpot: "ab".repeat(32),
                    adjustment_factor: 7,
                    pearl_proof_id: "12".repeat(32),
                    plain_proof: proofBase64
                },
                replyFn(result, status) { response = { result, status }; }
            });
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
        assert.equal(request.method, "submitPlainProof");
        assert.equal(request.params.plain_proof, proofBase64);
        assert.equal(response.status, 200);
        const data = response.result.error.data;
        assert.equal(data.pearl.job_id, "pearl-job");
        assert.equal(data.pearl.proof_id, "12".repeat(32));
        assert.equal(data.pearl.proof_sha256, crypto.createHash("sha256").update(proof).digest("hex"));
        assert.equal(data.pearl.proof_base64_chars, proofBase64.length);
        assert.equal(data.pearl.target_decimal, "123456789012345678901234567890");
        assert.equal(data.pearl.target_is_safe_integer, false);
        assert.equal(data.pearl.jackpot, "ab".repeat(32));
        assert.equal(data.pearl.adjustment_factor, 7);
        assert.equal(data.gateway_response.truncated, true);
        assert.ok(data.gateway_response.bytes > 4096);
        assert.ok(data.gateway_response.preview.length <= 4096);
        const logged = JSON.stringify(response.result);
        assert.equal(logged.includes(proofBase64), false);
        assert.equal(logged.includes("plain_proof"), false);
    });

    test("adds Pearl diagnostics to accepted and transport-failed gateway results", () => {
        const proof = Buffer.from("winning-proof").toString("base64");
        const originalGatewayRequest = pearl.gatewayRequest;
        const replies = [];
        const context = {
            blockData: proof,
            job: {
                id: "pearl-job",
                incomplete_header_bytes: Buffer.alloc(pearl.PEARL_HEADER_BYTES).toString("base64"),
                gatewayTarget: 123,
                targetDecimal: "123",
                cert_version: pearl.PEARL_CERT_VERSION
            },
            params: { pearl_proof_id: "34".repeat(32) },
            replyFn(result, status) { replies.push({ result, status }); }
        };
        try {
            pearl.gatewayRequest = function accepted(_method, _params, callback) {
                callback(null, { result: { status: "accepted", block_hash: "ab".repeat(32) } });
            };
            pearlProfile.pool.submitBlockRpc.call(pearlProfile.pool, context);
            const transportError = new Error("connection reset\nwith control text");
            transportError.code = "ECONNRESET";
            pearl.gatewayRequest = function failed(_method, _params, callback) { callback(transportError); };
            pearlProfile.pool.submitBlockRpc.call(pearlProfile.pool, context);
        } finally {
            pearl.gatewayRequest = originalGatewayRequest;
        }
        assert.equal(replies[0].status, 200);
        assert.equal(replies[0].result.pearl_diagnostic.proof_id, "34".repeat(32));
        assert.equal(replies[1].status, 0);
        assert.equal(replies[1].result.error.data.transport.code, "ECONNRESET");
        assert.equal(replies[1].result.error.data.pearl.proof_id, "34".repeat(32));
        assert.equal(JSON.stringify(replies).includes(proof), false);
    });
});
