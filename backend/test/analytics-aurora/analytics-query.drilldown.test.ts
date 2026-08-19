/**
 * The three drill-down queries, through the handler (DESIGN §4.3).
 *
 * Separate from `analytics-query.test.ts` because these need the DynamoDB tables the two human axes
 * live in, which must be set in the environment BEFORE the module is imported (the table names are
 * read at module scope). The predicate-level assertions on `experiment_exchanges` stay in the other
 * file; what is pinned here is the thing the feature is FOR: the numbers a drill-down reports must be
 * the numbers the console displays, or an operator cannot check the result they are shipping on.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

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
const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } } },
  } as unknown as APIGatewayProxyEvent;
}

/** A 30-day window, matching the console's default range. */
const RANGE = {
  start: new Date(Date.now() - 30 * DAY).toISOString(),
  end: new Date().toISOString(),
};

const call = async (body: Record<string, unknown>) => {
  const res = await handler(postEvent({ dateRange: RANGE, ...body }) as any);
  return JSON.parse(res.body);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ Items: [] });
});

// ---------------------------------------------------------------------------
// experiment_exchanges — the metric axes
// ---------------------------------------------------------------------------
describe('experiment_exchanges reports the FULL-MATCH aggregate, not the page', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    exchange_id: 'ex1',
    channel_arn: 'arn:chime:channel/one',
    created_at: ISO(1 * DAY),
    variant_id: 'control',
    relevance_score: 80,
    total_count: '120',
    avg_score_all: '74.5',
    scored_count: '96',
    withheld_count: '3',
    ...over,
  });

  it('carries the totals a paginated view needs to reconcile from page 3', async () => {
    // The reconciliation must hold on ANY page. Window aggregates are computed before LIMIT, so a
    // 25-row page still reports the mean over all 120 matches; without that, only a view that pulled
    // every row could be checked, and the acceptance criterion allows pagination.
    mockDbQuery.mockResolvedValueOnce({ rows: [row(), row({ exchange_id: 'ex2' })] });
    const body = await call({ queryType: 'experiment_exchanges', experimentId: 'exp1', offset: 50 });

    expect(body.total).toBe(120);
    expect(body.stats.avg_score).toBeCloseTo(74.5, 5);
    expect(body.stats.scored_count).toBe(96);
    expect(body.data).toHaveLength(2);
  });

  it('counts the withheld rows so a reconciling operator knows how many transcripts are missing', async () => {
    // A redacted exchange keeps its numbers and loses its transcript. The count of those is part of
    // the evidence: silently showing 3 fewer links is how a view stops being reproducible.
    mockDbQuery.mockResolvedValueOnce({ rows: [row()] });
    const body = await call({ queryType: 'experiment_exchanges', experimentId: 'exp1' });
    expect(body.stats.withheld_count).toBe(3);
  });

  it('an empty match reports zero rather than omitting the totals', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const body = await call({ queryType: 'experiment_exchanges', experimentId: 'exp1' });
    expect(body.total).toBe(0);
    expect(body.stats.avg_score).toBeNull();
  });

  it('echoes the axis and variant it actually served', async () => {
    // The view has to be able to say which population it is showing; taking that from the request
    // rather than the response would let a silently-defaulted axis be mislabelled.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const body = await call({
      queryType: 'experiment_exchanges',
      experimentId: 'exp1',
      axis: 'battle',
      variantId: 'treatment',
    });
    expect(body.axis).toBe('battle');
    expect(body.variantId).toBe('treatment');
  });
});

