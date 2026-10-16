"use strict";
const { Transform } = require("node:stream");
const { spec } = require("node:test/reporters");

// Wraps node:test's `spec` reporter and inserts a blank line before each group
// header (lines starting with "▶ ", the spec reporter's suite marker) for readability.
class SpacedSpecReporter extends Transform {
    constructor() {
        super({ writableObjectMode: true });
        this.pendingText = "";
        this.lastPrintedNonEmptyLine = "";
        this.lastPrintedLineWasBlank = false;
        this.reporter = spec();
        this.reporter.on("data", (chunk) => {
            this.push(this.rewriteText(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)));
        });
        this.reporter.on("error", (error) => {
            this.destroy(error);
        });
    }

    rewriteText(text) {
        this.pendingText += text;
        let output = "";
        let newlineIndex = this.pendingText.indexOf("\n");
        while (newlineIndex !== -1) {
            let line = this.pendingText.slice(0, newlineIndex + 1);
            this.pendingText = this.pendingText.slice(newlineIndex + 1);
            if (/^▶ /.test(line) && this.lastPrintedNonEmptyLine && !this.lastPrintedLineWasBlank) line = `\n${  line}`;
            if (line.trim()) {
                this.lastPrintedNonEmptyLine = line.trimEnd();
                this.lastPrintedLineWasBlank = false;
            } else {
                this.lastPrintedLineWasBlank = true;
            }
            output += line;
            newlineIndex = this.pendingText.indexOf("\n");
        }
        return output;
    }

    _transform(event, encoding, callback) {
        if (process.env.GITHUB_ACTIONS === "true" && event.type === "test:fail" &&
            event.data.details?.error?.failureType !== "subtestsFailed") {
            const error = event.data.details?.error;
            const detail = error?.cause?.stack || error?.stack || String(error);
            const message = `${event.data.name}\n${detail}`
                .replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
            this.push(`::error title=Node.js test failure::${message}\n`);
        }
        if (this.reporter.write(event, encoding)) return callback();
        this.reporter.once("drain", callback);
    }

    _flush(callback) {
        this.reporter.end();
        this.reporter.once("end", () => {
            if (this.pendingText) {
                let output = this.pendingText;
                if (/^▶ /.test(output) && this.lastPrintedNonEmptyLine && !this.lastPrintedLineWasBlank) output = `\n${  output}`;
                this.push(output);
                this.pendingText = "";
            }
            callback();
        });
    }
}

module.exports = SpacedSpecReporter;
