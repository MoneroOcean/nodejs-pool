"use strict";
const fs = require("node:fs");
const { DEFAULT_TARGET_HOST } = require("./shared.js");

const EXPECTED_LIVE_MINER_SKIP_REASONS = new Set(["no-accepted-share"]);
const NO_BLOCK_TEMPLATE_MESSAGE = "No block template yet. Please wait.";

function targetHasDetail(target, text) {
    if (String(target && target.error || "").includes(text)) return true;
    if (!target || typeof target.rawStdoutPath !== "string" || !target.rawStdoutPath) return false;
    try {
        return fs.readFileSync(target.rawStdoutPath, "utf8").includes(text);
    } catch (_error) {
        return false;
    }
}

function expectedLiveMinerSkipReason(target) {
    if (!target || target.success) return "";
    if (
        target.algorithm === "rx/arq"
        && !target.jobReceived
        && (target.failureReason === "job-timeout" || target.failureReason === "connection-failure")
        && targetHasDetail(target, NO_BLOCK_TEMPLATE_MESSAGE)
    ) {
        return "live pool did not have an rx/arq block template ready";
    }
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
