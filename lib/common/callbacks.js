"use strict";
function createTaskQueue(concurrency, worker) {
    const pending = [];
    let running = 0;

    function enqueue(method, data, callback) {
        pending[method]({ data, callback });
        pump();
    }

    function pump() {
        while (running < concurrency && pending.length) {
            const task = pending.shift();
            running += 1;
            worker(task.data, function onDone() {
                running -= 1;
                if (typeof task.callback === "function") task.callback();
                pump();
            });
        }
    }

    return {
        push(data, callback) { enqueue("push", data, callback); },
        unshift(data, callback) { enqueue("unshift", data, callback); },
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
