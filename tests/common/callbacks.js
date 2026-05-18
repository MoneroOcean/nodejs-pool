"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTaskQueue } = require("../../lib/common/callbacks.js");

test.describe("callbacks", { concurrency: false }, () => {
    test("createTaskQueue handles synchronous completions without recursive pump overflow", async () => {
        const blocked = [];
        let completed = 0;
        const queue = createTaskQueue(16, function processTask(task, done) {
            if (task.block) {
                blocked.push(done);
                return;
            }
            completed += 1;
            done();
        });

        for (let index = 0; index < 16; ++index) queue.push({ block: true });
        for (let index = 0; index < 30000; ++index) queue.push({ block: false });

        assert.equal(queue.running(), 16);
        assert.equal(queue.length(), 30000);
        assert.equal(blocked.length, 16);

        blocked.pop()();
        assert.equal(completed, 30000);
        assert.equal(queue.length(), 0);
        assert.equal(queue.running(), 15);
    });
});
