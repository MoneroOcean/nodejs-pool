"use strict";
const crypto = require("crypto");

/** @typedef {import("../../types/runtime").PoolConfig} PoolConfig */
/** @typedef {import("../../types/runtime").SqlParam} SqlParam */
/** @typedef {import("../../types/runtime").SqlRows} SqlRows */
/** @typedef {import("../../types/runtime").SupportRuntime} SupportRuntime */
/** @typedef {import("../../types/runtime").ExpressApp} ExpressApp */
/** @typedef {import("../../types/runtime").ExpressRequest} ExpressRequest */
/** @typedef {import("../../types/runtime").ExpressResponse} ExpressResponse */
/** @typedef {{username?: unknown, enabled?: unknown, from?: unknown, to?: unknown, threshold?: unknown, [key: string]: unknown}} RequestBody */
/** @typedef {{config: PoolConfig, getCacheValue: (key: string, fallback: unknown) => unknown, now: () => number, query: (sql: string, params?: readonly SqlParam[]) => Promise<SqlRows>, support: SupportRuntime}} AccountCore */
/** @typedef {{app: ExpressApp, registerJsonRoute: (target: ExpressApp, method: "get" | "post", path: string, scope: string, handler: (request: ExpressRequest, response: ExpressResponse) => unknown | Promise<unknown>, fallback?: unknown) => void, sendJson: (response: ExpressResponse, statusCode: number, payload: unknown) => unknown}} AccountHttp */
/** @typedef {{core: AccountCore, http: AccountHttp}} AccountContext */
/** @typedef {{nextAllowedAt: number, expiresAt: number}} SensitiveFailure */
/** @typedef {{status: number, payload: Record<string, unknown>}} ThresholdUpdate */

const SENSITIVE_FAILURE_DELAY_MS = 2 * 1000;
const SENSITIVE_FAILURE_RETENTION_MS = 10 * 60 * 1000;
const MAX_SENSITIVE_FAILURE_KEYS = 5000;

