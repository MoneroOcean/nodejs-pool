"use strict";
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const debug = require('debug')('support');
const os = require('os');
const { URL } = require('url');
const { formatLogEvent } = require('./logging.js');

/** @typedef {import("../../types/runtime").RpcBody} RpcBody */
/** @typedef {import("../../types/runtime").SqlRow} SqlRow */
/** @typedef {import("node:http").IncomingMessage} HttpResponse */
/** @typedef {{method?: string, timeout?: number, rejectUnauthorized?: boolean, headers: Record<string, string | number>, body?: string | Buffer}} HttpRequestOptions */
/** @typedef {(error: Error | null, response: HttpResponse | null, body?: string) => void} HttpResponseCallback */
/** @typedef {{batchSubject?: string, batchKey?: string, now?: number, cooldownMs?: number, connectionClose?: boolean, suppressErrorLog?: boolean}} SupportOptions */
/** @typedef {{label?: string, value?: unknown}} PlainTextField */
/** @typedef {{maxAgeMs?: number}} TokenOptions */
/** @typedef {{lastSentAt: number, events: Array<Record<string, unknown>>}} FyiDigest */
/**
 * @template T
 * @typedef {{enq: (value: T) => void, deq: () => T | undefined, size: () => number, toarray: () => T[], get: (index: number) => T | undefined}} CircularBuffer<T>
 */
/** @typedef {(body: RpcBody | string | Error, statusCode?: number) => void} JsonCallback */
/** @typedef {(method: string, params: unknown, callback: JsonCallback, optionsOrSuppressErrorLog?: boolean | SupportOptions) => void} RpcInvoker */
/** @typedef {(port: number, method: string, params: unknown, callback: JsonCallback, optionsOrSuppressErrorLog?: boolean | SupportOptions) => void} PortRpcInvoker */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @template T @param {number} size @returns {CircularBuffer<T>} */
function circularBuffer(size) {
    /** @type {Array<T | undefined>} */
    const data = new Array(size);
    let head = 0;
    let length = 0;

    /** @type {CircularBuffer<T>} */
    const buffer = {
        enq (value) {
            data[(head + length) % size] = value;
            if (length < size) {
                ++length;
            } else {
                head = (head + 1) % size;
            }
        },
        deq () {
            if (length === 0) {
                return undefined;
            }
            const value = data[head];
            data[head] = undefined;
            head = (head + 1) % size;
            --length;
            return value;
        },
        size () {
            return length;
        },
        toarray () {
            /** @type {T[]} */
            const result = [];
            for (let i = 0; i < length; ++i) {
                const value = data[(head + i) % size];
                if (typeof value !== "undefined") result.push(value);
            }
            return result;
        },
        get (index) {
            if (index < 0 || index >= length) {
                return undefined;
            }
            return data[(head + index) % size];
        }
    };

    return buffer;
}

// accumulates email notifications up to one hour (email/subject -> body)
/** @type {Record<string, string>} */
let emailAcc = {};
// last send time of email (email/subject -> time)
/** @type {Record<string, number>} */
let emailLastSendTime = {};
/** @type {number | undefined} */
let lastEmailSendTime;
/** @type {Record<string, number>} */
let fyiAlerts = {};
/** @type {Record<string, FyiDigest>} */
let fyiDailyAcc = {};

const FYI_COOLDOWN_MS = 60 * 60 * 1000;
const FYI_DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** @type {{emailBrand: string, emailSig: string, emailUnsubscribeBaseUrl: string}} */
const DEFAULT_GENERAL_EMAIL_CONFIG = {
    emailBrand: "MoneroOcean",
    emailSig: "MoneroOcean Admin Team",
    emailUnsubscribeBaseUrl: "https://api.moneroocean.stream"
};

