/**
 * THE EMPTY LEX ENVELOPE IS DROPPED AT THE FLOW, so no client has to know it exists.
 *
 * Chime materialises a channel message from a bot's Lex fulfillment even when that fulfillment
 * returned `messages: []`, and the flow IS invoked for it - verified live 2026-08-06 with the
 * MessageId. So the flow can see the non-message and deny it, which is the one exclusive power it has.
 *
 * What this file pins is the pair: the empty envelope is DENIED, and everything else a bot sends is
 * still ALLOWED. The second half is the one that matters - a structural test that is too eager
 * destroys user-visible answers.
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
  InvocationType: { Event: 'Event' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/intent-classifier.js', () => ({
  classifyIntent: jest.fn().mockResolvedValue({ intent: 'general', confidence: 'high' }),
}), { virtual: true });

// The placeholder claim is a real DynamoDB write. Mocked so a message CARRYING a `corr` marker can be
// driven through the branch at all - the un-mocked call would fail on credentials and hide the
// behaviour under test. Returns "you own it", the non-duplicate case.
const mockClaimPlaceholderMapping = jest.fn();
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  claimPlaceholderMapping: (corr: string, messageId: string) =>
    mockClaimPlaceholderMapping(corr, messageId),
  // The flow's other import from this module. Not exercised here (bot messages never reach the gate),
  // but the mock replaces the WHOLE module, so an absent export is a load-time failure.
  evaluateAbuseGate: jest.fn().mockResolvedValue({ allowed: true }),
}), { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: (e: any) => Promise<void>;

function botMessage(content: string, messageId = 'm-1') {
  return {
    CallbackId: 'cb-1',
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: messageId,
      Content: content,
      Metadata: undefined,
      Sender: { Arn: BOT, Name: 'Assistant-basic' },
      ChannelArn: CHANNEL,
    },
  };
}

/** The callbacks the flow issued, as {kind, messageId}. */
function callbacks(): Array<{ denied: boolean; messageId: string }> {
  return mockMessagingSend.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd: { __type?: string }) => cmd.__type === 'Callback')
    .map((cmd: { input: { DeleteResource?: boolean; ChannelMessage?: { MessageId: string } } }) => ({
      denied: cmd.input.DeleteResource === true,
      messageId: cmd.input.ChannelMessage?.MessageId ?? '',
    }));
}

/** What the flow told Amazon Chime SDK to STORE for this message. */
function storedContent(): string | undefined {
  const cb = mockMessagingSend.mock.calls
    .map(([cmd]) => cmd)
    .find((cmd: { __type?: string }) => cmd.__type === 'Callback');
  return cb?.input?.ChannelMessage?.Content;
}

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:standard';
  process.env.BASIC_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:basic';
  mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
  mockLambdaSend.mockResolvedValue({});
  // "you own the correlation" - the ordinary, non-duplicate case.
  mockClaimPlaceholderMapping.mockImplementation((_corr: string, messageId: string) => messageId);
  mockMessagingSend.mockImplementation((cmd: { __type?: string }) => {
    if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
    return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
  });
  ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
});

describe('the flow denies an empty Lex envelope', () => {
  it('DENIES it, so it is never persisted', async () => {
    await handler(botMessage('{"Messages":[]}'));
    expect(callbacks()).toEqual([{ denied: true, messageId: 'm-1' }]);
  });

  it('DENIES it percent-encoded', async () => {
    await handler(botMessage(encodeURIComponent('{"Messages":[]}')));
    expect(callbacks()).toEqual([{ denied: true, messageId: 'm-1' }]);
  });

  it('drops it BEFORE any I/O, so it consumes no correlation claim and no notify fan-out', async () => {
    // The loop guard's rule, for the same reason: a message on its way to being dropped must not have
    // side effects. Nothing but the DENY callback itself may be sent.
    //
    // The deny is asserted here too, and deliberately. Without it this test passes when the guard is
    // neutered - an ALLOWED bot message also sends exactly one callback and invokes no Lambda - so it
    // would have been a guard that cannot fail on the condition it claims to catch. Proven by
    // neutering the detector: this case failed only once the deny was part of the assertion.
    await handler(botMessage('{"Messages":[]}'));
    const kinds = mockMessagingSend.mock.calls.map(([cmd]) => cmd.__type);
    expect(kinds).toEqual(['Callback']);
    expect(callbacks()).toEqual([{ denied: true, messageId: 'm-1' }]);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('logs it clear of the words the e2e backend-error guard greps', async () => {
    // This fires on every silently-fulfilled turn. If the line looked like an error it would fail
    // every run - the exact trap `channel-flow-callback-idempotence` documents.
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    await handler(botMessage('{"Messages":[]}'));
    spy.mockRestore();

    const line = logged.find((l) => l.includes('empty Lex envelope'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/ERROR|Exception|AccessDenied|Denied/);
  });
});

describe('a CARRYING envelope is stored as its text, not the wrapper', () => {
  it('rewrites the welcome to the text a human reads', async () => {
    const welcome = JSON.stringify({
      Messages: [{ Content: "Hi - I'm your assistant at Stratum.", ContentType: 'PlainText' }],
    });
    await handler(botMessage(welcome));
    expect(callbacks()).toEqual([{ denied: false, messageId: 'm-1' }]);
    expect(storedContent()).toBe("Hi - I'm your assistant at Stratum.");
  });

  it('STILL TAKES THE DUPLICATE-PLACEHOLDER CLAIM on a wrapped placeholder', async () => {
    // The regression this pins is one this change introduced and then fixed: unwrapping and returning
    // straight to the callback skipped the claim below - and the Lex-materialised placeholder is
    // itself a carrying envelope, so ADR-022's one-placeholder-per-turn enforcement would have been
    // disabled for exactly the message it protects. The marker must survive into the stored content
    // AND the claim must still run.
    const placeholder = JSON.stringify({
      Messages: [{ Content: 'One moment... <!--corr:abc123-->', ContentType: 'PlainText' }],
    });
    await handler(botMessage(placeholder));
    expect(storedContent()).toBe('One moment... <!--corr:abc123-->');
    expect(mockClaimPlaceholderMapping).toHaveBeenCalledWith('abc123', 'm-1');
  });

  it('leaves an ordinary answer completely untouched', async () => {
    await handler(botMessage('The answer is 4.'));
    expect(storedContent()).toBe('The answer is 4.');
  });
});

describe('and it denies NOTHING else', () => {
  it('ALLOWS the placeholder Chime materialises from a carrying fulfillment', async () => {
    // The turn itself arrives this way. Denying it would drop the answer.
    const placeholder = JSON.stringify({
      Messages: [{ Content: 'One moment...', ContentType: 'PlainText' }],
    });
    await handler(botMessage(placeholder));
    expect(callbacks()).toEqual([{ denied: false, messageId: 'm-1' }]);
  });

  it('ALLOWS an assistant answer that quotes the empty shape in a fenced block', async () => {
    await handler(botMessage('A silent fulfillment is:\n\n```json\n{"Messages":[]}\n```'));
    expect(callbacks()).toEqual([{ denied: false, messageId: 'm-1' }]);
  });

  it('ALLOWS a JSON answer that merely has an empty Messages field', async () => {
    await handler(botMessage('{"Messages":[],"Count":0}'));
    expect(callbacks()).toEqual([{ denied: false, messageId: 'm-1' }]);
  });

  it('ALLOWS an ordinary bot answer', async () => {
    await handler(botMessage('The answer is 4.'));
    expect(callbacks()).toEqual([{ denied: false, messageId: 'm-1' }]);
  });
});
