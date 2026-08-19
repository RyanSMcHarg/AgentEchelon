/**
 * Federated add-member — the P1 privacy promise (backend-data assertion).
 *
 * Same guarantee as federated-create: the private host grounding (participantProfile, domainContext,
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
  AssociateChannelFlowCommand: jest.fn().mockImplementation((a) => ({ __type: 'AssociateFlow', input: a })),
  UpdateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'UpdateChannel', input: a })),
  SendChannelMessageCommand: jest.fn().mockImplementation((a) => ({ __type: 'SendMessage', input: a })),
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

type Handler = (e: unknown) => Promise<{ ok?: boolean }>;
let handler: Handler;

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ASSISTANT_CLASSIFICATION = 'basic';
  process.env.SSM_ROOT = '/agent-echelon';
  process.env.CHANNEL_CONTEXT_TABLE = 'ChannelContextTest';
  delete process.env.CHANNEL_FLOW_ARN_PARAM;
  ({ handler } = (await import('../lambda/src/federated-add-member')) as unknown as { handler: Handler });
});

beforeEach(() => {
  mockMessagingSend.mockReset().mockResolvedValue({ ChannelArn: `${APP}/channel/fed-basic-plan-p1` });
  mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: `${APP}/bot/basic` } });
  mockDdbSend.mockReset().mockResolvedValue({});
});

function event() {
  return {
    contextType: 'plan',
    contextId: 'p1',
    iss: 'https://host-idp',
    sub: 'foreign-sub',
    title: 'My Plan',
    userName: 'Priya',
    userLanguage: 'en',
    participantProfile: 'recruiter at Stratum Technologies',
    domainContext: { items: [{ title: 'JD' }] },
    otherContexts: [{ title: 'other plan' }],
  };
}

describe('federated add-member — P1 privacy promise', () => {
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
    expect(upd.input.Key).toEqual({ channelArn: `${APP}/channel/fed-basic-plan-p1` });
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
    expect(vals[':entry']).toEqual([{ sub: 'foreign-sub', iss: 'https://host-idp' }]);
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
      { sub: 'foreign-sub', iss: 'https://host-idp', role: 'reviewer' },
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
 * The channel flow must be associated BEFORE any membership.
 *
 * The assistant becomes a channel member here, and Lex can fire WelcomeIntent from that moment; every
 * message created before the association bypasses the flow entirely. `CreateChannel` takes no
 * channel-flow field, so immediately after creation is the earliest possible point.
 *
 * This is the SAME defect `39208b5` fixed in `create-conversation/index.js`. It was fixed there only,
 * and survived in this path plus two others because nothing held the six creation paths to one order.
 */
describe('channel-flow association ordering', () => {
  it('associates the flow before adding any member', async () => {
    // The suite above deletes CHANNEL_FLOW_ARN_PARAM, which disables association entirely, so this
    // needs its own module instance with the param set — otherwise the assertion passes vacuously on
    // a run where no AssociateChannelFlow is ever issued.
    jest.resetModules();
    process.env.CHANNEL_FLOW_ARN_PARAM = '/agent-echelon/channel-flow-arn';
    const mod = (await import('../lambda/src/federated-add-member')) as unknown as { handler: Handler };
    mockMessagingSend.mockReset().mockResolvedValue({ ChannelArn: `${APP}/channel/fed-basic-plan-p1` });
    mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: `${APP}/bot/basic` } });
    mockDdbSend.mockReset().mockResolvedValue({});
    try {
      await mod.handler(event());
      const order = mockMessagingSend.mock.calls.map((c) => (c[0] as { __type: string }).__type);
      expect(order).toContain('AssociateFlow');
      expect(order.indexOf('AssociateFlow')).toBeLessThan(order.indexOf('CreateMembership'));
    } finally {
      delete process.env.CHANNEL_FLOW_ARN_PARAM;
    }
  });
});

/**
 * Adding a member must not wipe the conversation's grounding (owner, 2026-08-10).
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
    await handler({ contextType: 'plan', contextId: 'p1', iss: 'https://host-idp', sub: 'foreign-sub' });
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
      contextType: 'plan', contextId: 'p1', iss: 'https://host-idp', sub: 'foreign-sub',
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
