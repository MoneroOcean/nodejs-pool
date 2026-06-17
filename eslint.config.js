"use strict";
const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  {
    ignores: [
      "node_modules/**",
      // Downloaded third-party miner code pulled in by live tests (gitignored).
      ".cache/**",
      // Generated local test outputs (gitignored).
      "test-artifacts/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" }],
      // Allow the codebase's deliberate best-effort "try { cleanup } catch (_e) {}" pattern.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The codebase uses obj.hasOwnProperty(...) on plain config/cache objects throughout.
      "no-prototype-builtins": "off",
      // Existing regex/string literals (email validation, escaped quotes in test fixtures)
      // intentionally carry these escapes; rewriting them risks changing matching behavior.
      "no-useless-escape": "off",
      // Email-body assertion regexes match exact runtime formatting with literal runs of spaces.
      "no-regex-spaces": "off",
      // ANSI escape-stripping regex intentionally matches a terminal control character.
      "no-control-regex": "off",
      // Helper scripts use defensive "x || 0" / "n || default" guards that are statically constant.
      "no-constant-binary-expression": "off"
    }
  }
];
