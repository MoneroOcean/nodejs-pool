"use strict";

function formatPreviewJson(value) {
    return JSON.stringify(value, null, 2);
}

function formatFixPlanPreview(fixPlan) {
    return [
        "In 10 seconds is going to change " + fixPlan.cacheKey,
        "From:",
        formatPreviewJson(fixPlan.currentValue),
        "To:",
        formatPreviewJson(fixPlan.nextValue),
        "Summary: " + fixPlan.summary
    ].join("\n");
}

module.exports = {
    formatFixPlanPreview
};
