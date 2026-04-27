"use strict";
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const debug = require('debug')('support');
const os = require('os');
const { URL } = require('url');

function circularBuffer(size) {
    let data = new Array(size);
    let head = 0;
    let length = 0;

    let buffer = {
        enq: function (value) {
            data[(head + length) % size] = value;
            if (length < size) {
                ++length;
            } else {
                head = (head + 1) % size;
            }
        },
        deq: function () {
            if (length === 0) {
                return undefined;
            }
            const value = data[head];
            data[head] = undefined;
            head = (head + 1) % size;
            --length;
            return value;
        },
        size: function () {
            return length;
        },
        toarray: function () {
            let result = new Array(length);
            for (let i = 0; i < length; ++i) {
                result[i] = data[(head + i) % size];
            }
            return result;
        },
        get: function (index) {
            if (index < 0 || index >= length) {
                return undefined;
            }
            return data[(head + index) % size];
        }
    };

    return buffer;
}

// accumulates email notifications up to one hour (email/subject -> body)
let emailAcc = {};
// last send time of email (email/subject -> time)
let emailLastSendTime = {};
let lastEmailSendTime;

const DEFAULT_GENERAL_EMAIL_CONFIG = {
    emailBrand: "MoneroOcean",
    emailSig: "MoneroOcean Admin Team",
    emailUnsubscribeBaseUrl: "https://api.moneroocean.stream"
};

