"use strict";
let debug = require('debug')('db');
let cleanShareInProgress = false;
let cleanShareStuckCount = 0;
const CLEAN_SHARE_BLOCK_HEADER_RETRIES = 3;
const CLEAN_SHARE_BLOCK_HEADER_RETRY_DELAY_MS = 1000;
const poolTypeStr = require("./pool_type.js");

function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
            return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
        });
}

function isErrorLike(errorLike) {
    if (!errorLike || typeof errorLike !== "object") return false;
    if (errorLike instanceof Error) return true;
    return typeof errorLike.message === "string" || typeof errorLike.code !== "undefined";
}

function formatErrorLike(errorLike) {
    if (!isErrorLike(errorLike)) return null;
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

function stringifyFallback(value) {
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return null;
    }
}

function formatRpcFailureValue(value) {
    const formatted = formatErrorLike(value);
    if (formatted) return formatted;
    if (typeof value === "string") return value;
    return stringifyFallback(value);
}

function formatBodyRpcFailure(body) {
    if (typeof body === "undefined") return "unknown error";
    const formattedBody = formatErrorLike(body);
    if (formattedBody) return formattedBody;
    if (typeof body === "string") return body;
    return formatBodyObjectFailure(body);
}

function formatBodyObjectFailure(body) {
    const isEmptyObjectResponse = body && typeof body === "object" && !Array.isArray(body) &&
        Object.keys(body).length === 0;
    if (isEmptyObjectResponse) return "empty daemon response";
    const stringifiedBody = stringifyFallback(body);
    return stringifiedBody === null ? "unknown error" : stringifiedBody;
}

function formatErrRpcFailure(err, body) {
    const formattedErr = formatRpcFailureValue(err);
    return formattedErr === null ? formatBodyRpcFailure(body) : formattedErr;
}

function formatCleanShareRpcFailure(err, body) {
    if (err && err.stack) return err.stack;
    if (typeof err !== "undefined" && err !== null && err !== true) return formatErrRpcFailure(err, body);
    return formatBodyRpcFailure(body);
}

function logShareCleanup(message) {
    console.log("Share DB cleanup: " + message);
}

