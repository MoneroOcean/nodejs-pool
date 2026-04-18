"use strict";

const { blob, createProfile, pool, pow, rpc } = require("./core/factories.js");

module.exports = createProfile({
    port: 18081,
    coin: "",
    displayCoin: "XMR",
    blobType: 0,
    algo: "rx/0",
    blobTypeName: "cryptonote",
    blob: blob.cryptonote(),
    pool: pool.standard({
        acceptSubmittedBlock: pool.submitAccept.statusOkObject,
        dualSubmitDisplayCoin: "XTM",
        dualSubmitReportPort: 18144,
        dualSubmitPortOffset: 0,
        mainSubmitPortOffset: 2,
        submitBlockRpc: pool.blockSubmit.dualMain
    }),
    network: {
        mainnet: {
            prefix: 18,
            subPrefix: 42,
            intPrefix: 19
        },
        testnet: {
            prefix: 53,
            subPrefix: 63,
            intPrefix: 54
        }
    },
    addresses: {
        coinDev: "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
        poolDev: "499fS1Phq64hGeqV8p2AfXbf6Ax7gP6FybcMJq6Wbvg8Hw6xms8tCmdYpPsTLSaTNuLEtW4kF2DDiWCFcw4u7wSvFD8wFWE",
        blocked: [
            "43SLUTpyTgXCNXsL43uD8FWZ5wLAdX7Ak67BgGp7dxnGhLmrffDTXoeGm2GBRm8JjigN9PTg2gnShQn5gkgE1JGWJr4gsEU",
            "42QWoLF7pdwMcTXDviJvNkWEHJ4TXnMBh2Cx6HNkVAW57E48Zfw6wLwDUYFDYJAqY7PLJUTz9cHWB5C4wUA7UJPu5wPf4sZ",
            "46gq64YYgCk88LxAadXbKLeQtCJtsLSD63NiEc3XHLz8NyPAyobACP161JbgyH2SgTau3aPUsFAYyK2RX4dHQoaN1ats6iT",
            "47mr7jYTroxQMwdKoPQuJoc9Vs9S9qCUAL6Ek4qyNFWJdqgBZRn4RYY2QjQfqEMJZVWPscupSgaqmUn1dpdUTC4fQsu3yjN"
        ]
    },
    niceHashDiff: 400000,
    agent: {
        warningRules: [
            {
                matcher: "xmrig",
                maxVersionExclusive: "3.2.0",
                message: "Please update your XMRig miner ({agent}) to v3.2.0+ to support new rx/0 Monero algo"
            },
            {
                matcher: "xmrig",
                minVersionInclusive: "4.0.0",
                maxVersionExclusive: "4.2.0",
                message: "Please update your XMRig miner ({agent}) to v4.2.0+ to support new rx/0 Monero algo"
            },
            {
                matcher: "xmrstak",
                message: "Please update your xmr-stak miner ({agent}) to xmr-stak-rx miner to support new rx/0 Monero algo"
            },
            {
                matcher: "xnp",
                maxVersionExclusive: "0.14.0",
                message: "Please update your xmr-node-proxy ({agent}) to version v0.14.0+ by doing 'cd xmr-node-proxy && ./update.sh' (or check https://github.com/MoneroOcean/xmr-node-proxy repo) to support new rx/0 Monero algo"
            },
            {
                matcher: "srbmulti",
                maxVersionExclusive: "0.1.5",
                message: "Please update your SRBminer-MULTI ({agent}) to version v0.1.5+ to support new rx/0 Monero algo"
            }
        ],
        unsupportedByMatcher: {
            xmrstakrx: "rx/0",
            xmrstak: "cn/r"
        }
    },
    rpc: rpc.cryptonoteGetBlock({ lastHeaderMmCoin: "XTM-T" }),
    pow: pow.randomx(),
    perf: {
        defaultPerf: 1,
        mainAlgo: true,
        extraPrevDefaultPerf: {
            "cn/rwz": 1.3,
            "cn/zls": 1.3,
            "cn/double": 0.5
        }
    }
});
