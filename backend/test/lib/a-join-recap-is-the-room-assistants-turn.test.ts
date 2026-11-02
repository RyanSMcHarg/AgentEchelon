/**
 * THE RECAP A NEW MEMBER GETS IS A TURN BY THE ROOM'S ASSISTANT (plan step 25, decision row 7).
 *
 * The share used to write the recap itself with a utility model and a fixed prompt, then post it under
 * the assistant's name inside a fixed English wrapper. It now asks the router of the conversation's
 * classification for an ordinary turn (`lib/join-recap.ts`), and the router runs it as the room's
 * primary, in that assistant's model and copy, targeted at the new member.
 *
 * Three halves, each driven rather than read from source:
 *   - the share: adds the member, announces, THEN asks for the recap, and composes no recap itself;
 *   - the router: answers the recap privately to the new member as a `conversation_summary` turn whose
 *     request is the assistant's copy, and refuses one for a non-member or one naming its own speaker;
 *   - the copy: a deployment's wording replaces the shipped English.
 */
const mockChimeSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
  DescribeChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeMembership', input: args })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'CreateMembership', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetMessage', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
  GetParametersByPathCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetByPath', input: args })),
}), { virtual: true });

// Stub only the billed model call. The recap must not reach it at all; the stub records whether it did.
const mockClassify = jest.fn();
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: jest.fn(async (msg: string) => {
      mockClassify(msg);
      return actual.fastPathIntent(msg) ?? { intent: 'general', confidence: 'high' };
    }),
  };
}, { virtual: true });

// THE ABUSE GATE, observed: what each turn asks it, and (when a test says so) its answer.
const mockGateCalls = jest.fn();
let mockGateAnswer: unknown;
jest.mock('../../lambda/src/lib/abuse-controls.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/abuse-controls.js');
  return {
    ...actual,
    evaluateAbuseGate: async (opts: Record<string, unknown>) => {
      mockGateCalls(opts);
      return mockGateAnswer ?? actual.evaluateAbuseGate(opts);
    },
  };
}, { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { edgeContext } from '../helpers/edge-context';

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';
const OWNER = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/alice';
const JOINER = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/bob';

const sends = () => mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === 'SendMessage').map((c) => c.input);
const invokes = () => mockLambdaSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === 'Invoke')
  .map((c) => JSON.parse(Buffer.from(c.input.Payload).toString('utf8')));

/** A roster read answers with these members; every other call answers as a send would. */
function roster(members: string[]) {
  mockChimeSend.mockImplementation(async (cmd: { __type: string }) => (cmd.__type === 'ListMemberships'
    ? { ChannelMemberships: [...members, BOT].map((Arn) => ({ Member: { Arn, Name: Arn.split('/').pop() } })) }
    : { MessageId: 'posted-1' }));
}