/** @type {Record<string, string>} */
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
    remoteShareStalePendingSubject: "FYI: Pending blocks not verified for over a month",
    remoteShareStalePendingBody: "remote_share has %(count)s pending block(s) older than %(age_days)s days.\n\n%(jobs)s\n\nPlease verify wallet/daemon sync and pending_blocks.",
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
    statsDaemonFailBody: "The worker failed to return last block header for %(port)s port. Error detail: %(error)s. Please verify if the daemon or merged-mining relay is running properly.",
    statsDaemonRecoverSubject: "Querying daemon for %(port)s port for last block header is back to normal",
    statsDaemonRecoverBody: "A warning was sent to you indicating that the worker failed to return the last block header for %(port)s port. The issue seems to be solved now.",
    statsBehindBlocksSubject: "Pool node %(node)s is %(lag)s blocks behind",
    statsBehindBlocksBody: "Pool node %(node)s is %(lag)s blocks behind for %(port)s port",
    longRunnerStuckSubject: "long_runner stuck",
    longRunnerStuckBody: "%(stuck_count)s",
    longRunnerCleanSubject: "long_runner share history retention warning",
    longRunnerCleanBody: "long_runner is retaining share history spanning %(blocks)s block heights to protect pending payouts. " +
        "Oldest locked height: %(oldest_locked_height)s; current height: %(current_height)s.",
    uplinkBacklogSubject: "FYI: Pool uplink backlog",
    uplinkBacklogBody: "Queued shares: %(queued)s\nRunning sends: %(running)s\nTarget: %(target)s\nHost: %(host)s\n"
};

/** @param {unknown} value @returns {value is string} */
function isUsableNodeIp(value) {
    if (typeof value !== "string") return false;
    const normalized = value.trim();
    return normalized !== "" &&
        normalized !== "::" &&
        normalized !== "0.0.0.0" &&
        normalized !== "127.0.0.1" &&
        normalized !== "localhost";
}

/** @returns {string} */
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

/** @param {unknown} value @returns {string} */
function formatNodeEmailLabel(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    return raw.replace(/\.moneroocean\.stream$/i, "").split(".")[0] || raw;
}

/** @returns {string} */
function getPoolNodeEmailLabel() {
    const hostname = global.config && typeof global.config.hostname === "string" && global.config.hostname.trim() !== ""
        ? global.config.hostname.trim()
        : os.hostname();
    return formatNodeEmailLabel(hostname);
}

/** @param {string} moduleName @param {string} item @param {string} fallback @returns {string} */
function getConfiguredString(moduleName, item, fallback) {
    const configModule = global.config && global.config[moduleName];
    if (isRecord(configModule) && typeof configModule[item] === "string" && configModule[item].length > 0) {
        return configModule[item];
    }
    return fallback;
}

/** @returns {string} */
function getEmailBrand() {
    return getConfiguredString("general", "emailBrand", DEFAULT_GENERAL_EMAIL_CONFIG.emailBrand);
}

/** @returns {string} */
function getEmailSignature() {
    return getConfiguredString("general", "emailSig", DEFAULT_GENERAL_EMAIL_CONFIG.emailSig);
}

/** @returns {string} */
function getEmailUnsubscribeBaseUrl() {
    return getConfiguredString("general", "emailUnsubscribeBaseUrl", DEFAULT_GENERAL_EMAIL_CONFIG.emailUnsubscribeBaseUrl);
}

/** @param {string} item @param {string} [fallback] @returns {string} */
function getEmailTemplate(item, fallback) {
    return getConfiguredString("email", item, Object.prototype.hasOwnProperty.call(DEFAULT_EMAIL_TEMPLATES, item) ? DEFAULT_EMAIL_TEMPLATES[item] || "" : fallback || "");
}

/** @param {string} item @param {Record<string, unknown>} values @param {string} [fallback] @returns {string} */
function renderEmailTemplate(item, values, fallback) {
    return formatTemplate(getEmailTemplate(item, fallback), values || {});
}

/** @param {unknown} value @returns {string} */
function htmlEscape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function replaceChar(char) {
        const escaped = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[char];
        return escaped || char;
    });
}

/** @param {string} item @param {Record<string, unknown>} values @param {string | undefined} fallback @returns {string} */
function renderEmailHtmlTemplate(item, values, fallback) {
    /** @type {Record<string, unknown>} */
    const escapedValues = {};
    Object.keys(values || {}).forEach(function escapeValue(key) {
        escapedValues[key] = htmlEscape(values[key]);
    });
    return formatTemplate(getEmailTemplate(item, fallback), escapedValues);
}

