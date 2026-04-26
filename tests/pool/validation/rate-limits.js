"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MAIN_PORT,
    MAIN_WALLET,
    ALT_WALLET,
    THIRD_WALLET,
    VALID_RESULT,
    startHarness,
    invokePoolMethod,
    createBaseTemplate,
    poolModule
} = require("../common/harness.js");

async function expectLoginFinalError(params, error, options = {}) {
    const { prepare, timeout } = options;
    const { runtime } = await startHarness();

    try {
        if (prepare) await prepare(runtime);
        const reply = invokePoolMethod({ method: "login", params });

        assert.equal(reply.replies.length, 0);
        assert.deepEqual(reply.finals, [{ error, timeout }]);
    } finally {
        await runtime.stop();
    }
}

test.describe("pool validation: rate limits", { concurrency: false }, () => {
test("keepalived alias returns the same response as keepalive", async () => {
    const { runtime } = await startHarness();
    const socket = {};

    try {
        const loginReply = invokePoolMethod({
            socket,
            id: 193,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "worker-keepalived"
            }
        });

        const reply = invokePoolMethod({
            socket,
            id: 194,
            method: "keepalived",
            params: {
                id: loginReply.replies[0].result.id
            }
        });

        assert.deepEqual(reply.replies, [{ error: null, result: { status: "KEEPALIVED" } }]);
        assert.equal(reply.finals.length, 0);
    } finally {
        await runtime.stop();
    }
});

test("login requests are rejected when the per-IP login rate limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalLoginRateLimitPerSecond = global.config.pool.loginRateLimitPerSecond;
    const originalLoginRateLimitBurst = global.config.pool.loginRateLimitBurst;
    const ip = "10.0.0.77";

    try {
        global.config.pool.loginRateLimitPerSecond = 1;
        global.config.pool.loginRateLimitBurst = 1;

        const first = invokePoolMethod({
            socket: {},
            id: 1941,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-login-first"
            },
            ip
        });
        const second = invokePoolMethod({
            socket: {},
            id: 1942,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-login-second"
            },
            ip
        });

        assert.equal(first.replies[0].error, null);
        assert.deepEqual(second.finals, [{
            error: "Rate limit exceeded for login requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.loginRateLimitPerSecond = originalLoginRateLimitPerSecond;
        global.config.pool.loginRateLimitBurst = originalLoginRateLimitBurst;
        await runtime.stop();
    }
});

test("subscribe-phase requests share the login rate limit bucket", async () => {
    const { runtime } = await startHarness();
    const originalLoginRateLimitPerSecond = global.config.pool.loginRateLimitPerSecond;
    const originalLoginRateLimitBurst = global.config.pool.loginRateLimitBurst;
    const ip = "10.0.0.83";

    try {
        global.config.pool.loginRateLimitPerSecond = 1;
        global.config.pool.loginRateLimitBurst = 1;

        const first = invokePoolMethod({
            socket: {},
            id: 19421,
            method: "mining.subscribe",
            params: ["rate-subscribe-agent"],
            ip
        });
        const second = invokePoolMethod({
            socket: {},
            id: 19422,
            method: "mining.extranonce.subscribe",
            params: [],
            ip
        });

        assert.equal(first.replies[0].error, null);
        assert.deepEqual(second.finals, [{
            error: "Rate limit exceeded for login requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.loginRateLimitPerSecond = originalLoginRateLimitPerSecond;
        global.config.pool.loginRateLimitBurst = originalLoginRateLimitBurst;
        await runtime.stop();
    }
});

test("submit requests are rejected when the per-IP submit rate limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalSubmitRateLimitPerSecond = global.config.pool.submitRateLimitPerSecond;
    const originalSubmitRateLimitBurst = global.config.pool.submitRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.78";

    try {
        global.config.pool.submitRateLimitPerSecond = 1;
        global.config.pool.submitRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1943,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-submit"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const firstSubmit = invokePoolMethod({
            socket,
            id: 1944,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000011",
                result: VALID_RESULT
            },
            ip
        });
        const secondSubmit = invokePoolMethod({
            socket,
            id: 1945,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000012",
                result: VALID_RESULT
            },
            ip
        });

        assert.deepEqual(firstSubmit.replies, [{ error: null, result: { status: "OK" } }]);
        assert.deepEqual(secondSubmit.finals, [{
            error: "Rate limit exceeded for submit requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.submitRateLimitPerSecond = originalSubmitRateLimitPerSecond;
        global.config.pool.submitRateLimitBurst = originalSubmitRateLimitBurst;
        await runtime.stop();
    }
});

test("keepalive requests are rejected when the per-IP keepalive rate limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalKeepaliveRateLimitPerSecond = global.config.pool.keepaliveRateLimitPerSecond;
    const originalKeepaliveRateLimitBurst = global.config.pool.keepaliveRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.79";

    try {
        global.config.pool.keepaliveRateLimitPerSecond = 1;
        global.config.pool.keepaliveRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1946,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-keepalive"
            },
            ip
        });
        const minerId = loginReply.replies[0].result.id;

        const firstKeepalive = invokePoolMethod({
            socket,
            id: 1947,
            method: "keepalive",
            params: { id: minerId },
            ip
        });
        const secondKeepalive = invokePoolMethod({
            socket,
            id: 1948,
            method: "keepalive",
            params: { id: minerId },
            ip
        });

        assert.deepEqual(firstKeepalive.replies, [{ error: null, result: { status: "KEEPALIVED" } }]);
        assert.deepEqual(secondKeepalive.finals, [{
            error: "Rate limit exceeded for keepalive requests",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.keepaliveRateLimitPerSecond = originalKeepaliveRateLimitPerSecond;
        global.config.pool.keepaliveRateLimitBurst = originalKeepaliveRateLimitBurst;
        await runtime.stop();
    }
});

test("getjob requests are rejected when the pre-share job request limit is exceeded", async () => {
    const { runtime } = await startHarness();
    const originalJobRequestRateLimitPerSecond = global.config.pool.jobRequestRateLimitPerSecond;
    const originalJobRequestRateLimitBurst = global.config.pool.jobRequestRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.80";

    try {
        global.config.pool.jobRequestRateLimitPerSecond = 1;
        global.config.pool.jobRequestRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1949,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-getjob"
            },
            ip
        });
        const minerId = loginReply.replies[0].result.id;

        const firstGetJob = invokePoolMethod({
            socket,
            id: 1950,
            method: "getjob",
            params: { id: minerId },
            ip
        });
        const secondGetJob = invokePoolMethod({
            socket,
            id: 1951,
            method: "getjob",
            params: { id: minerId },
            ip
        });

        assert.equal(firstGetJob.replies[0].error, null);
        assert.deepEqual(secondGetJob.finals, [{
            error: "Rate limit exceeded for job requests before first valid share",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.jobRequestRateLimitPerSecond = originalJobRequestRateLimitPerSecond;
        global.config.pool.jobRequestRateLimitBurst = originalJobRequestRateLimitBurst;
        await runtime.stop();
    }
});

test("getjobtemplate and getjob share the same pre-share job request bucket", async () => {
    const { runtime } = await startHarness();
    const originalJobRequestRateLimitPerSecond = global.config.pool.jobRequestRateLimitPerSecond;
    const originalJobRequestRateLimitBurst = global.config.pool.jobRequestRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.81";

    try {
        global.config.pool.jobRequestRateLimitPerSecond = 1;
        global.config.pool.jobRequestRateLimitBurst = 1;

        invokePoolMethod({
            socket,
            id: 1952,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-getjobtemplate"
            },
            ip
        });

        const firstTemplate = invokePoolMethod({
            socket,
            id: 1953,
            method: "getjobtemplate",
            params: {},
            ip
        });
        const secondGetJob = invokePoolMethod({
            socket,
            id: 1954,
            method: "getjob",
            params: { id: socket.miner_id },
            ip
        });

        assert.equal(firstTemplate.replies[0].error, null);
        assert.deepEqual(secondGetJob.finals, [{
            error: "Rate limit exceeded for job requests before first valid share",
            timeout: undefined
        }]);
    } finally {
        global.config.pool.jobRequestRateLimitPerSecond = originalJobRequestRateLimitPerSecond;
        global.config.pool.jobRequestRateLimitBurst = originalJobRequestRateLimitBurst;
        await runtime.stop();
    }
});

