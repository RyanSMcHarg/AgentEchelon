/**
 * conversation-management handler (SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md).
 *
 * Pins the authorization + ordering + guards without real AWS: virtual SDK command
 * mocks (the repo's image-gen-output style), a fake Chime/SSM/DDB client. Covers:
 *  - archive rejects a non-moderator (403);
 *  - archive order: system message BEFORE the archived tag, then drop moderators;
 *  - remove-member refuses the assistant bot server-side (before any delete);
 *  - remove-member / leave delete the right membership and are idempotent.
 */

const mockChimeSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock(
  '@aws-sdk/client-chime-sdk-messaging',
  () => ({
    ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
    ListChannelModeratorsCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'ListModerators', input })),
    DeleteChannelModeratorCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'DeleteModerator', input })),
    DeleteChannelMembershipCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'DeleteMembership', input })),
    SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'SendMessage', input })),
    TagResourceCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'Tag', input })),
    DescribeChannelCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'Describe', input })),
    UpdateChannelCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'UpdateChannel', input })),
    ChannelMessageType: { STANDARD: 'STANDARD' },
    ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
  }),
  { virtual: true },
);
jest.mock(
  '@aws-sdk/client-ssm',
  () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
    GetParameterCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'GetParam', input })),
  }),
  { virtual: true },
);
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock(
  '@aws-sdk/lib-dynamodb',
  () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
    PutCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'Put', input })),
  }),
  { virtual: true },
);

const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc';
const ADMIN_ARN = `${APP}/user/service-admin`;
process.env.APP_INSTANCE_ARN = APP;
process.env.ADMIN_ARN_PARAM = '/agent-echelon/app-instance-admin-arn';
process.env.AUDIT_TABLE = 'conv-actions';
process.env.ALLOWED_ORIGIN = 'https://app.example';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/src/conversation-management');

const CALLER_SUB = 'user-1';
const callerArn = `${APP}/user/${CALLER_SUB}`;
const CHANNEL = `${APP}/channel/conv-123`;

function event(resource: string, body: Record<string, unknown>) {
  return {
    resource,
    requestContext: { authorizer: { claims: { sub: CALLER_SUB, email: 'u@example.com', 'cognito:groups': 'premium' } } },
    body: JSON.stringify(body),
    headers: { origin: 'https://app.example' },
  } as never;
}

/** Configure the fake Chime client; `moderators` drives the ListChannelModerators reply. */
function primeChime(moderators: string[], overrides: Partial<Record<string, unknown>> = {}) {
  mockChimeSend.mockImplementation((cmd: { _cmd: string }) => {
    if (cmd._cmd in overrides) return overrides[cmd._cmd] as Promise<unknown>;
    switch (cmd._cmd) {
      case 'ListModerators':
        return Promise.resolve({ ChannelModerators: moderators.map((a) => ({ Moderator: { Arn: a } })) });
      case 'Describe':
        return Promise.resolve({ Channel: { Name: 'Chat', Mode: 'RESTRICTED', Metadata: '{"modelTier":"premium"}' } });
      default:
        return Promise.resolve({});
    }
  });
}

const sent = (name: string) => mockChimeSend.mock.calls.filter((c) => c[0]._cmd === name);
const firstIndexOf = (name: string) => mockChimeSend.mock.calls.findIndex((c) => c[0]._cmd === name);

beforeEach(() => {
  mockChimeSend.mockReset();
  mockSsmSend.mockReset();
  mockDdbSend.mockReset();
  mockSsmSend.mockResolvedValue({ Parameter: { Value: ADMIN_ARN } });
  mockDdbSend.mockResolvedValue({});
});

describe('archive', () => {
  it('rejects a non-moderator (403) and sets no tag', async () => {
    primeChime([]); // caller is not among the moderators
    const res = await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(403);
    expect(sent('Tag')).toHaveLength(0);
    expect(sent('DeleteModerator')).toHaveLength(0);
  });

  it('archives in order: system message BEFORE tag, then drops moderators', async () => {
    primeChime([callerArn, `${APP}/user/other-mod`]);
    const res = await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    // system message posted, then the archived tag, then moderators removed.
    expect(firstIndexOf('SendMessage')).toBeGreaterThanOrEqual(0);
    expect(firstIndexOf('SendMessage')).toBeLessThan(firstIndexOf('Tag'));
    expect(sent('Tag')[0][0].input.Tags).toEqual([{ Key: 'archived', Value: 'true' }]);
    // one DeleteModerator per moderator (caller + other).
    expect(sent('DeleteModerator')).toHaveLength(2);
    // metadata display-mirror written.
    expect(sent('UpdateChannel')[0][0].input.Metadata).toContain('"archived":true');
    // audit row written.
    expect(mockDdbSend).toHaveBeenCalled();
  });
});

describe('remove-member', () => {
  it('refuses the assistant bot server-side, before any moderator check or delete', async () => {
    primeChime([callerArn]);
    const res = await handler(
      event('/conversations/remove-member', { channelArn: CHANNEL, memberArn: `${APP}/bot/assistant` }),
    );
    expect(res.statusCode).toBe(403);
    expect(sent('ListModerators')).toHaveLength(0);
    expect(sent('DeleteMembership')).toHaveLength(0);
  });

  it('removes a non-bot member when the caller is a moderator', async () => {
    primeChime([callerArn]);
    const target = `${APP}/user/victim`;
    const res = await handler(event('/conversations/remove-member', { channelArn: CHANNEL, memberArn: target }));
    expect(res.statusCode).toBe(200);
    expect(sent('DeleteMembership')[0][0].input.MemberArn).toBe(target);
  });

  it('rejects a non-moderator (403)', async () => {
    primeChime([]);
    const res = await handler(
      event('/conversations/remove-member', { channelArn: CHANNEL, memberArn: `${APP}/user/victim` }),
    );
    expect(res.statusCode).toBe(403);
    expect(sent('DeleteMembership')).toHaveLength(0);
  });
});

describe('leave', () => {
  it('removes only the caller’s own membership (no moderator check)', async () => {
    primeChime([]); // not a moderator — leave still works
    const res = await handler(event('/conversations/leave', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    expect(sent('DeleteMembership')[0][0].input.MemberArn).toBe(callerArn);
  });

  it('is idempotent when the membership is already gone (NotFoundException)', async () => {
    primeChime([], { DeleteMembership: Promise.reject(Object.assign(new Error('gone'), { name: 'NotFoundException' })) });
    const res = await handler(event('/conversations/leave', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
  });
});
