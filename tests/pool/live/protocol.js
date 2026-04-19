"use strict";

const crypto = require("node:crypto");
const { once } = require("node:events");
const net = require("node:net");
const readline = require("node:readline");
const { setTimeout: delay } = require("node:timers/promises");
const tls = require("node:tls");

const {
    DEFAULT_WALLET,
    BASE_DIFF,
    postJson,
    readTextFileIfExists,
    isTcpReachable
} = require("./shared.js");

const PROTOCOL_PROBES = {
    "eth-bad-share": {
        authorize({ user, password }, id) {
            return { id, method: "mining.authorize", params: [user, password] };
        },
        submit({ user }, metrics, id) {
            return { id, method: "mining.submit", params: buildBadEthSubmitParams(user, metrics.jobId) };
        },
        useSubscribe: true
    },
    "login-bad-share": {
        authorize({ wallet, password, worker }, id) {
            return {
                id,
                jsonrpc: "2.0",
                method: "login",
                params: {
                    login: wallet,
                    pass: password,
                    agent: "nodejs-pool-live-probe/1.0",
                    rigid: worker
                }
            };
        },
        submit(_context, metrics, id) {
            return { id, method: "submit", params: buildBadLoginSubmitParams(metrics.loginId, metrics.jobId) };
        },
        useSubscribe: false
    }
};

function createProbeSocket(config, target) {
    return config.tls
        ? tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false })
        : net.createConnection({ host: target.host, port: target.port });
}

function writeProtocolLine(stream, direction, message) {
    stream.write(`${direction} ${message}\n`);
}

function sendProtocolJson(socket, stream, payload) {
    const line = JSON.stringify(payload);
    writeProtocolLine(stream, ">", line);
    socket.write(`${line}\n`);
}

function parseProtocolLines(buffer, chunk) {
    const lines = `${buffer}${chunk}`.split(/\r?\n/);
    return { lines: lines.slice(0, -1).filter(Boolean), buffer: lines[lines.length - 1] || "" };
}

class JsonLineSocketClient {
    constructor(config, target, logStream, errorStream) {
        this.config = config;
        this.target = target;
        this.logStream = logStream;
        this.errorStream = errorStream;
        this.socket = null;
        this.lineBuffer = "";
        this.messages = [];
        this.waiters = [];
    }

    async connect(timeoutMs) {
        this.socket = createProbeSocket(this.config, this.target);
        this.socket.setEncoding("utf8");
        this.socket.setTimeout(timeoutMs);

        await new Promise((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onTimeout = () => {
                cleanup();
                reject(new Error("Socket timeout before connect"));
            };
            const cleanup = () => {
                this.socket.off(this.config.tls ? "secureConnect" : "connect", onReady);
                this.socket.off("error", onError);
                this.socket.off("timeout", onTimeout);
            };

            this.socket.once(this.config.tls ? "secureConnect" : "connect", onReady);
            this.socket.once("error", onError);
            this.socket.once("timeout", onTimeout);
        });

        this.socket.on("data", (chunk) => {
            const parsed = parseProtocolLines(this.lineBuffer, chunk);
            this.lineBuffer = parsed.buffer;
            for (const line of parsed.lines) {
                if (this.logStream) writeProtocolLine(this.logStream, "<", line);
                try {
                    this.messages.push(JSON.parse(line));
                    this.flushWaiters();
                } catch (error) {
                    if (this.errorStream) this.errorStream.write(`${error.stack || error.message}\n`);
                }
            }
        });
        this.socket.on("error", (error) => {
            if (this.errorStream) this.errorStream.write(`${error.stack || error.message}\n`);
        });
    }

    flushWaiters() {
        for (let index = 0; index < this.waiters.length; ) {
            const waiter = this.waiters[index];
            const messageIndex = this.messages.findIndex(waiter.predicate);
            if (messageIndex === -1) {
                index += 1;
                continue;
            }
            const [message] = this.messages.splice(messageIndex, 1);
            clearTimeout(waiter.timer);
            this.waiters.splice(index, 1);
            waiter.resolve(message);
        }
    }

