/**
 * Drift-spawned conversation creation.
 *
 * WHAT THIS PINS. A drift conversation used to open with a HARDCODED first message that bypassed the welcome
 * composer entirely: no company, no access line, no example prompts, none of the config-driven behavior or
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
/**
 * THE ORIGIN CONVERSATION'S CLASSIFICATION, as its tag read returns it (step 39). Answered beside
 * `mockChimeSend` rather than through it, so the command order the cases below assert is unchanged.
 */
const mockOrigin = { classification: 'premium' as string | undefined, reads: [] as string[] };

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({
    send: (cmd: { __type: string; input: { ResourceARN: string } }) => {
      if (cmd.__type !== 'ListTags') return mockChimeSend(cmd);
      mockOrigin.reads.push(cmd.input.ResourceARN);
      return Promise.resolve({ Tags: mockOrigin.classification ? [{ Key: 'classification', Value: mockOrigin.classification }] : [] });
    },
  })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
  CreateChannelCommand: jest.fn().mockImplementation((input) => ({ __type: 'CreateChannel', input })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((input) => ({ __type: 'CreateMembership', input })),
  CreateChannelModeratorCommand: jest.fn().mockImplementation((input) => ({ __type: 'CreateModerator', input })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((input) => ({ __type: 'AssociateFlow', input })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendMessage', input })),
  DeleteChannelMembershipCommand: jest.fn().mockImplementation((input) => ({ __type: 'DeleteMembership', input })),
  DeleteChannelModeratorCommand: jest.fn().mockImplementation((input) => ({ __type: 'DeleteModerator', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  putChannelContext: (...args: unknown[]) => mockPutChannelContext(...args),
  getChannelContext: (...args: unknown[]) => mockGetChannelContext(...args),
}));

import {
  createConversationFromDrift,
  createConversationFromEvent,
  createConversationForPerson,
  createConversationForBriefing,
  NoServiceAdminError,
  OriginClassificationMismatchError,
} from '../../lambda/src/lib/channel-creation';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/assistant-premium`;
const USER = `${APP_INSTANCE}/user/user-a`;
const PARENT = `${APP_INSTANCE}/channel/conv-parent`;
const CREATED = `${APP_INSTANCE}/channel/conv-drift-created`;
/** The service admin every conversation is created as (step 33). */
const SERVICE_ADMIN = `${APP_INSTANCE}/user/service-admin`;

const INPUT = {
  creatorBearerArn: SERVICE_ADMIN,
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
  mockOrigin.classification = 'premium';
  mockOrigin.reads = [];
  mockChimeSend.mockImplementation((cmd) =>
    Promise.resolve(cmd.__type === 'CreateChannel' ? { ChannelArn: CREATED } : {}));
});

describe('a conversation opened from another one carries its classification', () => {
  it('reads the origin\'s tag and creates when it matches', async () => {
    await createConversationFromDrift(INPUT);
    expect(mockOrigin.reads).toEqual([PARENT]);
    expect(commandOf('CreateChannel')).toBeDefined();
  });

  it.each([
    ['another classification', 'basic'],
    ['no classification at all', undefined],
  ])('refuses an origin of %s, before anything is written', async (_label, origin) => {
    mockOrigin.classification = origin;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createConversationFromDrift(INPUT)).rejects.toBeInstanceOf(OriginClassificationMismatchError);
    error.mockRestore();
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockPutChannelContext).not.toHaveBeenCalled();
  });

  it('refuses an event-opened conversation whose concerned conversation is another classification', async () => {
    mockOrigin.classification = 'standard';
    await expect(createConversationFromEvent({
      appInstanceArn: APP_INSTANCE, botArn: BOT, userArn: USER, typeKey: 'ops', classification: 'premium',
      modelId: '', modelName: '', topicLabel: 'Report latency', channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
      parentChannelArn: PARENT, creatorBearerArn: SERVICE_ADMIN, agents: [],
    } as any)).rejects.toBeInstanceOf(OriginClassificationMismatchError);
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('reads no origin for a conversation opened from none (a person\'s, a briefing)', async () => {
    await createConversationForPerson({
      appInstanceArn: APP_INSTANCE, botArn: BOT, userArn: USER, classification: 'premium', title: 'T',
      modelId: 'm', channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`, creatorBearerArn: SERVICE_ADMIN,
    });
    expect(mockOrigin.reads).toEqual([]);
  });
});

