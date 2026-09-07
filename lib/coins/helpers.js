"use strict";
const ETH_BASE_REWARD = 2; // ETH static block reward, in whole ETH
const ETH_MULTIPLIER = 1000000000000000000; // 1 ETH expressed in wei
const ERG_REEMISSION_TOKEN_ID = "d9a2cc8a09abfaed87afacfbb7daee79a6b26f10c6613fc13d3f3953e5521d1a";
const ERG_NANO = 1000000000;

/** @typedef {{transactions: {hash: string, gasPrice: string}[], baseFeePerGas?: string, gasUsed: string, uncles: unknown[]}} EthRewardBlock */
/** @typedef {{endian?: "little" | "big", size?: number}} BufferOptions */
/** @typedef {bigint | number | string | boolean | Buffer | {value?: bigint, toString(radix?: number): string, toBuffer?: (options: BufferOptions) => Buffer} | null | undefined} BigIntInput */

/** @param {EthRewardBlock} block @param {{result?: {gasUsed: string, transactionHash: string}}[]} txReceipts @param {number} [baseReward] */
function calcEthReward(block, txReceipts, baseReward) {
    const blockBaseReward = baseReward === undefined ? ETH_BASE_REWARD : baseReward;
    /** @type {Record<string, number>} */
    const gasPrices = Object.create(null);
    block.transactions.forEach(function (tx) {
        gasPrices[tx.hash] = parseInt(tx.gasPrice);
    });
    let fee = 0;
    txReceipts.forEach(function (tx) {
        if (!tx.result || !tx.result.gasUsed) return;
        // An unmatched receipt makes the reward invalid, as it cannot be priced.
        const gasPrice = gasPrices[tx.result.transactionHash] ?? NaN;
        fee += parseInt(tx.result.gasUsed) * gasPrice;
    });
    // Post-London: the base fee portion of every tx is burned, so subtract it from collected fees.
    if (block.baseFeePerGas) fee -= parseInt(block.baseFeePerGas) * parseInt(block.gasUsed);
    // Each included uncle adds 1/32 of the base reward to the miner.
    return (blockBaseReward + blockBaseReward * (block.uncles.length / 32)) * ETH_MULTIPLIER + fee;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {number} height @param {unknown} blockTx */
function calcErgReward(height, blockTx) {
    if (!Array.isArray(blockTx) || !isRecord(blockTx[0])) return null;
    const outputs = blockTx[0]["outputs"];
    if (!Array.isArray(outputs) || outputs.length !== 2) return null;
    const rewardOutput = outputs[1];
    if (!isRecord(rewardOutput) || rewardOutput["creationHeight"] !== height) return null;
    const emission = Number(rewardOutput["value"]);
    const assets = rewardOutput["assets"];
    if (!Number.isSafeInteger(emission) || emission <= 0 || !Array.isArray(assets)) return null;
    const reemissionToken = assets.find(asset => isRecord(asset) && asset["tokenId"] === ERG_REEMISSION_TOKEN_ID);
    if (!isRecord(reemissionToken)) return null;

    const onChainReemission = Number(reemissionToken["amount"]);
    const expectedReemission = emission >= 15 * ERG_NANO ? 12 * ERG_NANO : Math.max(0, emission - 3 * ERG_NANO);
    // The daemon's re-emission token independently encodes the EIP-27 cut.
    if (!Number.isSafeInteger(onChainReemission) || onChainReemission < 0
        || onChainReemission > emission || onChainReemission !== expectedReemission) return null;

    let reward = emission - onChainReemission;
    if (blockTx.length > 1) {
        const lastTx = blockTx.at(-1);
        if (!isRecord(lastTx)) return null;
        const feeOutputs = lastTx["outputs"];
        if (Array.isArray(feeOutputs) && feeOutputs.length === 1) {
            const feeOutput = feeOutputs[0];
            if (!isRecord(feeOutput)) return null;
            if (feeOutput["creationHeight"] === height) {
                const fees = Number(feeOutput["value"]);
                if (!Number.isSafeInteger(fees) || fees < 0 || !Number.isSafeInteger(reward + fees)) return null;
                reward += fees;
            }
        }
    }
    return reward;
}

/** @param {number} height */

function calcEtcBaseReward(height) {
    if (!Number.isSafeInteger(height) || height < 1) return null;
    const era = Math.floor((height - 1) / 5000000);
    return 5 * (4 ** era) / (5 ** era);
}

/** @param {BigIntInput} value @param {number} [base] */
function toBigInt(value, base) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string") return BigInt(base === 16 ? `0x${value}` : value);
    if (Buffer.isBuffer(value)) return BigInt(`0x${value.toString("hex") || "00"}`);
    if (value && typeof value === "object") {
        if (typeof value.value === "bigint") return value.value;
        if (typeof value.toString === "function") {
            const stringValue = value.toString(base || 10);
            return BigInt(base === 16 ? `0x${stringValue}` : stringValue);
        }
        if (typeof value.toBuffer === "function") return fromBuffer(value.toBuffer({ endian: "big" }));
        throw new TypeError("Unsupported integer object");
    }
    return BigInt(value || 0);
}

/** @param {Uint8Array} buffer @param {BufferOptions} [options] */
function fromBuffer(buffer, options) {
    const opts = options || {};
    const normalized = opts.endian === "little" ? Buffer.from(buffer).reverse() : Buffer.from(buffer);
    // "|| 00" guards an empty buffer, since BigInt("0x") would throw.
    return BigInt(`0x${normalized.toString("hex") || "00"}`);
}

/** @param {BigIntInput} value @param {BufferOptions} [options] @param {number} [base] */
function toBuffer(value, options, base) {
    const opts = options || {};
    let hex = toBigInt(value, base).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    // opts.size fixes the output to exactly that many bytes: left-pad with zeros or drop the low bytes.
    if (typeof opts.size === "number") {
        if (hex.length < opts.size * 2) hex = `${"00".repeat(opts.size)}${hex}`.slice(-opts.size * 2);
        else if (hex.length > opts.size * 2) hex = hex.slice(0, opts.size * 2);
    }
    const buffer = Buffer.from(hex || "00", "hex");
    return opts.endian === "little" ? Buffer.from(buffer).reverse() : buffer;
}

/** @param {unknown} obj @returns {unknown} */
function arr2hex(obj) {
    if (Array.isArray(obj)) {
        if (obj.every(function (item) { return typeof item === "number"; })) {
            return obj.map(function (n) { return n.toString(16).padStart(2, "0"); }).join("");
        }
        return obj.map(arr2hex);
    }
    if (obj !== null && typeof obj === "object") {
        /** @type {Record<string, unknown>} */
        const result = {};
        for (const [key, value] of Object.entries(obj)) result[key] = arr2hex(value);
        return result;
    }
    return obj;
}

module.exports = {
    arr2hex,
    calcEtcBaseReward,
    calcErgReward,
    calcEthReward,
    fromBuffer,
    toBigInt,
    toBuffer
};