const DEFAULT_EMAIL_TEMPLATES = {
    unsubscribeFooter: "Unsubscribe: %(unsubscribe_url)s",
    unsubscribeSuccessHtml: "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Email unsubscribed</title><style>body{font-family:Arial,sans-serif;margin:0;background:#f6f8fb;color:#16202a}.wrap{max-width:520px;margin:0 auto;padding:48px 20px}.panel{background:#fff;border:1px solid #dbe3ec;border-radius:8px;padding:28px;overflow-wrap:anywhere}h1{font-size:24px;margin:0 0 12px}p{line-height:1.5;margin:0 0 12px}.wallet{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-word}.muted{color:#5d6b7a;font-size:14px}</style></head><body><main class=\"wrap\"><section class=\"panel\"><h1>Email unsubscribed</h1><p>Email notifications for <span class=\"wallet\">%(wallet)s</span> have been disabled.</p><p class=\"muted\">%(email)s will no longer receive miner notifications for this wallet.</p></section></main></body></html>",
    unsubscribeErrorHtml: "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Unsubscribe link expired</title><style>body{font-family:Arial,sans-serif;margin:0;background:#f6f8fb;color:#16202a}.wrap{max-width:520px;margin:0 auto;padding:48px 20px}.panel{background:#fff;border:1px solid #dbe3ec;border-radius:8px;padding:28px}h1{font-size:24px;margin:0 0 12px}p{line-height:1.5;margin:0;color:#5d6b7a}</style></head><body><main class=\"wrap\"><section class=\"panel\"><h1>Unable to unsubscribe</h1><p>This unsubscribe link is invalid, expired, or no longer matches the current email subscription.</p></section></main></body></html>",
    workerNotHashingSubject: "Worker stopped hashing: %(worker)s",
    workerNotHashingBody: "Worker status changed\n\n" +
        "Pool: %(pool)s\n" +
        "Status: stopped\n" +
        "Worker: %(worker)s\n" +
        "Wallet: %(wallet)s\n" +
        "Time (UTC): %(timestamp)s\n" +
        "Notice delay: %(notice_delay)s\n\n" +
        "No action is required if this was expected.",
    workerStartHashingSubject: "Worker started hashing: %(worker)s",
    workerStartHashingBody: "Worker status changed\n\n" +
        "Pool: %(pool)s\n" +
        "Status: started\n" +
        "Worker: %(worker)s\n" +
        "Wallet: %(wallet)s\n" +
        "Time (UTC): %(timestamp)s\n\n" +
        "No action is required if this was expected.",
    paymentPerformedSubject: "Payment sent: %(payment_amount)s %(coin)s",
    paymentPerformedBody: "Payment sent\n\n" +
        "Pool: %(pool)s\n" +
        "Status: confirmed\n" +
        "Coin: %(coin)s\n" +
        "Paid amount: %(payment_amount)s %(coin)s\n" +
        "Fee charged: %(fee)s %(coin)s\n" +
        "Balance decrease: %(amount)s %(coin)s\n" +
        "Destination: %(address)s\n" +
        "Paid at (UTC): %(paid_at)s\n\n" +
        "Transaction hash: %(tx_hash)s\n" +
        "Transaction key: %(tx_key)s\n" +
        "Proof URL: %(proof_url)s",
    paymentFailStopSubject: "Payment runtime fail-stop",
    paymentFailStopBody: "The payment runtime entered fail-stop: %(message)s.\n" +
        "Please review batches and restart payments after resolving the issue.",
    workerLmdbFullSubject: "Worker module paused due to LMDB full",
    workerLmdbFullBody: "worker paused after LMDB reported map full while %(scope)s: %(detail)s.",
    workerDbWriteSubject: "Pool DB write failed",
    workerDbWriteBody: "Cannot write to pool DB: %(error)s",
    workerPoolChangeSubject: "FYI: Pool hashrate/workers changed significantly",
    workerPoolChangeBody: "Pool hashrate changed from %(old_hashrate)s to %(new_hashrate)s (%(hashrate_ratio)s)\n" +
        "Pool number of workers changed from %(old_workers)s to %(new_workers)s (%(workers_ratio)s)\n",
    workerRestartSubject: "Restarting worker module",
    workerRestartBody: "Restarted worker module!",
    remoteShareLmdbSubject: "remote_share rejecting new work due to LMDB full",
    remoteShareLmdbBody: "remote_share is rejecting new share and block frames after LMDB reported map full while %(scope)s: %(detail)s.",
    blockMgrBalanceSubject: "block_manager unable to make balance increase",
    blockMgrBalanceBody: "The block_manager module has hit an issue making a balance increase: %(message)s.  Please investigate and restart block_manager as appropriate",
    blockMgrPaymentSubject: "block_manager unable to make blockPayments",
    blockMgrPaymentBody: "The block_manager module has hit an issue making blockPayments with block %(block_hash)s",
    blockMgrNoSharesSubject: "FYI: No shares to pay block, so it was corrected by using the top height",
    blockMgrNoSharesBody: "PPLNS payout cycle for %(block_hashes)s block does not have any shares so will be redone using top height",
    blockMgrPayoutWindowSubject: "Warning: Not enough shares to pay block correctly, so it was corrected by upscaling miner rewards!",
    blockMgrPayoutWindowBody: "PPLNS payout cycle complete on block: %(block_height)s Payout Percentage: %(corrected_percent)s% (precisely %(total_payments)s / %(pay_window)s)\n" +
        "(This PPLNS payout cycle complete on block was corrected: %(block_height)s Payout Percentage: %(default_percent)s% (precisely %(total_payments)s / %(default_window)s))",
    blockMgrZeroValueSubject: "FYI: block_manager saw zero value locked block",
    blockMgrZeroValueBody: "The block_manager module saw zero value locked block %(block_hash)s",
    statsDaemonFailSubject: "Failed to query daemon for %(port)s port for last block header",
    statsDaemonFailBody: "The worker failed to return last block header for %(port)s port. Please verify if the daemon is running properly.",
    statsDaemonRecoverSubject: "Querying daemon for %(port)s port for last block header is back to normal",
    statsDaemonRecoverBody: "A warning was sent to you indicating that the worker failed to return the last block header for %(port)s port. The issue seems to be solved now.",
    statsBehindBlocksSubject: "Pool node %(node)s is %(lag)s blocks behind",
    statsBehindBlocksBody: "Pool node %(node)s is %(lag)s blocks behind for %(port)s port",
    longRunnerStuckSubject: "long_runner stuck",
    longRunnerStuckBody: "%(stuck_count)s",
    longRunnerCleanSubject: "long_runner module can not clean DB good enough",
    longRunnerCleanBody: "long_runner can not clean %(blocks)s block from DB!",
    uplinkBacklogSubject: "FYI: Pool uplink backlog",
    uplinkBacklogBody: "Queued shares: %(queued)s\nRunning sends: %(running)s\nTarget: %(target)s\nHost: %(host)s\n"
};

