"use strict";
/**
 * @param {number} poolType
 * @returns {"pplns" | "legacy"}
 */
module.exports = function poolTypeStr(poolType) {
    return poolType === global.protos.POOLTYPE.PPLNS ? "pplns" : "legacy";
};
