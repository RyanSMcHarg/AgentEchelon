import { edgeContext } from './helpers/edge-context';
/**
 * A HOST'S CONTEXT CONVERSATION OPENS THROUGH THE ONE CREATE PATH - the P1 privacy promise
 * (backend-data assertion), and creation through the shared creator.
 *
 * A person whose issuer declares the one-conversation session (`clearance: { oneChannel }` in the
 * trusted-issuer registry) calls the same `POST /create-conversation` as everyone else. The API reads
 * their issuer's entry and dispatches a context request to the creator of the classification it names
 * (`create-conversation-at-classification.ts`), which creates or re-opens the conversation at the
 * deterministic id the host's context derives. The LambdaClient below runs that creator in-process, so
 * every Amazon Chime SDK and DynamoDB call asserted here is the merged path's own.
 *
 * The sensitive host grounding (participantProfile, domainContext, otherContexts, userName) must go to
 * the SERVER-ONLY Channel Context store and must NOT appear in the Amazon Chime SDK channel Metadata
 * (which any member can read via DescribeChannel). The model-ROUTING signals (userLanguage, segment)
 * go to the same store, because Metadata is member-WRITABLE and they decide which model answers. Only
 * the conversation's identity bits (contextType, contextId, topic) stay in Metadata by design.
 *
 * The channel is created by `lib/channel-creation.ts`, which is NOT mocked here: the service admin
 * creates, the flow is attached, the assistant and the person are added, and the admin leaves - so no
 * assistant is a member before the flow is attached (a creator that acts as the service admin).
 *
 * This asserts the real backend effects (the Amazon Chime SDK calls and their bearers, and the DynamoDB
 * write), not a render or a 200 — the discipline the doc-vs-code audit exists to enforce.
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
  DescribeChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'DescribeMembership', input: a })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((a) => ({ __type: 'ListMemberships', input: a })),
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
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({
    send: async (cmd: { input: { FunctionName: string; Payload: Uint8Array } }) => {
      process.env.CREATOR_CLASSIFICATION = cmd.input.FunctionName.replace(/^creator-/, '');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { handler: creator } = require('../lambda/src/create-conversation-at-classification');
      const result = await creator(JSON.parse(new TextDecoder().decode(cmd.input.Payload)));
      return { Payload: new TextEncoder().encode(JSON.stringify(result)) };
    },
  })),
  InvokeCommand: jest.fn((input: unknown) => ({ input })),
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn().mockImplementation((a) => ({ __type: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __type: 'Update', input: a })),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111:app-instance/i';
/** The person id the exchange minted: a UUID v7, never the host's sub. */
const MINTED = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
const BOT = `${APP}/bot/basic`;
const ADMIN = `${APP}/user/ae-admin`;
const ADMIN_PARAM = '/agent-echelon/app-instance-admin-arn';
const FLOW_PARAM = '/agent-echelon/channel-flow-arn';
const FLOW = `${APP}/channel-flow/f`;
const CHANNEL = `${APP}/channel/ctx-basic-plan-p1`;
/** The host app's pool, declared in the registry with the one-conversation session at `basic`. */
const HOST_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_HostApp';

type Handler = (e: unknown) => Promise<{ statusCode: number; body: string }>;
let handler: Handler;

function answerSsm(): void {
  mockSsmSend.mockReset().mockImplementation(async (cmd: { input: { Name: string } }) => {
    if (cmd.input.Name === ADMIN_PARAM) return { Parameter: { Value: ADMIN } };
    if (cmd.input.Name === FLOW_PARAM) return { Parameter: { Value: FLOW } };
    return { Parameter: { Value: BOT } };
  });
}

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = APP;
  // The trusted-issuer registry: the deployment's own pool, and the host's with the one-conversation
  // session. The basic creator is the one that serves context conversations.
  process.env.TRUSTED_ISSUERS = JSON.stringify([
    { id: 'deployment', kind: 'cognito-pool', pool: 'us-east-1_Deployment', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Deployment', subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
    { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', iss: HOST_ISS, subject: ['sub'], clearance: { oneChannel: 'basic', classifications: ['basic'] }, admin: false, groupsClaim: 'cognito:groups' },
  ]);
  process.env.CONVERSATION_CREATORS = JSON.stringify({ basic: 'creator-basic', standard: 'creator-standard', premium: 'creator-premium' });
  process.env.CONTEXT_CONVERSATIONS = 'true';
  process.env.SSM_ROOT = '/agent-echelon';
  process.env.CHANNEL_CONTEXT_TABLE = 'ChannelContextTest';
  process.env.CHANNEL_FLOW_ARN_PARAM = FLOW_PARAM;
  process.env.CREATOR_BEARER_ARN_PARAM = ADMIN_PARAM;
  ({ handler } = (await import('../lambda/src/create-conversation')) as unknown as { handler: Handler });
});

