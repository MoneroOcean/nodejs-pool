"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { isCoinProfile } = require("./factories.js");

const PROFILE_DIRECTORY = path.resolve(__dirname, "..");
const PROFILE_IGNORE = new Set(["constants.js", "helpers.js", "index.js", "metadata.json"]);

function loadProfiles() {
    return fs.readdirSync(PROFILE_DIRECTORY)
        .filter(function filterEntry(entry) {
            return entry.endsWith(".js") && !PROFILE_IGNORE.has(entry);
        })
        .map(function requireProfile(entry) {
            return require(path.join(PROFILE_DIRECTORY, entry));
        })
        // Top-level helpers are allowed in lib/coins as long as they are not
        // tagged profile exports.
        .filter(isCoinProfile)
        .sort(function sortProfiles(left, right) {
            return left.port - right.port;
        });
}

/** @param {import("../../../types/coin_profiles").CoinProfile[]} profiles */
function buildMmPortSet(profiles) {
    /** @type {Record<string, number>} */
    const mmPortSet = {};
    profiles.forEach(function registerProfile(profile) {
        if (!profile.mergedMining || !profile.mergedMining.childPort) return;
        mmPortSet[profile.port] = profile.mergedMining.childPort;
    });
    return mmPortSet;
}

/** @param {Record<string, number>} mmPortSet */
function buildMmChildPortSet(mmPortSet) {
    /** @type {Record<string, Record<string, number>>} */
    const mmChildPortSet = {};
    for (const [parentPort, childPort] of Object.entries(mmPortSet)) {
        const parents = mmChildPortSet[childPort] ??= {};
        parents[parentPort] = 1;
    }
    return mmChildPortSet;
}

/** @param {import("../../../types/coin_profiles").CoinProfile[]} profiles */
function buildBlobTraits(profiles) {
    /** @type {Record<string, {nonceSize: number, proofSize: number}>} */
    const blobTraits = {};
    for (const profile of profiles) {
        blobTraits[profile.blobType] = {
            nonceSize: profile.blob.nonceSize,
            proofSize: profile.blob.proofSize
        };
    }
    return blobTraits;
}

function loadRegistry() {
    const profiles = loadProfiles();
    /** @type {Record<string, import("../../../types/coin_profiles").CoinProfile>} */
    const profilesByPort = {};
    /** @type {Record<string, import("../../../types/coin_profiles").CoinProfile>} */
    const profilesByAlias = {};
    /** @type {Record<string, import("../../../types/coin_profiles").CoinProfile[]>} */
    const profilesByBlobType = {};
    /** @type {Record<string, string>} */
    const port2algo = {};
    /** @type {Record<string, number>} */
    const port2blob_num = {};
    /** @type {Record<string, string | null>} */
    const port2coin = {};
    /** @type {Record<string, string>} */
    const port2displayCoin = {};
    /** @type {Record<string, number>} */
    const all_algos = {};
    /** @type {string[]} */
    const listedCoins = [];
    /** @type {Record<string, number>} */
    const mainAlgoSet = {};
    /** @type {Record<string, number>} */
    const prevMainAlgoSet = {};
    /** @type {Record<string, number>} */
    const defaultAlgoPerf = {};
    /** @type {Record<string, number>} */
    const prevAlgoPerf = {};
    /** @type {Record<string, string[]>} */
    const minerAlgoAliases = {};
    /** @type {Record<string, string[]>} */
    const canonicalAlgosByAlias = {};
    const blobTraits = buildBlobTraits(profiles);

    /** @param {import("../../../types/coin_profiles").CoinProfile} profile */
    function registerMinerAlgoAliases(profile) {
        for (const [algo, aliases] of Object.entries(profile.minerAlgoAliases || {})) {
            const registered = minerAlgoAliases[algo] ??= [];
            for (const alias of aliases) {
                if (!registered.includes(alias)) registered.push(alias);
                const canonical = canonicalAlgosByAlias[alias] ??= [];
                if (!canonical.includes(algo)) canonical.push(algo);
            }
        }
    }

    /** @param {import("../../../types/coin_profiles").CoinProfile} profile @param {string} portKey */
    function registerProfileBasics(profile, portKey) {
        profilesByPort[portKey] = profile;
        (profilesByBlobType[profile.blobType] ??= []).push(profile);
        port2algo[portKey] = profile.algo;
        port2blob_num[portKey] = profile.blobType;
        port2displayCoin[portKey] = profile.displayCoin;
        // Map listed coins, plus the empty-coin base profile so its port still resolves.
        if (profile.listed !== false || profile.coin === "") port2coin[portKey] = profile.coin;
        if (profile.listed !== false && profile.coin) listedCoins.push(profile.coin);
        if (profile.algo) all_algos[profile.algo] = 1;
    }

    /** @param {import("../../../types/coin_profiles").CoinProfile} profile */
    function registerProfilePerf(profile) {
        if (profile.perf && profile.perf.mainAlgo) mainAlgoSet[profile.algo] = 1;
        if (profile.perf && profile.perf.prevMainAlgo) prevMainAlgoSet[profile.algo] = 1;
        if (profile.perf && profile.perf.defaultPerf !== undefined && profile.algo) defaultAlgoPerf[profile.algo] = profile.perf.defaultPerf;
        if (profile.perf && profile.perf.prevDefaultPerf !== undefined && profile.algo) prevAlgoPerf[profile.algo] = profile.perf.prevDefaultPerf;
        if (profile.perf && profile.perf.extraPrevDefaultPerf) Object.assign(prevAlgoPerf, profile.perf.extraPrevDefaultPerf);
    }

    profiles.forEach(function registerProfile(profile) {
        const portKey = profile.port.toString();
        registerProfileBasics(profile, portKey);
        registerProfilePerf(profile);
        registerMinerAlgoAliases(profile);

        const aliasList = profile.aliases.slice();
        if (typeof profile.coin === "string") aliasList.push(profile.coin);
        if (typeof profile.displayCoin === "string") aliasList.push(profile.displayCoin);
        Array.from(new Set(aliasList.filter(Boolean))).forEach(function registerAlias(alias) {
            profilesByAlias[alias] = profile;
        });
    });

    const mm_port_set = buildMmPortSet(profiles);
    const mm_child_port_set = buildMmChildPortSet(mm_port_set);

    return {
        all_algos,
        blobTraits,
        canonicalAlgosByAlias,
        defaultAlgoPerf,
        listedCoins,
        mainAlgoSet,
        minerAlgoAliases,
        mm_child_port_set,
        mm_port_set,
        port2algo,
        port2blob_num,
        port2coin,
        port2displayCoin,
        prevAlgoPerf,
        prevMainAlgoSet,
        profiles,
        profilesByAlias,
        profilesByBlobType,
        profilesByPort
    };
}

module.exports = loadRegistry;
