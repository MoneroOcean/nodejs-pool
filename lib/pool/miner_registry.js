"use strict";

const { getMinerSessionActivity, getPoolSecurityConfig } = require("./security.js");

module.exports = function createMinerRegistry(deps) {
    const {
        cluster,
        debug,
        state,
        processSend,
        formatPoolEvent = function fallbackFormatPoolEvent(label) { return label; }
    } = deps;

    function sendToWorkers(data) {
        Object.keys(cluster.workers).forEach(function sendToWorker(key) {
            cluster.workers[key].send(data);
        });
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

    function adjustMinerDiff(miner) {
        if (miner.fixed_diff) {
            const newDiff = miner.calcNewDiff();
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

    function clearWalletSessionTrust(payout) {
        const payoutMiners = state.activeMinersByPayout.get(payout);
        if (!payoutMiners) return 0;

        let cleared = 0;
        for (const minerId of payoutMiners) {
            const miner = state.activeMiners.get(minerId);
            if (!miner || !miner.trust || miner.trust.trust === 0) continue;
            miner.trust.trust = 0;
            cleared += 1;
        }
        return cleared;
    }

    function retargetMiners() {
        debug(state.threadName + formatPoolEvent("Retarget scan", { miners: state.activeMiners.size }));
        global.config.ports.forEach(function resetPortCount(portData) {
            state.minerCount[portData.port] = 0;
        });

        const timeBefore = Date.now();
        for (const [_minerId, miner] of state.activeMiners) {
            if (adjustMinerDiff(miner)) miner.sendSameCoinJob();
            ++state.minerCount[miner.port];
        }
        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(state.threadName + formatPoolEvent("Retarget slow", {
            elapsedMs: elapsed,
            miners: state.activeMiners.size
        }));
        processSend({ type: "minerPortCount", data: { worker_id: process.env.WORKER_ID, ports: state.minerCount } });
    }

    function addProxyMiner(miner) {
        if (miner.proxyMinerName && miner.proxyMinerName in state.proxyMiners) return true;
        const wallet = miner.payout;
        const proxyMinerName = wallet;
        miner.proxyMinerName = proxyMinerName;

        if (!(proxyMinerName in state.proxyMiners)) {
            state.proxyMiners[proxyMinerName] = { connectTime: Date.now(), count: 1, hashes: 0 };
            console.log(state.threadName + formatPoolEvent("Proxy track", { payout: proxyMinerName }));
        } else if (++state.proxyMiners[proxyMinerName].count > global.config.pool.workerMax && !miner.xmrig_proxy) {
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
        }
        return true;
    }

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

    function removeMiner(miner, options) {
        if (!miner || miner.removed_miner) return;
        options = options || {};
        const proxyMinerName = miner.proxyMinerName;
        if (proxyMinerName && proxyMinerName in state.proxyMiners && --state.proxyMiners[proxyMinerName].count <= 0) delete state.proxyMiners[proxyMinerName];
        if (miner.payout in state.minerWallets && --state.minerWallets[miner.payout].count <= 0) delete state.minerWallets[miner.payout];
        const payoutMiners = state.activeMinersByPayout.get(miner.payout);
        if (payoutMiners) {
            payoutMiners.delete(miner.id);
            if (payoutMiners.size === 0) state.activeMinersByPayout.delete(miner.payout);
        }
        state.activeMiners.delete(miner.id);
        miner.removed_miner = true;
        if (options.destroySocket !== false) destroyMinerSocket(miner, options.reason);
        else state.activeMinerSockets.delete(miner.id);
    }

    function checkAliveMiners() {
        debug(state.threadName + formatPoolEvent("Alive scan", { miners: state.activeMiners.size }));
        const timeBefore = Date.now();
        const config = getPoolSecurityConfig();
        const deadline = timeBefore - global.config.pool.minerTimeout * 1000;
        for (const [_minerId, miner] of state.activeMiners) {
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
