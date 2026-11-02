const path = require('path');

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // The assistant session, the person resolver, email consent and account state in memory for every suite;
  // see each file for why and which suites test it for real.
  setupFiles: ['<rootDir>/test/setup/assistant-session.ts', '<rootDir>/test/setup/person-resolver.ts', '<rootDir>/test/setup/email-consent.ts', '<rootDir>/test/setup/account-state.ts'],
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
  // files; without a limit a long-lived worker's heap grows unbounded over an
  // 80-file run. Recycling caps peak RSS at a predictable level.
  workerIdleMemoryLimit: '768MB',
  // ── THE TRANSFORM CACHE IS ON, AND PINNED SOMEWHERE THAT SURVIVES BETWEEN RUNS ──────────────
  //
  // It used to be off, and the reason was real. Several suites reset the module registry per test
  // (jest.resetModules()) and re-`await import(...)` the module under test, which forces ts-jest
  // to re-transform it constantly. Under concurrent workers that churn raced the shared on-disk
  // cache: a module occasionally re-imported in a partial state, so a mocked client returned the
  // wrong row and the assertion failed — a load-dependent flake with no product cause.
  //
  // THE COST OF THAT FIX WAS NOT SMALL, and it was never measured until it started costing runs.
  // Measured on this repo: 4 files, 34.9s cold against 12.2s warm; a 25-file slice, 153s against
  // 80s, with identical results and no flake across repeats. So roughly half the wall clock of
  // every run was recompiling what the previous run had already compiled.
  //
  // That half is the difference between a suite that can be run here and one that cannot. The
  // full suite takes ~45 minutes, a run that outlives a tool call is moved to the background, and
  // a backgrounded run on this machine gets killed — losing every result it had produced. Halving
  // the clock is what lets a shard finish inside the window it is given.
  //
  // PINNED under node_modules/.cache rather than jest's default, which lives in the OS temp
  // directory and is swept: the whole win is on the SECOND run, so a cache that does not survive
  // to it is not a cache.
  //
  // IF THE PARTIAL-IMPORT FLAKE COMES BACK, set AE_JEST_NO_CACHE=1 to restore the old behaviour at
  // once, and record what you saw. A flake that returns is evidence for the deeper fix rather than
  // a reason to pay this cost forever, and the deeper fix is unchanged: retire the per-test
  // resetModules+import pattern so nothing recompiles mid-run.
  cache: process.env.AE_JEST_NO_CACHE !== '1',
  cacheDirectory: path.join(__dirname, 'node_modules', '.cache', 'ae-jest'),
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
