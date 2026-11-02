/**
 * THE DEPLOYED EVALUATION RUNNER, DRIVEN END TO END: a real turn is judged, and the verdict is
 * readable through the signed analytics API.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * Every citation on SPEC-EVALUATION's Coverage line is a unit test, and that document says so in its
 * own words: no test in that suite executes any evaluation SQL against a database, and none asserts
 * anything about a verdict a judge actually returned. That is the exact gap `emitEmfMetric` fell
 * through - `{name, unit}` where the schema required `{Name, Unit}`, every unit test green, every
 * document discarded silently for months. The evaluation runner has more of those seams than most
 * things here: a scheduled Lambda inside the VPC, a migration that must have applied on the live
 * cluster, a Bedrock judge, an INSERT against a partial unique index, and four read queries in a
 * different Lambda that have to name the same columns. Each half is unit-covered. Nothing joined them.
 *
 * So this drives the whole path against the deployment: a real conversation, a real turn, the real
 * runner invoked the way `validate.mjs` invokes it, and the verdict read back through the SigV4-signed
 * analytics API - the same path the admin console reads, never a direct database or Lambda call.
 *
 * ── WHAT IT ASSERTS, AND WHAT IT REFUSES TO ASSERT ──────────────────────────────────────────────
 *
 * THE JUDGE IS A MODEL, SO ITS VERDICT IS NOT A TEST ORACLE. A spec asserting "this decline scored 85
 * or better" or "classification === 'appropriate_refusal'" would fail on a correct deployment often
 * enough to earn a retry, and a gate with retries on it means nothing - which is this repo's own
 * recorded position on flaky gates. It is also the wrong instrument: whether the judge judges WELL is
 * measured by routing agreement and pairwise agreement against a human pick, not by an assertion in a
 * browser test.
 *
 * What is deterministic is the WIRING and the SHAPE, and that is what fails when this path breaks:
 *
 *   - a verdict row EXISTS for the exchange this test produced, and is reachable by that exchange's id
 *   - the score is a number inside 0-100
 *   - `rubric_version` is present and non-empty, so a score names the prompt it was judged under
 *   - `evaluator_model` is present and non-empty, so a score names the model that produced it
 *   - `sample_stratum` is one of the two declared values, so a score states the population it was
 *     drawn from
 *   - `is_compliant` and `is_grounded` read as TRUE, FALSE or NULL and never as a substituted default
 *   - a groundedness verdict exists only where the turn had passages to check against
 *   - every rate arrives with the population count beside it, and reads ABSENT rather than zero when
 *     nothing has been assessed
 *
 * THE NEXT PERSON WILL BE TEMPTED TO ASSERT THE VERDICT. Please do not. A test that says "the judge
 * scored this well" is a test that fails when the model is retired, when the rubric is edited, or on a
 * Tuesday - and the first response to that failure is always a retry, after which the test is
 * decoration. Assert what the deployment must do; measure what the judge does on the Evaluations and
 * Effectiveness surfaces, where a person can see the population behind the number.
 *
 * ── THE JUDGE MODEL IS ASSERTED THROUGH THE SIGNED PATH ─────────────────────────────────────────
 *
 * `evaluator_model` is written on every row (`evaluation-runner.ts`) and is published by
 * `intent_exchanges`, `evaluation_exchanges`, `intent_effectiveness` and `evaluation_scores`, so it is
 * asserted here the way every other column on this row is: over the API, never by reading the database,
 * because a read that bypasses the API proves nothing about the API.
 *
 * ── PRECONDITIONS, AND WHY EACH ONE SKIPS LOUDLY RATHER THAN SILENTLY ──────────────────────────
 *
 * AURORA MODE ONLY. Athena mode has no `evaluation_results` table and deploys a different, much
 * smaller runner, so there is nothing here to drive. That is a deployment shape rather than a defect,
 * so `validate.mjs` drops this phase entirely when no Aurora analytics stack resolves - it does not
 * run and pass. When the stack IS there and `EVAL_LAMBDA_NAME` still did not resolve, the phase stays
 * and this states that precondition by name, which under `E2E_REQUIRE_ALL=1` (validate's default)
 * fails the phase. A skip is not a pass, and `e2e/reporters/skip-visibility.ts` prints the reason.
 *
 * Gated by EVALUATION_VERDICTS_E2E=1 (the `evaluation-verdicts` phase). Runs against a live deployment:
 *   node backend/scripts/validate.mjs --only=evaluation-verdicts
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  evaluationLambdaName,
  invokeEvaluationRunner,
  MISSING_RUNNER_REASON,
} from './helpers/evaluation-runner';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardConsoleErrors();

const RUN = process.env.EVALUATION_VERDICTS_E2E === '1';
// SERIAL, because the three tests are three assertions about ONE produced exchange: the first makes
// it and scores it, the other two read the same row through two more query paths. Re-driving a turn
// per test would triple the model cost and measure three different exchanges.
const suite = RUN ? test.describe.serial : test.describe.skip;
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

/**
 * A substantive question, deliberately not a greeting and not task-shaped.
 *
 * The exchange population is minted by pairing a corr-marked placeholder with the update that replaces
 * it, so a turn answered inline by Lex may never become an exchange at all - and an exchange is the
 * only thing the runner can score. A task-shaped prompt has the opposite problem: it opens a task and
 * the reply is a clarifying question, which is a legitimate turn but drags a task flow into a test
 * about per-exchange verdicts.
 */
