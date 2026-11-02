/**
 * Proactive Briefing Lambda — unit tests.
 *
 * This is the proactive-workflow test that was explicitly missing. It
 * pins: an EventBridge fire (no user) creates a conversation through the
 * shared creator as the service admin, adds members, seeds the conversation, and emails members a link
 * INTO the conversation (never a presigned page) via the notification workflow, resiliently (a
 * member-add failure doesn't abort) and cleanly when no recipients are configured.
 *
 * Mocks the AWS SDK clients + the notification module so the test is
 * pure (no SES/Chime). Mirrors channel-battle.test.ts mocking +
 * battle-state.test.ts reset-modules-per-test (the Lambda captures
 * several env vars at module load).
 */

const mockChimeSend = jest.fn();
const mockSsmSend = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  CreateChannelCommand: jest.fn().mockImplementation((i) => ({ __t: 'CreateChannel', i })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((i) => ({ __t: 'AddMember', i })),
  CreateChannelModeratorCommand: jest.fn().mockImplementation((i) => ({ __t: 'AddModerator', i })),
  DeleteChannelMembershipCommand: jest.fn().mockImplementation((i) => ({ __t: 'Leave', i })),
  DeleteChannelModeratorCommand: jest.fn().mockImplementation((i) => ({ __t: 'DropModerator', i })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((i) => ({ __t: 'AssocFlow', i })),
  SendChannelMessageCommand: jest.fn().mockImplementation((i) => ({ __t: 'SendMsg', i })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((i) => ({ __t: 'ListTags', i })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((i) => ({ __t: 'GetParam', i })),
}), { virtual: true });


// The seed line is named to the router, which says it as the conversation's assistant.
const mockSay = jest.fn(async (..._args: unknown[]) => ({ posted: true }));
jest.mock('../lambda/src/lib/say-through-router', () => ({ sayThroughRouter: (...a: unknown[]) => mockSay(...a) }));
jest.mock('../lambda/src/lib/notification', () => ({
  ...jest.requireActual('../lambda/src/lib/notification'),
  sendEmailNotifications: (...a: unknown[]) => mockSendEmail(...a),
}));

// THE RECIPIENTS ARE PEOPLE, by AppInstanceUser ARN. Their names and addresses are the directory's,
// resolved at run time; the configuration carries neither.
const MEMBERS = [
  { userArn: 'arn:aws:chime:us-east-1:111:app-instance/i/user/a', email: 'a@stratum.example.com', name: 'Demo Basic' },
  { userArn: 'arn:aws:chime:us-east-1:111:app-instance/i/user/b', email: 'b@stratum.example.com', name: 'Demo Standard' },
];
const byArn = new Map(MEMBERS.map((m) => [m.userArn, m]));

/** The handler, with the directory answering for the members above. */
async function loadHandler() {
  const ms = await import('../lambda/src/lib/membership-source');
  ms.__setDefaultDirectoryForTests({
    personsInGroup: async () => ({ persons: [], unminted: [] }),
    personOf: async () => null,
    admins: async () => ({ persons: [], unminted: [] }),
    clearanceOf: async () => ({ state: 'none' as const }),
    listGroups: async () => [],
    groupsFor: async () => [],
    clearedByGroups: async () => null,
    findByAddress: async () => null,
    accountState: async () => 'active' as const,
    displayNameFor: async (arn) => byArn.get(arn)?.name ?? null,
    contactFor: async (arn) => (byArn.get(arn) ? { route: 'email', address: byArn.get(arn)!.email, name: byArn.get(arn)!.name } : null),
  });
  return (await import('../lambda/src/proactive-briefing')).handler;
}
const ADMIN = 'arn:aws:chime:us-east-1:111:app-instance/i/user/ae-admin';
const ADMIN_PARAM = '/agent/app-instance-admin-arn';

/** The service admin by its parameter; every other read is the standard assistant's bot. */
function answerSsm(admin = ADMIN): void {
  mockSsmSend.mockImplementation(async (cmd: { i: { Name: string } }) =>
    ({ Parameter: { Value: cmd.i.Name === ADMIN_PARAM ? admin : 'arn:bot/default' } }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i';
  process.env.BOT_ARN_PARAM = '/agent/bot-arn';
  process.env.CHANNEL_FLOW_ARN_PARAM = '/agent/flow-arn';
  process.env.CREATOR_BEARER_ARN_PARAM = ADMIN_PARAM;
  process.env.APP_URL = 'https://app.example';
  process.env.BRIEFING_RECIPIENT_ARNS = MEMBERS.map((m) => m.userArn).join(',');
  answerSsm();
  mockChimeSend.mockImplementation((cmd) =>
    cmd.__t === 'CreateChannel'
      ? Promise.resolve({ ChannelArn: 'arn:channel/proactive-1' })
      : Promise.resolve({}),
  );
  mockSendEmail.mockResolvedValue({ sent: ['a@stratum.example.com', 'b@stratum.example.com'], failed: [] });
});

describe('proactive-briefing handler', () => {
  it('no recipients configured → ok, and nothing is created', async () => {
    process.env.BRIEFING_RECIPIENT_ARNS = '';
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(true);
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('creates a RESTRICTED/PRIVATE standard conversation as the service admin and adds every member', async () => {
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' });

    expect(res.ok).toBe(true);
    expect(res.conversationArn).toBe('arn:channel/proactive-1');

    const create = mockChimeSend.mock.calls.find((c) => c[0].__t === 'CreateChannel')![0];
    expect(create.i.Mode).toBe('RESTRICTED');
    expect(create.i.Privacy).toBe('PRIVATE');
    // THE SHARED CREATOR, AS THE SERVICE ADMIN: never as the assistant.
    expect(create.i.ChimeBearer).toBe(ADMIN);
    expect(JSON.parse(create.i.Metadata)).toEqual(expect.objectContaining({ createdViaProactive: true, modelTier: 'standard' }));
    expect(create.i.Tags).toEqual(expect.arrayContaining([
      { Key: 'classification', Value: 'standard' },
      { Key: 'conversationType', Value: 'general' },
    ]));

    // The assistant and both recipients are added; every membership change bears the admin, which leaves.
    const adds = mockChimeSend.mock.calls.filter((c) => c[0].__t === 'AddMember');
    expect(adds.map((a) => a[0].i.MemberArn).sort()).toEqual(['arn:aws:chime:us-east-1:111:app-instance/i/user/a', 'arn:aws:chime:us-east-1:111:app-instance/i/user/b', 'arn:bot/default']);
    const writes = mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => ['CreateChannel', 'AssocFlow', 'AddMember', 'AddModerator', 'Leave', 'DropModerator'].includes(c.__t));
    expect([...new Set(writes.map((c) => c.i.ChimeBearer))]).toEqual([ADMIN]);
    expect(mockChimeSend.mock.calls.some((c) => c[0].__t === 'Leave' && c[0].i.MemberArn === ADMIN)).toBe(true);
    // Nobody opened a briefing, so no recipient is made a moderator: only the assistant is.
    const moderators = mockChimeSend.mock.calls.filter((c) => c[0].__t === 'AddModerator').map((c) => c[0].i.ChannelModeratorArn);
    expect(moderators).toEqual(['arn:bot/default']);
  });

  it('with no service admin, creates nothing: a conversation is never created as the assistant', async () => {
    answerSsm('');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events' });
    error.mockRestore();
    expect(res.ok).toBe(false);
    expect(mockChimeSend.mock.calls.some((c) => c[0].__t === 'CreateChannel')).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('emails every member a link into the conversation, and no presigned page', async () => {
    const handler = await loadHandler();
    await handler({ source: 'aws.events' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [recipients, content] = mockSendEmail.mock.calls[0];
    expect(recipients.map((r: { email: string; name: string }) => [r.email, r.name])).toEqual([
      ['a@stratum.example.com', 'Demo Basic'],
      ['b@stratum.example.com', 'Demo Standard'],
    ]);
    // A briefing is a mail a person can stop, so each carries its unsubscribe link.
    for (const r of recipients) expect(r.unsubscribeUrl).toMatch(/\/email\/preferences\?t=/);
    expect(content.subject).toMatch(/^Proactive briefing for \d{4}-\d{2}-\d{2}$/);
    expect(content.bodyText).toContain('https://app.example?conversation=conv-proactive-');
    expect(JSON.stringify(content)).not.toMatch(/X-Amz-|s3\./);
  });

  it('names the seed line to the router as the conversation assistant, with no link in it', async () => {
    const handler = await loadHandler();
    await handler({ source: 'aws.events' });
    expect(mockChimeSend.mock.calls.some((c) => c[0].__t === 'SendMsg')).toBe(false);
    const [classification, notice] = mockSay.mock.calls[mockSay.mock.calls.length - 1] as [string, { kind: string; botArn: string; vars: Record<string, string> }];
    expect(classification).toBe('standard');
    expect(notice.kind).toBe('briefingReady');
    expect(notice.botArn).toBe('arn:bot/default');
    expect(notice.vars).toEqual({ source: 'aws.events / Scheduled' });
  });

  it('is resilient: a member-add failure does not abort the run', async () => {
    mockChimeSend.mockImplementation((cmd) => {
      if (cmd.__t === 'CreateChannel') return Promise.resolve({ ChannelArn: 'arn:channel/p' });
      if (cmd.__t === 'AddMember' && cmd.i.MemberArn === 'arn:aws:chime:us-east-1:111:app-instance/i/user/a') {
        return Promise.reject(new Error('not a member of app instance'));
      }
      return Promise.resolve({});
    });
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1); // still emailed
  });

  it('top-level failure returns ok:false (no throw → no EventBridge retry storm)', async () => {
    mockChimeSend.mockImplementation((cmd) =>
      cmd.__t === 'CreateChannel' ? Promise.reject(new Error('Chime down')) : Promise.resolve({}),
    );
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Chime down');
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};

/**
 * The channel flow must be associated BEFORE any membership.
 *
 * Lex fires WelcomeIntent the moment the assistant becomes a member, and every message created before
 * the association bypasses the flow. The service admin creates, so the assistant is first added after
 * the association (`lib/channel-creation.ts`).
 */
describe('channel-flow association ordering', () => {
  it('associates the flow before adding any member', async () => {
    const handler = await loadHandler();
    await handler({ source: 'aws.events' });
    const order = mockChimeSend.mock.calls.map((c) => (c[0] as { __t: string }).__t);
    // Guard against a vacuous pass: if no association is issued at all, the ordering below is
    // meaningless. CHANNEL_FLOW_ARN_PARAM is set in beforeEach, so it must appear.
    expect(order).toContain('AssocFlow');
    expect(order.indexOf('AssocFlow')).toBeLessThan(order.indexOf('AddMember'));
  });
});

/**
 * THE BRIEFING IS HELD AT THE CLASSIFICATION THAT DECLARES IT (`holdsBriefing`), whatever
 * its classifications are called, and a deployment that declares none creates nothing.
 */
describe('the briefing classification is declared', () => {
  const topology = { timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 5, maxTokens: 1024,
    streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true, richProcessor: false, handlerExperimentsIndex: false };
  const ownSet = (briefing?: string) => ({
    classifications: [
      { value: 'internal', profile: 'colleague', grants: ['internal'], topology, models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3'], default: 'sonnet' }, holdsBriefing: briefing === 'internal' },
      { value: 'partner', profile: 'envoy', grants: ['partner'], topology, models: { selected: ['haiku'], default: 'haiku' }, holdsBriefing: briefing === 'partner' },
    ],
    profiles: [
      { name: 'colleague', modelKey: 'sonnet', classifierMode: 'llm' as const, timeoutSeconds: 30, contextScope: 'granted' as const },
      { name: 'envoy', modelKey: 'haiku', classifierMode: 'llm' as const, timeoutSeconds: 30, contextScope: 'granted' as const },
    ],
    groupClearance: { staff: 'internal', partners: 'partner' },
  });
  // The deployment's set, as the handler reads it at runtime: the rows its stacks publish.
  const install = async (briefing?: string) => {
    const { resolveDeploymentProfiles } = await import('../lib/config/profiles');
    const { seedRegistryRows } = await import('./helpers/registry-rows');
    seedRegistryRows(resolveDeploymentProfiles(ownSet(briefing)));
  };
  afterEach(async () => {
    const { clearRegistryRows } = await import('./helpers/registry-rows');
    clearRegistryRows();
  });

  it('creates the conversation at the declared classification and names the seed line to its router', async () => {
    await install('partner');
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(true);
    const create = mockChimeSend.mock.calls.find((c) => c[0].__t === 'CreateChannel')![0];
    expect(create.i.Tags).toEqual(expect.arrayContaining([{ Key: 'classification', Value: 'partner' }]));
    expect(mockSay.mock.calls[mockSay.mock.calls.length - 1][0]).toBe('partner');
  });

  it('creates nothing when the deployment declares no briefing classification', async () => {
    await install(undefined);
    const handler = await loadHandler();
    const res = await handler({ source: 'aws.events' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'no briefing classification is declared' }));
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockSay).not.toHaveBeenCalled();
  });
});
