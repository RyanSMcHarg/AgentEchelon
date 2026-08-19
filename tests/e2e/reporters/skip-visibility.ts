/**
 * A skipped test is not a passing test, and this run must say so out loud.
 *
 * THE PROBLEM. Most of this suite is gated on a provisioned test user:
 *
 *     const user = await getBasicUser();
 *     if (!user.password) { test.skip(); return; }
 *
 * That is correct for a portable suite - a deployment without demo users cannot drive a sign-in - but
 * it means a run with no credentials silently no-ops a large fraction of the suite and still exits 0
 * and prints green. Every coverage claim then rests on something nobody checked. The repo has been
 * bitten by this exact shape repeatedly: a guard asserting against a progress placeholder that always
 * passed, an alarm that could never fire, a spy that intercepted nothing. "Green having checked
 * nothing" is the failure mode, not a specific bug.
 *
 * WHAT THIS DOES. It reports, at the end of every run, exactly which tests skipped and why, grouped by
 * spec file - so a sparse run is VISIBLE rather than silent. And it fails the run in the two cases
 * where the result is not trustworthy:
 *
 *   1. ALWAYS, when the run reported skips and NOTHING passed. A run that checked nothing must never
 *      exit 0; there is no configuration in which that is a useful green.
 *   2. When `E2E_REQUIRE_ALL=1`, on any skip at all. This is the mode for a release gate or a
 *      post-deploy validation, where "we could not run 22 of these" is the answer that matters.
 *
 * A skip with no stated reason is called out separately. `test.skip(cond, 'why')` records the reason;
 * a bare `test.skip()` records nothing, so the report can only say the test opted out - which is worth
 * seeing, because it is an invitation to state the condition.
 */