/** @param {unknown} subject @param {"miner" | "admin"} audience @returns {string} */
function formatEmailSubject(subject, audience) {
    const rawSubject = String(subject || "");
    if (audience === "miner") {
        const brand = getEmailBrand();
        const brandPrefix = `${brand  }: `;
        return rawSubject.startsWith(brandPrefix) ? rawSubject : brandPrefix + rawSubject;
    }

    const nodeLabel = getPoolNodeEmailLabel();
    const subjectPrefix = `[${  nodeLabel  }] `;
    return rawSubject.startsWith(subjectPrefix) ? rawSubject : subjectPrefix + rawSubject;
}

/** @param {unknown} subject @param {unknown} body @returns {{subject: string, body: string}} */
function formatPoolNodeEmail(subject, body) {
    const formattedSubject = formatEmailSubject(subject, "admin");
    const nodeLabel = getPoolNodeEmailLabel();
    const bodyPrefix = `Pool node: ${  nodeLabel}`;
    const formattedBody = String(body || "").startsWith(bodyPrefix)
        ? String(body || "")
        : `${bodyPrefix  }\n\n${  String(body || "")}`;

    return {
        subject: formattedSubject,
        body: formattedBody
    };
}

/** @param {unknown} address @returns {string} */
function maskWalletAddress(address) {
    const value = typeof address === "string" ? address.trim() : "";
    if (value.length <= 12) return value;
    return `${value.slice(0, 6)  }...${  value.slice(-4)}`;
}

/** @returns {Buffer} */
function unsubscribeSecretKey() {
    const secKey = global.config && global.config.api && typeof global.config.api["secKey"] === "string"
        ? global.config.api["secKey"]
        : "";
    return Buffer.from(crypto.hkdfSync(
        "sha256",
        Buffer.from(secKey),
        Buffer.from("nodejs-pool-email-unsubscribe"),
        Buffer.from("email-unsubscribe-token"),
        32
    ));
}