function isUsableNodeIp(value) {
    if (typeof value !== "string") return false;
    const normalized = value.trim();
    return normalized !== "" &&
        normalized !== "::" &&
        normalized !== "0.0.0.0" &&
        normalized !== "127.0.0.1" &&
        normalized !== "localhost";
}

function detectNodeIp() {
    if (global.config && isUsableNodeIp(global.config.bind_ip)) return global.config.bind_ip.trim();

    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry && entry.family === "IPv4" && !entry.internal && isUsableNodeIp(entry.address)) {
                return entry.address;
            }
        }
    }

    return "unknown-ip";
}

function formatNodeEmailLabel(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    return raw.replace(/\.moneroocean\.stream$/i, "").split(".")[0] || raw;
}

function getPoolNodeEmailLabel() {
    const hostname = global.config && typeof global.config.hostname === "string" && global.config.hostname.trim() !== ""
        ? global.config.hostname.trim()
        : os.hostname();
    return formatNodeEmailLabel(hostname);
}

function getConfiguredString(moduleName, item, fallback) {
    const configModule = global.config && global.config[moduleName];
    if (configModule && typeof configModule[item] === "string" && configModule[item].length > 0) {
        return configModule[item];
    }
    return fallback;
}

function getEmailBrand() {
    return getConfiguredString("general", "emailBrand", DEFAULT_GENERAL_EMAIL_CONFIG.emailBrand);
}

function getEmailSignature() {
    return getConfiguredString("general", "emailSig", DEFAULT_GENERAL_EMAIL_CONFIG.emailSig);
}

function getEmailUnsubscribeBaseUrl() {
    return getConfiguredString("general", "emailUnsubscribeBaseUrl", DEFAULT_GENERAL_EMAIL_CONFIG.emailUnsubscribeBaseUrl);
}

function getEmailTemplate(item, fallback) {
    return getConfiguredString("email", item, Object.prototype.hasOwnProperty.call(DEFAULT_EMAIL_TEMPLATES, item) ? DEFAULT_EMAIL_TEMPLATES[item] : fallback || "");
}

function renderEmailTemplate(item, values, fallback) {
    return formatTemplate(getEmailTemplate(item, fallback), values || {});
}

function htmlEscape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function replaceChar(char) {
        return {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[char];
    });
}

function renderEmailHtmlTemplate(item, values, fallback) {
    const escapedValues = {};
    Object.keys(values || {}).forEach(function escapeValue(key) {
        escapedValues[key] = htmlEscape(values[key]);
    });
    return formatTemplate(getEmailTemplate(item, fallback), escapedValues);
}

function formatEmailSubject(subject, audience) {
    const rawSubject = String(subject || "");
    if (audience === "miner") {
        const brand = getEmailBrand();
        const brandPrefix = brand + ": ";
        return rawSubject.startsWith(brandPrefix) ? rawSubject : brandPrefix + rawSubject;
    }

    const nodeLabel = getPoolNodeEmailLabel();
    const subjectPrefix = "[" + nodeLabel + "] ";
    return rawSubject.startsWith(subjectPrefix) ? rawSubject : subjectPrefix + rawSubject;
}

function formatPoolNodeEmail(subject, body) {
    const formattedSubject = formatEmailSubject(subject, "admin");
    const nodeLabel = getPoolNodeEmailLabel();
    const bodyPrefix = "Pool node: " + nodeLabel;
    const formattedBody = String(body || "").startsWith(bodyPrefix)
        ? String(body || "")
        : bodyPrefix + "\n\n" + String(body || "");

    return {
        subject: formattedSubject,
        body: formattedBody
    };
}

