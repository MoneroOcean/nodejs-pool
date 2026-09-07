"use strict";
if (Boolean(process.stdin.isTTY) || process.argv.length !== 2) {
  console.log("Usage: unxz -c <block hash>.cvs.xz | node calc_mo_cvs_top.js");
  console.log("       wget -O - https://block-share-dumps.moneroocean.stream/<block hash>.cvs.xz | unxz -c | node calc_mo_cvs_top.js");
  process.exit(1);
}

let stdin = "";

process.stdin.on('data', function(data) {
  stdin += data.toString();
});

process.stdin.on('end', function() {
  // Only normalized difficulty contributes to this ranking.
  const wallets = Object.create(null);

  for (const line of stdin.split("\n")) {
    if (line.substring(0, 1) === "#") continue;
    const items = line.split('\t');
    if (items.length < 7) {
      console.error(`Skipped invalid line: ${  line}`);
      continue;
    }
    const wallet         = items[0];
    const xmr_diff = parseInt(items[5]);
    wallets[wallet] = (wallets[wallet] ?? 0) + xmr_diff;
  }

  for (const wallet of Object.keys(wallets).sort((a, b) => (wallets[a] < wallets[b]) ? 1 : -1)) {
    console.log(`${wallet  }: ${  wallets[wallet]}`);
  }

  process.exit(0);
});