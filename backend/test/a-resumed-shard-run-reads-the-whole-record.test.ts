/**
 * A SHARD RUN'S VERDICT IS THE ACCUMULATED RECORD'S, NOT THE INVOCATION'S.
 *
 * Observed verbatim from `node scripts/run-test-shards.mjs --shards=12 --only=6`:
 *
 *   shard 11/12: FAIL - 30 suites, 340 tests, 1 failed, 0 skipped
 *   TOTAL: 370 suites, 4930 tests, 1 failed, 0 skipped
 *   All shards passed.
 *
 * The TOTAL was summed from every report on disk; the last line was decided from the one shard this
 * invocation ran. The last line is the one a reader acts on. The runner now takes its verdict from
 * `scripts/lib/shard-verdict.cjs` over the same reports the TOTAL reads, and this pins that function
 * without starting a suite.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shardVerdict, shardFailed } = require('../scripts/lib/shard-verdict.cjs');

const green = (tests = 10, skipped = 0) => ({ suites: 2, tests, failed: 0, failedSuites: 0, success: true, skipped });
const red = () => ({ suites: 2, tests: 10, failed: 1, failedSuites: 1, success: false, skipped: 0 });
const all = (n: number, make = () => green()) => Array.from({ length: n }, (_, k) => ({ shard: k + 1, counts: make() }));

describe('the verdict reads the whole record', () => {
  it('is NOT proven when this run passed but an earlier run left a failed shard on disk (the observed case)', () => {
    const found = all(12);
    found[10] = { shard: 11, counts: red() };

    const v = shardVerdict(12, found);

    expect(v.proven).toBe(false);
    expect(v.failed).toEqual([11]);
    expect(v.line).toContain('11/12');
    expect(v.line).toContain('NOT proven');
    expect(v.line).not.toContain('All shards passed');
  });

  it('is NOT proven when a shard has no report', () => {
    const v = shardVerdict(4, all(4).filter((r) => r.shard !== 3));

    expect(v.proven).toBe(false);
    expect(v.missing).toEqual([3]);
    expect(v.line).toContain('INCOMPLETE');
  });

  it('names both a failure and a gap when the record holds both', () => {
    const found = all(4).filter((r) => r.shard !== 4);
    found[0] = { shard: 1, counts: red() };

    const v = shardVerdict(4, found);

    expect(v.failed).toEqual([1]);
    expect(v.missing).toEqual([4]);
    expect(v.line).toMatch(/FAILED.*INCOMPLETE.*NOT proven/);
  });

  it('is proven only when every shard is present and none failed', () => {
    const v = shardVerdict(4, all(4));
    expect(v).toMatchObject({ proven: true, failed: [], missing: [], line: 'All shards passed.' });
  });

  /**
   * THE THIRD WAY THE GREEN LINE LIED, observed 2026-09-15.
   *
   * `--only=1` against a tree that had been edited all afternoon printed "All shards passed." over
   * eleven reports written four hours earlier. Every shard was present and none recorded a failure,
   * so the two existing rules were both satisfied and the verdict was still wrong: those reports
   * described a tree that no longer existed.
   */
  describe('a report older than the code it claims to prove', () => {
    const at = (n: number, ms: number) => ({ shard: n, counts: green(), at: ms });
    const SOURCE_CHANGED = 5_000;

    it('is NOT proven when reports predate the newest source change (the observed case)', () => {
      const found = [at(1, 9_000), at(2, 1_000), at(3, 1_000), at(4, 1_000)];

      const v = shardVerdict(4, found, { sourceChangedAt: SOURCE_CHANGED });

      expect(v.proven).toBe(false);
      expect(v.stale).toEqual([2, 3, 4]);
      expect(v.line).toContain('STALE');
      expect(v.line).toContain('NOT proven');
      expect(v.line).not.toContain('All shards passed');
    });

    it('is proven when every report postdates the change, so the rule is not vacuous', () => {
      const found = [at(1, 9_000), at(2, 9_000), at(3, 9_000), at(4, 9_000)];

      const v = shardVerdict(4, found, { sourceChangedAt: SOURCE_CHANGED });

      expect(v).toMatchObject({ proven: true, stale: [], line: 'All shards passed.' });
    });

    it('reports a failing shard as FAILED rather than STALE, because that is the actionable fact', () => {
      const found = [{ shard: 1, counts: red(), at: 1_000 }, at(2, 9_000), at(3, 9_000), at(4, 9_000)];

      const v = shardVerdict(4, found, { sourceChangedAt: SOURCE_CHANGED });

      expect(v.failed).toEqual([1]);
      expect(v.stale).toEqual([]);
    });

    it('never calls a report stale when nothing measured when it was written', () => {
      // An unreadable mtime must not be guessed at. A guard that invents evidence is worse than one
      // that admits it has none.
      const v = shardVerdict(4, all(4), { sourceChangedAt: SOURCE_CHANGED });

      expect(v).toMatchObject({ proven: true, stale: [] });
    });

    it('leaves every existing caller alone when no source time is supplied', () => {
      const found = [at(1, 1_000), at(2, 1_000), at(3, 1_000), at(4, 1_000)];

      const v = shardVerdict(4, found);

      expect(v).toMatchObject({ proven: true, stale: [], line: 'All shards passed.' });
    });
  });

  it('says a skip is not a pass, while still proven', () => {
    const v = shardVerdict(2, all(2, () => green(10, 3)));
    expect(v.proven).toBe(true);
    expect(v.skipped).toBe(6);
    expect(v.line).toContain('A skip is not a pass');
  });

  it('ignores reports from outside the recorded split rather than counting them', () => {
    // A stale shard-9 report beside a 4-shard record is not evidence about the 4-shard run.
    const v = shardVerdict(4, [...all(4), { shard: 9, counts: red() }]);
    expect(v.proven).toBe(true);
  });
});

