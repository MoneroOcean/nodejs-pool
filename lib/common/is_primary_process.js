"use strict";
/**
 * @param {{isPrimary?: boolean, isMaster?: boolean} | null | undefined} clusterApi
 * @returns {boolean}
 */
module.exports = function isPrimaryProcess(clusterApi) {
    if (!clusterApi) return false;
    if (typeof clusterApi.isPrimary === "boolean") return clusterApi.isPrimary;
    return clusterApi.isMaster === true;
};
