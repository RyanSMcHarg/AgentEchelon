/**
 * THE CHANNEL FLOW ROUTES EVERY `@` TOKEN, and what it does with one depends on who it names (ADR-034).
 *
 * WHAT CHANGED. `@<assistant>` used to be a client-set `Target`: Amazon Chime SDK routed it, and none
 * of this code ran. That made addressing a message inseparable from restricting who could READ it -
 * the room watched somebody type to the assistant and saw no reply, because the reply was visible
 * only to the sender. Addressing and privacy are different acts, so `@` now sets no `Target`, the
 * flow routes it, and the exchange stays readable by everyone. `.` is what makes a message private,
 * and the service still routes that one from its `Target`.
 *
 * THE FOUR OUTCOMES, and three of them are silent in the channel:
 *
 *   @<assistant>  the flow dispatches the turn; the reply is a broadcast.
 *   @<person>     nothing is dispatched. Addressing a colleague starts no assistant turn.
 *   @<nobody>     nothing is dispatched, and it is WARNED - a typo'd name is otherwise
 *                 indistinguishable from a message nobody addressed.
 *   1:1           the flow stands aside at every token, because AUTO routes every message to Lex
 *                 there and a second entry would answer the turn twice.
 *
 * WHY THEY ARE PINNED TOGETHER. Each outcome leaves the same trace in the channel - the message
 * appears and no assistant speaks - so a regression in any of them looks exactly like the other
 * three working. Only the dispatch, and the absence of one, tells them apart.
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
  // A `.` message is read back for its `Target` (lib/private-command.ts). Here every stored message is
  // targeted at the member its own text names, so a private message proceeds exactly as the web
  // composer sends it. `withRoster` below derives that member rather than pinning one.
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

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const BOT = `${INSTANCE}/bot/basic-bot`;
const ALICE = `${INSTANCE}/user/alice`;
const BOB = `${INSTANCE}/user/bob`;
const ROUTER_BASIC = 'arn:aws:lambda:us-east-1:111122223333:function:router-basic';
const PLACEHOLDER = 'One moment... <!--corr:mention-abc-->';

/** Alice, Bob and the assistant: a GROUP, where the flow owns a mention. */
const GROUP = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: BOB, Name: 'Bob' } },
  { Member: { Arn: BOT, Name: 'Atlas' } },
];

/** Alice and the assistant: the size at which the flow stands aside. */
const ONE_TO_ONE = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: BOT, Name: 'Atlas' } },
];

function flowEvent(content: string) {
  return {
    CallbackId: 'cb-1',
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: `m-${Math.random().toString(36).slice(2)}`,
      Content: content,
      Metadata: undefined,
      Sender: { Arn: ALICE, Name: 'Alice' },
      ChannelArn: CHANNEL,
    },
  };
}

const invokes = () => mockLambdaSend.mock.calls
  .filter((c) => c[0]?.__type === 'Invoke')
  .map((c) => ({
    fn: c[0].input.FunctionName as string,
    payload: JSON.parse(Buffer.from(c[0].input.Payload).toString()),
  }));

/** Did the flow hand a turn to the router? The one observable that separates the four outcomes. */
const dispatched = () => invokes().some((i) => i.fn === ROUTER_BASIC);

/** The user message the turn was handed, which is the text the model actually answers. */
const dispatchedText = () => invokes().find((i) => i.fn === ROUTER_BASIC)?.payload?.aeTurn?.userMessage;

/** ALLOWED, not DENIED. A denied message is never persisted - it leaves the room entirely. */
const allowed = () => mockMessagingSend.mock.calls.some(
  (c) => c[0]?.__type === 'Callback' && !c[0]?.input?.DeleteResource && !!c[0]?.input?.ChannelMessage?.MessageId,
);

const readTheRoster = () => mockMessagingSend.mock.calls.some((c) => c[0]?.__type === 'ListMemberships');

