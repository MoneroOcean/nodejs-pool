"use strict";

module.exports = function applyConfigRows(config, rows) {
    rows.forEach(function applyConfigRow(row) {
        if (!Object.prototype.hasOwnProperty.call(config, row.module)) config[row.module] = {};
        if (Object.prototype.hasOwnProperty.call(config[row.module], row.item)) return;
        switch (row.item_type) {
        case "int": config[row.module][row.item] = parseInt(row.item_value, 10); break;
        case "bool": config[row.module][row.item] = row.item_value === "true"; break;
        case "string": config[row.module][row.item] = row.item_value; break;
        case "float": config[row.module][row.item] = parseFloat(row.item_value); break;
        }
    });
};
