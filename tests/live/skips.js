"use strict";
const { DEFAULT_TARGET_HOST } = require("./shared.js");

const EXPECTED_LIVE_MINER_SKIP_REASONS = new Set(["no-accepted-share"]);

function expectedLiveMinerSkipReason(target) {
    if (!target || target.success) return "";
    if (
        target.algorithm === "autolykos2"
        && target.host !== DEFAULT_TARGET_HOST
        && target.failureReason === "rejected-share"
        && target.acceptedShares === 0
        && target.disconnects > 0
    ) {
        return "remote autolykos2 endpoint rejected or disconnected before an accepted share";
    }
    if (!EXPECTED_LIVE_MINER_SKIP_REASONS.has(target.failureReason)) return "";
    return "no accepted share before timeout on this host";
}

function expectedLiveProtocolProbeSkipReason(target) {
    if (!target || target.success) return "";
    return target.protocolProbe
        && target.failureReason === "job-timeout"
        && target.connected
        && !target.jobReceived
        ? `live pool did not send a protocol-probe job for ${target.algorithm}`
        : "";
}

module.exports = {
    expectedLiveMinerSkipReason,
    expectedLiveProtocolProbeSkipReason
};