const PROMPT =
  'In two or three sentences, what is the trade-off between caching a dashboard query and showing '
  + 'fresh numbers?';

/** The two strata the runner declares (`UnscoredExchange.sample_stratum`). */
const DECLARED_STRATA = ['always', 'sampled'];

/** One row of `evaluation_exchanges`, in the fields this spec reads. */
interface ExchangeRow {
  id: string;
  channel_arn: string;
  intent: string | null;
  relevance_score: number | string | null;
  classification: string | null;
  reasoning: string | null;
  is_compliant: boolean | string | null;
}

/** One row of `intent_exchanges` - the per-exchange judged detail the Effectiveness drill reads. */
interface IntentExchangeRow {
  exchange_id: string;
  relevance_score: number | string | null;
  is_grounded: boolean | string | null;
  retrieved_passage_count: number | string | null;
  rubric_version: string | null;
  evaluator_model: string | null;
  sample_stratum: string | null;
}

/**
 * Postgres booleans arrive over JSON as `true`/`false`, and as `'t'`/`'f'` through some drivers. Read
 * as a TRI-STATE, because that is what the column means: NULL is "not assessed" and must never be
 * folded into false - the whole design of the compliance and groundedness columns rests on it.
 * `undefined` (the field absent from the row) is returned as `'absent'` so a dropped column fails
 * rather than reading as an honest NULL.
 */
function triState(v: unknown): true | false | null | 'absent' {
  if (v === undefined) return 'absent';
  if (v === null) return null;
  if (v === true || v === 'true' || v === 't') return true;
  if (v === false || v === 'false' || v === 'f') return false;
  return 'absent'; // an unrecognized value is a shape failure, reported as one
}

/** Shared across the serial block: what the first test produced, read by the two after it. */
let channelArn = '';
let exchangeId = '';
let exchangeIntent = '';

