/**
 * AN UNJUDGED ROW IS NOT A VERDICT: `is_compliant` NULL is never coalesced.
 *
 * `evaluation_results.is_compliant` is written by the evaluation runner's Pass C and is NULL on every
 * exchange it has not reached: those from before Pass C, and those where neither a guardrail finding
 * nor a usable judgement could assess it. What a reader does with that NULL decides the number it
 * publishes, and three readers once did three different things with it:
 *
 *   evaluation_scores          FILTER (WHERE er.is_compliant)                  ->    0% compliance
 *   getModelEffectiveness      FILTER (WHERE COALESCE(is_compliant, true))     ->  100% compliance
 *   daily breakdown            NOT COALESCE(is_compliant, true)                ->  zero violations
 *
 * Same 791 exchanges, three answers, none of them evidence of anything. An operator reading the
 * Evaluations tab saw a catastrophe; one reading Effectiveness saw perfection.
 *
 * The same invention has a second shape, and it is the one that outlived the SQL fix: a JavaScript
 * rollup that weights a NULL as a zero. An intent nothing has assessed then contributes a 0% group at
 * full exchange weight, and a variant with one assessed intent out of four reports a quarter of its
 * real rate - a confident number, arrived at honestly, describing nothing.
 *
 * ── WHY THIS IS A SOURCE-LEVEL GUARD ────────────────────────────────────────────────────────────
 *
 * The defect is a DEFAULT, and a default is invisible to a behavioral test: give any of these
 * queries a table of NULLs and each returns a confident number, exactly as it did in production. A
 * test would have to assert the absence of a coalesce to catch it, which is what this does directly.
 *
 * It is also the cheapest possible check for the most expensive class of error here - a number that
 * is wrong while looking right. See DESIGN-EVALUATION, Pass C for the design this
 * protects, and its Step 0: stop coalescing, report coverage, judge nothing yet.
 */
import * as fs from 'fs';
import * as path from 'path';

const QUERY_SRC = path.join(
  __dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'analytics-query.ts',
);

/** The file with `--` SQL comment lines and block comments removed. The rules below are explained by
 *  comments that necessarily name what they ban, and an explanation must not fail the rule it
 *  explains - the cheapest way to pass would be to delete the reasoning. */
