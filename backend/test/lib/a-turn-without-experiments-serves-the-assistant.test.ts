/**
 * A DEPLOYMENT WITHOUT `experiments` STILL ANSWERS, AND READS NO EXPERIMENTS TABLE.
 *
 * Experiments are a declared capability (`lib/config/capabilities.ts`). Without it there is no
 * Experiments stack, and the assistant stack is built with no experiments grant and no
 * `EXPERIMENTS_TABLE` (`AssistantsStack`, `props.experiments`). So the router learns at synth, from its
 * environment, that no experiment can arm: it resolves none, scans nothing, and dispatches the turn to
 * the classification's processor on the assistant's active version.
 *
 * The same turn with the table declared scans it, which is what makes the first case mean something.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/abuse-controls.js'),
  evaluateAbuseGate: async () => ({ allowed: true }),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
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
// Every DynamoDB call the turn makes, through the document client or the plain one, reaches this.
jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  actual.DynamoDBClient.prototype.send = (...args: unknown[]) => mockDdbSend(...args);
  return actual;
});
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  actual.DynamoDBDocumentClient.prototype.send = (...args: unknown[]) => mockDdbSend(...args);
  return actual;
});

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_SELF = `${APP}/bot/premium-bot`;
const HUMAN = `${APP}/user/alice`;
const PROCESSOR = 'arn:aws:lambda:us-east-1:111122223333:function:PremiumAsyncProcessor';
const EXPERIMENTS = 'agent-echelon-experiments-test';

const ROUTER_ENV: Record<string, string | undefined> = {
  AWS_LAMBDA_FUNCTION_NAME: 'AgentEchelonAssistants-premium-AgentHandler',
  CLASSIFICATION: 'premium',
  PREMIUM_ASYNC_PROCESSOR_ARN: PROCESSOR,
  ABUSE_CONTROLS_TABLE: undefined,
  ENABLE_LIVE_DRIFT: undefined,
  TURN_QUEUE_ENABLED: undefined,
  EXPERIMENTS_TABLE: undefined,
};

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const lexTurn = (userMessage: string) => ({
  inputTranscript: userMessage,
  sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
  requestAttributes: {
    'CHIME.channel.arn': CHANNEL,
    'CHIME.sender.arn': HUMAN,
    'x-amz-lex:channels:platform': 'Chime',
    'AE.message.id': 'm-the-question',
  } as Record<string, string>,
});

/** The tables the turn scanned. */
const scannedTables = (): string[] => mockDdbSend.mock.calls
  .map(([cmd]) => cmd as { constructor?: { name?: string }; input?: { TableName?: string } })
  .filter((cmd) => cmd?.constructor?.name === 'ScanCommand')
  .map((cmd) => String(cmd.input?.TableName));

/** Whether the turn was handed to the classification's processor. */
const dispatchedToTheProcessor = (): boolean => mockLambdaSend.mock.calls
  .some(([cmd]) => (cmd as { input?: { FunctionName?: string } })?.input?.FunctionName === PROCESSOR);

describe('a turn on a deployment that does not declare experiments', () => {
  const envBefore: Record<string, string | undefined> = {};
  beforeAll(() => { for (const key of Object.keys(ROUTER_ENV)) envBefore[key] = process.env[key]; });
  afterAll(() => applyEnv(envBefore));

  async function runTurn(env: Record<string, string | undefined>): Promise<void> {
    jest.resetModules();
    jest.clearAllMocks();
    applyEnv({ ...ROUTER_ENV, ...env });
    // The processor's published ARN, and this assistant's bot for every other parameter the turn reads.
    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => ({
      Parameter: { Value: String(cmd?.input?.Name ?? '').endsWith('/processor-arn') ? PROCESSOR : BOT_SELF },
    }));
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
    mockDdbSend.mockResolvedValue({ Items: [] });
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      if (cmd?.__type === 'ListMessages') return { ChannelMessages: [] };
      return { MessageId: 'sent-1' };
    });
    const { handler } = await import('../../lambda/src/router-agent-handler.js');
    await handler(lexTurn('What was our Q2 ARR?') as never);
  }

  it('dispatches the turn to the processor and scans no experiments table', async () => {
    await runTurn({});
    expect(dispatchedToTheProcessor()).toBe(true);
    expect(scannedTables()).toEqual([]);
  });

  it('scans the experiments table when the deployment declares experiments (the case above is not vacuous)', async () => {
    await runTurn({ EXPERIMENTS_TABLE: EXPERIMENTS });
    expect(dispatchedToTheProcessor()).toBe(true);
    expect(scannedTables()).toContain(EXPERIMENTS);
  });
});
