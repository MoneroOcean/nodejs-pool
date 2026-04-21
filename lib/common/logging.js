"use strict";

function formatLogValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        if (value === "") return null;
        return /^[A-Za-z0-9._:/%+-]+$/.test(value) ? value : JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return String(value);
    }
}

function formatLogFields(fields) {
    if (!fields || typeof fields !== "object") return "";
    const parts = [];
    Object.keys(fields).forEach(function appendField(key) {
        const value = formatLogValue(fields[key]);
        if (value === null) return;
        parts.push(key + "=" + value);
    });
    return parts.join(" ");
}

function formatLogEvent(label, fields) {
    if (typeof fields === "string") return label + ": " + fields;
    const suffix = formatLogFields(fields);
    return suffix ? label + ": " + suffix : label;
}

function createConsoleLogger(consoleApi) {
    const target = consoleApi || console;
    return {
        logInfo(label, fields) { target.log(formatLogEvent(label, fields)); },
        logWarn(label, fields) { target.warn(formatLogEvent(label, fields)); },
        logError(label, fields) { target.error(formatLogEvent(label, fields)); }
    };
}

module.exports = {
    createConsoleLogger,
    formatLogEvent,
    formatLogFields,
    formatLogValue
};