test("pre-share job request limits stop applying after the first accepted share", async () => {
    const { runtime } = await startHarness();
    const originalJobRequestRateLimitPerSecond = global.config.pool.jobRequestRateLimitPerSecond;
    const originalJobRequestRateLimitBurst = global.config.pool.jobRequestRateLimitBurst;
    const socket = {};
    const ip = "10.0.0.82";

    try {
        global.config.pool.jobRequestRateLimitPerSecond = 1;
        global.config.pool.jobRequestRateLimitBurst = 1;

        const loginReply = invokePoolMethod({
            socket,
            id: 1955,
            method: "login",
            params: {
                login: MAIN_WALLET,
                pass: "rate-getjob-after-share"
            },
            ip
        });
        const jobId = loginReply.replies[0].result.job.job_id;

        const submitReply = invokePoolMethod({
            socket,
            id: 1956,
            method: "submit",
            params: {
                id: socket.miner_id,
                job_id: jobId,
                nonce: "00000013",
                result: VALID_RESULT
            },
            ip
        });
        const getTemplateReply = invokePoolMethod({
            socket,
            id: 1957,
            method: "getjobtemplate",
            params: {},
            ip
        });
        const getJobReply = invokePoolMethod({
            socket,
            id: 1958,
            method: "getjob",
            params: { id: socket.miner_id },
            ip
        });

        assert.deepEqual(submitReply.replies, [{ error: null, result: { status: "OK" } }]);
        assert.equal(getTemplateReply.replies[0].error, null);
        assert.equal(getTemplateReply.finals.length, 0);
        assert.equal(getJobReply.replies[0].error, null);
        assert.equal(getJobReply.finals.length, 0);
    } finally {
        global.config.pool.jobRequestRateLimitPerSecond = originalJobRequestRateLimitPerSecond;
        global.config.pool.jobRequestRateLimitBurst = originalJobRequestRateLimitBurst;
        await runtime.stop();
    }
});
});
