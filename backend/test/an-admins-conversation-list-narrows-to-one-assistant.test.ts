/**
 * AN ADMIN'S CONVERSATION LIST NARROWS TO ONE ASSISTANT (SPEC-ADMIN-CONSOLE "Assistants": the page's Conversations link).
 *
 * `GET /admin/conversations?assistant=<name>` lists the conversations one of that assistant's identities was a member of,
 * read the way a team's route reads them (by member), under the caller's classification scope. It narrows a list the
 * caller already reads and never widens it: an assistant with no identity lists nothing, and the scope still applies.
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
const mockIdentities = jest.fn();
jest.mock('../lambda/src/lib/assistant-ownership.js', () => ({
  ...jest.requireActual('../lambda/src/lib/assistant-ownership.js'),
  listAssistantIdentities: (...a: unknown[]) => mockIdentities(...a),
}));
jest.mock('../lambda/src/lib/chime/clients.js', () => ({
  ...jest.requireActual('../lambda/src/lib/chime/clients.js'),
  chimeIdentityClient: () => ({ send: jest.fn() }),
}));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
process.env.APP_INSTANCE_ARN = APP;
process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:1:function:data-plane';
process.env.ADMIN_GROUP_NAMES = 'admins';
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler } from '../lambda/src/admin-conversations';

const bot = (assistant: string, n: number) => ({
  assistant, classification: 'premium', ownerTeam: null, ownerRecorded: false, role: 'primary', name: assistant, botArn: `${APP}/bot/${assistant}-${n}`,
});
const list = (assistant?: string): APIGatewayProxyEvent => ({
  httpMethod: 'GET',
  path: '/admin/conversations',
  headers: { origin: 'http://localhost:5173' },
  pathParameters: null,
  queryStringParameters: { limit: '25', offset: '0', ...(assistant !== undefined ? { assistant } : {}) },
  requestContext: { identity: { userArn: 'arn:aws:sts::1:assumed-role/ae-admin-console/console-sub' } },
} as unknown as APIGatewayProxyEvent);
const body = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => {
  jest.clearAllMocks();
  mockScope.mockReturnValue(null);
  mockIdentities.mockResolvedValue([bot('advisor', 1), bot('advisor', 2), bot('concierge', 1)]);
  mockAuroraListConversations.mockResolvedValue({ conversations: [], total: 0 });
});

describe('narrowing the admin list to one assistant', () => {
  it('lists by the assistant\'s own identities, every one of them and no other', async () => {
    const res = await handler(list('advisor'));
    expect(res.statusCode).toBe(200);
    const memberArns = mockAuroraListConversations.mock.calls[0][4] as string[];
    expect(memberArns.sort()).toEqual([`${APP}/bot/advisor-1`, `${APP}/bot/advisor-2`]);
  });

  it('keeps the caller\'s classification scope on the narrowed list', async () => {
    mockScope.mockReturnValue('basic');
    await handler(list('advisor'));
    const allowed = mockAuroraListConversations.mock.calls[0][2] as string[];
    expect(allowed).toContain('basic');
    expect(allowed).not.toContain('premium');
  });

  it('lists nothing for an assistant with no identity, without asking the archive', async () => {
    const res = await handler(list('no-such-assistant'));
    expect(body(res)).toEqual({ conversations: [], total: 0 });
    expect(mockAuroraListConversations).not.toHaveBeenCalled();
  });

  it('is the whole list, unnarrowed, without the parameter (non-vacuity)', async () => {
    await handler(list());
    expect(mockIdentities).not.toHaveBeenCalled();
    expect(mockAuroraListConversations.mock.calls[0][4]).toBeNull();
  });
});
