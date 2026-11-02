/**
 * EDITING A MESSAGE DOES NOT START A TURN.
 *
 * Chime re-invokes the channel flow when a persistent message is UPDATED (ADR-022), and nothing in
 * the flow read `EventType` - so it could not tell an edit from a send and treated both alike.
 *
 * WHAT WAS ACTUALLY STOPPING AN EDITED `@all` FROM FANNING OUT AGAIN was not a rule about edits. The
 * bypass paths claim `flow-<MessageId>`, and `MessageId` is stable across an edit, so a re-invoke
 * read as a duplicate delivery - but only for as long as that claim lives, and it is sized for
 * redelivery bursts (DEDUP_TTL_SECONDS = 300) rather than for a person changing their mind. Edit an
 * `@all` six minutes after sending it and the flow fanned the turn out again, on the edited text,
 * under a new correlation, with nothing recording that it was an edit.
 *
 * These assertions are about the RULE, not the TTL: an edit starts no turn at any age, and the
 * message is still allowed through so the person's edit lands in the channel.
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

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';
const HUMAN_A = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/alice';
const HUMAN_B = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/bob';
const ROUTER_BASIC = 'arn:aws:lambda:us-east-1:111122223333:function:router-basic';

function flowEvent(content: string, eventType: string) {
  return {
    CallbackId: 'cb-1',
    EventType: eventType,
    ChannelMessage: {
      MessageId: 'm-stable-across-the-edit',
      Content: content,
      Metadata: undefined,
      Sender: { Arn: HUMAN_A, Name: 'Alice' },
      ChannelArn: CHANNEL,
    },
  };
}

/** Any Lambda the flow invoked - a router hand-off or a processor dispatch. */
const dispatched = () => mockLambdaSend.mock.calls.some((c) => c[0]?.__type === 'Invoke');

/** An ALLOW, not a DENY: `DeleteResource` is what distinguishes them. */
const allowed = () => mockMessagingSend.mock.calls.some(
  (c) => c[0]?.__type === 'Callback' && !c[0]?.input?.DeleteResource && !!c[0]?.input?.ChannelMessage?.MessageId,
);

describe('an edited message starts no turn', () => {
  let handler: (e: any) => Promise<void>;

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
        messages: [{ contentType: 'PlainText', content: 'One moment... <!--corr:x-->' }],
      })),
    });
    mockMessagingSend.mockImplementation((cmd: any) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      // A GROUP, which is the size at which `@all` takes the bypass at all. Without this the tests
      // below would pass for the wrong reason: a 1:1 stands aside regardless of the event type.
      if (cmd.__type === 'ListMemberships') {
        return Promise.resolve({
          ChannelMemberships: [
            { Member: { Arn: HUMAN_A } },
            { Member: { Arn: BOT } },
            { Member: { Arn: HUMAN_B } },
          ],
        });
      }
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  it('a SENT @all in a group still fans out - the control', async () => {
    // Non-vacuity. Without this the guard could deny everything and the tests below would pass.
    await handler(flowEvent('@all what is the billing policy?', 'CREATE_CHANNEL_MESSAGE'));
    expect(dispatched()).toBe(true);
  });

  it('an EDITED @all does not, however long after it was sent', async () => {
    // No dedup claim is consulted, so this holds past the 300s window that used to be the only
    // thing standing between an edit and a second fan-out.
    await handler(flowEvent('@all what is the billing policy, revised?', 'UPDATE_CHANNEL_MESSAGE'));
    expect(dispatched()).toBe(false);
  });

  it('an edited /battle does not either', async () => {
    await handler(flowEvent('/battle which plan is better, revised?', 'UPDATE_CHANNEL_MESSAGE'));
    expect(dispatched()).toBe(false);
  });

  it('the edit is still ALLOWED through, so it lands in the channel', async () => {
    // Returning without a callback leaves Chime holding the message until the flow times out, and
    // FallbackAction: CONTINUE then delivers it UNPROCESSED - past the mention rules and the marker
    // stripping this flow exists to apply.
    await handler(flowEvent('@all revised', 'UPDATE_CHANNEL_MESSAGE'));
    expect(allowed()).toBe(true);
  });

  it('a redaction and a deletion start no turn either', async () => {
    await handler(flowEvent('@all gone', 'REDACT_CHANNEL_MESSAGE'));
    await handler(flowEvent('@all gone', 'DELETE_CHANNEL_MESSAGE'));
    expect(dispatched()).toBe(false);
  });

  it('an unfamiliar event type behaves exactly as before, rather than standing every turn down', async () => {
    // FAIL-OPEN, and the directions are not symmetric: a wrong guess that PROCESSES costs one
    // unwanted turn; a wrong guess that SKIPS costs every turn on the deployment. The existing
    // fixtures in this suite send 'CHANNEL_MESSAGE', which is exactly this case.
    await handler(flowEvent('@all what is the billing policy?', 'CHANNEL_MESSAGE'));
    expect(dispatched()).toBe(true);
  });
});
