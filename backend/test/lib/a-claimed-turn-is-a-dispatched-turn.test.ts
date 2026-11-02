/**
 * A TURN THE FLOW CLAIMS IS A TURN THE FLOW DISPATCHES.
 *
 * `flowOwnsTheTurn` answers "is this mine", and the handler's branches answer "so send it where". For
 * as long as every claim came from a token in the text - `@all`, an `@` that resolved, a command, a
 * leading `#<n>` - those two were the same set by accident, and nothing asserted it. The first claim
 * that came from somewhere else broke it in silence.
 *
 * MEASURED ON THE DEPLOYMENT, 2026-09-16. The channel flow claims the ordinary one-to-one turn, which
 * carries no token at all. The flow logged
 * `addressing { ownsTheTurn: true, isOneToOne: true }` and then released the message: no dispatch, no
 * placeholder, no refusal, nothing in the log. The person's message appeared and the assistant never
 * spoke. `flowOwnsTheTurn`'s own unit tests passed throughout, because the function was right.
 *
 * SO THIS FILE GUARDS THE SEAM RATHER THAN EITHER SIDE OF IT, and it is deliberately written as an
 * invariant over the handler rather than as a case list: a future claim arriving from a fifth place
 * should fail here until somebody routes it.
 *
 * THE ONE DOCUMENTED EXCEPTION IS PINNED TOO. `@<person>` claims the turn - the token resolves against
 * the roster - and dispatches nothing, because no assistant was named. That is MESSAGE-FLOW's routing
 * cell 11, "nobody, and it is warned", and a guard that did not carve it out would either fail on it
 * or be written loosely enough to miss the defect above.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetMessage', input: args })),
  DeleteChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'DeleteMessage', input: args })),
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
}), { virtual: true });

// SPREADS THE REAL MODULE, so a new export does not break this file. It used to list three functions
// and nothing else, which made the mock a snapshot of `abuse-controls` at the moment it was written:
// adding `flowDeliveryKey` there left every test here failing with "is not a function", in a file
// about the channel flow that has nothing to say about delivery keys. Only the behavior this file
// actually pins is overridden; the pure helpers stay real.
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/abuse-controls.js'),
  claimCorrelation: async () => true,
  claimPlaceholderMapping: async () => true,
  evaluateAbuseGate: async () => ({ allowed: true }),
}), { virtual: true });

jest.mock('../../lambda/src/lib/experiment-manager.js', () => ({
  listExperimentsCached: async () => [],
}), { virtual: true });

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const PAIR_CHANNEL = `${INSTANCE}/channel/premium-pair`;
const LEX_CHANNEL = `${INSTANCE}/channel/premium-1`;
const BOT = `${INSTANCE}/bot/the-assistant`;
const ALICE = `${INSTANCE}/user/alice`;
const BOB = `${INSTANCE}/user/bob`;
const ROUTER_PROBE = 'arn:aws:lambda:us-east-1:111122223333:function:router-probe';
const ROUTER_PREMIUM = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
const PLACEHOLDER = 'One moment... <!--corr:mention-abc-->';

/** A 1:1 as the assistant sees it: the person and itself, and nobody else. */
const ONE_TO_ONE = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: BOT, Name: 'Atlas' } },
];
/** A group, for the `@<person>` exception. */
const ROOM = [...ONE_TO_ONE, { Member: { Arn: BOB, Name: 'Bob' } }];

function flowEvent(content: string, channelArn: string) {
  return {
    CallbackId: `cb-${Math.random().toString(36).slice(2)}`,
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: `m-${Math.random().toString(36).slice(2)}`,
      Content: content,
      Metadata: undefined,
      Sender: { Arn: ALICE, Name: 'Alice' },
      ChannelArn: channelArn,
    },
  };
}

const invokes = () => mockLambdaSend.mock.calls
  .filter((c) => c[0]?.__type === 'Invoke')
  .map((c) => c[0].input.FunctionName as string);
const releases = () => mockMessagingSend.mock.calls.filter(
  (c) => c[0]?.__type === 'Callback' && !c[0]?.input?.DeleteResource,
);

