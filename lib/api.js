"use strict";
const express = require('express');        // call express
const apicache = require('apicache');
const app = express();                 // define our app using express
const cache = apicache.middleware;
const cluster = require('cluster');
const async = require("async");
const debug = require("debug")("api");
const cnUtil = require('cryptoforknote-util');
const jwt = require('jsonwebtoken'); // used to create, sign, and verify tokens
const crypto = require('crypto');
const workerHistory = require("./common/worker_history");

let addressBase58Prefix = cnUtil.address_decode(Buffer.from(global.config.pool.address));
const threadName = cluster.isMaster ? "(Master) " : "(Worker " + cluster.worker.id + " - " + process.pid + ") ";
const pool_list = global.config.pplns && global.config.pplns.enable === true ? ['pplns'] : [];

let RPM = 0;

setInterval(function () {
    console.log(threadName + "RPM: " + RPM);
    RPM = 0;
}, 60*1000);

// Simple replacement for the previous open CORS policy from cors().
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});
app.use(express.urlencoded({extended: false}));
app.use(express.json());

function get_identifiers(address) {
    return global.database.getCache('identifiers:' + address);
}

function getHashHistoryFromCache(key) {
    return workerHistory.toHashHistory(global.database.getCache(key));
}

function normalizePoolType(poolType) {
    return poolType === 'pplns' ? 'pplns' : 'legacy';
}

function getPagination(req, defaultLimit, maxLimit) {
    const limit = typeof(req.query.limit) !== 'undefined' ? Number(req.query.limit) : defaultLimit;
    return [typeof(maxLimit) === 'number' && limit > maxLimit ? maxLimit : limit, typeof(req.query.page) !== 'undefined' ? Number(req.query.page) : 0];
}

// Support Functions that are reused now
function getAllWorkerHashCharts(address, callback){
    let identifiers = get_identifiers(address);
    let returnData = { global: getHashHistoryFromCache("history:" + address) };
    if (identifiers === false || identifiers.length == 0) return callback(null, returnData);
    identifiers.sort().forEach(function(identifier){
        returnData[identifier] = getHashHistoryFromCache("history:" + address + "_" + identifier);
    });
    return callback(null, returnData);
}

function getAllWorkerStats(address, callback){
    let identifiers = get_identifiers(address);
    let globalCache = global.database.getCache(address);
    let globalStatsCache = global.database.getCache("stats:" + address);
    let returnData = {
        global: {
            lts:           globalStatsCache !== false ? Math.floor(globalStatsCache.lastHash / 1000) : false,
            identifer:     'global',
            hash:          globalStatsCache !== false ? globalStatsCache.hash : false,
            hash2:         globalStatsCache !== false ? globalStatsCache.hash2 : false,
            totalHash:     globalCache !== false ? globalCache.totalHashes : false,
            validShares:   globalCache !== false ? Number(globalCache.goodShares) : false,
            invalidShares: globalCache !== false ? (globalCache.badShares ? Number(globalCache.badShares) : 0) : false

        }
    };
    if (identifiers === false || identifiers.length == 0) return callback(null, returnData);
    identifiers.sort().forEach(function(identifier){
        let id2 = address + "_" + identifier;
        let cachedData = global.database.getCache(id2);
        let cachedStatsData = global.database.getCache("stats:" + id2);
        returnData[identifier] = {
            lts:           cachedStatsData !== false ? Math.floor(cachedStatsData.lastHash / 1000) : false,
            identifer:     identifier,
            hash:          cachedStatsData !== false ? cachedStatsData.hash : false,
            hash2:         cachedStatsData !== false ? cachedStatsData.hash2 : false,
            totalHash:     cachedData !== false ? cachedData.totalHashes : false,
            validShares:   cachedData !== false ? Number(cachedData.goodShares) : false,
            invalidShares: cachedData !== false ? (cachedData.badShares ? Number(cachedData.badShares) : 0) : false
        };
    });
    return callback(null, returnData);
}