/** @param {Buffer | string} value @returns {string} */
function base64UrlEncode(value) {
    return Buffer.from(value).toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

/** @param {string} value @returns {Buffer} */
function base64UrlDecode(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid token encoding");
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** @param {string} wallet @param {string} email @param {number} [issuedAt] @returns {string} */
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

/** @param {string} token @param {TokenOptions} [options] @returns {Record<string, unknown>} */
function parseEmailUnsubscribeToken(token, options) {
    const maxAgeMs = options && typeof options.maxAgeMs === "number" ? options.maxAgeMs : 30 * 24 * 60 * 60 * 1000;
    const raw = base64UrlDecode(token);
    if (raw.length <= 28) throw new Error("Invalid token length");
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", unsubscribeSecretKey(), nonce);
    decipher.setAuthTag(tag);
    /** @type {unknown} */
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
    if (!isRecord(payload) || typeof payload["wallet"] !== "string" || typeof payload["email"] !== "string" || typeof payload["iat"] !== "number") {
        throw new Error("Invalid token payload");
    }
    if (!Number.isFinite(payload["iat"]) || Date.now() - payload["iat"] > maxAgeMs || payload["iat"] > Date.now() + 5 * 60 * 1000) {
        throw new Error("Stale token");
    }
    return payload;
}

/** @param {string} wallet @param {string} email @returns {string} */
function createEmailUnsubscribeUrl(wallet, email) {
    const baseUrl = getEmailUnsubscribeBaseUrl().replace(/\/+$/g, "");
    return `${baseUrl  }/user/unsubscribeEmail/${  createEmailUnsubscribeToken(wallet, email)}`;
}

/** @param {unknown} body @param {string} [wallet] @param {string} [email] @returns {string} */
function appendUnsubscribeFooter(body, wallet, email) {
    if (!wallet || !email) return String(body || "");
    const unsubscribeUrl = createEmailUnsubscribeUrl(wallet, email);
    const footer = renderEmailTemplate("unsubscribeFooter", { unsubscribe_url: unsubscribeUrl }, DEFAULT_EMAIL_TEMPLATES["unsubscribeFooter"]);
    return `${String(body || "")  }\n\n${  footer}`;
}

/** @param {string} wallet @param {string} email @returns {string} */
function renderUnsubscribeSuccessHtml(wallet, email) {
    return renderEmailHtmlTemplate("unsubscribeSuccessHtml", { wallet, email }, DEFAULT_EMAIL_TEMPLATES["unsubscribeSuccessHtml"]);
}

/** @returns {string} */
function renderUnsubscribeErrorHtml() {
    return renderEmailHtmlTemplate("unsubscribeErrorHtml", {}, DEFAULT_EMAIL_TEMPLATES["unsubscribeErrorHtml"]);
}

/** @param {PlainTextField[]} fields @returns {string} */
function formatPlainTextFields(fields) {
    if (!Array.isArray(fields)) return "";
    return fields.filter(function hasValue(field) {
        return field && field.label && typeof field.value !== "undefined" && field.value !== null && String(field.value) !== "";
    }).map(function formatField(field) {
        return `${String(field.label)  }: ${  String(field.value)}`;
    }).join("\n");
}

/** @param {string | URL} targetUrl @param {HttpRequestOptions} options @param {HttpResponseCallback} callback @returns {void} */
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
        headers,
    };
    const transport = requestUrl.protocol === 'https:' ? https : http;
    let isFinished = false;
    /** @type {HttpResponse | null} */
    let response = null;
    /** @type {NodeJS.Timeout | null} */
    let wallTimeout = null;
    /** @param {Error | null} err @param {HttpResponse | null} [res] @param {string} [body] @returns {void} */
    const finalize = function (err, res, body) {
        if (isFinished) {
            return;
        }
        isFinished = true;
        if (wallTimeout !== null) {
            clearTimeout(wallTimeout);
            wallTimeout = null;
        }
        callback(err, res || null, body);
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

/** @param {unknown} err @param {HttpResponse | null} response @param {unknown} responseBody @returns {string} */
function formatHttpRequestFailure(err, response, responseBody) {
    const parts = [];
    if (err) {
        const code = isRecord(err) && typeof err["code"] !== "undefined" ? `${err["code"]  } ` : "";
        const message = err instanceof Error ? err.message : String(err);
        parts.push(`error=${  code  }${message}`);
    }
    if (response) parts.push(`status=${  response.statusCode  }${response.statusMessage ? ` ${  response.statusMessage}` : ""}`);
    if (typeof responseBody !== "undefined" && responseBody !== "") parts.push(`body=${  String(responseBody)}`);
    return parts.join(" ");
}

/** @param {string} toAddress @param {string} subject @param {string} email_body @param {number} [retry] @returns {void} */
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
    const body = `${JSON.stringify({
      from:    fromAddress,
      to:      recipient,
      subject,
      text:    email_body
    })  }\n`;
    makeHttpRequest(mailgunURL, {
        method: 'POST',
        body,
        rejectUnauthorized: global.config.general.mailgunNoCert === true ? false : true,
        headers: {
          "Content-Type":   "application/json",
          "Accept":         "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connection":     "close"
        }
    }, function(err, response, responseBody) {
        if (!err && response && response.statusCode === 200) {
            debug(email_body);
            console.log(formatLogEvent("Email", {
                to: recipient,
                status: "sent",
                response: responseBody
            }));
        } else {
            if (retry) {
                console.error(`Did not send e-mail to '${  recipient  }' successfully! ${  formatHttpRequestFailure(err, response, responseBody)}`);
            } else {
                setTimeout(sendEmailReal, 50*1000, recipient, subject, email_body, 1);
            }
        }
    });
}

/** @param {string} toAddress @param {string} subject @param {string} body @param {string} [wallet] @param {SupportOptions} [options] @returns {void} */
function sendEmail(toAddress, subject, body, wallet, options){
    const emailOptions = options || {};
    const isAdminEmail = toAddress === global.config.general.adminEmail;
    let batchKey = null;
    let finalSubject;
    let finalBody;
    if (isAdminEmail) {
        const formattedEmail = formatPoolNodeEmail(subject, body);
        finalSubject = formattedEmail.subject;
        finalBody = formattedEmail.body;
    } else {
        finalSubject = formatEmailSubject(emailOptions.batchSubject || subject, "miner");
        batchKey = typeof emailOptions.batchKey === "string" && emailOptions.batchKey.length > 0
            ? emailOptions.batchKey
            : finalSubject;
        finalBody = String(body || "");
    }

    if (isAdminEmail && !finalSubject.includes("FYI")) {
        sendEmailReal(toAddress, finalSubject, finalBody);
    } else {
        const reEmail = /^([a-zA-Z0-9_.-])+@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,4})+$/;
        if (!reEmail.test(toAddress)) {
            debug(`Avoid sending email to invalid address '${  toAddress  }'`);
            return;
        }
        const key = `${toAddress  }\t${  batchKey || finalSubject}`;
        if (!(key in emailAcc)) {
            emailAcc[key] = finalBody;
            scheduleBatchedEmail(key, toAddress, finalSubject, batchKey || finalSubject, wallet, isAdminEmail);
        } else {
            emailAcc[key] += `\n\n${  finalBody}`;
        }
    }
}