describe('createConversationFromDrift', () => {
  it('creates as the service admin and enrolls the assistant once, after the flow, bearing the admin', async () => {
    // The assistant's membership is what fires its WelcomeIntent, so it is added explicitly after the
    // flow association, by the admin that created the room, and exactly once.
    await createConversationFromDrift({ ...INPUT, channelFlowArn: `${APP_INSTANCE}/channel-flow/flow` });
    expect(commandOf('CreateChannel').input.ChimeBearer).toBe(SERVICE_ADMIN);
    const botAdds = mockChimeSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'CreateMembership' && c.input.MemberArn === BOT);
    expect(botAdds).toHaveLength(1);
    expect(botAdds[0].input.ChimeBearer).toBe(SERVICE_ADMIN);
    expect(issued().indexOf('AssociateFlow')).toBeLessThan(issued().indexOf('CreateMembership'));
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

  /**
   * THE PARENT LINK HAS TO BE A LINK THE CLIENT CAN RESOLVE.
   *
   * The chat app identifies a conversation by `ChannelArn.split('/').pop()` and puts exactly that in
   * `?conversation=` when reflecting its own URL. This composed a FULL ARN instead, so
   * `selectConversation` matched nothing in its list and then described a channel whose ARN was built
   * from an ARN - it got nothing back and returned. The link rendered, was clickable, and did
   * nothing: measured live, the header stayed on the child conversation for 30 seconds after the
   * click (`drift-detection.spec.ts`, "following the link did not return to the originating
   * conversation").
   */
  it('links the parent by the id the CLIENT knows it by, not by its ARN', async () => {
    await createConversationFromDrift(INPUT);
    const ctx = mockPutChannelContext.mock.calls[0][1] as { parentRef?: string };
    expect(ctx.parentRef).toBe('?conversation=conv-parent#message=msg-123');
    // The whole point: no ARN, encoded or otherwise, in the link.
    expect(ctx.parentRef).not.toContain('app-instance');
    expect(ctx.parentRef).not.toContain('%2F');
  });

  it('anchors the parent link on the MESSAGE, and omits the anchor when there is none', async () => {
    // Without the anchor the reader lands at the bottom of the parent thread and has to find the
    // message themselves, which is the thing the deep link exists to avoid. Omitted rather than
    // faked when the creating flow recorded no message - `originatingMessageId` is typed required, so
    // an empty string is how a caller that has none actually arrives here.
    await createConversationFromDrift({ ...INPUT, originatingMessageId: '' });
    const ctx = mockPutChannelContext.mock.calls[0][1] as { parentRef?: string };
    expect(ctx.parentRef).toBe('?conversation=conv-parent');
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
    // Ordering is the mechanism: the assistant is added moments after creation, and its welcome reads this.
    expect(mockPutChannelContext).toHaveBeenCalledTimes(1);
    expect(mockPutChannelContext.mock.invocationCallOrder[0])
      .toBeLessThan(mockChimeSend.mock.invocationCallOrder[0]);
  });

  it('associates the channel flow BEFORE any membership, so the welcome does not bypass it', async () => {
    // Lex fires WelcomeIntent the moment the assistant becomes a member, and every message created before
    // the association bypasses the flow, which is how the welcome once escaped it. The service admin
    // creates, so no assistant is a member until after the association.
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
    // Posted percent-encoded, as every platform message is.
    const content = decodeURIComponent(sent.input.Content);
    expect(content).toMatch(/^Moved Q2 ARR performance to its own conversation/);
    expect(content).toMatch(/stays open/i);
    expect(content).not.toMatch(/continuing in a new conversation/i);
  });

  it('does NOT repeat the navigation marker on the parent link message', async () => {
    // The Lex confirm reply owns the one-shot switch. Repeating the marker here would switch the user's
    // conversation twice.
    await createConversationFromDrift(INPUT);
    const sent = mockChimeSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'SendMessage');
    expect(decodeURIComponent(sent.input.Content)).not.toContain('NAVIGATE_CHANNEL');
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
 * The parent records each member's host-supplied role under the issuer subject the host named them by,
 * and the child carries it for the members it contains, matched through Identities.
 *
 * This is the same defect that a host's add-member path had, in a different creation path — which is
 * what is about: the same invariant has to be re-implemented per path, so a fix in one
 * looks complete from the outside.
 */
describe('the drift child inherits the member identity hint', () => {
  const FED_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_partner';
  // The partner's pool, declared in the trusted-issuer registry beside this deployment's own.
  beforeAll(() => {
    process.env.TRUSTED_ISSUERS = JSON.stringify([
      { id: 'partner', kind: 'cognito-pool', pool: 'us-east-1_partner', iss: FED_ISS, subject: ['sub'], clearance: { oneChannel: 'basic', classifications: ['basic'] }, admin: false, groupsClaim: 'cognito:groups' },
    ]);
  });
  afterAll(() => { delete process.env.TRUSTED_ISSUERS; });
  // The person the issuer subject resolves to through Identities (this suite's resolver answers the
  // person whose id is the subject).
  const derived = 'raw-partner-sub';

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

/**
 * TWO REGRESSIONS FROM THE ADR-053 CONSOLIDATION, each of which shipped green and was found by review.
 *
 * They are grouped because they share a cause rather than a symptom: moving creation behind one function
 * moved two things that the retired callers used to do for themselves, and in both cases the new code
 * READ correct. A conflict rethrown and a field silently dropped are the two shapes a consolidation
 * fails in, so they are pinned here rather than left to the live test that happened to catch neither.
 */
describe('the consolidated creator does not undo what the callers used to do', () => {
  const ADMIN = `${APP_INSTANCE}/user/service-admin`;

  const EVENT_INPUT = {
    appInstanceArn: APP_INSTANCE,
    botArn: BOT,
    userArn: USER,
    typeKey: 'ops',
    classification: 'premium' as const,
    modelId: 'm',
    modelName: 'M',
    topicLabel: 'A pager went off',
    channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
  };

  it('adds the primary ONCE when the type also names it, instead of conflicting and orphaning the room', async () => {
    // THE BUG. With a `creatorBearerArn`, step 2b adds the primary explicitly after the flow
    // association. The agents loop then skipped a member "only when the bot was the bearer", which is
    // false in exactly this case - so the primary was added twice. A conversation TYPE names its
    // assistants by HANDLE and may name the classification's own primary (`CONVERSATION_TYPES.ops`
    // lists `advisor`, which resolves to this same bot ARN), the second `CreateChannelMembership`
    // returns `ConflictException`, and the loop RETHROWS - failing a creation whose channel already
    // existed and leaving a room with no assistant in it.
    await createConversationFromEvent({
      ...EVENT_INPUT,
      creatorBearerArn: ADMIN,
      agents: [
        { handle: 'advisor', botArn: BOT, role: 'primary' },
        { handle: 'ops-premium', botArn: `${APP_INSTANCE}/bot/ops-premium`, role: 'ops' },
      ],
    });

    const additions = mockChimeSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'CreateMembership' && c.input.MemberArn === BOT);
    expect(additions).toHaveLength(1);

    // AND THE OTHER ASSISTANT IS STILL ADDED, which is what stops this passing for the wrong reason:
    // skipping the whole loop would also produce one addition of the primary.
    const ops = mockChimeSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'CreateMembership'
        && c.input.MemberArn === `${APP_INSTANCE}/bot/ops-premium`);
    expect(ops).toHaveLength(1);
  });

  /**
   * NO SERVICE ADMIN, NO CONVERSATION. There is no assistant-bearer
   * fallback: no creator's role holds a create, a tag or a membership change bearing an assistant, so a
   * creation without the admin is refused before anything is written rather than half-built.
   */
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['an assistant', BOT],
  ])('refuses every origin when the creator is %s, before anything is written', async (_label, creator) => {
    const attempts: Array<() => Promise<unknown>> = [
      () => createConversationFromDrift({ ...INPUT, creatorBearerArn: creator }),
      () => createConversationFromEvent({ ...EVENT_INPUT, creatorBearerArn: creator, agents: [] }),
      () => createConversationForPerson({
        appInstanceArn: APP_INSTANCE, botArn: BOT, userArn: USER, classification: 'premium', title: 'T',
        modelId: 'm', modelName: 'M', channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`, creatorBearerArn: creator,
      }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(NoServiceAdminError);
    }
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockPutChannelContext).not.toHaveBeenCalled();
  });

  it('puts a person\'s topic where the only reader of it looks', async () => {
    // THE BUG. `topic` was routed to `contextExtras` alongside `priorSubject`, which looks more
    // consistent and loses it: `ChannelContext` does not own a `topic` field, and a field it does not
    // own is silently discarded on write. The only reader is the router, which takes it from channel
    // Metadata. So every topic-seeded conversation opened with no topic grounding, with no error.
    await createConversationForPerson({
      appInstanceArn: APP_INSTANCE,
      botArn: BOT,
      userArn: USER,
      classification: 'premium',
      title: 'Q2 planning',
      modelId: 'm',
      modelName: 'M',
      topic: 'the Q2 revenue plan',
      channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
      creatorBearerArn: ADMIN,
    });

    const meta = JSON.parse(commandOf('CreateChannel').input.Metadata);
    expect(meta.topic).toBe('the Q2 revenue plan');

    // AND ON THE CONTEXT STORE, which is the leg the welcome actually reads. Metadata is eventually
    // consistent at `WelcomeIntent` - the router says so in its own comment - so Metadata alone left
    // the grounding intermittent. Both legs are asserted because either one alone is a defect.
    expect(ctxPatch().topic).toBe('the Q2 revenue plan');
  });

  it('adds the people as the admin, which has moderated since CreateChannel, not on a grant made a moment earlier', async () => {
    await createConversationFromEvent({
      ...EVENT_INPUT,
      creatorBearerArn: ADMIN,
      additionalMemberArns: [`${APP_INSTANCE}/user/someone-else`],
      agents: [{ handle: 'ops-premium', botArn: `${APP_INSTANCE}/bot/ops-premium`, role: 'ops' }],
    });
    const adds = mockChimeSend.mock.calls.map((c) => c[0])
      .filter((c) => (c.__type === 'CreateMembership' || c.__type === 'CreateModerator') && c.input.ChannelArn);
    const byMember = (arn: string) => adds.filter((c) => (c.input.MemberArn ?? c.input.ChannelModeratorArn) === arn);
    for (const arn of [USER, `${APP_INSTANCE}/user/someone-else`, `${APP_INSTANCE}/bot/ops-premium`]) {
      expect(byMember(arn).length).toBeGreaterThan(0);
      for (const c of byMember(arn)) expect(c.input.ChimeBearer).toBe(ADMIN);
    }
  });

  it('the admin leaves even when a later step of the creation fails', async () => {
    // THE DEFECT. The leave ran only on success, so a creation that threw after CreateChannel left the
    // half-built room with the service admin as a member and moderator, counted as a person everywhere.
    mockChimeSend.mockImplementation(async (cmd: { __type: string; input: { MemberArn?: string } }) => {
      if (cmd.__type === 'CreateMembership' && cmd.input.MemberArn === `${APP_INSTANCE}/bot/ops-premium`) {
        throw Object.assign(new Error('nope'), { name: 'ForbiddenException' });
      }
      return cmd.__type === 'CreateChannel' ? { ChannelArn: CREATED } : {};
    });
    await expect(createConversationFromEvent({
      ...EVENT_INPUT,
      creatorBearerArn: ADMIN,
      agents: [{ handle: 'ops-premium', botArn: `${APP_INSTANCE}/bot/ops-premium`, role: 'ops' }],
    })).rejects.toThrow('nope');
    const leave = mockChimeSend.mock.calls.map((c) => c[0])
      .filter((c) => c.__type === 'DeleteMembership' && c.input.MemberArn === ADMIN);
    expect(leave).toHaveLength(1);
  });

  it('carries no topic key at all when the person gave none', async () => {
    // ALSO CHARACTERIZATION: the old code put `topic` on the context store, so Metadata never carried
    // the key and this assertion was already true. It pins the absent-key behavior against the change
    // that started writing the key at all.
    //
    // An empty string on Metadata is not the same as an absent key: the router tests `typeof === 'string'`,
    // so a blank topic would ground the welcome on nothing while looking like a topic was supplied.
    await createConversationForPerson({
      appInstanceArn: APP_INSTANCE,
      botArn: BOT,
      userArn: USER,
      classification: 'premium',
      title: 'Q2 planning',
      modelId: 'm',
      modelName: 'M',
      channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
      creatorBearerArn: ADMIN,
    });
    expect(JSON.parse(commandOf('CreateChannel').input.Metadata)).not.toHaveProperty('topic');
  });
});

/**
 * THE CONSOLIDATION MUST BE ADDITIVE, AND TWICE IT WAS NOT.
 *
 * ADR-053 replaced a 633-line raw-JS handler with a bundled one calling this library. The contract a
 * replacement owes is that nothing a caller or an operator could observe got quieter, and the way that
 * breaks is not a dropped feature anybody would notice - it is a field. Two went missing and neither
 * failed a test, because nothing asserted the channel's own shape: the `conversationType` tag, which
 * the federated and briefing paths still write, and `createdBy`, which is the only record on the
 * channel itself of who opened it.
 *
 * SO THESE ASSERT THE SHAPE RATHER THAN THE BEHAVIOR. Every value here was read off
 * `git show d799db9d^:backend/lambda/create-conversation/index.js`, which is the definition of parity
 * for this path. A field dropped deliberately later should fail this and be deleted from it with the
 * reason, which is the difference between a decision and a disappearance.
 */
describe('the person-facing path is ADDITIVE against the handler it replaced', () => {
  const PERSON = {
    appInstanceArn: APP_INSTANCE,
    botArn: BOT,
    userArn: USER,
    classification: 'premium' as const,
    title: 'Q2 planning',
    modelId: 'anthropic.claude-sonnet-4-5',
    modelName: 'Sonnet 4.5',
    channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
    creatorBearerArn: `${APP_INSTANCE}/user/service-admin`,
  };

  const createChannel = () => commandOf('CreateChannel').input;

  it('labels the room with its real TYPE KEY, not with its privacy', async () => {
    // A label an operator filters on and cost allocation reports by; the context store's type is the
    // authority. `private` was the channel's Privacy, which DescribeChannel already reports.
    await createConversationForPerson(PERSON);
    expect(createChannel().Tags).toEqual([
      { Key: 'classification', Value: 'premium' },
      // Its audience, in the same call, so the member-side roles' second layer can read it.
      { Key: 'audience', Value: 'members' },
      // Every room records its primary, in the same call (§3.8).
      { Key: 'primaryAssistant', Value: 'test-assistant' },
      { Key: 'conversationType', Value: 'general' },
    ]);
  });

  it('the service admin that created it leaves as a MEMBER AND A MODERATOR, after the room is assembled', async () => {
    // Amazon Chime SDK makes the CreateChannel bearer a moderator, and deleting the membership alone left
    // the admin listed as a moderator of every person-opened room.
    await createConversationForPerson(PERSON);
    const admin = `${APP_INSTANCE}/user/service-admin`;
    expect(commandOf('DeleteModerator').input).toEqual(expect.objectContaining({ ChannelModeratorArn: admin, ChimeBearer: admin }));
    expect(commandOf('DeleteMembership').input).toEqual(expect.objectContaining({ MemberArn: admin, ChimeBearer: admin }));
    const order = issued();
    expect(order.lastIndexOf('CreateMembership')).toBeLessThan(order.indexOf('DeleteModerator'));
  });

  it('drops the admin\'s moderator record and membership AT ONCE, since neither depends on the other', async () => {
    // The moderator delete is held open: the membership delete must already be issued while it waits.
    let releaseModerator: () => void = () => undefined;
    mockChimeSend.mockImplementation((cmd) => {
      if (cmd.__type === 'DeleteModerator') return new Promise((resolve) => { releaseModerator = () => resolve({}); });
      return Promise.resolve(cmd.__type === 'CreateChannel' ? { ChannelArn: CREATED } : {});
    });
    const created = createConversationForPerson(PERSON);
    for (let i = 0; i < 50 && !issued().includes('DeleteMembership'); i++) await new Promise((r) => setImmediate(r));
    expect(issued()).toEqual(expect.arrayContaining(['DeleteModerator', 'DeleteMembership']));
    releaseModerator();
    await created;
  });

  it('tries a leave call that failed once more on its own, and logs only a second failure', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let moderatorAttempts = 0;
    mockChimeSend.mockImplementation((cmd) => {
      if (cmd.__type === 'DeleteModerator' && ++moderatorAttempts === 1) {
        return Promise.reject(Object.assign(new Error('conflict'), { name: 'ConflictException' }));
      }
      if (cmd.__type === 'DeleteMembership') return Promise.reject(new Error('still failing'));
      return Promise.resolve(cmd.__type === 'CreateChannel' ? { ChannelArn: CREATED } : {});
    });
    try {
      await createConversationForPerson(PERSON);
      expect(issued().filter((t) => t === 'DeleteModerator')).toHaveLength(2);
      expect(issued().filter((t) => t === 'DeleteMembership')).toHaveLength(2);
      const logged = error.mock.calls.map((c) => String(c[0]));
      expect(logged.some((m) => m.includes('could not drop its moderator record'))).toBe(false);
      expect(logged.some((m) => m.includes('could not leave it'))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it('records how long each step took when the caller hands it a timer', async () => {
    const { phaseTimer } = await import('../../lambda/src/lib/cold-path');
    const timer = phaseTimer();
    await createConversationForPerson({ ...PERSON, timer });
    expect(Object.keys(timer.phases)).toEqual(expect.arrayContaining([
      'contextWrite', 'primaryTag', 'createChannel', 'addAssistant', 'addOpener', 'adminLeaves',
    ]));
  });

  it('records WHO opened it on the channel, as the retired handler did', async () => {
    // Attribution only, and no code reads it: every former reader moved to the Amazon Chime SDK
    // moderator list because Metadata is member-writable. Kept because it is the only record on the
    // channel of who opened it, and because losing it was a reduction nobody decided on.
    await createConversationForPerson(PERSON);
    expect(JSON.parse(createChannel().Metadata).createdBy).toBe(USER);
  });

  it('still sets every channel property the retired handler set', async () => {
    await createConversationForPerson(PERSON);
    const input = createChannel();
    expect({
      app: input.AppInstanceArn,
      mode: input.Mode,
      privacy: input.Privacy,
      named: input.Name,
      hasId: !!input.ChannelId,
    }).toEqual({
      app: APP_INSTANCE,
      mode: 'RESTRICTED',
      privacy: 'PRIVATE',
      named: 'Q2 planning',
      hasId: true,
    });
    // The three model fields are display-only and nothing routes on them, but the admin console reads
    // them, so a replacement dropping one is a blank column rather than an error.
    const meta = JSON.parse(input.Metadata);
    expect([meta.modelId, meta.modelName, meta.modelTier])
      .toEqual(['anthropic.claude-sonnet-4-5', 'Sonnet 4.5', 'premium']);
  });

  it('every origin carries the same four tags: classification, audience, primary and type key', async () => {
    // One shape for every room, so an operator's filter and a cost report see every population.
    await createConversationFromDrift(INPUT);
    expect(commandOf('CreateChannel').input.Tags).toEqual([
      { Key: 'classification', Value: 'premium' },
      { Key: 'audience', Value: 'members' },
      { Key: 'primaryAssistant', Value: 'test-assistant' },
      { Key: 'conversationType', Value: 'general' },
    ]);
  });
});

describe('a person-opened or drift-spawned conversation is the ordinary type, at its own classification', () => {
  // The classification is an INPUT and the type is `general`, whatever the
  // classification. The type used to be the classification's own name, which made the stamp below read
  // `premium` and a type lookup by classification indistinguishable from a type lookup by type.
  const PERSON = {
    appInstanceArn: APP_INSTANCE,
    botArn: BOT,
    userArn: USER,
    classification: 'premium' as const,
    title: 'Platform on-call',
    modelId: 'anthropic.claude-sonnet-4-5',
    modelName: 'Sonnet 4.5',
    channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
    creatorBearerArn: `${APP_INSTANCE}/user/service-admin`,
  };

  it('stamps `general` for a person-opened conversation, and tags the classification it was given', async () => {
    await createConversationForPerson(PERSON);
    expect(ctxPatch().conversationType).toBe('general');
    expect(commandOf('CreateChannel').input.Tags).toContainEqual({ Key: 'classification', Value: 'premium' });
  });

  it('stamps `general` for a drift split, and keeps the parent\'s classification', async () => {
    await createConversationFromDrift(INPUT);
    expect(ctxPatch().conversationType).toBe('general');
    expect(commandOf('CreateChannel').input.Tags).toContainEqual({ Key: 'classification', Value: 'premium' });
  });

  it('adds nobody by type: only the opener is added as a person', async () => {
    await createConversationForPerson(PERSON);
    const people = mockChimeSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__type === 'CreateMembership' && String(c.input.MemberArn).includes('/user/'))
      .map((c) => c.input.MemberArn);
    expect(people).toEqual([USER]);
  });
});

describe('a conversation records the membership source its type enforces', () => {
  // DESIGN-CONVERSATION-TYPES §6: the share Lambda and the client read this, so it is stamped at creation.
  const EVENT = {
    appInstanceArn: APP_INSTANCE,
    botArn: BOT,
    userArn: USER,
    typeKey: 'ops',
    classification: 'premium' as const,
    modelId: '',
    modelName: '',
    topicLabel: 'Report latency',
    channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
    creatorBearerArn: `${APP_INSTANCE}/user/service-admin`,
    agents: [],
  };

  it('stamps the source on the server-side context row, which is what share enforces from', async () => {
    await createConversationFromEvent(EVENT as any);
    expect(ctxPatch().membershipSource).toBe('group:ops');
  });

  it('puts the same source in Metadata only as a display hint, beside no type key', async () => {
    await createConversationFromEvent(EVENT as any);
    const meta = JSON.parse(commandOf('CreateChannel').input.Metadata);
    expect(meta.membershipSource).toBe('group:ops');
    expect(meta.conversationType).toBeUndefined();
  });

  it('stamps nothing for an ordinary conversation, whose membership is manual', async () => {
    await createConversationFromDrift(INPUT);
    expect(ctxPatch().membershipSource).toBeUndefined();
    expect(JSON.parse(commandOf('CreateChannel').input.Metadata).membershipSource).toBeUndefined();
  });
});

describe('a scheduled briefing is created like every other conversation', () => {
  const MEMBERS = [`${APP_INSTANCE}/user/a`, `${APP_INSTANCE}/user/b`];
  const BRIEFING = {
    appInstanceArn: APP_INSTANCE,
    botArn: BOT,
    memberArns: MEMBERS,
    classification: 'premium' as const,
    channelId: 'conv-proactive-1',
    title: 'Briefing',
    metadataExtras: { createdViaProactive: true },
    channelFlowArn: `${APP_INSTANCE}/channel-flow/flow`,
    creatorBearerArn: SERVICE_ADMIN,
  };

  it('creates as the service admin, attaches the flow before the assistant, and every change bears the admin', async () => {
    await createConversationForBriefing(BRIEFING);
    expect(issued().indexOf('AssociateFlow')).toBeLessThan(issued().indexOf('CreateMembership'));
    const bearers = mockChimeSend.mock.calls.map((c) => c[0])
      .filter((c) => c.__type !== 'SendMessage').map((c) => c.input.ChimeBearer);
    expect([...new Set(bearers)]).toEqual([SERVICE_ADMIN]);
    expect(commandOf('CreateChannel').input.Tags).toEqual(expect.arrayContaining([
      { Key: 'classification', Value: 'premium' },
      { Key: 'conversationType', Value: 'general' },
    ]));
  });

  it('has no opener: the recipients are members and only the assistant is a moderator', async () => {
    await createConversationForBriefing(BRIEFING);
    const calls = mockChimeSend.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => c.__type === 'CreateMembership').map((c) => c.input.MemberArn)).toEqual([BOT, ...MEMBERS]);
    expect(calls.filter((c) => c.__type === 'CreateModerator').map((c) => c.input.ChannelModeratorArn)).toEqual([BOT]);
    // The participant shape counts the recipients, so a briefing for two reads as a group.
    expect(ctxPatch().participants).toEqual({ focus: 'group', humans: ['a', 'b'], subject: '' });
  });

  it('a recipient who cannot be added does not stop the others', async () => {
    mockChimeSend.mockImplementation((cmd) => {
      if (cmd.__type === 'CreateChannel') return Promise.resolve({ ChannelArn: CREATED });
      if (cmd.__type === 'CreateMembership' && cmd.input.MemberArn === MEMBERS[0]) return Promise.reject(new Error('not in app instance'));
      return Promise.resolve({});
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createConversationForBriefing(BRIEFING)).resolves.toEqual({ channelArn: CREATED, channelId: 'conv-proactive-1' });
    error.mockRestore();
    expect(mockChimeSend.mock.calls.some((c) => c[0].__type === 'CreateMembership' && c[0].input.MemberArn === MEMBERS[1])).toBe(true);
  });

  it('refuses with no service admin and at an admin-plane classification, before anything is written', async () => {
    await expect(createConversationForBriefing({ ...BRIEFING, creatorBearerArn: '' })).rejects.toBeInstanceOf(NoServiceAdminError);
    await expect(createConversationForBriefing({ ...BRIEFING, classification: 'admin' as never })).rejects.toThrow(/cannot be created/);
    expect(mockChimeSend).not.toHaveBeenCalled();
  });
});
