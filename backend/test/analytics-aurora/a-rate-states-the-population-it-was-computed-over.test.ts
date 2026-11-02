/**
 * A RATE STATES THE POPULATION IT WAS COMPUTED OVER.
 *
 * Evaluation scored everything: unscored rows, oldest first, capped per run. The cap is a timeout
 * guard and says so ("the next run picks up the rest"), not a sampling policy. Cost scaled with
 * traffic and the only lever changed WHEN an exchange was judged, never WHETHER.
 *
 * That was affordable while one cheap judge asked one question. It stops being affordable the moment
 * groundedness re-reads the retrieved context and pairwise judging costs two candidates and a
 * comparison. An unbounded population times a bigger per-row cost is how evaluation gets switched
 * off.
 *
 * The three properties that make the sample trustworthy, each pinned below:
 *
 *   1. STRATIFIED. Flagged and low-confidence rows are always taken. Sampling uniformly would
 *      dilute exactly the exchanges worth reading.
 *   2. DETERMINISTIC. The draw is a hash of the id, not random(). This query runs every 30 minutes
 *      over the SAME unscored backlog, so a fresh random draw would eventually admit every row and
 *      the sample would decay into the exhaustive scan it replaced.
 *   3. RECORDED. The stratum and rate land on the row, so a figure can state its population instead
 *      of a reader inferring it.
 */
import * as fs from 'fs';
import * as path from 'path';

const AURORA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const runner = fs.readFileSync(path.join(AURORA, 'evaluation-runner.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(AURORA, 'schema', '061-a-rate-states-the-population-it-was-computed-over.sql'),
  'utf8',
);

/**
 * The unscored-exchange selection, isolated so a match elsewhere cannot satisfy these, and taken to
 * the function's closing brace rather than a character count - a fixed slice silently truncated
 * before the sampling clause and failed on code that was present.
 */
function selection(): string {
  const lines = runner.split('\n');
  const start = lines.findIndex((l) => l.includes('async function getUnscoredExchanges'));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join('\n');
}

/**
 * The same block with SQL and TS comments removed.
 *
 * A comment explaining why something is NOT done contains the very word an assertion searches for:
 * the note saying the draw is "a hash of the id, NOT random()" made a search for `random()` match on
 * correct code. Assert against statements, never against the prose beside them.
 */
function selectionCode(): string {
  return selection()
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

describe('the sample is stratified', () => {
  it('always takes a low-confidence exchange', () => {
    expect(selection()).toContain("e.intent_confidence = 'low'");
  });

  it('always takes an exchange a person flagged', () => {
    // human_flag is keyed on the CHIME message id, so the join goes through the message row rather
    // than comparing to the exchange's uuid foreign key - the mismatch that 502'd the Flagged tab.
    const sel = selection();
    expect(sel).toContain('LEFT JOIN human_flag hf');
    expect(sel).toContain('hf.message_id = ma.message_id');
    expect(sel).toContain('hf.message_id IS NOT NULL');
  });

  it('always takes an exchange the guardrail found something on, leaving out the platform\'s own masks (Appendix C5)', () => {
    const sel = selectionCode();
    expect(sel.match(/\$\{HAS_SAFETY_FINDING_SQL\}/g)?.length).toBe(2);
    expect(runner).toMatch(/const HAS_SAFETY_FINDING_SQL = `EXISTS \(/);
    expect(runner).toMatch(/WHERE NOT \(f\.finding LIKE ANY\(\$3::text\[\]\)\)/);
    expect(sel).toContain('INTERNAL_MARKER_FINDING_IDS.map');
  });

  it('samples only the remainder', () => {
    // The three conditions are alternatives: a flagged or low-confidence row is taken whatever the
    // rate is set to, which is what "stratified" means here.
    const sel = selection();
    const at = sel.indexOf("e.intent_confidence = 'low'");
    expect(sel.slice(at, at + 400)).toContain('OR');
  });
});

describe('the draw is deterministic, so the sample does not decay', () => {
  it('hashes the id rather than drawing at random', () => {
    const sel = selection();
    expect(sel).toContain("md5(e.id::text)");
    expect(sel).toMatch(/%\s*100\s*<\s*\$2/);
  });

  it('never calls random()', () => {
    // The failure this avoids is slow and silent: re-drawing each run admits more of the same
    // backlog every 30 minutes until the sample is the exhaustive scan it replaced.
    expect(selectionCode().toLowerCase()).not.toContain('random()');
  });
});

describe('the rate is a lever, not a silent default', () => {
  it('defaults to 100, which is the behavior that shipped', () => {
    // Silently sampling a deployment that was measuring exhaustively would move every rate on the
    // dashboard without anybody asking for it.
    expect(runner).toContain("Number(process.env.EVAL_SAMPLE_PERCENT || 100)");
  });

  it('is clamped to a usable range', () => {
    expect(runner).toContain('Math.min(100, Math.max(1,');
  });
});

describe('the population is recorded on the row', () => {
  it('carries the stratum out of the selection', () => {
    expect(selection()).toContain("THEN 'always' ELSE 'sampled' END AS sample_stratum");
  });

  it('writes the stratum and the rate with the score', () => {
    const at = runner.indexOf('INSERT INTO evaluation_results');
    expect(runner.slice(at, at + 1000)).toContain('sample_stratum, sample_rate');
  });

  it('records NO rate on the always stratum, which is not sampled', () => {
    // Writing 100 there would read as "sampled at 100%" and invite pooling it with ordinary traffic.
    expect(runner).toContain("ex.sample_stratum === 'sampled' ? SAMPLE_RATE : null");
  });

  it('the migration says a rate over one stratum is not a rate over traffic', () => {
    expect(migration).toMatch(/not a rate over traffic/i);
    expect(migration).toContain('ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS sample_stratum');
    expect(migration).toContain('ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS sample_rate');
  });
});