suite('the deployed evaluation runner judges a real turn, and the verdict is readable', () => {
  // The TURN this spec drives has to be a healthy one, or the exchange being judged was produced by a
  // handler that was already failing - and a score over a fallback reply is not evidence about the
  // evaluation path. This watches the turn-path log groups (AgentHandler, AsyncProcessor,
  // DataPlaneLambda, ChannelFlowProcessor); it does NOT watch the evaluation Lambda, whose own
  // per-exchange failures are surfaced instead by the run counts logged and asserted below.
  guardBackendErrors('evaluation-verdicts');

  let creds: TestCredentials;
  let idToken = '';

  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test.beforeEach(async ({ page }) => {
    // THE PRECONDITIONS, STATED BY NAME. Each of these makes the whole path unreachable, and each
    // reads as a different failure if it is discovered three assertions later instead of here.
    test.skip(!evaluationLambdaName(), MISSING_RUNNER_REASON);
    expect(
      ANALYTICS_API,
      'VITE_ADMIN_API_URL must be set: the verdict is read through the signed analytics API, '
        + 'which is the only read this spec is allowed to make. validate.mjs resolves it from '
        + 'frontend/packages/admin/.env.',
    ).toBeTruthy();

    // testAdmin, because the analytics API is admin-gated and IAM-enforced: the read is SigV4-signed
    // through the same path the console uses, never a direct Lambda invoke with hand-made claims.
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    idToken = await idTokenOf(page);
    expect(idToken, 'an admin id token is required to read the analytics API').toBeTruthy();
  });

  /** Every exchange the last day holds, newest first. Ours is the newest, so it is on the first page. */
  const recentExchanges = async (): Promise<ExchangeRow[]> => {
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'evaluation_exchanges',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      // The query caps `limit` at 200 and orders by `created_at DESC`. The exchange this test just
      // produced is the most recent one in the deployment (the suite runs one worker), so it is at the
      // head of the first page - no paging needed, and none guessed at.
      limit: 200,
    });
    return ((j.data || []) as ExchangeRow[]);
  };

  test('a real turn reaches the exchange ledger and the runner records a verdict against it', async ({ page }) => {
    // The turn itself can take 180s, archival buffers up to ~2 minutes before the exchange exists, and
    // the runner scores up to 200 exchanges with a Bedrock call each.
    test.setTimeout(900_000);

    // Capture the ARN from the create response - the binding that makes every assertion below about
    // THIS turn. Without it "some scored exchange exists" would pass on any historical row, and would
    // have passed against a runner that has not written anything since the day it broke.
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await createConversation(page, `Evaluation verdict e2e ${Date.now()}`, 'Premium');
    channelArn = (await (await createResp).json()).conversation.conversationArn as string;
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    console.log(`\n--- evaluation-verdicts channel ---\n${channelArn}`);

    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });
    const reply = await sendAndWaitForResponse(page, PROMPT, 180_000);
    expect(reply.text && reply.text.length, 'the turn must return a response to be judged').toBeTruthy();

    // ── STEP 1: THE EXCHANGE IS ARCHIVED ────────────────────────────────────────────────────────
    //
    // Asserted separately from the verdict because the two failures need different fixes: no exchange
    // is the archival pairing (Chime -> Kinesis -> Aurora), no verdict on an existing exchange is the
    // runner. Collapsed into one assertion, a pairing regression would be reported as a broken judge.
    let mine: ExchangeRow | undefined;
    for (let i = 0; i < 30 && !mine; i++) {
      const rows = await recentExchanges();
      mine = rows.find((r) => r.channel_arn === channelArn);
      if (!mine) await page.waitForTimeout(6_000);
    }
    expect(
      mine,
      'the turn just answered must appear in the exchange ledger within 3 minutes. An empty result '
        + 'here is the archival pairing failing to mint an exchange, not an idle window - the turn was '
        + `observed answering in ${channelArn}.`,
    ).toBeTruthy();

    exchangeId = mine!.id;
    // THE INTENT ARRIVES AFTER THE EXCHANGE. The pairing mints the exchange from the delivered reply, and
    // the turn's intent is folded onto it from the router's later update (the `-UPD` record), so the first
    // poll that shows the exchange can show it without one. Keep reading, bounded, and fail below only if
    // it never fills.
    for (let i = 0; i < 20 && !mine?.intent; i++) {
      await page.waitForTimeout(6_000);
      mine = (await recentExchanges()).find((r) => r.id === exchangeId) ?? mine;
    }
    exchangeIntent = mine!.intent || '';
    console.log(`[evaluation-verdicts] exchange ${exchangeId} intent=${exchangeIntent || '(none)'}`);

    // The intent is what the Effectiveness drill keys on, so an exchange with none is unreachable
    // through that read path. Which intent the classifier chose is not asserted - only that it chose.
    expect(
      exchangeIntent,
      'an archived exchange must carry the intent its turn was routed under, and this one had none two '
        + 'minutes after it was archived. Without one the '
        + 'per-exchange judged detail (rubric version, stratum, groundedness) is unreachable through '
        + 'intent_exchanges, which is the only read path that publishes it.',
    ).toBeTruthy();

    // ── STEP 2: THE RUNNER SCORES IT ────────────────────────────────────────────────────────────
    //
    // ROBUST TO A ROW THAT IS ALREADY SCORED. The runner is also on a 30-minute schedule, so a
    // scheduled pass can reach this exchange before the invoke below does. That is a pass, not a
    // problem: what matters is that a verdict exists for this exchange and is readable. The invoke is
    // what makes the test finish in minutes rather than waiting for the schedule.
    //
    // RE-INVOKED WHILE PROGRESS IS BEING MADE. `getUnscoredExchanges` takes the backlog OLDEST FIRST,
    // capped at EVAL_MAX_PER_RUN (200), so on a deployment with a deep backlog one pass can finish
    // without ever reaching today's rows. Each pass that writes something has moved the backlog, so
    // another pass is worth making; a pass that writes nothing has not, and the loop stops rather than
    // spending the test's budget on invocations that cannot progress.
    const scoreOf = async (): Promise<ExchangeRow | undefined> =>
      (await recentExchanges()).find((r) => r.id === exchangeId);

    let scored = (await scoreOf())?.relevance_score ?? null;
    let passes = 0;
    const runs: string[] = [];
    while (scored === null && passes < 4) {
      const result = invokeEvaluationRunner();
      passes += 1;
      runs.push(JSON.stringify(result));
      console.log(`[evaluation-verdicts] runner pass ${passes}: ${runs[runs.length - 1]}`);
      // The run id is how a pass is identified in the rows it wrote, so a pass that answers without
      // one is a runner whose output cannot be traced to it.
      expect(
        result.runId,
        `the runner must answer with the run id it stamped on its rows. Got: ${runs[runs.length - 1]}`,
      ).toBeTruthy();
      // A pass that ERRORED on everything it took is a broken runner reporting a completed run - the
      // handler catches per-exchange failures and still answers 200. Named here rather than left to
      // the score assertion below, which would report it as "no verdict recorded".
      expect(
        result.errors > 0 && result.evaluated === 0,
        `the runner took exchanges and failed on all of them (${result.errors} error(s), 0 written). `
          + 'Its CloudWatch log names the first five; this is a runner fault rather than an empty '
          + 'backlog.',
      ).toBe(false);
      scored = (await scoreOf())?.relevance_score ?? null;
      if (scored === null && result.evaluated === 0) break; // no progress available - stop and report
    }

    const row = await scoreOf();
    expect(row, `the exchange ${exchangeId} must still be readable after the run`).toBeTruthy();
    console.log(`[evaluation-verdicts] verdict row: ${JSON.stringify(row)}`);

    // ABSENT AS WELL AS NULL, because `.not.toBeNull()` alone passes on `undefined`: a read query that
    // stopped selecting the column would have satisfied the one assertion this whole spec exists for.
    expect(
      row!.relevance_score === null || row!.relevance_score === undefined,
      'the deployed runner must record a verdict for an exchange it was just asked to score, and that '
        + 'verdict must be readable through the signed analytics API. A NULL here is the whole path '
        + 'failing at one of its seams - the migration not applied on the live cluster, the Bedrock '
        + 'judge unreachable from inside the VPC, the INSERT refused, or the read query no longer '
        + `naming the column. Runner passes: ${runs.join(' | ') || '(none - it was already scored)'}`,
    ).toBe(false);

    // ── THE SHAPE OF THE VERDICT, NOT THE VERDICT ───────────────────────────────────────────────
    const score = Number(row!.relevance_score);
    expect(Number.isFinite(score), `relevance_score must be a number, got ${String(row!.relevance_score)}`).toBe(true);
    expect(score, 'relevance_score is a 0-100 scale, and a value outside it means the clamp was lost')
      .toBeGreaterThanOrEqual(0);
    expect(score, 'relevance_score is a 0-100 scale, and a value outside it means the clamp was lost')
      .toBeLessThanOrEqual(100);

    // A CLASSIFICATION IS PRESENT. WHICH ONE IT IS, IS THE JUDGE'S CALL AND IS NOT ASSERTED - see this
    // file's header. The column being empty, though, is a wiring failure: `scoreExchange` substitutes
    // 'partial' even on a parse error, so there is no path on which a scored row carries none.
    expect(
      typeof row!.classification === 'string' && row!.classification.length > 0,
      `a scored exchange must carry a classification; got ${JSON.stringify(row!.classification)}`,
    ).toBe(true);

    // The judge's stated reason has to REACH the row, because it is the only thing that makes a score
    // reviewable by a person. Asserted as present rather than as non-empty: the runner records
    // `String(parsed.reasoning || '')`, so an empty string is the judge omitting it - a thin verdict,
    // not a broken pipeline - while an ABSENT field is the read query having dropped the column.
    expect(
      'reasoning' in row!,
      'evaluation_exchanges must publish `reasoning`, or a score on the console cannot be reviewed '
        + 'against anything by the operator it is shown to.',
    ).toBe(true);

    // TRI-STATE, NEVER A SUBSTITUTED DEFAULT. This column has been read three different wrong ways in
    // this codebase - filtered raw and reported 0%, coalesced to true and reported 100%, and counted as
    // not-coalesced-true and reported none - all from the same rows. NULL means not assessed, and the
    // read path must hand a reader that third state rather than a confident boolean.
    expect(
      triState(row!.is_compliant),
      'is_compliant must read as TRUE, FALSE or NULL. `absent` here means the column was dropped from '
        + 'the read or arrived in an unrecognized shape, and either way a reader cannot tell an '
        + `unassessed exchange from a compliant one. Got: ${JSON.stringify(row!.is_compliant)}`,
    ).not.toBe('absent');
  });

  /**
   * THE JUDGED DETAIL THAT MAKES A SCORE COMPARABLE TO ANOTHER SCORE.
   *
   * A relevance number on its own is not usable: two scores are comparable only if they were produced
   * by the same instrument, and a rate over them is only readable if the population they were drawn
   * from is known. The instrument is two facts, not one - what the judge was ASKED (`rubric_version`)
   * and WHICH MODEL judged (`evaluator_model`) - and each moves a score with nothing about the
   * assistant having changed. All three are stamped on the row at write time and published by
   * `intent_exchanges`, the Effectiveness L2 drill.
   *
   * This asserts them on THIS test's exchange, keyed by its id. Asserting them over "some row" would
   * pass on any historical verdict and would have passed before any of the columns was written.
   */
  test('the verdict names the rubric, the judge, and the population it was drawn from', async () => {
    test.setTimeout(180_000);
    expect(exchangeId, 'the previous test must have produced and scored an exchange').toBeTruthy();

    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'intent_exchanges',
      intent: exchangeIntent,
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      limit: 500,
    });
    const rows = (j.data || []) as IntentExchangeRow[];
    expect(
      rows.length,
      `intent_exchanges must answer for intent "${exchangeIntent}" over the last day - it is the only `
        + 'read path publishing the rubric version and the sampling stratum, so an empty answer leaves '
        + 'both unreadable by anyone.',
    ).toBeGreaterThan(0);

    const mine = rows.find((r) => r.exchange_id === exchangeId);
    expect(
      mine,
      `the exchange this run judged (${exchangeId}, intent ${exchangeIntent}) must appear in the `
        + 'Effectiveness drill for its own intent. Absent, the score exists in the table and cannot be '
        + 'reached from the surface that reports it.',
    ).toBeTruthy();
    console.log(`[evaluation-verdicts] judged detail: ${JSON.stringify(mine)}`);

    // THE RUBRIC VERSION IS DERIVED FROM THE PROMPT TEXT, so an empty one means a score that cannot
    // say what it was judged against - and two rubrics pooling into one average with nothing to warn
    // the reader, which is the only reason this column exists.
    expect(
      typeof mine!.rubric_version === 'string' && mine!.rubric_version.length > 0,
      'a verdict must name the rubric version it was judged under; the Effectiveness tab warns a '
        + 'reader when a window spans two of them, and it cannot do that from a blank. Got: '
        + `${JSON.stringify(mine!.rubric_version)}`,
    ).toBe(true);

    // THE JUDGE MODEL, THE OTHER HALF OF THE SAME QUESTION. Tenet P3 makes swapping the judge an
    // expected event, and every score re-baselines when it happens: a blank here means an operator
    // reading two windows cannot tell a regression in the assistant from a different judge. The runner
    // always writes it - the text judge's model, or the vision judge's on an image turn - so a blank on
    // a row this run just produced means the read path dropped it.
    expect(
      typeof mine!.evaluator_model === 'string' && mine!.evaluator_model.length > 0,
      'a verdict must name the model that produced it; the Effectiveness tab names the judge beside '
        + 'the average and warns when a window spans more than one, and it can do neither from a '
        + `blank. Got: ${JSON.stringify(mine!.evaluator_model)}`,
    ).toBe(true);

    // THE STRATUM IS ONE OF THE TWO DECLARED VALUES. Not a judged outcome - the runner computes it
    // deterministically from the row (`always` when a person flagged the response or the classifier
    // was unsure, `sampled` otherwise) - so a third value means the CASE expression and the column
    // have come apart, and every rate stamped with it describes a population nobody can name.
    expect(
      DECLARED_STRATA,
      `sample_stratum must be one of the declared strata, got ${JSON.stringify(mine!.sample_stratum)}`,
    ).toContain(mine!.sample_stratum);

    // A GROUNDEDNESS VERDICT ONLY WHERE THERE WAS GROUND TO CHECK AGAINST. `scoreGroundedness` records
    // NOT ASSESSED when the turn retrieved nothing, because a reply answered from model knowledge is
    // UNRETRIEVED rather than ungrounded - reporting it as ungrounded would invent a retrieval failure
    // where there was no retrieval. One direction only: a turn that DID retrieve can still read NULL,
    // because a judge that failed to answer records NULL rather than a verdict.
    const grounded = triState(mine!.is_grounded);
    expect(
      grounded,
      'is_grounded must read as TRUE, FALSE or NULL. `absent` means the column was dropped from the '
        + `read or arrived in an unrecognized shape. Got: ${JSON.stringify(mine!.is_grounded)}`,
    ).not.toBe('absent');
    // NO `?? 0` DEFAULT ON THE WAY IN. Coalescing an absent column to zero is how this assertion would
    // pass on a read that had stopped publishing the count at all - and zero is a MEANINGFUL value
    // here (it is what "this turn retrieved nothing" reads as), so the default would be indistinguishable
    // from the answer. The runner writes a number on every scored row, never NULL.
    // Absent and NULL are both failures and are checked together, because `.not.toBeNull()` alone
    // passes on `undefined` - a dropped column would have slipped straight through it.
    expect(
      mine!.retrieved_passage_count === null || mine!.retrieved_passage_count === undefined,
      'a scored exchange must publish how many passages the turn was given; the groundedness rate is '
        + 'read against it, and a count that is absent or NULL makes that rate unreadable. Got: '
        + `${JSON.stringify(mine!.retrieved_passage_count)}`,
    ).toBe(false);
    const passages = Number(mine!.retrieved_passage_count);
    expect(
      Number.isFinite(passages) && passages >= 0,
      `retrieved_passage_count must be a non-negative number, got ${JSON.stringify(mine!.retrieved_passage_count)}`,
    ).toBe(true);
    if (grounded !== null) {
      expect(
        passages,
        'a groundedness verdict was recorded for a turn the row says retrieved nothing. One of the two '
          + 'is wrong, and either way the groundedness rate is being computed over turns that had no '
          + 'passages to be grounded in.',
      ).toBeGreaterThan(0);
    }
  });

  /**
   * A RATE ARRIVES WITH ITS POPULATION, AND READS ABSENT RATHER THAN ZERO.
   *
   * The failure this guards is not a wrong number, it is a CONFIDENT one: a compliance rate of 0%
   * computed over rows nobody judged reads as a deployment breaking its rules, and 100% over the same
   * rows reads as a clean bill of health. Both have been produced from this table. The rule is that
   * NULL is a third state, never coalesced, and that the denominator travels with the rate so a reader
   * can tell "nothing was looked at" from "everything was fine".
   *
   * ASSERTED AS A BICONDITIONAL, ON WHATEVER THE DEPLOYMENT RETURNS. The "nothing assessed" state
   * cannot be produced on demand here - it depends on what the judge and the guardrails could assess
   * over the window, which is not something a browser can arrange - so instead of fabricating it, both
   * directions are asserted: a rate is present exactly when its population is non-empty, and absent
   * exactly when it is empty. Whichever state the deployment is in, one half makes a real claim.
   */
  test('every published rate states the population it was computed over', async () => {
    test.setTimeout(180_000);
    expect(exchangeId, 'the first test must have produced and scored an exchange').toBeTruthy();

    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    const dateRange = { start: start.toISOString(), end: end.toISOString() };

    // ── THE EVALUATIONS HEADLINE ────────────────────────────────────────────────────────────────
    //
    // `evaluation_scores` is the ONE read here that is cached (5 minutes, keyed by the window, which
    // floors to whole days - so the key is the same for every call made today). Every claim below is
    // therefore about the WINDOW rather than about this run's row: a snapshot up to five minutes old
    // is still a snapshot the invariants must hold on. The claims about this run's own row belong to
    // the two tests above, both of which read uncached query paths.
    const scores = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'evaluation_scores',
      dateRange,
    });
    console.log(
      `[evaluation-verdicts] evaluation_scores: total=${scores.totalExchanges} evaluated=${scores.evaluatedExchanges} `
      + `scored=${scores.scoredCount} complianceRate=${JSON.stringify(scores.complianceRate)} `
      + `complianceAssessed=${scores.complianceAssessed} buckets=${JSON.stringify(scores.scoreDistribution)}`,
    );

    // NON-VACUITY FIRST. Every check below reasons about counts, and an all-zero response satisfies
    // most arithmetic trivially. The first test scored an exchange inside this window, so a zero here
    // is the headline failing to see a verdict that demonstrably exists.
    expect(
      Number(scores.totalExchanges),
      'the window must hold the exchange this run produced; a zero total means the headline is reading '
        + 'a different population from the one the drill just returned.',
    ).toBeGreaterThan(0);
    expect(
      Number(scores.evaluatedExchanges),
      'the window must hold at least the verdict this run recorded. Zero here, with a scored row '
        + 'readable through evaluation_exchanges, means the headline and the list disagree about what a '
        + 'verdict is.',
    ).toBeGreaterThan(0);

    // A VERDICT COUNT CANNOT EXCEED THE POPULATION IT IS TAKEN OVER. A re-scored exchange has several
    // evaluation_results rows, and joining them raw multiplied every COUNT over the join - the defect
    // the DISTINCT ON exists to prevent, and it inflates exactly the panels an operator re-scores
    // BECAUSE they looked wrong. This chain is what a fan-out breaks.
    expect(
      Number(scores.scoredCount),
      'scored_count counts verdicts carrying a classification and cannot exceed the evaluated rows it '
        + 'is drawn from; a bigger number means the evaluation join is fanning out.',
    ).toBeLessThanOrEqual(Number(scores.evaluatedExchanges));
    expect(
      Number(scores.evaluatedExchanges),
      'evaluated_exchanges cannot exceed the exchanges in the window; a bigger number means one '
        + 'exchange is being counted once per verdict written against it.',
    ).toBeLessThanOrEqual(Number(scores.totalExchanges));

    // EVERY VERDICT SHOULD LAND IN A BUCKET - REPORTED, NOT ASSERTED. The buckets are matched on the
    // classification STRING the judge returned, and the runner stores that string unvalidated, so a
    // verdict spelled off-rubric lands in no bucket. That is worth seeing (15 appropriate refusals
    // were absent from every number on the tab for exactly this reason), and it is not something this
    // spec may fail on: the input is the model's wording, so an assertion here would be an assertion
    // about the judge. `every-verdict-is-counted-somewhere.test.ts` pins the bucket set itself.
    const BUCKETS = ['excellent', 'good', 'partial', 'poor', 'appropriateRefusal'];
    const d = (scores.scoreDistribution || {}) as Record<string, number>;
    // EVERY BUCKET IS PUBLISHED, CHECKED BEFORE THEY ARE SUMMED. `appropriateRefusal` was omitted from
    // this object entirely until it was 7.5 percent of scored exchanges, and a sum over the remaining
    // four would have gone green throughout - `Number(undefined || 0)` is 0, so a missing bucket reads
    // as an empty one. The keys are asserted present so the sum below cannot be a sum of four things.
    const missing = BUCKETS.filter((k) => !(k in d));
    expect(
      missing,
      'the score distribution must publish every bucket, or a verdict class is absent from the tab '
        + `rather than merely empty on it. Missing: ${JSON.stringify(missing)}, got keys `
        + `${JSON.stringify(Object.keys(d))}`,
    ).toEqual([]);
    const bucketed = BUCKETS.reduce((a, k) => a + Number(d[k] || 0), 0);
    if (bucketed !== Number(scores.scoredCount)) {
      console.warn(
        `[evaluation-verdicts] ${Number(scores.scoredCount) - bucketed} scored verdict(s) landed in no `
        + `bucket: buckets sum to ${bucketed} against scored_count ${scores.scoredCount}. Those rows are `
        + 'absent from every figure on the Evaluations tab. Check what classification strings the '
        + 'judge is returning against the buckets in getEvaluationMetrics.',
      );
    }
    expect(
      bucketed,
      'the buckets partition the scored verdicts, so their sum cannot exceed the total; a bigger sum '
        + 'means a verdict is being counted in two buckets at once.',
    ).toBeLessThanOrEqual(Number(scores.scoredCount));

    // THE NULL-HONESTY BICONDITIONAL.
    const assessed = Number(scores.complianceAssessed ?? 0);
    const rate = scores.complianceRate;
    if (assessed === 0) {
      expect(
        rate,
        'nothing in this window carries a compliance verdict, so the rate has no denominator and must '
          + 'read as absent. A 0 here is the surface reporting a deployment in breach of its own rules '
          + 'on the strength of a population nobody judged - and a 100 is the same invention pointing '
          + 'the other way.',
      ).toBeNull();
    } else {
      expect(
        rate,
        `${assessed} exchange(s) carry a compliance verdict, so the rate has a denominator and must be `
          + 'published. A null with a non-empty population hides a real measurement.',
      ).not.toBeNull();
      expect(Number(rate), 'a compliance rate is a percentage').toBeGreaterThanOrEqual(0);
      expect(Number(rate), 'a compliance rate is a percentage').toBeLessThanOrEqual(100);
    }

    // ── THE SAME RULE, PER INTENT, ON THE SURFACE AURORA MODE ACTUALLY SHOWS ────────────────────
    //
    // Aurora hides the Evaluations tab in favour of the Effectiveness drill, so the per-intent rates
    // are where an operator reads compliance and groundedness. Same pairing, checked on every row -
    // one row coalescing its NULLs is enough to make the column unreadable.
    const eff = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'intent_effectiveness',
      dateRange,
    });
    const rows = (eff.data || []) as Record<string, unknown>[];
    expect(
      rows.length,
      'intent_effectiveness must answer over a window holding this run\'s traffic; an empty answer '
        + 'makes every pairing below vacuous.',
    ).toBeGreaterThan(0);
    expect(
      rows.some((r) => Number(r.relevance_scored_count || 0) > 0),
      'at least one intent must report scored relevance: this run scored an exchange inside the '
        + 'window, so a deployment-wide zero means the drill cannot see the verdicts the list can. '
        + `Rows: ${JSON.stringify(rows.map((r) => [r.intent, r.relevance_scored_count]))}`,
    ).toBe(true);

    // THE PAIRS ARE PUBLISHED AT ALL, CHECKED BEFORE THEY ARE COMPARED. A row missing BOTH halves - the
    // rate and its denominator - would satisfy the pairing below having measured nothing, because an
    // absent rate and an absent count agree perfectly. The population key is what makes a rate readable,
    // so its presence is the assertion, not an assumption.
    const RATE_PAIRS: Array<[string, string]> = [
      ['compliance_rate', 'compliance_assessed_count'],
      ['groundedness_rate', 'groundedness_assessed_count'],
    ];
    const unpublished = rows.flatMap((r) => RATE_PAIRS
      .flatMap(([rateKey, popKey]) => [rateKey, popKey])
      .filter((k) => !(k in r))
      .map((k) => `${r.intent}: ${k}`));
    expect(
      unpublished,
      'every rate and every population count must be published on every intent row. A rate whose '
        + 'denominator is absent cannot be read, and a pair that is absent together looks consistent '
        + `while saying nothing. Unpublished: ${JSON.stringify(unpublished)}`,
    ).toEqual([]);

    const mismatches: string[] = [];
    for (const r of rows) {
      for (const [rateKey, popKey] of RATE_PAIRS) {
        const pop = Number(r[popKey] ?? 0);
        const value = r[rateKey];
        const present = value !== null && value !== undefined;
        if (pop === 0 && present) mismatches.push(`${r.intent}: ${rateKey}=${value} over an EMPTY ${popKey}`);
        if (pop > 0 && !present) mismatches.push(`${r.intent}: ${rateKey} absent over ${popKey}=${pop}`);
      }
    }
    expect(
      mismatches,
      'a rate is published exactly when its population is non-empty. A rate over an empty population '
        + 'is an invented measurement, and a missing rate over a real one hides one that was taken. '
        + `Mismatches: ${JSON.stringify(mismatches)}`,
    ).toEqual([]);
  });
});