describe('the router runs a join recap as the room\'s primary, privately', () => {
  let handler: (e: any) => Promise<{ messages?: { content: string }[] }>;
  let DEFAULT_JOIN_RECAP_REQUEST: string;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CLASSIFICATION = 'premium';
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: BOT },
      Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary', occupancy: 'live' }) }],
    });
    mockLambdaSend.mockResolvedValue({});
    ({ handler } = await import('../../lambda/src/router-agent-handler.js'));
    ({ DEFAULT_JOIN_RECAP_REQUEST } = await import('../../lambda/src/lib/join-recap.js'));
  });

  const recap = (extra: Record<string, unknown> = {}) => ({
    aeTurn: { channelArn: CHANNEL, senderArn: JOINER, targeted: true, trigger: 'join_recap', ...extra },
  });

  it('posts its acknowledgment TARGETED at the new member, as the room\'s assistant', async () => {
    roster([OWNER, JOINER]);
    await handler(recap());
    const posted = sends();
    expect(posted).toHaveLength(1);
    expect(posted[0].ChimeBearer).toBe(BOT);
    expect(posted[0].Target).toEqual([{ MemberArn: JOINER }]);
  });

  it('is private even when the payload declared it public', async () => {
    roster([OWNER, JOINER]);
    await handler(recap({ targeted: false }));
    expect(sends()[0].Target).toEqual([{ MemberArn: JOINER }]);
  });

  it('hands the worker a conversation_summary turn answering the assistant\'s own request, unclassified', async () => {
    roster([OWNER, JOINER]);
    await handler(recap());
    const worker = invokes().find((p) => p.channelArn === CHANNEL && p.intent);
    expect(worker).toMatchObject({
      intent: 'conversation_summary',
      userMessage: DEFAULT_JOIN_RECAP_REQUEST,
      senderArn: JOINER,
      botArn: BOT,
      trigger: 'join_recap',
    });
    // No model call was spent deciding what a recap is.
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('declares no human input, so the input guardrail does not screen the platform\'s own request', async () => {
    // The request is the platform's instruction, which nobody wrote. Screened as a person's input, the
    // prompt-attack filter blocked it and the new member was caught up with a refusal (archive,
    // 2026-10-21). The output guardrail still screens the recap itself.
    roster([OWNER, JOINER]);
    await handler(recap());
    const worker = invokes().find((p) => p.channelArn === CHANNEL && p.intent);
    expect(worker).toHaveProperty('userContent', '');
  });

  it('meters the recap against no allowance of a person: the new member asked for nothing', async () => {
    roster([OWNER, JOINER]);
    mockGateAnswer = undefined;
    await handler(recap());
    expect(mockGateCalls).toHaveBeenCalledWith(expect.objectContaining({ machineWritten: true }));
    // The control: a message the same person typed is metered against them.
    mockGateCalls.mockClear();
    await handler({ aeTurn: { channelArn: CHANNEL, senderArn: JOINER, userMessage: 'what is the billing policy?' } });
    expect(mockGateCalls).toHaveBeenCalledTimes(1);
    expect(mockGateCalls.mock.calls[0][0]).not.toHaveProperty('machineWritten');
  });

  it('a recap the global budget refuses is skipped silently: no budget line to somebody who asked nothing', async () => {
    roster([OWNER, JOINER]);
    mockGateAnswer = { allowed: false, reason: 'budget', message: 'over budget', notice: { kind: 'budgetExhausted', vars: {} } };
    const res = await handler(recap());
    mockGateAnswer = undefined;
    expect(invokes().filter((p) => p.channelArn === CHANNEL && p.intent)).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    expect((res.messages ?? []).map((m) => m.content).join()).not.toContain('over budget');
  });

  it('refuses a recap for somebody who is not in the conversation, and says nothing', async () => {
    roster([OWNER]);
    const res = await handler(recap());
    expect(sends()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
    expect(res.messages ?? []).toEqual([]);
  });

  it('refuses a recap that names its own speaker: the room\'s primary speaks', async () => {
    roster([OWNER, JOINER]);
    await handler(recap({ botArn: BOT }));
    expect(sends()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
  });

  it('is not vacuous: an ordinary turn from the same person is classified and untargeted', async () => {
    roster([OWNER, JOINER]);
    await handler({ aeTurn: { channelArn: CHANNEL, senderArn: JOINER, userMessage: 'what is the billing policy?' } });
    expect(mockClassify).toHaveBeenCalled();
    expect(sends()[0].Target).toBeUndefined();
  });
});

describe('the recap request is the assistant\'s `join-recap` template', () => {
  it('is the shipped English where no template is saved; a version\'s retired copy is not read', async () => {
    const recap = await import('../../lambda/src/lib/join-recap.js');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await recap.joinRecapRequestFor({ classification: 'basic', assistant: 'advisor' })).toBe(recap.DEFAULT_JOIN_RECAP_REQUEST);
    warn.mockRestore();
    // No entry point takes a version's copy any more.
    expect((recap as Record<string, unknown>).joinRecapRequest).toBeUndefined();
    expect(recap.joinRecapRequestFor.length).toBeLessThanOrEqual(2);
  });
});

describe('the share asks for the recap and writes none', () => {
  const ROUTER = 'arn:aws:lambda:us-east-1:111122223333:function:premium-router';

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  /**
   * Share the conversation with Bob. `owned`: whether the router reports that a `person-joined` run owns Bob's welcome
   * (ADR-061 decision 5), which it does only where the room's assistant declares a workflow on that event.
   */
  async function shareWithBob(owned: boolean) {
    const { routerArnEnvName } = await import('../../lambda/src/lib/router-arn.js');
    process.env[routerArnEnvName('premium')] = ROUTER;
    process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
    process.env.USER_POOL_ID = 'pool';
    // The deployment's registry rows, read at runtime by the handler: the shipped catalog.
    (await import('../helpers/registry-rows')).seedRegistryRows();

    const order: string[] = [];
    jest.doMock('@aws-sdk/client-cognito-identity-provider', () => ({
      CognitoIdentityProviderClient: jest.fn(() => ({
        send: async () => ({ Users: [{ Username: 'bob', Attributes: [{ Name: 'email', Value: 'bob@example.com' }] }], Groups: [{ GroupName: 'premium' }] }),
      })),
      ListUsersCommand: jest.fn(), AdminListGroupsForUserCommand: jest.fn(),
    }), { virtual: true });
    jest.doMock('@aws-sdk/client-sesv2', () => ({ SESv2Client: jest.fn(() => ({ send: jest.fn() })), SendEmailCommand: jest.fn() }), { virtual: true });
    jest.doMock('../../lambda/src/lib/conversation-primary', () => ({
      primaryAssistantOf: async () => ({ classification: 'premium', botArn: BOT }),
    }));
    // The join line is a notice the router says; the share holds no assistant session.
    const say = jest.fn(async (_c: string, n: { kind: string }) => { order.push(`say:${n.kind}`); return { posted: true }; });
    const joined = jest.fn(async (_c: string, _ch: string, people: string[]) => {
      order.push('event:person-joined');
      return new Set(owned ? people : []);
    });
    jest.doMock('../../lambda/src/lib/say-through-router', () => ({ sayThroughRouter: say, personJoinedThroughRouter: joined }));
    mockChimeSend.mockImplementation(async (cmd: { __type: string }) => {
      order.push(`role:${cmd.__type}`);
      return cmd.__type === 'ListTags' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {};
    });
    mockLambdaSend.mockImplementation(async (cmd: { __type: string }) => { order.push(`lambda:${cmd.__type}`); return {}; });

    // WHO BOB IS, by person: the directory finds his subject by the address and resolves it through
    // Identities, reads his groups and names him. Faked here; it is tested on its own.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { __setDefaultDirectoryForTests } = require('../../lambda/src/lib/membership-source');
    __setDefaultDirectoryForTests({
      personsInGroup: async () => ({ persons: [], unminted: [] }),
      personOf: async () => null,
      admins: async () => ({ persons: [], unminted: [] }),
      clearanceOf: async () => ({ state: 'none' as const }),
      listGroups: async () => [],
      findByAddress: async () => JOINER,
      groupsFor: async () => ['premium'],
      clearedByGroups: async () => null,
      displayNameFor: async () => 'Bob',
      contactFor: async () => ({ route: 'email', address: 'bob@example.com', name: 'Bob' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handler } = require('../../lambda/share-conversation/index.js');
    const res = await handler({
      httpMethod: 'POST',
      requestContext: { authorizer: edgeContext({ claims: { sub: 'alice', email: 'alice@example.com' } }) },
      body: JSON.stringify({ conversationArn: CHANNEL, recipientEmail: 'bob@example.com' }),
    });
    return { res, say, joined, order };
  }

  it('adds the member, announces, then asks the classification\'s router for a recap turn addressed to them', async () => {
    const { res, say, joined, order } = await shareWithBob(false);
    expect(res.statusCode).toBe(200);
    // `person-joined` is named once the membership exists; with no workflow declared, it owns nobody.
    expect(joined).toHaveBeenCalledWith('premium', CHANNEL, [JOINER]);
    // The confirmation the chat client words its message from, counted as the caller on the share's own role.
    expect(JSON.parse(res.body).isNowMultiUser).toBe(false);
    const list = mockChimeSend.mock.calls.map((c) => c[0] as any).find((c) => c.__type === 'ListMemberships');
    expect(list?.input.ChimeBearer).toMatch(/\/user\/alice$/);

    // Ordering: membership, then the announcement, then the event, then the recap request.
    const add = order.indexOf('role:CreateMembership');
    const announce = order.indexOf('say:memberJoined');
    const event = order.indexOf('event:person-joined');
    const ask = order.indexOf('lambda:Invoke');
    expect([add >= 0, announce > add, event > announce, ask > event]).toEqual([true, true, true, true]);
    expect(say).toHaveBeenCalledWith('premium', expect.objectContaining({ kind: 'memberJoined', channelArn: CHANNEL, botArn: BOT, vars: { name: expect.any(String) } }));

    // The request: the router of this classification, asynchronous, and nothing the router decides.
    const call = mockLambdaSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Invoke');
    expect(call.input.FunctionName).toBe(ROUTER);
    expect(call.input.InvocationType).toBe('Event');
    const { aeTurn } = JSON.parse(Buffer.from(call.input.Payload).toString('utf8'));
    expect(aeTurn).toMatchObject({ channelArn: CHANNEL, senderArn: JOINER, targeted: true, trigger: 'join_recap' });
    expect(aeTurn.userMessage).toBeUndefined();
    expect(aeTurn.botArn).toBeUndefined();

    // The share named two lines and posted nothing itself: the room-wide announcement, and the welcome to
    // the new member alone, whose notify directive the email bridge sends as their email.
    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[0][1]).toMatchObject({ kind: 'memberJoined', to: [] });
    expect(say.mock.calls[1][1]).toMatchObject({ kind: 'memberWelcome', vars: { notifyPerson: expect.any(String) } });
    const welcome = say.mock.calls[1][1] as unknown as { to: string[]; vars: { notifyPerson: string } };
    expect(welcome.to).toEqual([welcome.vars.notifyPerson]);
    expect(order.filter((o) => o.endsWith('SendMessage'))).toEqual([]);
  });

  it('where a person-joined run owns the welcome, the share asks for no recap and sends no welcome of its own (ADR-061 decision 5)', async () => {
    const { res, say, joined } = await shareWithBob(true);
    expect(res.statusCode).toBe(200);
    expect(joined).toHaveBeenCalledWith('premium', CHANNEL, [JOINER]);
    // The room still hears the join line; the welcome, its email and the recap are the run's.
    expect(say.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(['memberJoined']);
    expect(mockLambdaSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'Invoke')).toEqual([]);
  });

  it('carries no model and no recap wording (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/share-conversation/index.js'), 'utf8');
    expect(src).not.toMatch(/client-bedrock-runtime|ConverseCommand|SUMMARY_MODEL_ID|join_summary/);
  });
});
