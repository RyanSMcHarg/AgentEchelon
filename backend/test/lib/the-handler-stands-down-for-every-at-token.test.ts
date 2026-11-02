/**
 * THE OTHER HALF OF "ONE RESPONDER", now that the channel flow routes every `@` token (ADR-034).
 *
 * The flow acts when `flowOwnsTheTurn` is true; this handler stands down when the SAME function over
 * the SAME roster is true. They are complements by construction rather than by two lists agreeing -
 * which matters because the failure has no error in it. If both sides say yes the turn is answered
 * twice; if both say no it is answered by nobody, and the channel looks identical to one where
 * nothing was asked.
 *
 * WHAT WIDENED. The guard used to match two literals, `@all` and `/battle`. `@<member>` cannot be
 * enumerated - it is any `@` that resolves against THIS channel's roster - so the guard now reads the
 * roster, and a cheap prefilter keeps the read off every message that carries no `@` at all.
 *
 * THE FAIL DIRECTION IS PER TOKEN, and that is the subtle part this file exists to pin. When the
 * roster cannot be read, `@all` still stands down (the flow's own unreadable-count path dispatches,
 * so it answers) while any other `@` is ANSWERED here (the flow faced the same failure, resolved
 * nobody, and dispatched nothing). Applying one rule to both would, during a Chime outage, silence
 * every message containing an `@`.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
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

// Stub only the BILLED model call, and mirror the real function's keyword fast path. Replacing the
// whole module makes every turn die in the handler's catch-all, which still returns a non-empty
// `messages` - so a "the handler answered" assertion would pass on the error path and prove nothing.
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: jest.fn(async (msg: string) =>
      actual.fastPathIntent(msg) ?? { intent: 'general', confidence: 'high' }),
  };
}, { virtual: true });

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const BOT = `${INSTANCE}/bot/basic-bot`;
const ALICE = `${INSTANCE}/user/alice`;
const BOB = `${INSTANCE}/user/bob`;

const GROUP = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: BOB, Name: 'Bob' } },
  { Member: { Arn: BOT, Name: 'Atlas' } },
];

const ONE_TO_ONE = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: BOT, Name: 'Atlas' } },
];

/** The LEX entry: the one Amazon Chime SDK's AUTO trigger invokes, and the one that may need to stand down. */
const lexEvent = (transcript: string) => ({
  sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
  inputTranscript: transcript,
  requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': ALICE },
});

const readTheRoster = () => mockMessagingSend.mock.calls.some((c) => c[0]?.__type === 'ListMemberships');

