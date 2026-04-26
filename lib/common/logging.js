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

function formatThreadName(options) {
    const opts = options || {};
    if (opts.single === true) return typeof opts.singlePrefix === "string" ? opts.singlePrefix : "(Single) ";
    if (opts.primary === true) return "[M] ";
    return "[S" + opts.workerId + ":" + opts.pid + "] ";
}

function createConsoleLogger(consoleApi, prefix) {
    const target = consoleApi || console;
    function getPrefix() {
        return typeof prefix === "function" ? prefix() : (prefix || "");
    }
    function formatPrefixed(label, fields) { return getPrefix() + formatLogEvent(label, fields); }
    return {
        logInfo(label, fields) { target.log(formatPrefixed(label, fields)); },
        logWarn(label, fields) { target.warn(formatPrefixed(label, fields)); },
        logError(label, fields) { target.error(formatPrefixed(label, fields)); }
    };
}

module.exports = {
    createConsoleLogger,
    formatLogEvent,
    formatLogFields,
    formatLogValue,
    formatThreadName
};
