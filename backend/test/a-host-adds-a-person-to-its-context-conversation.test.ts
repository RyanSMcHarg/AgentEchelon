/**
 * A HOST ADDS A PERSON TO ITS CONTEXT CONVERSATION - the P1 privacy promise (backend-data assertion).
 *
 * The host's membership change (`membershipHandler` in `conversation-management.ts`, its own function,
 * invoked directly by the host behind IAM) names the person by issuer and subject, resolved through the
 * trusted-issuer registry and `Identities`. Same guarantee as the context create: the private host grounding (participantProfile, domainContext,
 * otherContexts) and the model-ROUTING signals (userLanguage, segment) go to the SERVER-ONLY Channel
 * Context store and never into member-readable channel Metadata. add-member does NOT store userName
 * (it uses it only for the greeting).
 */
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  CreateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateChannel', input: a })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateMembership', input: a })),
  CreateChannelModeratorCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateModerator', input: a })),
  DeleteChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'DeleteMembership', input: a })),
  DeleteChannelModeratorCommand: jest.fn().mockImplementation((a) => ({ __type: 'DeleteModerator', input: a })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((a) => ({ __type: 'AssociateFlow', input: a })),
  UpdateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'UpdateChannel', input: a })),
  DescribeChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'DescribeChannel', input: a })),
  SendChannelMessageCommand: jest.fn().mockImplementation((a) => ({ __type: 'SendMessage', input: a })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((a) => ({ __type: 'ListTags', input: a })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((a) => ({ __type: 'GetParam', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn().mockImplementation((a) => ({ __type: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __type: 'Update', input: a })),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111:app-instance/i';
const BOT = `${APP}/bot/basic`;
const ADMIN = `${APP}/user/ae-admin`;
const ADMIN_PARAM = '/agent-echelon/app-instance-admin-arn';
const FLOW_PARAM = '/agent-echelon/channel-flow-arn';
const FLOW = `${APP}/channel-flow/f`;
const CHANNEL = `${APP}/channel/ctx-basic-plan-p1`;
/** The host app's pool, declared in the registry. */
const HOST_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_HostApp';
// The person the host's (issuer, sub) signs in as, through the registry and Identities: this suite's resolver answers the
// person whose id is the subject.
const TARGET_PREFIX = `${APP}/user/foreign-sub`;

type Handler = (e: unknown) => Promise<{ ok?: boolean }>;
let handler: Handler;

/** The service admin and the flow by their parameters; every other read is the classification's bot. */
function answerSsm(admin = ADMIN): void {
  mockSsmSend.mockReset().mockImplementation(async (cmd: { input: { Name: string } }) => {
    if (cmd.input.Name === ADMIN_PARAM) return { Parameter: { Value: admin } };
    if (cmd.input.Name === FLOW_PARAM) return { Parameter: { Value: FLOW } };
    return { Parameter: { Value: BOT } };
  });
}

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = APP;
  process.env.CONTEXT_CLASSIFICATION = 'basic';
  process.env.TRUSTED_ISSUERS = JSON.stringify([
    { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', iss: HOST_ISS, subject: ['sub'], clearance: { oneChannel: 'basic', classifications: ['basic'] }, admin: false, groupsClaim: 'cognito:groups' },
  ]);
  process.env.SSM_ROOT = '/agent-echelon';
  process.env.CHANNEL_CONTEXT_TABLE = 'ChannelContextTest';
  process.env.CREATOR_BEARER_ARN_PARAM = ADMIN_PARAM;
  delete process.env.CHANNEL_FLOW_ARN_PARAM;
  ({ membershipHandler: handler } = (await import('../lambda/src/conversation-management')) as unknown as { membershipHandler: Handler });
});

beforeEach(() => {
  mockMessagingSend.mockReset().mockResolvedValue({ ChannelArn: CHANNEL });
  answerSsm();
  mockDdbSend.mockReset().mockResolvedValue({});
});

function event() {
  return {
    op: 'add' as const,
    contextType: 'plan',
    contextId: 'p1',
    iss: HOST_ISS,
    sub: 'foreign-sub',
    title: 'My Plan',
    userName: 'Priya',
    userLanguage: 'en',
    participantProfile: 'recruiter at Stratum Technologies',
    domainContext: { items: [{ title: 'JD' }] },
    otherContexts: [{ title: 'other plan' }],
  };
}

describe('a host\'s add keeps the P1 privacy promise', () => {
  it('keeps the private host grounding OUT of member-readable channel Metadata', async () => {
    await handler(event());
    const createCall = mockMessagingSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'CreateChannel');
    expect(createCall).toBeDefined();
    const meta = JSON.parse(createCall.input.Metadata);
    expect(meta).not.toHaveProperty('participantProfile');
    expect(meta).not.toHaveProperty('domainContext');
    expect(meta).not.toHaveProperty('otherContexts');
    expect(meta).not.toHaveProperty('userName');
    // Nor the model-routing signals: member-writable Metadata must not steer model selection.
    expect(meta).not.toHaveProperty('userLanguage');
    expect(meta).not.toHaveProperty('segment');
    // the conversation's identity bits remain
    expect(meta.contextType).toBe('plan');
    expect(meta.topic).toBe('My Plan');
  });

  it('writes the private fields (not userName) and the routing signals to the server-only store', async () => {
    await handler({ ...event(), segment: { country: 'CN' } });
    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    expect(upd).toBeDefined();
    expect(upd.input.TableName).toBe('ChannelContextTest');
    expect(upd.input.Key).toEqual({ channelArn: `${APP}/channel/ctx-basic-plan-p1` });
    const vals = upd.input.ExpressionAttributeValues;
    expect(vals[':participantProfile']).toBe('recruiter at Stratum Technologies');
    expect(vals[':domainContext']).toEqual({ items: [{ title: 'JD' }] });
    expect(vals[':otherContexts']).toEqual([{ title: 'other plan' }]);
    expect(vals).not.toHaveProperty(':userName');
    expect(vals[':userLanguage']).toBe('en');
    expect(vals[':segment']).toEqual({ country: 'CN' });
  });

  it('records the new member\'s ISSUER hint, appended rather than written over the existing roster', async () => {
    // Without this the person just added is the only member nothing can resolve: their
    // AppInstanceUser id is a one-way hash of (iss, sub), so the notification fan-out falls back to
    // the default pool, fails to find them, and skips them — added on purpose, then silently never
    // notified — while host grounding can name everyone in the conversation except them.
    await handler(event());
    const appends = mockDdbSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'Update' && /list_append/.test(String(c.input.UpdateExpression)));
    expect(appends).toHaveLength(1);
    const vals = appends[0].input.ExpressionAttributeValues;
    expect(vals[':entry']).toEqual([{ sub: 'foreign-sub', iss: HOST_ISS }]);
    // list_append, not a bare SET: two hosts can add two people at once, and a read-modify-write
    // would lose one of them.
    expect(String(appends[0].input.UpdateExpression)).toMatch(/list_append\(if_not_exists\(/);
  });

  it('carries the host-supplied role, which exists nowhere else', async () => {
    // Membership can report who is here and the IdP owns their name; the role on THIS conversation is
    // the host's statement and has no other source.
    await handler({ ...event(), role: 'reviewer' });
    const append = mockDdbSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.__type === 'Update' && /list_append/.test(String(c.input.UpdateExpression)));
    expect(append.input.ExpressionAttributeValues[':entry']).toEqual([
      { sub: 'foreign-sub', iss: HOST_ISS, role: 'reviewer' },
    ]);
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
 * A NEW CONVERSATION IS CREATED BY THE SHARED CREATOR, AS THE SERVICE ADMIN.
 *
 * `lib/channel-creation.ts` is not mocked here. The service admin creates, the flow is attached before
 * any assistant is a member (an assistant's membership fires its welcome, and every message created
 * before the association bypasses the flow), the assistant and the target are added, and the admin
 * leaves. No call bears an assistant, and the target is never made a moderator.
 */
describe('creation through the shared creator', () => {
  async function freshHandler(withFlow: boolean, admin = ADMIN): Promise<Handler> {
    jest.resetModules();
    if (withFlow) process.env.CHANNEL_FLOW_ARN_PARAM = FLOW_PARAM;
    else delete process.env.CHANNEL_FLOW_ARN_PARAM;
    answerSsm(admin);
    return ((await import('../lambda/src/conversation-management')) as unknown as { membershipHandler: Handler }).membershipHandler;
  }
  afterEach(() => { delete process.env.CHANNEL_FLOW_ARN_PARAM; });

  it('creates as the service admin and attaches the flow before any assistant is a member', async () => {
    const run = await freshHandler(true);
    const res = await run(event());
    expect(res.ok).toBe(true);
    const calls = mockMessagingSend.mock.calls.map((c) => c[0] as { __type: string; input: Record<string, string> });
    const order = calls.map((c) => c.__type);
    expect(order).toContain('AssociateFlow');
    const firstBotAdd = calls.findIndex((c) => c.__type === 'CreateMembership' && c.input.MemberArn === BOT);
    expect(firstBotAdd).toBeGreaterThan(-1);
    expect(order.indexOf('AssociateFlow')).toBeLessThan(firstBotAdd);
    // Every create, flow and membership change bears the service admin, never an assistant.
    const writes = calls.filter((c) => ['CreateChannel', 'AssociateFlow', 'CreateMembership', 'CreateModerator', 'DeleteMembership', 'DeleteModerator'].includes(c.__type));
    expect([...new Set(writes.map((c) => c.input.ChimeBearer))]).toEqual([ADMIN]);
    // The classification, the room's type and the context binding are tagged at creation.
    const create = calls.find((c) => c.__type === 'CreateChannel')!.input as unknown as { Tags: Array<{ Key: string; Value: string }> };
    expect(create.Tags).toEqual(expect.arrayContaining([
      { Key: 'classification', Value: 'basic' },
      { Key: 'conversationType', Value: 'general' },
      { Key: 'contextType', Value: 'plan' },
    ]));
  });

  it('adds the target as a member and never makes them a moderator', async () => {
    const run = await freshHandler(true);
    await run(event());
    const calls = mockMessagingSend.mock.calls.map((c) => c[0] as { __type: string; input: Record<string, string> });
    expect(calls.some((c) => c.__type === 'CreateMembership' && c.input.MemberArn.startsWith(TARGET_PREFIX))).toBe(true);
    const moderators = calls.filter((c) => c.__type === 'CreateModerator').map((c) => c.input.ChannelModeratorArn);
    expect(moderators).toEqual([BOT]);
  });

  it('refuses a subject that has never signed in, and creates or adds nothing', async () => {
    const run = await freshHandler(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolvePerson } = require('../lambda/src/lib/person-identity');
    (resolvePerson as jest.Mock).mockResolvedValueOnce(null);
    const res = await run(event());
    expect(res).toMatchObject({ ok: false });
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('with no service admin, creates nothing and adds nobody', async () => {
    const run = await freshHandler(true, '');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run(event());
    error.mockRestore();
    expect(res.ok).toBe(false);
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('in an existing conversation, adds the assistant and the target bearing the service admin', async () => {
    const run = await freshHandler(true);
    mockMessagingSend.mockReset().mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'CreateChannel') {
        const conflict = new Error('channel exists') as Error & { name: string };
        conflict.name = 'ConflictException';
        throw conflict;
      }
      if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'basic' }] };
      if (cmd.__type === 'DescribeChannel') return { Channel: { Metadata: '{}' } };
      return {};
    });
    const res = await run(event());
    expect(res.ok).toBe(true);
    const calls = mockMessagingSend.mock.calls.map((c) => c[0] as { __type: string; input: Record<string, string> });
    const adds = calls.filter((c) => c.__type === 'CreateMembership');
    expect(adds.map((c) => c.input.MemberArn)).toEqual([BOT, TARGET_PREFIX]);
    expect([...new Set(adds.map((c) => c.input.ChimeBearer))]).toEqual([ADMIN]);
    for (const t of ['DescribeChannel', 'UpdateChannel']) {
      expect([t, calls.find((c) => c.__type === t)?.input.ChimeBearer]).toEqual([t, ADMIN]);
    }
    expect(calls.some((c) => c.__type === 'CreateModerator')).toBe(false);
  });

  it('refuses an existing conversation of another classification, writing nothing and adding nobody (step 39)', async () => {
    const run = await freshHandler(true);
    mockMessagingSend.mockReset().mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'CreateChannel') {
        const conflict = new Error('channel exists') as Error & { name: string };
        conflict.name = 'ConflictException';
        throw conflict;
      }
      if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return {};
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run(event());
    error.mockRestore();
    expect(res.ok).toBe(false);
    const types = mockMessagingSend.mock.calls.map((c) => (c[0] as { __type: string }).__type);
    expect(types.filter((t) => ['UpdateChannel', 'CreateMembership'].includes(t))).toEqual([]);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

/**
 * Adding a member must not wipe the conversation's grounding (maintainer, 2026-08-10).
 *
 * WHY THIS DIFFERS FROM THE CREATE PATH. Create/edit re-stamps the whole plan, so a field the host stops
 * sending has genuinely been removed and clearing it is right. Add-member create-or-GETS an EXISTING
 * conversation and adds one person - the host is saying "this member joins", not "and here is the
 * complete grounding again".
 *
 * Treating omission as removal meant a call carrying only the four required fields wiped the private
 * grounding AND the model/language routing. Nothing errored; the next turn just answered worse, in the
 * wrong language, on the wrong model. `putChannelContext` already distinguishes `undefined` ("not part of
 * this patch") from `null` (explicit REMOVE), so passing the host's intent through is the whole fix.
 */
describe('add-member preserves what it was not asked to change', () => {
  /** The DynamoDB update the handler issued against the Channel Context store. */
  function contextUpdate() {
    return mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
  }

  it('a MINIMAL add touches none of the grounding fields', async () => {
    await handler({ op: 'add', contextType: 'plan', contextId: 'p1', iss: HOST_ISS, sub: 'foreign-sub' });
    const upd = contextUpdate();
    // No REMOVE at all: the previous grounding and routing survive somebody being added.
    if (upd) {
      expect(upd.input.UpdateExpression).not.toContain('REMOVE');
      for (const f of ['participantProfile', 'domainContext', 'otherContexts', 'userLanguage', 'segment']) {
        expect(upd.input.UpdateExpression).not.toContain(`#${f} =`);
      }
    }
  });

  it('an EXPLICIT null still clears — a host that wants a field gone can still remove it', async () => {
    await handler({
      op: 'add', contextType: 'plan', contextId: 'p1', iss: HOST_ISS, sub: 'foreign-sub',
      participantProfile: null, userLanguage: null,
    });
    const upd = contextUpdate();
    expect(upd).toBeDefined();
    expect(upd.input.UpdateExpression).toContain('REMOVE');
    expect(upd.input.ExpressionAttributeNames).toHaveProperty('#participantProfile');
    expect(upd.input.ExpressionAttributeNames).toHaveProperty('#userLanguage');
  });

  it('a SUPPLIED value is still written', async () => {
    await handler({ ...event(), userLanguage: 'es' });
    const upd = contextUpdate();
    expect(upd.input.ExpressionAttributeValues[':userLanguage']).toBe('es');
    expect(upd.input.ExpressionAttributeValues[':participantProfile']).toContain('recruiter');
  });

  it('omitting ONE field leaves that one alone without affecting the others', async () => {
    // The realistic call: the host re-sends what it knows and says nothing about the rest.
    const { userLanguage: _omitted, ...rest } = event();
    await handler(rest);
    const upd = contextUpdate();
    expect(upd.input.UpdateExpression).not.toContain('#userLanguage =');
    expect(upd.input.UpdateExpression).not.toContain('REMOVE');
    // The supplied ones still land.
    expect(upd.input.ExpressionAttributeValues).toHaveProperty(':domainContext');
  });
});

/**
 * The SAME rule as the block above, one store over.
 *
 * The refresh on the create-or-GET path rebuilt channel Metadata from the four keys this call happens
 * to know and wrote that over whatever was there. Every other key on the channel was destroyed by an
 * unrelated add-member - which is the WRITE side of the legacy-grounding loss; the
 * read-side fallback existed, so the damage was silent.
 */
describe('add-member preserves channel metadata it did not set', () => {
  it('merges its own keys over the existing ones instead of replacing them', async () => {
    jest.resetModules();
    const mod = (await import('../lambda/src/conversation-management')) as unknown as { membershipHandler: Handler };

    mockMessagingSend.mockReset().mockImplementation(async (cmd: unknown) => {
      const c = cmd as { __type: string };
      if (c.__type === 'CreateChannel') {
        // The conversation already exists, which is the whole point of this path.
        const conflict = new Error('channel exists') as Error & { name: string };
        conflict.name = 'ConflictException';
        throw conflict;
      }
      if (c.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'basic' }] };
      if (c.__type === 'DescribeChannel') {
        return {
          Channel: {
            Metadata: JSON.stringify({
              hostGroundingHint: 'a key this call knows nothing about',
              modelTier: 'stale-value-ours-should-win',
            }),
          },
        };
      }
      return { ChannelArn: `${APP}/channel/ctx-basic-plan-p1` };
    });
    answerSsm();
    mockDdbSend.mockReset().mockResolvedValue({});

    await mod.membershipHandler(event());

    const update = mockMessagingSend.mock.calls
      .map((c) => c[0] as { __type: string; input: { Metadata?: string } })
      .find((c) => c.__type === 'UpdateChannel');
    expect(update).toBeTruthy();
    const written = JSON.parse(update!.input.Metadata || '{}');

    // The key nobody in this path knows about SURVIVES. That is the fix.
    expect(written.hostGroundingHint).toBe('a key this call knows nothing about');
    // And the keys this call DOES own still win, because they are the current plan.
    expect(written.modelTier).not.toBe('stale-value-ours-should-win');
  });

  it('leaves the metadata alone when the merge would exceed the cap, rather than writing its four keys over it', async () => {
    // The fallback sent our four keys ALONE when the merge was too big: the destructive overwrite the
    // merge exists to prevent, on exactly the channels carrying the most metadata of their own.
    jest.resetModules();
    const mod = (await import('../lambda/src/conversation-management')) as unknown as { membershipHandler: Handler };

    mockMessagingSend.mockReset().mockImplementation(async (cmd: unknown) => {
      const c = cmd as { __type: string };
      if (c.__type === 'CreateChannel') {
        const conflict = new Error('channel exists') as Error & { name: string };
        conflict.name = 'ConflictException';
        throw conflict;
      }
      if (c.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'basic' }] };
      if (c.__type === 'DescribeChannel') {
        return { Channel: { Metadata: JSON.stringify({ hostGroundingHint: 'x'.repeat(1000) }) } };
      }
      return { ChannelArn: `${APP}/channel/ctx-basic-plan-p1` };
    });
    answerSsm();
    mockDdbSend.mockReset().mockResolvedValue({});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await mod.membershipHandler(event());

    const update = mockMessagingSend.mock.calls
      .map((c) => c[0] as { __type: string; input: { Metadata?: string; Name?: string } })
      .find((c) => c.__type === 'UpdateChannel');
    expect(update).toBeTruthy();
    // Omitted, so the Amazon Chime SDK leaves the channel's metadata exactly as it was.
    expect(update!.input).not.toHaveProperty('Metadata');
    // The title is still ours to refresh.
    expect(update!.input.Name).toBeTruthy();
    warn.mockRestore();
  });
});

describe('the host names the person by issuer and subject, through the registry', () => {
  it('refuses an issuer the registry does not declare, and adds nobody', async () => {
    const r = await handler({ ...event(), iss: 'https://host-idp' });
    expect(r).toMatchObject({ ok: false, error: 'The issuer is not one this deployment trusts' });
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('refuses a call that names no operation', async () => {
    const { op: _op, ...rest } = event();
    expect(await handler(rest)).toMatchObject({ ok: false, error: 'op is add or remove' });
  });

  it('removes the person, bearing the classification\'s assistant, idempotently', async () => {
    mockMessagingSend.mockReset().mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'DeleteMembership') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
      return {};
    });
    const r = await handler({ op: 'remove', contextType: 'plan', contextId: 'p1', iss: HOST_ISS, sub: 'foreign-sub' });
    expect(r).toMatchObject({ ok: true, conversationArn: CHANNEL });
    const del = mockMessagingSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'DeleteMembership');
    expect(del.input).toMatchObject({ ChannelArn: CHANNEL, ChimeBearer: BOT });
    expect(String(del.input.MemberArn)).toMatch(/\/user\/foreign-sub$/);
  });
});

describe('the host adds only a person who may still sign in (SPEC-CREDENTIAL-EXCHANGE §4b)', () => {
  /** A fresh handler, and the account-state answer the directory it reads gives (test/setup/account-state.ts). */
  async function fresh(): Promise<{ run: Handler; accountState: jest.Mock }> {
    jest.resetModules();
    answerSsm();
    const run = ((await import('../lambda/src/conversation-management')) as unknown as { membershipHandler: Handler }).membershipHandler;
    const { accountState } = (jest.requireMock('../lambda/src/lib/membership-source') as { __accountStateForTests: { accountState: jest.Mock } }).__accountStateForTests;
    return { run, accountState };
  }
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it.each(['disabled', 'gone'] as const)('refuses an add for a person their issuer reports %s, and creates or adds nothing', async (state) => {
    const { run, accountState } = await fresh();
    accountState.mockResolvedValue(state);
    expect(await run(event())).toMatchObject({ ok: false, error: "The person's account is not active" });
    expect(accountState).toHaveBeenCalled();
    expect(mockMessagingSend).not.toHaveBeenCalled();
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('refuses an add when the issuer cannot be asked (fail closed)', async () => {
    const { run, accountState } = await fresh();
    accountState.mockRejectedValue(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));
    expect(await run(event())).toMatchObject({ ok: false });
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('still removes a disabled person, asking nothing', async () => {
    const { run, accountState } = await fresh();
    accountState.mockResolvedValue('disabled');
    mockMessagingSend.mockReset().mockResolvedValue({});
    const r = await run({ op: 'remove', contextType: 'plan', contextId: 'p1', iss: HOST_ISS, sub: 'foreign-sub' });
    expect(r).toMatchObject({ ok: true, conversationArn: CHANNEL });
    expect(accountState).not.toHaveBeenCalled();
  });
});