import type {
  Reporter,
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

interface SkipRecord {
  file: string;
  title: string;
  reason: string;
  /**
   * `gated` - the test opted itself out (a `test.skip(...)` that ran).
   * `did-not-run` - the test never started, because an earlier failure in its `describe.serial`
   *   block aborted the rest, or the run was interrupted.
   *
   * Playwright reports BOTH as `status: 'skipped'`, and conflating them is actively misleading: a
   * serial-block casualty was reported here as "no reason recorded - a bare test.skip()", which
   * sends the reader looking for a gate that does not exist instead of at the failure that
   * actually stopped the run. The discriminator is the `skip` annotation - every form of
   * `test.skip()` records one, and a test that never started records none.
   */
  kind: 'gated' | 'did-not-run';
}

/** Reason text used when a `test.skip()` opted out without saying why. */
const NO_REASON = '(no reason recorded - a test.skip() with no description)';

/** Reason text for a test that never started. */
const NEVER_STARTED =
  'did not run - an earlier failure in its describe.serial block, or an interrupted run';

export default class SkipVisibilityReporter implements Reporter {
  private skipped: SkipRecord[] = [];
  private passed = 0;
  private failed = 0;
  private flaky = 0;
  private rootDir = '';

  onBegin(config: FullConfig, _suite: Suite): void {
    this.rootDir = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // `outcome()` folds retries; `result.status` is this attempt. Skips never retry, so reading the
    // per-result status is exact for them, and the pass/fail tallies below are for context only.
    if (result.status === 'skipped') {
      const annotation = test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme');
      const gated = annotation !== undefined;
      this.skipped.push({
        file: this.relative(test.location.file),
        title: test.titlePath().filter(Boolean).slice(1).join(' > ') || test.title,
        reason: gated ? (annotation!.description?.trim() || NO_REASON) : NEVER_STARTED,
        kind: gated ? 'gated' : 'did-not-run',
      });
      return;
    }
    const outcome = test.outcome();
    if (outcome === 'expected') this.passed++;
    else if (outcome === 'flaky') this.flaky++;
    else if (outcome === 'unexpected') this.failed++;
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    const requireAll = process.env.E2E_REQUIRE_ALL === '1';
    this.print(requireAll);

    if (this.skipped.length === 0) return;

    // Case 1: nothing ran. Unconditional - there is no mode in which this is a useful green.
    if (this.passed === 0 && this.failed === 0) {
      console.log(
        '\n[skip-visibility] FAILING THE RUN: every reported test SKIPPED and nothing executed.\n'
        + '                  This run verified nothing. It is almost always missing credentials -\n'
        + '                  check AWS_PROFILE and the test-credentials secret, then re-run.',
      );
      return { status: 'failed' };
    }

    // Case 2: opted in to strictness. A release gate wants "we could not run these" to be a
    // failure. Only GATED skips count: a test that never started is downstream of a failure that
    // already fails the run, and failing again for it would point the reader at provisioning.
    const gatedCount = this.skipped.filter((s) => s.kind === 'gated').length;
    if (requireAll && gatedCount > 0) {
      console.log(
        `\n[skip-visibility] FAILING THE RUN: E2E_REQUIRE_ALL=1 and ${gatedCount} test(s) opted out.\n`
        + '                  Provision what they need, or drop E2E_REQUIRE_ALL for an exploratory run.',
      );
      return { status: 'failed' };
    }

    // Not failing, but never silent.
    console.log(
      `\n[skip-visibility] ${this.skipped.length} test(s) did NOT run. The result above is a pass over\n`
      + '                  what executed, NOT over the suite. Re-run with E2E_REQUIRE_ALL=1 to make\n'
      + '                  an unrunnable test a failure.',
    );
    void result;
  }

  private print(requireAll: boolean): void {
    const total = this.passed + this.failed + this.flaky + this.skipped.length;
    const gated = this.skipped.filter((s) => s.kind === 'gated');
    const neverRan = this.skipped.filter((s) => s.kind === 'did-not-run');
    console.log('\n[skip-visibility] ============ WHAT THIS RUN ACTUALLY CHECKED ============');
    console.log(`    executed : ${this.passed} passed, ${this.failed} failed, ${this.flaky} flaky`);
    console.log(`    gated    : ${gated.length} of ${total} opted out (a test.skip condition)`);
    console.log(`    not run  : ${neverRan.length} of ${total} never started`);
    console.log(`    mode     : ${requireAll ? 'E2E_REQUIRE_ALL=1 (a gated skip fails the run)' : 'default (skips reported, not fatal)'}`);

    if (neverRan.length) {
      // Distinct from a gate, and the distinction matters: these are downstream of a FAILURE, so
      // the fix is the failure, not provisioning.
      console.log(
        `\n    ${neverRan.length} test(s) never started - an earlier failure in a describe.serial`,
      );
      console.log('    block aborts the rest of that block. Fix the failure above and re-run;');
      console.log('    these are not credential gates and provisioning will not change them.');
    }

    if (this.skipped.length) {
      const byFile = new Map<string, SkipRecord[]>();
      for (const s of this.skipped) {
        const list = byFile.get(s.file) ?? [];
        list.push(s);
        byFile.set(s.file, list);
      }
      console.log('\n    NOT RUN:');
      for (const file of Array.from(byFile.keys()).sort()) {
        const records = byFile.get(file)!;
        console.log(`      ${file}  (${records.length})`);
        // Collapse identical reasons: 5 tests skipped for one missing user is one fact, not five.
        const byReason = new Map<string, number>();
        for (const r of records) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
        for (const [reason, count] of byReason) {
          console.log(`          ${count} x  ${reason}`);
        }
      }
      const unexplained = this.skipped.filter((s) => s.reason === NO_REASON).length;
      if (unexplained) {
        console.log(
          `\n    ${unexplained} skip(s) recorded NO reason. Prefer test.skip(condition, 'why') over a bare`,
        );
        console.log('    test.skip() so this report can say what was missing.');
      }
    }
    console.log('[skip-visibility] ========================================================');
  }

  /** The `skip` annotation Playwright records for `test.skip(condition, 'reason')`. */
  private reasonFor(test: TestCase): string {
    const annotation = test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme');
    const described = annotation?.description?.trim();
    return described ? described : NO_REASON;
  }

  private relative(file: string): string {
    if (!this.rootDir) return file;
    const rel = file.startsWith(this.rootDir) ? file.slice(this.rootDir.length) : file;
    return rel.replace(/^[\\/]/, '').replace(/\\/g, '/');
  }
}
