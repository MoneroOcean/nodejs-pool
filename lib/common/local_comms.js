"use strict";
const debug = require('debug')('db');
let cleanShareInProgress = false;
let cleanShareStuckCount = 0;
const CLEAN_SHARE_BLOCK_HEADER_RETRIES = 3;
const CLEAN_SHARE_BLOCK_HEADER_RETRY_DELAY_MS = 1000;
const poolTypeStr = require("./pool_type.js");

/** @typedef {import("../../types/runtime").LmdbApi} LmdbApi */
/** @typedef {import("../../types/runtime").LmdbEnv} LmdbEnv */
/** @typedef {import("../../types/runtime").LmdbTxn} LmdbTxn */
/** @typedef {import("../../types/runtime").LmdbCursor} LmdbCursor */
/** @typedef {import("../../types/runtime").LmdbDbi} LmdbDbi */
/** @typedef {import("../../types/runtime").BlockMessage} BlockMessage */
/** @typedef {import("../../types/runtime").BlockRecord} BlockRecord */
/** @typedef {import("../../types/runtime").BlockListEntry} BlockListEntry */
/** @typedef {import("../../types/runtime").AltBlockMessage} AltBlockMessage */
/** @typedef {import("../../types/runtime").AltBlockRecord} AltBlockRecord */
/** @typedef {import("../../types/runtime").AltBlockListEntry} AltBlockListEntry */
/** @typedef {import("../../types/runtime").ShareMessage} ShareMessage */
/** @typedef {import("../../types/runtime").InvalidShareMessage} InvalidShareMessage */
/** @typedef {import("../../types/runtime").BlockHeader} BlockHeader */
/** @typedef {import("../../types/runtime").ExpressResponse} ExpressResponse */
/** @typedef {{location: string, value: number | false}} CacheIncrement */
/** @typedef {{message?: string, code?: unknown, errno?: unknown, syscall?: string, constructor?: {name?: string}}} ErrorLike */
/** @template T @typedef {(txn: LmdbTxn) => T} ReadTxnRunner */
/** @template T @typedef {(txn: LmdbTxn, commit: () => void) => T} WriteTxnRunner */
/** @template T @typedef {(cursor: LmdbCursor) => T} CursorRunner */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} item @param {Record<string, unknown>} values @param {string} fallback @returns {string} */
function renderEmailTemplate(item, values, fallback) {
    if (global.support && typeof global.support.renderEmailTemplate === "function") return global.support.renderEmailTemplate(item, values, fallback);
    const template = global.config && global.config.email && typeof global.config.email[item] === "string" ? global.config.email[item] : fallback;
    return global.support && typeof global.support.formatTemplate === "function"
        ? global.support.formatTemplate(template || "", values || {})
        : String(template || "").replace(/%\(([^)]+)\)s/g, function replaceValue(_match, key) {
            return values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
        });
}

/** @param {unknown} errorLike @returns {errorLike is ErrorLike | Error} */
function isErrorLike(errorLike) {
    if (!errorLike || typeof errorLike !== "object") return false;
    if (errorLike instanceof Error) return true;
    return isRecord(errorLike) && (typeof errorLike["message"] === "string" || typeof errorLike["code"] !== "undefined");
}

/** @param {unknown} errorLike @returns {string | null} */
function formatErrorLike(errorLike) {
    if (!isErrorLike(errorLike)) return null;
    if (errorLike instanceof Error) {
        return errorLike.message || errorLike.name || "error";
    }
    if (!isRecord(errorLike)) return null;
    const parts = [];
    if (typeof errorLike.code !== "undefined") parts.push(String(errorLike.code));
    if (typeof errorLike.errno !== "undefined") parts.push(`errno=${  String(errorLike.errno)}`);
    if (typeof errorLike.syscall === "string") parts.push(`syscall=${  errorLike.syscall}`);
    if (typeof errorLike.message === "string" && errorLike.message.length > 0) parts.push(errorLike.message);
    if (parts.length !== 0) return parts.join(" ");

    return errorLike.constructor && errorLike.constructor.name ? errorLike.constructor.name : "error";
}

/** @param {unknown} value @returns {string | null} */
function stringifyFallback(value) {
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return null;
    }
}

