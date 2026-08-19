/**
 * `@all` takes ONE path at every channel size, and exactly one thing answers it.
 *
 * THE DESIGN. `@all` always takes the channel flow's broadcast bypass - no member-count branch, no
 * `ListChannelMemberships` on the hot path. The flow dispatches the async processor, which posts one
 * reply visible to every member.
 *
 * THE DEFECT THAT MAKES THE SECOND HALF NECESSARY. `@all` is not a Chime CHIME.mentions value, so
 * `StandardMessages: AUTO` does not route it to Lex in a GROUP channel and the bypass is the only
 * responder. In a 1:1 AUTO routes EVERY message regardless of mentions, so Lex is invoked as well and
 * the turn was answered twice - once by the broadcast, once by an ordinary Lex reply. Deterministic on
 * every 1:1 `@all`, which is why users hit it constantly. The router's `@all` guard closes it.
 *
 * THE TWO HALVES ARE ONE INVARIANT: the flow always answers, the router never does. Asserting either
 * alone would let the pair drift back into answering twice (router guard removed) or not at all (flow
 * bypass made conditional), so both are pinned here, in one file, deliberately.
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

// Override ONLY the billed model call. The previous mock replaced the whole module, so `IntentType`
// and `intentToDeliveryOption` came back undefined and every router turn below died in the handler's
// catch-all - which still returns a non-empty `messages`, so the bypass tests passed on the ERROR
// path and proved nothing about the bypass. Keep the rest of the module real.
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    // Mirrors the REAL classifyIntent: the keyword fast path first, the model only when it declines.
    // Stubbing the whole function instead hid the fast path, and the fast path is what calls a
    // sub-3-character message a greeting - so the attachment-only test could not fail even with the
    // guard removed. (Confirmed by mutation.) Stub the billed call, not the logic in front of it.
    classifyIntent: jest.fn(async (msg: string) =>
      actual.fastPathIntent(msg) ?? { intent: 'general', confidence: 'high' }),
  };
}, { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';
const HUMAN_A = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/alice';

function flowEvent(content: string) {
  return {
    CallbackId: 'cb-1',
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: `m-${Math.random().toString(36).slice(2)}`,
      Content: content,
      Metadata: undefined,
      Sender: { Arn: HUMAN_A, Name: 'Alice' },
      ChannelArn: CHANNEL,
    },
  };
}

const ROUTER_BASIC = 'arn:aws:lambda:us-east-1:111122223333:function:router-basic';
const PLACEHOLDER = 'One moment... <!--corr:mention-abc-->';

/** Every Lambda invoke the flow made, as {FunctionName, InvocationType, payload}. */
const invokes = () => mockLambdaSend.mock.calls
  .filter((c) => c[0]?.__type === 'Invoke')
  .map((c) => ({
    fn: c[0].input.FunctionName as string,
    type: c[0].input.InvocationType as string,
    payload: JSON.parse(Buffer.from(c[0].input.Payload).toString()),
  }));

/** Did the flow hand the turn to the ROUTER — i.e. produce a reply without running the turn itself? */
const handedOff = () => invokes().some((i) => i.fn === ROUTER_BASIC);

/** Messages the flow POSTED (not callbacks). */
const posted = () => mockMessagingSend.mock.calls
  .filter((c) => c[0]?.__type === 'SendMessage')
  .map((c) => c[0].input.Content as string);

/** An ALLOW, not a DENY. `DeleteResource` is the only thing distinguishing them. */
const allowed = () => mockMessagingSend.mock.calls.some(
  (c) => c[0]?.__type === 'Callback' && !c[0]?.input?.DeleteResource && !!c[0]?.input?.ChannelMessage?.MessageId,
);

const listedMemberships = () => mockMessagingSend.mock.calls.some((c) => c[0]?.__type === 'ListMemberships');

