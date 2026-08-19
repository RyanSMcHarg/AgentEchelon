/**
 * A CONVERSATION THAT IS MID-WORKFLOW, OR HAS JUST FINISHED ONE, IS NOT A CONVERSATION THAT HAS
 * CHANGED SUBJECT.
 *
 * Two failures from one live `report_generation` conversation, and they fail for opposite reasons.
 *
 * ONE - THE GUARD ASKED THE WRONG QUESTION. It asked "does this USER hold a live task here", which is
 * not the same as "is the assistant mid-workflow here": ownership moves to the person only when the
 * machine enters a state that declares `awaits` (ADR-024), so a state that ends its turn on a question
 * and forgets the flag leaves the task with the ASSISTANT and the guard silently stops existing. The
 * task sat in `drafting_outline`, the assistant asked "shall I draft the full report with this
 * structure, or would you like to adjust any sections?", the person answered "Can you make it 1-2
 * pages?", and the platform replied "It looks like you're shifting topics."
 *
 * TWO - THE GUARD HAD NOTHING LEFT TO ASK. The report was delivered, the person said "Looks good", the
 * assistant said it had saved the file, and "Where is the file?" fired a drift offer. By then the task
 * had ENDED, and every task lookup on this path filters to `pending`/`in_progress`, so no widening of
 * the live signal could reach that turn. A finished task keeps answering for a bounded window instead.
 *
 * Both are held here at the ROUTER, which is where the evidence is resolved. The detector itself only
 * ever sees a boolean (`drift-detection.test.ts`), and the flow only forwards it
 * (`live-drift-flow.test.ts`).
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

/** The drift flow is stubbed so what the ROUTER tells it is observable; the flow's own gates and the
 *  data-plane round-trip are covered by live-drift-flow.test.ts. Returning null keeps the turn on its
 *  normal path, so the assertions are about a real turn rather than a short-circuited one. */
const mockRunLiveDriftFlow = jest.fn();
jest.mock('../../lambda/src/lib/live-drift-flow.js', () => ({
  runLiveDriftFlow: (...a: unknown[]) => mockRunLiveDriftFlow(...a),
}), { virtual: true });

/** The messages here are sentences, not tokens, so the fast path does not settle them. Stubbed rather
 *  than left to Bedrock: this file is about what the router does with the turn, not how it labels it. */
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: async () => ({ intent: actual.IntentType.GENERAL, confidence: 'high' }),
  };
}, { virtual: true });

/** What the router told the drift flow about this conversation. */
const driftInput = () => mockRunLiveDriftFlow.mock.calls[0]?.[0] as {
  activeTaskInProgress?: boolean;
  taskSignal?: string;
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();

/** A task mirror row. `ownerSub` is the OWNER's partition key, a bot id for assistant-held work. */
const mirrorRow = (ownerSub: string, taskState: string, status = 'in_progress', taskId = 't-report') => ({
  taskId,
  taskType: 'report_generation',
  taskState,
  channelArn: CHANNEL,
  status,
  userSub: ownerSub,
  assistantId: principalIdOf(BOT_SELF),
  updatedAt: minutesAgo(1),
});

/** The full task row, whose `stateHistory` is where an ending is actually recorded (spec section 6). */
const endedTask = (endedMinutesAgo: number, taskId = 't-report') => ({
  taskId,
  channelArn: CHANNEL,
  taskType: 'report_generation',
  taskState: 'completed',
  status: 'completed',
  stateHistory: [
    { at: minutesAgo(endedMinutesAgo + 1), by: 'tool', from: 'generating', to: 'completed' },
    { at: minutesAgo(endedMinutesAgo), by: 'system', terminal: 'success', reason: 'task completed' },
  ],
});

/** Nothing live and nothing finished, for either owner. */
const noTasksAnywhere = () => ({ live: [], recentlyEnded: [] });

const turn = (userMessage: string) => ({
  aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage, userMessageId: 'm-1' },
});