describe('the handler stands down exactly when the flow claims the turn', () => {
  let handler: (e: any) => Promise<any>;
  let warn: jest.SpyInstance;

  const withRoster = (memberships: unknown[] | null) => {
    mockMessagingSend.mockImplementation((cmd: any) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'ListMemberships') {
        return memberships === null
          ? Promise.reject(new Error('AccessDenied'))
          : Promise.resolve({ ChannelMemberships: memberships });
      }
      if (cmd.__type === 'ListMessages') return Promise.resolve({ ChannelMessages: [] });
      return Promise.resolve({ ChannelMessage: { MessageId: 'm-1' }, MessageId: 'm-1' });
    });
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CLASSIFICATION = 'basic';
    // The bot parameter, and the assignment record naming the assistant on that bot: the router
    // resolves the turn's assistant from it and declines a turn whose assistant it cannot name.
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: BOT },
      Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'concierge', role: 'primary', occupancy: 'live' }) }],
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({})) });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    withRoster(GROUP);
    ({ handler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  afterEach(() => warn.mockRestore());

  it('stands down when an ASSISTANT is named in a group, because the flow dispatches that turn', async () => {
    // The case that closes the open platform question. `@<assistant>` no longer sets a `Target`, so
    // whether AUTO invokes this handler on `CHIME.mentions` alone stops mattering for correctness:
    // the flow dispatches either way, and this entry declines either way. Exactly one responder
    // whichever way that platform behavior turns out.
    const res = await handler(lexEvent('@Atlas what is the deploy order?'));

    // Empty ARRAY, not an absent field: the client drops a Lex envelope whose messages is present and
    // empty, and renders the raw envelope when it is missing entirely.
    expect(res.messages).toEqual([]);
  });

  it('stands down when a PERSON is named in a group, so no assistant answers a message meant for a colleague', async () => {
    // The flow starts no turn here either - nobody answers, which is correct. An assistant replying
    // to "@Bob can you take a look" is the interruption this grammar exists to prevent.
    const res = await handler(lexEvent('@Bob can you take a look at this?'));

    expect(res.messages).toEqual([]);
  });

  it('STANDS DOWN in a 1:1 too, because the flow claims every turn at that size', async () => {
    // THE PREMISE INVERTED ON 2026-09-17. `AUTO` routed every message to Amazon Lex at this size
    // regardless of mentions, so this entry ran whatever the flow did and the flow deferred to it.
    // Every assistant now carries `StandardMessages: NONE`, so an untargeted message reaches no Lex
    // entry at all and `flowOwnsTheTurn` returns true for every 1:1 - which means that if a Lex event
    // for one DOES arrive, the flow has already claimed it and answering here would be the second
    // answer the complement exists to prevent.
    withRoster(ONE_TO_ONE);

    const res = await handler(lexEvent('@Atlas what is the deploy order?'));

    expect(res.messages).toEqual([]);
  });

  it('ANSWERS a private message to the assistant that also carries its @, because the flow does not take it', async () => {
    // The `Target` is what routed this entry, and the flow stands aside for any message that resolves
    // to a private address. Standing down here as well would leave a private question answered by
    // nobody; answering on this entry keeps the reply targeted, as the question was.
    const res = await handler(lexEvent('.Atlas @Atlas what is the deploy order?'));

    expect(res.messages).not.toEqual([]);
  });

  it('ANSWERS when the name matches nobody, because the flow dispatched nothing for it', async () => {
    const res = await handler(lexEvent('@Carol what is the deploy order?'));

    expect(res.messages).not.toEqual([]);
  });

  it('answers an ordinary message with no @ in it', async () => {
    const res = await handler(lexEvent('what is the billing policy?'));

    expect(res.messages).not.toEqual([]);
  });

  it('answers a message quoting an email address, which is not a mention', async () => {
    // `@` mid-word is not a mention in any chat client. Treating one as a mention would send this
    // guard to the roster, resolve nobody, and - during a roster failure - decide the fate of an
    // ordinary message on a token that was never an address.
    //
    // THE COST SIDE OF THAT PROPERTY IS NOT ASSERTED HERE, because this handler reads memberships on
    // the ordinary path anyway (`getMemberArns`, cached per container), so counting reads at this
    // level proves nothing about the prefilter. `mightMentionSomeone` is pinned directly in
    // `flow-bypass.test.ts`, and the flow - which has exactly one membership call site - is where the
    // "no read without an @" property is observable end to end.
    const res = await handler(lexEvent('send it to bob@example.com please'));

    expect(res.messages).not.toEqual([]);
  });

  it('still stands down for @all, at group size, exactly as before', async () => {
    const res = await handler(lexEvent('@all what is the billing policy?'));

    expect(res.messages).toEqual([]);
  });

  it('stands down for an @all with no space in front of it, which the prefilter alone misses', async () => {
    // The other half of the same defect. This guard used to fire on `flowBypassToken`; widening it to
    // the `@` prefilter without keeping that term NARROWED it, because `matchesAtAll` has no leading
    // boundary and the prefilter requires one. Every such form skipped the guard and this entry ran a
    // full turn for a message the flow was claiming at the same moment. A guard that grows has to be
    // a superset of the one it replaces.
    const res = await handler(lexEvent('hey@all what is the billing policy?'));

    expect(res.messages).toEqual([]);
  });

  it('still stands down for /battle without reading anything', async () => {
    // A duel needs two assistants, so it cannot arise in a 1:1 at all: the flow owns it at every size
    // and no roster is needed to know that.
    const res = await handler(lexEvent('/battle tabs or spaces'));

    expect(res.messages).toEqual([]);
    expect(readTheRoster()).toBe(false);
  });

  it('stays silent when the transcript arrives percent-encoded', async () => {
    // The flow tests raw AND decoded. If this side tested one form only, the two would disagree about
    // what a token means and the turn would be answered twice.
    const res = await handler(lexEvent('%40all%20what%20is%20the%20billing%20policy%3F'));

    expect(res.messages).toEqual([]);
  });

  describe('when the roster cannot be read at all', () => {
    beforeEach(() => withRoster(null));

    it('still stands down for @all, because the flow fails toward dispatching', async () => {
      const res = await handler(lexEvent('@all what is the billing policy?'));

      expect(res.messages).toEqual([]);
      expect(warn.mock.calls.some(([m]) => String(m).includes('unreadable twice'))).toBe(true);
    });

    it('ANSWERS any other @, rather than silencing every @-shaped message during an outage', async () => {
      // The flow reads the same roster from the same service. It resolved nobody and dispatched
      // nothing, so standing down here too would leave the turn answered by NOBODY - and not as a
      // rare edge: as every message containing an `@` for the duration of the failure.
      const res = await handler(lexEvent('@Atlas what is the deploy order?'));

      expect(res.messages).not.toEqual([]);
      expect(warn.mock.calls.some(([m]) => String(m).includes('roster unreadable'))).toBe(true);
    });
  });
});

afterAll(() => { delete process.env.CLASSIFICATION; });
