/**
 * A REDELIVERED bypass message is recognised ACROSS CONTAINERS.
 *
 * Amazon Chime SDK invokes a channel flow asynchronously, and async Lambda invocation is at-least-once.
 * A redelivery is therefore a SEPARATE invocation, usually on a separate container, and the two can
 * overlap - measured on the deployment as two invocations 139ms apart with different Lambda request
 * ids carrying one `MessageId` and one `CallbackId`.
 *
 * THE DEFECT THIS PINS. The guard was a module-scope `Set`, so it lived in one container's memory.
 * Both attempts read an empty set, both believed they were the first, and the duplicate did its work
 * again. It was named "idempotency gate" throughout, which is what kept anyone from looking: a dedup
 * that lives in a process is a same-container optimisation wearing the label of a control.
 *
 * The fix is the control the rest of the codebase already uses for at-least-once delivery
 * (`lib/correlation.ts`, SPEC-ABUSE-CONTROLS, ADR-022): a key a redelivery provably replays, claimed
 * with a conditional write. So this file exercises TWO module instances, because one instance cannot
 * fail the way production did.
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

/**
 * The dedup store, DURABLE across the two module instances below - which is the whole point. It stands
 * outside the mock factory so a `resetModules` cannot clear it, exactly as DynamoDB does not forget
 * when a container recycles.
 */
const claimed = new Set<string>();
let claimShouldFail = false;

jest.mock('../../lambda/src/lib/abuse-controls.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/abuse-controls.js');
  return {
    ...actual,
    // Fails OPEN, like the real one: an unavailable table degrades to a duplicate, never to a dropped
    // turn.
    claimCorrelation: async (key: string) => {
      if (claimShouldFail) return true;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    claimPlaceholderMapping: async () => true,
    evaluateAbuseGate: async () => ({ allowed: true }),
  };
}, { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';
const HUMAN = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/alice';
const HUMAN_B = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/bob';
/** Replayed VERBATIM on a redelivery, which is what makes it a usable dedup key. */
const MESSAGE_ID = 'm-redelivered-1';

/** An `@all`, because a bypass is where a duplicate costs a model call rather than a wasted read. */
function flowEvent() {
  return {
    CallbackId: 'cb-1',
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: MESSAGE_ID,
      Content: '@all what is the billing policy?',
      Sender: { Arn: HUMAN, Name: 'Alice' },
      ChannelArn: CHANNEL,
    },
  };
}

/**
 * A FRESH module instance: a cold container, with its own module scope. Loading the handler twice is
 * what reproduces the production shape - the old in-memory guard passes trivially against one.
 */
async function coldContainer() {
  jest.resetModules();
  process.env.ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:standard';
  process.env.BASIC_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:basic';
  process.env.ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router';
  process.env.BASIC_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-basic';
  mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
  mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
  mockMessagingSend.mockImplementation((cmd: { __type?: string }) => {
    if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
    if (cmd.__type === 'ListMemberships') {
      // TWO humans. The flow stands aside for a 1:1 `@all` (MESSAGE-FLOW section 3.1), so a
      // single-human roster would make every assertion below pass against a bypass that never ran.
      return Promise.resolve({
        ChannelMemberships: [{ Member: { Arn: HUMAN } }, { Member: { Arn: HUMAN_B } }, { Member: { Arn: BOT } }],
      });
    }
    return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
  });
  const mod = await import('../../lambda/src/channel-flow-processor.js');
  return mod.handler as (e: unknown) => Promise<void>;
}

/** Router/processor invocations, which is where a duplicate actually costs something. */
const dispatches = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c: { __type?: string }) => c?.__type === 'Invoke');

beforeEach(() => {
  jest.clearAllMocks();
  claimed.clear();
  claimShouldFail = false;
});

describe('a redelivery on a DIFFERENT container is still a duplicate', () => {
  it('dispatches the turn once across two cold containers', async () => {
    const first = await coldContainer();
    await first(flowEvent());
    const dispatchedByWinner = dispatches().length;
    expect(dispatchedByWinner).toBeGreaterThan(0);

    // The redelivery, on a container that has never seen this message.
    const second = await coldContainer();
    await second(flowEvent());

    // The claim is what stops it, and nothing in the second container's memory could have.
    expect(dispatches().length).toBe(dispatchedByWinner);
  });

  it('still resolves the callback on the duplicate', async () => {
    // The claim records that the MESSAGE was handled, not that its CALLBACK was resolved. A winner
    // that died between the two would otherwise leave Chime holding the message until it times out,
    // and `FallbackAction: CONTINUE` then delivers it UNPROCESSED - past the mention rules and marker
    // stripping this flow exists to apply. So the loser calls back anyway.
    const first = await coldContainer();
    await first(flowEvent());

    mockMessagingSend.mockClear();
    const second = await coldContainer();
    await second(flowEvent());

    const callbacks = mockMessagingSend.mock.calls
      .map((c) => c[0])
      .filter((c: { __type?: string }) => c?.__type === 'Callback');
    expect(callbacks).toHaveLength(1);
  });

  it('FAILS OPEN when the dedup store is unavailable', async () => {
    // The direction the degrade has to run. An unreachable table must cost a duplicate, never a turn:
    // a user whose message is silently dropped has no way to tell, and no way to retry into a
    // different outcome.
    claimShouldFail = true;

    const first = await coldContainer();
    await first(flowEvent());
    const second = await coldContainer();
    await second(flowEvent());

    expect(dispatches().length).toBeGreaterThan(1);
  });

  it('does not collapse two DIFFERENT messages', async () => {
    // The key has to separate turns as well as join a redelivery to its original. Keyed on something
    // constant, every message after the first in a conversation would vanish.
    const first = await coldContainer();
    await first(flowEvent());
    const before = dispatches().length;

    const second = await coldContainer();
    await second({ ...flowEvent(), ChannelMessage: { ...flowEvent().ChannelMessage, MessageId: 'm-different' } });

    expect(dispatches().length).toBeGreaterThan(before);
  });
});