beforeEach(() => {
  mockMessagingSend.mockReset().mockResolvedValue({ ChannelArn: CHANNEL });
  answerSsm();
  mockDdbSend.mockReset().mockResolvedValue({});
});

function event(extra: Record<string, unknown> = {}, personId?: string) {
  return {
    httpMethod: 'POST',
    requestContext: { authorizer: edgeContext({ claims: { sub: 'foreign-sub', iss: HOST_ISS }, personId }) },
    body: JSON.stringify({
      contextType: 'plan',
      contextId: 'p1',
      title: 'My Plan',
      userName: 'Priya',
      participantProfile: 'recruiter at Stratum Technologies',
      domainContext: { items: [{ t: 'JD' }] },
      otherContexts: [{ title: 'other plan' }],
      participants: [{ sub: 's1', iss: 'i', role: 'owner' }],
      userLanguage: 'en',
      ...extra,
    }),
  };
}

type Call = { __type: string; input: Record<string, any> };
const calls = (): Call[] => mockMessagingSend.mock.calls.map((c) => c[0] as Call);
const types = () => calls().map((c) => c.__type);

describe('a context conversation keeps the P1 privacy promise', () => {
  it('keeps the private host grounding OUT of member-readable channel Metadata', async () => {
    const r = await handler(event());
    expect(r.statusCode).toBeLessThan(300);

    const createCall = calls().find((c) => c.__type === 'CreateChannel');
    expect(createCall).toBeDefined();
    const meta = JSON.parse(createCall!.input.Metadata);

    // The four private fields must NOT be member-readable.
    expect(meta).not.toHaveProperty('participantProfile');
    expect(meta).not.toHaveProperty('domainContext');
    expect(meta).not.toHaveProperty('otherContexts');
    expect(meta).not.toHaveProperty('userName');

    // Nor the model-routing signals: Metadata is member-WRITABLE, so leaving them here would let a
    // member steer which model answers their own conversation.
    expect(meta).not.toHaveProperty('userLanguage');
    expect(meta).not.toHaveProperty('segment');

    // NOR THE ROSTER. `{sub, iss, role}` is identity, which METADATA-AND-TAGS §1 puts on the never
    // list: Metadata is readable by every member and writable by any moderator, so a roster here
    // disclosed who else was in the conversation and which IdP they came from, and let a member edit
    // it. It moved to the server-only store as `memberIdentities` (asserted below).
    expect(meta).not.toHaveProperty('participants');

    // What legitimately stays: the conversation's own labels, which name no person.
    expect(meta.contextType).toBe('plan');
    expect(meta.contextId).toBe('p1');
    expect(meta.topic).toBe('My Plan');
    expect(meta.modelTier).toBe('basic');
  });

  it('writes the roster to the SERVER-ONLY store instead', async () => {
    await handler(event());
    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    expect(upd).toBeDefined();
    // Still recorded: it is the one place the host-supplied role and home issuer of each member live.
    expect(upd.input.ExpressionAttributeValues[':memberIdentities'])
      .toEqual([{ sub: 's1', iss: 'i', role: 'owner' }]);
  });

  it('writes the private host grounding to the SERVER-ONLY Channel Context store', async () => {
    await handler(event());

    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    expect(upd).toBeDefined();
    expect(upd.input.TableName).toBe('ChannelContextTest');
    expect(upd.input.Key).toEqual({ channelArn: CHANNEL });

    const vals = upd.input.ExpressionAttributeValues;
    expect(vals[':participantProfile']).toBe('recruiter at Stratum Technologies');
    expect(vals[':domainContext']).toEqual({ items: [{ t: 'JD' }] });
    expect(vals[':otherContexts']).toEqual([{ title: 'other plan' }]);
    expect(vals[':userName']).toBe('Priya');
  });

  it('writes the model-routing signals to the store, not to Metadata', async () => {
    await handler(event({ segment: { country: 'CN' } }));

    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    const vals = upd.input.ExpressionAttributeValues;
    expect(vals[':userLanguage']).toBe('en');
    expect(vals[':segment']).toEqual({ country: 'CN' });
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

describe('created through the shared creator, as the service admin', () => {
  it('the service admin creates the channel, at the deterministic id, at the classification the issuer names', async () => {
    const r = await handler(event());
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).conversationArn).toBe(CHANNEL);

    const create = calls().find((c) => c.__type === 'CreateChannel')!;
    expect(create.input.ChimeBearer).toBe(ADMIN);
    expect(create.input.ChannelId).toBe('ctx-basic-plan-p1');
    expect(create.input.Name).toBe('My Plan');
    const tags = Object.fromEntries((create.input.Tags as Array<{ Key: string; Value: string }>).map((t) => [t.Key, t.Value]));
    expect(tags).toEqual(expect.objectContaining({ classification: 'basic', contextType: 'plan', conversationType: 'general' }));
    expect(tags.primaryAssistant).toBeTruthy();
  });

  it('no Amazon Chime SDK create, flow or membership call bears the assistant', async () => {
    await handler(event());
    const writes = calls().filter((c) => c.__type !== 'SendMessage');
    expect(writes.length).toBeGreaterThan(0);
    for (const c of writes) expect([c.__type, c.input.ChimeBearer]).toEqual([c.__type, ADMIN]);
  });

  it('attaches the flow before any member is added, then adds the assistant and the person', async () => {
    // The person is the AppInstanceUser the exchange minted for (the host's registry id, sub), never the
    // host's sub and never an id derived from it.
    // The edge resolved (the host's registry id, sub) to the minted person and named it in its context.
    const { resolvePerson } = jest.requireMock('../lambda/src/lib/person-identity') as { resolvePerson: jest.Mock };
    resolvePerson.mockClear();
    await handler(event({}, MINTED));
    expect(resolvePerson).not.toHaveBeenCalled();
    const order = types();
    expect(order[0]).toBe('CreateChannel');
    expect(order[1]).toBe('AssociateFlow');
    const members = calls().filter((c) => c.__type === 'CreateMembership').map((c) => c.input.MemberArn);
    expect(members[0]).toBe(BOT);
    expect(members).toContain(`${APP}/user/${MINTED}`);
    expect(members.some((m) => String(m).endsWith('/foreign-sub'))).toBe(false);
    const moderators = calls().filter((c) => c.__type === 'CreateModerator').map((c) => c.input.ChannelModeratorArn);
    expect(moderators).toEqual(expect.arrayContaining([BOT, members[1]]));
  });

  it('the service admin leaves the room it assembled', async () => {
    await handler(event());
    expect(calls().find((c) => c.__type === 'DeleteMembership')?.input.MemberArn).toBe(ADMIN);
    expect(calls().find((c) => c.__type === 'DeleteModerator')?.input.ChannelModeratorArn).toBe(ADMIN);
  });

  it('writes the context row only once the channel is known to be new', async () => {
    await handler(event());
    const createAt = mockMessagingSend.mock.invocationCallOrder[types().indexOf('CreateChannel')];
    const firstWrite = mockDdbSend.mock.invocationCallOrder[0];
    expect(firstWrite).toBeGreaterThan(createAt);
    // And before the assistant is added, so a welcome fired by that membership reads it.
    const botAddAt = mockMessagingSend.mock.invocationCallOrder[types().indexOf('CreateMembership')];
    expect(firstWrite).toBeLessThan(botAddAt);
  });
});

describe('an existing conversation admits only its own members (security review, 2026-10-13)', () => {
  const conflict = () => Object.assign(new Error('exists'), { name: 'ConflictException' });
  const notFound = () => Object.assign(new Error('nf'), { name: 'NotFoundException' });
  const respond = (handlers: Record<string, () => unknown>) => mockMessagingSend.mockImplementation(async (cmd: { __type: string }) => {
    const h = handlers[cmd.__type];
    return h ? h() : {};
  });

  it('refuses a host user who names another person’s context, and changes nothing', async () => {
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => { throw notFound(); },
      ListMemberships: () => ({ ChannelMemberships: [{ Member: { Arn: BOT } }, { Member: { Arn: `${APP}/user/fed_owner` } }] }),
    });
    const r = await handler(event());
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).code).toBe('NOT_A_MEMBER');
    expect(types()).not.toContain('UpdateChannel');
    expect(types()).not.toContain('CreateMembership');
    expect(types()).not.toContain('CreateModerator');
    // The private grounding is not touched either: the shared creator writes nothing on a conflict.
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('re-opens it for someone already in it, acting as the service admin', async () => {
    respond({ CreateChannel: () => { throw conflict(); }, DescribeMembership: () => ({}) });
    const r = await handler(event());
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).conversationArn).toBe(CHANNEL);
    expect(types()).toEqual(expect.arrayContaining(['UpdateChannel', 'CreateMembership']));
    for (const c of calls().filter((x) => x.__type !== 'CreateChannel')) {
      expect([c.__type, c.input.ChimeBearer]).toEqual([c.__type, ADMIN]);
    }
    // The edited grounding is re-stamped.
    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    expect(upd.input.ExpressionAttributeValues[':userName']).toBe('Priya');
  });

  it('tolerates the assistant and the person already being seated', async () => {
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => ({}),
      CreateMembership: () => { throw conflict(); },
      CreateModerator: () => { throw conflict(); },
    });
    expect((await handler(event())).statusCode).toBe(200);
  });

  it('admits the first create still in flight: no person is in the channel yet', async () => {
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => { throw notFound(); },
      ListMemberships: () => ({ ChannelMemberships: [{ Member: { Arn: BOT } }] }),
    });
    expect((await handler(event())).statusCode).toBe(200);
  });

  it('does not count the service admin as a person while a first create is in flight', async () => {
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => { throw notFound(); },
      ListMemberships: () => ({ ChannelMemberships: [{ Member: { Arn: ADMIN } }] }),
    });
    expect((await handler(event())).statusCode).toBe(200);
  });

  it('a retry after a partial first create attaches the missing flow BEFORE any member, and writes the missing context row', async () => {
    // The first create made the channel and then failed to attach the flow (logged, not fatal for this
    // origin) or died between the two calls. The retry's CreateChannel answers ConflictException.
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => { throw notFound(); },
      ListMemberships: () => ({ ChannelMemberships: [{ Member: { Arn: ADMIN } }] }),
      DescribeChannel: () => ({ Channel: { ChannelArn: CHANNEL } }),
    });
    const r = await handler(event());
    expect(r.statusCode).toBe(200);
    const order = types();
    const associate = calls().find((c) => c.__type === 'AssociateFlow');
    expect(associate?.input).toMatchObject({ ChannelArn: CHANNEL, ChannelFlowArn: FLOW, ChimeBearer: ADMIN });
    expect(order.indexOf('AssociateFlow')).toBeLessThan(order.indexOf('CreateMembership'));
    // The context row creation would have written, filled in only where it is missing.
    const seeded = mockDdbSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'Update')
      .find((c) => String(c.input.UpdateExpression).includes('#participants = if_not_exists(#participants'));
    expect(seeded).toBeDefined();
    expect(seeded.input.ExpressionAttributeValues[':participants']).toBeDefined();
    expect(seeded.input.ExpressionAttributeValues[':conversationType']).toBe('general');
    expect(String(seeded.input.UpdateExpression)).not.toMatch(/#participants = :participants/);
  });

  it('a complete room keeps its flow: nothing is re-attached', async () => {
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => ({}),
      DescribeChannel: () => ({ Channel: { ChannelArn: CHANNEL, ChannelFlowArn: FLOW } }),
    });
    expect((await handler(event())).statusCode).toBe(200);
    expect(types()).not.toContain('AssociateFlow');
  });

  it('adds no member to a room whose flow cannot be read or attached', async () => {
    respond({
      CreateChannel: () => { throw conflict(); },
      DescribeMembership: () => ({}),
      DescribeChannel: () => ({ Channel: { ChannelArn: CHANNEL } }),
      AssociateFlow: () => { throw Object.assign(new Error('denied'), { name: 'ForbiddenException' }); },
    });
    expect((await handler(event())).statusCode).toBe(500);
    expect(types()).not.toContain('CreateMembership');
    expect(types()).not.toContain('CreateModerator');
  });

  it('refuses when the membership cannot be read, rather than admitting on an unknown', async () => {
    respond({ CreateChannel: () => { throw conflict(); }, DescribeMembership: () => { throw Object.assign(new Error('x'), { name: 'ForbiddenException' }); } });
    expect((await handler(event())).statusCode).toBe(403);
  });
});

