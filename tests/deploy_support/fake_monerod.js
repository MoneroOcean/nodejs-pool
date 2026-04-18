#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HEADER_HEIGHT = 3653353;
const HEADER_HASH = "22d0e7db498d5c3c734d2fa2e17a414d2717fb1dcff80593e99627c57fb0dd71";
const HEADER_REWARD = 600000000000;
const OK = { status: "OK" };
const WALLET_BALANCE = { balance: 5000000000000, unlocked_balance: 5000000000000 };
const XMR_POOL_ADDRESS = process.env.POOL_DEPLOY_XMR_POOL_ADDRESS || "46yzCCD3Mza9tRj7aqPSaxVbbePtuAeKzf8Ky2eRtcXGcEgCg1iTBio6N4sPmznfgGEUGDoBz5CLxZ2XPTyZu1yoCAG7zt6";
const XMR_FEE_ADDRESS = process.env.POOL_DEPLOY_XMR_FEE_ADDRESS || "463tWEBn5XZJSxLU6uLQnQ2iY9xuNcDbjLSjkn3XAXHCbLrTTErJrBWYgHJQyrCwkNgYvyV3z8zctJLPCZy24jvb3NiTcTJ";
function arg(argv, names, fallback = "") {
    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        if (names.includes(current) && typeof argv[index + 1] !== "undefined") return argv[index + 1];
        const match = names.find((name) => current.startsWith(`${name}=`));
        if (match) return current.slice(match.length + 1);
    }
    return fallback;
}
function writeLog(logPath, line) {
    if (!logPath) return;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`);
}
function respond(res, payload) {
    const body = `${JSON.stringify(payload)}\n`;
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}
function encodeVarint(value) {
    let current = BigInt(value);
    const bytes = [];
    do {
        let byte = Number(current & 0x7fn);
        current >>= 7n;
        if (current > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (current > 0n);
    return Buffer.from(bytes);
}
function createBlockTemplate(height) {
    const extra = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(32, 0x33), Buffer.from([0x02, 17]), Buffer.alloc(17, 0)]);
    const blob = Buffer.concat([
        encodeVarint(1), encodeVarint(1), encodeVarint(0), Buffer.alloc(32, 0x11), Buffer.alloc(4, 0),
        encodeVarint(1), encodeVarint(0), encodeVarint(1), Buffer.from([0xff]), encodeVarint(height),
        encodeVarint(1), encodeVarint(0), Buffer.from([0x02]), Buffer.alloc(32, 0x22), encodeVarint(extra.length), extra, encodeVarint(0)
    ]);
    return { blocktemplate_blob: blob.toString("hex"), reserved_offset: blob.indexOf(Buffer.from([0x02, 17])) + 2 };
}
function createState(role) {
    const header = { hash: HEADER_HASH, height: HEADER_HEIGHT, timestamp: Math.floor(Date.now() / 1000), difficulty: 668862824694, reward: HEADER_REWARD };
    return {
        role,
        header,
        template: createBlockTemplate(HEADER_HEIGHT + 1),
        mergeMiningHash: Array.from(Buffer.alloc(32, 0x44)),
        vmKey: Array.from(Buffer.alloc(32, 0x55)),
        blockHashBytes: Array.from(Buffer.from(HEADER_HASH, "hex")),
        blockJson: JSON.stringify({ miner_tx: { vout: [{ amount: HEADER_REWARD }] } })
    };
}
function createTransferResult() {
    const now = Date.now().toString(16).padStart(16, "0");
    return { fee: 1000000000, tx_hash: `${now}${"a".repeat(64)}`.slice(0, 64), tx_key: `${now}${"b".repeat(64)}`.slice(0, 64) };
}
const rpcHeader = (header, powAlgo = 2) => ({ hash: header.hash, height: String(header.height), timestamp: String(header.timestamp), pow: { pow_algo: powAlgo } });
function runWalletCli(argv) {
    const walletPath = arg(argv, ["--generate-new-wallet"], path.join(process.cwd(), "wallet"));
    const address = path.basename(walletPath) === "wallet_fee" ? XMR_FEE_ADDRESS : XMR_POOL_ADDRESS;
    fs.mkdirSync(path.dirname(walletPath), { recursive: true });
    fs.writeFileSync(`${walletPath}.address.txt`, `${address}\n`);
    fs.writeFileSync(walletPath, "");
    process.stdout.write(`Seed for ${walletPath}\n${address}\n`);
}
function resultFor(state, method, payload) {
    const { header, template } = state;
    const powAlgo = Number(payload?.params?.algo?.pow_algo) || 0;

    if (state.role === "wallet-rpc") {
        if (method === "getbalance") return WALLET_BALANCE;
        if (method === "transfer") return createTransferResult();
        if (method === "get_version") return { version: 1 };
        return OK;
    }

    if (["getlastblockheader", "getblockheaderbyhash", "getblockheaderbyheight"].includes(method)) {
        return { block_header: header };
    }

    switch (method) {
    case "get_info":
        return { status: "OK", difficulty: header.difficulty, height: header.height, main_height: header.height, synchronized: true };
    case "getblock":
        return { block_header: header, json: state.blockJson };
    case "getblocktemplate":
        return { difficulty: header.difficulty, height: header.height + 1, prev_hash: header.hash, expected_reward: header.reward, status: "OK", ...template };
    case "submitblock":
        return OK;
    case "GetTipInfo":
        return { metadata: { best_block_height: String(header.height), best_block_hash: header.hash } };
    case "GetHeaderByHash":
        return { header: rpcHeader(header), reward: String(header.reward) };
    case "GetBlocks":
        return [{ block: { header: rpcHeader(header) } }];
    case "GetNewBlockTemplateWithCoinbases":
        return {
            block: { header: rpcHeader({ ...header, height: header.height + 1 }, powAlgo) },
            miner_data: { target_difficulty: String(header.difficulty), reward: String(header.reward) },
            merge_mining_hash: state.mergeMiningHash,
            vm_key: state.vmKey
        };
    case "SubmitBlock":
        return { ...OK, block_hash: state.blockHashBytes };
    default:
        return OK;
    }
}
const argv = process.argv.slice(2);
const invokedAs = path.basename(process.argv[1]);
if (invokedAs === "monero-wallet-cli") { runWalletCli(argv); process.exit(0); }
const defaultRole = { monerod: "monerod", "monero-wallet-rpc": "wallet-rpc" }[invokedAs] || "tari-proxy";
const role = arg(argv, ["--role"], defaultRole);
const dataDir = arg(argv, ["--data-dir"], "/home/monerodaemon/.bitmonero");
const defaultPort = role === "monerod"
    ? Number(process.env.POOL_DEPLOY_MONEROD_PORT || 18083)
    : role === "wallet-rpc" ? 18082 : 18081;
const port = Number(arg(argv, ["--port", "--rpc-bind-port"], defaultPort));
const logPath = arg(argv, ["--log-path"], role === "monerod" ? path.join(dataDir, "bitmonero.log") : "");
const state = createState(role);
if (logPath) {
    const emitSyncMarkers = () => ["Synced", "You are now synchronized with the network"].forEach((line) => writeLog(logPath, line));
    writeLog(logPath, `Starting fake ${role}`);
    emitSyncMarkers();
    setInterval(emitSyncMarkers, 5000);
}
const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        try {
            const payload = JSON.parse(chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}");
            const method = payload.method || "";
            writeLog(logPath, `RPC ${role} ${method || "(empty)"}`);
            respond(res, { id: payload.id || "0", jsonrpc: "2.0", result: resultFor(state, method, payload) });
        } catch (_error) {
            respond(res, { id: null, jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
        }
    });
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`fake-${role} listening on ${port}\n`));
["SIGINT", "SIGTERM"].forEach((signal) => process.on(signal, () => server.close(() => process.exit(0))));
