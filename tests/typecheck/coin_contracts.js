"use strict";
const Coin = require("../../lib/coins/index.js");
const coin = new Coin({});
const template = { port: 18081, height: 1 };
coin.slowHashBuffAsync(Buffer.alloc(0), template, "miner", () => {});
coin.slowHashBuffAsync(Buffer.alloc(0), template, () => {});
// @ts-expect-error The address form requires a callback.
coin.slowHashBuffAsync(Buffer.alloc(0), template, "miner");
const describePort = coin.PORT2COIN_FULL;
// @ts-expect-error This method depends on its coin runtime receiver.
describePort(18081);
