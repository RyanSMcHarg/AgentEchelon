/**
 * A duel side parked on a task step tells the conversation it is waiting, and on whom (ADR-026, ADR-029).
 *
 * A task-shaped side runs its own chain, and a chain with legs left parks the side in `WAITING_FOR_USER`
 * until the duel's owner answers it with a reply targeted at that side. The chat app draws the "Reply to
 * this side" control from the `<!--battlewaiting-->` marker on the side's message, so the step the side
 * parks on carries that marker, with the owner's id, on the same update that delivers the step. The
 * battle row records that message as `waitingMessageId`, which is what the resume and the end of the duel
 * clear the marker from.
 *
 * A leg that completes its task carries no marker: the side has finished its round and waits on nobody.
 */
const mockMessagingSend = jest.fn();
const mockMarkBotWaitingForUser = jest.fn();
const mockGetBotRow = jest.fn();
const mockTransitionBotState = jest.fn();

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

jest.mock('../../lambda/src/lib/battle-state', () => ({
  markBotWaitingForUser: (...args: unknown[]) => mockMarkBotWaitingForUser(...args),
  getBotRow: (...args: unknown[]) => mockGetBotRow(...args),
  computeActiveResponseMs: () => 0,
  transitionBotState: (...args: unknown[]) => mockTransitionBotState(...args),
  readBattleRows: jest.fn().mockResolvedValue([]),
  allBotsTerminal: jest.fn(() => false),
}));

jest.mock('../../lambda/src/lib/message-analytics', () => ({
  writeMessageAnalytics: jest.fn().mockResolvedValue(undefined),
  messageAnalyticsEnabled: () => false,
}));

// The task's status write is the task service's concern, not this one's.
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  updateTaskStatus: jest.fn().mockResolvedValue(undefined),
}));

// A two-state machine: one step that needs the person, then the terminal state.
jest.mock('../../lambda/src/lib/intent-pack', () => ({
  ...jest.requireActual('../../lambda/src/lib/intent-pack'),
  taskStateMachines: () => ({
    report_generation: {
      initial: 'collecting_requirements',
      states: {
        collecting_requirements: { awaits: 'user' },
        completed: { terminal: true },
      },
    },
  }),
}));

import { finalizePlaceholderResponse, battleWaitingMarker } from '../../lambda/src/lib/async-processor-core';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';
const RIVAL = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const OWNER_ID = 'owner-person-id';
const OWNER = `arn:aws:chime:us-east-1:111:app-instance/i/user/${OWNER_ID}`;
const BATTLE_ID = 'a1b2c3d4e5f60718';
const PLACEHOLDER = 'side-placeholder-msg';
const STEP = 'Who is the audience for this report, and which period should it cover?';

interface FakeCommand {
  __type: string;
  input: Record<string, unknown>;
}

const contentWrittenTo = (messageId: string): string | undefined => {
  const update = mockMessagingSend.mock.calls
    .map((c) => c[0] as FakeCommand)
    .find((c) => c?.__type === 'Update' && c.input.MessageId === messageId);
  return update ? decodeURIComponent(update.input.Content as string) : undefined;
};

const finalize = (taskState: string, round: 1 | 2 = 1) =>
  finalizePlaceholderResponse({
    event: {
      channelArn: CHANNEL,
      correlationId: 'corr-1',
      userMessage: '/battle a report on growth',
      classification: 'standard',
      botArn: BOT,
      senderArn: OWNER,
      taskId: 'task-1',
      taskType: 'report_generation',
      battleContext: {
        battleId: BATTLE_ID,
        round,
        totalRounds: 2,
        selfBotArn: BOT,
        rivalBotArn: RIVAL,
      },
    },
    response: STEP,
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    inputTokens: 10,
    outputTokens: 20,
    bedrockTime: 100,
    messageId: PLACEHOLDER,
    guardMs: 2,
    placeholderResolveMs: 5,
    conversationHistoryLength: 2,
    startTime: Date.now(),
    taskContext: { task: { taskId: 'task-1', taskType: 'report_generation', taskState, visibility: 'conversation' }, machines: {} } as never,
  });

beforeEach(() => {
  mockMessagingSend.mockReset();
  mockMessagingSend.mockImplementation((cmd: FakeCommand) => {
    if (cmd.__type === 'Get') return Promise.resolve({ ChannelMessage: {} });
    return Promise.resolve({});
  });
  mockMarkBotWaitingForUser.mockReset();
  mockMarkBotWaitingForUser.mockResolvedValue(true);
  mockTransitionBotState.mockReset();
  mockTransitionBotState.mockResolvedValue(false);
  mockGetBotRow.mockReset();
  mockGetBotRow.mockResolvedValue({ battleId: BATTLE_ID, botArn: BOT, state: 'INVOKED', initiatorUserSub: OWNER_ID });
});

describe('battleWaitingMarker', () => {
  it('names the duel, the side and the person it waits on', () => {
    expect(battleWaitingMarker({ battleId: BATTLE_ID, botArn: BOT, ownerId: OWNER_ID }))
      .toBe(`<!--battlewaiting:battleId=${BATTLE_ID},botArn=${BOT},owner=${OWNER_ID}-->`);
  });

  it('omits the owner when the duel recorded none, rather than writing an empty one', () => {
    expect(battleWaitingMarker({ battleId: BATTLE_ID, botArn: BOT }))
      .toBe(`<!--battlewaiting:battleId=${BATTLE_ID},botArn=${BOT}-->`);
  });
});

describe('a round-1 side whose chain has a step left', () => {
  it('delivers the step with the waiting marker, naming the duel owner', async () => {
    await finalize('collecting_requirements');

    const written = contentWrittenTo(PLACEHOLDER);
    expect(written).toContain(STEP);
    expect(written).toContain(`<!--battlewaiting:battleId=${BATTLE_ID},botArn=${BOT},owner=${OWNER_ID}-->`);
  });

  it('records the step message as the one the resume and the end of the duel clear', async () => {
    await finalize('collecting_requirements');

    expect(mockMarkBotWaitingForUser).toHaveBeenCalledWith(expect.objectContaining({
      battleId: BATTLE_ID, botArn: BOT, reason: 'task-step', waitingMessageId: PLACEHOLDER,
    }));
    // Parked, so the round is not over and round 2 is not fired.
    expect(mockTransitionBotState).not.toHaveBeenCalled();
  });

  it('names the sender as the owner when the side row carries none', async () => {
    mockGetBotRow.mockResolvedValue(null);
    await finalize('collecting_requirements');

    expect(contentWrittenTo(PLACEHOLDER)).toContain(`owner=${OWNER_ID}-->`);
  });
});

describe('a side that waits on nobody carries no marker', () => {
  it('a leg that completes the task finishes the round instead', async () => {
    await finalize('completed');

    expect(contentWrittenTo(PLACEHOLDER)).not.toContain('<!--battlewaiting:');
    expect(mockMarkBotWaitingForUser).not.toHaveBeenCalled();
  });

  it('a round-2 rebuttal never parks', async () => {
    await finalize('collecting_requirements', 2);

    expect(contentWrittenTo(PLACEHOLDER)).not.toContain('<!--battlewaiting:');
    expect(mockMarkBotWaitingForUser).not.toHaveBeenCalled();
  });
});