function maskWalletAddress(address) {
    const value = typeof address === "string" ? address.trim() : "";
    if (value.length <= 12) return value;
    return value.slice(0, 6) + "..." + value.slice(-4);
}

function unsubscribeSecretKey() {
    const secKey = global.config && global.config.api && typeof global.config.api.secKey === "string"
        ? global.config.api.secKey
        : "";
    return Buffer.from(crypto.hkdfSync(
        "sha256",
        Buffer.from(secKey),
        Buffer.from("nodejs-pool-email-unsubscribe"),
        Buffer.from("email-unsubscribe-token"),
        32
    ));
}

function base64UrlEncode(value) {
    return Buffer.from(value).toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid token encoding");
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function createEmailUnsubscribeToken(wallet, email, issuedAt) {
    const payload = JSON.stringify({
        wallet: String(wallet || ""),
        email: String(email || ""),
        iat: typeof issuedAt === "number" ? issuedAt : Date.now()
    });
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", unsubscribeSecretKey(), nonce);
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return base64UrlEncode(Buffer.concat([nonce, tag, ciphertext]));
}

function parseEmailUnsubscribeToken(token, options) {
    const maxAgeMs = options && typeof options.maxAgeMs === "number" ? options.maxAgeMs : 30 * 24 * 60 * 60 * 1000;
    const raw = base64UrlDecode(token);
    if (raw.length <= 28) throw new Error("Invalid token length");
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", unsubscribeSecretKey(), nonce);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
    if (!payload || typeof payload.wallet !== "string" || typeof payload.email !== "string" || typeof payload.iat !== "number") {
        throw new Error("Invalid token payload");
    }
    if (!Number.isFinite(payload.iat) || Date.now() - payload.iat > maxAgeMs || payload.iat > Date.now() + 5 * 60 * 1000) {
        throw new Error("Stale token");
    }
    return payload;
}

function createEmailUnsubscribeUrl(wallet, email) {
    const baseUrl = getEmailUnsubscribeBaseUrl().replace(/\/+$/g, "");
    return baseUrl + "/user/unsubscribeEmail/" + createEmailUnsubscribeToken(wallet, email);
}

function appendUnsubscribeFooter(body, wallet, email) {
    if (!wallet || !email) return String(body || "");
    const unsubscribeUrl = createEmailUnsubscribeUrl(wallet, email);
    const footer = renderEmailTemplate("unsubscribeFooter", { unsubscribe_url: unsubscribeUrl }, DEFAULT_EMAIL_TEMPLATES.unsubscribeFooter);
    return String(body || "") + "\n\n" + footer;
}

function renderUnsubscribeSuccessHtml(wallet, email) {
    return renderEmailHtmlTemplate("unsubscribeSuccessHtml", { wallet: wallet, email: email }, DEFAULT_EMAIL_TEMPLATES.unsubscribeSuccessHtml);
}

function renderUnsubscribeErrorHtml() {
    return renderEmailHtmlTemplate("unsubscribeErrorHtml", {}, DEFAULT_EMAIL_TEMPLATES.unsubscribeErrorHtml);
}

function formatPlainTextFields(fields) {
    if (!Array.isArray(fields)) return "";
    return fields.filter(function hasValue(field) {
        return field && field.label && typeof field.value !== "undefined" && field.value !== null && String(field.value) !== "";
    }).map(function formatField(field) {
        return String(field.label) + ": " + String(field.value);
    }).join("\n");
}

function makeHttpRequest(targetUrl, options, callback) {
    const requestUrl = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
    const headers = Object.assign({}, options.headers);
    const timeoutMs = typeof options.timeout === "number" && options.timeout > 0 ? options.timeout : 0;
    const requestOptions = {
        hostname: requestUrl.hostname,
        method: options.method || 'GET',
        path: requestUrl.pathname + requestUrl.search,
        port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
        rejectUnauthorized: options.rejectUnauthorized,
        headers: headers,
    };
    const transport = requestUrl.protocol === 'https:' ? https : http;
    let isFinished = false;
    let response = null;
    let wallTimeout = null;
    const finalize = function (err, res, body) {
        if (isFinished) {
            return;
        }
        isFinished = true;
        if (wallTimeout !== null) {
            clearTimeout(wallTimeout);
            wallTimeout = null;
        }
        callback(err, res, body);
    };
    const req = transport.request(requestOptions, function (res) {
        response = res;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            body += chunk;
        });
        res.on('end', function () {
            finalize(null, res, body);
        });
        res.on('error', function (err) {
            finalize(err);
        });
    });
    req.on('error', function (err) {
        finalize(err);
    });
    if (timeoutMs > 0) {
        wallTimeout = setTimeout(function onWallTimeout() {
            const error = new Error('Request timed out');
            if (response && typeof response.destroy === 'function') response.destroy(error);
            req.destroy(error);
            finalize(error);
        }, timeoutMs);
        req.setTimeout(timeoutMs, function () {
            req.destroy(new Error('Request timed out'));
        });
    }
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
        req.write(options.body);
    }
    req.end();
}

