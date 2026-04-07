"use strict";
const CircularBuffer = require('circular-buffer');
const http = require('http');
const https = require('https');
const debug = require('debug')('support');
const fs = require('fs');
const sprintf = require("sprintf-js").sprintf;

function circularBuffer(size) {
    let buffer = CircularBuffer(size);

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

function buildFetchOptions(options) {
    const fetchOptions = {
        method: options.method || "GET",
        headers: Object.assign({}, options.headers),
    };

    if (options.body !== undefined) fetchOptions.body = options.body;
    if (options.timeout) fetchOptions.signal = AbortSignal.timeout(options.timeout);

    return fetchOptions;
}

function makeResponseMeta(response) {
    return {
        statusCode: response.status,
        headers: response.headers,
    };
}

function fetchWithCallback(url, options, callback) {
    fetch(url, buildFetchOptions(options)).then(function (response) {
        return response.text().then(function (body) {
            callback(null, makeResponseMeta(response), body);
        });
    }).catch(function (error) {
        callback(error);
    });
}

function postWithCallback(url, options, callback) {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || 'POST',
        headers: Object.assign({}, options.headers),
    };

    if (options.agentOptions && typeof options.agentOptions.rejectUnauthorized === "boolean") {
        requestOptions.rejectUnauthorized = options.agentOptions.rejectUnauthorized;
    }

    const req = transport.request(requestOptions, function(response) {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", function(chunk) { body += chunk; });
        response.on("end", function() {
            callback(null, { statusCode: response.statusCode, headers: response.headers }, body);
        });
        response.on("error", function(error) {
            callback(error);
        });
    });

    if (options.timeout) {
        req.setTimeout(options.timeout, function() {
            req.destroy(new Error("Request timeout"));
        });
    }

    req.on("error", function(error) {
        callback(error);
    });

    if (options.body !== undefined) req.write(options.body);
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
    postWithCallback(global.config.general.mailgunURL, {
        method: "POST",
        body: body,
        agentOptions: {
            rejectUnauthorized: global.config.general.mailgunNoCert === true ? false : true
        },
        headers: {
          "Content-Type":   "application/json",
          "Accept":         "application/json",
          "Content-Length": body.length,
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
                sendEmailReal(email_address, email_subject, "Hello,\n\n" + email_body + "\n\nThank you,\n" + sprintf(global.config.general.emailSig, emailData));
            }, (is_fast_email ? 5 : 30)*60*1000, toAddress, subject, wallet);
        } else {
            emailAcc[key] += body;
        }
    }
}

function sendEmailAdmin(subject, body){
	sendEmail(global.config.general.adminEmail, subject, body);
}

function jsonRequest(host, port, data, callback, path, timeout) {
    path = path || 'json_rpc';
    let options = {
        url: (global.config.rpc.https ? "https://" : "http://") + host + ":" + port + "/" + path,
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
        options.headers["Content-Length"] = data2.length;
        options.body = data2;
    }
    let reply_fn = function (err, res, body) {
        if (err) {
            console.error("Error doing " + options.url + " request: " + err);
            return callback(err);
        }
        let json;
        try {
            json = JSON.parse(body);
        } catch (e) {
            debug("JSON parse exception: " + body);
            return callback("JSON parse exception: " + body);
        }
        debug("JSON result: " + JSON.stringify(json));
        return callback(json, res.statusCode);
    };
    debug("JSON REQUST: " + JSON.stringify(options));
    fetchWithCallback(options.url, options, reply_fn);
}

function rpc(host, port, method, params, callback, timeout) {
    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, callback, 'json_rpc', timeout);
}

function rpc2(host, port, method, params, callback, timeout) {
    return jsonRequest(host, port, params, callback, method, timeout);
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

function formatDate(date) {
    function pad(num) {
        return num < 10 ? "0" + num : num.toString();
    }

    let ts = new Date(date);
    return ts.getFullYear() + "-" +
        pad(ts.getMonth() + 1) + "-" +
        pad(ts.getDate()) + " " +
        pad(ts.getHours()) + ":" +
        pad(ts.getMinutes()) + ":" +
        pad(ts.getSeconds());
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
        rpcPortDaemon: function (port, method, params, callback) {
            rpc(global.config.daemon.address, port, method, params, callback, 30*1000);
        },
        rpcPortDaemon2: function (port, method, params, callback) {
            rpc2(global.config.daemon.address, port, method, params, callback, 30*1000);
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
    };
};