function Database(){
    const self = this;
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
    };

    function abortTxn(txn) {
        if (!txn) return;
        try {
            txn.abort();
        } catch (_error) {}
    }

    function commitTxn(txn) {
        if (!txn) return;
        txn.commit();
    }

    function closeCursor(cursor) {
        if (!cursor) return;
        try {
            cursor.close();
        } catch (_error) {}
    }

    function withReadTxn(run) {
        const txn = self.env.beginTxn({readOnly: true});
        try {
            return run(txn);
        } finally {
            abortTxn(txn);
        }
    }

    function withWriteTxn(run) {
        const txn = self.env.beginTxn();
        let committed = false;

        function commit() {
            if (committed) return;
            commitTxn(txn);
            committed = true;
        }

        try {
            const result = run(txn, commit);
            commit();
            return result;
        } finally {
            if (!committed) abortTxn(txn);
        }
    }

    function withCursor(txn, db, run) {
        const cursor = new self.lmdb.Cursor(txn, db);
        try {
            return run(cursor);
        } finally {
            closeCursor(cursor);
        }
    }

    function withReadCursor(txn, db, run) {
        return withCursor(txn, db, run);
    }

    this.incrementCacheData = function(key, data){
        withWriteTxn(function(txn){
            let cached = txn.getString(self.cacheDB, key);
            if (cached === null) return;
            cached = JSON.parse(cached);
            data.forEach(function(intDict){
                if (!cached.hasOwnProperty(intDict.location) || intDict.value === false){
                    cached[intDict.location] = 0;
                } else {
                    cached[intDict.location] += intDict.value;
                }
            });
            txn.putString(self.cacheDB, key, JSON.stringify(cached));
        });
    };

    this.getBlockList = function(pool_type, first, last) {
        debug("Getting block list");
        pool_type = pool_type === 'pplns' ? global.protos.POOLTYPE.PPLNS : false;
        let response = [];
        try{
            return withReadTxn(function(txn) {
                return withReadCursor(txn, self.blockDB, function(cursor) {
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
                    return response;
                });
            });
        } catch (e){
            return response;
        }
    };

    this.getAltBlockList = function(pool_type, coin_port, first, last) {
        debug("Getting altblock list");
        pool_type = pool_type === 'pplns' ? global.protos.POOLTYPE.PPLNS : false;
        let response = [];
        try{
            return withReadTxn(function(txn) {
                return withReadCursor(txn, self.altblockDB, function(cursor) {
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
                    return response;
                });
            });
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

    this.invalidateBlock = function(blockId){
        withWriteTxn(function(txn){
            let blockData = global.protos.Block.decode(txn.getBinary(self.blockDB, blockId));
            blockData.valid = false;
            blockData.unlocked = true;
            txn.putBinary(self.blockDB, blockId, global.protos.Block.encode(blockData));
        });
    };

    this.invalidateAltBlock = function(blockId){
        withWriteTxn(function(txn){
            let blockData = global.protos.AltBlock.decode(txn.getBinary(self.altblockDB, blockId));
            blockData.valid = false;
            blockData.unlocked = true;
            txn.putBinary(self.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        });
    };

    this.changeAltBlockPayStageStatus = function(blockId, pay_stage, pay_status){
        withWriteTxn(function(txn){
            let blockData = global.protos.AltBlock.decode(txn.getBinary(self.altblockDB, blockId));
            blockData.pay_stage  = pay_stage;
            blockData.pay_status = pay_status;
            txn.putBinary(self.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        });
    };

    this.moveAltBlockReward = function(srcBlockId, dstBlockId, srcAmount){
        withWriteTxn(function(txn){
            let srcBlockData = global.protos.AltBlock.decode(txn.getBinary(self.altblockDB, srcBlockId));
            let dstBlockData = global.protos.AltBlock.decode(txn.getBinary(self.altblockDB, dstBlockId));
            dstBlockData.value += srcAmount;
            srcBlockData.value = 0;
            srcBlockData.pay_stage  = "Paid by other block";
            srcBlockData.pay_status = "Will be paid by block " + dstBlockData.hash + " on " + dstBlockData.height + " height";
            srcBlockData.unlocked   = true;
            txn.putBinary(self.altblockDB, srcBlockId, global.protos.AltBlock.encode(srcBlockData));
            txn.putBinary(self.altblockDB, dstBlockId, global.protos.AltBlock.encode(dstBlockData));
        });
    };

    this.changeAltBlockPayValue = function(blockId, pay_value){
        withWriteTxn(function(txn){
            let blockData = global.protos.AltBlock.decode(txn.getBinary(self.altblockDB, blockId));
            blockData.pay_value  = pay_value;
            txn.putBinary(self.altblockDB, blockId, global.protos.AltBlock.encode(blockData));
        });
    };

    this.getValidLockedBlocks = function(){
        let blockList = [];
        return withReadTxn(function(txn) {
            return withReadCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.Block.decode(data);
                        if (blockData.valid === true && blockData.unlocked === false){
                            blockData.height = key;
                            blockList.push(blockData);
                        }
                    });
                }
                return blockList;
            });
        });
    };

    this.getValidLockedAltBlocks = function(){
        let blockList = [];
        return withReadTxn(function(txn) {
            return withReadCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.valid === true && blockData.unlocked === false){
                            blockData.id = key;
                            blockList.push(blockData);
                        }
                    });
                }
                return blockList;
            });
        });
    };

    this.isAltBlockInDB = function(port, height){
        let isBlockFound = false;
        return withReadTxn(function(txn) {
            return withReadCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.port === port && blockData.height === height){
                            isBlockFound = true;
                        }
                    });
                }
                return isBlockFound;
            });
        });
    };

    this.unlockBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.Block.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.unlocked = true;
                            txn.putBinary(self.blockDB, key, global.protos.Block.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    this.unlockAltBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.unlocked = true;
                            txn.putBinary(self.altblockDB, key, global.protos.AltBlock.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    this.payReadyBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.Block.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.pay_ready = true;
                            txn.putBinary(self.blockDB, key, global.protos.Block.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    this.payReadyAltBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        let blockData = global.protos.AltBlock.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.pay_ready = true;
                            txn.putBinary(self.altblockDB, key, global.protos.AltBlock.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    this.getCache = function(cacheKey){
        debug("Getting Key: "+cacheKey);
        try {
            return withReadTxn(function(txn) {
                let cached = txn.getString(self.cacheDB, cacheKey);
                if (cached !== null){
                    debug("Result for Key: " + cacheKey + " is: " + cached);
                    return JSON.parse(cached);
                }
                return false;
            });
        } catch (e) {
            return false;
        }
    };

    this.setCache = function(cacheKey, cacheData){
        debug("Setting Key: "+cacheKey+ " Data: " + JSON.stringify(cacheData));
        withWriteTxn(function(txn){
            txn.putString(self.cacheDB, cacheKey, JSON.stringify(cacheData));
        });
    };

    this.bulkSetCache = function(cacheUpdates){
        withWriteTxn(function(txn){
            for (const [key, value] of Object.entries(cacheUpdates)) {
              const value_str = JSON.stringify(value);
              txn.putString(self.cacheDB, key, value_str);
            }
        });
    };

    this.getOldestLockedBlockHeight = function(){
        /*
        6-29-2017 - Snipa -
        This function returns a decompressed block proto for the first locked block in the system as part of the
        share depth functions.  DO NOT BLINDLY REPLACE getLastBlock WITH THIS FUNCTION.
        */
        debug("Getting the oldest locked block in the system");

        let oldestLockedBlockHeight = null;

        withReadTxn(function(txn) {
            withReadCursor(txn, self.altblockDB, function(cursor) {
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
            });

            withReadCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                     cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                         if (oldestLockedBlockHeight !== null && oldestLockedBlockHeight <= key) return;
                         let blockData = global.protos.Block.decode(data);
                         if (blockData.unlocked === false && blockData.pay_ready !== true) {
                             oldestLockedBlockHeight = key;
                         }
                     });
                }
            });
        });

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
	    if (cleanShareStuckCount > 5) {
	        const values = { stuck_count: cleanShareStuckCount };
	        global.support.sendEmail(
	            global.config.general.adminEmail,
	            renderEmailTemplate("longRunnerStuckSubject", values, "long_runner stuck"),
	            renderEmailTemplate("longRunnerStuckBody", values, "%(stuck_count)s")
	        );
	    }
	    finish(new Error("Share DB cleanup is already running"));
	    return; // already running
		}
		cleanShareInProgress = true;
        let oldestLockedBlockHeight = this.getOldestLockedBlockHeight();
        const abortMessage = "Share DB cleanup aborted because the main daemon block-header lookup failed";

        function abortCleanup() {
            console.error(abortMessage);
            cleanShareInProgress = false;
            finish(new Error(abortMessage));
        }

        function finalizeCleanup(data) {
            if (global.config.general.blockCleaner === true){
                if(data.length > 0){
                    let totalDeleted = 0;
                    let totalDeleted2 = 0;
                    logShareCleanup("block cleaning started: removing " + data.length + " block share records");
                    let txn = null;
                    try {
                        txn = global.database.env.beginTxn();
                        data.forEach(function(block){
                            ++ totalDeleted;
                            ++ totalDeleted2;
                            debug("Deleted block: " + parseInt(block));
                            txn.del(global.database.shareDB, parseInt(block));
			    if (totalDeleted2 > 100) {
			        commitTxn(txn);
			        txn = global.database.env.beginTxn();
                                totalDeleted2 = 0;
			    }
                        });
                        commitTxn(txn);
                        txn = null;
                    } finally {
                        abortTxn(txn);
                    }
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
        }

        function scanShares(lastBlock, difficulty) {
            let shareCount = 0;
            let pplnsFound = false;
            let blockSet = {};
            logShareCleanup("scanning from " + lastBlock + " for more than " + difficulty + " shares");
            withReadTxn(function(txn) {
                withReadCursor(txn, self.shareDB, function(cursor) {
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
                });
            });
            logShareCleanup("scan finished");
            finalizeCleanup(Array.from(Object.keys(blockSet)));
        }

        function loadCleanupWindow(oldestLockedBlockDifficulty) {
            global.coinFuncs.getLastBlockHeader(function(err, body){
                if (err !== null) {
                    console.error("Last block header request failed!");
                    return abortCleanup();
                }
                if (oldestLockedBlockHeight === null){
                    logShareCleanup("no locked blocks found. scanning from current height " + body.height);
                    return scanShares(body.height, Math.floor(body.difficulty * global.config.pplns.shareMulti * 2));
                }
                logShareCleanup("block depth to keep is " + (body.height - oldestLockedBlockHeight));
                if (body.height - oldestLockedBlockHeight > global.config.general.blockCleanWarning) {
                    const values = { blocks: body.height - oldestLockedBlockHeight };
                    global.support.sendEmail(
                        global.config.general.adminEmail,
                        renderEmailTemplate("longRunnerCleanSubject", values, "long_runner module can not clean DB good enough"),
                        renderEmailTemplate("longRunnerCleanBody", values, "long_runner can not clean %(blocks)s block from DB!")
                    );
                }
                return scanShares(oldestLockedBlockHeight, Math.floor(oldestLockedBlockDifficulty * global.config.pplns.shareMulti * 2));
            }, true);
        }

        if (oldestLockedBlockHeight === null) return loadCleanupWindow(null);

        let attempt = 0;
        (function requestBlockHeader() {
            ++attempt;
            global.coinFuncs.getBlockHeaderByID(oldestLockedBlockHeight, function(err, result) {
                if (err === null && result && typeof result.difficulty !== "undefined") {
                    return loadCleanupWindow(result.difficulty);
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
                if (attempt >= CLEAN_SHARE_BLOCK_HEADER_RETRIES) return abortCleanup();
                setTimeout(requestBlockHeader, CLEAN_SHARE_BLOCK_HEADER_RETRY_DELAY_MS);
            }, true);
        }());
    };
}

module.exports = Database;
