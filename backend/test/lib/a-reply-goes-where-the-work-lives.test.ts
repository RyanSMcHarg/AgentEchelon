/**
 * A REPLY GOES WHERE THE WORK LIVES.
 *
 *  - Shared work, public message: the answer is the public reply, and nothing else is sent.
 *  - A private message: the answer is the private reply.
 *  - Private work: its details go only in messages targeted at the person. From a public message the
 *    answer is posted to them privately, and the public placeholder says only that.
 *
 * Driven through `finalizePlaceholderResponse` with Amazon Chime SDK stubbed, so what is asserted is
 * what each message would actually say and who could read it.
 */
const mockMessagingSend = jest.fn();
const mockMarkBotWaitingForUser = jest.fn();
const mockWriteMessageAnalytics = jest.fn();
/**
 * How many messages had been PUBLISHED (sent or updated) when the analytics row was written. Pins the
 * ORDER, not a line. Counts mutations only: the turn reads the placeholder first to learn how it was
 * targeted, and a read publishes nothing archival could race.
 */
let publishesAtAnalyticsWrite: number | null = null;

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  GetChannelMessageCommand: class {
    __type = 'Get';
    constructor(public input: Record<string, unknown>) {}
  },
  UpdateChannelMessageCommand: class {
    __type = 'Update';
    constructor(public input: Record<string, unknown>) {}
  },
  SendChannelMessageCommand: class {
    __type = 'Send';
    constructor(public input: Record<string, unknown>) {}
  },
  ListChannelMessagesCommand: class {
    __type = 'List';
    constructor(public input: Record<string, unknown>) {}
  },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
  ChannelMessageType: { STANDARD: 'STANDARD' },
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
  ApplyGuardrailCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  QueryCommand: jest.fn(),
  ScanCommand: jest.fn(),
  DeleteCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));

// The battle row is state this turn writes, not behavior it decides, so it is stubbed and asserted on.
jest.mock('../../lambda/src/lib/battle-state', () => ({
  markBotWaitingForUser: (...args: unknown[]) => mockMarkBotWaitingForUser(...args),
  getBotRow: jest.fn().mockResolvedValue(null),
  computeActiveResponseMs: () => 0,
  transitionBotState: jest.fn(),
  readBattleRows: jest.fn().mockResolvedValue([]),
  allBotsTerminal: jest.fn(() => false),
}));

jest.mock('../../lambda/src/lib/message-analytics', () => ({
  writeMessageAnalytics: (...args: unknown[]) => mockWriteMessageAnalytics(...args),
  messageAnalyticsEnabled: () => false,
}));

import { finalizePlaceholderResponse } from '../../lambda/src/lib/async-processor-core';
import { planResumedChainDelivery, ANSWERED_PRIVATELY } from '../../lambda/src/lib/resumed-chain-delivery';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';
const USER = 'arn:aws:chime:us-east-1:111:app-instance/user/u1';
const PLACEHOLDER = 'placeholder-msg';
const NEW_MESSAGE = 'new-msg';
const ANSWER = 'The payroll correction for your account is scheduled for Friday.';

interface FakeCommand { __type: string; input: Record<string, unknown> }
const calls = (type: string): FakeCommand[] =>
  mockMessagingSend.mock.calls.map((c) => c[0] as FakeCommand).filter((c) => c?.__type === type);
const writtenTo = (id: string): string | undefined => {
  const u = calls('Update').filter((c) => c.input.MessageId === id).pop();
  return u ? decodeURIComponent(u.input.Content as string) : undefined;
};

function stubChime(placeholderTarget: Array<{ MemberArn: string }> | undefined) {
  mockMessagingSend.mockImplementation((cmd: FakeCommand) => {
    if (cmd.__type === 'Get') return Promise.resolve({ ChannelMessage: { Target: placeholderTarget } });
    if (cmd.__type === 'Send') return Promise.resolve({ MessageId: NEW_MESSAGE });
    return Promise.resolve({});
  });
}

