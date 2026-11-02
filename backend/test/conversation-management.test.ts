import { asPerson, edgeContext } from './helpers/edge-context';
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
    ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'ListTags', input })),
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

// THE NOTICE IS THE ASSISTANT SPEAKING (Phase 1c): its session is a client whose sends are marked, so a
// test can tell a post on the assistant's speak session from one on this function's own role.
const mockSpeakAs = jest.fn();
const mockCopy: { value: Record<string, string> | undefined } = { value: undefined };
/** Every profile name the notice's copy was read from. */
const mockCopyReadFor: string[] = [];
// THE NOTICE IS NAMED TO THE ROUTER (`say-through-router.ts`), which says it as the room's assistant from that
// assistant's own templates (here, the ones `npm run migrate-legacy-copy` would write from `mockCopy`). Emulated here with the real line builder, so the order and the words are still checked, and
// marked so a test can tell the router's post from one on this function's own role.
// AN ARCHIVED ROOM'S DEADLINES (ADR-061 decision 1) are cancelled by the router of its classification; recorded
// here so a test can check the archive asked for it.
const mockCancelDeadlines = jest.fn();
jest.mock('../lambda/src/lib/say-through-router', () => ({
  cancelDeadlinesThroughRouter: async (classification: string, cancel: { channelArn: string; invitationId?: string }) => {
    mockCancelDeadlines(classification, cancel);
    return true;
  },
  sayThroughRouter: async (classification: string, notice: { kind: string; botArn: string; vars?: Record<string, string> }) => {
    mockSpeakAs({ classification, ...notice });
    const { noticeLine } = jest.requireActual('../lambda/src/lib/assistant-notice');
    mockChimeSend({ _cmd: 'SendMessage', viaRouter: true, input: { ChimeBearer: notice.botArn, Content: noticeLine(mockCopy.value ? jest.requireActual('./helpers/own-templates').ownWords(mockCopy.value) : undefined, notice.kind, notice.vars ?? {}) } });
    return { posted: true };
  },
}));
jest.mock('../lambda/src/lib/active-profile', () => ({
  resolveActiveProfile: async (name: string) => { mockCopyReadFor.push(name); return { copy: mockCopy.value }; },
}));
// The room's primary (§3.8), and the archiver's identity record for the name the room shows.
const mockPrimary = jest.fn();
jest.mock('../lambda/src/lib/conversation-primary', () => ({
  primaryAssistantOf: (...args: unknown[]) => mockPrimary(...args),
}));
const mockIdentitySend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn().mockImplementation(() => ({ send: mockIdentitySend })),
  DescribeAppInstanceUserCommand: jest.fn().mockImplementation((input) => ({ _cmd: 'DescribeUser', input })),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc';
const BOT = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/assistant-premium';
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
    requestContext: { authorizer: edgeContext({ claims: { sub: CALLER_SUB, email: 'u@example.com', 'cognito:groups': 'premium' } }) },
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
        return Promise.resolve({ ChannelModerators: moderators.map((a) => ({ Moderator: { Arn: a, Name: a.endsWith('/user/user-1') ? 'Riley Chen' : '' } })) });
      case 'ListTags':
        return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] });
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
  mockSpeakAs.mockReset();
  mockCancelDeadlines.mockReset();
  mockCopy.value = undefined;
  mockCopyReadFor.length = 0;
  mockPrimary.mockReset();
  mockPrimary.mockResolvedValue({ assistant: 'advisor', botArn: BOT, classification: 'premium', source: 'tag' });
  mockIdentitySend.mockReset();
  mockIdentitySend.mockResolvedValue({ AppInstanceUser: { Name: 'Riley Chen' } });
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

  it('archives in order: the notice BEFORE the tag, then drops moderators', async () => {
    primeChime([callerArn, `${APP}/user/other-mod`, BOT]);
    const res = await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    // notice posted, then the archived tag, then moderators removed.
    expect(firstIndexOf('SendMessage')).toBeGreaterThanOrEqual(0);
    expect(firstIndexOf('SendMessage')).toBeLessThan(firstIndexOf('Tag'));
    expect(sent('Tag')[0][0].input.Tags).toEqual([{ Key: 'archived', Value: 'true' }]);
    // one DeleteModerator per moderator (caller, other, the assistant).
    expect(sent('DeleteModerator')).toHaveLength(3);
    // metadata display-mirror written.
    expect(sent('UpdateChannel')[0][0].input.Metadata).toContain('"archived":true');
    // audit row written.
    expect(mockDdbSend).toHaveBeenCalled();
    // the router of the room's classification is asked to cancel every deadline the room carried.
    expect(mockCancelDeadlines).toHaveBeenCalledWith('premium', { channelArn: CHANNEL });
  });
});