/** @param {string} toAddress @param {string} key @param {string} subject @param {string} body @param {SupportOptions} [options] @returns {boolean} */
function sendFyi(toAddress, key, subject, body, options) {
    if (typeof toAddress !== "string" || !toAddress.trim()) return false;
    const opts = options || {};
    const timeNow = typeof opts.now === "number" ? opts.now : Date.now();
    const cooldownMs = typeof opts.cooldownMs === "number" ? opts.cooldownMs : FYI_COOLDOWN_MS;
    const stateKey = `${toAddress  }\t${  key || subject}`;
    if (fyiAlerts[stateKey] && timeNow - fyiAlerts[stateKey] < cooldownMs) return false;
    fyiAlerts[stateKey] = timeNow;
    sendEmail(toAddress, subject, body);
    return true;
}

/** @param {string} toAddress @param {string} key @returns {boolean} */
function clearFyi(toAddress, key) {
    if (typeof toAddress !== "string" || !toAddress.trim()) return false;
    delete fyiAlerts[`${toAddress  }\t${  key}`];
    return true;
}

/** @param {string} key @param {string} subject @param {string} body @param {SupportOptions} [options] @returns {boolean} */
function sendAdminFyi(key, subject, body, options) {
    if (!global.config || !global.config.general || !global.config.general.adminEmail) return false;
    return sendFyi(global.config.general.adminEmail, key, subject, body, options);
}

