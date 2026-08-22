/**
 * A resumed duel side that asks ANOTHER question still resolves every message it posted (ADR-029).
 *
 * The resumed shape is a pair (see `planResumedChainDelivery`): the person answered privately, so the
 * reply Amazon Chime SDK posted is targeted, and the turn posts a second, untargeted message for its
 * public output. Both are on the channel before the model's text is inspected.
 *
 * So the clarification exit owes exactly what the answer exit owes. Sending the question to the private
 * placeholder instead left the public message reading "..." forever - the orphan a person reads as
 * "my reply went nowhere" - and put the question somewhere the rival cannot see, which is the
 * concealment ADR-029 reverses. ADR-025 is the other half: the acknowledgment belongs to the turn, so
 * the turn is what resolves it, on every exit rather than on the one that happened to be written first.
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

// The battle row is state this turn writes, not behaviour it decides, so it is stubbed and asserted on.
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
import { RESUMED_CHAIN_ACKNOWLEDGEMENT } from '../../lambda/src/lib/resumed-chain-delivery';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';
const RIVAL = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const USER = 'arn:aws:chime:us-east-1:111:app-instance/user/u1';
const PRIVATE_PLACEHOLDER = 'private-placeholder-msg';
const PUBLIC_MESSAGE = 'public-answer-msg';
const QUESTION = 'Which fiscal quarter should the report cover, Q3 or Q4?';
const CLARIFYING_REPLY = `${QUESTION}\nNEED_CLARIFICATION`;

interface FakeCommand {
  __type: string;
  input: Record<string, unknown>;
}

const calls = (type: string): FakeCommand[] =>
  mockMessagingSend.mock.calls.map((c) => c[0] as FakeCommand).filter((c) => c?.__type === type);

/** What a reader would see on a given message after this turn, or undefined if it was never written. */
const contentWrittenTo = (messageId: string): string | undefined => {
  const update = calls('Update').find((c) => c.input.MessageId === messageId);
  return update ? decodeURIComponent(update.input.Content as string) : undefined;
};

const phaseWrittenTo = (messageId: string): string | undefined => {
  const update = calls('Update').find((c) => c.input.MessageId === messageId);
  return update ? JSON.parse(update.input.Metadata as string).respPhase : undefined;
};

/** The placeholder is TARGETED (a private reply) unless a case says otherwise. */
function stubChime(placeholderTarget: Array<{ MemberArn: string }> | undefined) {
  mockMessagingSend.mockImplementation((cmd: FakeCommand) => {
    if (cmd.__type === 'Get') {
      return Promise.resolve({ ChannelMessage: { Target: placeholderTarget } });
    }
    if (cmd.__type === 'Send') return Promise.resolve({ MessageId: PUBLIC_MESSAGE });
    return Promise.resolve({});
  });
}

const finalize = (broadcastAnswer: boolean) =>
  finalizePlaceholderResponse({
    event: {
      channelArn: CHANNEL,
      correlationId: 'corr-1',
      userMessage: 'Q3 please',
      userType: 'standard',
      botArn: BOT,
      senderArn: USER,
      broadcastAnswer,
      battleContext: {
        battleId: 'a1b2c3d4e5f60718',
        round: 1,
        totalRounds: 2,
        selfBotArn: BOT,
        rivalBotArn: RIVAL,
      },
    },
    response: CLARIFYING_REPLY,
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    inputTokens: 10,
    outputTokens: 20,
    bedrockTime: 100,
    messageId: PRIVATE_PLACEHOLDER,
    guardMs: 2,
    placeholderResolveMs: 5,
    conversationHistoryLength: 2,
    startTime: Date.now(),
  });

beforeEach(() => {
  mockMessagingSend.mockReset();
  mockMarkBotWaitingForUser.mockReset();
  mockMarkBotWaitingForUser.mockResolvedValue(true);
  publishesAtAnalyticsWrite = null;
  mockWriteMessageAnalytics.mockReset();
  mockWriteMessageAnalytics.mockImplementation(() => {
    publishesAtAnalyticsWrite = mockMessagingSend.mock.calls
      .map((c) => (c[0] as FakeCommand)?.__type)
      .filter((t) => t === 'Update' || t === 'Send').length;
    return Promise.resolve(undefined);
  });
});

/** The single argument the turn hands the out-of-band store, whatever branch it took. */
const analyticsWrite = (): { messageId: string; channelArn: string; analytics: Record<string, unknown> } => {
  expect(mockWriteMessageAnalytics).toHaveBeenCalledTimes(1);
  return mockWriteMessageAnalytics.mock.calls[0][0];
};