function formatHttpRequestFailure(err, response, responseBody) {
    const parts = [];
    if (err) parts.push("error=" + (err.code ? err.code + " " : "") + (err.message || String(err)));
    if (response) parts.push("status=" + response.statusCode + (response.statusMessage ? " " + response.statusMessage : ""));
    if (typeof responseBody !== "undefined" && responseBody !== "") parts.push("body=" + String(responseBody));
    return parts.join(" ");
}

function sendEmailReal(toAddress, subject, email_body, retry) {
    const mailgunURL = typeof global.config.general.mailgunURL === "string" ? global.config.general.mailgunURL.trim() : "";
    const fromAddress = typeof global.config.general.emailFrom === "string" ? global.config.general.emailFrom.trim() : "";
    const recipient = typeof toAddress === "string" ? toAddress.trim() : "";
    if (!recipient || !mailgunURL || !fromAddress) {
        debug("Skipping email send due to incomplete mail settings");
        return;
    }
    if (lastEmailSendTime && Date.now() - lastEmailSendTime < 1000) {
      setTimeout(sendEmailReal, 1000, recipient, subject, email_body, retry);
      return;
    }
    lastEmailSendTime = Date.now();
    const body = JSON.stringify({
      from:    fromAddress,
      to:      recipient,
      subject: subject,
      text:    email_body
    }) + "\n";
    makeHttpRequest(mailgunURL, {
        method: 'POST',
        body: body,
        rejectUnauthorized: global.config.general.mailgunNoCert === true ? false : true,
        headers: {
          "Content-Type":   "application/json",
          "Accept":         "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connection":     "close"
        }
    }, function(err, response, responseBody) {
        if (!err && response.statusCode === 200) {
            debug(email_body);
            console.log("Email to '" + recipient + "' was sent successfully!  Response: " + responseBody);
        } else {
            if (retry) {
                console.error("Did not send e-mail to '" + recipient + "' successfully! " + formatHttpRequestFailure(err, response, responseBody));
            } else {
                setTimeout(sendEmailReal, 50*1000, recipient, subject, email_body, 1);
            }
        }
    });
}

