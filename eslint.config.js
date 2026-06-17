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
      // Intentionally-empty best-effort cleanup catch blocks now carry an explanatory
      // comment, so the rule is fully strict (no allowEmptyCatch).
      "no-empty": "error",
      // hasOwnProperty calls were rewritten to Object.hasOwn / Object.prototype.hasOwnProperty.call.
      "no-prototype-builtins": "error",
      // Useless escapes were removed where provably behavior-preserving.
      "no-useless-escape": "error",
      // Literal multi-space regex runs were rewritten with explicit { N } quantifiers.
      "no-regex-spaces": "error",
      // The one intentional ANSI control-char regex carries a scoped inline disable.
      "no-control-regex": "error",
      // Statically-constant binary expressions were simplified to their constant value.
      "no-constant-binary-expression": "error",
      // Stricter rule set enabled below; merged behavior-preservingly.
      "no-throw-literal": "error",
      "default-case-last": "error",
      "no-unused-expressions": "error",
      "no-var": "error",
      "no-else-return": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "always", { "null": "ignore" }],
      "no-implicit-coercion": "error",
      "object-shorthand": "error",
      "prefer-template": "error",
      "no-shadow": "error",
      "no-param-reassign": "error"
    }
  }
];
