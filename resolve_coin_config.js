"use strict";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the startup coin name once; core code receives definite metadata.
 * @param {unknown} startupConfig
 * @param {unknown} coinConfigs
 */
module.exports = function resolveCoinConfig(startupConfig, coinConfigs) {
    if (!isRecord(startupConfig) || !isRecord(coinConfigs)) throw new Error("Invalid coin configuration");
    const coinName = startupConfig["coin"];
    if (typeof coinName !== "string" || !Object.hasOwn(coinConfigs, coinName)) throw new Error("Unknown configured coin");
    const coin = coinConfigs[coinName];
    if (!isRecord(coin)) throw new Error("Invalid coin metadata");
    const funcFile = coin["funcFile"];
    const sigDigits = coin["sigDigits"];
    const name = coin["name"];
    const mixIn = coin["mixIn"];
    const shortCode = coin["shortCode"];
    if (typeof funcFile !== "string" || !funcFile ||
        typeof sigDigits !== "number" || !Number.isFinite(sigDigits) || sigDigits <= 0 ||
        typeof name !== "string" || typeof shortCode !== "string" ||
        typeof mixIn !== "number" || !Number.isSafeInteger(mixIn) || mixIn < 0) {
        throw new Error(`Invalid metadata for coin ${coinName}`);
    }
    return { ...coin, funcFile, sigDigits, name, mixIn, shortCode };
};