describe('a context conversation with no service admin (step 33)', () => {
  // No assistant-bearer fallback: the role holds no create, tag or membership change bearing an
  // assistant, so a deployment without a service admin is refused before any call is made.
  const clearCache = async () => (await import('../lambda/src/lib/service-admin-bearer')).__clearServiceAdminBearerCache();
  afterEach(clearCache);

  it('refuses to create or re-open, and calls nothing', async () => {
    await clearCache();
    mockSsmSend.mockImplementation(async (cmd: { input: { Name: string } }) => {
      if (cmd.input.Name === ADMIN_PARAM) return { Parameter: { Value: '' } };
      if (cmd.input.Name === FLOW_PARAM) return { Parameter: { Value: FLOW } };
      return { Parameter: { Value: BOT } };
    });
    const r = await handler(event());
    expect(`${r.statusCode} ${JSON.parse(r.body).code}`).toBe('500 SERVER_MISCONFIG');
    expect(calls()).toEqual([]);
  });
});

describe('which create a caller gets follows from their issuer, never from the request', () => {
  it('a one-conversation caller asking for a typed conversation still opens only a context one', async () => {
    const r = await handler({
      httpMethod: 'POST',
      requestContext: { authorizer: edgeContext({ claims: { sub: 'foreign-sub', iss: HOST_ISS, 'cognito:groups': 'premium' } }) },
      body: JSON.stringify({ title: 'Mine', modelId: 'm', modelTier: 'premium' }),
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('INVALID_REQUEST');
    expect(types()).not.toContain('CreateChannel');
  });

  it('a person of the deployment\'s own pool naming a context gets the typed path, not a context conversation', async () => {
    const r = await handler({
      httpMethod: 'POST',
      requestContext: { authorizer: edgeContext({ claims: { sub: 'native-sub', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Deployment', 'cognito:groups': 'basic' } }) },
      body: JSON.stringify({ contextType: 'plan', contextId: 'p1' }),
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('MISSING_REQUIRED_FIELDS');
    expect(types()).not.toContain('CreateChannel');
  });

  it('a token from an issuer the registry does not declare opens nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await handler({
      httpMethod: 'POST',
      requestContext: { authorizer: edgeContext({ claims: { sub: 'foreign-sub', iss: 'https://host-idp' } }) },
      body: JSON.stringify({ contextType: 'plan', contextId: 'p1' }),
    });
    warn.mockRestore();
    expect(r.statusCode).toBe(401);
    expect(types()).not.toContain('CreateChannel');
  });
});

describe('a creator no oneChannel issuer names refuses a context request', () => {
  it('refuses, and creates nothing', async () => {
    const saved = process.env.CONTEXT_CONVERSATIONS;
    process.env.CONTEXT_CONVERSATIONS = 'false';
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      jest.resetModules();
      process.env.CREATOR_CLASSIFICATION = 'basic';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { handler: creator } = require('../lambda/src/create-conversation-at-classification');
      const result = await creator({ kind: 'context', classification: 'basic', userArn: `${APP}/user/${MINTED}`, body: { contextType: 'plan', contextId: 'p1' } });
      expect(result).toMatchObject({ ok: false, code: 'SERVER_MISCONFIG' });
      expect(types()).not.toContain('CreateChannel');
    } finally {
      err.mockRestore();
      process.env.CONTEXT_CONVERSATIONS = saved;
    }
  });
});
