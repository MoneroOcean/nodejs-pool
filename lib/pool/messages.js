"use strict";

module.exports = function createMessageHandler(deps) {
    const {
        cluster,
        debug,
        state,
        sendToWorkers,
        setNewBlockTemplate,
        setNewCoinHashFactor
    } = deps;
    const shareStatMap = {
        trustedShare: "trustedShares",
        normalShare: "normalShares",
        invalidShare: "invalidShares",
        outdatedShare: "outdatedShares",
        throttledShare: "throttledShares"
    };

    return function messageHandler(message) {
        const shareStat = shareStatMap[message.type];
        if (shareStat) {
            ++state.shareStats[shareStat];
            if (shareStat !== "outdatedShares") ++state.shareStats.totalShares;
            return;
        }

        switch (message.type) {
        case "banIP":
            debug(state.threadName + "Received ban IP update from nodes");
            if (cluster.isMaster) {
                sendToWorkers(message);
            } else if (!state.localhostCheck.test(message.data)) {
                state.bannedTmpIPs[message.data] = 1;
            } else if (message.wallet) {
                state.bannedTmpWallets[message.wallet] = 1;
            }
            break;
        case "newBlockTemplate":
            debug(state.threadName + "Received new block template");
            setNewBlockTemplate(message.data);
            break;
        case "newCoinHashFactor":
            debug(state.threadName + "Received new coin hash factor");
            setNewCoinHashFactor(true, message.data.coin, message.data.coinHashFactor);
            break;
        case "minerPortCount":
            if (cluster.isMaster) state.minerCount[message.data.worker_id] = message.data.ports;
            break;
        case "sendRemote":
            if (cluster.isMaster) global.database.sendQueue.push({ body: Buffer.from(message.body, "hex") });
            break;
        }
    };
};