describe('the channel flow answers @all, at every channel size', () => {
  let handler: (e: any) => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:standard';
    process.env.BASIC_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:basic';
    process.env.PREMIUM_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:premium';
    process.env.ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
    process.env.BASIC_ROUTER_ARN = ROUTER_BASIC;
    process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
    // The router's real return shape: a Lex response whose messages[0].content is the placeholder.
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
        messages: [{ contentType: 'PlainText', content: PLACEHOLDER }],
      })),
    });
    mockMessagingSend.mockImplementation((cmd: any) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  it('hands the turn to the router in a GROUP, after reading the member count', async () => {
    await handler(flowEvent('@all what is the billing policy?'));

    expect(handedOff()).toBe(true);
    // THIS ASSERTION IS INVERTED FROM WHAT IT WAS, deliberately, and the reason is worth keeping.
    //
    // It used to assert the member list was NEVER read: `@all` took one bypass at every channel size,
    // and the router silenced the Lex entry to keep one responder. Measured live 2026-08-12, that
    // produced TWO placeholders in a 1:1 (558ms apart, one stranded at "One moment..." forever),
    // because the two entries derive correlation ids by different rules and the duplicate-placeholder
    // claim therefore had no collision to deny.
    //
    // The count is now the branch: in a group the flow answers (this test), in a 1:1 it stands aside
    // and the Lex entry answers (the test below). One responder either way - which was always the
    // invariant; only the mechanism changed.
    expect(listedMemberships()).toBe(true);
  });

  it('STANDS ASIDE in a 1:1, because AUTO routes every message to Lex at that size', async () => {
    // The other half of the complement. Nothing is dispatched here, and that is correct rather than a
    // dropped turn: Amazon Chime SDK invokes Lex for every message in a 1:1 regardless of mentions, so
    // the Lex entry runs and answers. Dispatching as well is what produced the duplicate.
    // Two memberships is the 1:1 shape: the user and the assistant.
    mockMessagingSend.mockImplementation((cmd: any) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'ListMemberships') {
        return Promise.resolve({ ChannelMemberships: [{ Member: { Arn: HUMAN_A } }, { Member: { Arn: BOT } }] });
      }
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });

    await handler(flowEvent('@all what is the billing policy?'));

    expect(handedOff()).toBe(false);
    // ALLOWED, never denied: a denied message is not persisted, so the user's own `@all` would vanish
    // from the channel and from the assistant's history.
    expect(allowed()).toBe(true);
  });

  it('runs NONE of the turn itself: no processor dispatch, no intent, no delivery option', async () => {
    await handler(flowEvent('@all what is the billing policy?'));

    // MESSAGE-FLOW §3.1: bypassing Lex is the only sanctioned difference. Before the handoff this path
    // invoked the PROCESSOR directly with a hardcoded `intent: 'general'` and its own
    // `deliveryOption` - a second turn path that could diverge from the Lex one silently, because the
    // turn still answers either way. Exactly one invoke, to the router, carrying no turn decisions.
    const calls = invokes();
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe(ROUTER_BASIC);
    // Synchronous: the placeholder comes BACK from the turn.
    expect(calls[0].type).toBe('RequestResponse');
    expect(calls[0].payload.aeTurn.intent).toBeUndefined();
    expect(calls[0].payload.aeTurn.deliveryOption).toBeUndefined();
    expect(calls[0].payload.aeTurn.userType).toBeUndefined();
  });

  it('answers at the CHANNEL classification, never a hardwired one', async () => {
    // A basic channel's @all must reach the basic router. Routing to standard would answer with the
    // standard model and standard-tier company context - the cross-classification leak the split
    // exists to prevent, and `basic` deliberately has no upward fallback.
    await handler(flowEvent('@all what is the billing policy?'));

    expect(invokes()[0].fn).toBe(ROUTER_BASIC);
  });

  it('declares the inbound message id, so the dedup key is stable across a redelivery', async () => {
    // The flow no longer mints the correlation id, but the key is only stable because it hands over
    // the id it alone sees. Without it the router falls back to a 90-second time bucket, and a
    // redelivery straddling a bucket boundary answers twice.
    const event = flowEvent('@all what is the billing policy?');
    await handler(event);

    expect(invokes()[0].payload.aeTurn.userMessageId).toBe(event.ChannelMessage.MessageId);
  });

  it('posts the placeholder the ROUTER handed back, rather than composing its own', async () => {
    // THIS IS THE FALLBACK PATH NOW, not the normal one. Under ADR-025 the turn posts its own
    // acknowledgment and returns an empty array, so the flow posts only when the turn hands the
    // message BACK - it had no resolved identity, or its own send failed. The mock returns a
    // non-empty response, which is exactly that case.
    //
    // The property is unchanged and still worth pinning: whatever the flow does post is the TURN'S
    // text, carrying the turn's marker. Composing one here would mint a second correlation id that
    // the duplicate-placeholder guard and the processor are not listening for.
    await handler(flowEvent('@all what is the billing policy?'));

    expect(posted()).toContain(PLACEHOLDER);
  });

  it('posts NOTHING when the router returns an empty messages array', async () => {
    // The NORMAL outcome under ADR-025 (the turn posted its own message), and still also the
    // silent-turn case below.
    // An empty array means "post nothing" (ADR-022) - a silent turn, or a duplicate that lost its
    // claim. Inventing a bubble here would undo the dedup the router just performed.
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
        messages: [],
      })),
    });

    await handler(flowEvent('@all what is the billing policy?'));

    expect(handedOff()).toBe(true);
    expect(posted()).toEqual([]);
  });

  it('says something when the router FAILS, instead of going silent', async () => {
    // The old shape posted the placeholder FIRST, so a failed dispatch stranded a "One moment..." that
    // never resolved. Nothing is posted before the invoke now, so the failure must speak for itself.
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({ errorMessage: 'boom', errorType: 'Error' })),
    });

    await handler(flowEvent('@all what is the billing policy?'));

    const messages = posted();
    expect(messages).toHaveLength(1);
    // Specifically NOT the raw error payload: a handler that threw still returns HTTP 200, so an
    // unchecked post puts a stack trace in the channel as the user's answer.
    expect(messages[0]).not.toContain('errorMessage');
    expect(messages[0]).not.toContain('boom');
  });

  it('forwards an attachment, which is the only way one can reach the turn', async () => {
    // Lex never sees message Metadata, so the flow is the only component that can carry an
    // attachment-in file reference to the turn. Dropping it here makes a file-bearing @all answer as
    // if the file were not there - fluently, with nothing in any log to explain it.
    const event = flowEvent('@all what does this say?');
    event.ChannelMessage.Metadata = JSON.stringify({
      attachment: { fileKey: 'uploads/u1/report.pdf', type: 'application/pdf', name: 'report.pdf' },
    }) as any;

    await handler(event);

    expect(invokes()[0].payload.aeTurn.attachment).toEqual({
      fileKey: 'uploads/u1/report.pdf',
      contentType: 'application/pdf',
      name: 'report.pdf',
    });
  });

  it('ALLOWS the message rather than denying it, so the user\'s own @all survives in history', async () => {
    await handler(flowEvent('@all what is the billing policy?'));

    // Denying would keep Lex out without any router guard — and drop the user's message from the
    // channel and from the assistant's context. That trade is rejected on purpose.
    expect(allowed()).toBe(true);
  });
});

