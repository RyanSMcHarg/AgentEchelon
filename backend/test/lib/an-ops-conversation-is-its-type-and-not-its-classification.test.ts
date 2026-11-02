/**
 * AN EVENT-INITIATED CONVERSATION IS ITS TYPE, NOT ITS CLASSIFICATION.
 *
 * ADR-053 Phase 1 names seven things that have to hold before the `ops` type is real rather than
 * declared. Six of them are properties of the creating call and are asserted here; the seventh - that
 * the flow works, proved by an addressed turn being answered rather than by the association call
 * returning - cannot be proved in a unit test and is a live check.
 *
 * ── WHAT WOULD FAIL WITHOUT THESE ────────────────────────────────────────────────────────────────
 *
 * Every consumer in this system once resolved a conversation-type config by CLASSIFICATION. So a
 * conversation created "of type `ops`" would have resolved to an ordinary type for its whole life: the
 * platform's maximum retention instead of 30 days, and drift ON despite the type declaring it off.
 * Nothing would report that. The conversation would answer, be named correctly, carry the right people,
 * and quietly be an ordinary conversation. These cases are the difference between a dimension that is configured and
 * one that is read.
 */
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockPutChannelContext = jest.fn();
const mockGetChannelContext = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  // The origin conversation's tag read, answered beside the recorded
  // calls so the order asserted below is unchanged: the origin is premium, as the creation is.
  ChimeSDKMessagingClient: jest.fn(() => ({
    send: (cmd: { __type: string }) => (cmd.__type === 'ListTags'
      ? Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] })
      : mockMessagingSend(cmd)),
  })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTags', input })),
  CreateChannelCommand: jest.fn((input: unknown) => ({ __type: 'CreateChannel', input })),
  CreateChannelMembershipCommand: jest.fn((input: unknown) => ({ __type: 'CreateMembership', input })),
  CreateChannelModeratorCommand: jest.fn((input: unknown) => ({ __type: 'CreateModerator', input })),
  AssociateChannelFlowCommand: jest.fn((input: unknown) => ({ __type: 'AssociateFlow', input })),
  SendChannelMessageCommand: jest.fn((input: unknown) => ({ __type: 'SendMessage', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  putChannelContext: (...a: unknown[]) => mockPutChannelContext(...a),
  getChannelContext: (...a: unknown[]) => mockGetChannelContext(...a),
}));

import { createConversationFromEvent } from '../../lambda/src/lib/channel-creation';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const user = (sub: string) => `${APP}/user/${sub}`;
const bot = (name: string) => `${APP}/bot/${name}`;
const CONCERNED = `${APP}/channel/concerned-1`;
const PRIMARY = bot('advisor');

/** Every call the creator made, in order, as `{__type, input}`. */
const calls = () => mockMessagingSend.mock.calls.map((c) => c[0] as { __type: string; input: Record<string, unknown> });
const callsOfType = (t: string) => calls().filter((c) => c.__type === t);
const writtenContext = () => mockPutChannelContext.mock.calls[0][1] as Record<string, unknown>;

const create = (over: Record<string, unknown> = {}) =>
  createConversationFromEvent({
    creatorBearerArn: `${APP}/user/service-admin`,
    appInstanceArn: APP,
    botArn: PRIMARY,
    userArn: user('owner'),
    typeKey: 'ops',
    classification: 'premium',
    modelId: 'm',
    modelName: 'M',
    topicLabel: 'error rate above threshold',
    channelFlowArn: `${APP}/channel-flow/flow-1`,
    parentChannelArn: CONCERNED,
    agents: [
      { handle: 'advisor', botArn: PRIMARY, role: 'primary' },
      { handle: 'ops-premium', botArn: bot('ops-premium'), role: 'ops' },
    ],
    ...over,
  } as Parameters<typeof createConversationFromEvent>[0]);

beforeEach(() => {
  jest.clearAllMocks();
  mockMessagingSend.mockResolvedValue({ ChannelArn: `${APP}/channel/conv-ops-1` });
  mockGetChannelContext.mockResolvedValue(null);
  mockPutChannelContext.mockResolvedValue(true);
});

