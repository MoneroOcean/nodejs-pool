"use strict";
/**
 * @typedef {{module: string, item: string, item_type: "int" | "bool" | "string" | "float", item_value: string}} ConfigRow
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isConfigModule(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} config
 * @param {ConfigRow[]} rows
 * @returns {void}
 */
module.exports = function applyConfigRows(config, rows) {
    rows.forEach(function applyConfigRow(row) {
        const existingConfig = config[row.module];
        /** @type {Record<string, unknown>} */
        const moduleConfig = isConfigModule(existingConfig) ? existingConfig : {};
        config[row.module] = moduleConfig;
        if (Object.prototype.hasOwnProperty.call(moduleConfig, row.item)) return;
        switch (row.item_type) {
        case "int": moduleConfig[row.item] = parseInt(row.item_value, 10); break;
        case "bool": moduleConfig[row.item] = row.item_value === "true"; break;
        case "string": moduleConfig[row.item] = row.item_value; break;
        case "float": moduleConfig[row.item] = parseFloat(row.item_value); break;
        }
    });
};
