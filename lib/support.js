"use strict";
const http = require('http');
const https = require('https');
const debug = require('debug')('support');
const fs = require('fs');
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

    buffer.sum = function () {
        if (this.size() === 0) {
            return 1;
        }
        return this.toarray().reduce(function (a, b) {
            return a + b;
        });
    };

    buffer.average = function (lastShareTime) {
        if (this.size() === 0) {
            return global.config.pool.targetTime * 1.5;
        }
        let extra_entry = (Date.now() / 1000) - lastShareTime;
        return (this.sum() + Math.round(extra_entry)) / (this.size() + 1);
    };

    buffer.clear = function () {
        let i = this.size();
        while (i > 0) {
            this.deq();
            i = this.size();
        }
    };

    return buffer;
}

// accumulates email notifications up to one hour (email/subject -> body)
let emailAcc = {};
// last send time of email (email/subject -> time)
let emailLastSendTime = {};
let lastEmailSendTime;

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

function sendEmailReal(toAddress, subject, email_body, retry) {
    if (lastEmailSendTime && Date.now() - lastEmailSendTime < 1000) {
      setTimeout(sendEmailReal, 1000, toAddress, subject, email_body, retry);
      return;
    }
    lastEmailSendTime = Date.now();
    const body = JSON.stringify({
      from:    global.config.general.emailFrom,
      to:      toAddress,
      subject: subject,
      text:    email_body
    }) + "\n";
    makeHttpRequest(global.config.general.mailgunURL, {
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
            console.log("Email to '" + toAddress + "' was sent successfully!  Response: " + responseBody);
        } else {
            if (retry) {
                console.error("Did not send e-mail to '" + toAddress + "' successfully!  Response: " + responseBody + " Response: "+JSON.stringify(response));
            } else {
                setTimeout(sendEmailReal, 50*1000, toAddress, subject, email_body, 1);
            }
        }
    });
}

function sendEmail(toAddress, subject, body, wallet){
    if (toAddress === global.config.general.adminEmail && !subject.includes("FYI")) {
        sendEmailReal(toAddress, subject, body);
    } else {
        let reEmail = /^([a-zA-Z0-9_\.-])+@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,4})+$/;
        if (!reEmail.test(toAddress)) {
            debug("Avoid sending email to invalid address '" + toAddress + "'");
            return;
        }
        let key = toAddress + "\t" + subject;
        if (!(key in emailAcc)) {
            emailAcc[key] = body;
            let time_now = Date.now();
            let is_fast_email = !(key in emailLastSendTime) || time_now - emailLastSendTime[key] > 6*60*60*1000;
            emailLastSendTime[key] = time_now;
            setTimeout(function(email_address, email_subject, wallet) {
                let key2 = email_address + "\t" + email_subject;
                let email_body = emailAcc[key2];
                delete emailAcc[key2];
                let emailData = {
                    wallet: wallet
                };
                sendEmailReal(email_address, email_subject, "Hello,\n\n" + email_body + "\n\nThank you,\n" + formatTemplate(global.config.general.emailSig, emailData));
            }, (is_fast_email ? 5 : 30)*60*1000, toAddress, subject, wallet);
        } else {
            emailAcc[key] += body;
        }
    }
}

function sendEmailAdmin(subject, body){
	sendEmail(global.config.general.adminEmail, subject, body);
}

function formatRequestError(err) {
    if (err instanceof Error) return err.stack || err.message;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch (_error) {
        return String(err);
    }
}

function logJsonRequestError(url, statusCode, err, suppressErrorLog) {
    if (suppressErrorLog) return;
    const statusPrefix = typeof statusCode === "number" && statusCode >= 400 ? "HTTP " + statusCode + " " : "";
    console.error("Error doing " + url.toString() + " request: " + statusPrefix + formatRequestError(err));
}

