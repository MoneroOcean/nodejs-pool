"use strict";
function createTaskQueue(concurrency, worker) {
    const pending = [];
    let running = 0;
    let pumping = false;

    function enqueue(method, data, callback) {
        // method is "push" (FIFO tail) or "unshift" (priority front) — see the queue object below.
        pending[method]({ data, callback });
        pump();
    }

    function pump() {
        // Guard against reentry: a synchronous worker callback runs pump() again, which would
        // let `running` exceed `concurrency`. Skip when an outer pump loop is already active.
        if (pumping) return;
        pumping = true;
        while (running < concurrency && pending.length) {
            const task = pending.shift();
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
        push(data, callback) { enqueue("push", data, callback); },
        unshift(data, callback) { enqueue("unshift", data, callback); },
        oldest() { return pending.length ? pending[pending.length - 1] : null; },
        tail() { return pending.length ? pending[pending.length - 1] : null; },
        remove(predicate) {
            for (let index = pending.length - 1; index >= 0; --index) if (predicate(pending[index])) pending.splice(index, 1);
        },
        length() { return pending.length; },
        running() { return running; }
    };
}

function findSeries(items, iteratee, done) {
    (function next(index) {
        if (index >= items.length) return done(null);
        iteratee(items[index], function onResult(result) {
            if (result) return done(result);
            return next(index + 1);
        });
    }(0));
}

module.exports = { createTaskQueue, findSeries };
