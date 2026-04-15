"use strict";
let debug = require('debug')('db');
let async = require('async');
let cleanShareInProgress = false;
let cleanShareStuckCount = 0;
const CLEAN_SHARE_BLOCK_HEADER_RETRIES = 3;
const CLEAN_SHARE_BLOCK_HEADER_RETRY_DELAY_MS = 1000;

function formatCleanShareRpcFailure(err, body) {
    function formatErrorLike(errorLike) {
        if (!errorLike || typeof errorLike !== "object") return null;
        if (!(errorLike instanceof Error) && typeof errorLike.message !== "string" && typeof errorLike.code === "undefined") {
            return null;
        }

        const parts = [];
        if (typeof errorLike.code !== "undefined") parts.push(String(errorLike.code));
        if (typeof errorLike.errno !== "undefined") parts.push("errno=" + String(errorLike.errno));
        if (typeof errorLike.syscall === "string") parts.push("syscall=" + errorLike.syscall);
        if (typeof errorLike.message === "string" && errorLike.message.length > 0) parts.push(errorLike.message);
        if (parts.length !== 0) return parts.join(" ");

        if (typeof errorLike.stack === "string" && errorLike.stack.length > 0) {
            return errorLike.stack.split("\n")[0];
        }
        return errorLike.constructor && errorLike.constructor.name ? errorLike.constructor.name : "error";
    }

    if (err && err.stack) return err.stack;
    if (typeof err !== "undefined" && err !== null && err !== true) {
        const formattedErr = formatErrorLike(err);
        if (formattedErr) return formattedErr;
        if (typeof err === "string") return err;
        try {
            return JSON.stringify(err);
        } catch (_error) {}
    }
    if (typeof body !== "undefined") {
        const formattedBody = formatErrorLike(body);
        if (formattedBody) return formattedBody;
        if (typeof body === "string") return body;
        if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) {
            return "empty daemon response";
        }
        try {
            return JSON.stringify(body);
        } catch (_error) {}
    }
    return "unknown error";
}

function logShareCleanup(message) {
    console.log("Share DB cleanup: " + message);
}

function poolTypeStr(poolType) {
    return poolType === global.protos.POOLTYPE.PPLNS ? 'pplns' : 'legacy';
}

