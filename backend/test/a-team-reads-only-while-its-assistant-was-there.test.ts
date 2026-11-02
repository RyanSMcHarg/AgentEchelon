/**
 * A TEAM READS A CONVERSATION ONLY FOR THE PERIOD ITS ASSISTANT WAS IN IT (SPEC-ADMIN-CONSOLE, "Membership period").
 *
 * Owning an assistant that was a member of a conversation is the team's reason to read it, and that
 * reason does not reach turns from before the assistant joined or after it left. Without the bound,
 * adding an assistant to a conversation would widen its team's read to the whole history. The read also
 * requires a stated reason, like the admin read, and a conversation the assistant was never in answers as
 * not found.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { membershipPeriods, withinPeriods } from '../lambda/src/lib/membership-period';

const mockMessages = jest.fn();
const mockHistory = jest.fn();
jest.mock('../lambda/src/lib/data-plane-client.js', () => ({
  hasDataPlane: () => true,
  adminListConversations: jest.fn(),
  adminListMessages: (...a: unknown[]) => mockMessages(...a),
  adminMembershipHistory: (...a: unknown[]) => mockHistory(...a),
}));
jest.mock('@aws-sdk/client-athena', () => ({
  AthenaClient: jest.fn(() => ({ send: jest.fn() })),
  StartQueryExecutionCommand: jest.fn(),
  GetQueryExecutionCommand: jest.fn(),
  GetQueryResultsCommand: jest.fn(),
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
const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const BOT = `${APP}/bot/hr-standard`;
const OTHER_BOT = `${APP}/bot/finance-standard`;
const mockScope = jest.fn();
jest.mock('../lambda/src/lib/assistant-scope.js', () => ({
  ...jest.requireActual('../lambda/src/lib/assistant-scope.js'),
  requireOwnedAssistant: (...a: unknown[]) => mockScope(...a),
}));

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

const CHANNEL_ID = 'conv-1';
const CHANNEL_ARN = `${APP}/channel/${CHANNEL_ID}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
const msg = (id: string, minute: number) => ({ id, content: id, senderArn: 'u', timestamp: at(minute), isBot: false, redacted: false });

const read = (query: Record<string, string> | null = { reason: 'customer escalation' }): APIGatewayProxyEvent => ({
  httpMethod: 'GET',
  path: `/admin/assistants/hr/conversations/${CHANNEL_ID}/messages`,
  headers: { origin: 'http://localhost:5173' },
  pathParameters: { assistant: 'hr', channelId: CHANNEL_ID },
  queryStringParameters: query,
  requestContext: { identity: { userArn: 'arn:aws:sts::1:assumed-role/ae-team-console/console-sub@standard' } },
} as unknown as APIGatewayProxyEvent);
const body = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAccess.mockResolvedValue({});
  mockScope.mockResolvedValue({ assistant: 'hr', bots: [{ assistant: 'hr', botArn: BOT, classification: 'standard' }] });
  mockMessages.mockResolvedValue([msg('before', 1), msg('during', 5), msg('after', 12), msg('again', 20)]);
  mockHistory.mockResolvedValue([
    { action: 'joined', memberArn: BOT, timestamp: at(3) },
    { action: 'left', memberArn: BOT, timestamp: at(10) },
    { action: 'joined', memberArn: OTHER_BOT, timestamp: at(0) },
    { action: 'joined', memberArn: BOT, timestamp: at(18) },
  ]);
});

describe('a team reading a conversation', () => {
  it('sees only the turns from while its assistant was a member', async () => {
    const res = await handler(read());
    expect(res.statusCode).toBe(200);
    expect(body(res).messages.map((m: { id: string }) => m.id)).toEqual(['during', 'again']);
    expect(body(res).periods).toEqual([{ from: at(3), to: at(10) }, { from: at(18), to: null }]);
  });

  it('answers a conversation its assistant was never in as not found', async () => {
    mockHistory.mockResolvedValue([{ action: 'joined', memberArn: OTHER_BOT, timestamp: at(0) }]);
    const res = await handler(read());
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('CONVERSATION_NOT_FOUND');
    expect(mockMessages).not.toHaveBeenCalled();
  });

  it('requires a stated reason, and reads nothing without one', async () => {
    const res = await handler(read(null));
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('REASON_REQUIRED');
    expect(mockHistory).not.toHaveBeenCalled();
    expect(mockMessages).not.toHaveBeenCalled();
  });

  it('records the reason and the periods it was bounded to', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler(read());
    const audit = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('team_conversation_read'));
    log.mockRestore();
    expect(JSON.parse(audit!)).toMatchObject({ assistant: 'hr', channelArn: CHANNEL_ARN, reason: 'customer escalation', messages: 2 });
  });

  it('is in the access log, with the person, the conversation and the reason, before anything is returned', async () => {
    const res = await handler(read());
    expect(res.statusCode).toBe(200);
    expect(mockRecordAccess).toHaveBeenCalledTimes(1);
    expect(mockRecordAccess.mock.calls[0][0]).toMatchObject({
      _auditEvent: 'team_conversation_read',
      channelArn: CHANNEL_ARN,
      assistant: 'hr',
      capabilities: ['view-messages'],
      reason: 'customer escalation',
    });
  });

  it('is refused, and returns no message, when the read cannot be recorded', async () => {
    mockRecordAccess.mockRejectedValue(new Error('the access record could not be written'));
    const res = await handler(read());
    expect(res.statusCode).toBe(503);
    expect(body(res).code).toBe('ACCESS_LOG_UNAVAILABLE');
    expect(body(res).messages).toBeUndefined();
    expect(res.body).not.toContain('during');
  });

  it('sees only the versions of an edited message made while its assistant was a member', async () => {
    // Said at 5 (in), edited at 7 (in), edited again at 12 (after the assistant left at 10).
    mockMessages.mockResolvedValue([{
      ...msg('during', 5),
      content: 'third',
      versions: [{ at: at(5), content: 'first' }, { at: at(7), content: 'second' }, { at: at(12), content: 'third' }],
    }]);
    const [m] = body(await handler(read())).messages;
    expect(m.versions.map((v: { content: string }) => v.content)).toEqual(['first', 'second']);
    expect(m.content).toBe('second');
    expect(JSON.stringify(m)).not.toContain('third');
  });

  it('is refused for an assistant the team does not own, before any read', async () => {
    mockScope.mockResolvedValue({ statusCode: 403, headers: {}, body: JSON.stringify({ code: 'ASSISTANT_NOT_OWNED' }) });
    const res = await handler(read());
    expect(res.statusCode).toBe(403);
    expect(mockHistory).not.toHaveBeenCalled();
  });
});

describe('membership periods', () => {
  it('ignores a leave with no join before it, and merges overlapping identities', () => {
    const periods = membershipPeriods([
      { action: 'left', memberArn: BOT, timestamp: at(1) },
      { action: 'joined', memberArn: BOT, timestamp: at(2) },
      { action: 'joined', memberArn: OTHER_BOT, timestamp: at(4) },
      { action: 'left', memberArn: BOT, timestamp: at(6) },
      { action: 'left', memberArn: OTHER_BOT, timestamp: at(8) },
    ], [BOT, OTHER_BOT]);
    expect(periods).toEqual([{ from: at(2), to: at(8) }]);
  });

  it('includes the join instant and excludes the leave instant', () => {
    const periods = [{ from: at(2), to: at(6) }];
    expect(withinPeriods(at(2), periods)).toBe(true);
    expect(withinPeriods(at(6), periods)).toBe(false);
    expect(withinPeriods('not a time', periods)).toBe(false);
  });
});