const finalize = (args: { visibility: 'private' | 'conversation'; broadcastAnswer?: boolean }) =>
  finalizePlaceholderResponse({
    event: {
      channelArn: CHANNEL, correlationId: 'corr-1', userMessage: '#2 when is it fixed?', classification: 'standard',
      botArn: BOT, senderArn: USER, ...(args.broadcastAnswer ? { broadcastAnswer: true } : {}),
    },
    response: ANSWER,
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    inputTokens: 10, outputTokens: 20, bedrockTime: 100,
    messageId: PLACEHOLDER, guardMs: 2, placeholderResolveMs: 5, conversationHistoryLength: 2,
    startTime: Date.now(),
    taskContext: {
      task: {
        taskId: 't2', channelArn: CHANNEL, userArn: USER, status: 'in_progress', taskType: 'general',
        visibility: args.visibility, createdAt: '', updatedAt: '',
      },
      machines: {}, transitions: [],
    },
  } as never);

beforeEach(() => {
  mockMessagingSend.mockReset();
  mockMarkBotWaitingForUser.mockReset();
  mockWriteMessageAnalytics.mockReset().mockResolvedValue(undefined);
});

describe('shared work answered from a public message', () => {
  it('answers in the public reply and sends nothing else, however the work was resumed', async () => {
    stubChime(undefined);
    await finalize({ visibility: 'conversation', broadcastAnswer: true });

    expect(writtenTo(PLACEHOLDER)).toContain(ANSWER);
    // No private receipt beside it: the person can see the answer under their own message.
    expect(calls('Send')).toHaveLength(0);
  });
});

describe('a private message', () => {
  it('is answered privately, in the placeholder already targeted at the person, with nothing public', async () => {
    stubChime([{ MemberArn: USER }]);
    await finalize({ visibility: 'conversation', broadcastAnswer: true });

    expect(writtenTo(PLACEHOLDER)).toContain(ANSWER);
    expect(calls('Send')).toHaveLength(0);
  });
});

describe('private work answered from a public message', () => {
  beforeEach(() => stubChime(undefined));

  it('sends the answer in a message targeted at the person', async () => {
    await finalize({ visibility: 'private' });

    const sent = calls('Send');
    expect(sent).toHaveLength(1);
    expect(sent[0].input.Target).toEqual([{ MemberArn: USER }]);
    expect(writtenTo(NEW_MESSAGE)).toContain(ANSWER);
  });

  it('leaves the public placeholder saying only that they were answered privately', async () => {
    await finalize({ visibility: 'private' });

    expect(writtenTo(PLACEHOLDER)).toBe(ANSWERED_PRIVATELY);
    const everyPublicWrite = calls('Update').filter((c) => c.input.MessageId === PLACEHOLDER)
      .map((c) => decodeURIComponent(c.input.Content as string)).join('\n');
    expect(everyPublicWrite).not.toContain('payroll');
  });

  it('fails the turn rather than answering in public when the private message cannot be posted', async () => {
    mockMessagingSend.mockImplementation((cmd: FakeCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ ChannelMessage: {} });
      if (cmd.__type === 'Send') return Promise.reject(new Error('throttled'));
      return Promise.resolve({});
    });
    await expect(finalize({ visibility: 'private' })).rejects.toThrow(/not answering a private item in public/);
    const publicWrites = calls('Update').map((c) => decodeURIComponent(c.input.Content as string)).join('\n');
    expect(publicWrites).not.toContain('payroll');
  });
});

describe('planResumedChainDelivery', () => {
  it('keeps a duel side answered privately public, because a duel is a comparison', () => {
    expect(planResumedChainDelivery({ resumedChain: true, isDuel: true, placeholderIsTargeted: true }))
      .toEqual({ broadcastTheAnswer: true, targetTheAnswer: false });
  });

  it('never broadcasts an ordinary resumed chain, and never sends a receipt', () => {
    for (const placeholderIsTargeted of [true, false]) {
      expect(planResumedChainDelivery({ resumedChain: true, placeholderIsTargeted }))
        .toEqual({ broadcastTheAnswer: false, targetTheAnswer: false });
    }
  });

  it('sends private work to the person from a public placeholder, on any turn and even in a duel', () => {
    expect(planResumedChainDelivery({ taskIsPrivate: true, placeholderIsTargeted: false }))
      .toEqual({ broadcastTheAnswer: false, targetTheAnswer: true });
    expect(planResumedChainDelivery({ resumedChain: true, isDuel: true, taskIsPrivate: true, placeholderIsTargeted: true }))
      .toEqual({ broadcastTheAnswer: false, targetTheAnswer: false });
  });
});