describe('what counts as a failed shard', () => {
  it('a suite that failed to run fails the shard even with zero failed tests', () => {
    // A compile error or a module-scope throw reports numFailedTests: 0.
    expect(shardFailed({ suites: 3, tests: 0, failed: 0, failedSuites: 1, success: false, skipped: 0 })).toBe(true);
  });

  it('jest reporting success: false fails the shard on its own', () => {
    expect(shardFailed({ suites: 3, tests: 5, failed: 0, failedSuites: 0, success: false, skipped: 0 })).toBe(true);
  });

  /**
   * A DOCUMENTATION EDIT IS NOT A CODE EDIT, and treating it as one charged a full re-run for a typo.
   *
   * Documentation belongs under the staleness rule at all because a few suites genuinely read it:
   * they check that a document's code citations resolve and that its cited line numbers fall inside
   * the files they name. Those can go red when a markdown file changes and nothing else does.
   *
   * But the rule was unscoped, so correcting ONE citation in a design record marked all twelve shards
   * stale and asked for roughly twenty-five minutes of re-running to re-prove work the edit could not
   * have touched. Observed 2026-09-17, twice in one session.
   */
  describe('a documentation change reaches only the shards that read documentation', () => {
    const at = (n: number, ms: number) => ({ shard: n, counts: green(), at: ms });
    const CODE_CHANGED = 1_000;
    const DOCS_CHANGED = 8_000;
    // Every report is newer than the code change and older than the docs change, so the docs rule is
    // the only thing that can mark any of them stale.
    const found = [at(1, 5_000), at(2, 5_000), at(3, 5_000), at(4, 5_000)];

    it('marks ONLY the doc-reading shards stale', () => {
      const v = shardVerdict(4, found, {
        sourceChangedAt: CODE_CHANGED, docsChangedAt: DOCS_CHANGED, docsReadingShards: [3],
      });

      expect(v.stale).toEqual([3]);
      expect(v.proven).toBe(false);
    });

    it('proves the suite when a docs edit touches no doc-reading shard', () => {
      // The case the old rule got wrong: nothing that ran can be affected, so the record still stands.
      const v = shardVerdict(4, found, {
        sourceChangedAt: CODE_CHANGED, docsChangedAt: DOCS_CHANGED, docsReadingShards: [],
      });

      expect(v.stale).toEqual([]);
      expect(v.proven).toBe(true);
    });

    it('still marks EVERY shard stale for a CODE change, doc-reading or not', () => {
      // The scoping must not weaken the original rule, which is the one that caught a green line
      // standing over reports four hours older than the tree.
      const v = shardVerdict(4, found, {
        sourceChangedAt: 9_000, docsChangedAt: DOCS_CHANGED, docsReadingShards: [3],
      });

      expect(v.stale).toEqual([1, 2, 3, 4]);
      expect(v.proven).toBe(false);
    });

    it('takes the LATER of the two for a doc-reading shard', () => {
      // A shard that reads docs is answerable to both, so neither change may be allowed to mask the
      // other by being the one the comparison happens to use.
      const older = [at(1, 2_000), at(2, 2_000), at(3, 2_000), at(4, 2_000)];
      const docsLater = shardVerdict(4, older, {
        sourceChangedAt: 1_500, docsChangedAt: 3_000, docsReadingShards: [3],
      });
      expect(docsLater.stale).toEqual([3]);

      const codeLater = shardVerdict(4, older, {
        sourceChangedAt: 3_000, docsChangedAt: 1_500, docsReadingShards: [3],
      });
      expect(codeLater.stale).toEqual([1, 2, 3, 4]);
    });

    it('keeps the old behavior when no docs measurement is supplied', () => {
      // Every existing caller passes `sourceChangedAt` alone, and must be unaffected.
      const v = shardVerdict(4, found, { sourceChangedAt: CODE_CHANGED });
      expect(v.stale).toEqual([]);
      expect(v.proven).toBe(true);
    });
  });

  it('a report from before these fields existed is judged on failed tests', () => {
    expect(shardFailed({ suites: 3, tests: 5, failed: 0, skipped: 0 })).toBe(false);
    expect(shardFailed({ suites: 3, tests: 5, failed: 2, skipped: 0 })).toBe(true);
  });
});
