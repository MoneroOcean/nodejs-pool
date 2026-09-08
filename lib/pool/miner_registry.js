"use strict";
const { getMinerSessionActivity, getPoolSecurityConfig } = require("./security.js");

/** @typedef {import("./security").MinerActivity & {id: string, payout: string, fixed_diff: boolean, difficulty: number, logString: string, port: number, connectTime: number, hasSubmittedValidShare?: boolean, removed_miner?: boolean, proxyMinerName?: string, trust_key?: string, trust?: {trust: number}, calcNewDiff: () => number, setNewDiff: (difficulty: number) => boolean, sendSameCoinJob: () => void}} RegistryMiner */
/** @typedef {import("node:net").Socket & {miner_id?: string, firstShareTimer?: NodeJS.Timeout | null, authTimer?: NodeJS.Timeout | null, destroyReason?: string, __poolClosedByRegistry?: boolean, finalizing?: boolean}} MinerSocket */
/** @typedef {{connectTime: number, count: number, hashes: number, submissionBudget: boolean}} ProxyState */
/** @typedef {{threadName: string | undefined, activeMiners: Map<string, RegistryMiner>, activeMinersByPayout: Map<string, Set<string>>, activeMinerSockets: Map<string, MinerSocket>, minerCount: Record<number, number>, proxyMiners: Record<string, ProxyState>, bannedBigTmpWallets: Record<string, number>, minerWallets: Record<string, {count: number}>}} RegistryState */
/** @param {{cluster: Pick<import("node:cluster").Cluster, "workers">, debug: (message: string) => void, state: RegistryState, processSend: (data: import("node:child_process").Serializable) => void, formatPoolEvent?: (label: string, fields?: Record<string, unknown>) => string}} deps */
module.exports = function createMinerRegistry(deps) {
    const {
        cluster,
        debug,
        state,
        processSend,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;

    /** @param {import("node:child_process").Serializable} data */
    function sendToWorkers(data) {
        for (const worker of Object.values(cluster.workers || {})) worker?.send(data);
    }

    function registerPool() {
        global.mysql.query("INSERT INTO pools (id, ip, last_checkin, active, hostname) VALUES (?, ?, now(), ?, ?) ON DUPLICATE KEY UPDATE last_checkin=now(), active=?",
            [global.config.pool_id, global.config.bind_ip, true, global.config.hostname, true]);
        global.mysql.query("DELETE FROM ports WHERE pool_id = ?", [global.config.pool_id]).then(function refillPorts() {
            global.config.ports.forEach(function insertPort(port) {
                global.mysql.query("INSERT INTO ports (pool_id, network_port, starting_diff, port_type, description, hidden, ip_address, ssl_port) values (?, ?, ?, ?, ?, ?, ?, ?)",
                    [global.config.pool_id, port.port, port.difficulty, port.portType, port.desc, port.hidden, global.config.bind_ip, port.ssl === true ? 1 : 0]);
            });
        });
    }

    /** @param {RegistryMiner} miner */
    function adjustMinerDiff(miner) {
        if (miner.fixed_diff) {
            const newDiff = miner.calcNewDiff();
            // Force a fixed-diff miner back to dynamic only when its real hashrate calls for >10x its fixed diff.
            if (miner.difficulty * 10 < newDiff) {
                console.log(state.threadName + formatPoolEvent("Diff mode switch", {
                    miner: miner.logString,
                    prevDiff: miner.difficulty,
                    nextDiff: newDiff,
                    mode: "dynamic"
                }));
                miner.fixed_diff = false;
                if (miner.setNewDiff(newDiff)) return true;
            }
        } else if (miner.setNewDiff(miner.calcNewDiff())) {
            return true;
        }
        return false;
    }

    /** @param {RegistryMiner} miner @param {MinerSocket} socket */
    function addActiveMiner(miner, socket) {
        state.activeMiners.set(miner.id, miner);
        state.activeMinerSockets.set(miner.id, socket);

        let payoutMiners = state.activeMinersByPayout.get(miner.payout);
        if (!payoutMiners) {
            payoutMiners = new Set();
            state.activeMinersByPayout.set(miner.payout, payoutMiners);
        }
        payoutMiners.add(miner.id);
    }

    /** @param {RegistryMiner} miner */
    function getMinerTrustKey(miner) {
        return miner.trust_key || miner.payout;
    }

    /** @param {string} payout @param {string} [trustKey] */
    function clearWalletSessionTrust(payout, trustKey) {
        const payoutMiners = state.activeMinersByPayout.get(payout);
        if (!payoutMiners) return 0;
        const targetTrustKey = trustKey || payout;

        let cleared = 0;
        for (const minerId of payoutMiners) {
            const miner = state.activeMiners.get(minerId);
            if (!miner || getMinerTrustKey(miner) !== targetTrustKey || !miner.trust || miner.trust.trust === 0) continue;
            miner.trust.trust = 0;
            cleared += 1;
        }
        return cleared;
    }

    function retargetMiners() {
        debug(state.threadName + formatPoolEvent("Retarget scan", { miners: state.activeMiners.size }));
        for (const port of Object.keys(state.minerCount)) delete state.minerCount[Number(port)];
        global.config.ports.forEach(function resetPortCount(portData) {
            state.minerCount[portData.port] = 0;
        });

        const timeBefore = Date.now();
        for (const miner of state.activeMiners.values()) {
            if (adjustMinerDiff(miner)) miner.sendSameCoinJob();
            state.minerCount[miner.port] = (state.minerCount[miner.port] || 0) + 1;
        }
        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(state.threadName + formatPoolEvent("Retarget slow", {
            elapsedMs: elapsed,
            miners: state.activeMiners.size
        }));
        processSend({ type: "minerPortCount", data: { worker_id: process.env["WORKER_ID"], ports: state.minerCount } });
    }

    /** @param {RegistryMiner} miner */
    function addProxyMiner(miner) {
        if (miner.proxyMinerName && miner.proxyMinerName in state.proxyMiners) return true;
        const wallet = miner.payout;
        const proxyMinerName = wallet;
        const proxyWorkerMax = global.config.pool.proxyWorkerMax || global.config.pool.workerMax;
        miner.proxyMinerName = proxyMinerName;

        const proxyState = state.proxyMiners[proxyMinerName];
        if (!proxyState) {
            state.proxyMiners[proxyMinerName] = { connectTime: Date.now(), count: 1, hashes: 0, submissionBudget: false };
            console.log(state.threadName + formatPoolEvent("Proxy track", { payout: proxyMinerName }));
        } else if (proxyState.count >= proxyWorkerMax) {
            console.error(state.threadName + formatPoolEvent("Wallet long ban", {
                payout: wallet,
                reason: "worker-limit"
            }));
            state.bannedBigTmpWallets[wallet] = 1;
            const payoutMiners = state.activeMinersByPayout.get(wallet);
            if (payoutMiners) {
                for (const minerId of Array.from(payoutMiners)) {
                    removeMiner(state.activeMiners.get(minerId));
                }
            }
            return false;
        } else {
            ++proxyState.count;
        }
        return true;
    }

    /** @param {RegistryMiner} miner @param {string} [reason] */
    function destroyMinerSocket(miner, reason) {
        const socket = miner && miner.id ? state.activeMinerSockets.get(miner.id) : null;
        if (!socket) return;
        state.activeMinerSockets.delete(miner.id);
        if (socket.miner_id === miner.id) delete socket.miner_id;
        if (socket.firstShareTimer) {
            clearTimeout(socket.firstShareTimer);
            socket.firstShareTimer = null;
        }
        if (socket.authTimer) {
            clearTimeout(socket.authTimer);
            socket.authTimer = null;
        }
        if (reason) socket.destroyReason = reason;
        if (!socket.__poolClosedByRegistry && typeof socket.end === "function" && socket.writable) {
            socket.__poolClosedByRegistry = true;
            socket.finalizing = true;
            socket.end();
            return;
        }
        if (typeof socket.destroy === "function" && !socket.destroyed && !socket.__poolClosedByRegistry) {
            socket.__poolClosedByRegistry = true;
            socket.destroy();
        }
    }

    /** @param {RegistryMiner | null | undefined} miner @param {{destroySocket?: boolean, reason?: string}} [options] */
    function removeMiner(miner, options) {
        if (!miner || miner.removed_miner) return;
        const opts = options || {};
        const proxyMinerName = miner.proxyMinerName;
        const proxyState = proxyMinerName ? state.proxyMiners[proxyMinerName] : null;
        if (proxyState && --proxyState.count <= 0 && proxyMinerName) delete state.proxyMiners[proxyMinerName];
        const walletState = state.minerWallets[miner.payout];
        if (walletState && --walletState.count <= 0) delete state.minerWallets[miner.payout];
        const payoutMiners = state.activeMinersByPayout.get(miner.payout);
        if (payoutMiners) {
            payoutMiners.delete(miner.id);
            if (payoutMiners.size === 0) state.activeMinersByPayout.delete(miner.payout);
        }
        state.activeMiners.delete(miner.id);
        miner.removed_miner = true;
        if (opts.destroySocket !== false) destroyMinerSocket(miner, opts.reason);
        else state.activeMinerSockets.delete(miner.id);
    }

    function checkAliveMiners() {
        debug(state.threadName + formatPoolEvent("Alive scan", { miners: state.activeMiners.size }));
        const timeBefore = Date.now();
        const config = getPoolSecurityConfig();
        const deadline = timeBefore - global.config.pool.minerTimeout * 1000;
        for (const miner of state.activeMiners.values()) {
            const firstShareDeadline = miner.connectTime + config.minerFirstShareTimeoutMs;
            if (!miner.hasSubmittedValidShare && timeBefore >= firstShareDeadline) {
                removeMiner(miner, { reason: "first-share-timeout" });
                continue;
            }
            if (getMinerSessionActivity(miner) < deadline) removeMiner(miner, { reason: "miner-timeout" });
        }
        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(state.threadName + formatPoolEvent("Alive check slow", {
            elapsedMs: elapsed,
            miners: state.activeMiners.size
        }));
    }

    return {
        sendToWorkers,
        registerPool,
        adjustMinerDiff,
        addActiveMiner,
        retargetMiners,
        addProxyMiner,
        clearWalletSessionTrust,
        removeMiner,
        checkAliveMiners
    };
};
