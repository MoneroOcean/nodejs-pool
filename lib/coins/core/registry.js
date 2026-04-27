"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { isCoinProfile } = require("./factories.js");

const PROFILE_DIRECTORY = path.resolve(__dirname, "..");
const PROFILE_IGNORE = new Set(["constants.js", "helpers.js", "index.js", "metadata.json"]);

function normalizeProfile(profile) {
    const normalized = Object.assign({
        aliases: [],
        blob: {},
        listed: true,
        perf: {},
        pool: {},
        pow: {},
        rpc: {},
        template: {}
    }, profile);

    normalized.port = Number(normalized.port);
    normalized.displayCoin = normalized.displayCoin || normalized.coin || "";
    normalized.aliases = Array.from(new Set(
        []
            .concat(typeof normalized.coin === "string" ? [normalized.coin] : [])
            .concat(typeof normalized.displayCoin === "string" ? [normalized.displayCoin] : [])
            .concat(Array.isArray(normalized.aliases) ? normalized.aliases : [])
            .filter(function keepAlias(alias) {
                return typeof alias === "string" && alias.length > 0;
            })
    ));

    if (!normalized.blob.nonceSize) normalized.blob.nonceSize = 4;
    if (!normalized.blob.proofSize) normalized.blob.proofSize = 32;

    return normalized;
}

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
        .map(normalizeProfile)
        .sort(function sortProfiles(left, right) {
            return left.port - right.port;
        });
}

function buildMmPortSet(profiles) {
    const mmPortSet = {};
    profiles.forEach(function registerProfile(profile) {
        if (!profile.mergedMining || !profile.mergedMining.childPort) return;
        mmPortSet[profile.port] = profile.mergedMining.childPort;
    });
    return mmPortSet;
}

function buildMmChildPortSet(mmPortSet) {
    const mmChildPortSet = {};
    for (const parentPort in mmPortSet) {
        const childPort = mmPortSet[parentPort];
        if (!(childPort in mmChildPortSet)) mmChildPortSet[childPort] = {};
        mmChildPortSet[childPort][parentPort] = 1;
    }
    return mmChildPortSet;
}

function buildBlobTraits(profiles) {
    const blobTraits = {};

    profiles.forEach(function registerProfile(profile) {
        const blobType = profile.blobType;
        if (blobType === undefined || blobType === null) return;
        if (!(blobType in blobTraits)) {
            blobTraits[blobType] = {
                nonceSize: profile.blob.nonceSize,
                proofSize: profile.blob.proofSize
            };
        }

        if (profile.blob.nonceSize) blobTraits[blobType].nonceSize = profile.blob.nonceSize;
        if (profile.blob.proofSize) blobTraits[blobType].proofSize = profile.blob.proofSize;
    });

    return blobTraits;
}

function loadRegistry() {
    const profiles = loadProfiles();
    const profilesByPort = {};
    const profilesByAlias = {};
    const profilesByBlobType = {};
    const port2algo = {};
    const port2blob_num = {};
    const port2coin = {};
    const port2displayCoin = {};
    const all_algos = {};
    const listedCoins = [];
    const mainAlgoSet = {};
    const prevMainAlgoSet = {};
    const defaultAlgoPerf = {};
    const prevAlgoPerf = {};
    const minerAlgoAliases = {};
    const canonicalAlgosByAlias = {};
    const blobTraits = buildBlobTraits(profiles);

    function registerMinerAlgoAliases(profile) {
        if (!profile.minerAlgoAliases) return;
        for (const algo in profile.minerAlgoAliases) {
            if (!(algo in minerAlgoAliases)) minerAlgoAliases[algo] = [];
            const aliases = profile.minerAlgoAliases[algo];
            aliases.forEach(function addAlias(alias) {
                if (!minerAlgoAliases[algo].includes(alias)) minerAlgoAliases[algo].push(alias);
                if (!(alias in canonicalAlgosByAlias)) canonicalAlgosByAlias[alias] = [];
                if (!canonicalAlgosByAlias[alias].includes(algo)) canonicalAlgosByAlias[alias].push(algo);
            });
        }
    }

    function registerProfileBasics(profile, portKey) {
        profilesByPort[portKey] = profile;
        if (!(profile.blobType in profilesByBlobType)) profilesByBlobType[profile.blobType] = [];
        profilesByBlobType[profile.blobType].push(profile);
        port2algo[portKey] = profile.algo;
        port2blob_num[portKey] = profile.blobType;
        port2displayCoin[portKey] = profile.displayCoin;
        if (profile.listed !== false || profile.coin === "") port2coin[portKey] = profile.coin;
        if (profile.listed !== false && profile.coin) listedCoins.push(profile.coin);
        if (profile.algo) all_algos[profile.algo] = 1;
    }

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
