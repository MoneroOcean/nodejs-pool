"use strict";

const SENSITIVE_FAILURE_DELAY_MS = 2 * 1000;
const SENSITIVE_FAILURE_RETENTION_MS = 10 * 60 * 1000;
const MAX_SENSITIVE_FAILURE_KEYS = 5000;

module.exports = function registerAccountRoutes(ctx) {
    const {
        core,
        http
    } = ctx;
    const { config, getCacheValue, now, query, support } = core;
    const { app, registerJsonRoute, sendJson } = http;
    const sensitiveFailures = new Map();

    function getBody(req) { return req.body && typeof req.body === "object" ? req.body : {}; }

    function requireBodyFields(req, res, names) {
        const body = getBody(req);
        for (const name of names) {
            if (!(name in body)) {
                sendJson(res, 401, { success: false, msg: "No \"" + name + "\" parameter was found" });
                return null;
            }
        }
        return body;
    }

    function timeNow() { return typeof now === "function" ? now() : Date.now(); }

    function sensitiveKey(username) {
        const value = typeof username === "string" ? username.trim() : "";
        return value ? value : null;
    }

    function pruneSensitiveFailures(time) {
        for (const [key, entry] of sensitiveFailures) {
            if (entry.expiresAt <= time || entry.nextAllowedAt <= time - SENSITIVE_FAILURE_RETENTION_MS) sensitiveFailures.delete(key);
        }
        while (sensitiveFailures.size > MAX_SENSITIVE_FAILURE_KEYS) {
            const first = sensitiveFailures.keys().next();
            if (first.done) break;
            sensitiveFailures.delete(first.value);
        }
    }

    function throttlePayload(waitMs) {
        return {
            success: false,
            msg: "Too many attempts. Try again in " + Math.ceil(waitMs / 1000) + " seconds."
        };
    }

    function acquireSensitiveAttempt(key) {
        if (!key) return null;
        const time = timeNow();
        const entry = sensitiveFailures.get(key);
        if (entry && entry.nextAllowedAt > time) return throttlePayload(entry.nextAllowedAt - time);
        sensitiveFailures.set(key, {
            nextAllowedAt: time + SENSITIVE_FAILURE_DELAY_MS,
            expiresAt: time + SENSITIVE_FAILURE_RETENTION_MS
        });
        if (sensitiveFailures.size > MAX_SENSITIVE_FAILURE_KEYS) pruneSensitiveFailures(time);
    }

    function clearSensitiveFailure(key) {
        if (key) sensitiveFailures.delete(key);
    }

    function renderUnsubscribeSuccess(wallet, email) {
        if (support && typeof support.renderUnsubscribeSuccessHtml === "function") {
            return support.renderUnsubscribeSuccessHtml(wallet, email);
        }
        return "<!doctype html><html><body><h1>Email unsubscribed</h1><p>Email notifications have been disabled.</p></body></html>";
    }

    function renderUnsubscribeError() {
        if (support && typeof support.renderUnsubscribeErrorHtml === "function") {
            return support.renderUnsubscribeErrorHtml();
        }
        return "<!doctype html><html><body><h1>Unable to unsubscribe</h1><p>This unsubscribe link is invalid or expired.</p></body></html>";
    }

    function sendHtml(res, statusCode, body) {
        res.status(statusCode).type("html").send(body);
    }

    function formatThresholdCoin(thresholdCoin) {
        const divisor = Number(config.general && config.general.sigDivisor);
        if (!Number.isInteger(thresholdCoin) || !Number.isInteger(divisor) || divisor <= 0) {
            return String(support.coinToDecimal(thresholdCoin));
        }
        const whole = Math.trunc(thresholdCoin / divisor);
        const fraction = Math.abs(thresholdCoin % divisor);
        if (fraction === 0) return String(whole);
        return whole + "." + String(fraction).padStart(String(divisor).length - 1, "0").replace(/0+$/, "");
    }

    async function updateThreshold(username, thresholdValue) {
        if (!thresholdValue) return { status: 401, payload: { success: false, msg: "Can't set threshold to a wrong value" } };
        if (!username) return { status: 401, payload: { success: false, msg: "Can't set threshold for unknown user" } };
        if (getCacheValue(username, false) === false) return { status: 401, payload: { success: false, msg: "Can't set threshold for unknown user" } };

        let threshold = Number(thresholdValue);
        if (!Number.isFinite(threshold)) return { status: 401, payload: { success: false, msg: "Can't set threshold to a wrong value" } };
        if (threshold > 1000) threshold = 1000;
        if (threshold < config.payout.walletMin) threshold = config.payout.walletMin;
        const thresholdCoin = support.decimalToCoin(threshold);

        const rows = await query("SELECT id FROM users WHERE username = ? AND payout_threshold_lock = '1'", [username]);
        if (rows.length !== 0) {
            return { status: 401, payload: { success: false, msg: "Can't update locked payment threshold" } };
        }
        await query(
            "INSERT INTO users (username, payout_threshold) VALUES (?, ?) ON DUPLICATE KEY UPDATE payout_threshold = ?",
            [username, thresholdCoin, thresholdCoin]
        );
        return { status: 200, payload: { msg: "Threshold updated, set to: " + formatThresholdCoin(thresholdCoin) } };
    }

    registerJsonRoute(app, "post", "/user/subscribeEmail", "subscribe email", async function handler(req, res) {
        const body = requireBodyFields(req, res, ["enabled", "from", "to"]);
        if (!body || !body.username) {
            if (body) return sendJson(res, 401, { success: false, msg: "No \"username\" parameter was found" });
            return;
        }
        const throttleKey = sensitiveKey(body.username);
        const throttle = acquireSensitiveAttempt(throttleKey);
        if (throttle) return sendJson(res, 429, throttle);

        if (body.from === "" && body.to === "") {
            const result = await query("UPDATE users SET enable_email = ? WHERE username = ?", [body.enabled, body.username]);
            if (result && result.affectedRows === 1) {
                clearSensitiveFailure(throttleKey);
                return { msg: "Email preferences were updated" };
            }
            return sendJson(res, 401, { error: "This XMR address does not have email subscription" });
        }

        if (body.from === "") {
            const result = await query(
                "UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND (email IS NULL OR email = '')",
                [body.enabled, body.to, body.username]
            );
            if (result && result.affectedRows === 1) {
                clearSensitiveFailure(throttleKey);
                return { msg: "Email preferences were updated" };
            }
            if (getCacheValue(body.username, false) === false) {
                return sendJson(res, 401, { success: false, msg: "Can't set email for unknown user" });
            }
            try {
                await query("INSERT INTO users (username, enable_email, email) VALUES (?, ?, ?)", [body.username, body.enabled, body.to]);
                clearSensitiveFailure(throttleKey);
                return { msg: "Email preferences were updated" };
            } catch (_error) {
                return sendJson(res, 401, { error: "Please specify valid FROM email" });
            }
        }

        const result = await query(
            "UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND email = ?",
            [body.enabled, body.to, body.username, body.from]
        );
        if (result && result.affectedRows === 1) {
            clearSensitiveFailure(throttleKey);
            return { msg: "Email preferences were updated" };
        }
        return sendJson(res, 401, { error: "FROM email does not match" });
    });

    app.get("/user/unsubscribeEmail/:token", async function unsubscribeToken(req, res) {
        try {
            if (!support || typeof support.parseEmailUnsubscribeToken !== "function") throw new Error("unsubscribe token support unavailable");
            const tokenData = support.parseEmailUnsubscribeToken(req.params.token);
            const result = await query(
                "UPDATE users SET enable_email = 0 WHERE username = ? AND email = ?",
                [tokenData.wallet, tokenData.email]
            );
            if (!result || result.affectedRows !== 1) {
                sendHtml(res, 401, renderUnsubscribeError());
                return;
            }
            sendHtml(res, 200, renderUnsubscribeSuccess(tokenData.wallet, tokenData.email));
        } catch (_error) {
            sendHtml(res, 401, renderUnsubscribeError());
        }
    });

    app.get("/user/:address/unsubscribeEmail", async function unsubscribeLegacy(req, res) {
        try {
            const result = await query("UPDATE users SET enable_email = 0 WHERE username = ?", [req.params.address]);
            sendHtml(
                res,
                result && result.affectedRows === 1 ? 200 : 401,
                result && result.affectedRows === 1 ? renderUnsubscribeSuccess(req.params.address, "") : renderUnsubscribeError()
            );
        } catch (_error) {
            sendHtml(res, 401, renderUnsubscribeError());
        }
    });

    registerJsonRoute(app, "get", "/user/:address", "user", async function handler(req) {
        const rows = await query("SELECT payout_threshold, enable_email FROM users WHERE username = ? LIMIT 1", [req.params.address]);
        return rows.length === 1
            ? { payout_threshold: rows[0].payout_threshold, email_enabled: rows[0].enable_email }
            : { payout_threshold: support.decimalToCoin(config.payout.defaultPay), email_enabled: 0 };
    });

    registerJsonRoute(app, "post", "/user/updateThreshold", "user update threshold", async function handler(req, res) {
        const body = getBody(req);
        const result = await updateThreshold(body.username, body.threshold);
        return sendJson(res, result.status, result.payload);
    });
};
