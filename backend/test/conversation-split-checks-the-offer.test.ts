/**
 * THE MODEL MAY REQUEST A SPLIT; IT MAY NOT AUTHORIZE ONE (DESIGN 2.4.2).
 *
 * Creating a channel needs `chime:CreateChannel`, which cannot be tag-scoped the way the assistant's
 * other rights are, because the tag that would gate it does not exist until the channel does. So the
 * question is not whether the grant is narrow - it is what can reach it.
 *
 * The processor is the component that executes model output. If channel creation lived there, a reply
 * that talked its way past the contract could open rooms. Behind this function, the reply can only
 * ever ASK, and the ask is checked against a record the model never wrote: the offer stored when the
 * subjects were put to the person.
 *
 * WHAT THESE TESTS PIN is that an injected or mistaken reply gets nothing. Not a smaller blast radius
 * - none: no offer means no channel, a label nobody offered means no channel, and somebody else's
 * offer is not visible to this call at all.
 */

const mockReadPending = jest.fn();
const mockClearPending = jest.fn();
const mockCreate = jest.fn();
const mockSend = jest.fn();
/** The parent channel's tags. Routed apart from membership reads so each can be asserted alone. */
const mockTags = jest.fn();

jest.mock('../lambda/src/lib/turn-lock.js', () => ({
  readPendingSplit: (...a: unknown[]) => mockReadPending(...a),
  clearPendingSplit: (...a: unknown[]) => mockClearPending(...a),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class {
    send = (cmd: { kind?: string }) => (cmd?.kind === 'tags' ? mockTags(cmd) : mockSend(cmd));
  },
  ListChannelMembershipsCommand: class { constructor(public input: unknown) {} },
  ListTagsForResourceCommand: class { readonly kind = 'tags'; constructor(public input: unknown) {} },
}));
jest.mock('../lambda/src/lib/channel-creation.js', () => ({
  createConversationFromDrift: (...a: unknown[]) => mockCreate(...a),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';
const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';

process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/i';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/src/conversation-split');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const session = require('../lambda/src/lib/assistant-session') as { vendAssistantSession: jest.Mock };
const sessionFor = (botArn: string) => ({
  assistant: 'atlas', role: 'primary', botArn,
  credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 't', sessionToken: 't' },
});

const request = (labels: string[]) => ({
  channelArn: CHANNEL,
  responderId: 'atlas',
  botArn: BOT,
  correlationId: 'turn-1',
  userArn: USER,
  classification: 'standard' as const,
  labels,
  originatingMessageId: 'm9',
});

beforeEach(() => {
  jest.clearAllMocks();
  session.vendAssistantSession.mockImplementation(async () => sessionFor(BOT));
  mockReadPending.mockResolvedValue({
    topics: [
      { label: 'billing', messageIds: ['m1', 'm3'] },
      { label: 'the failed deploy', messageIds: ['m2'] },
    ],
    offeredTo: { alice: true },
    originatingMessageId: 'm9',
    offeredAt: 1,
  });
  mockClearPending.mockResolvedValue(undefined);
  mockCreate.mockImplementation(async () => ({ channelArn: `${CHANNEL}-new`, channelId: 'new' }));
  mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
});

/**
 * THE NEW CONVERSATION'S CLASSIFICATION IS THE PARENT'S TAG, NOT THE REQUEST'S (Layer 1).
 *
 * This role's CreateChannel and TagResource are app-scoped, because the tag that would gate them does
 * not exist until the channel does. So IAM does not stop a request that names a higher classification,
 * and "never above the parent's" was a comment beside `modelTier: req.classification`. It is enforced
 * here now, from the immutable tag, and it fails closed: no readable tag, no conversation.
 */
describe('the classification a split creates at', () => {
  it('reads the parent channel tag and creates at that classification', async () => {
    mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'premium' }] });

    await handler({ ...request(['billing']), classification: undefined });

    expect(mockTags).toHaveBeenCalledWith(expect.objectContaining({ input: { ResourceARN: CHANNEL } }));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ modelTier: 'premium' }));
  });

  it('refuses when the request names a classification the tag does not carry', async () => {
    // The request says premium; the parent is standard. Creating at premium would carry the parent's
    // messages above it, and creating at standard would act on a picture the caller has shown is wrong.
    const result = await handler({ ...request(['billing']), classification: 'premium' });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.refused).toEqual(['billing']);
  });

  it('refuses when the tag cannot be read, rather than creating at the floor', async () => {
    mockTags.mockRejectedValue(new Error('AccessDenied'));

    const result = await handler(request(['billing', 'the failed deploy']));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.refused).toEqual(['billing', 'the failed deploy']);
  });

  it('refuses when the parent carries no classification tag, or an unknown one', async () => {
    mockTags.mockResolvedValueOnce({ Tags: [] });
    const untagged = await handler(request(['billing']));
    mockTags.mockResolvedValueOnce({ Tags: [{ Key: 'classification', Value: 'top-secret' }] });
    const unknown = await handler(request(['billing']));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(untagged.refused).toEqual(['billing']);
    expect(unknown.refused).toEqual(['billing']);
  });

  it('still clears the answered offer when the classification refuses the split', async () => {
    // The person answered. A standing offer is also `awaitingPerson`, which holds the conversation.
    mockTags.mockRejectedValue(new Error('AccessDenied'));

    await handler(request(['billing']));

    expect(mockClearPending).toHaveBeenCalledWith(expect.objectContaining({ channelArn: CHANNEL, responderId: 'atlas' }));
  });

  it('does not read the tag when no offer is outstanding', async () => {
    mockReadPending.mockResolvedValue(undefined);

    await handler(request(['billing']));

    expect(mockTags).not.toHaveBeenCalled();
  });

  it("refuses a parent above this deployment's own classification", async () => {
    mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'premium' }] });
    const prior = process.env.CLASSIFICATION;
    process.env.CLASSIFICATION = 'basic';
    try {
      let basicHandler: typeof handler;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        basicHandler = require('../lambda/src/conversation-split').handler;
      });
      const result = await basicHandler!({ ...request(['billing']), classification: 'premium' });

      expect(mockCreate).not.toHaveBeenCalled();
      expect(result.refused).toEqual(['billing']);
    } finally {
      if (prior === undefined) delete process.env.CLASSIFICATION; else process.env.CLASSIFICATION = prior;
    }
  });
});