function sendEmail(toAddress, subject, body, wallet, options){
    const emailOptions = options && typeof options === "object" ? options : {};
    const isAdminEmail = toAddress === global.config.general.adminEmail;
    let batchKey = null;
    if (isAdminEmail) {
        const formattedEmail = formatPoolNodeEmail(subject, body);
        subject = formattedEmail.subject;
        body = formattedEmail.body;
    } else {
        subject = formatEmailSubject(emailOptions.batchSubject || subject, "miner");
        batchKey = typeof emailOptions.batchKey === "string" && emailOptions.batchKey.length > 0
            ? emailOptions.batchKey
            : subject;
        body = String(body || "");
    }

    if (isAdminEmail && !subject.includes("FYI")) {
        sendEmailReal(toAddress, subject, body);
    } else {
        let reEmail = /^([a-zA-Z0-9_\.-])+@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,4})+$/;
        if (!reEmail.test(toAddress)) {
            debug("Avoid sending email to invalid address '" + toAddress + "'");
            return;
        }
        let key = toAddress + "\t" + (batchKey || subject);
        if (!(key in emailAcc)) {
            emailAcc[key] = body;
            let time_now = Date.now();
            let is_fast_email = !(key in emailLastSendTime) || time_now - emailLastSendTime[key] > 6*60*60*1000;
            emailLastSendTime[key] = time_now;
            setTimeout(function(email_address, email_subject, email_batch_key, wallet) {
                let key2 = email_address + "\t" + email_batch_key;
                let email_body = emailAcc[key2];
                delete emailAcc[key2];
                if (!isAdminEmail) {
                    email_body = appendUnsubscribeFooter(email_body, wallet, email_address);
                }
                let emailData = {
                    wallet: wallet
                };
                sendEmailReal(email_address, email_subject, "Hello,\n\n" + email_body + "\n\nThank you,\n" + formatTemplate(getEmailSignature(), emailData));
            }, (is_fast_email ? 5 : 30)*60*1000, toAddress, subject, batchKey || subject, wallet);
        } else {
            emailAcc[key] += "\n\n" + body;
        }
    }
}

function resetEmailState() {
    emailAcc = {};
    emailLastSendTime = {};
    lastEmailSendTime = undefined;
}

function formatRequestError(err) {
    let message;
    if (err instanceof Error) {
        const errorName = typeof err.name === "string" && err.name.length > 0 ? err.name : "Error";
        message = errorName + ": " + (err.message || String(err));
    } else if (typeof err === "string") message = err;
    else {
        try {
            message = JSON.stringify(err);
        } catch (_error) {
            message = String(err);
        }
    }
    return String(message).replace(/\s*\r?\n\s*/g, " ").trim();
}

function logJsonRequestError(url, statusCode, err, suppressErrorLog) {
    if (suppressErrorLog) return;
    const statusPrefix = typeof statusCode === "number" && statusCode >= 400 ? "HTTP " + statusCode + " " : "";
    console.error("Error doing " + url.toString() + " request: " + statusPrefix + formatRequestError(err));
}

function normalizeJsonRequestOptions(options) {
    if (options && typeof options === "object") {
        return {
            connectionClose: options.connectionClose !== false,
            suppressErrorLog: !!options.suppressErrorLog
        };
    }
    return {
        connectionClose: true,
        suppressErrorLog: !!options
    };
}

function jsonRequest(host, port, data, callback, path, timeout, optionsOrSuppressErrorLog) {
    const requestBehavior = normalizeJsonRequestOptions(optionsOrSuppressErrorLog);
    const requestPath = String(path || '').replace(/^\/+/, '');
    const url = new URL((global.config.rpc.https ? "https://" : "http://") + host + ":" + port + "/" + requestPath);
    let options = {
        method: data ? "POST" : "GET",
        timeout: timeout,
        headers: {
            "Content-Type": "application/json",
            "Accept":       "application/json",
        }
    };
    if (requestBehavior.connectionClose) options.headers["Connection"] = "close";
    if (global.config.daemon.basicAuth) {
        options.headers["Authorization"] = global.config.daemon.basicAuth;
    }
    if (global.config.daemon["X-API-KEY"]) {
        options.headers["X-API-KEY"]     = global.config.daemon["X-API-KEY"];
        options.headers["api_key"]       = global.config.daemon["X-API-KEY"];
    }

    if (data) {
        const data2 = typeof data === 'string' ? data : JSON.stringify(data);
        options.headers["Content-Length"] = Buffer.byteLength(data2);
        options.body = data2;
    }
    let reply_fn = function (err, res, body) {
        if (err) {
            logJsonRequestError(url, null, err, requestBehavior.suppressErrorLog);
            return callback(err);
        }
        let json;
        try {
            json = JSON.parse(body);
        } catch (e) {
            debug("JSON parse exception: " + body);
            logJsonRequestError(url, res && res.statusCode, "JSON parse exception: " + e.message, requestBehavior.suppressErrorLog);
            return callback("JSON parse exception: " + body);
        }
        if (json && Object.prototype.hasOwnProperty.call(json, "error") && json.error !== null) {
            logJsonRequestError(url, res && res.statusCode, json.error, requestBehavior.suppressErrorLog);
        } else if (res && res.statusCode >= 400) {
            logJsonRequestError(url, res.statusCode, "Unexpected HTTP status", requestBehavior.suppressErrorLog);
        }
        debug("JSON result: " + JSON.stringify(json));
        return callback(json, res.statusCode);
    };
    debug("JSON REQUST: " + JSON.stringify(options));
    makeHttpRequest(url, options, reply_fn);
}