// ---------------------------------------------------------------------------
// experiment_feedback — the approval axis
// ---------------------------------------------------------------------------
describe('experiment_feedback returns the votes behind the approval rate', () => {
  const vote = (over: Record<string, unknown> = {}) => ({
    experimentId: 'exp1',
    variantId: 'control',
    intent: 'research',
    feedback: 'up',
    assignmentMode: 'probabilistic',
    createdAt: ISO(1 * DAY),
    userSub: 'u1',
    messageId: 'm1',
    channelArn: 'arn:chime:channel/one',
    ...over,
  });

  it('without an experimentId returns EMPTY and scans nothing', async () => {
    const body = await call({ queryType: 'experiment_feedback' });
    expect(body.data).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports a rate that matches the rows it returns', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        vote({ userSub: 'u1', messageId: 'm1', feedback: 'up' }),
        vote({ userSub: 'u2', messageId: 'm2', feedback: 'up' }),
        vote({ userSub: 'u3', messageId: 'm3', feedback: 'down' }),
      ],
    });
    const body = await call({ queryType: 'experiment_feedback', experimentId: 'exp1' });

    expect(body.total).toBe(3);
    expect(body.stats.thumbs_up).toBe(2);
    expect(body.stats.approval_rate).toBeCloseTo(66.7, 1);
    const up = body.data.filter((r: any) => r.feedback === 'up').length;
    expect(Math.round((up / body.data.length) * 1000) / 10).toBe(body.stats.approval_rate);
  });

  it('counts a REVISED vote once, so the row list and the rate agree', async () => {
    // The append-only table stores both records. A drill-down that showed two rows behind a
    // one-vote rate would prove the number wrong rather than support it.
    mockSend.mockResolvedValueOnce({
      Items: [
        vote({ feedback: 'up', createdAt: ISO(5 * DAY) }),
        vote({ feedback: 'down', createdAt: ISO(1 * DAY) }),
      ],
    });
    const body = await call({ queryType: 'experiment_feedback', experimentId: 'exp1' });

    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].feedback).toBe('down');
    expect(body.stats.approval_rate).toBe(0);
  });

  it('carries the conversation for each vote, so the rated reply can be read', async () => {
    mockSend.mockResolvedValueOnce({ Items: [vote({ channelArn: 'arn:chime:channel/xyz' })] });
    const body = await call({ queryType: 'experiment_feedback', experimentId: 'exp1' });
    expect(body.data[0].channel_arn).toBe('arn:chime:channel/xyz');
    expect(body.data[0].message_id).toBe('m1');
  });

  it('pages without losing the total', async () => {
    // "10 most recent" cannot reproduce a rate over 30. The page is a page; the total is the truth.
    mockSend.mockResolvedValueOnce({
      Items: Array.from({ length: 30 }, (_, i) =>
        vote({ userSub: `u${i}`, messageId: `m${i}`, feedback: i < 20 ? 'up' : 'down' }),
      ),
    });
    const body = await call({ queryType: 'experiment_feedback', experimentId: 'exp1', limit: 5 });

    expect(body.data).toHaveLength(5);
    expect(body.total).toBe(30);
    expect(body.stats.approval_rate).toBeCloseTo(66.7, 1);
  });

  it('excludes battle votes by default — they are not the approval population', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        vote({ userSub: 'u1', messageId: 'm1', assignmentMode: 'battle' }),
        vote({ userSub: 'u2', messageId: 'm2', assignmentMode: 'probabilistic' }),
      ],
    });
    const body = await call({ queryType: 'experiment_feedback', experimentId: 'exp1' });
    expect(body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// experiment_picks — the human axis
// ---------------------------------------------------------------------------
describe('experiment_picks returns the picks behind battle_wins', () => {
  const outcome = (battleId: string, over: Record<string, unknown> = {}) => ({
    battleId,
    votes: {
      'user-a': {
        winner: 'B',
        variantId: 'treatment',
        experimentId: 'exp1',
        intent: 'research',
        chosenAt: ISO(1 * DAY),
        ...over,
      },
    },
  });

  it('without an experimentId returns EMPTY and scans nothing', async () => {
    const body = await call({ queryType: 'experiment_picks' });
    expect(body.data).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is a DIFFERENT population from the battle turns — picks, not exchanges', async () => {
    // C3: one link cannot serve both. A duel produces two turns and at most one pick per user, so a
    // view that showed turns while labelling them picks would misreport the human axis.
    mockSend.mockResolvedValueOnce({ Items: [outcome('b1'), outcome('b2')] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const body = await call({ queryType: 'experiment_picks', experimentId: 'exp1' });

    expect(body.axis).toBe('picks');
    expect(body.total).toBe(2);
    expect(body.stats.treatment_wins).toBe(2);
    expect(body.stats.control_wins).toBe(0);
  });

  it('resolves each pick to its conversation by MATCHING the battle id, never decoding it', async () => {
    // battleId is sha256(channelArn:userMessageId) — one-way. The only route back is the archived
    // battle turns that carry it.
    mockSend.mockResolvedValueOnce({ Items: [outcome('b1')] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ battle_id: 'b1', channel_arn: 'arn:chime:channel/duel' }] });
    const body = await call({ queryType: 'experiment_picks', experimentId: 'exp1' });

    expect(body.data[0].channel_arn).toBe('arn:chime:channel/duel');
    expect(body.stats.unresolved_conversations).toBe(0);
  });

  it('keeps a pick whose conversation cannot be resolved, and SAYS how many', async () => {
    // The pick counted toward the win. Dropping it would make the drill-down disagree with the
    // number it explains; hiding the gap would overstate the evidence.
    mockSend.mockResolvedValueOnce({ Items: [outcome('b1')] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const body = await call({ queryType: 'experiment_picks', experimentId: 'exp1' });

    expect(body.data).toHaveLength(1);
    expect(body.data[0].channel_arn).toBeNull();
    expect(body.stats.unresolved_conversations).toBe(1);
  });

  it('a failed conversation lookup still renders the picks', async () => {
    mockSend.mockResolvedValueOnce({ Items: [outcome('b1')] });
    mockDbQuery.mockRejectedValueOnce(new Error('aurora unavailable'));
    const body = await call({ queryType: 'experiment_picks', experimentId: 'exp1' });
    expect(body.total).toBe(1);
    expect(body.data[0].channel_arn).toBeNull();
  });

  it('narrows to one variant', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        outcome('b1'),
        outcome('b2', { winner: 'A', variantId: 'control' }),
      ],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const body = await call({ queryType: 'experiment_picks', experimentId: 'exp1', variantId: 'control' });

    expect(body.total).toBe(1);
    expect(body.data[0].variant_id).toBe('control');
  });
});
