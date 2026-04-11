"use strict";

const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
};

const buffered = [];
let flushed = false;
const shouldFlushBufferedOutput = process.env.NODE_TEST_FLUSH_BUFFERED_OUTPUT === "1";

function bufferConsole(method) {
    return (...args) => {
        buffered.push({ method, args });
    };
}

console.log = bufferConsole("log");
console.info = bufferConsole("info");
console.warn = bufferConsole("warn");
console.error = bufferConsole("error");

function flushBufferedOutput() {
    if (flushed || buffered.length === 0) return;
    flushed = true;

    originalConsole.error("");
    originalConsole.error("Suppressed debug output:");
    for (const entry of buffered) {
        originalConsole[entry.method](...entry.args);
    }
}

process.on("exit", (code) => {
    if (shouldFlushBufferedOutput && code !== 0) flushBufferedOutput();
});
