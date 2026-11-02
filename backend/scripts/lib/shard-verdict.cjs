/**
 * The verdict of a sharded test run, computed from the ACCUMULATED RECORD and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE. The runner used to decide its last line from the shards the current
 * invocation happened to run. A resumed `--only=6` whose one shard passed therefore printed
 * "All shards passed." two lines below a summary that listed shard 11 as FAIL and a TOTAL with one
 * failure in it. The TOTAL was right and the verdict was wrong, and the verdict is the line a reader
 * acts on. The missing-shard half of that was fixed first; the failed-shard-from-an-earlier-run half
 * is the same defect, so both now read one input: every shard report on disk.
 *
 * PURE, so it can be tested without starting a suite. The runner reads the reports; this decides.
 *
 * STALENESS IS THE THIRD WAY A GREEN LINE LIES, and it was found the same way as the other two: a
 * `--only=1` against a tree that had changed all afternoon printed "All shards passed." over eleven
 * reports written four hours earlier, before six agents' worth of edits. Every shard was present and
 * none recorded a failure, so both existing rules were satisfied and the verdict was still wrong. A
 * report is evidence about the tree AS IT WAS WHEN THE SHARD RAN; once the source moves under it, it
 * is a historical fact rather than a current one. So a report older than the newest source change is
 * counted as stale, and stale is not proven.
 *
 * Stale is reported SEPARATELY from failed, because the reader's next action differs: a failure is
 * something to debug, staleness is something to re-run. Naming them together would send someone
 * hunting a bug in a shard that never disagreed with anything.
 *
 * NOT A JEST TEST FILE, so jest ignores it.
 */

/**
 * Whether one shard report records a failure.
 *
 * A failed TEST is not the only failure a report can hold. A suite that does not compile, or whose
 * module scope throws, fails with zero failed tests - so a shard judged on `failed` alone reads a
 * broken suite as green. `failedSuites` and jest's own `success` flag are part of the judgment.
 */
function shardFailed(counts) {
  if (!counts) return true;
  return (counts.failed ?? 0) > 0
    || (counts.failedSuites ?? 0) > 0
    || counts.success === false;
}

/**
 * @param {number} shards  how many shards the run on record was split into
 * @param {Array<{ shard: number, counts: object | null, at?: number }>} found  every report on disk.
 *   `at` is when that report was written, epoch ms. Absent means the caller did not measure it, and
 *   an unmeasured report is never called stale: a guard that invents evidence is worse than one that
 *   admits it has none.
 * @param {{ sourceChangedAt?: number, docsChangedAt?: number, docsReadingShards?: number[] }} [opts]
 *   `sourceChangedAt` is when the newest CODE file under test last changed, epoch ms. Absent disables
 *   the staleness rule entirely, so every existing caller keeps its behavior and the rule is opt-in by
 *   supplying a measurement.
 *
 *   `docsChangedAt` and `docsReadingShards` scope the DOCS half of that rule, and they exist because
 *   the unscoped version was wrong in an expensive direction. Documentation lives under the same
 *   staleness umbrella because a handful of suites genuinely read it - they check that a doc's code
 *   citations resolve, and that its line numbers are inside the files they name. But treating a
 *   markdown edit as invalidating EVERY shard charged a full twelve-shard re-run, roughly twenty-five
 *   minutes, for fixing a single citation in a design record. Nothing in shards that never open a
 *   `.md` file can be affected by one.
 *
 *   So a docs change marks stale only the shards that ran a suite which reads docs. A code change
 *   still marks every shard, because code is what the whole suite is about.
 * @returns {{
 *   proven: boolean,
 *   failed: number[],
 *   missing: number[],
 *   stale: number[],
 *   skipped: number,
 *   line: string,
 * }}
 *   `proven` is true only when EVERY shard has a report, no report records a failure, and no report
 *   predates the newest source change. `line` is the one-line verdict to print; it names what is
 *   wrong rather than counting it, so it tells the reader which command to run next.
 */
function shardVerdict(shards, found, opts) {
  const byShard = new Map();
  const atByShard = new Map();
  for (const r of found || []) {
    if (Number.isInteger(r?.shard) && r.shard >= 1 && r.shard <= shards) {
      byShard.set(r.shard, r.counts);
      if (Number.isFinite(r.at)) atByShard.set(r.shard, r.at);
    }
  }
  const sourceChangedAt = Number.isFinite(opts?.sourceChangedAt) ? opts.sourceChangedAt : null;
  const docsChangedAt = Number.isFinite(opts?.docsChangedAt) ? opts.docsChangedAt : null;
  const docsReadingShards = new Set(opts?.docsReadingShards || []);
  /**
   * The instant a given shard's report has to beat.
   *
   * A shard that never opened a `.md` file is answerable to the code change alone. One that did is
   * answerable to whichever came later, because either could have invalidated it.
   */
  const mustBeNewerThan = (shard) => {
    if (docsChangedAt === null || !docsReadingShards.has(shard)) return sourceChangedAt;
    if (sourceChangedAt === null) return docsChangedAt;
    return Math.max(sourceChangedAt, docsChangedAt);
  };

  const missing = [];
  const failed = [];
  const stale = [];
  let skipped = 0;
  for (let i = 1; i <= shards; i++) {
    if (!byShard.has(i) || !byShard.get(i)) { missing.push(i); continue; }
    const counts = byShard.get(i);
    if (shardFailed(counts)) { failed.push(i); continue; }
    // A FAILING shard is reported as failing, not as stale: the failure is the more actionable fact,
    // and re-running it is implied either way. Only an otherwise-green shard can be stale.
    const threshold = mustBeNewerThan(i);
    if (threshold !== null && atByShard.has(i) && atByShard.get(i) < threshold) {
      stale.push(i);
    }
    skipped += counts.skipped ?? 0;
  }

  const proven = missing.length === 0 && failed.length === 0 && stale.length === 0;
  const parts = [];
  if (failed.length) {
    parts.push(`FAILED: shard(s) ${failed.map((s) => `${s}/${shards}`).join(', ')} record a failure.`);
  }
  if (missing.length) {
    parts.push(`INCOMPLETE: shard(s) ${missing.join(', ')} have no report.`);
  }
  if (stale.length) {
    parts.push(
      `STALE: shard(s) ${stale.join(', ')} were last run before the source changed, `
      + 'so they prove nothing about this tree.',
    );
  }
  let line;
  if (!proven) {
    line = `${parts.join(' ')} The suite is NOT proven.`;
  } else if (skipped > 0) {
    // A skip is unfinished work, not a pass - say so rather than printing an unqualified green.
    line = `All shards passed, but ${skipped} test(s) were skipped. A skip is not a pass.`;
  } else {
    line = 'All shards passed.';
  }

  return { proven, failed, missing, stale, skipped, line };
}

module.exports = { shardVerdict, shardFailed };