function rpc(host, port, method, params, callback, timeout, optionsOrSuppressErrorLog) {
    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, callback, 'json_rpc', timeout, optionsOrSuppressErrorLog);
}

function rpc2(host, port, method, params, callback, timeout, optionsOrSuppressErrorLog) {
    return jsonRequest(host, port, params, callback, method, timeout, optionsOrSuppressErrorLog);
}

function https_get(url, callback) {
  let timer;
  let is_callback_called = false;
  var req = https.get(url, function(res) {
    if (res.statusCode != 200) {
      if (timer) clearTimeout(timer);
      console.error("URL " + url + ": Result code: " + res.statusCode);
      if (!is_callback_called) {
        is_callback_called = true;
        callback(null);
      }
      return;
    }
    let str = "";
    res.on('data', function(d) { str += d; });
    res.on('end', function() {
      if (timer) clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(str);
      } catch (e) {
        console.error("URL " + url + ": JSON parse exception: " + e);
        if (!is_callback_called) {
          is_callback_called = true;
          callback(str);
        }
        return;
      }
      if (!is_callback_called) {
        is_callback_called = true;
        callback(json);
      }
      return;
    });
    res.on('error', function() {
      if (timer) clearTimeout(timer);
      console.error("URL " + url + ": RESPONSE ERROR!");
      if (!is_callback_called) {
        is_callback_called = true;
        callback(null);
      }
    });
  });
  req.on('error', function() {
    if (timer) clearTimeout(timer);
    console.error("URL " + url + ": REQUEST ERROR!");
    if (!is_callback_called) {
      is_callback_called = true;
      callback(null);
    }
  });
  timer = setTimeout(function() {
    req.abort();
    console.error("URL " + url + ": TIMEOUT!");
    if (!is_callback_called) {
      is_callback_called = true;
      callback(null);
    }
  }, 30*1000);
  req.end();
}

function getCoinHashFactor(coin, callback) {
    global.mysql.query("SELECT item_value FROM config WHERE module = 'daemon' and item = 'coinHashFactor" + coin + "'").then(function (rows) {
        if (rows.length != 1) {
	    console.error("Can't get config.daemon.coinHashFactor" + coin + " value");
            return callback(null);
        }
        callback(parseFloat(rows[0].item_value));
    }).catch(function (error) {
       console.error("SQL query failed: " + error);
       return callback(0);
    });
}

function setCoinHashFactor(coin, coinHashFactor) {
    global.mysql.query("UPDATE config SET item_value = ? WHERE module = 'daemon' and item = 'coinHashFactor" + coin + "'", [coinHashFactor]).catch(function (error) {
       console.error("SQL query failed: " + error);
    });
    global.config.daemon["coinHashFactor" + coin] = coinHashFactor;
}

function padDatePart(value) { return value.toString().padStart(2, '0'); }

function formatTemplate(template, values) {
    return template.replace(/%\(([^)]+)\)s/g, function (_, key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : '';
    });
}

function formatDate(date) {
    // Date formatting for MySQL date time fields.
    const ts = new Date(date);
    return ts.getFullYear() + '-' +
        padDatePart(ts.getMonth() + 1) + '-' +
        padDatePart(ts.getDate()) + ' ' +
        padDatePart(ts.getHours()) + ':' +
        padDatePart(ts.getMinutes()) + ':' +
        padDatePart(ts.getSeconds());
}

