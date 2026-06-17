"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const createLifecycle = require("../../../lib/pool/lifecycle.js");

function createLifecycleHarness(rows, template) {
    const fixes = [];
    const state = {
        activeBlockTemplates: { "": template },
        lastBlockLagStartTime: {},
        lastBlockFixTime: {},
        lastBlockFixCount: {},
        threadName: ""
    };

    global.config = {
        bind_ip: "127.0.0.1",
        daemon: {
            port: template.port,
            stuckTemplateLagBlocks: 5,
            stuckTemplateGraceSeconds: 300,
            stuckTemplateFixCooldownSeconds: 900,
            stuckTemplateCheckInterval: 60000
        },
        general: {
            adminEmail: "ops@example.com",
            allowStuckPoolKill: false
        },
        hostname: "pool.test"
    };
    global.mysql = {
        query(sql) {
            assert.equal(sql, "SELECT blockID, xtmBlockID, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)");
            return Promise.resolve(rows);
        }
    };
    global.coinFuncs = {
        fixDaemonIssue(issue) {
            fixes.push(issue);
        }
    };
    global.support = {
        sendEmail() {}
    };

    const lifecycle = createLifecycle({
        cluster: {},
        fs,
        net: {},
        os: {},
        pruneTimedEntries() {},
        readline: {},
        retention: {},
        state,
        minerRegistry: {},
        shareProcessor: {},
        templateManager: {},
        messageHandler() {},
        startPortServers() {},
        formatCoinPort(_coin, port) { return `XMR:${  port}`; },
        formatPoolEvent(label, fields) { return `${label  } ${  JSON.stringify(fields || {})}`; }
    });

    return { fixes, lifecycle, state };
}

// Snapshot the globals each test stubs so the finally block can restore them.
function saveGlobals() {
    const saved = {
        dateNow: Date.now,
        config: global.config,
        mysql: global.mysql,
        coinFuncs: global.coinFuncs,
        support: global.support
    };
    return function restore() {
        Date.now = saved.dateNow;
        global.config = saved.config;
        global.mysql = saved.mysql;
        global.coinFuncs = saved.coinFuncs;
        global.support = saved.support;
    };
}

test.describe("pool runtime: daemon recovery", { concurrency: false }, () => {
test("stuck template recovery waits for grace, respects cooldown, and clears after catch-up", async () => {
    const restoreGlobals = saveGlobals();
    let now = 100000;
    const template = { port: 18081, height: 100, xtm_height: 200 };
    const rows = [
        { port: 18081, blockID: 100, xtmBlockID: 200 },
        { port: 18081, blockID: 105, xtmBlockID: 200 }
    ];
    const { fixes, lifecycle } = createLifecycleHarness(rows, template);
    Date.now = function () { return now; };

    try {
        assert.equal((await lifecycle.checkStuckTemplateHealth()).xmr, "grace");
        now += 301000;
        assert.equal((await lifecycle.checkStuckTemplateHealth()).xmr, "fix");
        now += 5000;
        assert.equal((await lifecycle.checkStuckTemplateHealth()).xmr, "cooldown");
        assert.equal(fixes.length, 1);
        assert.equal(fixes[0].reason, "xmr-lag");
        assert.equal(fixes[0].expectedXmrHeight, 105);

        template.height = 105;
        assert.equal((await lifecycle.checkStuckTemplateHealth()).xmr, "healthy");

        template.height = 100;
        now += 1000;
        assert.equal((await lifecycle.checkStuckTemplateHealth()).xmr, "grace");
        assert.equal(fixes.length, 1);
    } finally {
        restoreGlobals();
    }
});

test("stuck template recovery uses one full-stack fix when XMR and XTM both lag", async () => {
    const restoreGlobals = saveGlobals();
    let now = 100000;
    const template = { port: 18081, height: 100, xtm_height: 200 };
    const rows = [
        { port: 18081, blockID: 100, xtmBlockID: 200 },
        { port: 18081, blockID: 105, xtmBlockID: 205 }
    ];
    const { fixes, lifecycle } = createLifecycleHarness(rows, template);
    Date.now = function () { return now; };

    try {
        await lifecycle.checkStuckTemplateHealth();
        now += 301000;
        const result = await lifecycle.checkStuckTemplateHealth();

        assert.equal(result.xmr, "fix");
        assert.equal(result.xtm, "fix");
        assert.equal(fixes.length, 1);
        assert.deepEqual(fixes[0], {
            reason: "template-stuck",
            port: 18081,
            xmrHeight: 100,
            expectedXmrHeight: 105,
            xtmHeight: 200,
            expectedXtmHeight: 205
        });
    } finally {
        restoreGlobals();
    }
});
});
