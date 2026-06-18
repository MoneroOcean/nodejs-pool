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

    test("oldest() returns the earliest-enqueued task for both push and unshift (share-verify cleanup)", () => {
        // concurrency 0 keeps everything pending so we can inspect oldest().
        const queue = createTaskQueue(0, function processTask(_task, done) { done(); });

        queue.push({ label: "push-first" });        // enqueued 1st -> the true oldest
        queue.unshift({ label: "unshift-second" });  // priority-front: array head, but NEWER than push-first
        queue.push({ label: "push-third" });

        // Positional pending[0] here is "unshift-second"; oldest() must NOT return that.
        assert.equal(queue.oldest().data.label, "push-first");

        queue.remove(function removeFirst(task) { return task.data.label === "push-first"; });
        assert.equal(queue.oldest().data.label, "unshift-second");
    });
});