/** @param {AccountContext} ctx @returns {void} */
module.exports = function registerAccountRoutes(ctx) {
    const {
        core,
        http
    } = ctx;
    const { config, getCacheValue, now, query, support } = core;
    const { app, registerJsonRoute, sendJson } = http;
    /** @type {Map<string, SensitiveFailure>} */
    const sensitiveFailures = new Map();

    /** @param {ExpressRequest} req @returns {RequestBody} */
    function getBody(req) { return req.body && typeof req.body === "object" ? req.body : {}; }

    /** @param {ExpressRequest} req @param {ExpressResponse} res @param {string[]} names @returns {RequestBody | null} */
    function requireBodyFields(req, res, names) {
        const body = getBody(req);
        for (const name of names) {
            if (!(name in body)) {
                sendJson(res, 401, { success: false, msg: `No "${  name  }" parameter was found` });
                return null;
            }
        }
        return body;
    }

    /** @returns {number} */
    function timeNow() { return typeof now === "function" ? now() : Date.now(); }

    /** @param {unknown} value @returns {string} */
    function sensitivePart(value) {
        if (typeof value === "string") return value.trim();
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        return "";
    }

    /** @param {unknown} kind @param {unknown} username @returns {string | null} */
    function sensitiveKey(kind, username) {
        const userValue = sensitivePart(username);
        if (!userValue) return null;

        const hash = crypto.createHash("sha256");
        // Length-prefix each part so distinct (kind, username) pairs can't collide via concatenation.
        for (const part of [sensitivePart(kind), userValue]) {
            hash.update(String(Buffer.byteLength(part)));
            hash.update(":");
            hash.update(part);
        }
        return hash.digest("hex");
    }

    /** @param {number} time @returns {void} */
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

    /** @param {number} waitMs @returns {Record<string, unknown>} */
    function throttlePayload(waitMs) {
        return {
            success: false,
            msg: `Too many attempts. Try again in ${  Math.ceil(waitMs / 1000)  } seconds.`
        };
    }

    /** @param {string | null} key @returns {Record<string, unknown> | null} */
    function acquireSensitiveAttempt(key) {
        if (!key) return null;
        const time = timeNow();
        pruneSensitiveFailures(time);
        const entry = sensitiveFailures.get(key);
        if (entry && entry.nextAllowedAt > time) return throttlePayload(entry.nextAllowedAt - time);
        sensitiveFailures.set(key, {
            nextAllowedAt: time + SENSITIVE_FAILURE_DELAY_MS,
            expiresAt: time + SENSITIVE_FAILURE_RETENTION_MS
        });
        if (sensitiveFailures.size > MAX_SENSITIVE_FAILURE_KEYS) pruneSensitiveFailures(time);
        return null;
    }

    /** @param {string | null} key @returns {void} */
    function clearSensitiveFailure(key) {
        if (key) sensitiveFailures.delete(key);
    }

    /** @param {string} wallet @param {string} email @returns {string} */
    function renderUnsubscribeSuccess(wallet, email) {
        if (support && typeof support.renderUnsubscribeSuccessHtml === "function") {
            return support.renderUnsubscribeSuccessHtml(wallet, email);
        }
        return "<!doctype html><html><body><h1>Email unsubscribed</h1><p>Email notifications have been disabled.</p></body></html>";
    }

    /** @returns {string} */
    function renderUnsubscribeError() {
        if (support && typeof support.renderUnsubscribeErrorHtml === "function") {
            return support.renderUnsubscribeErrorHtml();
        }
        return "<!doctype html><html><body><h1>Unable to unsubscribe</h1><p>This unsubscribe link is invalid or expired.</p></body></html>";
    }

    /** @param {ExpressResponse} res @param {number} statusCode @param {string} body @returns {void} */
    function sendHtml(res, statusCode, body) {
        res.status(statusCode).type("html").send(body);
    }

    /** @param {number} thresholdCoin @returns {string} */
    function formatThresholdCoin(thresholdCoin) {
        const divisor = Number(config.general && config.general.sigDivisor);
        if (!Number.isInteger(thresholdCoin) || !Number.isInteger(divisor) || divisor <= 0) {
            return String(support.coinToDecimal(thresholdCoin));
        }
        const whole = Math.trunc(thresholdCoin / divisor);
        const fraction = Math.abs(thresholdCoin % divisor);
        if (fraction === 0) return String(whole);
        // divisor is 10^n: its digit count minus the leading "1" is the fraction width; trim trailing zeros.
        return `${whole  }.${  String(fraction).padStart(String(divisor).length - 1, "0").replace(/0+$/, "")}`;
    }

    /** @param {unknown} username @param {unknown} thresholdValue @returns {Promise<ThresholdUpdate>} */
    async function updateThreshold(username, thresholdValue) {
        if (!thresholdValue) return { status: 401, payload: { success: false, msg: "Can't set threshold to a wrong value" } };
        if (typeof username !== "string" || username === "") return { status: 401, payload: { success: false, msg: "Can't set threshold for unknown user" } };
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
        return { status: 200, payload: { msg: `Threshold updated, set to: ${  formatThresholdCoin(thresholdCoin)}` } };
    }

    registerJsonRoute(app, "post", "/user/subscribeEmail", "subscribe email", /** @param {ExpressRequest} req @param {ExpressResponse} res */ async function handler(req, res) {
        const body = requireBodyFields(req, res, ["enabled", "from", "to"]);
        if (!body) return;
        if (typeof body.username !== "string" || body.username === "") {
            return sendJson(res, 401, { success: false, msg: "No \"username\" parameter was found" });
        }
        // These values flow into SQL ? parameters; a non-string from/to or a non-primitive
        // enabled would be expanded by the mysql escaper into extra SQL (mass match / extra
        // column writes), so require primitives here.
        if (typeof body.from !== "string" || typeof body.to !== "string" ||
            (typeof body.enabled !== "string" && typeof body.enabled !== "number" && typeof body.enabled !== "boolean")) {
            return sendJson(res, 400, { success: false, msg: "Invalid parameter type" });
        }
        const throttleKey = sensitiveKey("subscribeEmail", body.username);
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

    app.get("/user/unsubscribeEmail/:token", /** @param {ExpressRequest} req @param {ExpressResponse} res */ async function unsubscribeToken(req, res) {
        try {
            if (!support || typeof support.parseEmailUnsubscribeToken !== "function") throw new Error("unsubscribe token support unavailable");
            const tokenData = support.parseEmailUnsubscribeToken(req.params["token"] || "");
            if (!tokenData || typeof tokenData["wallet"] !== "string" || typeof tokenData["email"] !== "string") throw new Error("invalid unsubscribe token");
            const result = await query(
                "UPDATE users SET enable_email = 0 WHERE username = ? AND email = ?",
                [tokenData["wallet"], tokenData["email"]]
            );
            if (!result || result.affectedRows !== 1) {
                sendHtml(res, 401, renderUnsubscribeError());
                return;
            }
            sendHtml(res, 200, renderUnsubscribeSuccess(tokenData["wallet"], tokenData["email"]));
        } catch (_error) {
            sendHtml(res, 401, renderUnsubscribeError());
        }
    });

    registerJsonRoute(app, "get", "/user/:address", "user", /** @param {ExpressRequest} req */ async function handler(req) {
        const rows = await query("SELECT payout_threshold, enable_email FROM users WHERE username = ? LIMIT 1", [req.params["address"] || ""]);
        const row = rows[0];
        return rows.length === 1 && row
            ? { payout_threshold: row["payout_threshold"], email_enabled: row["enable_email"] }
            : { payout_threshold: support.decimalToCoin(config.payout.defaultPay), email_enabled: 0 };
    });

    registerJsonRoute(app, "post", "/user/updateThreshold", "user update threshold", /** @param {ExpressRequest} req @param {ExpressResponse} res */ async function handler(req, res) {
        const body = getBody(req);
        const result = await updateThreshold(body.username, body.threshold);
        return sendJson(res, result.status, result.payload);
    });
};