function getAddressStats(address, extCallback){
    const [address_pt, payment_id] = address.split('.');
    let cachedData = global.database.getCache(address);
    let cachedStatsData = global.database.getCache("stats:" + address);
    let paidQuery = "SELECT SUM(amount) as amt FROM payments WHERE payment_address = ? AND payment_id = ?";
    let txnQuery = "SELECT count(id) as amt FROM payments WHERE payment_address = ? AND payment_id = ?";
    let unpaidQuery = "SELECT SUM(amount) as amt FROM balance WHERE payment_address = ? AND payment_id = ?";
    if (typeof(payment_id) === 'undefined') {
        paidQuery = "SELECT SUM(amount) as amt FROM payments WHERE payment_address = ? AND payment_id IS ?";
        txnQuery = "SELECT count(id) as amt FROM payments WHERE payment_address = ? AND payment_id IS ?";
        unpaidQuery = "SELECT SUM(amount) as amt FROM balance WHERE payment_address = ? AND payment_id IS ?";
    }
    async.waterfall([
        function (callback) {
            debug(threadName + "Checking Influx for last 10min avg for /miner/address/stats");
            return callback(null, {
                hash:          cachedStatsData.hash,
                hash2:         cachedStatsData.hash2,
                identifier:    'global',
                lastHash:      Math.floor(cachedStatsData.lastHash / 1000),
                totalHashes:   cachedData.totalHashes,
                validShares:   Number(cachedData.goodShares),
                invalidShares: cachedData.badShares ? Number(cachedData.badShares) : 0
            });
        },
        function (returnData, callback) {
            debug(threadName + "Checking MySQL total amount paid for /miner/address/stats");
            global.mysql.query(paidQuery, [address_pt, payment_id]).then(function (rows) {
                if (typeof(rows[0]) === 'undefined') {
                    returnData.amtPaid = 0;
                } else {
                    returnData.amtPaid = rows[0].amt;
                    if (returnData.amtPaid === null) {
                        returnData.amtPaid = 0;
                    }
                }
                return callback(null, returnData);
            }).catch(function (error) {
                console.error("SQL query failed: " + error);
                return callback(null, {});
            });
        },
        function (returnData, callback) {
            debug(threadName + "Checking MySQL total amount unpaid for /miner/address/stats");
            global.mysql.query(unpaidQuery, [address_pt, payment_id]).then(function (rows) {
                if (typeof(rows[0]) === 'undefined') {
                    returnData.amtDue = 0;
                } else {
                    returnData.amtDue = rows[0].amt;
                    if (returnData.amtDue === null) {
                        returnData.amtDue = 0;
                    }
                }
                return callback(null, returnData);
            }).catch(function (error) {
                console.error("SQL query failed: " + error);
                return callback(null, {});
            });
        },
        function (returnData, callback) {
            debug(threadName + "Checking MySQL total amount unpaid for /miner/address/stats");
            global.mysql.query(txnQuery, [address_pt, payment_id]).then(function (rows) {
                if (typeof(rows[0]) === 'undefined') {
                    returnData.txnCount = 0;
                } else {
                    returnData.txnCount = rows[0].amt;
                    if (returnData.txnCount === null) {
                        returnData.txnCount = 0;
                    }
                }
                return callback(true, returnData);
            }).catch(function (error) {
                console.error("SQL query failed: " + error);
                return callback(null, {});
            });
        }
    ], function (err, result) {
        debug(threadName + "Result information for " + address + ": " + JSON.stringify(result));
        if (err === true) {
            return extCallback(null, result);
        }
        if (err) {
            console.error(threadName + "Error within the miner stats identifier func");
            return extCallback(err.toString());
        }
    });
}

// ROUTES FOR OUR API
// =============================================================================

// test route to make sure everything is working (accessed at GET http://localhost:8080/api)

