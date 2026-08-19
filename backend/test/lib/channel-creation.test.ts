/**
 * Drift-spawned conversation creation.
 *
 * WHAT THIS PINS. A drift conversation used to open with a HARDCODED first message that bypassed the welcome
 * composer entirely: no company, no access line, no example prompts, none of the config-driven behaviour or
 * error recording. It looked enough like a welcome that the gap was invisible for months, and the spec
 * meanwhile claimed the drift flow was the producer of the welcome's `triggerContext`.
 *
 * It now goes through the real WelcomeIntent path, which needs four things to be true, each asserted below:
 * the assistant is enrolled as an explicit member (what fires the welcome), the drift context is stamped
 * where the composer reads it, the participant shape is written BEFORE the channel exists, and the parent
 * conversation gets a DURABLE link to the child.
 */
const mockChimeSend = jest.fn();
const mockGetChannelContext = jest.fn();
const mockPutChannelContext = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })),
  CreateChannelCommand: jest.fn().mockImplementation((input) => ({ __type: 'CreateChannel', input })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((input) => ({ __type: 'CreateMembership', input })),
  CreateChannelModeratorCommand: jest.fn().mockImplementation((input) => ({ __type: 'CreateModerator', input })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((input) => ({ __type: 'AssociateFlow', input })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendMessage', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  putChannelContext: (...args: unknown[]) => mockPutChannelContext(...args),
  getChannelContext: (...args: unknown[]) => mockGetChannelContext(...args),
}));