function jsonRequest(host, port, data, callback, path, timeout, suppressErrorLog) {
    const requestPath = String(path || '').replace(/^\/+/, '');
    const url = new URL((global.config.rpc.https ? "https://" : "http://") + host + ":" + port + "/" + requestPath);
    let options = {
        method: data ? "POST" : "GET",
        timeout: timeout,
        headers: {
            "Content-Type": "application/json",
            "Accept":       "application/json",
            "Connection":   "close",
        }
    };
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
            logJsonRequestError(url, null, err, suppressErrorLog);
            return callback(err);
        }
        let json;
        try {
            json = JSON.parse(body);
        } catch (e) {
            debug("JSON parse exception: " + body);
            logJsonRequestError(url, res && res.statusCode, "JSON parse exception: " + e.message, suppressErrorLog);
            return callback("JSON parse exception: " + body);
        }
        if (json && Object.prototype.hasOwnProperty.call(json, "error") && json.error !== null) {
            logJsonRequestError(url, res && res.statusCode, json.error, suppressErrorLog);
        } else if (res && res.statusCode >= 400) {
            logJsonRequestError(url, res.statusCode, "Unexpected HTTP status", suppressErrorLog);
        }
        debug("JSON result: " + JSON.stringify(json));
        return callback(json, res.statusCode);
    };
    debug("JSON REQUST: " + JSON.stringify(options));
    makeHttpRequest(url, options, reply_fn);
}

function rpc(host, port, method, params, callback, timeout, suppressErrorLog) {
    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, callback, 'json_rpc', timeout, suppressErrorLog);
}

function rpc2(host, port, method, params, callback, timeout, suppressErrorLog) {
    return jsonRequest(host, port, params, callback, method, timeout, suppressErrorLog);
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

function padDatePart(value) {
    return value.toString().padStart(2, '0');
}

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

function formatDateFromSQL(date) {
    // Date formatting for MySQL date time fields.
    let ts = new Date(date);
    return Math.floor(ts.getTime() / 1000);
}

function coinToDecimal(amount) {
    return amount / global.config.coin.sigDigits;
}

function decimalToCoin(amount) {
    return Math.round(amount * global.config.coin.sigDigits);
}

function blockCompare(a, b) {
    if (a.height < b.height) {
        return 1;
    }

    if (a.height > b.height) {
        return -1;
    }
    return 0;
}

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

module.exports = function () {
    return {
        rpcDaemon: function (method, params, callback) {
            rpc(global.config.daemon.address, global.config.daemon.port, method, params, callback, 30*1000);
        },
        rpcPortDaemon: function (port, method, params, callback, suppressErrorLog) {
            rpc(global.config.daemon.address, port, method, params, callback, 30*1000, suppressErrorLog);
        },
        rpcPortDaemon2: function (port, method, params, callback, suppressErrorLog) {
            rpc2(global.config.daemon.address, port, method, params, callback, 30*1000, suppressErrorLog);
        },
        rpcWallet: function (method, params, callback) {
            rpc(port_wallet_ip(global.config.wallet.port), global.config.wallet.port, method, params, callback, 30*60*1000);
        },
        rpcPortWallet: function (port, method, params, callback) {
            rpc(port_wallet_ip(port), port, method, params, callback, 30*60*1000);
        },
        rpcPortWallet2: function (port, method, params, callback) {
            rpc2(port_wallet_ip(port), port, method, params, callback, 30*60*1000);
        },
        rpcPortWalletShort: function (port, method, params, callback) {
            rpc(port_wallet_ip(port), port, method, params, callback, 30*1000);
        },
        rpcPortWalletShort2: function (port, method, params, callback) {
            rpc2(port_wallet_ip(port), port, method, params, callback, 30*1000);
        },
        circularBuffer: circularBuffer,
        formatDate: formatDate,
        coinToDecimal: coinToDecimal,
        decimalToCoin: decimalToCoin,
        formatDateFromSQL: formatDateFromSQL,
        blockCompare: blockCompare,
        sendEmail: sendEmail,
	sendEmailAdmin: sendEmailAdmin,
        tsCompare: tsCompare,
        getCoinHashFactor: getCoinHashFactor,
        setCoinHashFactor: setCoinHashFactor,
        https_get: https_get,
        formatTemplate: formatTemplate,
    };
};
