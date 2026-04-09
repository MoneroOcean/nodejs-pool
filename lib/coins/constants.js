"use strict";

// Keep static XMR-family metadata in JSON so adding or adjusting ports is
// mostly data-driven instead of requiring code edits in the pool runtime.
const config = require("./metadata.json");

const reXMRig = /XMRig(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\./;
const reXMRSTAKRX = /\w+-stak-rx\/(\d+)\.(\d+)\.(\d+)/;
const reXMRSTAK = /\w+-stak(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\.(\d+)/;
const reXNP = /xmr-node-proxy\/(\d+)\.(\d+)\.(\d+)/;
const reCAST = /cast_xmr\/(\d+)\.(\d+)\.(\d+)/;
const reSRB = /SRBMiner Cryptonight AMD GPU miner\/(\d+)\.(\d+)\.(\d+)/;
const reSRBMULTI = /SRBMiner-MULTI\/(\d+)\.(\d+)\.(\d+)/;

function buildPortMaps(portConfig) {
    const port2coin = {};
    const port2blob_num = {};
    const port2algo = {};

    Object.entries(portConfig).forEach(function ([port, entry]) {
        if (Object.prototype.hasOwnProperty.call(entry, "coin")) port2coin[port] = entry.coin;
        port2blob_num[port] = entry.blobType;
        port2algo[port] = entry.algo;
    });

    return { port2coin, port2blob_num, port2algo };
}

function getCoin2Port(portMap) {
    const coin2port = {};
    for (const port in portMap) coin2port[portMap[port]] = parseInt(port, 10);
    return coin2port;
}

function getCoins(portMap) {
    const coins = [];
    for (const port in portMap) if (portMap[port] !== "") coins.push(portMap[port]);
    return coins;
}

function getMmChildPortSet(mmPortSet) {
    const mmChildPortSet = {};
    for (const port in mmPortSet) {
        const childPort = mmPortSet[port];
        if (!(childPort in mmChildPortSet)) mmChildPortSet[childPort] = {};
        mmChildPortSet[childPort][port] = 1;
    }
    return mmChildPortSet;
}

function getAlgos(portMap) {
    const algos = {};
    for (const port in portMap) algos[portMap[port]] = 1;
    return algos;
}

function buildTemplateHex(poolNonceSize) {
    return "02" + (poolNonceSize + 0x100).toString(16).substr(-2) + "00".repeat(poolNonceSize);
}

function buildMergedTemplateHex(poolNonceSize, mmNonceSize) {
    return "02" + (mmNonceSize + poolNonceSize + 0x100).toString(16).substr(-2) + "00".repeat(mmNonceSize + poolNonceSize);
}

module.exports = function createConstants(cnUtil) {
    const mm_nonce_size = cnUtil.get_merged_mining_nonce_size();
    const mm_port_set = config.mmPortSet || {};
    const { port2coin, port2blob_num, port2algo } = buildPortMaps(config.ports);

    return {
        all_algos: getAlgos(port2algo),
        coin2port: getCoin2Port(port2coin),
        coins: getCoins(port2coin),
        extra_nonce_mm_template_hex: buildMergedTemplateHex(config.poolNonceSize, mm_nonce_size),
        extra_nonce_template_hex: buildTemplateHex(config.poolNonceSize),
        fix_daemon_sh: config.fixDaemonScript,
        mm_child_port_set: getMmChildPortSet(mm_port_set),
        mm_nonce_size,
        mm_port_set,
        pool_nonce_size: config.poolNonceSize,
        port2algo,
        port2blob_num,
        port2coin,
        ports: Object.keys(port2coin),
        reCAST,
        reSRB,
        reSRBMULTI,
        reXMRSTAK,
        reXMRSTAKRX,
        reXMRig,
        reXNP
    };
};