    async request(payload, timeoutMs, predicate) {
        const matcher = predicate || ((message) => message && message.id === payload.id);
        const responsePromise = this.waitFor(matcher, timeoutMs);
        sendProtocolJson(this.socket, this.logStream, payload);
        return await responsePromise;
    }

    waitFor(predicate, timeoutMs) {
        const existingIndex = this.messages.findIndex(predicate);
        if (existingIndex !== -1) {
            const [message] = this.messages.splice(existingIndex, 1);
            return Promise.resolve(message);
        }

        return awaitableWait(predicate, timeoutMs, this);
    }

    async close() {
        if (!this.socket) return;
        const socket = this.socket;
        this.socket = null;
        if (socket.destroyed) return;
        await new Promise((resolve) => {
            socket.once("close", resolve);
            socket.end();
        }).catch(() => {});
    }
}

function awaitableWait(predicate, timeoutMs, client) {
    return new Promise((resolve, reject) => {
        const waiter = {
            predicate,
            resolve,
            timer: setTimeout(() => {
                client.waiters = client.waiters.filter((entry) => entry !== waiter);
                reject(new Error(`Timed out waiting for protocol message from ${client.target.host}:${client.target.port}`));
            }, timeoutMs)
        };
        client.waiters.push(waiter);
    });
}