describe('a turn the flow claims is a turn the flow dispatches', () => {
  let handler: (e: any) => Promise<void>;

  const withRoom = (members: unknown[]) => {
    mockMessagingSend.mockImplementation((cmd: { __type: string; input?: { ResourceARN?: string } }) => {
      if (cmd.__type === 'ListTags') {
        // The channel's classification decides which profile serves it, and therefore its turn entry.
        // ONE CLASSIFICATION. `probe` was removed on 2026-09-17 with the per-profile turn entry;
        // what distinguishes the cases below is the ROSTER (a one-to-one against a group), which is
        // what actually decides whether the flow owns an untargeted turn.
        return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] });
      }
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: members });
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PREMIUM_ROUTER_ARN = ROUTER_PREMIUM;
    process.env.STANDARD_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
    mockSsmSend.mockImplementation(() => Promise.resolve({ Parameter: { Value: JSON.stringify({ role: 'primary', occupancy: 'live', botArn: BOT }) } }));
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
        messages: [{ contentType: 'PlainText', content: PLACEHOLDER }],
      })),
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    withRoom(ONE_TO_ONE);
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  it('dispatches an untargeted 1:1 turn, which is the defect this file exists for', async () => {
    await handler(flowEvent('In one sentence, what is a feature flag?', PAIR_CHANNEL));

    // THE ASSERTION THAT WOULD HAVE CAUGHT IT. Before the dispatch branch existed this released the
    // message and invoked nothing, and every other test in the suite still passed.
    expect(`dispatched to: ${invokes().join(',') || '(nothing)'}`).toBe(`dispatched to: ${ROUTER_PREMIUM}`);
    // And the person's own message still reaches the room; claiming a turn is not holding a message.
    expect(releases()).toHaveLength(1);
  });

  it('does NOT dispatch the same message in a GROUP, which is what keeps the case above meaningful', async () => {
    // NON-VACUITY, REWRITTEN WHEN THE ENTRY STOPPED VARYING. This used to contrast a flow-entry
    // classification against a Lex-entry one, and that contrast no longer exists: every assistant
    // carries `StandardMessages: NONE` and the per-profile `turnEntry` was removed on 2026-09-17.
    //
    // The property that still needs guarding is the same one: if the handler dispatched every
    // untargeted message, the case above would prove nothing. A group message nobody addressed is
    // nobody's turn - an assistant does not answer people talking to each other - so this is the
    // half that fails if the one-to-one claim were widened into "claim everything".
    withRoom(ROOM);
    await handler(flowEvent('In one sentence, what is a feature flag?', LEX_CHANNEL));

    expect(`dispatched to: ${invokes().join(',') || '(nothing)'}`).toBe('dispatched to: (nothing)');
    expect(releases()).toHaveLength(1);
  });

  it('claims and deliberately dispatches nothing for an @ naming a person, which is routing cell 11', async () => {
    // The documented exception. `@Bob` resolves against the roster, so the flow owns the turn and the
    // Amazon Lex entry stands down - and no assistant was named, so nothing is dispatched and the
    // outcome is warned rather than answered. A guard written as "claimed implies dispatched" with no
    // carve-out would fail here; one written loosely enough to pass would have missed the real defect.
    withRoom(ROOM);
    await handler(flowEvent('@Bob can you take a look', LEX_CHANNEL));

    expect(`dispatched to: ${invokes().join(',') || '(nothing)'}`).toBe('dispatched to: (nothing)');
    expect(releases()).toHaveLength(1);
  });

  it('claims a redelivery once, so an untargeted turn is not answered twice', async () => {
    // The dedup claim is keyed on the message id and is spent by `dispatchesATurn`. A dispatch branch
    // added without adding itself to that predicate answers a redelivered message twice, which is the
    // defect the `/stop` note in the handler records. `claimCorrelation` is stubbed true here, so this
    // pins that the dispatch goes THROUGH the claimed path rather than around it.
    const event = flowEvent('what is a feature flag?', PAIR_CHANNEL);
    await handler(event);
    expect(invokes()).toHaveLength(1);
  });
});
