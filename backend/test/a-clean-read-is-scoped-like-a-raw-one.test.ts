/**
 * A READ OF THE DE-IDENTIFIED COPY IS SCOPED LIKE A RAW ONE (SPEC-ADMIN-CONSOLE FR54).
 *
 * It needs a stated reason, stays inside the caller's classification scope, and for a team member covers
 * only a conversation its assistant was in and only the periods it was there. A message removed in the
 * archive after the copy was derived shows as removed, never with its text, before the next run.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockClean = jest.fn();
const mockHistory = jest.fn();
jest.mock('../lambda/src/lib/data-plane-client.js', () => ({
  hasDataPlane: () => true,
  adminListConversations: jest.fn(),
  adminListMessages: jest.fn(),
  adminMembershipHistory: (...a: unknown[]) => mockHistory(...a),
  adminCleanConversation: (...a: unknown[]) => mockClean(...a),
}));
jest.mock('@aws-sdk/client-athena', () => ({
  AthenaClient: jest.fn(() => ({ send: jest.fn() })),
  StartQueryExecutionCommand: jest.fn(), GetQueryExecutionCommand: jest.fn(), GetQueryResultsCommand: jest.fn(),
  QueryExecutionState: { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Parameter: { Value: '' } }) })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });
jest.mock('../lambda/src/lib/caller-scope.js', () => ({
  ...jest.requireActual('../lambda/src/lib/caller-scope.js'),
  scopeForRequest: () => null,
}));
const mockScope = jest.fn();
jest.mock('../lambda/src/lib/assistant-scope.js', () => ({
  ...jest.requireActual('../lambda/src/lib/assistant-scope.js'),
  requireOwnedAssistant: (...a: unknown[]) => mockScope(...a),
}));
const mockQuery = jest.fn();
jest.mock('../lambda/src/analytics-aurora/db-client', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn() }));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const BOT = `${APP}/bot/hr-standard`;
// THE ACCESS LOG (ADR-052): a read is recorded before its content is returned, so the tests stand one in.
const mockRecordAccess = jest.fn().mockResolvedValue({});
jest.mock('../lambda/src/lib/access-log.js', () => ({
  ...jest.requireActual('../lambda/src/lib/access-log.js'),
  recordAccess: (...a: unknown[]) => mockRecordAccess(...a),
}));

process.env.APP_INSTANCE_ARN = APP;
process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:1:function:data-plane';
process.env.ADMIN_GROUP_NAMES = 'admins';
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler } from '../lambda/src/admin-conversations';
import { adminCleanConversation } from '../lambda/src/analytics-aurora/clean-copy';

const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
const row = (seq: number, minute: number) => ({ seq, kind: 'message', occurredAt: at(minute), actor: 'Person 1', actorKind: 'person', action: null, subject: null, text: `t${seq}`, originalText: null, state: 'present' });

const read = (team: boolean, query: Record<string, string> | null = { reason: 'review' }): APIGatewayProxyEvent => ({
  httpMethod: 'GET',
  path: team ? '/admin/assistants/hr/conversations/conv-1/clean' : '/admin/conversations/conv-1/clean',
  headers: { origin: 'http://localhost:5173' },
  pathParameters: team ? { assistant: 'hr', channelId: 'conv-1' } : { channelId: 'conv-1' },
  queryStringParameters: query,
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/ae-${team ? 'team' : 'admin'}-console/console-sub${team ? '@standard' : ''}` } },
} as unknown as APIGatewayProxyEvent);
const body = (r: { body: string }) => JSON.parse(r.body);

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAccess.mockResolvedValue({});
  mockScope.mockImplementation(async (e: APIGatewayProxyEvent) => (e.pathParameters?.assistant ? { assistant: 'hr', bots: [{ assistant: 'hr', botArn: BOT, classification: 'standard' }] } : null));
  mockClean.mockResolvedValue({ rows: [row(0, 1), row(1, 5), row(2, 12)], derivedAt: at(30), classification: 'standard' });
  mockHistory.mockResolvedValue([
    { action: 'joined', memberArn: BOT, timestamp: at(3) },
    { action: 'left', memberArn: BOT, timestamp: at(10) },
  ]);
});

describe('reading the de-identified copy', () => {
  it('gives an admin the whole copy and when it was derived', async () => {
    const r = await handler(read(false));
    expect(r.statusCode).toBe(200);
    expect(body(r).rows).toHaveLength(3);
    expect(body(r).derivedAt).toBe(at(30));
  });

  it('gives a team only the periods its assistant was in the conversation', async () => {
    const r = await handler(read(true));
    expect(r.statusCode).toBe(200);
    expect(body(r).rows.map((x: { seq: number }) => x.seq)).toEqual([1]);
  });

  it('answers a team as not found for a conversation its assistant was never in', async () => {
    mockHistory.mockResolvedValue([]);
    const r = await handler(read(true));
    expect(r.statusCode).toBe(404);
    expect(mockClean).not.toHaveBeenCalled();
  });

  it('requires a stated reason, and reads nothing without one', async () => {
    const r = await handler(read(false, null));
    expect(r.statusCode).toBe(400);
    expect(body(r).code).toBe('REASON_REQUIRED');
    expect(mockClean).not.toHaveBeenCalled();
  });

  it('is in the access log with its reason, for an admin and for a team', async () => {
    await handler(read(false));
    await handler(read(true));
    expect(mockRecordAccess).toHaveBeenCalledTimes(2);
    for (const [line] of mockRecordAccess.mock.calls) {
      expect(line).toMatchObject({ _auditEvent: 'clean_conversation_read', capabilities: ['view-clean-conversations'], reason: 'review' });
    }
  });

  it('is refused, and returns no row, when the read cannot be recorded', async () => {
    mockRecordAccess.mockRejectedValue(new Error('the access record could not be written'));
    const r = await handler(read(false));
    expect(r.statusCode).toBe(503);
    expect(body(r).code).toBe('ACCESS_LOG_UNAVAILABLE');
    expect(body(r).rows).toBeUndefined();
  });
});

describe('a removal reaches the copy at read time', () => {
  it('shows a message removed after the copy was derived as removed, with no text', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [
        { seq: 0, kind: 'message', occurred_at: at(1), actor: 'Person 1', actor_kind: 'person', action: null, subject: null, text: 'kept', original_text: null, state: 'present', redacted_now: false, deleted_now: false },
        { seq: 1, kind: 'message', occurred_at: at(2), actor: 'Person 1', actor_kind: 'person', action: null, subject: null, text: 'said then', original_text: 'first', state: 'present', redacted_now: true, deleted_now: false },
      ] })
      .mockResolvedValueOnce({ rows: [{ derived_at: at(30), classification: 'standard' }] });
    const copy = await adminCleanConversation({ channelArn: `${APP}/channel/conv-1` });
    expect(copy.rows[0]).toMatchObject({ state: 'present', text: 'kept' });
    expect(copy.rows[1]).toMatchObject({ state: 'redacted', text: null, originalText: null });
    expect(String(mockQuery.mock.calls[0][0])).toContain("r.source_message_id || '-RED'");
  });
});