import { createConversationFromDrift } from '../../lambda/src/lib/channel-creation';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/assistant-premium`;
const USER = `${APP_INSTANCE}/user/user-a`;
const PARENT = `${APP_INSTANCE}/channel/conv-parent`;
const CREATED = `${APP_INSTANCE}/channel/conv-drift-created`;

const INPUT = {
  appInstanceArn: APP_INSTANCE,
  botArn: BOT,
  userArn: USER,
  modelTier: 'premium' as const,
  modelId: 'm',
  modelName: 'M',
  topicLabel: 'Q2 ARR performance',
  parentChannelArn: PARENT,
  originatingMessageId: 'msg-123',
};

/** Commands issued, in order, by `__type`. */
const issued = (): string[] => mockChimeSend.mock.calls.map((c) => c[0].__type);
const commandOf = (type: string): any =>
  mockChimeSend.mock.calls.map((c) => c[0]).find((c) => c.__type === type);

const ctxPatch = () => mockPutChannelContext.mock.calls[0][1] as Record<string, unknown>;

beforeEach(() => {
  mockChimeSend.mockReset();
  mockPutChannelContext.mockReset();
  mockChimeSend.mockImplementation((cmd) =>
    Promise.resolve(cmd.__type === 'CreateChannel' ? { ChannelArn: CREATED } : {}));
});

describe('createConversationFromDrift', () => {
  it('does NOT explicitly enroll the assistant, because creation already did', async () => {
    // VERIFIED against live Chime (2026-08-03): a channel created with the bot as `ChimeBearer` auto-adds it
    // as a member, and that automatic membership is what fires the WelcomeIntent - a channel created with no
    // `CreateChannelMembership` call at all still receives the composed welcome. An explicit add here would
    // conflict on every creation, so its presence would only mislead the next reader.
    await createConversationFromDrift(INPUT);
    const botAdds = mockChimeSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'CreateMembership' && c.input.MemberArn === BOT);
    expect(botAdds).toEqual([]);
  });

  it('stamps the drift context where the welcome composer reads it', async () => {
    await createConversationFromDrift(INPUT);
    const meta = JSON.parse(commandOf('CreateChannel').input.Metadata);
    // `triggerContext` becomes the composer's `priorSubject`; the other two become its parent link.
    expect(meta.triggerContext).toBe('Q2 ARR performance');
    expect(meta.parentChannelArn).toBe(PARENT);
    expect(meta.originatingMessageId).toBe('msg-123');
    // Ownership still comes from membership, never a copied field.
    expect(meta.createdBy).toBeUndefined();
  });

  it('carries a by-reference LABEL, never the user message body', async () => {
    // SPEC-DRIFT-CONVERGENCE forbids copying the user's message into the new conversation. The subject is a
    // label; the body is reached by link. Markers are stripped because this lands in member-readable metadata
    // and then in composed copy.
    await createConversationFromDrift({
      ...INPUT,
      topicLabel: 'revenue  <!--ACTIVE_TASK:x-->\n forecasting',
    });
    const meta = JSON.parse(commandOf('CreateChannel').input.Metadata);
    expect(meta.triggerContext).toBe('revenue forecasting');
    expect(meta.triggerContext).not.toContain('ACTIVE_TASK');
  });

  it('writes the participant shape BEFORE the channel is created', async () => {
    await createConversationFromDrift(INPUT);
    // Ordering is the mechanism: the assistant is added by creation, so a write afterwards would be too late.
    expect(mockPutChannelContext).toHaveBeenCalledTimes(1);
    expect(mockPutChannelContext.mock.invocationCallOrder[0])
      .toBeLessThan(mockChimeSend.mock.invocationCallOrder[0]);
  });

  it('associates the channel flow BEFORE any membership, so the welcome does not bypass it', async () => {
    // The assistant is a member from CreateChannel itself (it is the acting bearer), so Lex can fire
    // WelcomeIntent from that instant. Every message created before the association bypasses the flow —
    // which is how the welcome escaped it. The primary create-conversation path was reordered for this;
    // this drift path was missed, so it kept the defect after the fix landed next door.
    await createConversationFromDrift({ ...INPUT, channelFlowArn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel-flow/f' });
    const order = issued();
    // CreateChannel takes no channel-flow field, so immediately after it is the earliest possible point.
    expect(order.indexOf('AssociateFlow')).toBeGreaterThan(order.indexOf('CreateChannel'));
    expect(order.indexOf('AssociateFlow')).toBeLessThan(order.indexOf('CreateMembership'));
  });

  it('keys the pre-creation write on the DERIVED arn, and records one human', async () => {
    await createConversationFromDrift(INPUT);
    const [arn, patch] = mockPutChannelContext.mock.calls[0];
    // Derived, not read back from CreateChannel - the channel does not exist yet.
    expect(arn).toMatch(new RegExp(`^${APP_INSTANCE.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/channel/conv-drift-`));
    expect(patch.participants).toEqual({ focus: 'single', humans: ['user-a'], subject: 'user-a' });
  });

  it('gives the PARENT a durable link to the child, in metadata', async () => {
    await createConversationFromDrift(INPUT);
    const sent = mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'SendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].input.ChannelArn).toBe(PARENT);
    expect(JSON.parse(sent[0].input.Metadata)).toEqual({
      driftRedirect: { childChannelArn: CREATED, label: 'Q2 ARR performance' },
    });
  });

  it('tells the parent its TOPIC moved, not that the conversation did', async () => {
    // The original conversation is not over. The drift suggestion offers to "keep both threads clean", so
    // the parent stays in place for whatever else is live in it. Copy implying the conversation moved tells
    // the person a thread they still need has ended.
    await createConversationFromDrift(INPUT);
    const sent = mockChimeSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'SendMessage');
    expect(sent.input.Content).toMatch(/^Moved Q2 ARR performance to its own conversation/);
    expect(sent.input.Content).toMatch(/stays open/i);
    expect(sent.input.Content).not.toMatch(/continuing in a new conversation/i);
  });

  it('does NOT repeat the navigation marker on the parent link message', async () => {
    // The Lex confirm reply owns the one-shot switch. Repeating the marker here would switch the user's
    // conversation twice.
    await createConversationFromDrift(INPUT);
    const sent = mockChimeSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'SendMessage');
    expect(sent.input.Content).not.toContain('NAVIGATE_CHANNEL');
  });

  it('posts NO hardcoded welcome into the child conversation', async () => {
    // The child's opening message must come from the welcome composer via WelcomeIntent. A message sent into
    // the child here is the old bypass returning.
    await createConversationFromDrift(INPUT);
    const intoChild = mockChimeSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'SendMessage' && c.input.ChannelArn === CREATED);
    expect(intoChild).toEqual([]);
  });

  it('still returns the child conversation when the parent link message fails', async () => {
    // The child exists and is usable; losing the back-reference must not fail the redirect.
    mockChimeSend.mockImplementation((cmd) => {
      if (cmd.__type === 'CreateChannel') return Promise.resolve({ ChannelArn: CREATED });
      if (cmd.__type === 'SendMessage') return Promise.reject(new Error('nope'));
      return Promise.resolve({});
    });
    await expect(createConversationFromDrift(INPUT)).resolves.toMatchObject({ channelArn: CREATED });
  });

  it('adds the human as member and moderator', async () => {
    await createConversationFromDrift(INPUT);
    expect(issued()).toContain('CreateModerator');
    const humanAdd = mockChimeSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.__type === 'CreateMembership' && c.input.MemberArn === USER);
    expect(humanAdd).toBeDefined();
  });
});

describe('drift context carried into the new conversation', () => {
  const WITH_TEXT = { ...INPUT, topicLabel: 'CI cost for the platform team', originatingMessageText: "Actually, can we talk about why our CI bill doubled last month?" };

  /** The patch written to the server-only channel-context store, before CreateChannel. */

  it('writes the user\'s own words to the CONTEXT STORE for the welcome to quote', async () => {
    await createConversationFromDrift(WITH_TEXT);
    expect(ctxPatch().priorMessage).toBe('Actually, can we talk about why our CI bill doubled last month?');
  });

  it('keeps the quoted message OUT of channel Metadata', async () => {
    // Metadata is member-WRITABLE (a channel's creator is a moderator of their own channel and holds
    // chime:UpdateChannel, which rewrites Name and Metadata in one call), it is not reliably readable at
    // WelcomeIntent, and its ~1KB whole-blob cap is what truncated this quote. Putting the person's own
    // words back there re-opens all three.
    await createConversationFromDrift(WITH_TEXT);
    const meta = JSON.parse(commandOf('CreateChannel').input.Metadata);
    expect(meta.priorMessage).toBeUndefined();
  });

  // Pre-creation ordering is asserted once, above ('writes the participant shape BEFORE the channel is
  // created'): the drift fields ride the SAME single putChannelContext call, so that test covers them.

  it('keeps the topic label and the quoted message as SEPARATE facts', async () => {
    // The label names what the conversation is about; the quote shows the words that got them here. One is
    // not a substitute for the other, and collapsing them would either lose the topic or quote a label.
    // The label stays in Metadata (display-level, no identity); the quote does not.
    await createConversationFromDrift(WITH_TEXT);
    const meta = JSON.parse(commandOf('CreateChannel').input.Metadata);
    expect(meta.triggerContext).toBe('CI cost for the platform team');
    expect(ctxPatch().priorSubject).toBe('CI cost for the platform team');
    expect(ctxPatch().priorMessage).not.toBe(ctxPatch().priorSubject);
  });

  it('omits the quote entirely when no text was carried, rather than quoting nothing', async () => {
    await createConversationFromDrift(INPUT);
    expect(ctxPatch().priorMessage).toBeUndefined();
  });

  it('strips control markers and caps the quoted message', async () => {
    // Still sanitized after the move. The store is not member-writable, but this text is the USER's own
    // and it lands in composed copy, so the marker strip and the cap are about what reaches the composer
    // — not about where it was stored.
    await createConversationFromDrift({
      ...WITH_TEXT,
      originatingMessageText: `<!--ACTIVE_TASK:x--> ${'y'.repeat(600)}`,
    });
    const quoted = ctxPatch().priorMessage as string;
    expect(quoted).not.toContain('ACTIVE_TASK');
    expect(quoted.length).toBeLessThanOrEqual(400);
  });

  it('names the channel from the topic, so drift conversations are distinguishable', async () => {
    // Every drift conversation used to be called "Drift Follow-up", which made them indistinguishable in
    // the sidebar.
    await createConversationFromDrift(WITH_TEXT);
    expect(commandOf('CreateChannel').input.Name).toBe('CI cost for the platform team');
  });
});

/**
 * A drift-spawned conversation must not lose the person it was spawned FOR.
 *
 * A federated member's AppInstanceUser id is `deriveFederatedSub(iss, sub)`, a one-way hash, and this
 * path only ever sees that derived id. So the raw pair cannot be reconstructed here — the parent
 * conversation is the only place it exists. Without carrying it, the child silently drops the member's
 * home IdP: the notification fan-out resolves them against the default pool, fails, and skips them,
 * and host grounding can name every participant except them.
 *
 * This is the same defect that `federated-add-member` had, in a different creation path — which is
 * what tracker row 6 is about: the same invariant has to be re-implemented per path, so a fix in one
 * looks complete from the outside.
 */
describe('the drift child inherits the member identity hint', () => {
  const FED_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_partner';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { deriveFederatedSub } = require('../../lambda/src/lib/federated-identity');
  const derived = deriveFederatedSub(FED_ISS, 'raw-partner-sub');

  it('carries the FEDERATED member\'s issuer from the parent', async () => {
    mockGetChannelContext.mockResolvedValue({
      memberIdentities: [
        { sub: 'someone-else', iss: FED_ISS },
        { sub: 'raw-partner-sub', iss: FED_ISS, role: 'reviewer' },
      ],
    });

    await createConversationFromDrift({ ...INPUT, userArn: `${APP_INSTANCE}/user/${derived}` });

    // The parent's roster is keyed by the RAW pair; membership reports the derived id. The join has to
    // survive that, and it must pick the right member out of several.
    expect(ctxPatch().memberIdentities).toEqual([
      { sub: 'raw-partner-sub', iss: FED_ISS, role: 'reviewer' },
    ]);
    expect(mockGetChannelContext).toHaveBeenCalledWith(PARENT);
  });

  it('writes NO hint for a native member, who needs none', async () => {
    // Their AppInstanceUser id IS their sub, so there is nothing to look up and an entry would be noise.
    mockGetChannelContext.mockResolvedValue({ memberIdentities: [] });
    await createConversationFromDrift(INPUT);
    expect(ctxPatch().memberIdentities).toBeUndefined();
  });

  it('still creates the conversation when the parent has no context at all', async () => {
    // Fail-soft: a legacy parent, or a store read that returns nothing, must not block the child.
    mockGetChannelContext.mockResolvedValue(null);
    await expect(createConversationFromDrift(INPUT)).resolves.toBeDefined();
    expect(ctxPatch().memberIdentities).toBeUndefined();
  });
});