function codeOf(file: string): string {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

describe('compliance: NULL means not assessed, and is never defaulted', () => {
  const sql = codeOf(QUERY_SRC);

  it('no reader coalesces is_compliant to a verdict', () => {
    // BOTH DIRECTIONS ARE INVENTIONS. Defaulting NULL to true invents a pass for something never
    // judged; defaulting to false invents a violation. Both were in the codebase at once, in
    // different queries, which is how the same data reported 0% and 100%.
    const coalesces = sql.match(/COALESCE\(\s*(er\.)?is_compliant/g) || [];
    expect(coalesces).toHaveLength(0);
  });

  it('no reader coalesces a relevance score to zero', () => {
    // THE SAME INVENTION, ON A CONTINUOUS METRIC, and for a long time the ban above covered only the
    // boolean next to it. Judging is a SAMPLE and a backlog, so most exchanges are unscored at any
    // moment by design. Counting each of them as a zero made every score measure evaluation COVERAGE
    // rather than quality: it fell as traffic grew and rose when the backlog caught up, two variants
    // sampled at different rates stopped being comparable, and an alert titled "evaluated quality
    // below target" fired on how much had been judged.
    //
    // The SD is banned with it. A sample SD over placeholder zeros describes the spread of the
    // scoring coverage, and that SD is the denominator of the Welch test the recommendation runs.
    const zeroFilled = sql.match(/(COALESCE|coalesce)\(\s*(er\.)?relevance_score\s*,\s*0\s*\)/g) || [];
    expect(zeroFilled).toHaveLength(0);
  });

  it('publishes the scored population wherever it publishes a score', () => {
    // An average with no denominator cannot be told apart from an average over one row, and these
    // columns are read as verdicts.
    expect(sql).toMatch(/COUNT\(er\.relevance_score\)[\s\S]{0,40}AS scored_count/);
  });

  it('counts only rows that carry a verdict, on both sides of the rate', () => {
    // A compliant row is an explicit TRUE, a violation an explicit FALSE. `FILTER (WHERE
    // er.is_compliant)` is not the same thing: it silently drops NULL into the denominator, which is
    // what produced 0%.
    expect(sql).toMatch(/FILTER \(WHERE er\.is_compliant IS TRUE\)/);
    expect(sql).toMatch(/FILTER \(WHERE er\.is_compliant IS FALSE\)/);
    // The denominator is the ASSESSED population, never the whole one.
    expect(sql).toMatch(/NULLIF\(COUNT\(\*\) FILTER \(WHERE er\.is_compliant IS NOT NULL\), 0\)/);
  });

  it('publishes coverage beside the rate', () => {
    // A rate without its denominator cannot be told apart from "nothing was looked at" - which is
    // precisely the state the deployment is in until Pass C writes a verdict.
    expect(sql).toMatch(/compliance_assessed_count/);
  });

  it('reports no rate at all when nothing was assessed, rather than zero', () => {
    // `parseFloat(row.compliance_rate || '0')` turned an absent rate into a confident 0%. With no
    // writer, that is every row today.
    const js = fs.readFileSync(QUERY_SRC, 'utf8');
    expect(js).not.toMatch(/parseFloat\(row\.compliance_rate \|\| '0'\)/);
    expect(js).toMatch(/complianceRate:[\s\S]{0,160}\?\s*null/);
  });

  it('never folds an unassessed group into a rollup as a zero', () => {
    // `(Number(r.compliance_rate) || 0) * n` against the shared score weight is the JS shape of the
    // same invention the SQL rules above ban: a group nothing assessed arrives as 0% and takes full
    // weight. Compliance carries its own weight, the way task_completion_rate already did.
    const js = fs.readFileSync(QUERY_SRC, 'utf8');
    expect(js).not.toMatch(/compliance_rate\s*\+=\s*\(Number\(/);
    expect(js).toMatch(/_complianceWeight/);
  });
});

describe('the deterministic half of the verdict can actually reach it', () => {
  const EVAL_SRC = path.join(
    __dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts',
  );
  const ARCHIVAL_SRC = path.join(
    __dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts',
  );

  it('reads the agent metadata from the UPDATE row, where the turn actually writes it', () => {
    // The assistant posts a placeholder and rewrites it when the reply is ready, so guardrailFindings
    // - the entire deterministic half of the compliance verdict - is stamped on the update row.
    // Selecting only `ma.metadata` left every deterministic rule with nothing to match on, silently:
    // the findings existed, one row away, and the verdict came back NOT ASSESSED forever. Every update
    // is its own row (migration 084), and the reply graded is the message as it stands: the latest.
    const sql = fs.readFileSync(EVAL_SRC, 'utf8');
    expect(sql).toContain("updateJoinSql({ alias: 'ma_upd', create: 'ma', pick: 'latest' })");
    expect(sql).toMatch(/COALESCE\(ma\.metadata, '\{\}'::jsonb\) \|\| COALESCE\(ma_upd\.metadata, '\{\}'::jsonb\)/);
  });

  it('folds the caller clearance onto the canonical row, where a reader looks for it', () => {
    // user_clearance arrives on the UPDATE like every other analytic. Without a line in the fold, the
    // CREATE row is NULL forever and the clearance a turn ran under - the one question migration 046
    // added the column to answer - matches nothing.
    const sql = fs.readFileSync(ARCHIVAL_SRC, 'utf8');
    expect(sql).toMatch(/user_clearance\s*=\s*COALESCE\(\$\d+, user_clearance\)/);
  });
});
