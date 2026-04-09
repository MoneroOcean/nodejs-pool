"use strict";

const ETH_BASE_REWARD = 2;
const ETH_MULTIPLIER = 1000000000000000000;

function calcEthReward(block, txReceipts) {
    const gasPrices = {};
    block.transactions.forEach(function (tx) {
        gasPrices[tx.hash] = parseInt(tx.gasPrice);
    });
    let fee = 0;
    txReceipts.forEach(function (tx) {
        if (tx.result && tx.result.gasUsed) fee += parseInt(tx.result.gasUsed) * gasPrices[tx.result.transactionHash];
    });
    if (block.baseFeePerGas) fee -= parseInt(block.baseFeePerGas) * parseInt(block.gasUsed);
    return (ETH_BASE_REWARD + ETH_BASE_REWARD * (block.uncles.length / 32)) * ETH_MULTIPLIER + fee;
}

function calcErgReward(height, blockTx) {
    let reward = 0;
    if (blockTx.length && blockTx[0].outputs.length == 2 && blockTx[0].outputs[1].creationHeight == height) {
        reward += blockTx[0].outputs[1].value;
        reward -= blockTx[0].outputs[1].value >= 15000000000 ? 12000000000 : 3000000000;
    }
    if (blockTx.length > 1) {
        const lastTx = blockTx[blockTx.length - 1];
        if (lastTx.outputs.length == 1 && lastTx.outputs[0].creationHeight == height) {
            reward += lastTx.outputs[0].value;
        }
    }
    return reward;
}

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
    }
    return BigInt(value || 0);
}

function fromBuffer(buffer, options) {
    options = options || {};
    const normalized = options.endian === "little" ? Buffer.from(buffer).reverse() : Buffer.from(buffer);
    return BigInt(`0x${normalized.toString("hex") || "00"}`);
}

function toBuffer(value, options, base) {
    options = options || {};
    let hex = toBigInt(value, base).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    if (typeof options.size === "number") {
        if (hex.length < options.size * 2) hex = `${"00".repeat(options.size)}${hex}`.slice(-options.size * 2);
        else if (hex.length > options.size * 2) hex = hex.slice(0, options.size * 2);
    }
    const buffer = Buffer.from(hex || "00", "hex");
    return options.endian === "little" ? Buffer.from(buffer).reverse() : buffer;
}

function arr2hex(obj) {
    if (Array.isArray(obj)) {
        if (obj.every(function (item) { return typeof item === "number"; })) {
            return obj.map(function (n) { return n.toString(16).padStart(2, "0"); }).join("");
        }
        return obj.map(arr2hex);
    }
    if (obj !== null && typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) result[key] = arr2hex(value);
        return result;
    }
    return obj;
}

module.exports = {
    arr2hex: arr2hex,
    calcErgReward: calcErgReward,
    calcEthReward: calcEthReward,
    fromBuffer: fromBuffer,
    toBigInt: toBigInt,
    toBuffer: toBuffer
};
