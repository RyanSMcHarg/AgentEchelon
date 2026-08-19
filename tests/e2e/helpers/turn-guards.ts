/**
 * Per-test guards that watch the parts of the system the assertions do not.
 *
 * An e2e test asserts what the user SEES. That leaves two blind spots, and both have hidden real
 * defects in this project:
 *
 *  - the SERVER. A handler can fail on every single turn and the UI still look right, because the
 *    code falls back. The classification handler was denied `ssm:GetParameter` on its own
 *    `processor-arn` on every request for an unknown period; it logged an AccessDenied every time,
 *    1700+ unit tests and the whole e2e suite stayed green, and it was found by reading CloudWatch
 *    by hand. Verified: this guard finds 73 error lines in that window, and none in a healthy one.
 *
 *  - the BROWSER CONSOLE. Only 3 of the 10 turn-driving specs checked it, so a React error in the
 *    other 7 was invisible.
 *
 * Installed with one call at the top of a spec's describe block, so the guards cannot be quietly
 * omitted from a new test the way a per-test assertion can.
 */
import { test } from '@playwright/test';
import { assertNoBackendErrors } from './backend-errors';
import { ConsoleMonitor } from './console-monitor';

/**
 * Assert, after each test, that no handler logged an error while it ran.
 *
 * Only asserts when the test PASSED. A test that already failed has its own diagnosis, and throwing
 * a second error from afterEach would bury it; the backend lines are printed instead, since they are
 * often the cause. The value is in the passing case: a green test that hid a server-side failure
 * becomes a red one.
 *
 * `label` names the spec in the failure text so a CI log says which suite, not just which test.
 */
export function guardBackendErrors(label: string): void {
  // Window opens at the first test and covers the whole suite.
  //
  // Checked once per FILE rather than per test, deliberately. The check is a handful of CloudWatch
  // queries; per test it added ~9s to every test including pure-JSON ones that never reach the
  // backend, which would be ~16 minutes across the suite - a coverage gain that makes the suite too
  // slow to run is not a gain. Per file it is a few seconds each.
  //
  // The cost is attribution: a failure names the spec and the window, not the individual test. The
  // log lines carry their own timestamps and correlation ids, so that is a small step to close by
  // hand, and it is worth it to keep the check cheap enough to always be on.
  let windowStart = 0;
  let anyTestRan = false;

  test.beforeEach(() => {
    // A few seconds of lead-in: a turn's first request can reach the handler marginally before the
    // test body starts, and CloudWatch timestamps are the handler's clock, not ours.
    if (!anyTestRan) windowStart = Date.now() - 5_000;
    anyTestRan = true;
  });

  test.afterAll(async () => {
    if (!anyTestRan) return; // whole file skipped - nothing ran, nothing to check
    await assertNoBackendErrors(windowStart, label);
  });
}

/**
 * Assert, after each test, that the browser console stayed clean.
 *
 * The companion to {@link guardBackendErrors}, and installed the same way, for the same reason: an
 * assertion a spec can forget to write is an assertion most specs do forget. A coverage sweep found
 * only 6 of 25 specs checking the console at all, including the sign-in flow (13 tests), the battle
 * surface (16) and the admin dashboard (15) - so a React error, a failed fetch or a hydration
 * mismatch on any of those paths was invisible.
 *
 * Attaches BEFORE navigation (`beforeEach` runs before the test body), which matters: listeners
 * added after `goto` miss everything the initial render logged.
 *
 * Only asserts when the test PASSED, matching the backend guard. A test that already failed has its
 * own diagnosis and a second throw from afterEach would bury it - the captured entries are printed
 * instead, since a console error is frequently the cause of the visible failure.
 */
export function guardConsoleErrors(): void {
  let monitor: ConsoleMonitor | null = null;

  test.beforeEach(({ page }) => {
    monitor = new ConsoleMonitor();
    monitor.attach(page);
    expectedConsoleErrors = [];
  });

  test.afterEach(({}, testInfo) => {
    if (!monitor) return;
    // `monitor.all` (structured entries), NOT `monitor.getErrors()` (pre-formatted strings). The
    // guard reads `.text` / `.severity` / `.url` off each entry, and getErrors() returns
    // `string[]`, so this filter used to throw `Cannot read properties of undefined (reading
    // 'includes')` the moment a test both declared an allowConsoleError and produced a console
    // error - and when no allowance was declared, `.some()` short-circuited before touching the
    // string, so the guard threw a report of `[undefined] undefined` instead of the error text.
    // Either way it has never once reported a console error usefully. `tests/` has no typecheck,
    // so nothing caught the shape mismatch.
    const errors = monitor.all
      .filter((e) => e.severity === 'error' || e.severity === 'pageerror')
      .filter((e) => {
        // Match the URL as well as the text. A browser reports a failed request as the generic
        // "Failed to load resource: the server responded with a status of 400 ()", with the endpoint
        // only in `.url` - so a text-only match forced an allowance to be written as "any 400 in this
        // test", when what a negative-path test actually wants to permit is "a 400 FROM THIS
        // endpoint". Matching both keeps the declaration narrow enough to still catch a 400 from
        // somewhere unexpected in the same test.
        const haystack = e.url ? `${e.text} ${e.url}` : e.text;
        return !expectedConsoleErrors.some((p) => (typeof p === 'string' ? haystack.includes(p) : p.test(haystack)));
      });
    if (!errors.length) return;

    if (testInfo.status !== testInfo.expectedStatus) {
      // Already failing: print, do not throw over the top of the real diagnosis.
      console.log(`[console-guard] ${errors.length} console error(s) during a FAILING test:`);
      for (const e of errors.slice(0, 10)) console.log(`  [${e.severity}] ${e.text.slice(0, 300)}`);
      return;
    }
    throw new Error(
      `${errors.length} unexpected console error(s):\n`
      + errors.map((e, i) => `  ${i + 1}. [${e.severity}] ${e.text}${e.url ? ` [${e.url}]` : ''}`).join('\n')
      + '\n\nIf a test causes one DELIBERATELY (a negative-path case), declare it with '
      + 'allowConsoleError(...) inside that test rather than weakening the guard for everyone.',
    );
  });
}

/** Patterns the CURRENT test expects to see. Reset per test by {@link guardConsoleErrors}. */
let expectedConsoleErrors: Array<string | RegExp> = [];

/**
 * Declare a console error this test causes ON PURPOSE.
 *
 * Negative-path tests legitimately produce console errors: "reject invalid credentials" submits bad
 * credentials, Cognito answers 400, and the browser logs a failed resource load. That is the test
 * working, not the app failing.
 *
 * Scoped to the single test that declares it, deliberately. The alternative - adding "400" to the
 * monitor's global ignore list - would blind every other spec to real failed requests, which is
 * precisely how the console monitor came to be ignoring genuine React defects before.
 */
export function allowConsoleError(pattern: string | RegExp): void {
  expectedConsoleErrors.push(pattern);
}
