/**
 * A CONVERSATION IS FOUND BY THE ID A PERSON GAVE AN OPERATOR (SPEC-ADMIN-CONSOLE FR52).
 *
 * `GET /admin/conversations/find?id=` answers from the same query as the list, under the same
 * classification scope, so a lookup reaches nothing the list would not show. A conversation outside the
 * caller's scope and one that does not exist answer the same 404, so the lookup never confirms that a
 * conversation exists to someone not permitted to see it.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockAuroraListConversations = jest.fn();
jest.mock('../lambda/src/lib/data-plane-client.js', () => ({
  hasDataPlane: () => true,
  adminListConversations: (...a: unknown[]) => mockAuroraListConversations(...a),
  adminListMessages: jest.fn(),
  adminMembershipHistory: jest.fn(),
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
const mockScope = jest.fn();
jest.mock('../lambda/src/lib/caller-scope.js', () => ({
  ...jest.requireActual('../lambda/src/lib/caller-scope.js'),
  scopeForRequest: (...a: unknown[]) => mockScope(...a),
}));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
process.env.APP_INSTANCE_ARN = APP;
process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:1:function:data-plane';
process.env.ADMIN_GROUP_NAMES = 'admins';
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler } from '../lambda/src/admin-conversations';

const CHANNEL_ID = 'conv-1';
const CHANNEL_ARN = `${APP}/channel/${CHANNEL_ID}`;
const summary = (channelArn: string, cls = 'standard') => ({
  channelArn, name: 'Refund question', messageCount: 4, memberCount: 2, state: 'live', metadata: { modelTier: cls },
});

/** A console session, signed: the shape every admin call has arrived in since FR43. */
const find = (id: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: 'GET',
  path: '/admin/conversations/find',
  headers: { origin: 'http://localhost:5173' },
  pathParameters: null,
  queryStringParameters: id === undefined ? null : { id },
  requestContext: { identity: { userArn: 'arn:aws:sts::1:assumed-role/ae-team-console/console-sub' } },
} as unknown as APIGatewayProxyEvent);
const body = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => {
  jest.clearAllMocks();
  mockScope.mockReturnValue(null);
  mockAuroraListConversations.mockResolvedValue({ conversations: [summary(CHANNEL_ARN)], total: 1 });
});

describe('finding a conversation by its id', () => {
  it.each([
    ['the bare channel id', CHANNEL_ID],
    ['the full channel ARN', CHANNEL_ARN],
  ])('finds it from %s', async (_label, id) => {
    const res = await handler(find(id));
    expect(res.statusCode).toBe(200);
    expect(body(res).conversation.channelArn).toBe(CHANNEL_ARN);
    // The lookup is the list query narrowed to one conversation, not a separate read.
    expect(mockAuroraListConversations).toHaveBeenCalledWith(1, 0, null, CHANNEL_ARN, null);
  });

  it('carries the caller\'s classification scope into the query', async () => {
    mockScope.mockReturnValue('basic');
    await handler(find(CHANNEL_ID));
    const allowed = mockAuroraListConversations.mock.calls[0][2] as string[];
    expect(allowed).toContain('basic');
    expect(allowed).not.toContain('premium');
  });

  it('answers a conversation outside the scope exactly as one that does not exist', async () => {
    mockScope.mockReturnValue('basic');
    // A data plane that does not narrow by scope still cannot leak it: the handler filters again.
    mockAuroraListConversations.mockResolvedValue({ conversations: [summary(CHANNEL_ARN, 'premium')], total: 1 });
    const outside = await handler(find(CHANNEL_ID));
    mockAuroraListConversations.mockResolvedValue({ conversations: [], total: 0 });
    const missing = await handler(find(CHANNEL_ID));
    expect(outside.statusCode).toBe(404);
    expect(body(outside)).toEqual(body(missing));
    expect(body(outside).code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('never answers with a different conversation, even from a data plane that ignores the filter', async () => {
    mockAuroraListConversations.mockResolvedValue({ conversations: [summary(`${APP}/channel/someone-else`)], total: 1 });
    const res = await handler(find(CHANNEL_ID));
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ['nothing', undefined],
    ['a blank id', '  '],
    ['another app instance\'s conversation', 'arn:aws:chime:us-east-1:1:app-instance/other/channel/conv-1'],
    ['an id that is not a channel id', 'conv-1\' OR 1=1'],
  ])('refuses %s as a bad request', async (_label, id) => {
    const res = await handler(find(id));
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('CONVERSATION_ID_INVALID');
    expect(mockAuroraListConversations).not.toHaveBeenCalled();
  });
});
