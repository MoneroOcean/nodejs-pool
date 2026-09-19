"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const pearl = require("../../../lib/coins/core/pearl.js");
const pearlProfile = require("../../../lib/coins/pearl.js");

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
        assert.deepEqual(payload, {
            header: header.toString("hex"),
            height: 123,
            job_id: "pearl-job",
            target: pearl.targetForDifficulty(2).targetHex,
            difficulty: 2,
            cert_version: pearl.PEARL_CERT_VERSION
        });
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
});
