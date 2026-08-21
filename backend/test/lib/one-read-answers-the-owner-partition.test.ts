/**
 * A CHANNEL TURN ASKS AN OWNER'S PARTITION ONCE, AND THE PER-TYPE FALLBACK IS NOT A SECOND ANSWER.
 *
 * The router's last task lookup is a loop over every declared machine, calling
 * `getActiveTask(userSub, type, { channelArn })`. Its comment describes it as the requester-keyed
 * question - "what has this person open at all", as distinct from "what is waiting on them" - and
 * that WAS the distinction before ADR-024. It is not one now. The mirror row is partitioned by the
 * CURRENT OWNER (`putMirrorRow`, task-tracking.ts), so both lookups read the same partition, and the
 * channel-scoped read above it (`getOwnerChannelTasks`) already returns every live row in it for this
 * channel: unbounded, paginated, strongly consistent, and NOT narrowed by task type.
 *
 * So on a channel turn the loop is strictly weaker than a read the turn has already made. It cannot
 * name a row that read missed - it queries the same partition key, the same channel filter and the
 * same active statuses, plus a type filter - and it costs up to two DynamoDB reads per declared type
 * (a GSI query, then a strongly-consistent base-table re-check) on the most ordinary turn there is.
 *
 * WHAT THIS FILE PINS, in both directions:
 *   - with a channel, the fallback does not run: the channel read is the answer;
 *   - without one, it still does. That path has no `getOwnerChannelTasks` to lean on, so removing the
 *     loop outright would remove the only lookup a channel-less turn makes.
 *
 * The mock harness follows `live-work-suppresses-drift.test.ts` in this directory, which exercises
 * the same block of the router for the drift signal it feeds.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

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
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_SELF = `${APP}/bot/premium-bot`;
const HUMAN = `${APP}/user/alice`;
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;

const ROSTER_PARAM = '/agent-echelon/alt-bot-slots/roster';
const SELF_FUNCTION = 'AgentEchelonClassification-Premium-AgentHandler';

const mockGetOwnerChannelTasks = jest.fn();
const mockGetActiveTaskForOwner = jest.fn();
const mockGetActiveTask = jest.fn();
const mockGetTask = jest.fn();
const mockApplyUserResponseToTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getOwnerChannelTasks: (...a: unknown[]) => mockGetOwnerChannelTasks(...a),
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    getActiveTask: (...a: unknown[]) => mockGetActiveTask(...a),
    getTask: (...a: unknown[]) => mockGetTask(...a),
    applyUserResponseToTask: (...a: unknown[]) => mockApplyUserResponseToTask(...a),
  };
}, { virtual: true });

const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();
const mockResumeFromWaiting = jest.fn();

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
    readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
    resumeBotFromWaiting: (...a: unknown[]) => mockResumeFromWaiting(...a),
  };
}, { virtual: true });

const mockRunLiveDriftFlow = jest.fn();
jest.mock('../../lambda/src/lib/live-drift-flow.js', () => ({
  runLiveDriftFlow: (...a: unknown[]) => mockRunLiveDriftFlow(...a),
}), { virtual: true });

/** Sentences, not tokens, so the short-message fast path does not settle the turn before the lookups. */
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: async () => ({ intent: actual.IntentType.GENERAL, confidence: 'high' }),
  };
}, { virtual: true });

const noTasksAnywhere = () => ({ live: [], recentlyEnded: [] });

const turn = (userMessage: string, channelArn: string = CHANNEL) => ({
  aeTurn: { channelArn, senderArn: HUMAN, userMessage, userMessageId: 'm-1' },
});

describe('the per-type task fallback and the channel read', () => {
  let routerHandler: (e: any) => Promise<any>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.AWS_LAMBDA_FUNCTION_NAME = SELF_FUNCTION;
    process.env.ALT_BOT_SLOTS_ROSTER_PARAM = ROSTER_PARAM;
    delete process.env.ABUSE_CONTROLS_TABLE;

    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) =>
      cmd?.input?.Name === ROSTER_PARAM
        ? { Parameter: { Value: JSON.stringify([]) } }
        : { Parameter: { Value: BOT_SELF } });

    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });

    mockResolveActiveBattle.mockResolvedValue(null);
    mockReadBattleRows.mockResolvedValue([]);
    mockResumeFromWaiting.mockResolvedValue(false);
    mockGetOwnerChannelTasks.mockResolvedValue(noTasksAnywhere());
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockGetActiveTask.mockResolvedValue(null);
    mockGetTask.mockResolvedValue(null);
    mockApplyUserResponseToTask.mockResolvedValue({ applied: true });
    mockRunLiveDriftFlow.mockResolvedValue(null);

    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  it('does not re-ask the person partition per task type when a channel read already scanned it', async () => {
    // The ordinary turn: nothing held anywhere, so the channel read comes back empty and the loop
    // used to run in full. Both reads that DO happen are asserted, so this cannot pass by the block
    // being skipped entirely.
    await routerHandler(turn('Can you pull together the quarterly numbers for the board?'));

    expect(mockGetOwnerChannelTasks).toHaveBeenCalledWith(
      principalIdOf(HUMAN), CHANNEL, expect.objectContaining({ endedWithinMs: expect.any(Number) }),
    );
    expect(mockGetOwnerChannelTasks).toHaveBeenCalledWith(
      principalIdOf(BOT_SELF), CHANNEL, expect.objectContaining({ endedWithinMs: expect.any(Number) }),
    );
    expect(mockGetActiveTask).not.toHaveBeenCalled();
  });

  it('still asks per type when there is no channel to scope the read to', async () => {
    // The other direction, and it is why the loop is skipped rather than deleted. Without a channel
    // the owner read is not made at all (it needs one for its filter), so this is the only lookup the
    // turn has - and a fallback that no longer runs anywhere would be a lookup silently removed.
    await routerHandler(turn('Can you pull together the quarterly numbers for the board?', ''));

    expect(mockGetOwnerChannelTasks).not.toHaveBeenCalled();
    expect(mockGetActiveTask).toHaveBeenCalled();
    // Asked WITHOUT a channel scope, which is the only shape available here.
    for (const call of mockGetActiveTask.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
  });
});