/** @param {number} timestamp @returns {string} */
function formatFyiDailyTime(timestamp) {
    return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** @param {string} toAddress @param {string} key @param {string} subject @param {((events: Array<Record<string, unknown>>, helpers: {formatTime: (timestamp: number) => string}) => string) | string | undefined} buildBody @param {Record<string, unknown>} [event] @param {SupportOptions} [options] @returns {boolean} */
function sendFyiDaily(toAddress, key, subject, buildBody, event, options) {
    if (typeof toAddress !== "string" || !toAddress.trim()) return false;
    const opts = options || {};
    const timeNow = typeof opts.now === "number" ? opts.now : Date.now();
    const cooldownMs = typeof opts.cooldownMs === "number" ? opts.cooldownMs : FYI_DAILY_COOLDOWN_MS;
    const stateKey = `${toAddress  }\t${  key || subject}`;
    if (!fyiDailyAcc[stateKey]) fyiDailyAcc[stateKey] = { lastSentAt: 0, events: [] };

    const digest = fyiDailyAcc[stateKey];
    digest.events.push(Object.assign({ ts: timeNow }, event || {}));
    if (digest.lastSentAt && timeNow - digest.lastSentAt < cooldownMs) return false;

    const events = digest.events.slice();
    digest.events.length = 0;
    digest.lastSentAt = timeNow;
    const body = typeof buildBody === "function"
        ? buildBody(events, { formatTime: formatFyiDailyTime })
        : String(buildBody || "");
    sendEmail(toAddress, subject, body);
    return true;
}

/** @param {string} key @param {string} toAddress @param {string} subject @param {string} batchKey @param {string | undefined} wallet @param {boolean} isAdminEmail @returns {void} */
function scheduleBatchedEmail(key, toAddress, subject, batchKey, wallet, isAdminEmail) {
    const time_now = Date.now();
    const is_fast_email = !(key in emailLastSendTime) || time_now - (emailLastSendTime[key] || 0) > 6*60*60*1000;
    emailLastSendTime[key] = time_now;
    setTimeout(function(email_address, email_subject, email_batch_key, cb_wallet) {
        const key2 = `${email_address  }\t${  email_batch_key}`;
        let email_body = emailAcc[key2];
        delete emailAcc[key2];
        if (!isAdminEmail) email_body = appendUnsubscribeFooter(email_body, cb_wallet, email_address);
        const emailData = { wallet: cb_wallet };
        sendEmailReal(email_address, email_subject, `Hello,\n\n${  email_body  }\n\nThank you,\n${  formatTemplate(getEmailSignature(), emailData)}`);
    }, (is_fast_email ? 5 : 30)*60*1000, toAddress, subject, batchKey, wallet);
}

/** @returns {void} */
function resetEmailState() {
    emailAcc = {};
    emailLastSendTime = {};
    fyiAlerts = {};
    fyiDailyAcc = {};
    lastEmailSendTime = undefined;
}

/** @param {unknown} err @returns {string} */
function formatRequestError(err) {
    let message;
    if (err instanceof Error) {
        const errorName = typeof err.name === "string" && err.name.length > 0 ? err.name : "Error";
        message = `${errorName  }: ${  err.message || String(err)}`;
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

/** @param {URL} url @param {number | null | undefined} statusCode @param {unknown} err @param {boolean} suppressErrorLog @returns {void} */
function logJsonRequestError(url, statusCode, err, suppressErrorLog) {
    if (suppressErrorLog) return;
    const statusPrefix = typeof statusCode === "number" && statusCode >= 400 ? `HTTP ${  statusCode  } ` : "";
    console.error(`Error doing ${  url.toString()  } request: ${  statusPrefix  }${formatRequestError(err)}`);
}

/** @param {boolean | SupportOptions | undefined} options @returns {{connectionClose: boolean, suppressErrorLog: boolean}} */
function normalizeJsonRequestOptions(options) {
    if (options && typeof options === "object") {
        return {
            connectionClose: options.connectionClose !== false,
            suppressErrorLog: Boolean(options.suppressErrorLog)
        };
    }
    return {
        connectionClose: true,
        suppressErrorLog: Boolean(options)
    };
}

/** @param {string} host @param {number} port @param {unknown} data @param {JsonCallback} callback @param {string | undefined} path @param {number} timeout @param {boolean | SupportOptions | undefined} optionsOrSuppressErrorLog @returns {void} */
function jsonRequest(host, port, data, callback, path, timeout, optionsOrSuppressErrorLog) {
    const requestBehavior = normalizeJsonRequestOptions(optionsOrSuppressErrorLog);
    const requestPath = String(path || '').replace(/^\/+/, '');
    const url = new URL(`${(global.config.rpc.https ? "https://" : "http://") + host  }:${  port  }/${  requestPath}`);
    /** @type {HttpRequestOptions} */
    const options = {
        method: data ? "POST" : "GET",
        timeout,
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
    /** @param {Error | null} err @param {HttpResponse | null} res @param {string} [body] @returns {void} */
    const reply_fn = function (err, res, body) {
        if (err) {
            logJsonRequestError(url, null, err, requestBehavior.suppressErrorLog);
            return callback(err);
        }
        let json;
        try {
            json = JSON.parse(body || "");
        } catch (e) {
            debug(`JSON parse exception: ${  body}`);
            logJsonRequestError(url, res && res.statusCode, `JSON parse exception: ${  formatRequestError(e)}`, requestBehavior.suppressErrorLog);
            return callback(`JSON parse exception: ${  body}`);
        }
        if (json && Object.prototype.hasOwnProperty.call(json, "error") && json.error !== null) {
            logJsonRequestError(url, res && res.statusCode, json.error, requestBehavior.suppressErrorLog);
        } else if (res && typeof res.statusCode === "number" && res.statusCode >= 400) {
            logJsonRequestError(url, res.statusCode, "Unexpected HTTP status", requestBehavior.suppressErrorLog);
        }
        debug(`JSON result: ${  JSON.stringify(json)}`);
        return callback(json, res ? res.statusCode : undefined);
    };
    debug(`JSON REQUST: ${  JSON.stringify(options)}`);
    makeHttpRequest(url, options, reply_fn);
}

/** @param {string} host @param {number} port @param {string} method @param {unknown} params @param {JsonCallback} callback @param {number} timeout @param {boolean | SupportOptions | undefined} optionsOrSuppressErrorLog @returns {void} */
function rpc(host, port, method, params, callback, timeout, optionsOrSuppressErrorLog) {
    const data = {
        id: "0",
        jsonrpc: "2.0",
        method,
        params
    };
    return jsonRequest(host, port, data, callback, 'json_rpc', timeout, optionsOrSuppressErrorLog);
}

/** @param {string} host @param {number} port @param {string} method @param {unknown} params @param {JsonCallback} callback @param {number} timeout @param {boolean | SupportOptions | undefined} optionsOrSuppressErrorLog @returns {void} */
function rpc2(host, port, method, params, callback, timeout, optionsOrSuppressErrorLog) {
    return jsonRequest(host, port, params, callback, method, timeout, optionsOrSuppressErrorLog);
}

/** @param {string} url @param {(body: unknown) => void} callback @returns {void} */
function https_get(url, callback) {
  // Declared up-front so the error/response/request handler closures below can clear it;
  // the single assignment happens later at the setTimeout call.
  /** @type {NodeJS.Timeout | undefined} */
  // eslint-disable-next-line prefer-const -- separate declaration is needed so the handler closures can reference it before the assignment
  let timer;
  let is_callback_called = false;
  const req = https.get(url, function(res) {
    if (res.statusCode !== 200) {
      if (timer) clearTimeout(timer);
      console.error(`URL ${  url  }: Result code: ${  res.statusCode}`);
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
        console.error(`URL ${  url  }: JSON parse exception: ${  e}`);
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
      console.error(`URL ${  url  }: RESPONSE ERROR!`);
      if (!is_callback_called) {
        is_callback_called = true;
        callback(null);
      }
    });
  });
  req.on('error', function() {
    if (timer) clearTimeout(timer);
    console.error(`URL ${  url  }: REQUEST ERROR!`);
    if (!is_callback_called) {
      is_callback_called = true;
      callback(null);
    }
  });
  timer = setTimeout(function() {
    req.abort();
    console.error(`URL ${  url  }: TIMEOUT!`);
    if (!is_callback_called) {
      is_callback_called = true;
      callback(null);
    }
  }, 30*1000);
  req.end();
}

/** @param {string} coin @param {(factor: number | null) => void} callback @returns {void} */
function getCoinHashFactor(coin, callback) {
    global.mysql.query(`SELECT item_value FROM config WHERE module = 'daemon' and item = 'coinHashFactor${  coin  }'`).then(function (rows) {
        if (rows.length !== 1) {
        console.error(`Can't get config.daemon.coinHashFactor${  coin  } value`);
            return callback(null);
        }
        const itemValue = rows[0] && rows[0]["item_value"];
        if (typeof itemValue !== "string" && typeof itemValue !== "number") return callback(null);
        const factor = parseFloat(String(itemValue));
        callback(Number.isFinite(factor) ? factor : null);
    }).catch(function (error) {
       console.error(`SQL query failed: ${  error}`);
       return callback(0);
    });
}

/** @param {string} coin @param {number} coinHashFactor @returns {void} */
function setCoinHashFactor(coin, coinHashFactor) {
    global.mysql.query(`UPDATE config SET item_value = ? WHERE module = 'daemon' and item = 'coinHashFactor${  coin  }'`, [coinHashFactor]).catch(function (error) {
       console.error(`SQL query failed: ${  error}`);
    });
    global.config.daemon[`coinHashFactor${  coin}`] = coinHashFactor;
}

/** @param {number} value @returns {string} */
function padDatePart(value) { return value.toString().padStart(2, '0'); }

/** @param {string} template @param {Record<string, unknown>} values @returns {string} */
function formatTemplate(template, values) {
    return template.replace(/%\(([^)]+)\)s/g, function (_match, key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : '';
    });
}

/** @param {number | string | Date} date @returns {string} */
function formatDate(date) {
    // Date formatting for MySQL date time fields.
    const ts = new Date(date);
    return `${ts.getFullYear()  }-${ 
        padDatePart(ts.getMonth() + 1)  }-${ 
        padDatePart(ts.getDate())  } ${ 
        padDatePart(ts.getHours())  }:${ 
        padDatePart(ts.getMinutes())  }:${ 
        padDatePart(ts.getSeconds())}`;
}

/** @param {number | string | Date} date @returns {string} */
function formatDateUTC(date) {
    const ts = new Date(date);
    return `${ts.getUTCFullYear()  }-${ 
        padDatePart(ts.getUTCMonth() + 1)  }-${ 
        padDatePart(ts.getUTCDate())  } ${ 
        padDatePart(ts.getUTCHours())  }:${ 
        padDatePart(ts.getUTCMinutes())  }:${ 
        padDatePart(ts.getUTCSeconds())}`;
}

/** @param {number | string | Date} date @returns {number} */
function formatDateFromSQL(date) {
    // Parse a MySQL date time string into a Unix timestamp in seconds.
    const ts = new Date(date);
    return Math.floor(ts.getTime() / 1000);
}

/** @param {number | string} amount @returns {number} */
function coinToDecimal(amount) { return Number(amount) / global.config.coin.sigDigits; }

/** @param {number} amount @returns {number} */
function decimalToCoin(amount) { return Math.round(amount * global.config.coin.sigDigits); }

/** @typedef {{ts: number}} TimePoint */
/** @param {TimePoint} a @param {TimePoint} b @returns {number} */
function tsCompare(a, b) {
    if (a.ts < b.ts) {
        return 1;
    }

    if (a.ts > b.ts) {
        return -1;
    }
    return 0;
}

/** @param {number} port @returns {string} */
function port_wallet_ip(port) {
  const ip = global.config.wallet[`address_${  port.toString()}`];
  if (typeof ip === "string" && ip) return ip;
  return global.config.wallet.address;
}

/** @param {(host: string, port: number, method: string, params: unknown, callback: JsonCallback, timeout: number, options?: boolean | SupportOptions) => void} invoker @param {string | ((port: number) => string)} targetHost @param {number | (() => number)} targetPort @param {number} timeout @returns {RpcInvoker} */
function bindRpcCall(invoker, targetHost, targetPort, timeout) {
    return function callBoundRpc(method, params, callback, optionsOrSuppressErrorLog) {
        const port = typeof targetPort === "function" ? targetPort() : targetPort;
        return invoker(typeof targetHost === "function" ? targetHost(port) : targetHost, port, method, params, callback, timeout, optionsOrSuppressErrorLog);
    };
}

/** @param {(host: string, port: number, method: string, params: unknown, callback: JsonCallback, timeout: number, options?: boolean | SupportOptions) => void} invoker @param {string | ((port: number) => string)} targetHost @param {number} timeout @returns {PortRpcInvoker} */
function bindPortRpcCall(invoker, targetHost, timeout) {
    /** @param {number} port @param {string} method @param {unknown} params @param {JsonCallback} callback @param {boolean | SupportOptions} [optionsOrSuppressErrorLog] */
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
        rpcPortWalletShort: bindPortRpcCall(rpc, port_wallet_ip, 120*1000),
        circularBuffer,
        formatDate,
        formatDateUTC,
        coinToDecimal,
        decimalToCoin,
        formatDateFromSQL,
        sendEmail,
        sendFyi,
        clearFyi,
        sendAdminFyi,
        sendFyiDaily,
        detectNodeIp,
        tsCompare,
        getCoinHashFactor,
        setCoinHashFactor,
        https_get,
        formatTemplate,
        formatEmailSubject,
        formatPlainTextFields,
        getEmailTemplate,
        maskWalletAddress,
        renderEmailTemplate,
        createEmailUnsubscribeToken,
        parseEmailUnsubscribeToken,
        createEmailUnsubscribeUrl,
        renderUnsubscribeSuccessHtml,
        renderUnsubscribeErrorHtml,
        _resetEmailState: resetEmailState,
        emailDefaults: {
            general: DEFAULT_GENERAL_EMAIL_CONFIG,
            email: DEFAULT_EMAIL_TEMPLATES
        }
    };
};