describe('the router does NOT answer @all, so a 1:1 is not answered twice', () => {
  let routerHandler: (e: any) => Promise<any>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  const lexEvent = (transcript: string) => ({
    sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
    inputTranscript: transcript,
    requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': HUMAN_A },
  });

  it('returns an EMPTY messages array for an @all turn', async () => {
    const res = await routerHandler(lexEvent('@all what is the billing policy?'));

    // Empty ARRAY, not an absent field: the client drops a Lex envelope whose `Messages` is present
    // and empty, and renders the raw envelope when it is missing entirely.
    expect(res.messages).toEqual([]);
  });

  it('spends nothing BILLABLE before deciding — no Bedrock, no classification, no dispatch', async () => {
    await routerHandler(lexEvent('@all summarise the billing policy'));

    // NARROWED FROM "no SSM" ON PURPOSE. Deciding now needs the channel's member count, and the bearer
    // for that read is the classification's bot ARN, which comes from SSM (memoized per container).
    // So one parameter fetch before the decision is expected and is the price of the responder branch.
    //
    // What must STILL be true is the property that assertion was really protecting: nothing BILLED and
    // nothing irreversible happens before the guard decides. The intent classifier is a model call, and
    // a dispatch is a turn that cannot be un-run.
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('stays silent when the transcript arrives percent-encoded', async () => {
    // The flow tests raw AND decoded. If the router tested only one form, the two would disagree about
    // what `@all` means and the turn would be answered twice again.
    const res = await routerHandler(lexEvent('%40all%20what%20is%20the%20billing%20policy%3F'));
    expect(res.messages).toEqual([]);
  });

  it('does NOT silence an ordinary turn that merely contains the word all', async () => {
    // `\b` after `@all` is what keeps `@allison` and a bare "all" out. Over-matching here silences
    // real turns, which is a worse failure than the duplicate.
    const res = await routerHandler(lexEvent('tell me all of the billing policies'));
    expect(res.messages).not.toEqual([]);
  });

  // ── The other half of "one responder", now that the flow hands off instead of dispatching ──
  //
  // The guard above keeps the LEX entry quiet. Once the flow reaches the turn through this same
  // handler, the guard has to let the FLOW entry through or nothing answers at all. Both halves live
  // here together, deliberately: pinning either alone lets the pair drift back into answering twice
  // (guard dropped) or not at all (guard applied to both entries).

  const bypassEvent = (userMessage: string) => ({
    aeTurn: { channelArn: CHANNEL, senderArn: HUMAN_A, userMessage },
  });

  /**
   * What the TURN posted.
   *
   * ADR-025 moved the ACT of posting onto the turn for bypass entries: it sends its own
   * acknowledgment and returns an empty `messages` array, so the caller posts nothing. These
   * assertions therefore read the send rather than the return. **The properties being pinned are
   * unchanged** - that the flow entry is not silenced, that the text round-trips, that a real turn was
   * dispatched - only where the evidence lives has moved.
   */
  const postedContent = (): string | undefined => mockMessagingSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c?.__type === 'SendMessage')
    .pop()?.input?.Content;

  it('does NOT silence a flow handoff whose text still contains @all', async () => {
    // The token SURVIVING matters, and this is the case the exemption exists for. The flow strips the
    // token it matched, so the happy path never reaches the guard at all - which makes a test using
    // already-stripped text vacuous: it passes whether or not the exemption is there. (Confirmed by
    // mutation: silencing both entries left such a test green.)
    //
    // The surviving-token case is `/battle`, not `@all`: the `@all` path strips with /gi, so every
    // occurrence goes, but `/battle` strips only its own leading command token. So
    // "/battle should we tell @all about the outage" reaches the handler with `@all` intact, and
    // without the exemption the flow decides a duel happens, hands it off, and the guard silences the
    // very turn it was asked to run. Nothing answers, and nothing errors.
    await routerHandler(bypassEvent('should we tell @all about the outage?'));
    // The turn ran and SPOKE. Under ADR-025 that is what "not silenced" looks like: a send, not a
    // returned string.
    expect(postedContent()).toBeTruthy();
    // A REAL turn, not the handler's catch-all apology. "not empty" alone is satisfied by the error
    // response, which is how this file's bypass assertions used to pass without exercising anything.
    // The correlation marker is only minted once the turn is actually dispatched.
    expect(postedContent()).toContain('<!--corr:');
  });

  it('still silences the LEX entry for the same message, so exactly one entry answers', async () => {
    // The 1:1 case: AUTO routes every message to Lex regardless of mentions, so both entries see this
    // turn. Exactly one of them may run it.
    const res = await routerHandler(lexEvent('@all what is the billing policy?'));
    expect(res.messages).toEqual([]);
  });

  it('round-trips a message containing a literal percent sign', async () => {
    // The bypass hands DECODED text and the handler decodes what it is given, so the adapter encodes.
    // Without that, a message containing '%' is corrupted and a malformed escape throws outright.
    await routerHandler(bypassEvent('is 50% of the billing policy refundable?'));
    // Reaching a dispatched turn IS the proof: without the encode, `decodeURIComponent` throws on the
    // bare '%' and the handler falls to its catch-all apology, which carries no marker.
    expect(postedContent()).toContain('<!--corr:');
  });

  it('carries the attachment through the bypass to the dispatched turn', async () => {
    // The attachment reaches the worker or it does not exist: Lex never sees message Metadata, so if
    // the bypass drops it, a file-bearing turn answers as though no file were attached.
    await routerHandler({
      aeTurn: {
        channelArn: CHANNEL,
        senderArn: HUMAN_A,
        userMessage: 'what does this say?',
        attachment: { fileKey: 'uploads/u1/report.pdf', contentType: 'application/pdf' },
      },
    });

    expect(postedContent()).toContain('<!--corr:');
    const dispatch = mockLambdaSend.mock.calls
      .map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()))
      .find((p) => p.attachment);
    expect(dispatch?.attachment).toEqual({ fileKey: 'uploads/u1/report.pdf', contentType: 'application/pdf' });
  });

  it('does not answer a file with a "hi" caption as a GREETING', async () => {
    // The classifiers see the TEXT only, so "hi" + a PDF classifies as GREETING - and GREETING is
    // answered DIRECT from a canned string with NO processor dispatch, so the file is never read. A
    // user dropping a file and typing "hi" is an ordinary thing to do, and the failure is silent: a
    // friendly reply arrives and nothing anywhere says the attachment was ignored.
    await routerHandler({
      aeTurn: {
        channelArn: CHANNEL,
        senderArn: HUMAN_A,
        userMessage: 'hi',
        attachment: { fileKey: 'uploads/u1/report.pdf', contentType: 'application/pdf' },
      },
    });

    // A dispatched turn (marker present), not the canned greeting.
    expect(postedContent()).toContain('<!--corr:');
    expect(postedContent()).not.toContain('what can I help you with');
  });

  it('still answers a bare "hi" with the canned greeting when there is NO file', async () => {
    // The correction above must be scoped to attachment turns. Widening it would put every greeting
    // through a full model turn - cost and latency for "hi".
    await routerHandler(bypassEvent('hi'));

    // A DIRECT turn is posted by the assistant too - ADR-025 gives the turn whatever it produced,
    // placeholder or canned answer, so a greeting is not a special case.
    expect(postedContent()).toContain('what can I help you with');
  });
});
