/**
 * THE E2E SUITE'S `test`, WATCHED. Every spec imports `test` and `expect` from here rather than from
 * `@playwright/test`, and gets three listeners with no further call:
 *
 *  - OPERATOR ALERTS. The run subscribes to the admin notification channel as the e2e admin, the channel every
 *    `ae.alert` is posted to and emailed from. An alarm going into ALARM, or any other operator notice, fails
 *    the test running when it arrives, with the alarm's name, reason and time.
 *  - BACKEND ERRORS, LIVE. CloudWatch Logs Live Tail over the turn path's log groups; an error line fails the
 *    running test as it arrives, with the line, its request id and its log group. `guardBackendErrors` stays
 *    as the per-file backstop.
 *  - STALLS. A test that sees no progress for its stall window (120s unless it says otherwise) fails with
 *    when each side was last heard from. Progress is the page's own events (responses, WebSocket frames, DOM
 *    changes, console output), any backend log line naming one of the test's conversations, a message on a
 *    runner-side messaging session, and a helper read whose answer changed.
 *
 * What a spec declares, inside the test that needs it:
 *
 *  - `expectAlarm('…-context-source-failure-rate')`: an alarm (or notice type) the spec trips on purpose.
 *    It holds for the rest of the run, since an alarm evaluates minutes after the test that caused it.
 *  - `allowBackendError(/pattern/)`: an error line this test causes on purpose.
 *  - `declareWait('the invitation deadline', dueAt)`: the test waits on a timer, so silence until `dueAt` plus
 *    a margin is expected rather than a stall.
 *  - `test.use({ stallWindowMs })`: a wider window for a step with no event at all.
 *
 * See docs/guides/developer/E2E-WATCHDOG.md.
 */
import { test as base, expect } from '@playwright/test';
import { currentWatch, declaredBackendErrors, trackConversation, noteProgress } from './watchdog/current';
import { DEFAULT_STALL_WINDOW_MS, toPattern } from './watchdog/logic';
import { RunWatch, watchdogEnabled } from './watchdog/run-watch';

export { expect, trackConversation, noteProgress };

interface WatchedTestFixtures {
  /** How long the test may go with no progress signal. */
  stallWindowMs: number;
  /** The watch itself, auto-started for every test. */
  watchdog: void;
}

interface WatchedWorkerFixtures {
  runWatch: RunWatch;
}

let run: RunWatch | null = null;

export const test = base.extend<WatchedTestFixtures, WatchedWorkerFixtures>({
  stallWindowMs: [Number(process.env.E2E_STALL_WINDOW_MS) || DEFAULT_STALL_WINDOW_MS, { option: true }],

  runWatch: [async ({}, use, workerInfo) => {
    const watch = new RunWatch(workerInfo);
    run = watch;
    await watch.start();
    await use(watch);
    run = null;
    const unattributed = await watch.stop();
    if (unattributed.length) {
      throw new Error(
        `[watchdog] ${unattributed.length} finding(s) arrived with no test running to fail:\n`
        + unattributed.map((f, i) => `  ${i + 1}. ${f}`).join('\n'),
      );
    }
  }, { scope: 'worker', auto: true, timeout: 180_000 }],

  watchdog: [async ({ runWatch, stallWindowMs }, use, testInfo) => {
    if (!watchdogEnabled()) {
      await use();
      return;
    }
    const w = runWatch.beginTest(testInfo, stallWindowMs);
    try {
      await use();
    } finally {
      const finding = await w.finish();
      runWatch.endTest(w);
      if (finding) throw new Error(`[watchdog] ${finding}`);
    }
  }, { auto: true }],

  // Every context a test uses reports its page events: the built-in one here, and any a spec builds itself
  // through `browser.newContext` below.
  context: async ({ context, runWatch }, use) => {
    if (watchdogEnabled()) await runWatch.attachContext(context);
    await use(context);
  },

  browser: [async ({ browser, runWatch }, use) => {
    if (watchdogEnabled()) {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args: Parameters<typeof browser.newContext>) => {
        const c = await newContext(...args);
        await runWatch.attachContext(c);
        return c;
      };
    }
    await use(browser);
  }, { scope: 'worker' }],
});

function requireWatch(what: string) {
  const w = currentWatch();
  if (!w && watchdogEnabled()) throw new Error(`${what} is declared inside a test, where the watchdog is watching`);
  return w;
}

/**
 * An alarm (by name) or an operator notice (by message type) this spec trips on purpose. Holds for the rest of
 * the run, because an alarm evaluates on its own period and may go into ALARM after the test that caused it.
 */
export function expectAlarm(nameOrType: string | RegExp): void {
  requireWatch('expectAlarm');
  run?.expectAlert(toPattern(nameOrType), base.info().titlePath.slice(1).join(' > '));
}

/** A backend error line this test causes on purpose: not a failure live, nor in the file's sweep. */
export function allowBackendError(pattern: string | RegExp): void {
  const p = toPattern(pattern);
  requireWatch('allowBackendError')?.allowBackendError(p);
  declaredBackendErrors.push(p);
}

/**
 * The test now waits on a timer due at `dueAt` (epoch ms): silence is expected until then plus a margin, and
 * the stall detector resumes after it.
 */
export function declareWait(reason: string, dueAt: number): void {
  requireWatch('declareWait')?.declareWait(reason, dueAt);
}
