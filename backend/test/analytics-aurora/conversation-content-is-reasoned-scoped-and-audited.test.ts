/**
 * CONVERSATION CONTENT IS READ UNDER THE CONTENT CAPABILITY, WITH A STATED REASON, AUDITED AND SCOPED.
 *
 * The analytics API serves labels and counts under `view-analytics`, and everything that returns what
 * was said (a transcript, a summary, a message and its answer, a rating's note) under `view-events`, on
 * every route that serves it, POST and GET alike. Each content read states a reason and writes an audit
 * line, and every row it returns is narrowed to the caller's classification scope - the transcript under
 * `messages` included.
 *
 * Also pinned here: the GET routes are scoped as the POST is, an analytics window is validated and
 * bounded in one place, and a moderation audit row names only a moderation the archive holds.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ownerQuery: jest.fn().mockResolvedValue({ rows: [] }),
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));
// The cross-conversation context reads once per classification under that classification's reader role.
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: jest.fn(async (_classification: string, fn: (c: { query: typeof mockDbQuery }) => unknown) => fn({ query: mockDbQuery })),
  withWriterRole: jest.fn(async (fn: (c: { query: typeof mockDbQuery }) => unknown) => fn({ query: mockDbQuery })),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';
const SCOPED_ROLE = 'App-QualityRole-abc';
const FULL_ROLE = 'App-AdminRole-def';
process.env.CLASSIFICATION_ROLE_SCOPES = JSON.stringify([
  { role: `arn:aws:iam::111122223333:role/${SCOPED_ROLE}`, scope: 'basic' },
  { role: `arn:aws:iam::111122223333:role/${FULL_ROLE}`, scope: 'full' },
]);

import { handler, MAX_WINDOW_DAYS, __setContentReadRecorder } from '../../lambda/src/analytics-aurora/analytics-query';
import { __clearScopeCache } from '../../lambda/src/lib/caller-scope';
import { analyticsPathFor } from '../helpers/analytics-path';

const assumed = (role: string) => `arn:aws:sts::111122223333:assumed-role/${role}/session`;

function post(body: Record<string, unknown>, opts: { role?: string; path?: string } = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: opts.path ?? analyticsPathFor(body),
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: assumed(opts.role ?? FULL_ROLE) } },
  } as unknown as APIGatewayProxyEvent;
}

function get(path: string, params: Record<string, string> = {}, role = FULL_ROLE): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path,
    queryStringParameters: params,
    requestContext: { identity: { userArn: assumed(role) } },
  } as unknown as APIGatewayProxyEvent;
}

const CONTENT_QUERIES = [
  'channel_events', 'cross_conversation_context', 'conversation_summaries', 'evaluation_exchanges',
  'flagged_responses', 'ground_truth', 'label_queue', 'user_ratings',
];
const CONTENT_GETS = ['/analytics/conversations', '/analytics/context', '/analytics/evaluation/exchanges'];

let logSpy: jest.SpyInstance;
const auditLines = (): Array<Record<string, unknown>> => logSpy.mock.calls
  .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
  .filter((l): l is Record<string, unknown> => !!l && l._auditEvent === 'analytics_content_read');

beforeAll(() => __clearScopeCache());
const recorded: Array<Record<string, unknown>> = [];
beforeEach(() => {
  recorded.length = 0;
  __setContentReadRecorder(async (line) => { recorded.push(line); });
  mockDbQuery.mockReset().mockResolvedValue({ rows: [] });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => logSpy.mockRestore());

describe('a view-analytics caller reaches no conversation content', () => {
  it.each(CONTENT_QUERIES)('%s is refused on the analytics root, before any query runs', async (queryType) => {
    const res = await handler(post({ queryType, channelArn: 'arn:c', personId: 'p1', accessReason: 'curious' }, { path: '/query' }));
    expect(res.statusCode).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe('a content-capable caller reads content with a stated reason, and the read is audited', () => {
  it.each(CONTENT_QUERIES)('%s without a reason is refused with REASON_REQUIRED', async (queryType) => {
    const res = await handler(post({ queryType, channelArn: 'arn:c', personId: 'p1' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('REASON_REQUIRED');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('serves the transcript with a reason, and records who read which conversation and why', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ conversation_classification: 'premium', message_id: 'm1', content: 'hello', sender: 'Ada', sender_arn: 'arn:u' }],
    });
    const res = await handler(post({ queryType: 'conversation_summaries', channelArn: 'arn:c', accessReason: 'a reported message' }));
    expect(res.statusCode).toBe(200);
    // A Full caller (an administrator holding both capabilities) sees what it always saw.
    expect(JSON.parse(res.body).messages).toHaveLength(1);
    expect(auditLines()).toEqual([expect.objectContaining({
      queryType: 'conversation_summaries', channelArn: 'arn:c', reason: 'a reported message', scope: 'full',
    })]);
  });

  it('records the read in the access log, naming the reader, the conversation, the scope and the reason', async () => {
    const res = await handler(post({ queryType: 'flagged_responses', accessReason: 'a reported wrong answer' }));
    expect(res.statusCode).toBe(200);
    expect(recorded).toEqual([expect.objectContaining({
      _auditEvent: 'analytics_content_read', capabilities: ['view-events'], queryType: 'flagged_responses',
      scope: 'full', reason: 'a reported wrong answer',
    })]);
  });

  it('refuses a content read it cannot record, before any query runs', async () => {
    __setContentReadRecorder(async () => { throw new Error('table down'); });
    const res = await handler(post({ queryType: 'flagged_responses', accessReason: 'a reported wrong answer' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('ACCESS_LOG_UNAVAILABLE');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each(CONTENT_GETS)('GET %s states a reason too', async (path) => {
    const refused = await handler(get(path, { personId: 'p1', channelArn: 'arn:c' }));
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body).code).toBe('REASON_REQUIRED');
    expect(mockDbQuery).not.toHaveBeenCalled();

    const res = await handler(get(path, { personId: 'p1', channelArn: 'arn:c', accessReason: 'an audit request' }));
    expect(res.statusCode).toBe(200);
    expect(auditLines()).toEqual([expect.objectContaining({ path, reason: 'an audit request' })]);
  });

  it('asks no reason of an aggregate', async () => {
    const res = await handler(post({ queryType: 'model_usage' }));
    expect(res.statusCode).toBe(200);
    expect(auditLines()).toEqual([]);
  });

  // The Alerts tab is assembled from these reads, so opening it asks for no reason.
  it.each(['intent_effectiveness', 'latency_metrics', 'model_effectiveness', 'error_rate_daily'])(
    'answers %s, an Alerts read, without a reason and on the analytics root',
    async (queryType) => {
      const res = await handler(post({ queryType }, { path: '/query' }));
      expect(res.statusCode).toBe(200);
      expect(auditLines()).toEqual([]);
    },
  );

  it('counts error-response replies on the per-intent aggregate, without their content', async () => {
    await handler(post({ queryType: 'intent_effectiveness' }, { path: '/query' }));
    const sql = mockDbQuery.mock.calls.map((c) => String(c[0])).find((q) => q.includes('ex_agg')) ?? '';
    expect(sql).toMatch(/AS error_response_count/);
    expect(sql).toMatch(/BOOL_OR\(classification = 'error_response'\) AS is_error_response/);
    // A count, not the replies: the aggregate never selects a message's text.
    expect(sql).not.toMatch(/um\.content|am\.content|AS user_message|AS agent_response/);
  });
});

describe('content rows are narrowed to the caller\'s scope', () => {
  it('scopes the transcript under `messages` by the room\'s classification', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ conversation_classification: 'premium', message_id: 'm1', content: 'above the scope' }],
    });
    const above = await handler(post({ queryType: 'conversation_summaries', channelArn: 'arn:c', accessReason: 'r' }, { role: SCOPED_ROLE }));
    expect(above.statusCode).toBe(200);
    expect(JSON.parse(above.body).messages).toEqual([]);
    // The detail query names the room's classification on every message it returns.
    expect(String(mockDbQuery.mock.calls[0][0])).toMatch(/room\.classification AS conversation_classification/);

    mockDbQuery.mockResolvedValue({
      rows: [{ conversation_classification: 'basic', message_id: 'm2', content: 'in scope' }],
    });
    const within = await handler(post({ queryType: 'conversation_summaries', channelArn: 'arn:c', accessReason: 'r' }, { role: SCOPED_ROLE }));
    expect(JSON.parse(within.body).messages.map((m: { message_id: string }) => m.message_id)).toEqual(['m2']);
  });

  it('withholds a transcript whose room has no classification', async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ conversation_classification: null, message_id: 'm1', content: 'unclassified' }] });
    const res = await handler(post({ queryType: 'conversation_summaries', channelArn: 'arn:c', accessReason: 'r' }, { role: SCOPED_ROLE }));
    expect(JSON.parse(res.body).messages).toEqual([]);
  });

  it('narrows the query\'s own row key as well as `data`, so no field carries a withheld row', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { channel_arn: 'arn:a', conversation_classification: 'basic', summary: 'ok' },
        { channel_arn: 'arn:b', conversation_classification: 'premium', summary: 'withheld' },
        { channel_arn: 'arn:c', conversation_classification: null, summary: 'unclassified' },
      ],
    });
    const res = await handler(post({ queryType: 'conversation_summaries', accessReason: 'r' }, { role: SCOPED_ROLE }));
    const body = JSON.parse(res.body);
    expect(body.data.map((r: { channel_arn: string }) => r.channel_arn)).toEqual(['arn:a']);
    expect(body.conversations.map((r: { channel_arn: string }) => r.channel_arn)).toEqual(['arn:a']);
  });

  it('drops a content row that carries no classification at all, for a scoped caller', async () => {
    // The event log's rows carry no classification of their own.
    mockDbQuery.mockResolvedValue({ rows: [{ event_type: 'CREATE_CHANNEL_MESSAGE', message_id: 'm1', content: 'x', created_at: 't' }] });
    const res = await handler(post({ queryType: 'channel_events', channelArn: 'arn:c', accessReason: 'r' }, { role: SCOPED_ROLE }));
    expect(JSON.parse(res.body).data).toEqual([]);
  });
});

describe('the GET routes are scoped as the POST is', () => {
  it('narrows GET /analytics/conversations to the scope', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { channel_arn: 'arn:a', conversation_classification: 'basic' },
        { channel_arn: 'arn:b', conversation_classification: 'premium' },
      ],
    });
    const res = await handler(get('/analytics/conversations', { accessReason: 'r' }, SCOPED_ROLE));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).conversations.map((r: { channel_arn: string }) => r.channel_arn)).toEqual(['arn:a']);
  });

  it('narrows an aggregate GET too, dropping an unclassifiable row and keeping a dimensionless one', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { id: 'f1', conversation_classification: 'basic' },
        { id: 'f2', conversation_classification: 'premium' },
        { id: 'f3', conversation_classification: 'unknown' },
        { id: 'f4' },
      ],
    });
    const res = await handler(get('/analytics/evaluation/flows', {}, SCOPED_ROLE));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).flows.map((r: { id: string }) => r.id)).toEqual(['f1', 'f4']);
  });

  it('leaves a Full caller\'s GET unchanged', async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ id: 'f2', conversation_classification: 'premium' }] });
    const res = await handler(get('/analytics/evaluation/flows'));
    expect(JSON.parse(res.body).flows).toHaveLength(1);
  });
});

describe('an analytics window is validated and bounded in one place', () => {
  it.each(['abc', '0', '-3', '1.5', '7days'])('refuses days=%s with a 400 that says what was wrong', async (days) => {
    const res = await handler(get('/analytics/evaluation/flows', { days }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/days must be a whole number/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('refuses a named window missing a bound, unparseable, or ending before it starts', async () => {
    for (const params of [
      { windowStart: '2026-09-01T00:00:00Z' },
      { windowStart: 'yesterday', windowEnd: '2026-09-02T00:00:00Z' },
      { windowStart: '2026-09-02T00:00:00Z', windowEnd: '2026-09-01T00:00:00Z' },
    ] as Array<Record<string, string>>) {
      const res = await handler(get('/analytics/evaluation/flows', params));
      expect(res.statusCode).toBe(400);
    }
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it(`bounds a query that states no cap of its own to ${MAX_WINDOW_DAYS} days, keeping the window's end`, async () => {
    const DAY = 86_400_000;
    await handler(get('/analytics/evaluation/flows', { days: '5000' }));
    const trailing = String((mockDbQuery.mock.calls[0][1] as unknown[])[0]);
    const lo = Date.parse(/^\[([^,]+),/.exec(trailing)![1]);
    expect(Date.now() - lo).toBeLessThanOrEqual(MAX_WINDOW_DAYS * DAY + 5_000);
    expect(Date.now() - lo).toBeGreaterThanOrEqual(MAX_WINDOW_DAYS * DAY - 5_000);

    mockDbQuery.mockClear();
    await handler(post({ queryType: 'evaluation_flows', dateRange: { start: '2024-01-01', end: '2026-08-31' } }));
    const named = String((mockDbQuery.mock.calls[0][1] as unknown[])[0]);
    const [, from, to] = /^\[([^,]+),([^)]+)\)$/.exec(named)!;
    expect(Date.parse(to)).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(Date.parse(to) - Date.parse(from)).toBe(MAX_WINDOW_DAYS * DAY);
  });
});

describe('a moderation audit row names a moderation the archive holds', () => {
  const record = (moderation: 'redact' | 'delete' = 'redact') =>
    post({ queryType: 'record_moderation', channelArn: 'arn:c', messageId: 'm1', moderation });
  const inserted = () => mockDbQuery.mock.calls.some(([sql]) => /INSERT INTO moderation_actions/.test(String(sql)));
  const stateIs = (archived: boolean, moderated: boolean) => mockDbQuery.mockImplementation(async (sql: string) =>
    (/AS archived/.test(String(sql)) ? { rows: [{ archived, moderated }] } : { rows: [] }));

  it('refuses a message that is not in that conversation\'s archive', async () => {
    stateIs(false, false);
    const res = await handler(record());
    expect(res.statusCode).toBe(404);
    expect(inserted()).toBe(false);
  });

  it('refuses a message the archive holds no moderation of, so the console can retry', async () => {
    stateIs(true, false);
    const res = await handler(record('delete'));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('MODERATION_NOT_RECORDED');
    expect(inserted()).toBe(false);
    // It asked about the deletion it would attribute, not any moderation.
    const [, params] = mockDbQuery.mock.calls.find(([sql]) => /AS archived/.test(String(sql)))! as [string, unknown[]];
    expect(params).toEqual(['arn:c', 'm1', 'm1-DEL', 'DELETE_CHANNEL_MESSAGE']);
  });

  it('records a moderation the archive holds', async () => {
    stateIs(true, true);
    const res = await handler(record());
    expect(res.statusCode).toBe(200);
    expect(inserted()).toBe(true);
  });
});
