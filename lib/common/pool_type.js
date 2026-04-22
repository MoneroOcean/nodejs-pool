"use strict";

module.exports = function poolTypeStr(poolType) {
    return poolType === global.protos.POOLTYPE.PPLNS ? "pplns" : "legacy";
};