/** What the flow POSTED as a bot, and the ARN it posted as. */
const posts = () => mockMessagingSend.mock.calls
  .filter((c) => c[0]?.__type === 'SendMessage')
  .map((c) => ({ content: c[0].input.Content as string, as: c[0].input.ChimeBearer as string }));

describe('an @ token names one member, and the flow routes it', () => {
  let handler: (e: any) => Promise<void>;
  let warn: jest.SpyInstance;

  const withRoster = (memberships: unknown[]) => {
    mockMessagingSend.mockImplementation((cmd: any) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: memberships });
      if (cmd.__type === 'GetMessage') {
        // PROPERLY TARGETED MEANS THE `Target` NAMES THE MEMBER THE TEXT ADDRESSED, not merely that one
        // is set (lib/private-command.ts). So the stored Target is DERIVED from the `.` token of the
        // message the flow has just released, which is what the composer does. A fixed ARN here made
        // `.Atlas` read as a message targeted at Bob, which is the disclosure the check now refuses.
        const released = mockMessagingSend.mock.calls
          .map((c: any) => c[0])
          .filter((c: any) => c?.__type === 'Callback')
          .pop()?.input?.ChannelMessage?.Content as string | undefined;
        const token = /^\s*\.(\S+)\s/.exec(released ?? '')?.[1]?.toLowerCase();
        const addressee = (memberships as Array<{ Member?: { Arn?: string; Name?: string } }>)
          .find((m) => m?.Member?.Name?.toLowerCase() === token);
        return Promise.resolve({ ChannelMessage: { Target: [{ MemberArn: addressee?.Member?.Arn ?? BOB }] } });
      }
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:standard';
    process.env.BASIC_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:basic';
    process.env.PREMIUM_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:premium';
    process.env.STANDARD_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
    process.env.BASIC_ROUTER_ARN = ROUTER_BASIC;
    process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: JSON.stringify({ role: 'primary', occupancy: 'live', assistant: 'advisor', botArn: BOT }) } });
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
        messages: [{ contentType: 'PlainText', content: PLACEHOLDER }],
      })),
    });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    withRoster(GROUP);
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  afterEach(() => warn.mockRestore());

  it('dispatches a broadcast turn when an ASSISTANT is named, and posts nothing itself', async () => {
    await handler(flowEvent('@Atlas what is the deploy order?'));

    expect(dispatched()).toBe(true);
    // BROADCAST is the whole point of separating addressing from privacy: the room asked, so the room
    // sees the answer. The turn is dispatched untargeted, and the flow posts nothing (it never speaks),
    // even though the router hands a message back here.
    expect(invokes().find((i) => i.fn === ROUTER_BASIC)?.payload?.aeTurn?.targeted).toBeFalsy();
    expect(posts()).toHaveLength(0);
    expect(allowed()).toBe(true);
  });

  it('hands the turn the QUESTION, not the address', async () => {
    // "@Atlas what is the deploy order?" asks about the deploy order. Leaving the token in makes the
    // assistant's own name part of the question it is answering.
    await handler(flowEvent('@Atlas what is the deploy order?'));

    expect(dispatchedText()).toBe('what is the deploy order?');
  });

  it('keeps a mention of somebody ELSE, because that clause is the request', async () => {
    await handler(flowEvent('@Atlas could you ask @Bob about it'));

    expect(dispatchedText()).toBe('could you ask @Bob about it');
  });

  it('starts NO turn when a person is named', async () => {
    // Addressing a colleague is not summoning the assistant. An assistant that answered here would
    // interrupt every conversation in a busy room.
    await handler(flowEvent('@Bob can you take a look at this?'));

    expect(dispatched()).toBe(false);
    // The message is still released, with its `@` intact - the token is how Bob sees it was for him.
    expect(allowed()).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('starts NO turn for a PRIVATE message that also names an assistant, so its answer is not broadcast', async () => {
    // A `.` message is readable by two people. A flow-dispatched turn answers untargeted, so taking
    // this one would put the answer in front of the whole room. The composer refuses the combination;
    // another ingress does not, and the flow may not rely on one client. Amazon Chime SDK routes the
    // message from its `Target`, and the reply inherits that.
    await handler(flowEvent('.Bob @Atlas what did we decide about the budget?'));

    expect(dispatched()).toBe(false);
    expect(allowed()).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('starts no flow turn for a private message to the assistant carrying its @ too', async () => {
    await handler(flowEvent('.Atlas @Atlas what is the deploy order?'));

    expect(dispatched()).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it('starts no turn, and SAYS SO, when the name matches nobody here', async () => {
    // The one outcome with no trace at all: the message appears, nothing answers, and in a group the
    // ordinary path cannot recover it either. A typo'd assistant name and a member who has left both
    // land here, and without the warning a person is ignored in front of the room and no record says
    // why.
    await handler(flowEvent('@Carol are you around?'));

    expect(dispatched()).toBe(false);
    expect(allowed()).toBe(true);
    expect(warn.mock.calls.some(([m]) => String(m).includes('named nobody'))).toBe(true);
  });

  it('does NOT refuse the message, because two people may simply have typed an @ at each other', async () => {
    // Replying "I don't know who that is" would answer messages that were never addressed to an
    // assistant at all. Silence plus a record is the chosen direction.
    await handler(flowEvent('@Carol are you around?'));

    expect(posts()).toHaveLength(0);
  });

  it('does NOT warn about an unresolvable @ in a 1:1, because the ordinary path answers there', async () => {
    // The warning says "no turn starts". At this size that is false: AUTO routes every message to Lex
    // regardless of mentions, so an unresolvable `@` is answered by the ordinary path and nothing is
    // dropped. Logging it anyway would put a line claiming a dropped turn next to a turn that ran.
    withRoster(ONE_TO_ONE);

    await handler(flowEvent('@Carol are you around?'));

    expect(warn.mock.calls.some(([m]) => String(m).includes('named nobody'))).toBe(false);
  });

  it('claims a 1:1 @all with no space in front of it, now that nothing else is invoked', async () => {
    // THE TWO-RESPONDER DEFECT THIS ONCE PINNED, kept because the reason matters. `matchesAtAll` has
    // no leading boundary; the roster-read prefilter requires one. So "hey@all" is an `@all` to the
    // branch below and not a mention to the gate above it - the roster was never read, `isOneToOne`
    // defaulted to false, and the flow dispatched in a two-member channel where AUTO invoked the
    // handler for every message regardless. Two placeholders, one stranded forever.
    //
    // THE HAZARD IS GONE BECAUSE THE SECOND RESPONDER IS GONE. `turnEntry` now defaults to `'flow'`,
    // so the assistant carries `StandardMessages: NONE` and Amazon Chime SDK invokes Amazon Lex for
    // no untargeted message at any size. Standing aside here would answer NOBODY, which is the worse
    // of the two failures. The match-surface gap is still real and still worth its own guard; what
    // changed is which side of it is safe.
    withRoster(ONE_TO_ONE);

    await handler(flowEvent('hey@all what is the billing policy?'));

    expect(dispatched()).toBe(true);
    expect(allowed()).toBe(true);
  });

  it('still answers that same @all in a GROUP, so the fix did not silence it', async () => {
    await handler(flowEvent('hey@all what is the billing policy?'));

    expect(dispatched()).toBe(true);
  });

  it('claims a 1:1 whichever token the message carries, because it is now the only entry', async () => {
    // WHY IT USED TO STAND ASIDE. Under `StandardMessages: AUTO` this size routed EVERY message to
    // Amazon Lex regardless of mentions, so the Lex entry ran whatever the flow did. Dispatching as
    // well meant two entries on one turn under two correlation ids, which the duplicate-placeholder
    // claim could not recognize as the same turn - measured 2026-08-12 as two placeholders 558 ms
    // apart, one stranded at "One moment..." forever.
    //
    // Under the `'flow'` default the premise is simply false: `NONE` means Amazon Lex is invoked for
    // no untargeted message, so there is no second entry to collide with. The duplicate-placeholder
    // claim stays - it still guards a redelivery of the same message - but it no longer has to
    // reconcile two entries racing one turn.
    withRoster(ONE_TO_ONE);

    await handler(flowEvent('@Atlas what is the deploy order?'));

    expect(dispatched()).toBe(true);
    expect(allowed()).toBe(true);
  });

  it('dispatches a percent-encoded @all, which only the DECODED form carries', async () => {
    await handler(flowEvent('%40all%20what%20is%20the%20billing%20policy%3F'));

    expect(dispatched()).toBe(true);
  });

  it('dispatches an @all that only the RAW form carries, so the two decisions cannot disagree', async () => {
    // The wedge that separates the forms in the other direction. "@all%41 hello" decodes to
    // "@allA hello", where the word boundary after `@all` is gone and the token vanishes; the raw
    // form still carries it. `mentionsAll` tests both, and the `@all` branch now turns on
    // `flowOwnsTheTurn` rather than on the member count directly - so an answer computed from the
    // decoded form alone would send a GROUP `@all` down the 1:1 stand-aside, and it would be answered
    // by nobody. Nothing errors in that state; the message simply sits there.
    await handler(flowEvent('@all%41 hello'));

    expect(dispatched()).toBe(true);
  });

  it('DOES read the roster for a message carrying no @, which is what the flow entry costs', async () => {
    // THE PREFILTER STOPPED BEING A GATE, and this test is where that cost is visible rather than
    // asserted in prose. Under `turnEntry: 'lex'` a message with no `@`, no `.` and no command cost
    // exactly one `ChannelFlowCallback` and read nothing, because nothing downstream needed the
    // roster. Under the `'flow'` default the flow has to know whether this is a 1:1 before it can
    // know whether the turn is its own, and room size comes only from a live `ListChannelMemberships`.
    //
    // THE PLACEMENT IS WHAT MAKES IT AFFORDABLE, NOT THE ABSENCE OF THE READ. ADR-041 rule 4 moved it
    // AFTER `callbackAllow`, so the person sees their own message first and the read is traded
    // against the Amazon Chime SDK to Amazon Lex to Lambda hop it replaces. `allowed()` being true
    // alongside the read is that ordering holding.
    withRoster(ONE_TO_ONE);

    await handler(flowEvent('sounds good to me'));

    expect(readTheRoster()).toBe(true);
    expect(allowed()).toBe(true);
    // A 1:1 with no token is still the flow's turn to answer, because nothing else is invoked for it.
    expect(dispatched()).toBe(true);
  });

  it('answers a bare @<assistant> with nothing rather than an unresolvable placeholder', async () => {
    // Addressed, but there is no request in it. Dispatching would put a "One moment..." in the room
    // for a turn with nothing to answer.
    await handler(flowEvent('@Atlas'));

    expect(dispatched()).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it('prefers the LONGER name, so a prefix cannot claim a message addressed to somebody else', async () => {
    // Sam and Samantha in one room. Getting this wrong notifies the wrong person and attributes the
    // turn to them, and nothing errors.
    withRoster([
      { Member: { Arn: `${INSTANCE}/user/sam`, Name: 'Sam' } },
      { Member: { Arn: `${INSTANCE}/user/samantha`, Name: 'Samantha' } },
      { Member: { Arn: BOT, Name: 'Atlas' } },
    ]);

    await handler(flowEvent('@Samantha please review'));

    // Both are people, so neither starts a turn - what is being pinned is that the message was
    // RESOLVED rather than falling through to the "named nobody" warning.
    expect(dispatched()).toBe(false);
    expect(warn.mock.calls.some(([m]) => String(m).includes('named nobody'))).toBe(false);
  });
});
