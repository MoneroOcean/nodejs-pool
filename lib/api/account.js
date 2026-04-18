"use strict";

const crypto = require("crypto");
const express = require("express");

module.exports = function registerAccountRoutes(ctx) {
    const {
        auth,
        core,
        http
    } = ctx;
    const { jwt, trackAuth } = auth;
    const { config, getCacheValue, query, support } = core;
    const { app, registerJsonRoute, sendJson } = http;

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

    function hashPassword(password) {
        return crypto.createHmac("sha256", config.api.secKey).update(password).digest("hex");
    }

    function signToken(id) {
        return jwt.sign({ id: id }, config.api.secKey, { expiresIn: "1d" });
    }

    function authFailure(res, msg) {
        trackAuth(false);
        return sendJson(res, 401, { success: false, msg: msg });
    }

    function authSuccess(id) {
        trackAuth(true);
        return { success: true, msg: signToken(id) };
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

    async function updateThreshold(username, thresholdValue, options) {
        if (!thresholdValue) return { status: 401, payload: { success: false, msg: "Can't set threshold to a wrong value" } };
        if (!username) return { status: 401, payload: { success: false, msg: "Can't set threshold for unknown user" } };
        if (options.requireKnownUser && getCacheValue(username, false) === false) {
            return { status: 401, payload: { success: false, msg: "Can't set threshold for unknown user" } };
        }

        let threshold = Number(thresholdValue);
        if (!Number.isFinite(threshold)) return { status: 401, payload: { success: false, msg: "Can't set threshold to a wrong value" } };
        if (typeof options.maxThreshold === "number" && threshold > options.maxThreshold) threshold = options.maxThreshold;
        if (threshold < config.payout.walletMin) threshold = config.payout.walletMin;
        const thresholdCoin = support.decimalToCoin(threshold);

        if (options.checkLock) {
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

        await query("UPDATE users SET payout_threshold = ? WHERE id = ?", [thresholdCoin, options.userId]);
        return { status: 200, payload: { msg: "Threshold updated, set to: " + formatThresholdCoin(thresholdCoin) } };
    }

    registerJsonRoute(app, "post", "/user/subscribeEmail", "subscribe email", async function handler(req, res) {
        const body = requireBodyFields(req, res, ["enabled", "from", "to"]);
        if (!body || !body.username) {
            if (body) return sendJson(res, 401, { success: false, msg: "No \"username\" parameter was found" });
            return;
        }

        if (body.from === "" && body.to === "") {
            const result = await query("UPDATE users SET enable_email = ? WHERE username = ?", [body.enabled, body.username]);
            return result && result.affectedRows === 1
                ? { msg: "Email preferences were updated" }
                : sendJson(res, 401, { error: "This XMR address does not have email subscription" });
        }

        if (body.from === "") {
            const result = await query(
                "UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND (email IS NULL OR email = '')",
                [body.enabled, body.to, body.username]
            );
            if (result && result.affectedRows === 1) return { msg: "Email preferences were updated" };
            if (getCacheValue(body.username, false) === false) {
                return sendJson(res, 401, { success: false, msg: "Can't set email for unknown user" });
            }
            try {
                await query("INSERT INTO users (username, enable_email, email) VALUES (?, ?, ?)", [body.username, body.enabled, body.to]);
                return { msg: "Email preferences were updated" };
            } catch (_error) {
                return sendJson(res, 401, { error: "Please specify valid FROM email" });
            }
        }

        const result = await query(
            "UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND email = ?",
            [body.enabled, body.to, body.username, body.from]
        );
        return result && result.affectedRows === 1
            ? { msg: "Email preferences were updated" }
            : sendJson(res, 401, { error: "FROM email does not match" });
    });

    registerJsonRoute(app, "get", "/user/:address/unsubscribeEmail", "unsubscribe email", async function handler(req, res) {
        const result = await query("UPDATE users SET enable_email = 0 WHERE username = ?", [req.params.address]);
        return result && result.affectedRows === 1
            ? { msg: "Your email was unsubscribed from further notifications" }
            : sendJson(res, 401, { error: "This XMR address does not have email subscription" });
    });

    registerJsonRoute(app, "get", "/user/:address", "user", async function handler(req) {
        const rows = await query("SELECT payout_threshold, enable_email FROM users WHERE username = ? LIMIT 1", [req.params.address]);
        return rows.length === 1
            ? { payout_threshold: rows[0].payout_threshold, email_enabled: rows[0].enable_email }
            : { payout_threshold: support.decimalToCoin(config.payout.defaultPay), email_enabled: 0 };
    });

    registerJsonRoute(app, "post", "/user/updateThreshold", "user update threshold", async function handler(req, res) {
        const body = getBody(req);
        const result = await updateThreshold(body.username, body.threshold, {
            checkLock: true,
            maxThreshold: 1000,
            requireKnownUser: true
        });
        return sendJson(res, result.status, result.payload);
    });

    registerJsonRoute(app, "post", "/authenticate", "authenticate", async function handler(req, res) {
        const body = getBody(req);
        let hmac;
        try {
            hmac = hashPassword(body.password);
        } catch (_error) {
            return authFailure(res, "Invalid password");
        }

        const rows = await query("SELECT id, pass, email FROM users WHERE username = ? LIMIT 1", [body.username]);
        if (rows.length === 0) return authFailure(res, "Password is not set, so you can not login now.");

        const user = rows[0];
        if (user.pass === null) {
            if (user.email === body.password) return authSuccess(user.id);
            return authFailure(res, "Wrong password. Password equals to string after : character in your miner password field.");
        }
        if (user.pass !== hmac) {
            return authFailure(res, "Wrong password. Password was set by you in Dashboard Options before.");
        }
        return authSuccess(user.id);
    });

    const secureRoutes = express.Router();
    secureRoutes.use(function verifyToken(req, res, next) {
        const body = getBody(req);
        const token = body.token || req.query.token || req.headers["x-access-token"];
        if (!token) {
            trackAuth(false);
            res.status(403).send({ success: false, msg: "No token provided." });
            return;
        }

        try {
            req.decoded = jwt.verify(token, config.api.secKey);
            trackAuth(true);
            next();
        } catch (_error) {
            trackAuth(false);
            res.json({ success: false, msg: "Failed to authenticate token." });
        }
    });

    registerJsonRoute(secureRoutes, "get", "/tokenRefresh", "token refresh", async function handler(req) {
        return { msg: signToken(req.decoded.id) };
    });

    registerJsonRoute(secureRoutes, "get", "/", "authed user", async function handler(req) {
        const rows = await query("SELECT payout_threshold, enable_email, email FROM users WHERE id = ?", [req.decoded.id]);
        return { msg: { payout_threshold: rows[0].payout_threshold, email_enabled: rows[0].enable_email, email: rows[0].email } };
    });

    registerJsonRoute(secureRoutes, "post", "/changePassword", "change password", async function handler(req, res) {
        const body = getBody(req);
        if (!body.password) return sendJson(res, 401, { success: false, msg: "Invalid password" });
        await query("UPDATE users SET pass = ? WHERE id = ?", [hashPassword(body.password), req.decoded.id]);
        return { msg: "Password updated" };
    });

    registerJsonRoute(secureRoutes, "post", "/changeEmail", "change email", async function handler(req) {
        const body = getBody(req);
        await query("UPDATE users SET email = ? WHERE id = ?", [body.email, req.decoded.id]);
        return { msg: "Updated email was set to: " + body.email };
    });

    registerJsonRoute(secureRoutes, "post", "/toggleEmail", "toggle email", async function handler(req) {
        await query("UPDATE users SET enable_email = NOT enable_email WHERE id = ?", [req.decoded.id]);
        return { msg: "Email toggled" };
    });

    registerJsonRoute(secureRoutes, "post", "/changePayoutThreshold", "change payout threshold", async function handler(req, res) {
        const body = getBody(req);
        const result = await updateThreshold(req.decoded.id, body.threshold, {
            checkLock: false,
            requireKnownUser: false,
            userId: req.decoded.id
        });
        return sendJson(res, result.status, result.payload);
    });

    app.use("/authed", secureRoutes);
};