// Config API
app.get('/config', cache('5 minutes'), function (req, res) {
    ++ RPM;
    res.json({
        pplns_fee: global.config.payout.pplnsFee,
        min_wallet_payout: global.config.payout.walletMin * global.config.general.sigDivisor,
        min_exchange_payout: global.config.payout.exchangeMin * global.config.general.sigDivisor,
        dev_donation: global.config.payout.devDonation,
        pool_dev_donation: global.config.payout.poolDevDonation,
        maturity_depth: global.config.payout.blocksRequired,
        min_denom: global.config.payout.denom * global.config.general.sigDivisor,
        coin_code: global.config.general.coinCode
    });
});

// Pool APIs
app.get('/pool/address_type/:address', cache('10 seconds'), function (req, res) {
    ++ RPM;
    let address = req.params.address;
    if (addressBase58Prefix === cnUtil.address_decode(Buffer.from(address))) {
        res.json({valid: true, address_type: global.config.general.coinCode});
    } else {
        res.json({valid: false});
    }
});

app.get('/pool/motd', cache('60 seconds'), function (req, res) {
    ++ RPM;
    const news = global.database.getCache('news');
    res.json({created: news.created, subject: news.subject, body: news.body});
});

app.get('/pool/stats', cache('10 seconds'), function (req, res) {
    ++ RPM;
    let localCache = global.database.getCache('pool_stats_global');
    delete(localCache.minerHistory);
    delete(localCache.hashHistory);
    let lastPayment = global.database.getCache('lastPaymentCycle');
    res.json({pool_list: pool_list, pool_statistics: localCache, last_payment: !lastPayment ? 0 : lastPayment});
});

app.get('/pool/chart/hashrate', cache('10 seconds'), function (req, res) {
    ++ RPM;
    res.json(getHashHistoryFromCache('global_stats'));
});

app.get('/pool/chart/miners', cache('10 seconds'), function (req, res) {
    ++ RPM;
    res.json(global.database.getCache('global_stats')['minerHistory']);
});

app.get('/pool/chart/hashrate/:pool_type', cache('10 seconds'), function (req, res) {
    ++ RPM;
    if (req.params.pool_type !== 'pplns') return res.json({'error': 'Invalid pool type'});
    res.json(getHashHistoryFromCache('pplns_stats'));
});

app.get('/pool/chart/miners/:pool_type', cache('10 seconds'), function (req, res) {
    ++ RPM;
    if (req.params.pool_type !== 'pplns') return res.json({'error': 'Invalid pool type'});
    res.json(global.database.getCache('stats_pplns')['minerHistory']);
});

app.get('/pool/stats/:pool_type', cache('10 seconds'), function (req, res) {
    ++ RPM;
    if (req.params.pool_type !== 'pplns') return res.json({'error': 'Invalid pool type'});
    let localCache = global.database.getCache('pool_stats_pplns');
    localCache.fee = global.config.payout.pplnsFee;
    delete(localCache.minerHistory);
    delete(localCache.hashHistory);
    res.json({pool_statistics: localCache});
});

app.get('/pool/ports', cache('10 seconds'), function (req, res) {
    ++ RPM;
    res.json(global.database.getCache('poolPorts'));
});

app.get('/pool/blocks/:pool_type', cache('10 seconds'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 25);
    res.json(global.database.getBlockList(req.params.pool_type, page*limit, (page + 1) * limit));
});

app.get('/pool/altblocks/:pool_type', cache('10 seconds'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 25);
    res.json(global.database.getAltBlockList(req.params.pool_type, null, page*limit, (page + 1) * limit));
});

app.get('/pool/blocks', cache('10 seconds'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 25);
    res.json(global.database.getBlockList(null, page*limit, (page + 1) * limit));
});

app.get('/pool/altblocks', cache('10 seconds'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 25);
    res.json(global.database.getAltBlockList(null, null, page*limit, (page + 1) * limit));
});

