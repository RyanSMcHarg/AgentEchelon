module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Keep the default `npm test` skip-free. The live image-gen suite hits PAID
  // external providers (OpenAI, FAL) and is opt-in via RUN_LIVE_IMAGE_GEN=1 — so
  // rather than collect-then-skip it (which reports a skip on every run), don't
  // collect it at all unless that env is set. Run it during deploy validation:
  //   RUN_LIVE_IMAGE_GEN=1 IMAGE_GEN_KEYS_SECRET_ARN=... npx jest image-gen-live
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(process.env.RUN_LIVE_IMAGE_GEN === '1' ? [] : ['/image-gen-live\\.test\\.ts$']),
  ],
  // Guardrail against melting the machine. Jest defaults to (cores - 1) workers —
  // on a 16-core box that is 15 ts-jest workers each holding a full in-memory TS
  // program, and with `cache: false` (below) every one of them recompiles from
  // scratch. The combined CPU + RAM spike has hard-locked dev machines. Cap the
  // pool to a modest, fixed size so the suite stays responsive; override for CI or
  // a beefier box with JEST_MAX_WORKERS (e.g. JEST_MAX_WORKERS=8 or =75%).
  maxWorkers: process.env.JEST_MAX_WORKERS || 4,
  // Restart a worker once it balloons past this after a test file finishes. The
  // resetModules()+re-import() suites accrete transformed-module state across
  // files; without a ceiling a long-lived worker's heap grows unbounded over an
  // 80-file run. Recycling caps peak RSS at a predictable level.
  workerIdleMemoryLimit: '768MB',
  // Several suites reset the module registry per test (jest.resetModules()) and
  // re-`await import(...)` the module under test, which forces ts-jest to
  // re-transform it constantly. Under concurrent workers that churn races on the
  // shared on-disk transform cache: a module occasionally re-imports in a partial
  // state, so a mocked client returns the wrong row and the assertion fails — a
  // load-dependent flake with no product cause (every affected suite passes in
  // isolation). Disabling the transform cache removes the raced shared resource and
  // makes the suite deterministic. Cost is a modest per-run recompile; the reliable
  // gate is worth it. (A deeper fix — retiring the per-test resetModules+import
  // pattern so nothing recompiles mid-run — is the real long-term cleanup.)
  cache: false,
  // Several suites (e.g. battle-state) call jest.resetModules() in beforeEach and
  // then `await import(...)` the module under test per case, so ts-jest recompiles
  // it every test. Under full-suite load that recompile can exceed the 5s default
  // and fail spuriously (mockSend never called → calls[0] undefined). 20s gives it
  // headroom; a genuinely hung test still fails well within CI limits.
  testTimeout: 20000,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: {
        ignoreCodes: [2307, 151002],
      },
    }],
  },
  // .ts wins over committed .js artifacts; tests should always read fresh
  // source, never a stale compile output. Without this the resolver picks
  // analytics-query.js (a committed build artifact) instead of .ts and
  // any test that imports a new export fails confusingly.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
