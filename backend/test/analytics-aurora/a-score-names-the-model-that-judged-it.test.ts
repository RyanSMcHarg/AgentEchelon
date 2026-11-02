/**
 * A SCORE NAMES THE MODEL THAT JUDGED IT.
 *
 * The Aurora evaluation runner stamps `evaluator_model` on every row it writes and has done since the
 * first migration. No query selected it and no surface showed it, so the column was recorded and
 * thrown away.
 *
 * WHY THAT MATTERS RATHER THAN BEING TIDINESS. Tenet P3: the harness outlives the model, and a model is
 * a replaceable function call, which makes swapping the judge an EXPECTED event rather than an edge
 * case. Every score re-baselines when it happens, so a fall in relevance is either a regression in the
 * assistant or a different judge, and the two are indistinguishable while the model is unreadable.
 * `rubric_version` already segregates rows scored under different prompt WORDING; the model is the
 * other axis of the same problem, and it was the axis nobody could see.
 *
 * ── WHAT IS PINNED, AND WHY IT EXECUTES THE PATH ────────────────────────────────────────────────
 *
 * The sibling guard `a-declared-column-is-actually-returned.test.ts` exists because a column named in
 * a response contract and absent from the SELECT list is a promise with no producer, and a text check
 * found six of those. A text check is not enough here: the point is that the value reaches a caller,
 * so these go through `handler` with the database mocked, assert on the SQL that was actually sent,
 * and assert on the body that actually came back.
 *
 * AURORA MODE ONLY. The four-pass Aurora runner is the one that writes this column. The Athena runner
 * scores relevance alone and records no judge, so the fields are ABSENT there rather than null, and the
 * console has to read absence as "not known" instead of as a single judge.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { edgeContext } from '../helpers/edge-context';

const mockDbQuery = jest.fn();
const mockSend = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

process.env.FEEDBACK_TABLE = 'UserFeedbackTest';
process.env.BATTLE_OUTCOME_TABLE = 'BattleOutcomeTest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/analytics-aurora/analytics-query');

const DAY = 24 * 60 * 60 * 1000;
const RANGE = {
  start: new Date(Date.now() - 30 * DAY).toISOString(),
  end: new Date().toISOString(),
};

/** A judge and its successor. The whole feature is about telling these two apart. */
const JUDGE = 'anthropic.claude-3-5-haiku-20241022-v1:0';
const NEXT_JUDGE = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

const call = async (body: Record<string, unknown>) => {
  const res = await handler(postEvent({ dateRange: RANGE, ...body }) as never);
  return JSON.parse(res.body);
};

/** Every SQL string the handler sent, so an assertion can name the query it means. */
const sqlSent = (): string[] => mockDbQuery.mock.calls.map((c) => String(c[0]));

/** The one statement carrying a marker unique to the query under test. */
function statementContaining(marker: string): string {
  const found = sqlSent().filter((s) => s.includes(marker));
  // Exactly one, so a shared fragment cannot make an assertion pass against the wrong query - the
  // failure shape the sibling guards in this directory keep running into.
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ Items: [] });
  // Anything the handler asks for beyond what a test stubs answers empty rather than undefined.
  mockDbQuery.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// The per-exchange rows behind the Effectiveness drill.
