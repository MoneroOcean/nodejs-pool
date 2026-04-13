"use strict";

const coinConfig = require("./core/config.js");
const loadRegistry = require("./core/registry.js");

const reXMRig = /XMRig(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\./;
const reXMRSTAKRX = /\w+-stak-rx\/(\d+)\.(\d+)\.(\d+)/;
const reXMRSTAK = /\w+-stak(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\.(\d+)/;
const reXNP = /xmr-node-proxy\/(\d+)\.(\d+)\.(\d+)/;
const reCAST = /cast_xmr\/(\d+)\.(\d+)\.(\d+)/;
const reSRB = /SRBMiner Cryptonight AMD GPU miner\/(\d+)\.(\d+)\.(\d+)/;
const reSRBMULTI = /SRBMiner-MULTI\/(\d+)\.(\d+)\.(\d+)/;

function buildCoin2Port(profiles) {
    const coin2port = {};

    profiles.forEach(function registerProfile(profile) {
        if (typeof profile.coin === "string") coin2port[profile.coin] = profile.port;
        if (profile.aliases) profile.aliases.forEach(function registerAlias(alias) {
            coin2port[alias] = profile.port;
        });
        if (profile.displayCoin) coin2port[profile.displayCoin] = profile.port;
    });

    return coin2port;
}

function buildTemplateHex(poolNonceSize) {
    return "02" + (poolNonceSize + 0x100).toString(16).substr(-2) + "00".repeat(poolNonceSize);
}

function buildMergedTemplateHex(poolNonceSize, mmNonceSize) {
    return "02" + (mmNonceSize + poolNonceSize + 0x100).toString(16).substr(-2) + "00".repeat(mmNonceSize + poolNonceSize);
}

module.exports = function createConstants(cnUtil) {
    const registry = loadRegistry();
    const mm_nonce_size = cnUtil.get_merged_mining_nonce_size();

    return {
        all_algos: registry.all_algos,
        coin2port: buildCoin2Port(registry.profiles),
        coins: registry.listedCoins.slice(),
        extra_nonce_mm_template_hex: buildMergedTemplateHex(coinConfig.poolNonceSize, mm_nonce_size),
        extra_nonce_template_hex: buildTemplateHex(coinConfig.poolNonceSize),
        fix_daemon_sh: coinConfig.fixDaemonScript,
        mm_child_port_set: registry.mm_child_port_set,
        mm_nonce_size,
        mm_port_set: registry.mm_port_set,
        pool_nonce_size: coinConfig.poolNonceSize,
        port2algo: registry.port2algo,
        port2blob_num: registry.port2blob_num,
        port2coin: registry.port2coin,
        port2displayCoin: registry.port2displayCoin,
        ports: Object.keys(registry.port2algo),
        reCAST,
        reSRB,
        reSRBMULTI,
        reXMRSTAK,
        reXMRSTAKRX,
        reXMRig,
        reXNP
    };
};