function formatDateUTC(date) {
    const ts = new Date(date);
    return ts.getUTCFullYear() + '-' +
        padDatePart(ts.getUTCMonth() + 1) + '-' +
        padDatePart(ts.getUTCDate()) + ' ' +
        padDatePart(ts.getUTCHours()) + ':' +
        padDatePart(ts.getUTCMinutes()) + ':' +
        padDatePart(ts.getUTCSeconds());
}

function formatDateFromSQL(date) {
    // Date formatting for MySQL date time fields.
    let ts = new Date(date);
    return Math.floor(ts.getTime() / 1000);
}

function coinToDecimal(amount) { return amount / global.config.coin.sigDigits; }

function decimalToCoin(amount) { return Math.round(amount * global.config.coin.sigDigits); }

function tsCompare(a, b) {
    if (a.ts < b.ts) {
        return 1;
    }

    if (a.ts > b.ts) {
        return -1;
    }
    return 0;
}

function port_wallet_ip(port) {
  const ip = global.config.wallet["address_" + port.toString()];
  if (ip) return ip;
  return global.config.wallet.address;
}

function bindRpcCall(invoker, targetHost, targetPort, timeout) {
    return function callBoundRpc(method, params, callback, optionsOrSuppressErrorLog) {
        const port = typeof targetPort === "function" ? targetPort() : targetPort;
        return invoker(typeof targetHost === "function" ? targetHost(port) : targetHost, port, method, params, callback, timeout, optionsOrSuppressErrorLog);
    };
}

function bindPortRpcCall(invoker, targetHost, timeout) {
    return function callPortRpc(port, method, params, callback, optionsOrSuppressErrorLog) {
        return invoker(typeof targetHost === "function" ? targetHost(port) : targetHost, port, method, params, callback, timeout, optionsOrSuppressErrorLog);
    };
}

module.exports = function () {
    return {
        rpcPortDaemon: bindPortRpcCall(rpc, function () { return global.config.daemon.address; }, 30*1000),
        rpcPortDaemon2: bindPortRpcCall(rpc2, function () { return global.config.daemon.address; }, 30*1000),
        rpcWallet: bindRpcCall(rpc, port_wallet_ip, function () { return global.config.wallet.port; }, 30*60*1000),
        rpcPortWallet: bindPortRpcCall(rpc, port_wallet_ip, 30*60*1000),
        rpcPortWallet2: bindPortRpcCall(rpc2, port_wallet_ip, 30*60*1000),
        rpcPortWalletShort: bindPortRpcCall(rpc, port_wallet_ip, 30*1000),
        circularBuffer: circularBuffer,
        formatDate: formatDate,
        formatDateUTC: formatDateUTC,
        coinToDecimal: coinToDecimal,
        decimalToCoin: decimalToCoin,
        formatDateFromSQL: formatDateFromSQL,
        sendEmail: sendEmail,
        detectNodeIp: detectNodeIp,
        tsCompare: tsCompare,
        getCoinHashFactor: getCoinHashFactor,
        setCoinHashFactor: setCoinHashFactor,
        https_get: https_get,
        formatTemplate: formatTemplate,
        formatEmailSubject: formatEmailSubject,
        formatPlainTextFields: formatPlainTextFields,
        getEmailTemplate: getEmailTemplate,
        maskWalletAddress: maskWalletAddress,
        renderEmailTemplate: renderEmailTemplate,
        createEmailUnsubscribeToken: createEmailUnsubscribeToken,
        parseEmailUnsubscribeToken: parseEmailUnsubscribeToken,
        createEmailUnsubscribeUrl: createEmailUnsubscribeUrl,
        renderUnsubscribeSuccessHtml: renderUnsubscribeSuccessHtml,
        renderUnsubscribeErrorHtml: renderUnsubscribeErrorHtml,
        _resetEmailState: resetEmailState,
        emailDefaults: {
            general: DEFAULT_GENERAL_EMAIL_CONFIG,
            email: DEFAULT_EMAIL_TEMPLATES
        }
    };
};
