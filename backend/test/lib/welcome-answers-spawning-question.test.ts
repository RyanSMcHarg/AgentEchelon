/**
 * A drift-spawned conversation ANSWERS the question that started it — the person does not retype it.
 *
 * THE DEFECT. The welcome quoted their words ("You asked: > …") and then answered nothing: it was a
 * terminal Lex message, no `<!--corr:-->` marker and no processor dispatch. The quote made it look
 * like the assistant had the question, so retyping it felt like being ignored.
 *
 * THE SHAPE. The welcome IS the placeholder — the same placeholder→update flow every other turn uses.
 * It carries the marker, the processor resolves it and updates it in place, and `messagePrefix` keeps
 * the welcome text above the answer (a plain update REPLACES content, which would throw away the
 * orientation copy — company, access line, example prompts — to show the answer).
 *
 * ONLY for a spawned conversation: `priorMessage` is written solely by the drift creation path, so an
 * ordinary new conversation must keep a plain, unmarked welcome and dispatch nothing. That negative is
 * asserted too — a marker on every welcome would leave an unresolvable correlation on every new
 * conversation in the deployment.
 */
const mockChimeSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();
const mockGetChannelContext = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  DescribeChannelCommand: jest.fn().mockImplementation((i) => ({ __t: 'DescribeChannel', i })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((i) => ({ __t: 'ListTags', i })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((i) => ({ __t: 'ListMemberships', i })),
  SendChannelMessageCommand: jest.fn().mockImplementation((i) => ({ __t: 'SendMessage', i })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((i) => ({ __t: 'Invoke', i })),
  InvocationType: { Event: 'Event' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((i) => ({ __t: 'GetParam', i })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client.js', () => ({
  getChannelContext: (...a: unknown[]) => mockGetChannelContext(...a),
  getParticipantContext: jest.fn().mockResolvedValue(null),
  putChannelContext: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/a/channel/c1';
const SENDER = 'arn:aws:chime:us-east-1:111:app-instance/a/user/alice';
const QUESTION = 'why did our CI bill double last month?';

type Handler = (e: unknown) => Promise<{ messages: Array<{ content: string }> }>;
let handler: Handler;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111:app-instance/a';
  process.env.ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111:function:standard';
  mockSsmSend.mockResolvedValue({ Parameter: { Value: 'arn:bot' } });
  mockChimeSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});
  ({ handler } = (await import('../../lambda/src/router-agent-handler.js')) as unknown as { handler: Handler });
});

/** A Chime WelcomeIntent: no inputTranscript. */
const welcomeEvent = () => ({
  sessionState: { intent: { name: 'WelcomeIntent' }, sessionAttributes: {} },
  requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': SENDER },
});

const invokePayload = () => {
  const call = mockLambdaSend.mock.calls.find((c) => (c[0] as { __t: string }).__t === 'Invoke');
  if (!call) return null;
  return JSON.parse(Buffer.from((call[0] as { i: { Payload: Uint8Array } }).i.Payload).toString());
};

describe('a spawned conversation', () => {
  beforeEach(() => {
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL, priorSubject: 'CI cost', priorMessage: QUESTION,
    });
  });

  it('dispatches the processor with the ORIGINAL question, so it is answered unprompted', async () => {
    await handler(welcomeEvent());
    const payload = invokePayload();
    expect(payload).not.toBeNull();
    expect(payload.userMessage).toBe(QUESTION);
  });

  it('keeps the welcome above the answer via messagePrefix', async () => {
    await handler(welcomeEvent());
    const payload = invokePayload();
    // Without this the update REPLACES the welcome, discarding the orientation copy to show the answer.
    expect(typeof payload.messagePrefix).toBe('string');
    expect(payload.messagePrefix.length).toBeGreaterThan(0);
  });

  it('returns a welcome carrying the marker, and the SAME id it dispatched', async () => {
    const res = await handler(welcomeEvent());
    const content = res.messages[0].content;
    const marker = /<!--corr:([A-Za-z0-9._-]+)-->/.exec(content);
    expect(marker).not.toBeNull();
    // A marker that does not match the dispatch resolves nothing and strands the turn.
    expect(marker![1]).toBe(invokePayload().correlationId);
    // The welcome copy still has to be there — this message IS the welcome, not a bare placeholder.
    expect(content.replace(marker![0], '').trim().length).toBeGreaterThan(0);
  });
});

describe('an ordinary new conversation', () => {
  it('gets a plain unmarked welcome and dispatches nothing', async () => {
    mockGetChannelContext.mockResolvedValue(null); // no priorMessage ⇒ not drift-spawned
    const res = await handler(welcomeEvent());
    expect(res.messages[0].content).not.toMatch(/<!--corr:/);
    expect(invokePayload()).toBeNull();
  });
});