describe('creating only what was offered and chosen', () => {
  it('creates a conversation for the subject the person chose', async () => {
    const result = await handler(request(['billing']));

    expect(result.created).toEqual([{ label: 'billing', channelArn: `${CHANNEL}-new` }]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      topicLabel: 'billing',
      parentChannelArn: CHANNEL,
      // THE PARENT'S TAG (standard in this fixture), never the request's.
      modelTier: 'standard',
    }));
  });

  it('creates nothing when no offer is outstanding', async () => {
    mockReadPending.mockResolvedValue(undefined);

    const result = await handler(request(['billing']));

    // The whole point of the boundary. A reply that invents a split, or replays an old one, reaches
    // a record that says no question was asked.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.refused).toEqual(['billing']);
  });

  it('refuses a subject that was never on the table', async () => {
    const result = await handler(request(['the pricing page']));

    // Creating it would open a room the person did not ask for, holding messages they did not send
    // there - and the label came through a model, so this is exactly where that has to be caught.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.refused).toEqual(['the pricing page']);
  });

  it('reads the offer as the person answering, so an offer put to somebody else is invisible', async () => {
    await handler(request(['billing']));

    expect(mockReadPending).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL,
      responderId: 'atlas',
      speakerId: 'alice',
    }));
  });
});

describe('when part of it does not work', () => {
  it('keeps the subjects that succeeded and names the one that did not', async () => {
    mockCreate
      .mockImplementationOnce(async () => ({ channelArn: `${CHANNEL}-a`, channelId: 'a' }))
      .mockImplementationOnce(async () => { throw new Error('CreateChannel failed'); });

    const result = await handler(request(['billing', 'the failed deploy']));

    // The person chose several things. Losing the rest because one threw is a worse answer than the
    // partial one, and what did not happen is named rather than dropped.
    expect(result.created).toEqual([{ label: 'billing', channelArn: `${CHANNEL}-a` }]);
    expect(result.refused).toEqual(['the failed deploy']);
  });

  it('does not leave an answered offer standing', async () => {
    await handler(request(['billing']));

    // A standing offer could be split again by a later reply that happened to name the same subject.
    expect(mockClearPending).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL, responderId: 'atlas',
    }));
  });

  it('leaves the offer standing when nothing was created and nothing matched', async () => {
    mockReadPending.mockResolvedValue(undefined);

    await handler(request(['billing']));

    // Nothing was answered here: the record says there was no question. Clearing would dispose of an
    // offer that may still be live for the person it was actually put to.
    expect(mockClearPending).not.toHaveBeenCalled();
  });
});

/**
 * WHAT DOES NOT MOVE MATTERS AS MUCH AS WHAT DOES.
 *
 * Every test above offers two subjects, where "split what they chose" and "split everything" are hard
 * to tell apart. With three offered and one chosen they separate completely: the wrong implementation
 * opens three rooms and empties a conversation the person wanted to keep.
 */
