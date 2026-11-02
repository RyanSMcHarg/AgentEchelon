/**
 * EVERY VERDICT THE JUDGE RETURNS IS COUNTED SOMEWHERE, AND NO EXCHANGE IS DROPPED FROM THE PANEL.
 *
 * Two defects found the same way on 2026-09-14 - by reading the live numbers and asking what the
 * buckets add up to - and they lean in opposite directions, which is why neither was obvious.
 *
 * ── 1. A VERDICT WITH NO BUCKET (understated quality) ───────────────────────────────────────────
 *
 * The judge returns six classifications. The distribution counted four, so `appropriate_refusal` was
 * tallied nowhere: 15 of 200 scored exchanges live, 7.5 percent, absent from every number on the tab.
 * An appropriate refusal is a GOOD outcome - the prompt scores it 85-100 for correctly declining - so
 * its absence made the deployment look worse than it was, and a reader summing the buckets silently
 * got 93 percent of the population.
 *
 * ── 2. A BUCKET THAT NAMED A DEFECT WHERE THERE WAS NONE ────────────────────────────────────────
 *
 * `getModelEffectiveness` put 151 of 797 exchanges - 18.9 percent - into one model 'unknown' /
 * intent 'unknown' bucket. Those rows are greetings, drift notices and split confirmations.
 *
 * THE FIRST ATTEMPT AT THIS EXCLUDED THEM, AND THAT WAS WRONG (owner correction, 2026-09-14). It
 * rested on two claims that do not hold:
 *
 *   "No model ran."  The notice TEXT is a constant, but drift detection runs an embedding call to
 *   decide the topic moved. That is model work with a real cost, and a canned sentence at the end of
 *   a model decision is not an absent model call.
 *
 *   "0 of 26 carried a correlation marker."  `a-deferral-is-a-measured-response.test.ts` states that
 *   a notice carries no marker BY CONSTRUCTION - which is precisely why the acknowledged message id
 *   had to travel on the notice instead. The marker's absence is a documented property of this
 *   message kind, not evidence it was never a response.
 *
 * And the direction is the whole point. That same prior work records what excluding a population
 * does: "It was not a bad number, it was an ABSENT one - queued turns left the latency population
 * entirely, the averages stayed healthy, and the wait the platform deliberately imposes appeared
 * nowhere." A filter here reproduces that exactly, by deleting the turns that drag the averages down.
 *
 * So the rows STAY COUNTED and are LABELLED for what they are. 'unknown' claimed an attribution
 * defect where there is none; a notice is named as a notice, which leaves the word 'unknown' to mean
 * the one thing worth chasing - a turn that DID call a model and lost the record, which
 * `model-backfill.ts` repairs from the out-of-band analytics store.
 */
import * as fs from 'fs';
import * as path from 'path';

const querySrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'analytics-query.ts'), 'utf8');
// ── READ FROM THE RUBRIC THAT ACTUALLY SCORES, NOT A COPY OF IT ─────────────────────────────────
//
// This read `lambda/src/evaluation/relevance-prompt.ts`, which nothing imports and which has already
// drifted from the live rubric - its own header says so. So the guard derived the enum from a file
// no judge has ever been sent: a verdict added to the live rubric would have passed here vacuously,
// which is the precise failure this test exists to catch, one file over.
//
// The live rubric is `RELEVANCE_PROMPT` in the Aurora runner. Both runners are read, because Athena
// mode deploys a SECOND runner (`lambda/src/evaluation/evaluation-runner.ts`, wired at
// `archive-stack.ts`) with its own copy, and a verdict either one can return has to have a bucket.
const auroraRunnerSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts'), 'utf8');
const athenaRunnerSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lambda', 'src', 'evaluation', 'evaluation-runner.ts'), 'utf8');

/** Every verdict either live rubric tells its judge it may return, read rather than listed. */
function verdictsFromPrompt(): string[] {
  const found = new Set<string>();
  for (const src of [auroraRunnerSrc, athenaRunnerSrc]) {
    for (const m of src.matchAll(/"classification":\s*"<([^>]+)>"/g)) {
      for (const v of m[1].split('|').map((s) => s.trim()).filter(Boolean)) found.add(v);
    }
  }
  if (found.size === 0) throw new Error('could not read the classification enum out of either live rubric');
  return [...found];
}

