"use strict";
const async = require('async');
const http = require('http');
const https = require('https');
const { URL } = require('url');

function postWithRetry(targetUrl, body, callback) {
    const requestUrl = new URL(targetUrl);
    const transport = requestUrl.protocol === 'https:' ? https : http;
    const req = transport.request({
        hostname: requestUrl.hostname,
        method: 'POST',
        path: requestUrl.pathname + requestUrl.search,
        port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
        headers: {
            'Content-Length': Buffer.byteLength(body),
            'Connection': 'close',
        },
    }, function (response) {
        response.resume();
        response.on('end', function () {
            callback(null, response.statusCode);
        });
    });
    req.on('error', function (error) {
        callback(error, 0);
    });
    req.setTimeout(30 * 1000, function () {
        req.destroy(new Error('Remote share POST timed out'));
    });
    req.end(body);
}

function Database() {

    let thread_id='';

    this.sendQueue = async.queue(function (task, callback) {
        async.doUntil(
            function (intCallback) {
                postWithRetry(global.config.general.shareHost, task.body, function (error, statusCode) {
                    return intCallback(null, error ? 0 : statusCode);
                });
            },
            function (data, untilCB) {
                return untilCB(null, data === 200);
            },
            function () {
                return callback();
            });
    }, require('os').cpus().length*32);

    this.storeShare = function (blockId, shareData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.SHARE,
            key: global.config.api.authKey,
            msg: shareData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeBlock = function (blockId, blockData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.BLOCK,
            key: global.config.api.authKey,
            msg: blockData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeAltBlock = function (blockId, blockData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.ALTBLOCK,
            key: global.config.api.authKey,
            msg: blockData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeInvalidShare = function (minerData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.INVALIDSHARE,
            key: global.config.api.authKey,
            msg: minerData,
            exInt: 1
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    setInterval(function(queue_obj){
        if ((queue_obj.length() > 20 || queue_obj.running() > 20) && global.database.thread_id === '(Master) '){
            console.log(global.database.thread_id + "Remote queue state: " + queue_obj.length() + " items in the queue " + queue_obj.running() + " items being processed");
        }
    }, 30*1000, this.sendQueue);


    this.initEnv = function(){
        this.data = null;
    };
}

module.exports = Database;