function buildBadEthSubmitParams(user, jobId) {
    return [
        user,
        jobId,
        `0x${crypto.randomBytes(8).toString("hex")}`,
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`
    ];
}

function buildBadLoginSubmitParams(loginId, jobId) {
    return {
        id: loginId || "",
        job_id: jobId || "",
        nonce: crypto.randomBytes(4).toString("hex"),
        result: "00".repeat(32)
    };
}

function buildPoolEndpointProbePayload(requestId) {
    return {
        id: requestId,
        jsonrpc: "2.0",
        method: "getjob",
        params: { id: "nodejs-pool-live-reachability" }
    };
}

function isPoolEndpointResponse(message, requestId) {
    return !!message
        && typeof message === "object"
        && message.id === requestId
        && message.jsonrpc === "2.0"
        && message.result === null
        && message.error
        && message.error.code === -1
        && message.error.message === "Unauthenticated";
}

async function isPoolEndpointReachable(host, port, useTls, timeoutMs = 1500) {
    if (!(await isTcpReachable(host, port))) return false;
    const socket = createProbeSocket({ tls: useTls }, { host, port });
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    try {
        socket.setEncoding("utf8");
        if (!(await Promise.race([once(socket, useTls ? "secureConnect" : "connect"), delay(timeoutMs, null, { ref: false })]))) {
            return false;
        }
        socket.write(`${JSON.stringify(buildPoolEndpointProbePayload(1))}\n`);
        const line = await Promise.race([once(rl, "line"), delay(timeoutMs, null, { ref: false })]);
        return !!line && isPoolEndpointResponse(JSON.parse(line[0]), 1);
    } catch (_error) {
        return false;
    } finally {
        rl.close();
        socket.destroy();
    }
}

const hasGpuProtocolProbe = (plan) => !plan.miner && !!plan.protocolProbe;
const BLOCK_SUBMIT_ATTEMPT_TIMEOUT_MS = 15000;

function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bigIntToLittleHex(value, size = 32) {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    hex = hex.padStart(size * 2, "0").slice(-size * 2);
    return Buffer.from(hex, "hex").reverse().toString("hex");
}

function buildResultHexForDifficulty(diff) {
    const normalized = BigInt(diff);
    if (normalized <= 0n) return "00".repeat(32);
    const target = BASE_DIFF / normalized;
    return bigIntToLittleHex(target);
}

function parseLatestTemplateSnapshot(logText, chainPrefix) {
    const matcher = new RegExp(`Template: [^\\n]*chain=(${escapeRegExp(chainPrefix)}[^\\s]*)[^\\n]*diff=([0-9]+)(?:/([0-9]+))?`, "g");
    let match;
    let lastMatch = null;
    while ((match = matcher.exec(logText)) !== null) lastMatch = match;
    if (!lastMatch) return null;
    return {
        chain: lastMatch[1],
        primaryDiff: BigInt(lastMatch[2]),
        secondaryDiff: lastMatch[3] ? BigInt(lastMatch[3]) : null
    };
}

function buildCandidateMatrix(resultHexes, loginDiffs) {
    const candidates = [];
    for (const resultHex of resultHexes) {
        for (const loginDiff of loginDiffs) candidates.push({ loginDiff, resultHex });
    }
    return candidates;
}

function buildXmrOnlyResultHexes(xmrTemplate) {
    if (!xmrTemplate || !xmrTemplate.secondaryDiff || xmrTemplate.secondaryDiff <= 1n) {
        throw new Error("Could not determine XTM difficulty from the pool stderr template log.");
    }
    const candidates = [
        xmrTemplate.secondaryDiff - 1n,
        xmrTemplate.secondaryDiff / 2n,
        xmrTemplate.secondaryDiff / 4n,
        xmrTemplate.secondaryDiff / 8n,
        xmrTemplate.secondaryDiff / 16n
    ].filter((value) => value > 0n);
    return Array.from(new Set(candidates.map((value) => buildResultHexForDifficulty(value))));
}

function buildLowDiffResultHexes(xmrTemplate) {
    if (!xmrTemplate || !xmrTemplate.primaryDiff || xmrTemplate.primaryDiff <= 1n) {
        throw new Error("Could not determine XMR difficulty from the pool template log.");
    }
    const candidates = [
        xmrTemplate.primaryDiff - 1n,
        xmrTemplate.primaryDiff / 2n,
        xmrTemplate.primaryDiff / 4n,
        xmrTemplate.primaryDiff / 8n
    ].filter((value) => value > 0n);
    return Array.from(new Set(candidates.map((value) => buildResultHexForDifficulty(value))));
}

async function readLocalXmrTemplateMetadata() {
    const body = await postJson("http://127.0.0.1:18081/json_rpc", {
        jsonrpc: "2.0",
        id: "0",
        method: "getblocktemplate",
        params: {
            reserve_size: 17,
            wallet_address: DEFAULT_WALLET
        }
    });
    if (!body || !body.result) throw new Error(`Invalid getblocktemplate response: ${JSON.stringify(body)}`);
    return {
        mainDifficulty: BigInt(body.result.mbl_difficulty || body.result.difficulty || 0)
    };
}

function getBlockSubmitOutcomeEntries(text, worker) {
    const entries = [];
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
        if (
            !line.includes("Block submit failed:")
            && !line.includes("Block submit unknown:")
            && !line.includes("Block submit rpc-error:")
            && !line.includes("Block hash unresolved:")
            && !line.includes("Block found:")
        ) continue;

        const chainMatch = /chain=([^\s,]+)/.exec(line);
        const minerMatch = /miner="([^"]+)"/.exec(line);
        if (!chainMatch || !minerMatch) continue;

        const miner = minerMatch[1];
        if (worker && !miner.includes(`:${worker} `) && !miner.includes(`:${worker}(`) && !miner.includes(worker)) continue;

        if (line.includes("Block submit failed:")) {
            entries.push({ kind: "failed", chain: chainMatch[1], miner });
            continue;
        }
        if (line.includes("Block submit unknown:")) {
            entries.push({ kind: "unknown", chain: chainMatch[1], miner });
            continue;
        }
        if (line.includes("Block submit rpc-error:")) {
            entries.push({ kind: "rpc-error", chain: chainMatch[1], miner });
            continue;
        }
        if (line.includes("Block hash unresolved:")) {
            entries.push({ kind: "unresolved-hash", chain: chainMatch[1], miner });
            continue;
        }
        if (
            line.includes("Block found:")
            && (
                line.includes('"result":false')
                || line.includes('"result":"invalid"')
                || line.includes('"result":"high-hash"')
                || line.includes('"response":"rejected"')
                || line.includes('"error":')
            )
        ) {
            entries.push({ kind: "rejected", chain: chainMatch[1], miner });
        }
    }
    return entries;
}

function matchesBlockSubmitExpectation(logText, expectation, worker) {
    const outcomes = getBlockSubmitOutcomeEntries(logText, worker);
    if (expectation.exactFailureCount && outcomes.length !== expectation.exactFailureCount) return false;
    if (!expectation.exactFailureCount && expectation.minFailureCount && outcomes.length < expectation.minFailureCount) return false;

    const chains = outcomes.map((entry) => entry.chain);
    if (expectation.includeChains && expectation.includeChains.some((prefix) => !chains.some((chain) => chain.startsWith(prefix)))) return false;
    if (expectation.includeAnyChains && !expectation.includeAnyChains.some((prefix) => chains.some((chain) => chain.startsWith(prefix)))) return false;
    if (expectation.excludeChains && expectation.excludeChains.some((prefix) => chains.some((chain) => chain.startsWith(prefix)))) return false;
    return true;
}

function summarizeBlockSubmitLog(logText, worker) {
    const outcomes = getBlockSubmitOutcomeEntries(logText, worker);
    return {
        outcomeCount: outcomes.length,
        failureCount: outcomes.filter((entry) => entry.kind === "failed").length,
        unknownCount: outcomes.filter((entry) => entry.kind === "unknown").length,
        rpcErrorCount: outcomes.filter((entry) => entry.kind === "rpc-error").length,
        unresolvedHashCount: outcomes.filter((entry) => entry.kind === "unresolved-hash").length,
        rejectedCount: outcomes.filter((entry) => entry.kind === "rejected").length,
        chains: outcomes.map((entry) => entry.chain)
    };
}

function isSuccessfulSubmitResponse(message) {
    return !!message && !message.error && (message.result === true || message.result?.status === "OK");
}

function buildC29SubmitNonce(job) {
    const prefix = typeof job?.xn === "string" ? job.xn.toLowerCase() : "";
    return `${prefix}${"0".repeat(Math.max(0, 15 - prefix.length))}1`;
}

function buildDefaultBlockSubmitPayload(loginReply, resultHex) {
    const loginId = loginReply.result?.id || "";
    const job = loginReply.result?.job;
    if (!job || !job.job_id) throw new Error("Default login did not return a job for the block-submit attempt.");

    return {
        id: loginId,
        job_id: job.job_id,
        nonce: "00000001",
        result: resultHex
    };
}

function buildC29BlockSubmitPayload(loginReply, resultHex) {
    const loginId = loginReply.result?.id || "";
    const job = loginReply.result?.job;
    if (!job || !job.job_id) throw new Error("C29 login did not return a job for the block-submit attempt.");

    return {
        id: loginId,
        job_id: job.job_id,
        nonce: buildC29SubmitNonce(job),
        pow: Array.from({ length: 42 }, (_value, index) => index),
        result: resultHex,
        block_submit_test_result: resultHex
    };
}

function buildEthBlockSubmitParams(user, jobId, resultHex) {
    return [
        user,
        jobId,
        `0x${crypto.randomBytes(8).toString("hex")}`,
        `0x${"11".repeat(32)}`,
        `0x${"00".repeat(32)}`,
        `0x${resultHex}`
    ];
}

function buildRavenBlockSubmitParams(user, jobId, headerHash, resultHex) {
    if (!jobId || !headerHash) throw new Error("Kawpow notify payload did not include a job id and header hash.");
    return [
        user,
        jobId,
        "0x0000000000000001",
        `0x${headerHash}`,
        `0x${"ab".repeat(32)}`,
        `0x${resultHex}`
    ];
}

module.exports = {
    PROTOCOL_PROBES,
    createProbeSocket,
    writeProtocolLine,
    sendProtocolJson,
    parseProtocolLines,
    JsonLineSocketClient,
    isPoolEndpointReachable,
    hasGpuProtocolProbe,
    BLOCK_SUBMIT_ATTEMPT_TIMEOUT_MS,
    parseLatestTemplateSnapshot,
    buildCandidateMatrix,
    buildXmrOnlyResultHexes,
    buildLowDiffResultHexes,
    readLocalXmrTemplateMetadata,
    getBlockSubmitOutcomeEntries,
    matchesBlockSubmitExpectation,
    summarizeBlockSubmitLog,
    isSuccessfulSubmitResponse,
    buildDefaultBlockSubmitPayload,
    buildC29BlockSubmitPayload,
    buildEthBlockSubmitParams,
    buildRavenBlockSubmitParams
};
