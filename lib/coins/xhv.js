"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 17750,
    coin: "XHV",
    blobType: 11,
    algo: "cn-heavy/xhv",
    blobTypeName: "cryptonote_xhv",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    minerAlgoAliases: {
        "cn-heavy/0": ["cn-heavy"]
    },
    agent: {
        noSupportRules: [
            {
                matcher: "xmrig",
                maxVersionExclusive: "6.3.0",
                unsupportedAlgos: ["cn-heavy/xhv"]
            }
        ]
    },
    rpc: rpc.cryptonoteGetBlock({
        headerRewardMode: "first-vout",
        selectWalletTransferReward({ transfer, transfers }) {
            const assetTransfer = transfers.find((item) => item.asset_type === "XHV");
            return assetTransfer ? assetTransfer.amount : transfer.amount;
        }
    }),
    pow: pow.cryptonightHeavy({ variant: 1 })
});