describe('work in this conversation suppresses drift', () => {
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

  describe('while the work is running', () => {
    it('suppresses when the live task is held by the ASSISTANT and the person holds nothing', async () => {
      // The first reported transcript. `generating` awaits nobody, exactly as `drafting_outline` used
      // to, so the chain sits in the assistant's partition and the person's queue is empty. Keyed on
      // ownership, the router reported no live task and the answer to its own question read as a pivot.
      mockGetOwnerChannelTasks.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(BOT_SELF)
          ? { live: [mirrorRow(principalIdOf(BOT_SELF), 'generating')], recentlyEnded: [] }
          : noTasksAnywhere());

      await routerHandler(turn('Can you make it 1-2 pages?'));

      expect(driftInput().activeTaskInProgress).toBe(true);
      expect(driftInput().taskSignal).toBe('live');
    });

    it('still suppresses when the person holds the task (the narrow case is not lost)', async () => {
      mockGetOwnerChannelTasks.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN)
          ? { live: [mirrorRow(principalIdOf(HUMAN), 'collecting_requirements')], recentlyEnded: [] }
          : noTasksAnywhere());

      await routerHandler(turn('The audience is the board, keep it to two pages.'));

      expect(driftInput().activeTaskInProgress).toBe(true);
    });

    it('does NOT suppress when the conversation has no work at all', async () => {
      // The other direction, and it is what keeps the guard from being a switch that turns drift off.
      await routerHandler(turn('Actually, can we talk about the hiring plan instead?'));

      expect(driftInput().activeTaskInProgress).toBe(false);
      expect(driftInput().taskSignal).toBeUndefined();
    });

    it('buys the broader answer with no additional read', async () => {
      // The condition comes from lookups the turn already makes: one query on the person's partition,
      // one on the assistant's when that finds nothing. Both now ask for the ended half as well, which
      // is free - the filter runs after the read. The log confirmation is NOT paid when live work
      // already settles the question.
      mockGetOwnerChannelTasks.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(BOT_SELF)
          ? { live: [mirrorRow(principalIdOf(BOT_SELF), 'generating')], recentlyEnded: [] }
          : noTasksAnywhere());

      await routerHandler(turn('Can you make it 1-2 pages?'));

      expect(mockGetOwnerChannelTasks).toHaveBeenCalledTimes(2);
      expect(mockGetTask).not.toHaveBeenCalled();
      // And it asks for the ended half in the same call rather than issuing a second query for it.
      expect(mockGetOwnerChannelTasks.mock.calls[0][2]).toEqual(
        expect.objectContaining({ endedWithinMs: expect.any(Number) }),
      );
    });
  });

  describe('just after the work has finished', () => {
    beforeEach(() => {
      // Nothing live anywhere; the report's mirror row sits finished in the ASSISTANT's partition,
      // because a report is handed back to the assistant before it completes.
      mockGetOwnerChannelTasks.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(BOT_SELF)
          ? { live: [], recentlyEnded: [mirrorRow(principalIdOf(BOT_SELF), 'completed', 'completed')] }
          : noTasksAnywhere());
    });

    it('reads a follow-up about the delivered file as being about it', async () => {
      // The second reported transcript, exactly: the report was delivered and accepted, the assistant
      // said it had saved the file, and this question was answered with an offer to talk elsewhere.
      mockGetTask.mockResolvedValue(endedTask(2));

      await routerHandler(turn('Where is the file?'));

      expect(driftInput().activeTaskInProgress).toBe(true);
      expect(driftInput().taskSignal).toBe('recently_ended');
    });

    it('lets a message well outside the window drift, so this is not drift switched off', async () => {
      // The same conversation a long time later. Without this the guard would be indistinguishable
      // from disabling the feature for any channel that ever ran a task.
      mockGetTask.mockResolvedValue(endedTask(120));

      await routerHandler(turn('Actually, can we talk about the hiring plan instead?'));

      expect(driftInput().activeTaskInProgress).toBe(false);
    });

    it('takes the ending from the LOG, not from the mirror row that pointed at it', async () => {
      // The mirror says the row was touched a minute ago; the task's own append-only history says the
      // work ended two hours ago, and the history is the record (spec section 6, which is explicit
      // that there is no `resolvedAt` scalar beside it). Believing the mirror would stretch the window
      // by however long anything else touched the row.
      mockGetTask.mockResolvedValue(endedTask(120));

      await routerHandler(turn('Where is the file?'));

      expect(mockGetTask).toHaveBeenCalledTimes(1);
      expect(driftInput().activeTaskInProgress).toBe(false);
    });

    it('does not suppress on a task whose log records no ending', async () => {
      // A row that is closed in the mirror but has no terminal entry cannot say WHEN it ended, and a
      // guard that assumed "recently" would suppress on a task closed months ago.
      mockGetTask.mockResolvedValue({ ...endedTask(2), stateHistory: [] });

      await routerHandler(turn('Where is the file?'));

      expect(driftInput().activeTaskInProgress).toBe(false);
    });
  });
});