/** @param {unknown} value @returns {string | null} */
function formatRpcFailureValue(value) {
    const formatted = formatErrorLike(value);
    if (formatted) return formatted;
    if (typeof value === "string") return value;
    return stringifyFallback(value);
}

/** @param {unknown} body @returns {string} */
function formatBodyRpcFailure(body) {
    if (typeof body === "undefined") return "unknown error";
    const formattedBody = formatErrorLike(body);
    if (formattedBody) return formattedBody;
    if (typeof body === "string") return body;
    return formatBodyObjectFailure(body);
}

/** @param {unknown} body @returns {string} */
function formatBodyObjectFailure(body) {
    const isEmptyObjectResponse = body && typeof body === "object" && !Array.isArray(body) &&
        Object.keys(body).length === 0;
    if (isEmptyObjectResponse) return "empty daemon response";
    const stringifiedBody = stringifyFallback(body);
    return stringifiedBody === null ? "unknown error" : stringifiedBody;
}

/** @param {unknown} err @param {unknown} body @returns {string} */
function formatErrRpcFailure(err, body) {
    const formattedErr = formatRpcFailureValue(err);
    return formattedErr === null ? formatBodyRpcFailure(body) : formattedErr;
}

/** @param {unknown} err @param {unknown} body @returns {string} */
function formatCleanShareRpcFailure(err, body) {
    if (isErrorLike(err) && typeof err.message === "string" && err.message) return err.message;
    if (typeof err !== "undefined" && err !== null && err !== true) return formatErrRpcFailure(err, body);
    return formatBodyRpcFailure(body);
}

/** @param {string} message @returns {void} */
function logShareCleanup(message) {
    console.log(`Share DB cleanup: ${  message}`);
}

/**
 * LMDB-backed local communication store.  The environment and DBIs are
 * opened by initEnv, so the constructor keeps them nullable until startup.
 * @constructor
 */