// ---------------------------------------------------------------------------
describe('intent_exchanges carries the judge on every row', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    exchange_id: 'ex1',
    relevance_score: 82,
    rubric_version: 'abc12345',
    evaluator_model: JUDGE,
    sample_stratum: 'sampled',
    total_count: '2',
    ...over,
  });

  it('selects the column from the evaluation join, so the row can name its judge', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [row()] });
    await call({ queryType: 'intent_exchanges', intent: 'general' });

    const sql = statementContaining('COUNT(*) OVER() AS total_count');
    // Read on the outer select AND aggregated in the join, because reading an alias that exposes no
    // such column is a runtime 42703 rather than a missing value.
    expect(sql).toContain('er.evaluator_model');
    expect(sql).toContain('MAX(evaluator_model) AS evaluator_model');
  });

  it('returns the judge to the caller', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [row(), row({ exchange_id: 'ex2' })] });
    const body = await call({ queryType: 'intent_exchanges', intent: 'general' });

    expect(body.data.map((r: Record<string, unknown>) => r.evaluator_model)).toEqual([JUDGE, JUDGE]);
  });

  it('leaves an older row NULL rather than naming the current judge', async () => {
    // A row scored before the column was read back has no judge to name. Filling in today's model
    // would attribute a score to a model that never saw it, which is worse than the gap: the surface
    // renders NULL as a dash, and a dash is the honest answer.
    mockDbQuery.mockResolvedValueOnce({ rows: [row({ evaluator_model: null })] });
    const body = await call({ queryType: 'intent_exchanges', intent: 'general' });

    expect(body.data[0].evaluator_model).toBeNull();
  });

  it('a row judged by a DIFFERENT model comes back as that model', async () => {
    // The whole point: two rows in one table that a reader must be able to refuse to average.
    mockDbQuery.mockResolvedValueOnce({
      rows: [row(), row({ exchange_id: 'ex2', evaluator_model: NEXT_JUDGE })],
    });
    const body = await call({ queryType: 'intent_exchanges', intent: 'general' });

    expect(new Set(body.data.map((r: Record<string, unknown>) => r.evaluator_model)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The Effectiveness rollup: the aggregate the drill hangs off.
// ---------------------------------------------------------------------------
describe('intent_effectiveness publishes the judge and how many judged the window', () => {
  const l0 = (over: Record<string, unknown> = {}) => ({
    intent: 'general',
    exchange_count: '100',
    avg_relevance: '71.0',
    relevance_scored_count: '64',
    rubric_version: 'abc12345',
    rubric_version_count: '1',
    evaluator_model: JUDGE,
    evaluator_model_count: '1',
    ...over,
  });

  it('aggregates the distinct judges beside the name, in the CTE the surface reads', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [l0()] });
    await call({ queryType: 'intent_effectiveness' });

    const sql = statementContaining('WITH ex_agg AS');
    expect(sql).toContain('COUNT(DISTINCT er.evaluator_model) AS evaluator_model_count');
    expect(sql).toContain('MAX(er.evaluator_model) AS evaluator_model');
    // Projected out of ex_agg as well. Six signals were once computed in this CTE, declared in the
    // response and left out of the outer select, which is the defect this line exists against.
    expect(sql).toContain('ex_agg.evaluator_model_count');
    expect(sql).toContain('ex_agg.evaluator_model');
  });

  it('declares both names in the response contract the console reads', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [l0()] });
    const body = await call({ queryType: 'intent_effectiveness' });

    expect(body.columns).toContain('evaluator_model');
    expect(body.columns).toContain('evaluator_model_count');
  });

  it('returns one judge as one, which is the case that prints a name', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [l0()] });
    const body = await call({ queryType: 'intent_effectiveness' });

    expect(body.data[0].evaluator_model).toBe(JUDGE);
    expect(Number(body.data[0].evaluator_model_count)).toBe(1);
  });

  it('returns a MIXED window as more than one, which is the case that warns', async () => {
    // An average over two judges is not one number, and this count is the only thing on the response
    // that says so.
    mockDbQuery.mockResolvedValueOnce({ rows: [l0({ evaluator_model_count: '2', evaluator_model: NEXT_JUDGE })] });
    const body = await call({ queryType: 'intent_effectiveness' });

    expect(Number(body.data[0].evaluator_model_count)).toBe(2);
  });

  it('an unjudged intent carries no judge and a zero count, never a defaulted name', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [l0({ avg_relevance: null, relevance_scored_count: '0', evaluator_model: null, evaluator_model_count: '0' })],
    });
    const body = await call({ queryType: 'intent_effectiveness' });

    expect(body.data[0].evaluator_model).toBeNull();
    expect(Number(body.data[0].evaluator_model_count)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The Evaluations view: the headline and its daily series.
// ---------------------------------------------------------------------------
describe('evaluation_scores says which judge produced the average', () => {
  const headline = (over: Record<string, unknown> = {}) => ({
    total_exchanges: '200',
    evaluated_exchanges: '150',
    avg_relevance_score: '73.4',
    scored_count: '150',
    evaluator_model: JUDGE,
    evaluator_model_count: '1',
    ...over,
  });

  const daily = (over: Record<string, unknown> = {}) => ({
    date: '2026-09-20',
    assistant: 'advisor',
    intent_type: 'general',
    count: '40',
    avg_relevance_score: '75.0',
    evaluator_model: JUDGE,
    evaluator_model_count: '1',
    ...over,
  });

  /** The headline query runs first, the daily breakdown second. */
  const stub = (h: Record<string, unknown>, d: Record<string, unknown>[]) => {
    mockDbQuery.mockResolvedValueOnce({ rows: [h] }).mockResolvedValueOnce({ rows: d });
  };

  // ── EACH CASE ASKS FOR ITS OWN WINDOW ──────────────────────────────────────────────────────────
  //
  // This handler memoizes by window, so a second call over the same range answers from the cache and
  // the mock rows for the case under test are never read. A test that hit that read the PREVIOUS
  // case's judge and passed or failed for a reason having nothing to do with its own fixture.
  let windowDays = 30;
  const scores = () => {
    windowDays += 1;
    return call({
      queryType: 'evaluation_scores',
      dateRange: { start: new Date(Date.now() - windowDays * DAY).toISOString(), end: RANGE.end },
    });
  };

  it('selects the judge in BOTH statements, so the headline and the series agree', async () => {
    stub(headline(), [daily()]);
    await scores();

    for (const marker of ['AS excellent_count', 'AS blocking_violation_count']) {
      const sql = statementContaining(marker);
      expect(sql).toContain('COUNT(DISTINCT er.evaluator_model) AS evaluator_model_count');
      expect(sql).toContain('MAX(er.evaluator_model) AS evaluator_model');
      // The DISTINCT ON subquery has to expose it or the read above is a 42703 at request time.
      expect(sql).toMatch(/evaluator_model\s*\n\s*FROM evaluation_results/);
    }
  });

  it('publishes the judge and the distinct count on the response', async () => {
    stub(headline(), [daily()]);
    const body = await scores();

    expect(body.evaluatorModel).toBe(JUDGE);
    expect(body.evaluatorModelCount).toBe(1);
  });

  it('counts a mixed window as two, so the tab can refuse the single average', async () => {
    stub(headline({ evaluator_model_count: '2' }), [daily(), daily({ date: '2026-09-21', evaluator_model: NEXT_JUDGE })]);
    const body = await scores();

    expect(body.evaluatorModelCount).toBe(2);
  });

  it('reports no judge and a zero count on a window nothing has scored', async () => {
    // Nothing judged is not "one judge". A defaulted name here would let the tab claim an instrument
    // for an average that does not exist.
    stub(headline({ evaluator_model: null, evaluator_model_count: '0', scored_count: '0' }), []);
    const body = await scores();

    expect(body.evaluatorModel).toBeNull();
    expect(body.evaluatorModelCount).toBe(0);
  });

  it('carries the judge on each daily row, so a re-baseline has a date', async () => {
    stub(headline({ evaluator_model_count: '2' }), [daily(), daily({ date: '2026-09-21', evaluator_model: NEXT_JUDGE })]);
    const body = await scores();

    expect(body.data.map((r: Record<string, unknown>) => r.evaluator_model)).toEqual([JUDGE, NEXT_JUDGE]);
  });

  it('a daily group spanning a swap says how many, rather than naming one of them', async () => {
    stub(headline({ evaluator_model_count: '2' }), [daily({ evaluator_model_count: '2' })]);
    const body = await scores();

    expect(Number(body.data[0].evaluator_model_count)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The per-exchange evaluation list.
// ---------------------------------------------------------------------------
describe('evaluation_exchanges carries the judge with the verdict', () => {
  it('returns the model beside the classification it produced', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ex1',
        classification: 'good',
        relevance_score: 80,
        is_compliant: true,
        evaluator_model: JUDGE,
        user_message: 'hello',
        agent_response: 'hi',
      }],
    });
    const body = await call({ queryType: 'evaluation_exchanges' });

    expect(body.data[0].evaluator_model).toBe(JUDGE);
    // The verdict and its judge travel together; a classification whose judge is unknown cannot be
    // compared with one scored later.
    expect(body.data[0].classification).toBe('good');
  });

  it('exposes the column on the join it is read from', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await call({ queryType: 'evaluation_exchanges' });

    const sql = statementContaining('COALESCE(am.updated_content, am.content) AS agent_response');
    expect(sql).toContain('er.evaluator_model');
    expect(sql).toMatch(/evaluator_model\s*\n\s*FROM evaluation_results/);
  });

  it('renders nothing for an older row rather than inventing a judge', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 'ex1', classification: 'good', evaluator_model: null, user_message: 'a', agent_response: 'b' }],
    });
    const body = await call({ queryType: 'evaluation_exchanges' });

    expect(body.data[0].evaluator_model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The write half, so the reader and the writer cannot drift apart.
// ---------------------------------------------------------------------------
describe('the column the reader selects is the column the runner writes', () => {
  it('the Aurora runner stamps the judge on every exchange it scores', () => {
    // Source-level, because the write cannot be exercised without a database. It pins the pairing:
    // if the runner ever renames this column the queries above return nothing and say nothing, which
    // is the silent shape the surfaces were in before they read it at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const runner = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts'),
      'utf8',
    );
    const at = runner.indexOf('INSERT INTO evaluation_results');
    expect(at).toBeGreaterThan(-1);
    expect(runner.slice(at, at + 900)).toContain('evaluator_model');
    // A VISION-JUDGED IMAGE TURN NAMES ITS OWN JUDGE. An image_generation turn is scored by the vision
    // judge, so stamping the text judge there would make the column name a model that never saw it -
    // the same defect `rubric_version` already had once in this file.
    expect(runner).toContain('evaluatorModel = img.model;');
  });
});
