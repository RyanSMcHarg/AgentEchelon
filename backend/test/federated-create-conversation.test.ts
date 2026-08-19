/**
 * Federated create-conversation — the P1 privacy promise (backend-data assertion).
 *
 * The sensitive host grounding (participantProfile, domainContext, otherContexts, userName) must go to
 * the SERVER-ONLY Channel Context store and must NOT appear in the Amazon Chime SDK channel Metadata
 * (which any member can read via DescribeChannel). The model-ROUTING signals (userLanguage, segment)
 * go to the same store, because Metadata is member-WRITABLE and they decide which model answers. Only
 * the conversation's identity bits (contextType, contextId, topic) and the participant ROSTER stay in
 * Metadata by design.
 *
 * This asserts the real backend effects (the CreateChannel Metadata payload + the DynamoDB write),
 * not a render or a 200 — the discipline the doc-vs-code audit exists to enforce.
 */
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  CreateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateChannel', input: a })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateMembership', input: a })),
  CreateChannelModeratorCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateModerator', input: a })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((a) => ({ __type: 'AssociateFlow', input: a })),
  UpdateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'UpdateChannel', input: a })),
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

type Handler = (e: unknown) => Promise<{ statusCode: number; body: string }>;
let handler: Handler;

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ASSISTANT_CLASSIFICATION = 'basic';
  process.env.SSM_ROOT = '/agent-echelon';
  process.env.CHANNEL_CONTEXT_TABLE = 'ChannelContextTest';
  delete process.env.CHANNEL_FLOW_ARN_PARAM; // ⇒ flow-associate is skipped, fewer mocks
  ({ handler } = (await import('../lambda/src/federated-create-conversation')) as unknown as { handler: Handler });
});

beforeEach(() => {
  mockMessagingSend.mockReset().mockResolvedValue({ ChannelArn: `${APP}/channel/fed-basic-plan-p1` });
  mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: `${APP}/bot/basic` } });
  mockDdbSend.mockReset().mockResolvedValue({});
});

function event(extra: Record<string, unknown> = {}) {
  return {
    httpMethod: 'POST',
    requestContext: { authorizer: { claims: { sub: 'foreign-sub', iss: 'https://host-idp' } } },
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

describe('federated create-conversation — P1 privacy promise', () => {
  it('keeps the private host grounding OUT of member-readable channel Metadata', async () => {
    const r = await handler(event());
    expect(r.statusCode).toBeLessThan(300);

    const createCall = mockMessagingSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.__type === 'CreateChannel');
    expect(createCall).toBeDefined();
    const meta = JSON.parse(createCall.input.Metadata);

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
  });

  it('writes the roster to the SERVER-ONLY store instead', async () => {
    await handler(event());
    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    expect(upd).toBeDefined();
    // Still recorded — a federated member's AppInstanceUser id is a one-way hash of (iss, sub), so
    // without this nothing can map them back to an IdP to resolve contact details.
    expect(upd.input.ExpressionAttributeValues[':memberIdentities'])
      .toEqual([{ sub: 's1', iss: 'i', role: 'owner' }]);
  });

  it('writes the private host grounding to the SERVER-ONLY Channel Context store', async () => {
    await handler(event());

    const upd = mockDdbSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Update');
    expect(upd).toBeDefined();
    expect(upd.input.TableName).toBe('ChannelContextTest');
    expect(upd.input.Key).toEqual({ channelArn: `${APP}/channel/fed-basic-plan-p1` });

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

/**
 * The channel flow must be associated BEFORE any membership — see federated-add-member.test.ts for the
 * full reasoning. Same defect as `39208b5`, which fixed only `create-conversation/index.js`.
 */
describe('channel-flow association ordering', () => {
  it('associates the flow before adding any member or moderator', async () => {
    // The suite above deletes CHANNEL_FLOW_ARN_PARAM ("⇒ flow-associate is skipped, fewer mocks"), so
    // this needs its own module instance with the param set — otherwise no AssociateChannelFlow is
    // ever issued and the ordering assertion would pass vacuously.
    jest.resetModules();
    process.env.CHANNEL_FLOW_ARN_PARAM = '/agent-echelon/channel-flow-arn';
    const mod = (await import('../lambda/src/federated-create-conversation')) as unknown as { handler: Handler };
    mockMessagingSend.mockReset().mockResolvedValue({ ChannelArn: `${APP}/channel/fed-basic-plan-p1` });
    mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: `${APP}/bot/basic` } });
    mockDdbSend.mockReset().mockResolvedValue({});
    try {
      await mod.handler(event());
      const order = mockMessagingSend.mock.calls.map((c) => (c[0] as { __type: string }).__type);
      expect(order).toContain('AssociateFlow');
      expect(order.indexOf('AssociateFlow')).toBeLessThan(order.indexOf('CreateMembership'));
      expect(order.indexOf('AssociateFlow')).toBeLessThan(order.indexOf('CreateModerator'));
    } finally {
      delete process.env.CHANNEL_FLOW_ARN_PARAM;
    }
  });
});
