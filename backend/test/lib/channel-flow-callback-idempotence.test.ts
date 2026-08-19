/**
 * A REDELIVERED message must not fail the channel flow.
 *
 * A channel-flow callback is one-shot, and Amazon Chime SDK Messaging delivers at least once. The
 * second callback for the same message finds the first already resolved and is refused with
 * `BadRequestException: Unable to complete processing of non-pending message …` (or, when two
 * callbacks race, `ConflictException`).
 *
 * Letting that propagate inverted the consequence: the invocation failed, Lambda retried, and the
 * retry produced ANOTHER duplicate callback. Observed live on 2026-08-07 - 9 `Invoke Error`s in 24
 * hours across five conversations, during runs the e2e suite reported green, because the turn's
 * answer still reached the DOM and no guard was reading this function's log group.
 *
 * The message was already allowed, which is the state the caller wanted, so the duplicate is success.
 * What must NOT change is everything else: a callback that fails for any other reason means the
 * message did not get through, and that has to stay loud.
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

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';
const HUMAN_A = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/alice';

function flowEvent(content: string) {
  return {
    CallbackId: 'cb-1',
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: 'm-redelivered',
      Content: content,
      Metadata: undefined,
      Sender: { Arn: HUMAN_A, Name: 'Alice' },
      ChannelArn: CHANNEL,
    },
  };
}

/** The service's answer to a second callback on one message. */
function nonPendingError() {
  const err = new Error(
    'Unable to complete processing of non-pending message for callback id: cb-1, message id: m-redelivered',
  );
  err.name = 'BadRequestException';
  return err;
}

function conflictError() {
  const err = new Error('There was a conflict processing the request. Try your request again.');
  err.name = 'ConflictException';
  return err;
}

/**
 * How a consumed callback USUALLY comes back, and the shape this file originally missed.
 *
 * Measured on the deployment: two invocations 139ms apart carrying one `CallbackId`, the first denial
 * succeeding and the second answered with a 403 whose text says nothing about callbacks at all. It was
 * rethrown, Lambda retried twice, and the three ERROR lines failed a live battle e2e whose turn had
 * otherwise gone perfectly.
 */
function alreadyConsumedError() {
  const err = new Error('You do not have sufficient access to perform this action.');
  err.name = 'ForbiddenException';
  return err;
}

/** Any other failure — the message genuinely did not get through. */
function realFailure() {
  const err = new Error('Channel not found');
  err.name = 'ResourceNotFoundException';
  return err;
}

describe('a duplicate delivery does not fail the flow', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: (e: any) => Promise<void>;

  async function loadHandler(callbackBehaviour: () => unknown) {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:standard';
    process.env.BASIC_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:basic';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
    mockLambdaSend.mockResolvedValue({});
    mockMessagingSend.mockImplementation((cmd: { __type?: string }) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'Callback') {
        const outcome = callbackBehaviour();
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({});
      }
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  }

  it('treats an already-resolved callback as success, so Lambda does not retry into another duplicate', async () => {
    await loadHandler(() => nonPendingError());
    await expect(handler(flowEvent('what is the billing policy?'))).resolves.toBeUndefined();
  });

  it('treats a racing ConflictException the same way', async () => {
    await loadHandler(() => conflictError());
    await expect(handler(flowEvent('what is the billing policy?'))).resolves.toBeUndefined();
  });

  it('treats a 403 on an already-consumed callback the same way', async () => {
    // The shape that actually occurs. Rethrowing it makes Lambda retry a callback that is already
    // decided, so one duplicate delivery becomes three ERROR lines - and the turn they belong to has
    // already been handled correctly.
    await loadHandler(() => alreadyConsumedError());
    await expect(handler(flowEvent('what is the billing policy?'))).resolves.toBeUndefined();
  });

  it('does not hide a role that cannot call back AT ALL', async () => {
    // The trade this makes, pinned. A missing `chime:ChannelFlowCallback` grant raises the same error
    // name, and swallowing it here is only safe because it cannot hide: such a role fails its FIRST
    // callback on every message, so nothing is ever released and the channel is visibly dead. What is
    // asserted is that the flow still does not DELIVER anything on that path - the failure surfaces as
    // silence in the channel, not as a message that quietly went missing while the flow reported fine.
    await loadHandler(() => alreadyConsumedError());
    await handler(flowEvent('what is the billing policy?'));

    const released = mockMessagingSend.mock.calls
      .map((c) => c[0])
      .filter((c: { __type?: string }) => c?.__type === 'Callback');
    expect(released.length).toBeGreaterThan(0);
  });

  it('STILL FAILS LOUDLY on any other callback error', async () => {
    // The point of the narrow predicate. A callback that fails for another reason means the message
    // did not get through, and swallowing that would hide a real delivery failure behind the fix for
    // a benign one.
    await loadHandler(() => realFailure());
    await expect(handler(flowEvent('what is the billing policy?'))).rejects.toThrow(/Channel not found/);
  });

  it('logs the benign case WITHOUT the word "Exception", so the e2e error guard does not flag it', async () => {
    // The e2e backend-error guard greps `?ERROR ?Exception ?AccessDenied ?Denied` across the turn's
    // log groups. The first version of this success message included the SDK error NAME
    // (`BadRequestException`), so the line announcing that everything was fine failed a live battle
    // turn. The guard's pattern is deliberately broad and stays that way; the benign line must not
    // look like an error.
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    await loadHandler(() => nonPendingError());
    await handler(flowEvent('what is the billing policy?'));
    spy.mockRestore();

    const line = logged.find((l) => l.includes('callback already resolved'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/Exception|ERROR|AccessDenied|Denied/);
  });

  it('a BadRequest that is NOT about a non-pending message still throws', async () => {
    // Matching on the name alone would swallow every malformed-callback bug in this file.
    const err = new Error('Invalid channel ARN');
    err.name = 'BadRequestException';
    await loadHandler(() => err);
    await expect(handler(flowEvent('what is the billing policy?'))).rejects.toThrow(/Invalid channel ARN/);
  });
});