describe('the type constrains the classification rather than supplying it', () => {
  it('carries the classification the caller supplied, as the channel tag', async () => {
    await create();
    expect(callsOfType('CreateChannel')[0].input.Tags)
      .toEqual([
        { Key: 'classification', Value: 'premium' },
        { Key: 'audience', Value: 'members' },
        { Key: 'primaryAssistant', Value: 'test-assistant' },
        // The type key labels the room; the classification is still the caller's.
        { Key: 'conversationType', Value: 'ops' },
      ]);
  });

  it('refuses a classification the type does not permit, BEFORE a channel exists', async () => {
    // The refusal has to come before any Chime call. A creator that tagged first and checked second
    // would leave a channel at a classification the type forbids, and the tag is immutable.
    await expect(create({ classification: 'standard' })).rejects.toThrow(/does not permit/);
    expect(mockMessagingSend).not.toHaveBeenCalled();
    expect(mockPutChannelContext).not.toHaveBeenCalled();
  });

  it('refuses a type the registry does not declare', async () => {
    // Not merely unknown-key hygiene: `getConversationTypeConfig` falls back to the DEFAULT type for an
    // unknown key, which for an authorization check would let a typo create at the default type's
    // classification.
    await expect(create({ typeKey: 'opps' })).rejects.toThrow(/unknown conversation type/);
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('refuses a classification with no conversational runtime', async () => {
    // An admin-plane assistant never answers, so the conversation would be held by an assistant that
    // cannot reply. `ops` does not permit `admin` either, so this asserts the pair refuses rather than
    // which message wins.
    await expect(create({ classification: 'admin' })).rejects.toThrow();
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });
});

describe('the conversation gets the TYPE\'S policy, not the classification\'s', () => {
  it('applies the type\'s own retention and not the ordinary type\'s', async () => {
    // The case that catches the type being inert. `ops` declares 30 days and `general` the platform maximum, so
    // a creator resolving its config by anything but the type key sets the maximum.
    await create();
    expect(callsOfType('CreateChannel')[0].input.ExpirationSettings).toEqual({
      ExpirationDays: CONVERSATION_TYPES.ops.expiration!.days,
      ExpirationCriterion: CONVERSATION_TYPES.ops.expiration!.criterion,
    });
    // Stated as the inequality too, so this keeps failing if someone "fixes" it by making the two equal.
    expect(CONVERSATION_TYPES.ops.expiration!.days)
      .not.toBe(CONVERSATION_TYPES.general.expiration!.days);
  });

  it('stamps the type key where a later turn reads it', async () => {
    // The drift gate resolves `driftEnabled` from this stamp. Without it the gate falls back to the
    // ordinary type, which has drift ON while `ops` declares it off - so the assistant would offer to
    // split a conversation whose type exists to hold one subject.
    await create();
    expect(writtenContext().conversationType).toBe('ops');
  });

  it('stamps it on a key the context store actually owns', async () => {
    // THE TRAP THIS EXISTS FOR. That store silently discards a field absent from its allowlist and
    // swallows write failures, so a missing entry looks exactly like a working write - the stamp would
    // be a no-op that passes review and takes the whole feature with it.
    const client = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/lib/channel-context-client.ts'),
      'utf8',
    );
    const allowlist = client.slice(client.indexOf('const OWNED_FIELDS'));
    expect(allowlist.slice(0, allowlist.indexOf('];'))).toContain("'conversationType'");
  });

  it('is not branded a drift child, because the channel id is member-visible', async () => {
    // The id is the last segment of the ARN, which is what the client carries as a conversation's id and
    // reflects into its own URL. `conv-drift-...` on an ops conversation is something an audience reads.
    await create();
    const channelId = callsOfType('CreateChannel')[0].input.ChannelId as string;
    expect(channelId).toMatch(/^conv-ops-/);
    expect(channelId).not.toContain('drift');
  });

  it('claims no drift provenance in Metadata', async () => {
    await create();
    const metadata = JSON.parse(callsOfType('CreateChannel')[0].input.Metadata as string);
    expect(metadata.createdViaDrift).toBeUndefined();
    expect(metadata.conversationType).toBeUndefined(); // member-writable storage; the stamp is private
  });

  it('carries the issue so the assistants open on it rather than asking', async () => {
    // THIS ASSERTED THE OPPOSITE. The first version of this path carried no subject at all, reasoning
    // that `priorSubject` is drift carry-over and an event-opened conversation has none. It has one from
    // the instant it exists, and everybody arriving already knows what it is - they were just told in
    // the conversation the event concerned. The assistant was the only participant who had not been.
    await create({ issue: 'The platform error rate crossed its threshold.' });
    const ctx = writtenContext();
    // The welcome's subject is the LABEL, because the clause it renders is a noun phrase.
    expect(ctx.priorSubject).toBe('error rate above threshold');
    // The grounding takes the full line, because that is the half the model reads: the welcome is
    // composed rather than generated, so a person seeing the subject does not mean the assistant has it.
    expect(ctx.domainContext).toEqual({ title: 'The platform error rate crossed its threshold.' });
    // Still no quoted user message: nobody typed anything to quote.
    expect(ctx.priorMessage).toBeUndefined();
  });

  it('names no other thread when the platform opened the room on its own, with no parent', async () => {
    // "picks up <subject>, so the other thread can carry on" is right only when an event concerned a
    // room that carries on. A system-opened room (ops-team) has none, so its label is its topic.
    await create({ parentChannelArn: undefined });
    expect(writtenContext().priorSubject).toBeUndefined();
    expect(writtenContext().topic).toBe('error rate above threshold');
  });

  it('carries the label alone when the event supplied no issue line', async () => {
    await create();
    expect(writtenContext().priorSubject).toBe('error rate above threshold');
    expect(writtenContext().domainContext).toBeUndefined();
  });
});

describe('the assistants the type names are added, and a failure to add one is fatal', () => {
  it('adds the second assistant, and the primary exactly once although the type names it too', async () => {
    await create();
    const members = callsOfType('CreateMembership').map((c) => c.input.MemberArn);
    expect(members).toContain(bot('ops-premium'));
    // The service admin creates, so the primary is added explicitly after the flow (step 2b). The type
    // also names it (`advisor`), and a second add would conflict and fail the creation, so it is once.
    expect(members.filter((m) => m === PRIMARY)).toHaveLength(1);
  });

  it('FAILS the creation when an assistant cannot be added', async () => {
    // The asymmetry with the human loop is the point: a person missing from a conversation is a
    // degradation worth a log line, and an assistant missing from it is the feature absent. Riding the
    // tolerant human loop would have delivered a one-assistant `ops` conversation and reported success.
    mockMessagingSend.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) => {
      if (cmd.__type === 'CreateChannel') return Promise.resolve({ ChannelArn: `${APP}/channel/conv-ops-1` });
      if (cmd.__type === 'CreateMembership' && cmd.input.MemberArn === bot('ops-premium')) {
        return Promise.reject(new Error('NotFound'));
      }
      return Promise.resolve({});
    });
    await expect(create()).rejects.toThrow(/NotFound/);
  });

  it('tolerates a human who cannot be added, which is the opposite rule', async () => {
    // Same conversation, different member kind. Failing the whole creation over one person would lose
    // the conversation for everybody rather than for one.
    mockMessagingSend.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) => {
      if (cmd.__type === 'CreateChannel') return Promise.resolve({ ChannelArn: `${APP}/channel/conv-ops-1` });
      if (cmd.__type === 'CreateMembership' && cmd.input.MemberArn === user('second')) {
        return Promise.reject(new Error('NotFound'));
      }
      return Promise.resolve({});
    });
    await expect(create({ additionalMemberArns: [user('second')] })).resolves.toMatchObject({
      channelArn: `${APP}/channel/conv-ops-1`,
    });
  });
});

describe('the flow, and the one message', () => {
  it('associates the flow BEFORE any membership', async () => {
    // The primary is a member from CreateChannel itself, so Lex can fire WelcomeIntent from that
    // instant - and every message created before the association bypasses the flow, including the
    // welcome.
    await create();
    const order = calls().map((c) => c.__type);
    expect(order.indexOf('AssociateFlow')).toBeGreaterThan(order.indexOf('CreateChannel'));
    expect(order.indexOf('AssociateFlow')).toBeLessThan(order.indexOf('CreateMembership'));
  });

  it('refuses to create a conversation with no flow at all', async () => {
    // A `@ops` conversation nobody can address is inert rather than degraded, and no person is sitting
    // in it to notice. The drift path stays best-effort because somebody is.
    await expect(create({ channelFlowArn: undefined })).rejects.toThrow(/channel flow/);
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('posts NOTHING into the conversation the event concerned', async () => {
    // The caller posts the notification. A creator that also posted would put two bot messages in that
    // conversation, one of them announcing a move that did not happen.
    await create();
    expect(callsOfType('SendMessage')).toEqual([]);
  });
});