describe('a resumed side that asks again', () => {
  beforeEach(() => stubChime([{ MemberArn: USER }]));

  it('puts the question on the PUBLIC message, not the private placeholder', async () => {
    await finalize(true);

    // ADR-029 decision 1: the question is broadcast, like every other duel message. On a resumed chain
    // the public message is the one carrying this side's output, so that is the message it replaces.
    expect(contentWrittenTo(PUBLIC_MESSAGE)).toContain(QUESTION);
    expect(contentWrittenTo(PRIVATE_PLACEHOLDER)).not.toContain(QUESTION);
  });

  it('leaves nothing reading "..." (the orphan a person reads as a lost reply)', async () => {
    await finalize(true);

    // The public message is posted with "..." before the model's text is inspected, so the only thing
    // that stops it being an orphan is this turn writing over it.
    const posted = calls('Send').map((c) => decodeURIComponent(c.input.Content as string));
    expect(posted).toContain('...');
    // Asserted as "was written, and not with the placeholder copy", never as "is not '...'" alone: a
    // message that was never touched satisfies the second half and fails the person.
    for (const id of [PUBLIC_MESSAGE, PRIVATE_PLACEHOLDER]) {
      expect(contentWrittenTo(id)).toBeDefined();
      expect(contentWrittenTo(id)).not.toBe('...');
    }
    expect(contentWrittenTo(PRIVATE_PLACEHOLDER)).toBe(RESUMED_CHAIN_ACKNOWLEDGEMENT);
  });

  it('marks the side waiting on the message that actually holds the question', async () => {
    await finalize(true);

    // `waitingMessageId` names the message whose `<!--battlewaiting-->` marker the resume clears
    // (ADR-029 decision 6). Naming the receipt instead would clear a marker that is not there and
    // leave the affordance stuck on the question forever.
    expect(mockMarkBotWaitingForUser).toHaveBeenCalledWith(
      expect.objectContaining({ waitingMessageId: PUBLIC_MESSAGE, question: QUESTION }),
    );
  });

  it('does not close the turn: a question is a step, not an answer', async () => {
    await finalize(true);

    // Only `final` stamps `agent_final_at`. A person asked for more information has not been answered,
    // so neither message may claim the turn finished - on the question or on the receipt beside it.
    expect(phaseWrittenTo(PUBLIC_MESSAGE)).toBe('interim');
    expect(phaseWrittenTo(PRIVATE_PLACEHOLDER)).toBe('interim');
  });
});

describe('a turn that asks a question still reports what it cost', () => {
  // The clarification branch RETURNS. While the out-of-band write sat below it, a turn that ran a full
  // Converse loop to compose a question archived with no tokens, no cost and no latency - and the
  // dimension the question is measured FOR (asked vs. forged ahead) lost its cost half entirely.
  // Measurement belongs to the TURN; it cannot depend on which delivery branch the turn took.

  it('writes the analytics row on the clarification exit, keyed to the message holding the question', async () => {
    stubChime([{ MemberArn: USER }]);
    await finalize(true);

    // Keyed on the turn's OUTPUT message, by the same rule the answer path follows: on a resumed chain
    // that is the public message, not the private placeholder the turn started from.
    expect(analyticsWrite().messageId).toBe(PUBLIC_MESSAGE);
    expect(analyticsWrite().channelArn).toBe(CHANNEL);
  });

  it('the row carries the compute the question actually cost', async () => {
    stubChime(undefined);
    await finalize(false);

    // Asserted as real values, not as "the row exists": a row present but empty is the same blind spot
    // wearing a different shape.
    expect(analyticsWrite().analytics).toEqual(
      expect.objectContaining({ inputTokens: 10, outputTokens: 20, latencyMs: 100 }),
    );
    expect(Number(analyticsWrite().analytics.totalMs)).toBeGreaterThanOrEqual(0);
  });

  it('writes the row BEFORE the message it describes reaches the channel', async () => {
    stubChime(undefined);
    await finalize(false);

    // Why the order matters: archival sees the message through Chime's Kinesis mirror and reads this
    // row by message id. Written after the update, the row can lose the race and the question archives
    // with no telemetry - the same outcome as not writing it at all, but intermittent.
    expect(publishesAtAnalyticsWrite).toBe(0);
    // And the turn really did publish, so the zero above is an ordering fact rather than a turn that
    // never got that far.
    expect(calls('Update').length).toBeGreaterThan(0);
  });

  it('reporting the cost does not let a question claim the turn finished', async () => {
    stubChime(undefined);
    await finalize(false);

    // The guard on moving a telemetry write earlier. Finality is DECLARED, so the row may carry
    // `totalMs` without closing the turn - but if the phase ever stopped being declared here, the
    // archival fallback ("no phase + total_ms present -> final") would fire on this very row and freeze
    // e2e at a question. This asserts the two together, because it is the PAIR that is safe.
    expect(analyticsWrite().analytics.totalMs).toBeDefined();
    expect(phaseWrittenTo(PRIVATE_PLACEHOLDER)).toBe('interim');
    expect(analyticsWrite().analytics.respPhase).toBeUndefined();
  });
});

describe('an ordinary side asking for the first time is unchanged', () => {
  beforeEach(() => stubChime(undefined));

  it('the question replaces the placeholder itself, with no second message', async () => {
    await finalize(false);

    // The turn owes one message and posts none: this is the path ADR-029 describes directly, and the
    // resumed pair above must not leak a receipt or a broadcast into it.
    expect(calls('Send')).toHaveLength(0);
    expect(contentWrittenTo(PRIVATE_PLACEHOLDER)).toContain(QUESTION);
    expect(calls('Update')).toHaveLength(1);
    expect(mockMarkBotWaitingForUser).toHaveBeenCalledWith(
      expect.objectContaining({ waitingMessageId: PRIVATE_PLACEHOLDER }),
    );
  });
});
