// ESLint flat config. Only rules that catch a real defect are enabled; style is
// left to the formatter, because a style violation that merely disagrees with a
// reviewer's taste is noise in a repository this size.
//
// The rules below were chosen from failures this project has actually shipped:
// a floating promise inside the login poller kept the process alive, and a
// comparison between a number and a string silently never matched.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // ── Correctness ──────────────────────────────────────────────────────
      // Dead imports and unused bindings are warnings, not errors: AGENTS.md §1
      // says unrelated dead code is *pointed out, not deleted*, so the gate must
      // not force a cleanup into an unrelated change.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-undef': 'off', // TypeScript already resolves identifiers
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-async-promise-executor': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-useless-assignment': 'error',

      // ── Node specifics ───────────────────────────────────────────────────
      'no-process-exit': 'off', // cli.ts owns the exit codes by design
      'no-console': 'off', // the stdout/stderr split is a documented contract

      // ── Deliberately off ─────────────────────────────────────────────────
      // `new Promise(resolve => setTimeout(resolve, ms))` is the idiomatic sleep
      // here; the rule would flag it for returning the timer handle.
      'no-promise-executor-return': 'off',
      // Terminal control characters appear in regexes on purpose: ANSI escapes
      // have to be measured and stripped to compute display width.
      'no-control-regex': 'off',
      // Zero third-party dependencies is enforced structurally by
      // scripts/check-modules.ts, not by a lint rule.
      'no-restricted-imports': ['off'],
      // `require-atomic-updates` has an acknowledged false positive on guarded
      // module-level caches (`if (...) return; cache = ...`), which is exactly
      // how the capability cache and credential store are written.
      'require-atomic-updates': 'off',
      // The bridge receives untyped JSON from four different upstreams; `any`
      // at those boundaries is deliberate, and the boundary types are narrowed
      // immediately. Banning it outright would push the same casts into `unknown`
      // gymnastics without adding safety.
      '@typescript-eslint/no-explicit-any': 'off',
      // Declarations and their JSDoc are load-bearing for readers.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Tests take over stdin and drive the terminal; they still must not write
    // outside their scratch directory, which test/platform.ts guards.
    files: ['test/**/*.ts'],
  },
]
