"use strict";
/** @typedef {{cacheKey: string, currentValue: unknown, nextValue: unknown, summary: string}} FixPlan */

/** @param {unknown} value */
function formatPreviewJson(value) { return JSON.stringify(value, null, 2) ?? "null"; }

/** @param {FixPlan} fixPlan */
function formatFixPlanPreview(fixPlan) {
    return [
        `In 10 seconds is going to change ${  fixPlan.cacheKey}`,
        "From:",
        formatPreviewJson(fixPlan.currentValue),
        "To:",
        formatPreviewJson(fixPlan.nextValue),
        `Summary: ${  fixPlan.summary}`
    ].join("\n");
}

module.exports = {
    formatFixPlanPreview
};
