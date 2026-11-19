/**
 * AN INTENT COUNTS THE WORK A TURN DID, WHEREVER A FIGURE IS GROUPED BY INTENT (ADR-064 decision I).
 *
 * A turn bound to a task counts under the task's type (`WORK_INTENT_SQL`), whatever its message was
 * classified as. Every per-intent rollup that reports quality, cost, latency, documents or ratings reads
 * that expression, so an intent's figures agree from one surface to the next. The queries that answer
 * what the classifier said (its agreement with a label, its distribution, a refusal it caused) read the
 * classified intent, and the console labels those "Classified as".
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, WORK_INTENT_SQL, __setContentReadRecorder } = require('../../lambda/src/analytics-aurora/analytics-query');
__setContentReadRecorder(async () => undefined);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyticsPathFor } = require('../helpers/analytics-path');

const RANGE = { start: '2026-11-06', end: '2026-11-12' };
const WORK = `COALESCE(${WORK_INTENT_SQL('e')}, 'unknown')`;

const call = async (body: Record<string, unknown>) => {
  const event = {
    httpMethod: 'POST',
    path: analyticsPathFor(body),
    body: JSON.stringify({ dateRange: RANGE, ...body }),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
  const res = await handler(event as never);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const sqlSent = (): string[] => mockDbQuery.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  mockDbQuery.mockReset().mockResolvedValue({ rows: [] });
  mockSend.mockReset().mockResolvedValue({ Items: [] });
});

describe('a rollup by intent counts a task turn under its task\'s type', () => {
  it.each([
    ['model_effectiveness', `${WORK} AS intent`],
    ['evaluation_scores', `${WORK} AS intent_type`],
    ['document_evaluation', `${WORK} AS intent`],
    ['message_flow', `COALESCE(${WORK_INTENT_SQL('e')}, upd.metadata->>'intent'`],
    ['intent_effectiveness', `${WORK_INTENT_SQL('e')} AS intent`],
  ])('%s', async (queryType, grouping) => {
    const res = await call({ queryType });
    expect(res.status).toBe(200);
    expect(sqlSent().some((s) => s.includes(grouping))).toBe(true);
    expect(sqlSent().some((s) => s.includes("COALESCE(e.intent, 'unknown') AS intent"))).toBe(false);
  });

  it('the ratings behind an intent are the ones its Effectiveness row counts', async () => {
    mockSend.mockResolvedValue({
      Items: [
        // Classified as general when cast; the turn worked on a report task.
        { userSub: 'p1', messageId: 'chime-1', feedback: 'up', createdAt: '2026-11-07T10:00:00Z', intent: 'general' },
        // Classified as report_generation when cast; the turn is not a task turn and counts as general.
        { userSub: 'p2', messageId: 'chime-2', feedback: 'down', createdAt: '2026-11-07T11:00:00Z', intent: 'report_generation' },
        // Not archived yet: the intent stamped on the vote stands.
        { userSub: 'p3', messageId: 'chime-3', feedback: 'up', createdAt: '2026-11-07T12:00:00Z', intent: 'report_generation' },
      ],
    });
    mockDbQuery.mockImplementation(async (sql: string) => (String(sql).includes('AS work_intent')
      ? { rows: [
        { message_id: 'chime-1', work_intent: 'report_generation', work_intent_only: 'report_generation', channel_arn: 'arn:c1' },
        { message_id: 'chime-2', work_intent: 'general', work_intent_only: 'general', channel_arn: 'arn:c2' },
      ] }
      : { rows: [] }));
    const res = await call({ queryType: 'user_ratings', intent: 'report_generation', accessReason: 'checking ratings' });
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ message_id: string; intent: string }>).map((r) => [r.message_id, r.intent]);
    expect(ids.sort()).toEqual([['chime-1', 'report_generation'], ['chime-3', 'report_generation']]);
  });

  it('reads the replies of only the ratings it returns, newest first, when no intent narrows the list', async () => {
    mockSend.mockResolvedValue({
      Items: Array.from({ length: 5 }, (_, n) => ({ userSub: `p${n}`, messageId: `chime-${n}`, feedback: 'up', createdAt: `2026-11-07T1${n}:00:00Z`, intent: 'general' })),
    });
    const res = await call({ queryType: 'user_ratings', limit: '2', accessReason: 'checking ratings' });
    expect(res.status).toBe(200);
    expect((res.body.data as Array<{ message_id: string }>).map((r) => r.message_id)).toEqual(['chime-4', 'chime-3']);
    const lookup = mockDbQuery.mock.calls.find((c) => String(c[0]).includes('AS work_intent'));
    expect(lookup?.[1]).toEqual([['chime-4', 'chime-3']]);
  });
});

describe('a list of ratings narrowed to one intent', () => {
  it('reads the replies of only the ratings it returns; the rest are read for their intent alone', async () => {
    mockSend.mockResolvedValue({
      Items: Array.from({ length: 5 }, (_, n) => ({ userSub: `p${n}`, messageId: `chime-${n}`, feedback: 'up', createdAt: `2026-11-07T1${n}:00:00Z`, intent: 'report_generation' })),
    });
    const res = await call({ queryType: 'user_ratings', intent: 'report_generation', limit: '2', accessReason: 'checking ratings' });
    expect(res.status).toBe(200);
    expect((res.body.data as Array<{ message_id: string }>).map((r) => r.message_id)).toEqual(['chime-4', 'chime-3']);
    const content = mockDbQuery.mock.calls.filter((c) => String(c[0]).includes('agent_response'));
    expect(content).toHaveLength(1);
    expect(content[0][1]).toEqual([['chime-4', 'chime-3']]);
    const intents = mockDbQuery.mock.calls.filter((c) => String(c[0]).includes('work_intent_only'));
    expect(String(intents[0][0])).not.toContain('content');
    expect(intents[0][1]).toEqual([['chime-4', 'chime-3', 'chime-2', 'chime-1', 'chime-0']]);
  });
});

describe('a query about what the classifier said reads the classified intent', () => {
  it.each([
    ['intent_distribution', "COALESCE(e.intent, 'unknown') AS intent"],
    ['routing_agreement', 'l.true_label = e.intent'],
    ['safety_readings', "COALESCE(e.intent, 'unknown') AS intent"],
  ])('%s', async (queryType, grouping) => {
    const res = await call({ queryType });
    expect(res.status).toBe(200);
    expect(sqlSent().some((s) => s.includes(grouping))).toBe(true);
  });
});
