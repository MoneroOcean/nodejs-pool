"use strict";

// Prints the exchange recovery helper catalog.
// This script is read-only; run the listed helper for the specific stuck state.

const HELP = [
    "exchange recovery helpers:",
    "",
    "Deposit guard:",
    "  node manage_scripts/exchange_recovery_deposit_clear.js",
    "  node manage_scripts/exchange_recovery_deposit_clear.js --port <port>",
    "  node manage_scripts/exchange_recovery_deposit_clear.js --port <port> --clear --confirm-reviewed-deposit=true",
    "  Use after a wallet->exchange deposit is posted/credited but altblock_exchange_deposit is still waiting.",
    "",
    "Ambiguous wallet send:",
    "  node manage_scripts/exchange_recovery_wallet_clear.js",
    "  node manage_scripts/exchange_recovery_wallet_clear.js --port <port>",
    "  node manage_scripts/exchange_recovery_wallet_clear.js --port <port> --clear --confirm-reviewed-wallet=true",
    "  Use after reviewing an ambiguous wallet RPC submit stored in altblock_exchange_wallet.",
    "  For ARQ transfer-too-large recovery, clear only the old reviewed wallet entry; the restarted runtime will retry and auto sweep_all once.",
    "",
    "Intermediate bridge credit:",
    "  node manage_scripts/exchange_recovery_bridge_credit_fix.js --current-balance=<amount> --active-orders=false --confirm-reviewed-credit=true",
    "  Use when BASE/BTC/USDT credited differently than the active trade expectation.",
    "",
    "Low final XMR credit:",
    "  node manage_scripts/exchange_recovery_low_xmr_credit_fix.js --current-balance=<amount> --active-orders=false --confirm-reviewed-credit=true",
    "  Use when final XMR credited less than expected and the observed amount is complete.",
    "",
    "Backward/manual XMR balance:",
    "  node manage_scripts/exchange_recovery_xmr_balance_fix.js --current-balance=<amount> --active-orders=false --confirm-manual-withdrawal=true",
    "  Use when final XMR settlement is stuck because exchange XMR moved backward or was manually withdrawn."
];

function main() {
    HELP.forEach(function print(line) {
        console.log(line);
    });
}

if (require.main === module) main();

module.exports = {
    HELP,
    main
};