describe('every verdict the judge can return is counted somewhere', () => {
  it('reads more than the four the distribution used to carry', () => {
    // Guards the guard: if the prompt enum stops parsing, the test below would pass vacuously.
    const verdicts = verdictsFromPrompt();
    expect(`verdict count: ${verdicts.length >= 5}`).toBe('verdict count: true');
    expect(verdicts).toContain('appropriate_refusal');
  });

  it('gives each one a bucket in the distribution', () => {
    const verdicts = verdictsFromPrompt();
    // The section of the file that builds the distribution counters.
    // Starts at the first counter's FILTER clause, not at its alias - the alias comes after the
    // literal it tests, so slicing there hid 'excellent' from the very scan looking for it.
    const block = querySrc.slice(
      querySrc.indexOf("FILTER (WHERE er.classification = 'excellent')"),
      querySrc.indexOf('AS scored_count'));
    const missing = verdicts.filter((v) => !block.includes(`'${v}'`));
    expect(`verdicts with no bucket: ${missing.join(',') || 'none'}`).toBe('verdicts with no bucket: none');
  });

  it('publishes the denominator, so the buckets can be checked rather than trusted to sum', () => {
    // A verdict a deployment adds later lands in the total and in no bucket. With the total published
    // that is visible; without it, it is exactly the silent drop this file exists for.
    expect(querySrc).toMatch(/COUNT\(\*\) FILTER \(WHERE er\.classification IS NOT NULL\) AS scored_count/);
    expect(querySrc).toMatch(/scoredCount: parseInt\(row\.scored_count/);
  });

  it('surfaces the refusal bucket to the client under its own name', () => {
    expect(querySrc).toMatch(/appropriateRefusal: parseInt\(row\.appropriate_refusal_count/);
    // NOT folded into `good`: "answered well" and "was right to decline" are different facts.
    expect(`folded into good: ${/good: parseInt\(row\.(good_count\s*\+|appropriate)/.test(querySrc)}`)
      .toBe('folded into good: false');
  });
});

describe('the effectiveness panel counts every exchange, and names what it cannot attribute', () => {
  /** The body of getModelEffectiveness, so the assertions cannot match some other query. */
  const modelEffectiveness = (() => {
    const start = querySrc.indexOf('async function getModelEffectiveness');
    expect(start).toBeGreaterThan(-1);
    return querySrc.slice(start, querySrc.indexOf('\n}', querySrc.indexOf('ORDER BY exchange_count DESC', start)));
  })();

  it('does NOT filter the population down to model turns', () => {
    // THE REGRESSION THIS FILE NOW EXISTS TO STOP. A WHERE clause requiring telemetry deletes the
    // notices from the panel and makes every average healthier by removing what drags it down - the
    // exact failure a-deferral-is-a-measured-response.test.ts was written to end, in a second place.
    const whereClause = modelEffectiveness.slice(modelEffectiveness.indexOf('WHERE e.created_at'));
    expect(`filters on total_ms: ${/AND\s*\([\s\S]{0,200}?m\.total_ms IS NOT NULL/.test(whereClause)}`)
      .toBe('filters on total_ms: false');
    expect(`filters on the model column: ${/WHERE[\s\S]{0,800}?AND[\s\S]{0,200}?m\.bedrock_model IS NOT NULL/.test(whereClause)}`)
      .toBe('filters on the model column: false');
    // The only WHERE condition is the date window the caller asked for.
    expect(modelEffectiveness).toMatch(/WHERE e\.created_at >= lower\(\$1::tstzrange\) AND e\.created_at < upper\(\$1::tstzrange\)/);
  });

  it('names a DIRECT answer from what the turn declared, not from missing telemetry', () => {
    // MESSAGE-FLOW section 2.5 settles the population question: a direct answer "pairs into an
    // exchange - yes, on the target it declares", and DeliveryOption.DIRECT is defined as an
    // "immediate response without Bedrock" for greetings and acknowledgments. So no model is CORRECT
    // BEHAVIOUR on these rows, not a gap, and calling them 'unknown' claimed a defect where the
    // deployment is working exactly as specified.
    expect(modelEffectiveness).toMatch(/e\.delivery_option = 'DIRECT'/);
    expect(modelEffectiveness).toMatch(/direct answer \(no model by design\)/);
    // NOT THE EARLIER GUESS. "bot-authored with no total_ms" inferred the category from absent
    // telemetry, and that guess swept up four marker-carrying turns which HAD lost their attribution
    // - hiding a real defect inside the bucket for the healthy case.
    const guessed = /THEN 'notice \(no model turn\)'/.test(modelEffectiveness);
    expect(`infers the category from telemetry: ${guessed}`).toBe('infers the category from telemetry: false');
  });

  it('makes a declared-kind row visible as a PAIRING defect, not a model bucket', () => {
    // A drift suggestion and a deferral notice must not pair into an exchange at all - MESSAGE-FLOW
    // section 2.5 says each "pairs into an exchange: no, and it says so rather than being excluded by
    // an absence". Both archival pairing paths already refuse a row that declared a kind, so one
    // reaching this query means the pairing let it through: a historical row from before the
    // declaration shipped, or a producer that is not declaring.
    //
    // Naming it here does not fix the pairing. It makes the size of that defect COUNTABLE instead of
    // spreading it across model buckets or hiding it under a label that sounds fine.
    expect(modelEffectiveness).toMatch(/turn_kind, m\.metadata->>'turnKind'/);
    expect(modelEffectiveness).toMatch(/NOT AN ANSWER: /);
  });

  it("leaves 'unknown' meaning the one thing worth chasing", () => {
    // A turn that DID run a model and lost the attribution still lands on 'unknown'. That residual is
    // what model-backfill.ts repairs from the out-of-band store; sharing the word with a fifth of the
    // traffic is what made it unreadable.
    expect(modelEffectiveness).toMatch(/ELSE 'unknown'/);
  });

  it('groups by the SAME expression it selects, or the tab errors at query time', () => {
    // Postgres groups by the expression, not the alias. This pair has diverged before, and on this
    // path the symptom is the whole panel returning an error rather than a wrong number.
    const label = /CASE\s*\n\s*WHEN m\.bedrock_model IS NOT NULL THEN m\.bedrock_model/;
    const selectHalf = modelEffectiveness.slice(0, modelEffectiveness.indexOf('FROM exchanges'));
    const groupHalf = modelEffectiveness.slice(modelEffectiveness.indexOf('GROUP BY'));
    expect(`select carries the label: ${label.test(selectHalf)}`).toBe('select carries the label: true');
    expect(`group carries the label: ${label.test(groupHalf)}`).toBe('group carries the label: true');
  });
});