describe('the archive notice is the conversation assistant speaking', () => {
  it("is named to the router as the ROOM'S PRIMARY, never posted by this function or the service admin", async () => {
    primeChime([callerArn]);
    await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(mockPrimary.mock.calls[0][0]).toBe(CHANNEL);
    expect(mockSpeakAs).toHaveBeenCalledWith(expect.objectContaining({ classification: 'premium', kind: 'conversationArchived', botArn: BOT }));
    const posts = sent('SendMessage').map((c) => c[0]);
    expect(posts).toHaveLength(1);
    expect(posts[0].viaRouter).toBe(true);
    expect(posts[0].input.ChimeBearer).toBe(BOT);
  });

  it('names the archiver by their identity record, the name the room shows, never by email', async () => {
    primeChime([callerArn]);
    await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(mockIdentitySend.mock.calls[0][0].input).toEqual({ AppInstanceUserArn: callerArn });
    const content = sent('SendMessage')[0][0].input.Content as string;
    expect(content).toMatch(/^Conversation archived by Riley Chen on \d{4}-\d{2}-\d{2}\. It is now read-only\.$/);
    expect(content).not.toContain('u@example.com');
  });

  it("uses the assistant's configured words when it has them", async () => {
    mockCopy.value = { conversationArchived: 'Archivado por {who} el {date}. Solo lectura.' };
    primeChime([callerArn]);
    await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(sent('SendMessage')[0][0].input.Content).toMatch(/^Archivado por Riley Chen el \d{4}-\d{2}-\d{2}\. Solo lectura\.$/);
  });

  it("names the bot of the assistant the room's primary record names, whose copy the router reads", async () => {
    const OPS_BOT = BOT.replace(/[^/]+$/, 'ops-bot');
    mockPrimary.mockResolvedValue({ assistant: 'ops-premium', botArn: OPS_BOT, classification: 'premium', source: 'tag' });
    primeChime([callerArn]);
    await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(mockSpeakAs).toHaveBeenCalledWith(expect.objectContaining({ botArn: OPS_BOT }));
    expect(sent('SendMessage')).toHaveLength(1);
  });

  it('a primary record naming an undeclared assistant posts no notice and logs a security event', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockPrimary.mockResolvedValue({ assistant: 'nobody-declared-this', botArn: BOT, classification: 'premium', source: 'tag' });
      primeChime([callerArn]);
      const res = await handler(event('/conversations/archive', { channelArn: CHANNEL }));
      expect(res.statusCode).toBe(200);
      expect(sent('SendMessage')).toHaveLength(0);
      expect(sent('Tag')).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.objectContaining({ reason: 'undeclared-assistant' }));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a room with no resolvable primary is archived without a notice, and nothing posts as the platform', async () => {
    mockPrimary.mockRejectedValue(Object.assign(new Error('no primary'), { name: 'RoomHasNoPrimary' }));
    primeChime([callerArn]);
    const res = await handler(event('/conversations/archive', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    expect(sent('SendMessage')).toHaveLength(0);
    expect(sent('Tag')).toHaveLength(1);
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

  it('leaves as the PERSON the token resolves to, never the token sub or a member the body names', async () => {
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    primeChime([]);
    const res = await handler(asPerson(event('/conversations/leave', { channelArn: CHANNEL, memberArn: `${APP}/user/someone-else` }), PERSON));
    expect(res.statusCode).toBe(200);
    expect(sent('DeleteMembership')[0][0].input.MemberArn).toBe(`${APP}/user/${PERSON}`);
    const audit = mockDdbSend.mock.calls.map((c) => c[0].input?.Item).find((i) => i?.operation === 'LEAVE');
    expect(audit).toMatchObject({ actorSub: PERSON, targetArn: `${APP}/user/${PERSON}` });
  });

  it('is idempotent when the membership is already gone (NotFoundException)', async () => {
    primeChime([], { DeleteMembership: Promise.reject(Object.assign(new Error('gone'), { name: 'NotFoundException' })) });
    const res = await handler(event('/conversations/leave', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
  });
});

// This file declares its jest mocks at top level and imports the module under test lazily
// inside each case, so it has no top-level import/export of its own. Without one TypeScript treats
// it as a global SCRIPT rather than a module: its top-level `const`s then share one global scope
// with every other such test file, they collide (TS2451), and symbols resolve against whichever
// file won - which is how `abuse-controls.test.ts` came to be typechecked against
// `user-profile-client`. `npm run typecheck` was red with 52 errors for that reason alone, and
// these files were effectively unchecked. This marks the file as a module. Do not remove.
export {};

/**
 * ARCHIVING FROM THE ADMIN CONSOLE (`archive-conversation`, SPEC-ADMIN-CONSOLE FR51).
 *
 * The same sequence, reached on the admin API by an admin console session with a stated reason. The
 * gateway already refused anyone without the capability; the function still accepts only an admin
 * console session on that path, and only with a reason.
 */
describe('archive from the admin console', () => {
  const ADMIN_SUB = '0a1b2c3d-0000-4000-8000-00000000abcd';
  const adminEvent = (body: Record<string, unknown>, role = 'agent-echelon-admin-console') => ({
    httpMethod: 'POST',
    path: '/admin/conversations/conv-123/archive',
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/${role}/console-${ADMIN_SUB}` } },
    body: JSON.stringify(body),
    headers: { origin: 'https://app.example' },
  }) as never;

  it('archives with the administrator as the actor and records the reason', async () => {
    primeChime([callerArn]);
    const res = await handler(adminEvent({ reason: 'a reported harassment thread' }));
    expect(res.statusCode).toBe(200);
    expect(sent('Tag')[0][0].input.Tags).toEqual([{ Key: 'archived', Value: 'true' }]);
    expect(sent('DeleteModerator')).toHaveLength(1);
    const audit = mockDdbSend.mock.calls.map((c) => c[0].input?.Item).find((i) => i?.operation === 'ARCHIVE');
    expect(audit).toMatchObject({ actorSub: ADMIN_SUB, reason: 'a reported harassment thread', channelArn: CHANNEL });
  });

  it('refuses without a reason, and archives nothing', async () => {
    primeChime([callerArn]);
    const res = await handler(adminEvent({}));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('REASON_REQUIRED');
    expect(sent('Tag')).toHaveLength(0);
  });

  it('refuses a session that is not an admin console session', async () => {
    primeChime([callerArn]);
    const res = await handler(adminEvent({ reason: 'r' }, 'agent-echelon-team-console'));
    expect(res.statusCode).toBe(403);
    expect(sent('Tag')).toHaveLength(0);
  });

  it('parses an admin whose person id is not a UUID as the actor, and names them by their twin', async () => {
    primeChime([callerArn]);
    const opaque = 'person_01J8ZQ.x';
    const res = await handler({
      httpMethod: 'POST',
      path: '/admin/conversations/conv-123/archive',
      requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-admin-console/console-${opaque}` } },
      body: JSON.stringify({ reason: 'r' }),
      headers: { origin: 'https://app.example' },
    } as never);
    expect(res.statusCode).toBe(200);
    const audit = mockDdbSend.mock.calls.map((c) => c[0].input?.Item).find((i) => i?.operation === 'ARCHIVE');
    expect(audit).toMatchObject({ actorSub: opaque });
  });
});