describe('splitting one subject out of three', () => {
  const THREE = {
    topics: [
      { label: 'billing', messageIds: ['m1', 'm4'] },
      { label: 'the failed deploy', messageIds: ['m2'] },
      { label: 'the pricing page copy', messageIds: ['m3'] },
    ],
    offeredTo: { alice: true },
    originatingMessageId: 'm9',
    offeredAt: 1,
  };

  beforeEach(() => { mockReadPending.mockResolvedValue(THREE); });

  it('creates exactly one conversation, for the subject they chose', async () => {
    const result = await handler(request(['the failed deploy']));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      topicLabel: 'the failed deploy',
    }));
    expect(result.created).toEqual([
      { label: 'the failed deploy', channelArn: `${CHANNEL}-new` },
    ]);
    expect(result.refused).toEqual([]);
  });

  it('never opens a room for a subject they did not name', async () => {
    await handler(request(['the failed deploy']));

    // The two they left behind stay where they are. Moving them would empty a conversation the
    // person deliberately kept whole, and the messages would be somewhere they never sent them.
    const moved = mockCreate.mock.calls.map((c: any[]) => c[0].topicLabel);
    expect(moved).not.toContain('billing');
    expect(moved).not.toContain('the pricing page copy');
  });

  it('closes the offer once it has been answered, even partly', async () => {
    await handler(request(['the failed deploy']));

    // Answered is answered. Leaving it open would let a later reply that happened to say "billing"
    // move a subject the person had already passed over.
    expect(mockClearPending).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL, responderId: 'atlas',
    }));
  });

  it('creates two when two were chosen, and still leaves the third', async () => {
    mockCreate
      .mockImplementationOnce(async () => ({ channelArn: `${CHANNEL}-a`, channelId: 'a' }))
      .mockImplementationOnce(async () => ({ channelArn: `${CHANNEL}-b`, channelId: 'b' }));

    const result = await handler(request(['billing', 'the pricing page copy']));

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.created.map((c: { label: string }) => c.label))
      .toEqual(['billing', 'the pricing page copy']);
    const moved = mockCreate.mock.calls.map((c: any[]) => c[0].topicLabel);
    expect(moved).not.toContain('the failed deploy');
  });
});

/**
 * WHO THE NEW CONVERSATION BELONGS TO (DESIGN 2.4.2).
 *
 * The two rules are opposites, and each is wrong applied to the other case. A subject the ROOM could
 * already read has to carry the room, or moving it makes a shared thread vanish for everyone except
 * the person who answered the offer. A PRIVATE subject has to carry only its requester, because the
 * room never saw it and carrying them would publish it by the act of moving it.
 */
describe('membership of a spawned conversation', () => {
  const MIXED = {
    topics: [
      { label: 'the failed deploy', messageIds: ['m2'] },
      { label: 'my expenses query', messageIds: ['m3'], private: true, requestorId: 'alice' },
    ],
    offeredTo: { alice: true },
    originatingMessageId: 'm9',
    offeredAt: 1,
  };
  const ROOM = [
    'arn:aws:chime:us-east-1:1:app-instance/i/user/alice',
    'arn:aws:chime:us-east-1:1:app-instance/i/user/bob',
    'arn:aws:chime:us-east-1:1:app-instance/i/user/carol',
  ];

  beforeEach(() => {
    mockReadPending.mockResolvedValue(MIXED);
    mockSend.mockResolvedValue({
      ChannelMemberships: [
        ...ROOM.map((arn) => ({ Member: { Arn: arn } })),
        // The assistant is a member of every channel by creation. Carrying it across would put a
        // SECOND assistant in a room that already has its own, and then two of them answer.
        { Member: { Arn: BOT } },
      ],
    });
  });

  it('carries the room into a conversation split from a shared subject', async () => {
    await handler(request(['the failed deploy']));

    const created = mockCreate.mock.calls[0][0];
    expect(created.additionalMemberArns).toEqual(ROOM);
    expect(created.additionalMemberArns).not.toContain(BOT);
  });

  it('carries only the requester into a conversation split from a targeted subject', async () => {
    await handler(request(['my expenses query']));

    const created = mockCreate.mock.calls[0][0];
    // Not "the room minus somebody" - nobody at all. The creator is added by creation itself, and
    // anyone else here would be reading a message that was never theirs.
    expect(created.additionalMemberArns).toBeUndefined();
  });

  it('does not ask who is in the room when nothing needs it', async () => {
    await handler(request(['my expenses query']));

    // A call saved, and a question not asked: an offer of nothing but private subjects has no
    // business enumerating the conversation.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('carries nobody rather than guessing when the membership cannot be read', async () => {
    mockSend.mockRejectedValue(new Error('AccessDenied'));

    await handler(request(['the failed deploy']));

    // A conversation missing people is a visible problem somebody reports. One holding a person who
    // should not be there is a disclosure nobody sees, so the failure direction is deliberate.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].additionalMemberArns).toEqual([]);
  });
});

describe('the split speaks as nobody: the processor that asked posts the link', () => {
  it('mints no assistant session', async () => {
    await handler(request(['billing']));
    expect(session.vendAssistantSession).not.toHaveBeenCalled();
  });

  it('asks creation not to post the parent link, and returns what it created', async () => {
    const out = await handler(request(['billing']));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ postParentLink: false }));
    expect(out.created.map((c: { label: string }) => c.label)).toEqual(['billing']);
  });
});
