"use strict";
const ETH_BASE_REWARD = 2; // ETH static block reward, in whole ETH
const ETH_MULTIPLIER = 1000000000000000000; // 1 ETH expressed in wei
const ERG_REEMISSION_TOKEN_ID = "d9a2cc8a09abfaed87afacfbb7daee79a6b26f10c6613fc13d3f3953e5521d1a";
const ERG_NANO = 1000000000;

function calcEthReward(block, txReceipts, baseReward) {
    const blockBaseReward = baseReward === undefined ? ETH_BASE_REWARD : baseReward;
    const gasPrices = {};
    block.transactions.forEach(function (tx) {
        gasPrices[tx.hash] = parseInt(tx.gasPrice);
    });
    let fee = 0;
    txReceipts.forEach(function (tx) {
        if (tx.result && tx.result.gasUsed) fee += parseInt(tx.result.gasUsed) * gasPrices[tx.result.transactionHash];
    });
    // Post-London: the base fee portion of every tx is burned, so subtract it from collected fees.
    if (block.baseFeePerGas) fee -= parseInt(block.baseFeePerGas) * parseInt(block.gasUsed);
    // Each included uncle adds 1/32 of the base reward to the miner.
    return (blockBaseReward + blockBaseReward * (block.uncles.length / 32)) * ETH_MULTIPLIER + fee;
}

function calcErgReward(height, blockTx) {
    if (!Array.isArray(blockTx) || !blockTx.length || !Array.isArray(blockTx[0].outputs)
        || blockTx[0].outputs.length !== 2 || blockTx[0].outputs[1].creationHeight !== height) return null;

    const rewardOutput = blockTx[0].outputs[1];
    const emission = Number(rewardOutput.value);
    if (!Number.isSafeInteger(emission) || emission <= 0 || !Array.isArray(rewardOutput.assets)) return null;

    const reemissionToken = rewardOutput.assets.find(function findReemissionToken(asset) {
        return asset && asset.tokenId === ERG_REEMISSION_TOKEN_ID;
    });
    if (!reemissionToken) return null;

    const onChainReemission = Number(reemissionToken.amount);
    const expectedReemission = emission >= 15 * ERG_NANO ? 12 * ERG_NANO : Math.max(0, emission - 3 * ERG_NANO);
    // The token amount is supplied by our canonical Ergo daemon and independently encodes the
    // EIP-27 re-emission cut. Fail closed if it disagrees with the expected emission schedule.
    if (!Number.isSafeInteger(onChainReemission) || onChainReemission < 0
        || onChainReemission > emission || onChainReemission !== expectedReemission) return null;

    let reward = emission - onChainReemission;
    if (blockTx.length > 1) {
        const lastTx = blockTx[blockTx.length - 1];
        if (Array.isArray(lastTx.outputs) && lastTx.outputs.length === 1 && lastTx.outputs[0].creationHeight === height) {
            const fees = Number(lastTx.outputs[0].value);
            if (!Number.isSafeInteger(fees) || fees < 0) return null;
            reward += fees;
        }
    }
    return reward;
}

function calcEtcBaseReward(height) {
    if (!Number.isSafeInteger(height) || height < 1) return null;
    const era = Math.floor((height - 1) / 5000000);
    return 5 * (4 ** era) / (5 ** era);
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
    const opts = options || {};
    const normalized = opts.endian === "little" ? Buffer.from(buffer).reverse() : Buffer.from(buffer);
    // "|| 00" guards an empty buffer, since BigInt("0x") would throw.
    return BigInt(`0x${normalized.toString("hex") || "00"}`);
}

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
    arr2hex,
    calcEtcBaseReward,
    calcErgReward,
    calcEthReward,
    fromBuffer,
    toBigInt,
    toBuffer
};