function Database(){
    const self = this;
    /** @type {"local"} */
    this.role = "local";
    /** @type {LmdbApi} */
    this.lmdb = require('node-lmdb');
    /** @type {LmdbEnv | null} */
    this.env = null;
    /** @type {LmdbDbi | null} */
    this.shareDB = null;
    /** @type {LmdbDbi | null} */
    this.blockDB = null;
    /** @type {LmdbDbi | null} */
    this.altblockDB = null;
    /** @type {LmdbDbi | null} */
    this.cacheDB = null;

    /** @returns {LmdbEnv} */
    function requireEnv() {
        if (!self.env) throw new Error("LMDB environment is not initialized");
        return self.env;
    }

    /** @param {LmdbDbi | null} db @param {string} name @returns {LmdbDbi} */
    function requireDbi(db, name) {
        if (!db) throw new Error(`${name} database is not initialized`);
        return db;
    }

    /** @returns {void} */
    this.initEnv = function(){
        self.env = new self.lmdb.Env();
        self.env.open({
            path: global.config.db_storage_path,
            maxDbs: 10,
            mapSize: Number(global.config.general["dbSizeGB"]) * 1024 * 1024 * 1024,
            useWritemap: true,
            maxReaders: 512
        });
        self.shareDB = self.env.openDbi({
            name: 'shares',
            create: true,
            dupSort: true,
            dupFixed: false,
            integerDup: true,
            keyIsUint32: true
        });
        self.blockDB = self.env.openDbi({
            name: 'blocks',
            create: true,
            keyIsUint32: true
        });
        self.altblockDB = self.env.openDbi({
            name: 'altblocks',
            create: true,
            keyIsUint32: true
        });
        self.cacheDB = self.env.openDbi({
            name: 'cache',
            create: true
        });
    };

    /** @param {LmdbTxn | null | undefined} txn @returns {void} */
    function abortTxn(txn) {
        if (!txn) return;
        try {
            txn.abort();
        } catch (_error) { /* best-effort txn abort; ignore if already aborted/closed */ }
    }

    /** @param {LmdbTxn | null | undefined} txn @returns {void} */
    function commitTxn(txn) {
        if (!txn) return;
        txn.commit();
    }

    /** @param {LmdbCursor | null | undefined} cursor @returns {void} */
    function closeCursor(cursor) {
        if (!cursor) return;
        try {
            cursor.close();
        } catch (_error) { /* best-effort cursor close; ignore if already closed */ }
    }

    /** @template T @param {ReadTxnRunner<T>} run @returns {T} */
    function withReadTxn(run) {
        const txn = requireEnv().beginTxn({readOnly: true});
        try {
            return run(txn);
        } finally {
            abortTxn(txn);
        }
    }

    /** @template T @param {WriteTxnRunner<T>} run @returns {T} */
    function withWriteTxn(run) {
        const txn = requireEnv().beginTxn();
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

    /** @template T @param {LmdbTxn} txn @param {LmdbDbi | null} db @param {CursorRunner<T>} run @returns {T} */
    function withCursor(txn, db, run) {
        /** @type {LmdbCursor} */
        const cursor = new self.lmdb.Cursor(txn, requireDbi(db, "cursor"));
        try {
            return run(cursor);
        } finally {
            closeCursor(cursor);
        }
    }

    /** @template T @param {LmdbTxn} txn @param {LmdbDbi | null} db @param {CursorRunner<T>} run @returns {T} */
    function withReadCursor(txn, db, run) {
        return withCursor(txn, db, run);
    }

    /** @param {string} key @param {CacheIncrement[]} data @returns {void} */
    this.incrementCacheData = function(key, data){
        withWriteTxn(function(txn){
            const cached = txn.getString(requireDbi(self.cacheDB, "cache"), key);
            if (cached === null) return;
            const parsed = JSON.parse(cached);
            if (!isRecord(parsed)) return;
            const cacheValues = parsed;
            data.forEach(function(intDict){
                if (!Object.hasOwn(cacheValues, intDict.location) || intDict.value === false){
                    cacheValues[intDict.location] = 0;
                } else {
                    const current = cacheValues[intDict.location];
                    cacheValues[intDict.location] = (typeof current === "number" ? current : 0) + intDict.value;
                }
            });
            txn.putString(requireDbi(self.cacheDB, "cache"), key, JSON.stringify(cacheValues));
        });
    };

    /** @param {string | null | undefined} pool_type @param {number | undefined} first @param {number | undefined} last @returns {BlockListEntry[]} */
    this.getBlockList = function(pool_type, first, last) {
        debug("Getting block list");
        const poolTypeFilter = pool_type === 'pplns' ? global.protos.POOLTYPE.PPLNS : false;
        /** @type {BlockListEntry[]} */
        const response = [];
        try{
            return withReadTxn(function(txn) {
                return withReadCursor(txn, self.blockDB, function(cursor) {
                    for (let found = cursor.goToLast(), i = 0; found; found = cursor.goToPrev()) {
                        if (typeof last !== 'undefined' && i >= last) break;
                        cursor.getCurrentBinary(function (_key, data) {  // jshint ignore:line
                            const blockData = global.protos.Block.decode(data);
                            const poolType = poolTypeStr(blockData.poolType);
                            if (poolTypeFilter === false || blockData.poolType === poolTypeFilter) {
                                if (typeof first !== 'undefined' && i++ < first) return;
                                response.push({
                                    ts: blockData.timestamp,
                                    hash: blockData.hash,
                                    diff: blockData.difficulty,
                                    shares: blockData.shares,
                                    height: Number(_key),
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
        } catch (_e){
            return response;
        }
    };

    /** @param {string | null | undefined} pool_type @param {number | undefined} coin_port @param {number | undefined} first @param {number | undefined} last @returns {AltBlockListEntry[]} */
    this.getAltBlockList = function(pool_type, coin_port, first, last) {
        debug("Getting altblock list");
        const poolTypeFilter = pool_type === 'pplns' ? global.protos.POOLTYPE.PPLNS : false;
        /** @type {AltBlockListEntry[]} */
        const response = [];
        try{
            return withReadTxn(function(txn) {
                return withReadCursor(txn, self.altblockDB, function(cursor) {
                    for (let found = cursor.goToLast(), i = 0; found; found = cursor.goToPrev()) {
                        if (typeof last !== 'undefined' && i >= last) break;
                        cursor.getCurrentBinary(function (_key, data) {  // jshint ignore:line
                            const blockData = global.protos.AltBlock.decode(data);
                            const poolType = poolTypeStr(blockData.poolType);
                            if ((poolTypeFilter === false || blockData.poolType === poolTypeFilter) && (!coin_port || blockData.port === coin_port)) {
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
        } catch (_e){
            return response;
        }
    };

    /** @param {Buffer} shareData @param {(stored: boolean) => void} callback @returns {void} */
    this.storeInvalidShare = function(shareData, callback){
        try {
            const share = global.protos.InvalidShare.decode(shareData);
            let minerID = share.paymentAddress;
            if (typeof(share.paymentID) !== 'undefined' && share.paymentID.length > 10) {
                minerID = `${minerID  }.${  share.paymentID}`;
            }
            const minerIDWithIdentifier = `${minerID  }_${  share.identifier}`;
            this.incrementCacheData(minerIDWithIdentifier, [{location: 'badShares', value: share.count ? share.count : 1}]);
            this.incrementCacheData(minerID, [{location: 'badShares', value: share.count ? share.count : 1}]);
            callback(true);
        } catch (_e){
            console.error("Ran into an error storing an invalid share.  Damn!");
            callback(false);
        }
    };

    /** @param {number | string} blockId @returns {void} */
    this.invalidateBlock = function(blockId){
        withWriteTxn(function(txn){
            const blockData = global.protos.Block.decode(txn.getBinary(requireDbi(self.blockDB, "blocks"), blockId));
            blockData.valid = false;
            blockData.unlocked = true;
            txn.putBinary(requireDbi(self.blockDB, "blocks"), blockId, global.protos.Block.encode(blockData));
        });
    };

    /** @param {number | string} blockId @returns {void} */
    this.invalidateAltBlock = function(blockId){
        withWriteTxn(function(txn){
            const blockData = global.protos.AltBlock.decode(txn.getBinary(requireDbi(self.altblockDB, "altblocks"), blockId));
            blockData.valid = false;
            blockData.unlocked = true;
            txn.putBinary(requireDbi(self.altblockDB, "altblocks"), blockId, global.protos.AltBlock.encode(blockData));
        });
    };

    /** @param {number | string} blockId @param {string} pay_stage @param {string} pay_status @returns {void} */
    this.changeAltBlockPayStageStatus = function(blockId, pay_stage, pay_status){
        withWriteTxn(function(txn){
            const blockData = global.protos.AltBlock.decode(txn.getBinary(requireDbi(self.altblockDB, "altblocks"), blockId));
            blockData.pay_stage  = pay_stage;
            blockData.pay_status = pay_status;
            txn.putBinary(requireDbi(self.altblockDB, "altblocks"), blockId, global.protos.AltBlock.encode(blockData));
        });
    };

    /** @param {number | string} srcBlockId @param {number | string} dstBlockId @param {number} srcAmount @returns {void} */
    this.moveAltBlockReward = function(srcBlockId, dstBlockId, srcAmount){
        withWriteTxn(function(txn){
            const altblockDB = requireDbi(self.altblockDB, "altblocks");
            const srcBlockData = global.protos.AltBlock.decode(txn.getBinary(altblockDB, srcBlockId));
            const dstBlockData = global.protos.AltBlock.decode(txn.getBinary(altblockDB, dstBlockId));
            dstBlockData.value = (dstBlockData.value || 0) + srcAmount;
            srcBlockData.value = 0;
            srcBlockData.pay_stage  = "Paid by other block";
            srcBlockData.pay_status = `Will be paid by block ${  dstBlockData.hash  } on ${  dstBlockData.height  } height`;
            srcBlockData.unlocked   = true;
            txn.putBinary(altblockDB, srcBlockId, global.protos.AltBlock.encode(srcBlockData));
            txn.putBinary(altblockDB, dstBlockId, global.protos.AltBlock.encode(dstBlockData));
        });
    };

    /** @param {number | string} blockId @param {number} pay_value @returns {void} */
    this.changeAltBlockPayValue = function(blockId, pay_value){
        withWriteTxn(function(txn){
            const blockData = global.protos.AltBlock.decode(txn.getBinary(requireDbi(self.altblockDB, "altblocks"), blockId));
            blockData.pay_value  = pay_value;
            txn.putBinary(requireDbi(self.altblockDB, "altblocks"), blockId, global.protos.AltBlock.encode(blockData));
        });
    };

    /** @returns {BlockRecord[]} */
    this.getValidLockedBlocks = function(){
        /** @type {BlockRecord[]} */
        const blockList = [];
        return withReadTxn(function(txn) {
            return withReadCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        const blockData = global.protos.Block.decode(data);
                        if (blockData.valid === true && blockData.unlocked === false){
                            blockList.push(Object.assign({}, blockData, { height: Number(key) }));
                        }
                    });
                }
                return blockList;
            });
        });
    };

    /** @returns {AltBlockRecord[]} */
    this.getValidLockedAltBlocks = function(){
        /** @type {AltBlockRecord[]} */
        const blockList = [];
        return withReadTxn(function(txn) {
            return withReadCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        const blockData = global.protos.AltBlock.decode(data);
                        if (blockData.valid === true && blockData.unlocked === false){
                            blockList.push(Object.assign({}, blockData, { id: Number(key) }));
                        }
                    });
                }
                return blockList;
            });
        });
    };

    /** @param {string} blockHex @returns {void} */
    this.unlockBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        const blockData = global.protos.Block.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.unlocked = true;
                            txn.putBinary(requireDbi(self.blockDB, "blocks"), key, global.protos.Block.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    /** @param {string} blockHex @returns {void} */
    this.unlockAltBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        const blockData = global.protos.AltBlock.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.unlocked = true;
                            txn.putBinary(requireDbi(self.altblockDB, "altblocks"), key, global.protos.AltBlock.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    /** @param {string} blockHex @returns {void} */
    this.payReadyBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.blockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        const blockData = global.protos.Block.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.pay_ready = true;
                            txn.putBinary(requireDbi(self.blockDB, "blocks"), key, global.protos.Block.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    /** @param {string} blockHex @returns {void} */
    this.payReadyAltBlock = function(blockHex){
        withWriteTxn(function(txn){
            withCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                    cursor.getCurrentBinary(function(key, data){  // jshint ignore:line
                        const blockData = global.protos.AltBlock.decode(data);
                        if (blockData.hash === blockHex){
                            blockData.pay_ready = true;
                            txn.putBinary(requireDbi(self.altblockDB, "altblocks"), key, global.protos.AltBlock.encode(blockData));
                        }
                    });
                }
            });
        });
    };

    /** @param {string} cacheKey @returns {unknown} */
    this.getCache = function(cacheKey){
        debug(`Getting Key: ${cacheKey}`);
        try {
            return withReadTxn(function(txn) {
                const cached = txn.getString(requireDbi(self.cacheDB, "cache"), cacheKey);
                if (cached !== null){
                    debug(`Result for Key: ${  cacheKey  } is: ${  cached}`);
                    return JSON.parse(cached);
                }
                return false;
            });
        } catch (_e) {
            return false;
        }
    };

    /** @param {string} cacheKey @param {unknown} cacheData @returns {void} */
    this.setCache = function(cacheKey, cacheData){
        debug(`Setting Key: ${cacheKey } Data: ${  JSON.stringify(cacheData)}`);
        withWriteTxn(function(txn){
            txn.putString(requireDbi(self.cacheDB, "cache"), cacheKey, JSON.stringify(cacheData));
        });
    };

    /** @param {Record<string, unknown>} cacheUpdates @returns {void} */
    this.bulkSetCache = function(cacheUpdates){
        withWriteTxn(function(txn){
            for (const [key, value] of Object.entries(cacheUpdates)) {
                txn.putString(requireDbi(self.cacheDB, "cache"), key, JSON.stringify(value));
            }
        });
    };

    /** @returns {number | null} */
    this.getOldestLockedBlockHeight = function(){
        /*
        6-29-2017 - Snipa -
        This function returns a decompressed block proto for the first locked block in the system as part of the
        share depth functions.  DO NOT BLINDLY REPLACE getLastBlock WITH THIS FUNCTION.
        */
        debug("Getting the oldest locked block in the system");

        /** @type {number | null} */
        let oldestLockedBlockHeight = null;

        withReadTxn(function(txn) {
            withReadCursor(txn, self.altblockDB, function(cursor) {
                for (let found = cursor.goToFirst(); found; found = cursor.goToNext()) {
                     cursor.getCurrentBinary(function(_key, data){  // jshint ignore:line
                         const blockData = global.protos.AltBlock.decode(data);
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
                         const blockHeight = Number(key);
                         if (oldestLockedBlockHeight !== null && oldestLockedBlockHeight <= blockHeight) return;
                         const blockData = global.protos.Block.decode(data);
                         if (blockData.unlocked === false && blockData.pay_ready !== true) {
                             oldestLockedBlockHeight = blockHeight;
                         }
                     });
                }
            });
        });

        if (oldestLockedBlockHeight !== null) {
            console.log(`Got the oldest locked block in the system at height: ${  String(oldestLockedBlockHeight)}`);
        } else {
            console.log("There are no locked blocks in the system. Woohoo!");
        }
        return oldestLockedBlockHeight;
    };

    /** @param {(error?: Error | null) => void} done @returns {void} */
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
            return;
        }
        cleanShareInProgress = true;
        /** @type {number | null} */
        let oldestLockedBlockHeight = null;
        try {
            oldestLockedBlockHeight = this.getOldestLockedBlockHeight();
        } catch (error) {
            // Any failure after the flag is set must clear it, or every later cleanup
            // cycle refuses to run ("already running") until the process restarts.
            return failCleanup(error);
        }
        const abortMessage = "Share DB cleanup aborted because the main daemon block-header lookup failed";

        /** @param {unknown} error @returns {void} */
        function failCleanup(error) {
            cleanShareInProgress = false;
            finish(error instanceof Error ? error : new Error(String(error)));
        }

        function abortCleanup() {
            console.error(abortMessage);
            cleanShareInProgress = false;
            finish(new Error(abortMessage));
        }

        /** @param {string[]} data @returns {void} */
        function finalizeCleanup(data) {
            if (global.config.general["blockCleaner"] === true){
                if(data.length > 0){
                    let totalDeleted = 0;
                    let batchCount = 0;
                    logShareCleanup(`block cleaning started: removing ${  data.length  } block share records`);
                    /** @type {LmdbTxn | null} */
                    let txn = null;
                    try {
                        txn = requireEnv().beginTxn();
                        data.forEach(function(block){
                            if (!txn) throw new Error("LMDB cleanup transaction is not active");
                            ++ totalDeleted;
                            ++ batchCount;
                            debug(`Deleted block: ${  parseInt(block)}`);
                            txn.del(requireDbi(self.shareDB, "shares"), parseInt(block, 10));
                            // Commit in batches of 100 to cap the write-txn / dirty-page footprint.
                            if (batchCount > 100) {
                                commitTxn(txn);
                                txn = requireEnv().beginTxn();
                                batchCount = 0;
                            }
                        });
                        commitTxn(txn);
                        txn = null;
                    } finally {
                        abortTxn(txn);
                    }
                    logShareCleanup(`block cleaning finished: removed ${  totalDeleted  } block share records`);
                }
                const env = requireEnv();
                if (typeof env.sync === "function") env.sync(function(){});
            } else {
                logShareCleanup(`block cleaning disabled. would have removed: ${  JSON.stringify(data)}`);
            }
            cleanShareInProgress = false;
            cleanShareStuckCount = 0;
            logShareCleanup("finished");
            finish(null);
        }

        /** @param {number} lastBlock @param {number} difficulty @returns {void} */
        function scanShares(lastBlock, difficulty) {
            let shareCount = 0;
            let pplnsFound = false;
            /** @type {Record<string, number>} */
            const blockSet = {};
            logShareCleanup(`scanning from ${  lastBlock  } for more than ${  difficulty  } shares`);
            withReadTxn(function(txn) {
                withReadCursor(txn, self.shareDB, /** @param {LmdbCursor} cursor */ function(cursor) {
                    for (let blockID = lastBlock - 1; blockID > 0; --blockID) {
                        debug(`Scanning block: ${  blockID}`);
                        for (let found = cursor.goToRange(blockID); found !== null && Number(found) === blockID; found = cursor.goToNextDup()) {
                            if (pplnsFound) {
                                blockSet[blockID] = 1;
                                break;
                            } else {
                                cursor.getCurrentBinary(function(_key, data) {  // jshint ignore:line
                                    try{
                                        const shareData = global.protos.Share.decode(data);
                                        if (shareData.poolType === global.protos.POOLTYPE.PPLNS){
                                            shareCount += shareData.shares2 || 0;
                                        }
                                    } catch(_e){
                                        console.error("Invalid share");
                                    }
                                });
                                if (shareCount >= difficulty){
                                    pplnsFound = true;
                                    logShareCleanup(`found the first block to be deleted at ${  blockID  } height`);
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

        /** @param {number | null} oldestLockedBlockDifficulty @returns {void} */
        function loadCleanupWindow(oldestLockedBlockDifficulty) {
            global.coinFuncs.getLastBlockHeader(/** @param {unknown} err @param {BlockHeader | undefined} body */ function(err, body){
                if (err !== null || !body) {
                    console.error("Last block header request failed!");
                    return abortCleanup();
                }
                // scanShares (LMDB read) and finalizeCleanup (write txn) run here inside an
                // async callback; an uncaught throw would latch cleanShareInProgress forever.
                try {
                    const headerHeight = body.height;
                    const headerDifficulty = body.difficulty;
                    if (oldestLockedBlockHeight === null){
                        if (typeof headerDifficulty !== "number" || !Number.isFinite(headerDifficulty) || headerDifficulty <= 0) {
                            return failCleanup(new Error("Invalid current block difficulty"));
                        }
                        logShareCleanup(`no locked blocks found. scanning from current height ${  headerHeight}`);
                        return scanShares(headerHeight, Math.floor(headerDifficulty * Number(global.config.pplns["shareMulti"]) * 2));
                    }
                    const lockedHeight = oldestLockedBlockHeight;
                    const blockDepth = headerHeight - lockedHeight;
                    logShareCleanup(`block depth to keep is ${  blockDepth}`);
                    if (blockDepth > Number(global.config.general["blockCleanWarning"])) {
                        const values = {
                            blocks: blockDepth,
                            oldest_locked_height: lockedHeight,
                            current_height: headerHeight
                        };
                        global.support.sendEmail(
                            global.config.general.adminEmail,
                            renderEmailTemplate("longRunnerCleanSubject", values, "long_runner share history retention warning"),
                            renderEmailTemplate(
                                "longRunnerCleanBody",
                                values,
                                "long_runner is retaining share history spanning %(blocks)s block heights to protect pending payouts. " +
                                "Oldest locked height: %(oldest_locked_height)s; current height: %(current_height)s."
                            )
                        );
                    }
                    if (oldestLockedBlockDifficulty === null) return failCleanup(new Error("Missing locked block difficulty"));
                    return scanShares(lockedHeight, Math.floor(oldestLockedBlockDifficulty * Number(global.config.pplns["shareMulti"]) * 2));
                } catch (error) {
                    return failCleanup(error);
                }
            }, true);
        }

        if (oldestLockedBlockHeight === null) return loadCleanupWindow(null);

        let attempt = 0;
        (function requestBlockHeader() {
            ++attempt;
            global.coinFuncs.getBlockHeaderByID(oldestLockedBlockHeight, /** @param {unknown} err @param {BlockHeader | undefined} result */ function(err, result) {
                if (err === null && result && typeof result.difficulty !== "undefined") {
                    return loadCleanupWindow(result.difficulty);
                }

                const failure = formatCleanShareRpcFailure(err, result);
                console.error(
                    `Share DB cleanup: can't get main block with ${ 
                    oldestLockedBlockHeight 
                    } height on attempt ${ 
                    attempt 
                    }/${ 
                    CLEAN_SHARE_BLOCK_HEADER_RETRIES 
                    }: ${ 
                    failure}`
                );
                if (attempt >= CLEAN_SHARE_BLOCK_HEADER_RETRIES) return abortCleanup();
                setTimeout(requestBlockHeader, CLEAN_SHARE_BLOCK_HEADER_RETRY_DELAY_MS);
            }, true);
        }());
    };
}

module.exports = Database;