app.get('/pool/coin_altblocks/:coin_port', cache('10 seconds'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 25);
    res.json(global.database.getAltBlockList(null, parseInt(req.params.coin_port), page*limit, (page + 1) * limit));
});

app.get('/pool/payments/:pool_type', cache('1 minute'), function (req, res) {
    ++ RPM;
    let pool_type = req.params.pool_type;
    const [limit, page] = getPagination(req, 10);
    if (pool_type !== 'pplns') return res.json({'error': 'Invalid pool type'});
    let query = "SELECT distinct(transaction_id) as txnID FROM payments WHERE pool_type = ? ORDER BY transaction_id DESC LIMIT ? OFFSET ?";
    let response = [];
    global.mysql.query(query, [pool_type, limit, page * limit]).then(function (rows) {
        if (rows.length === 0) return res.json([]);
        const paymentIds = rows.map(function (row) { return row.txnID; });
        global.mysql.query("SELECT * FROM transactions WHERE id IN (" + paymentIds.join() + ") ORDER BY id DESC").then(function (txnIDRows) {
            txnIDRows.forEach(function (txnrow) {
                let ts = new Date(txnrow.submitted_time);
                response.push({
                    id: txnrow.id,
                    hash: txnrow.transaction_hash,
                    mixins: txnrow.mixin,
                    payees: txnrow.payees,
                    fee: txnrow.fees,
                    value: txnrow.xmr_amt,
                    ts: ts.getTime(),
                });
            });
            return res.json(response.sort(global.support.tsCompare));
        }).catch(function (error) {
            console.error("SQL query failed: " + error);
            return res.json({});
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting pool payments: " + JSON.stringify(err));
        return res.json({error: 'Issue getting pool payments'});
    });
});

// cache pool_type here just to avoid multiple SQL requests
let tx_pool_types = {};

app.get('/pool/payments', cache('1 minute'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 10);
    let query = "SELECT * FROM transactions ORDER BY id DESC LIMIT ? OFFSET ?";
    global.mysql.query(query, [limit, page * limit]).then(function (rows) {
        if (rows.length === 0) return res.json([]);
        let response = [];
        rows.forEach(function (row, index, array) {
            if (pool_list.length === 1 || (row.id in tx_pool_types && tx_pool_types[row.id] != "?")) {
                let ts = new Date(row.submitted_time);
                response.push({
                    id: row.id,
                    hash: row.transaction_hash,
                    mixins: row.mixin,
                    payees: row.payees,
                    fee: row.fees,
                    value: row.xmr_amt,
                    ts: ts.getTime(),
                    pool_type: (pool_list.length === 1 ? normalizePoolType(pool_list[0]) : tx_pool_types[row.id])
                });
                if (array.length === response.length) {
                    res.json(response.sort(global.support.tsCompare));
                }
            } else {
                global.mysql.query("SELECT pool_type FROM payments WHERE transaction_id = ? LIMIT 1", [row.id]).then(function (ptRows) {
                    if (ptRows.length === 0) {
                        console.error("Unknown pool_type for tx_id " + row.id);
                        ptRows = [ { "pool_type": "?" } ];
                    }
                    let ts = new Date(row.submitted_time);
                    tx_pool_types[row.id] = normalizePoolType(ptRows[0].pool_type);
                    response.push({
                        id: row.id,
                        hash: row.transaction_hash,
                        mixins: row.mixin,
                        payees: row.payees,
                        fee: row.fees,
                        value: row.xmr_amt,
                        ts: ts.getTime(),
                        pool_type: tx_pool_types[row.id]
                    });
                    if (array.length === response.length) {
                        res.json(response.sort(global.support.tsCompare));
                    }
                }).catch(function (error) {
                    console.error("SQL query failed: " + error);
                    return res.json({});
                });
            }
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting miner payments: " + JSON.stringify(err));
        res.json({error: 'Issue getting pool payments'});
    });
});

// Network APIs
app.get('/network/stats', cache('10 seconds'), function (req, res) {
    ++ RPM;
    res.json(global.database.getCache('networkBlockInfo'));
});

// Miner APIs
app.get('/miner/:address/identifiers', cache('10 seconds'), function (req, res) {
    ++ RPM;
    let address = req.params.address;
    return res.json(get_identifiers(address));
});

app.get('/miner/:address/payments', cache('1 minute'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 25);
    const [address, payment_id] = req.params.address.split('.');
    let query = "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM " +
        "payments WHERE payment_address = ? AND payment_id = ? ORDER BY paid_time DESC LIMIT ? OFFSET ?";
    if (typeof(payment_id) === 'undefined') {
        query = "SELECT amount as amt, pool_type, transaction_id, UNIX_TIMESTAMP(paid_time) as ts FROM " +
            "payments WHERE payment_address = ? AND payment_id IS ? ORDER BY paid_time DESC LIMIT ? OFFSET ?";
    }
    let response = [];
    global.mysql.query(query, [address, payment_id, limit, page * limit]).then(function (rows) {
        if (rows.length === 0) return res.json(response);
        rows.forEach(function (row, index, array) {
            debug(threadName + "Got rows from initial SQL query: " + JSON.stringify(row));
            global.mysql.query("SELECT transaction_hash, mixin FROM transactions WHERE id = ? ORDER BY id DESC", [row.transaction_id]).then(function (txnrows) {
                txnrows.forEach(function (txnrow) {
                    debug(threadName + "Got a row that's a transaction ID: " + JSON.stringify(txnrow));
                    response.push({
                        pt: normalizePoolType(row.pool_type),
                        ts: Math.ceil(row.ts),
                        amount: row.amt,
                        txnHash: txnrow.transaction_hash,
                        mixin: txnrow.mixin
                    });
                    if (array.length === response.length) {
                        return res.json(response.sort(global.support.tsCompare));
                    }
                });
            }).catch(function (error) {
                console.error("SQL query failed: " + error);
                return res.json({});
            });
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting miner payments: " + JSON.stringify(err));
        return res.json({error: 'Issue getting miner payments'});
    });
});

app.get('/miner/:address/block_payments', cache('1 minute'), function (req, res) {
    ++ RPM;
    const [limit, page] = getPagination(req, 10, 100);
    const [address, payment_id] = req.params.address.split('.');
    const where_str = typeof(payment_id) === 'undefined'
                      ? "payment_address = '" + address + "' AND (payment_id IS NULL OR payment_id = '')"
                      : "payment_address = '" + address + "' AND payment_id = '" + payment_id + "'";

    global.mysql.query("SELECT * FROM paid_blocks WHERE paid_time > (NOW() - INTERVAL 7 DAY) ORDER BY id DESC LIMIT ? OFFSET ?", [limit, page * limit]).then(function (rows) {
        if (rows.length === 0) return res.json([]);
        let block_hexes = [];
        rows.forEach(function (row) { block_hexes.push('"' + row.hex + '"'); });

        global.mysql.query("SELECT hex, amount FROM block_balance WHERE " + where_str + " AND hex IN (" + block_hexes.join() + ")").then(function (rows2) {
            let block_miner_shares = {};
            rows2.forEach(function (row2) { block_miner_shares[row2.hex] = row2.amount; });
            let response = [];
            rows.forEach(function (row) {
                const miner_payment_share = row.hex in block_miner_shares ? block_miner_shares[row.hex] : 0;
                response.push({
                    id:            row.id,
                    ts:            (new Date(row.paid_time)).getTime() / 1000,
                    ts_found:      (new Date(row.found_time)).getTime() / 1000,
                    port:          row.port,
                    hash:          row.hex,
                    value_percent: miner_payment_share * 100.0,
                    value:         miner_payment_share * row.amount / global.config.general.sigDivisor
                });
            });
            return res.json(response.sort(global.support.tsCompare));
        }).catch(function (err) {
            console.error(threadName + "Error getting block_balance miner block payments: " + JSON.stringify(err));
            return res.json({error: 'Issue getting block payments'});
        });
    }).catch(function (err) {
        console.error(threadName + "Error getting paid_blocks miner block payments: " + JSON.stringify(err));
        return res.json({error: 'Issue getting block payments'});
    });
});

app.get('/miner/:address/stats/allWorkers', cache('10 seconds'), function (req, res) {
    ++ RPM;
    getAllWorkerStats(req.params.address, function(err, data){
        return res.json(data);
    });
});

app.get('/miner/:address/stats/:identifier', cache('10 seconds'), function (req, res) {
    ++ RPM;
    let address = req.params.address;
    let identifier = req.params.identifier;
    let memcKey = address + "_" + identifier;
    let cachedData = global.database.getCache(memcKey);
    let cachedStatsData = global.database.getCache("stats:" + memcKey);
    return res.json({
        lts:           Math.floor(cachedStatsData.lastHash / 1000),
        identifer:     identifier,
        hash:          cachedStatsData.hash,
        hash2:         cachedStatsData.hash2,
        totalHash:     cachedData.totalHashes,
        validShares:   Number(cachedData.goodShares),
        invalidShares: cachedData.badShares ? Number(cachedData.badShares) : 0
    });
});

app.get('/miner/:address/chart/hashrate', cache('10 seconds'), function (req, res) {
    ++ RPM;
    return res.json(getHashHistoryFromCache("history:" + req.params.address));
});

app.get('/miner/:address/chart/hashrate/allWorkers', cache('10 seconds'), function (req, res) {
    ++ RPM;
    getAllWorkerHashCharts(req.params.address, function(err, data){
        return res.json(data);
    });
});

app.get('/miner/:address/chart/hashrate/:identifier', cache('10 seconds'), function (req, res) {
    ++ RPM;
    return res.json(getHashHistoryFromCache("history:" + req.params.address + "_" + req.params.identifier));
});

app.get('/miner/:address/stats', cache('1 minute'), function (req, res) {
    ++ RPM;
    getAddressStats(req.params.address, function(err, data){
        return res.json(data);
    });
});

app.get('/user/:address', function (req, res) {
    ++ RPM;
    global.mysql.query("SELECT payout_threshold, enable_email FROM users WHERE username = ? LIMIT 1", [req.params.address]).then(function(row){
        if (row.length == 1) {
            return res.json({payout_threshold: row[0].payout_threshold, email_enabled: row[0].enable_email});
        } else {
            return res.json({payout_threshold: global.support.decimalToCoin(global.config.payout.defaultPay), email_enabled: 0});
        }
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

app.post('/user/subscribeEmail', function (req, res) {
    ++ RPM;
    const username = req.body.username;
    if (!username) return res.status(401).send({'success': false, 'msg': "No \"username\" parameter was found"});
    if (!("enabled" in req.body)) return res.status(401).send({'success': false, 'msg': "No \"enabled\" parameter was found"});
    if (!("from" in req.body)) return res.status(401).send({'success': false, 'msg': "No \"from\" parameter was found"});
    if (!("to" in req.body)) return res.status(401).send({'success': false, 'msg': "No \"to\" parameter was found"});
    const enabled = req.body.enabled;
    const from    = req.body.from;
    const to      = req.body.to;
    if (from === "" && to === "") {
        global.mysql.query("UPDATE users SET enable_email = ? WHERE username = ?", [enabled, username]).then(function (result) {
	    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                return res.status(401).json({'error': 'This XMR address does not have email subscription'});
            } else {
                return res.json({'msg': 'Email preferences were updated'});
            }
        }).catch(function (error) {
            console.error("SQL query failed: " + error);
            return res.json({});
        });
    } else if (from === "") {
        global.mysql.query("UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND (email IS NULL OR email = '')", [enabled, to, username]).then(function (result) {
	    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                if (global.database.getCache(username) === false) return res.status(401).send({'success': false, 'msg': "Can't set email for unknown user"});
                global.mysql.query("INSERT INTO users (username, enable_email, email) VALUES (?, ?, ?)", [username, enabled, to]).then(function () {
                    return res.json({'msg': 'Email preferences were updated'});
                }).catch(function(err) {
                    return res.status(401).json({'error': 'Please specify valid FROM email'});
		});
            } else {
                return res.json({'msg': 'Email preferences were updated'});
            }
        }).catch(function (error) {
            console.error("SQL query failed: " + error);
            return res.json({});
        });
    } else {
        global.mysql.query("UPDATE users SET enable_email = ?, email = ? WHERE username = ? AND email = ?", [enabled, to, username, from]).then(function (result) {
	    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                return res.status(401).json({'error': 'FROM email does not match'});
            } else {
                return res.json({'msg': 'Email preferences were updated'});
            }
        }).catch(function (error) {
            console.error("SQL query failed: " + error);
            return res.json({});
        });
    }
});

app.get('/user/:address/unsubscribeEmail', function (req, res) {
    ++ RPM;
    global.mysql.query("UPDATE users SET enable_email = 0 WHERE username = ?", [req.params.address]).then(function (result) {
        if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
            return res.status(401).json({'error': 'This XMR address does not have email subscription'});
        } else {
            return res.json({'msg': 'Your email was unsubscribed from further notifications'});
        }
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

app.post('/user/updateThreshold', function (req, res) {
    ++ RPM;
    let threshold = req.body.threshold;
    if (!threshold) return res.status(401).send({'success': false, 'msg': "Can't set threshold to a wrong value"});
    if (threshold > 1000) threshold = 1000;
    const username = req.body.username;
    if (!username || global.database.getCache(username) === false) return res.status(401).send({'success': false, 'msg': "Can't set threshold for unknown user"});
    const threshold2 = global.support.decimalToCoin(threshold < global.config.payout.walletMin ? global.config.payout.walletMin : threshold);
    global.mysql.query("SELECT * FROM users WHERE username = ? AND payout_threshold_lock = '1'", [username]).then(function (rows) {
        if (rows.length === 0) {
            global.mysql.query("INSERT INTO users (username, payout_threshold) VALUES (?, ?) ON DUPLICATE KEY UPDATE payout_threshold=?", [username, threshold2, threshold2]).then(function () {
                return res.json({'msg': 'Threshold updated, set to: ' + global.support.coinToDecimal(threshold2)});
            });
        } else {
            return res.status(401).send({'success': false, 'msg':"Can't update locked payment threshold"});
        }
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

// Authentication
app.post('/authenticate', function (req, res) {
    ++ RPM;
    let hmac;
    try{
        hmac = crypto.createHmac('sha256', global.config.api.secKey).update(req.body.password).digest('hex');
    } catch (e) {
        return res.status(401).send({'success': false, msg: 'Invalid password'});
    }
    global.mysql.query("SELECT * FROM users WHERE username = ? AND ((pass IS null AND email = ?) OR (pass = ?))", [req.body.username, req.body.password, hmac]).then(function (rows) {
        if (rows.length === 0) {
            global.mysql.query("SELECT * FROM users WHERE username = ?", [req.body.username]).then(function (rows) {
                if (rows.length === 0) {
                    return res.status(401).send({'success': false, msg: 'Password is not set, so you can not login now.'});
                }
                global.mysql.query("SELECT * FROM users WHERE username = ? AND pass IS null", [req.body.username]).then(function (rows) {
                    if (rows.length !== 0) {
                        return res.status(401).send({'success': false, msg: 'Wrong password. Password equals to string after : character in your miner password field.'});
                    }
                    return res.status(401).send({'success': false, msg: 'Wrong password. Password was set by you in Dashboard Options before.'});
                });
            });
        } else {
            let token = jwt.sign({id: rows[0].id}, global.config.api.secKey, {expiresIn: '1d'});
            return res.json({'success': true, 'msg': token});
        }
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

// JWT Verification
// get an instance of the router for api routes
let secureRoutes = express.Router();
// route middleware to verify a token
secureRoutes.use(function (req, res, next) {
    let token = req.body.token || req.query.token || req.headers['x-access-token'];
    if (token) {
        jwt.verify(token, global.config.api.secKey, function (err, decoded) {
            if (err) {
                return res.json({success: false, msg: 'Failed to authenticate token.'});
            } else {
                req.decoded = decoded;
                next();
            }
        });

    } else {
        return res.status(403).send({
            success: false,
            msg: 'No token provided.'
        });
    }
});

// Secure/logged in routes.

secureRoutes.get('/tokenRefresh', function (req, res) {
    ++ RPM;
    let token = jwt.sign({id: req.decoded.id}, global.config.api.secKey, {expiresIn: '1d'});
    return res.json({'msg': token});
});

secureRoutes.get('/', function (req, res) {
    ++ RPM;
    global.mysql.query("SELECT payout_threshold, enable_email, email FROM users WHERE id = ?", [req.decoded.id]).then(function(row){
        return res.json({msg: {payout_threshold: row[0].payout_threshold, email_enabled: row[0].enable_email, email: row[0].email}});
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

secureRoutes.post('/changePassword', function (req, res) {
    ++ RPM;
    let hmac = crypto.createHmac('sha256', global.config.api.secKey).update(req.body.password).digest('hex');
    global.mysql.query("UPDATE users SET pass = ? WHERE id = ?", [hmac, req.decoded.id]).then(function () {
        return res.json({'msg': 'Password updated'});
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

secureRoutes.post('/changeEmail', function (req, res) {
    ++ RPM;
    global.mysql.query("UPDATE users SET email = ? WHERE id = ?", [req.body.email, req.decoded.id]).then(function () {
        return res.json({'msg': 'Updated email was set to: ' + req.body.email});
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

secureRoutes.post('/toggleEmail', function (req, res) {
    ++ RPM;
    global.mysql.query("UPDATE users SET enable_email = NOT enable_email WHERE id = ?", [req.decoded.id]).then(function () {
        return res.json({'msg': 'Email toggled'});
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

secureRoutes.post('/changePayoutThreshold', function (req, res) {
    ++ RPM;
    let threshold = req.body.threshold;
    if (!threshold) return res.status(401).send({'success': false, 'msg': "Can't set threshold to a wrong value"});
    if (threshold < global.config.payout.walletMin) threshold = global.config.payout.walletMin;
    threshold = global.support.decimalToCoin(threshold);
    global.mysql.query("UPDATE users SET payout_threshold = ? WHERE id = ?", [threshold, req.decoded.id]).then(function () {
        return res.json({'msg': 'Threshold updated, set to: ' + global.support.coinToDecimal(threshold)});
    }).catch(function (error) {
        console.error("SQL query failed: " + error);
        return res.json({});
    });
});

// apply the routes to our application with the prefix /api
app.use('/authed', secureRoutes);

// Authenticated routes

let workerList = [];

if (cluster.isMaster) {
    let numWorkers = require('os').cpus().length;
    console.log('Master cluster setting up ' + numWorkers + ' workers...');

    for (let i = 0; i < numWorkers; i++) {
        let worker = cluster.fork();
        workerList.push(worker);
    }

    cluster.on('online', function (worker) {
        console.log('Worker ' + worker.process.pid + ' is online');
    });

    cluster.on('exit', function (worker, code, signal) {
        console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
        console.log('Starting a new worker');
        worker = cluster.fork();
        workerList.push(worker);
    });
} else {
    app.listen(8001, function () {
        console.log('Process ' + process.pid + ' is listening to all incoming requests');
    });
}
