/**
 * A MESSAGE IS ROUTED ON ITS CONTENT, READ WITH THE CONVERSATION'S TASK STATE (ADR-064, amended 2026-11-12).
 *
 * A conversation is not task based: it may hold an open task, and each message is routed on what it says and on that
 * task's state. Read alone, "Q3, split by region, two pages" is `general`; read beside a report waiting on its
 * requirements, it is that report's answer. The classifier is offered the open task (its id, type, step, how the step
 * is named, whether it waits on the person, and the words that asked for it) and decides once: the message continues
 * the task, or it is a request of its own intent. A message it places in the task runs on the task's intent; one it
 * reads as something else runs on its own intent and the task stays open. The decision rides the turn as `routedAs`.
 *
 * The mock harness follows `live-work-suppresses-drift.test.ts`, which exercises the same block of the router.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

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

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_SELF = `${APP}/bot/premium-bot`;
const HUMAN = `${APP}/user/alice`;
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;

const mockGetOwnerChannelTasks = jest.fn();
const mockGetTask = jest.fn();
const mockApplyUserResponseToTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getAssigneeChannelTasks: (...a: unknown[]) => mockGetOwnerChannelTasks(...a),
    getActiveTaskForOwner: async () => null,
    getActiveTask: async () => null,
    getTask: (...a: unknown[]) => mockGetTask(...a),
    createTask: async (_e: unknown, _d: unknown, taskType?: string) =>
      ({ taskId: 't-new', taskType, taskState: 'collecting', status: 'in_progress' }),
    applyUserResponseToTask: (...a: unknown[]) => mockApplyUserResponseToTask(...a),
  };
}, { virtual: true });

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    resolveActiveBattle: async () => null,
    readBattleRows: async () => [],
    resumeBotFromWaiting: async () => false,
  };
}, { virtual: true });

jest.mock('../../lambda/src/lib/live-drift-flow.js', () => ({
  runLiveDriftFlow: async () => null,
  resolveOriginatingMessage: async () => ({ messageId: 'm-1' }),
}), { virtual: true });

/** The classifier's decision for this turn, and every call it was asked, with its options. */
type Decision = { intent: string; continuesTask?: { taskId: string; taskType: string }; waitingWorkDecided?: string[] };
const mockDecide = jest.fn<Decision, [string, { waitingWork?: Array<Record<string, unknown>> } | undefined]>();
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: async (message: string, opts: { waitingWork?: Array<Record<string, unknown>> } | undefined) =>
      ({ confidence: 'high', ...mockDecide(message, opts) }),
  };
}, { virtual: true });

/** A report waiting on this person for its requirements, in their partition. */
const waitingReport = {
  taskId: 't-report',
  taskType: 'report_generation',
  taskState: 'collecting_requirements',
  channelArn: CHANNEL,
  status: 'in_progress',
  personId: principalIdOf(HUMAN),
  ownerPersonId: principalIdOf(HUMAN),
  assistantId: principalIdOf(BOT_SELF),
  requestExcerpt: 'Write me a board report on revenue',
  updatedAt: new Date().toISOString(),
};

const turn = (userMessage: string) => ({
  aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage, userMessageId: 'm-1' },
});

/** The worker payloads this turn dispatched. */
const dispatched = () => mockLambdaSend.mock.calls
  .map((c) => (c[0] as { __type?: string; input?: { Payload?: unknown } }))
  .filter((c) => c.__type === 'Invoke' && c.input?.Payload)
  .map((c) => JSON.parse(Buffer.from(c.input!.Payload as Uint8Array).toString()))
  .filter((p) => p && typeof p === 'object' && 'correlationId' in p);

describe('a message is routed on its content read with the task state', () => {
  let routerHandler: (e: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'AgentEchelonAssistants-premium-AgentHandler';
    process.env.CLASSIFICATION = 'premium';
    delete process.env.ABUSE_CONTROLS_TABLE;
    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => {
      if (/\/definition(:|$)/.test(cmd?.input?.Name ?? '')) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      return { Parameter: { Value: BOT_SELF } };
    });
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
    mockGetOwnerChannelTasks.mockImplementation(async (owner: string) =>
      (owner === principalIdOf(HUMAN) ? { live: [waitingReport], recentlyEnded: [] } : { live: [], recentlyEnded: [] }));
    mockGetTask.mockResolvedValue(null);
    mockApplyUserResponseToTask.mockResolvedValue({ applied: true });
    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  afterAll(() => { delete process.env.CLASSIFICATION; });

  it('the classifier receives the open task as context: its id, type, step, that it waits on the person, and its request', async () => {
    mockDecide.mockReturnValue({ intent: 'general', waitingWorkDecided: ['t-report'] });
    await routerHandler(turn('Q3, split by region, two pages'));
    const opts = mockDecide.mock.calls[0][1];
    expect(opts?.waitingWork).toEqual([expect.objectContaining({
      taskId: 't-report', taskType: 'report_generation', step: 'collecting_requirements', waitsOnPerson: true,
      request: 'Write me a board report on revenue',
    })]);
  });

  it('a reply the classifier places in the waiting task continues it, on the task intent, recorded as continuing it', async () => {
    mockDecide.mockReturnValue({
      intent: 'report_generation',
      continuesTask: { taskId: 't-report', taskType: 'report_generation' },
      waitingWorkDecided: ['t-report'],
    });
    await routerHandler(turn('Q3, split by region, two pages'));
    expect(mockApplyUserResponseToTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't-report' }));
    const payloads = dispatched();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      taskId: 't-report', taskType: 'report_generation', isTaskContinuation: true,
      intent: 'report_generation', routedAs: 'continues_task',
    });
  });

  it('an unrelated question while the task waits is routed on its own intent and the task stays open', async () => {
    mockDecide.mockReturnValue({ intent: 'general', waitingWorkDecided: ['t-report'] });
    await routerHandler(turn('What time zone is the Denver office in?'));
    expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    const payloads = dispatched();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ intent: 'general', routedAs: 'own_intent' });
    expect(payloads[0].taskId).toBeUndefined();
    expect(payloads[0].isTaskContinuation).not.toBe(true);
  });

  it('a new request of another kind while the task waits opens its own task and leaves the report open', async () => {
    mockDecide.mockReturnValue({ intent: 'data_extraction', waitingWorkDecided: ['t-report'] });
    await routerHandler(turn('Separately, pull the totals out of the attached invoice.'));
    expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    const payloads = dispatched();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ taskId: 't-new', taskType: 'data_extraction', routedAs: 'own_intent' });
  });

  it('a conversation with no open task is unchanged: nothing is offered and nothing is recorded', async () => {
    mockGetOwnerChannelTasks.mockResolvedValue({ live: [], recentlyEnded: [] });
    mockDecide.mockReturnValue({ intent: 'general' });
    await routerHandler(turn('What time zone is the Denver office in?'));
    expect(mockDecide.mock.calls[0][1]?.waitingWork).toEqual([]);
    const payloads = dispatched();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ intent: 'general' });
    expect(payloads[0].routedAs).toBeUndefined();
    expect(payloads[0].taskId).toBeUndefined();
  });
});
