"use strict";

module.exports = function createMinerRegistry(deps) {
    const { cluster, debug, state, processSend } = deps;

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
                console.log("Dropped low fixed diff " + miner.difficulty + " for " + miner.logString + " miner to " + newDiff + " dynamic diff");
                miner.fixed_diff = false;
                if (miner.setNewDiff(newDiff)) return true;
            }
        } else if (miner.setNewDiff(miner.calcNewDiff())) {
            return true;
        }
        return false;
    }

    function retargetMiners() {
        debug(state.threadName + "Performing difficulty check on miners");
        global.config.ports.forEach(function resetPortCount(portData) {
            state.minerCount[portData.port] = 0;
        });

        const timeBefore = Date.now();
        for (const [_minerId, miner] of state.activeMiners) {
            if (adjustMinerDiff(miner)) miner.sendSameCoinJob();
            ++state.minerCount[miner.port];
        }
        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(state.threadName + "retargetMiners() consumed " + elapsed + " ms for " + state.activeMiners.size + " miners");
        processSend({ type: "minerPortCount", data: { worker_id: process.env.WORKER_ID, ports: state.minerCount } });
    }

    function addProxyMiner(miner) {
        if (miner.proxyMinerName && miner.proxyMinerName in state.proxyMiners) return true;
        const wallet = miner.payout;
        const proxyMinerName = wallet;
        miner.proxyMinerName = proxyMinerName;

        if (!(proxyMinerName in state.proxyMiners)) {
            state.proxyMiners[proxyMinerName] = { connectTime: Date.now(), count: 1, hashes: 0 };
            console.log("Starting to calculate high diff for " + proxyMinerName + " proxy");
        } else if (++state.proxyMiners[proxyMinerName].count > global.config.pool.workerMax && !miner.xmrig_proxy) {
            console.error(state.threadName + "Starting to long ban  " + wallet + " miner address");
            state.bannedBigTmpWallets[wallet] = 1;
            for (const [_minerId, activeMiner] of state.activeMiners) {
                if (activeMiner.payout === wallet) removeMiner(activeMiner);
            }
            return false;
        }
        return true;
    }

    function removeMiner(miner) {
        if (!miner || miner.removed_miner) return;
        const proxyMinerName = miner.proxyMinerName;
        if (proxyMinerName && proxyMinerName in state.proxyMiners && --state.proxyMiners[proxyMinerName].count <= 0) delete state.proxyMiners[proxyMinerName];
        if (miner.payout in state.minerWallets && --state.minerWallets[miner.payout].count <= 0) delete state.minerWallets[miner.payout];
        state.activeMiners.delete(miner.id);
        miner.removed_miner = true;
    }

    function checkAliveMiners() {
        debug(state.threadName + "Verifying if miners are still alive");
        const timeBefore = Date.now();
        const deadline = timeBefore - global.config.pool.minerTimeout * 1000;
        for (const [_minerId, miner] of state.activeMiners) {
            if (miner.lastContact < deadline) removeMiner(miner);
        }
        const elapsed = Date.now() - timeBefore;
        if (elapsed > 50) console.error(state.threadName + "checkAliveMiners() consumed " + elapsed + " ms for " + state.activeMiners.size + " miners");
    }

    return {
        sendToWorkers,
        registerPool,
        adjustMinerDiff,
        retargetMiners,
        addProxyMiner,
        removeMiner,
        checkAliveMiners
    };
};
