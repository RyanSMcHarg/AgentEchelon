// ESLint v9 flat config. Replaces the missing .eslintrc that CI's `npm
// run lint` expects. Baseline rules only — no aggressive style enforcement,
// since this project has been built without an active linter and we don't
// want to turn the lint job into a source of churn. The intent is "catch
// real bugs, don't bikeshed".
//
// If you want stricter rules later, add them to the `rules` block below
// or introduce a per-directory override.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**', '**/*.config.js', '**/*.config.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks v7 ships several React Compiler preview rules
      // (set-state-in-effect, refs, immutability, purity, error-boundaries)
      // that are stylistic / forward-looking, not bug detectors. The
      // codebase uses these patterns intentionally — refs for cross-render
      // state, derived UI state from effects, etc. Off until we adopt
      // the React Compiler proper.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The codebase uses `any` deliberately in several places (Cognito JWT
      // claims shape, Chime SDK observer payloads, error narrowing). Turn
      // off the strict rule rather than litter `eslint-disable`s.
      '@typescript-eslint/no-explicit-any': 'off',
      // Throwaway args + intentional placeholders are pervasive in the
      // existing code; warn rather than error so the lint job stays useful
      // without blocking on cosmetic noise.
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Empty catch blocks are common in defensive code (tracking, optional
      // features). Allow with a comment-only exception.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Node build scripts (e.g. scripts/*.mjs) run under Node, not the browser.
  {
    files: ['**/*.{mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // Test files lean on globals from vitest; loosen unused-vars and any-types.
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, vi: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
