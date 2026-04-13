"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 17767,
    coin: "ZEPH",
    blobType: 13,
    algo: "rx/0",
    blobTypeName: "cryptonote_zeph",
    blob: blob.cryptonote(),
    pool: pool.standard(),
    rpc: rpc.cryptonoteGetBlock({
        selectWalletTransferReward({ transfer, transfers }) {
            const assetTransfer = transfers.find((item) => item.asset_type === "ZEPH");
            return assetTransfer && Array.isArray(assetTransfer.amounts) && assetTransfer.amounts.length > 0
                ? assetTransfer.amounts[0]
                : transfer.amount;
        }
    }),
    pow: pow.randomx()
});
