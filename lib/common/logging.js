"use strict";
/** @typedef {Record<string, unknown>} LogFields */
/** @typedef {{single?: boolean, singlePrefix?: string, primary?: boolean, workerId?: string | number | undefined, pid?: string | number | undefined}} ThreadOptions */
/** @typedef {{log: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void}} ConsoleLike */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function formatLogValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        if (value === "") return null;
        // Emit bare only for tokens free of spaces/quotes (which would break key=value parsing); otherwise JSON-quote.
        return /^[A-Za-z0-9._:/%+-]+$/.test(value) ? value : JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return String(value);
    }
}

/**
 * @param {LogFields | null | undefined} fields
 * @returns {string}
 */
function formatLogFields(fields) {
    if (!fields || typeof fields !== "object") return "";
    /** @type {string[]} */
    const parts = [];
    Object.keys(fields).forEach(function appendField(key) {
        const value = formatLogValue(fields[key]);
        if (value === null) return;
        parts.push(`${key  }=${  value}`);
    });
    return parts.join(" ");
}

/**
 * @param {string} label
 * @param {string | LogFields | null | undefined} fields
 * @returns {string}
 */
function formatLogEvent(label, fields) {
    if (typeof fields === "string") return `${label  }: ${  fields}`;
    const suffix = formatLogFields(fields);
    return suffix ? `${label  }: ${  suffix}` : label;
}

/**
 * @param {ThreadOptions | undefined} options
 * @returns {string}
 */
function formatThreadName(options) {
    const opts = options || {};
    if (opts.single === true) return typeof opts.singlePrefix === "string" ? opts.singlePrefix : "(Single) ";
    if (opts.primary === true) return "[M] ";
    return `[S${  opts.workerId  }:${  opts.pid  }] `;
}

/**
 * @param {ConsoleLike | undefined} consoleApi
 * @param {string | (() => string) | undefined} prefix
 * @returns {{logInfo: (label: string, fields?: string | LogFields) => void, logWarn: (label: string, fields?: string | LogFields) => void, logError: (label: string, fields?: string | LogFields) => void}}
 */
function createConsoleLogger(consoleApi, prefix) {
    const target = consoleApi || console;
    /** @returns {string} */
    function getPrefix() {
        return typeof prefix === "function" ? prefix() : (prefix || "");
    }
    /** @param {string} label @param {string | LogFields | undefined} fields @returns {string} */
    function formatPrefixed(label, fields) { return getPrefix() + formatLogEvent(label, fields); }
    return {
        /** @param {string} label @param {string | LogFields | undefined} fields @returns {void} */
        logInfo(label, fields) { target.log(formatPrefixed(label, fields)); },
        /** @param {string} label @param {string | LogFields | undefined} fields @returns {void} */
        logWarn(label, fields) { target.warn(formatPrefixed(label, fields)); },
        /** @param {string} label @param {string | LogFields | undefined} fields @returns {void} */
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