function Database(){
    this.lmdb = require('node-lmdb');
    this.env = null;
    this.shareDB = null;
    this.blockDB = null;
    this.altblockDB = null;
    this.cacheDB = null;


    this.initEnv = function(){
        global.database.env = new this.lmdb.Env();
        global.database.env.open({
            path: global.config.db_storage_path,
            maxDbs: 10,
            mapSize: global.config.general.dbSizeGB * 1024 * 1024 * 1024,
            useWritemap: true,
            maxReaders: 512
        });
        global.database.shareDB = this.env.openDbi({
            name: 'shares',
            create: true,
            dupSort: true,
            dupFixed: false,
            integerDup: true,
            integerKey: true,
            keyIsUint32: true
        });
        global.database.blockDB = this.env.openDbi({
            name: 'blocks',
            create: true,
            integerKey: true,
            keyIsUint32: true
        });
        global.database.altblockDB = this.env.openDbi({
            name: 'altblocks',
            create: true,
            integerKey: true,
            keyIsUint32: true
        });
        global.database.cacheDB = this.env.openDbi({
            name: 'cache',
            create: true
        });
        //global.database.intervalID = setInterval(function(){
        //    global.database.env.sync(function(){});
        //}, 60000);  // Sync the DB every 60 seconds
    };

    this.incrementCacheData = function(key, data){
        let txn = this.env.beginTxn();
        let cached = txn.getString(this.cacheDB, key);
        if (cached !== null){
            cached = JSON.parse(cached);
            data.forEach(function(intDict){
                if (!cached.hasOwnProperty(intDict.location) || intDict.value === false){
                    cached[intDict.location] = 0;
                } else {
                    cached[intDict.location] += intDict.value;
                }
            });
            txn.putString(this.cacheDB, key, JSON.stringify(cached));
            txn.commit();
        } else {
            txn.abort();
        }
    };

    this.getBlockList = function(pool_type, first, last) {
        debug("Getting block list");
        pool_type = pool_type === 'pplns' ? global.protos.POOLTYPE.PPLNS : false;
        let response = [];
        try{
            let txn = global.database.env.beginTxn({readOnly: true});
            let cursor = new global.database.lmdb.Cursor(txn, global.database.blockDB);
            for (let found = cursor.goToLast(), i = 0; found; found = cursor.goToPrev()) {
                if (typeof last !== 'undefined' && i >= last) break;
                cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                    let blockData = global.protos.Block.decode(data);
                    let poolType = poolTypeStr(blockData.poolType);
                    if (pool_type === false || blockData.poolType === pool_type) {
                        if (typeof first !== 'undefined' && i++ < first) return;
                        response.push({
                            ts: blockData.timestamp,
                            hash: blockData.hash,
                            diff: blockData.difficulty,
                            shares: blockData.shares,
                            height: key,
                            valid: blockData.valid,
                            unlocked: blockData.unlocked,
                            pool_type: poolType,
                            value: blockData.value
                        });
                    }
                });
            }
            cursor.close();
            txn.abort();
            return response; //.sort(global.support.blockCompare);
        } catch (e){
            return response;
        }
    };

    this.getAltBlockList = function(pool_type, coin_port, first, last) {
        debug("Getting altblock list");
        pool_type = pool_type === 'pplns' ? global.protos.POOLTYPE.PPLNS : false;
        let response = [];
        try{
            let txn = global.database.env.beginTxn({readOnly: true});
            let cursor = new global.database.lmdb.Cursor(txn, global.database.altblockDB);
            for (let found = cursor.goToLast(), i = 0; found; found = cursor.goToPrev()) {
                if (typeof last !== 'undefined' && i >= last) break;
                cursor.getCurrentBinary(function (key, data) {  // jshint ignore:line
                    let blockData = global.protos.AltBlock.decode(data);
                    let poolType = poolTypeStr(blockData.poolType);
                    if ((pool_type === false || blockData.poolType === pool_type) && (!coin_port || blockData.port === coin_port)) {
                        if (typeof first !== 'undefined' && i++ < first) return;
                        response.push({
                            ts: blockData.timestamp,
                            hash: blockData.hash,
                            diff: blockData.difficulty,
                            shares: blockData.shares,
                            height: blockData.height,
                            valid: blockData.valid,
                            unlocked: blockData.unlocked,
                            pool_type: poolType,
                            value: blockData.value,
                            pay_value: blockData.pay_value,
                            pay_stage: blockData.pay_stage,
                            pay_status: blockData.pay_status,
                            port: blockData.port
                        });
                    }
                });
            }
            cursor.close();
            txn.abort();
            return response; //.sort(global.support.tsCompare);
        } catch (e){
            return response;
        }
    };

    this.storeInvalidShare = function(shareData, callback){
        try {
            let share = global.protos.InvalidShare.decode(shareData);
            let minerID = share.paymentAddress;
            if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                minerID = minerID + '.' + share.paymentID;
            }
            let minerIDWithIdentifier = minerID + "_" + share.identifier;
            this.incrementCacheData(minerIDWithIdentifier, [{location: 'badShares', value: share.count ? share.count : 1}]);
            this.incrementCacheData(minerID, [{location: 'badShares', value: share.count ? share.count : 1}]);
            callback(true);
        } catch (e){
            console.error("Ran into an error storing an invalid share.  Damn!");
            callback(false);
        }
    };

    this.getBlockByID = function(blockID){
        debug("Getting the data for blockID: " + blockID);
        let txn = this.env.beginTxn({readOnly: true});
        let data = txn.getBinary(this.blockDB, blockID);
        if (data === null){
            debug("Unable to get block at height: "+ blockID);
            return false;
        }
        let blockData = global.protos.Block.decode(data);
        txn.commit();
        debug("Done getting the last block for: "+ blockData.poolType + " height of: "+ blockID);
        return blockData;
    };

    this.invalidateBlock = function(blockId){
        let txn = this.env.beginTxn();
        let blockData = global.protos.Block.decode(txn.getBinary(this.blockDB, blockId));
        blockData.valid = false;
        blockData.unlocked = true;
        txn.putBinary(this.blockDB, blockId, global.protos.Block.encode(blockData));
        txn.commit();
    };

    this.invalidateAltBlock = function(blockId){
        let txn = this.env.beginTxn();
        let blockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, blockId));
        blockData.valid = false;
        blockData.unlocked = true;
        txn.putBinary(this.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        txn.commit();
    };

    this.changeAltBlockPayStageStatus = function(blockId, pay_stage, pay_status){
        let txn = this.env.beginTxn();
        let blockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, blockId));
        blockData.pay_stage  = pay_stage;
        blockData.pay_status = pay_status;
        txn.putBinary(this.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        txn.commit();
    };

    this.moveAltBlockReward = function(srcBlockId, dstBlockId, srcAmount){
        let txn = this.env.beginTxn();
        let srcBlockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, srcBlockId));
        let dstBlockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, dstBlockId));
        dstBlockData.value += srcAmount;
        srcBlockData.value = 0;
        srcBlockData.pay_stage  = "Paid by other block";
        srcBlockData.pay_status = "Will be paid by block " + dstBlockData.hash + " on " + dstBlockData.height + " height";
        srcBlockData.unlocked   = true;
        txn.putBinary(this.altblockDB, srcBlockId, global.protos.AltBlock.encode(srcBlockData));
        txn.putBinary(this.altblockDB, dstBlockId, global.protos.AltBlock.encode(dstBlockData));
        txn.commit();
    };

    this.changeAltBlockPayValue = function(blockId, pay_value){
        let txn = this.env.beginTxn();
        let blockData = global.protos.AltBlock.decode(txn.getBinary(this.altblockDB, blockId));
        blockData.pay_value  = pay_value;
        txn.putBinary(this.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        txn.commit();
    };

    this.getValidLockedBlocks = function(){
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        let blockList = [];
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.valid === true && blockData.unlocked === false){
                    blockData.height = key;
                    blockList.push(blockData);
                }
            });
        }
        cursor.close();
        txn.commit();
        return blockList;
    };

    this.getValidLockedAltBlocks = function(){
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        let blockList = [];
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.valid === true && blockData.unlocked === false){
                    blockData.id = key;
                    blockList.push(blockData);
                }
            });
        }
        cursor.close();
        txn.commit();
        return blockList;
    };

    this.isAltBlockInDB = function(port, height){
        let txn = this.env.beginTxn({readOnly: true});
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        let isBlockFound = false;
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.port === port && blockData.height === height){
                    isBlockFound = true;
                }
            });
        }
        cursor.close();
        txn.commit();
        return isBlockFound;
    };

    this.unlockBlock = function(blockHex){
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let blockDB = this.blockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.hash === blockHex){
                    blockData.unlocked = true;
                    txn.putBinary(blockDB, key, global.protos.Block.encode(blockData));
                }
            });
            blockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.unlockAltBlock = function(blockHex){
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let altblockDB = this.altblockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.hash === blockHex){
                    blockData.unlocked = true;
                    txn.putBinary(altblockDB, key, global.protos.AltBlock.encode(blockData));
                }
            });
            altblockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.payReadyBlock = function(blockHex){
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.blockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let blockDB = this.blockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.Block.decode(data);
                if (blockData.hash === blockHex){
                    blockData.pay_ready = true;
                    txn.putBinary(blockDB, key, global.protos.Block.encode(blockData));
                }
            });
            blockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.payReadyAltBlock = function(blockHex){
        let txn = this.env.beginTxn();
        let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
        for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
            let altblockDB = this.altblockDB;
            cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                let blockData = global.protos.AltBlock.decode(data);
                if (blockData.hash === blockHex){
                    blockData.pay_ready = true;
                    txn.putBinary(altblockDB, key, global.protos.AltBlock.encode(blockData));
                }
            });
            altblockDB = null;
        }
        cursor.close();
        txn.commit();
    };

    this.getCache = function(cacheKey){
        debug("Getting Key: "+cacheKey);
        try {
            let txn = this.env.beginTxn({readOnly: true});
            let cached = txn.getString(this.cacheDB, cacheKey);
            txn.abort();
            if (cached !== null){
                debug("Result for Key: " + cacheKey + " is: " + cached);
                return JSON.parse(cached);
            }
        } catch (e) {
            return false;
        }
        return false;
    };

    this.setCache = function(cacheKey, cacheData){
        debug("Setting Key: "+cacheKey+ " Data: " + JSON.stringify(cacheData));
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, cacheKey, JSON.stringify(cacheData));
        txn.commit();
    };

    this.bulkSetCache = function(cacheUpdates){
        let txn = this.env.beginTxn();
        for (const [key, value] of Object.entries(cacheUpdates)) {
          const value_str = JSON.stringify(value);
          txn.putString(this.cacheDB, key, value_str);
          //size += key.length + value_str.length;
        }
        txn.commit();
        //this.env.sync(function() {
          //console.log("Wrote " + size + " bytes to LMDB");
        //});
    };

    this.getOldestLockedBlockHeight = function(){
        /*
        6-29-2017 - Snipa -
        This function returns a decompressed block proto for the first locked block in the system as part of the
        share depth functions.  DO NOT BLINDLY REPLACE getLastBlock WITH THIS FUNCTION.
        */
        debug("Getting the oldest locked block in the system");

        let oldestLockedBlockHeight = null;

        let txn = this.env.beginTxn({readOnly: true});

        {   let cursor = new this.lmdb.Cursor(txn, this.altblockDB);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                 cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                     let blockData = global.protos.AltBlock.decode(data);
                     if (blockData.unlocked === false && blockData.pay_ready !== true){
                         if (oldestLockedBlockHeight === null || oldestLockedBlockHeight > blockData.anchor_height) {
                             oldestLockedBlockHeight = blockData.anchor_height;
                         }
                     }
                 });
            }
            cursor.close();
        }

        {   let cursor = new this.lmdb.Cursor(txn, this.blockDB);
            for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                 cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                     if (oldestLockedBlockHeight !== null && oldestLockedBlockHeight <= key) return;
                     let blockData = global.protos.Block.decode(data);
                     if (blockData.unlocked === false && blockData.pay_ready !== true) {
                         oldestLockedBlockHeight = key;
                     }
                 });
            }
            cursor.close();
        }

        txn.commit();

        if (oldestLockedBlockHeight !== null) {
            console.log("Got the oldest locked block in the system at height: " + oldestLockedBlockHeight.toString());
        } else {
            console.log("There are no locked blocks in the system. Woohoo!");
        }
        return oldestLockedBlockHeight;
    };

    this.cleanShareDB = function(done) {
        /*
         This keeps enough PPLNS share history around to unlock any still-locked blocks safely.
         If nothing is locked we can scan from the current chain tip and aggressively prune old shares.
         */
        const finish = typeof done === "function" ? done : function () {};
	if (cleanShareInProgress) {
	    console.error("Share DB cleanup is already running");
	    ++cleanShareStuckCount;
	    if (cleanShareStuckCount > 5) global.support.sendEmail(global.config.general.adminEmail,"LongRunner stuck",cleanShareStuckCount);
	    finish(new Error("Share DB cleanup is already running"));
	    return; // already running
	}
	cleanShareInProgress = true;
        let oldestLockedBlockHeight = this.getOldestLockedBlockHeight();
        async.waterfall([
            function(callback){
                if (oldestLockedBlockHeight === null) {
                    callback(null, null, null);
                } else {
                    let attempt = 0;
                    function requestBlockHeader() {
                        ++attempt;
                        global.coinFuncs.getBlockHeaderByID(oldestLockedBlockHeight, function(err, result) {
                            if (err === null && result && typeof result.difficulty !== "undefined") {
                                callback(null, oldestLockedBlockHeight, result.difficulty);
                                return;
                            }

                            const failure = formatCleanShareRpcFailure(err, result);
                            console.error(
                                "Share DB cleanup: can't get main block with " +
                                oldestLockedBlockHeight +
                                " height on attempt " +
                                attempt +
                                "/" +
                                CLEAN_SHARE_BLOCK_HEADER_RETRIES +
                                ": " +
                                failure
                            );
                            if (attempt >= CLEAN_SHARE_BLOCK_HEADER_RETRIES) {
                                callback(true);
                                return;
                            }
                            setTimeout(requestBlockHeader, CLEAN_SHARE_BLOCK_HEADER_RETRY_DELAY_MS);
                        }, true);
                    }
                    requestBlockHeader();
                }
            },
            function(oldestLockedBlockHeight, oldestLockedBlockDifficulty, callback){
                global.coinFuncs.getLastBlockHeader(function(err, body){
                    if (err !== null) {
                        console.error("Last block header request failed!");
                        return callback(true);
                    }
                    if (oldestLockedBlockHeight === null){
                        logShareCleanup("no locked blocks found. scanning from current height " + body.height);
                        callback(null, body.height, Math.floor(body.difficulty * global.config.pplns.shareMulti * 2));
                    } else {
                        logShareCleanup("block depth to keep is " + (body.height - oldestLockedBlockHeight));
                        if (body.height - oldestLockedBlockHeight > global.config.general.blockCleanWarning) {
                            global.support.sendEmail(global.config.general.adminEmail, "longRunner module can not clean DB good enough", "longRunner can not clean " + (body.height - oldestLockedBlockHeight) + " block from DB!");
                        }
                        callback(null, oldestLockedBlockHeight, Math.floor(oldestLockedBlockDifficulty * global.config.pplns.shareMulti * 2));
                    }
                }, true);
            },
            function (lastBlock, difficulty, callback) {
                let shareCount = 0;
                let pplnsFound = false;
                let blockSet = {};
                logShareCleanup("scanning from " + lastBlock + " for more than " + difficulty + " shares");
                let txn = global.database.env.beginTxn({readOnly: true});
                let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
                for (let blockID = lastBlock - 1; blockID > 0; --blockID) {
                    debug("Scanning block: " + blockID);
                    for (let found = (cursor.goToRange(parseInt(blockID)) === blockID); found; found = cursor.goToNextDup()) {
                        if (pplnsFound) {
                            blockSet[blockID] = 1;
                            break;
                        } else {
                            cursor.getCurrentBinary(function(key, data) {  // jshint ignore:line
                                try{
                                    let shareData = global.protos.Share.decode(data);
                                    if (shareData.poolType === global.protos.POOLTYPE.PPLNS){
                                        shareCount += shareData.shares2;
                                    }
                                } catch(e){
                                    console.error("Invalid share");
                                }
                            });
                            if (shareCount >= difficulty){
                                pplnsFound = true;
                                logShareCleanup("found the first block to be deleted at " + blockID + " height");
                                break;
                            }
                        }
                    }
                }
                cursor.close();
                txn.abort();
                logShareCleanup("scan finished");
                callback(null, Array.from(Object.keys(blockSet)));
            }
        ], function(err, data){
            if (err !== null) {
		    console.error("Share DB cleanup aborted because the main daemon block-header lookup failed");
		    cleanShareInProgress = false;
		    finish(new Error("Share DB cleanup aborted because the main daemon block-header lookup failed"));
		    return;
	    }
            if (global.config.general.blockCleaner === true){
                if(data.length > 0){
                    let totalDeleted = 0;
                    let totalDeleted2 = 0;
                    logShareCleanup("block cleaning started: removing " + data.length + " block share records");
                    let txn = global.database.env.beginTxn();
                    data.forEach(function(block){
                        ++ totalDeleted;
                        ++ totalDeleted2;
                        debug("Deleted block: " + parseInt(block));
                        txn.del(global.database.shareDB, parseInt(block));
			if (totalDeleted2 > 100) {
			    txn.commit();
			    txn = global.database.env.beginTxn();
                            totalDeleted2 = 0;
			}
                    });
                    txn.commit();
                    logShareCleanup("block cleaning finished: removed " + totalDeleted + " block share records");
                }
                global.database.env.sync(function(){
                });
            } else {
                logShareCleanup("block cleaning disabled. would have removed: " + JSON.stringify(data));
            }
            cleanShareInProgress = false;
            cleanShareStuckCount = 0;
            logShareCleanup("finished");
            finish(null);
        });
    };
}

module.exports = Database;
