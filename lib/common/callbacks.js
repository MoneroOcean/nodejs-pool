"use strict";
/**
 * @template T
 * @typedef {{data: T, callback: (() => void) | undefined, enqueueOrder: number}} QueueTask
 */

/**
 * @template T
 * @param {number} concurrency
 * @param {(data: T, done: () => void) => void} worker
 * @returns {{push: (data: T, callback?: () => void) => void, unshift: (data: T, callback?: () => void) => void, oldest: () => QueueTask<T> | null, remove: (predicate: (task: QueueTask<T>) => boolean) => void, length: () => number, running: () => number}}
 */
function createTaskQueue(concurrency, worker) {
    /** @type {QueueTask<T>[]} */
    const pending = [];
    let running = 0;
    let pumping = false;
    let enqueueOrder = 0;

    /**
     * @param {"push" | "unshift"} method
     * @param {T} data
     * @param {(() => void) | undefined} callback
     * @returns {void}
     */
    function enqueue(method, data, callback) {
        // method is "push" (FIFO tail) or "unshift" (priority front) — see the queue object below.
        // Stamp a monotonic insertion order so oldest() is correct regardless of push vs unshift:
        // an unshift (priority-front) queue puts the NEWEST task at the array head, so a positional
        // oldest() (pending[0]) would return the newest and defeat the share-verify stale cleanup.
        const task = { data, callback, enqueueOrder: enqueueOrder++ };
        if (method === "push") pending.push(task);
        else pending.unshift(task);
        pump();
    }

    function pump() {
        // Guard against reentry: a synchronous worker callback runs pump() again, which would
        // let `running` exceed `concurrency`. Skip when an outer pump loop is already active.
        if (pumping) return;
        pumping = true;
        while (running < concurrency && pending.length) {
            const task = pending.shift();
            if (!task) break;
            running += 1;
            worker(task.data, function onDone() {
                running -= 1;
                if (typeof task.callback === "function") task.callback();
                pump();
            });
        }
        pumping = false;
    }

    return {
        /** @param {T} data @param {(() => void) | undefined} callback @returns {void} */
        push(data, callback) { enqueue("push", data, callback); },
        /** @param {T} data @param {(() => void) | undefined} callback @returns {void} */
        unshift(data, callback) { enqueue("unshift", data, callback); },
        oldest() {
            let oldestTask = null;
            for (const task of pending) {
                if (!oldestTask || task.enqueueOrder < oldestTask.enqueueOrder) oldestTask = task;
            }
            return oldestTask;
        },
        /** @param {(task: QueueTask<T>) => boolean} predicate @returns {void} */
        remove(predicate) {
            for (let index = pending.length - 1; index >= 0; --index) {
                const task = pending[index];
                if (task && predicate(task)) pending.splice(index, 1);
            }
        },
        length() { return pending.length; },
        running() { return running; }
    };
}

/**
 * @template T
 * @template R
 * @param {T[]} items
 * @param {(item: T, callback: (result: R | null) => void) => void} iteratee
 * @param {(result: R | null) => void} done
 * @returns {void}
 */
function findSeries(items, iteratee, done) {
    (function next(index) {
        if (index >= items.length) return done(null);
        const item = items[index];
        if (typeof item === "undefined") return done(null);
        iteratee(item, function onResult(result) {
            if (result) return done(result);
            return next(index + 1);
        });
    }(0));
}

module.exports = { createTaskQueue, findSeries };
