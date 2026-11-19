/**
 * A TURN THAT ENDS OWING A MOVE IS ASKED FOR IT, ONCE (SPEC-TASK-STATE-TRANSITIONS §7a).
 *
 * The sequence measured on dev 2026-11-18 (premium `account_brief`): the model ran `load_company_context` in
 * `researching`, wrote the whole brief in the same answer and ended without `advance_task_state`, so the task stayed in
 * `researching` and never finished; the person's next message got "the brief is above" and no move either.
 *
 * What it proves, from the record alone (the reply's words decide nothing, tenet D11):
 *  - that turn is continued once in the same loop, the model takes `drafting` and then `completed`, the task ends on
 *    its success terminal, and the reply the person reads is the brief as written, once;
 *  - the following turn, on a task whose required tool ran on an earlier turn, is continued the same way;
 *  - the extra model call is a step of the turn, with its tokens counted;
 *  - DENY: a step waiting on the person, a step that declares no required tool, a step whose required tool has not run,
 *    and a requester's turn on a task someone else holds are not continued; a model that declines in the continuation
 *    leaves the task where it is and the reply unchanged; the continuation is asked for at most once.
 */
const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListChannelMessagesCommand: jest.fn(), UpdateChannelMessageCommand: jest.fn(), SendChannelMessageCommand: jest.fn(), DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })), InvokeCommand: jest.fn(), InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({
  loadCompanyContext: jest.fn(async () => ({ documentCount: 1, documents: [{ name: 'customer-accounts.json', content: '{}' }] })),
  loadPlatformInfo: jest.fn(async () => ({ documentCount: 0, documents: [] })),
  loadContextDigest: jest.fn(async () => null),
  buildDigestHint: jest.fn(() => ''),
}));
jest.mock('../../lambda/src/lib/assistant-session', () => ({
  ...jest.requireActual('../../lambda/src/lib/assistant-session'),
  vendAssistantSession: jest.fn(async () => ({
    assistant: 'advisor', role: 'primary', botArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/a/bot/advisor',
    credentials: { accessKeyId: 'AKIAROLE', secretAccessKey: 's', sessionToken: 't' },
  })),
}));
// THE TASK ROW, in memory: a required tool's success is recorded under its entry key, and an advance writes the edge.
jest.mock('../../lambda/src/lib/task-store', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-store');
  const machines = jest.requireActual('../../lambda/src/lib/task-state-machines');
  return {
    ...actual,
    recordToolRun: jest.fn(async (task: any, state: string, tool: string) => {
      const key = `tool:${tool}:${machines.actionRunKey(state, machines.entrySequenceOf(task.stateHistory, state))}`;
      task.actionRuns = [...new Set([...(task.actionRuns ?? []), key])];
      return { claimed: true, key };
    }),
    advanceTaskStateTo: jest.fn(async (args: any) => {
      const from = args.task.taskState;
      const def = args.machines[args.task.taskType]?.states?.[from];
      if (!def?.transitions.includes(args.toState)) return { ok: false, error: 'illegal_transition', from, legal: def?.transitions ?? [] };
      args.task.stateHistory = [...(args.task.stateHistory ?? []), { from, to: args.toState, at: new Date().toISOString(), by: args.by }];
      const terminal = args.machines[args.task.taskType]?.states?.[args.toState]?.terminal;
      if (terminal) args.task.status = 'completed';
      return { ok: true, from, to: args.toState, ...(terminal ? { terminal } : {}) };
    }),
  };
});

import { invokeBedrock, actAsAssistant, releaseAssistantIdentity } from '../../lambda/src/lib/async-processor-core';
import type { TaskLoopContext } from '../../lambda/src/lib/task-tools';
import { owedTransitionOf } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { ACCOUNT_BRIEF_INTENT, ACCOUNT_BRIEF_WORKFLOW } from '../../../demo/stratum-company/intent-packs';

const TOOL = 'load_company_context';
const BRIEF = 'Got everything I need. Drafting the brief now.\n\n# Coastal Health Systems\n\nRenewal 2026-12-01.\n\n---\n\n*Source: customer-accounts.json*';
const CONFIG = { model: 'anthropic.claude-sonnet', maxTokens: 4096, userType: 'premium' as const };
const MACHINES: Record<string, TaskStateMachine> = { [ACCOUNT_BRIEF_INTENT]: ACCOUNT_BRIEF_WORKFLOW };

const usage = { inputTokens: 100, outputTokens: 10 };
const callTool = (name: string, input: Record<string, unknown>, id = `t-${name}-${Math.random()}`) => ({
  stopReason: 'tool_use', usage,
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name, input } }] } },
});
const advance = (to: string) => callTool('advance_task_state', { to_state: to, reason: 'the step is done' });
const ends = (text: string) => ({ stopReason: 'end_turn', usage, output: { message: { role: 'assistant', content: text ? [{ text }] : [] } } });

function turnOn(state: string, over: Partial<Task> = {}, machines = MACHINES, taskType = ACCOUNT_BRIEF_INTENT): TaskLoopContext {
  return {
    task: {
      taskId: 'req-4b2dc08149a3', channelArn: 'arn:c', userArn: '', taskType, taskState: state, status: 'in_progress',
      assigneeId: 'advisor', assigneeType: 'assistant', details: {}, stateHistory: [], createdAt: 'now', updatedAt: 'now', ...over,
    } as unknown as Task,
    machines, initialState: state, transitions: [], assistantId: 'advisor',
  };
}
const run = (ctx: TaskLoopContext, request: string) =>
  invokeBedrock('sys', [{ role: 'user', content: request }], CONFIG, undefined, true, false, undefined, undefined, ctx);
/** The platform's notes in the conversation the model was sent (the loop's history is one array, appended to). */
const platformNotes = (): string[] => {
  const msgs = mockBedrockSend.mock.calls[0][0].input.messages as Array<{ role: string; content: Array<{ text?: string }> }>;
  return msgs.filter((m) => m.role === 'user')
    .map((m) => m.content.map((c) => c.text ?? '').join(''))
    .filter((t) => t.startsWith('Platform note'));
};

beforeAll(async () => {
  process.env.CONTEXT_BUCKET = 'test-context-bucket';
  await actAsAssistant('corr-owed-move');
});
afterAll(() => {
  delete process.env.CONTEXT_BUCKET;
  releaseAssistantIdentity();
});
beforeEach(() => mockBedrockSend.mockReset());

describe('the 03:18 turn: the record is read, the brief is written, and no move is taken', () => {
  it('is continued once, takes researching -> drafting -> completed, and the reply is the brief as written', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(callTool(TOOL, { documents: ['customer-accounts.json'] }))
      .mockResolvedValueOnce(ends(BRIEF))
      .mockResolvedValueOnce(advance('drafting'))
      .mockResolvedValueOnce(advance('completed'))
      .mockResolvedValueOnce(ends(''));
    const ctx = turnOn('researching', { correlationId: 'corr-1' } as Partial<Task>);
    const r = await run(ctx, 'Prepare an account brief on Coastal Health Systems for my renewal call tomorrow.');

    expect(ctx.task.taskState).toBe('completed');
    expect(ctx.transitions).toEqual([{ from: 'researching', to: 'drafting' }, { from: 'drafting', to: 'completed' }]);
    // The brief once, as written: nothing the continuation said is added when it wrote nothing.
    expect(r.response).toBe(BRIEF);
    // The continuation is the platform's note, from the record: the step, the tool that ran, the moves it offers.
    expect(mockBedrockSend).toHaveBeenCalledTimes(5);
    expect(platformNotes()).toHaveLength(1);
    const note = platformNotes()[0];
    expect(note).toContain('"researching"');
    expect(note).toContain(TOOL);
    expect(note).toContain('drafting');
    // Measured: the extra calls are steps of the turn, their tokens counted.
    expect(r.steps.map((s) => s.stepLabel)).toEqual([
      `tool:${TOOL}`, 'generate:owed-move', 'tool:advance_task_state', 'tool:advance_task_state', 'generate',
    ]);
    expect(r.inputTokens).toBe(500);
  });

  it('adds what the continuation wrote after it moved, after the reply the person already has', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(callTool(TOOL, {}))
      .mockResolvedValueOnce(ends('I have read the account record.'))
      .mockResolvedValueOnce(advance('drafting'))
      .mockResolvedValueOnce(ends('Here is the brief: renewal on 2026-12-01.'));
    const ctx = turnOn('researching');
    const r = await run(ctx, 'Brief me on Coastal Health Systems.');
    expect(ctx.task.taskState).toBe('drafting');
    expect(r.response).toBe('I have read the account record.\n\nHere is the brief: renewal on 2026-12-01.');
  });
});

describe('the following turn, on a task whose required tool ran on an earlier turn', () => {
  it('is continued the same way, and the task completes', async () => {
    const ran = `tool:${TOOL}:researching#0`;
    expect(owedTransitionOf(turnOn('researching', { actionRuns: [ran] } as Partial<Task>).task, MACHINES)).toMatchObject({ state: 'researching', next: ['drafting'] });
    mockBedrockSend
      .mockResolvedValueOnce(ends('The brief is already written above.'))
      .mockResolvedValueOnce(advance('drafting'))
      .mockResolvedValueOnce(advance('completed'))
      .mockResolvedValueOnce(ends(''));
    const ctx = turnOn('researching', { actionRuns: [ran] } as Partial<Task>);
    const r = await run(ctx, 'Please go ahead and write the brief now.');
    expect(ctx.task.taskState).toBe('completed');
    expect(r.response).toBe('The brief is already written above.');
  });
});

describe('DENY: a turn that legitimately stays in its step is not pushed', () => {
  const waiting: Record<string, TaskStateMachine> = {
    vetting: {
      initial: 'asking',
      states: {
        asking: { transitions: ['done'], awaits: { party: 'requester' }, tools: [TOOL], requiresTool: [TOOL], prompt: 'Look it up, then ask which account they mean.' },
        done: { transitions: [], terminal: 'success' },
      },
    },
  };

  it('a step waiting on the person: its tool ran and it asked a question, and the turn ends there', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(callTool(TOOL, {}))
      .mockResolvedValueOnce(ends('There are two Coastal accounts. Which one do you mean?'));
    const ctx = turnOn('asking', {}, waiting, 'vetting');
    const r = await run(ctx, 'Check the Coastal account.');
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(ctx.task.taskState).toBe('asking');
    expect(r.response).toBe('There are two Coastal accounts. Which one do you mean?');
    expect(r.steps.map((s) => s.stepLabel)).not.toContain('generate:owed-move');
  });

  it('a step that declares no required tool (drafting) ends where it is', async () => {
    mockBedrockSend.mockResolvedValueOnce(ends('Working on it.'));
    const ctx = turnOn('drafting', { stateHistory: [{ from: 'researching', to: 'drafting', at: 'x' }] } as Partial<Task>);
    await run(ctx, 'How is it going?');
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(ctx.task.taskState).toBe('drafting');
  });

  it('a step whose required tool has not run is not continued, so the requirement still binds', async () => {
    mockBedrockSend.mockResolvedValueOnce(ends('Let me think about which account you mean.'));
    const ctx = turnOn('researching');
    await run(ctx, 'Brief me on Coastal.');
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(owedTransitionOf(ctx.task, MACHINES)).toBeNull();
  });

  it('a requester\'s turn on a task someone else holds is not continued', async () => {
    mockBedrockSend.mockResolvedValueOnce(ends('It is with the account team.'));
    const ctx = { ...turnOn('researching', { actionRuns: [`tool:${TOOL}:researching#0`] } as Partial<Task>), requesterMoves: ['cancelled'] };
    await run(ctx, 'Where is my brief?');
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it('a model that declines in the continuation leaves the task and the reply as they were, and is asked once', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(callTool(TOOL, {}))
      .mockResolvedValueOnce(ends('I read the record; one figure is missing, so I am checking again.'))
      .mockResolvedValueOnce(ends('The step is not done yet.'));
    const ctx = turnOn('researching');
    const r = await run(ctx, 'Brief me on Coastal.');
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    expect(platformNotes()).toHaveLength(1);
    expect(ctx.task.taskState).toBe('researching');
    expect(r.response).toBe('I read the record; one figure is missing, so I am checking again.');
  });

  it('a step the platform moves (auto), one that rests and a finished task owe nothing from the model', () => {
    const ran = { actionRuns: [`tool:${TOOL}:researching#0`] } as Partial<Task>;
    for (const extra of [{ auto: 'drafting' }, { rests: true }]) {
      const m = { [ACCOUNT_BRIEF_INTENT]: { ...ACCOUNT_BRIEF_WORKFLOW, states: { ...ACCOUNT_BRIEF_WORKFLOW.states, researching: { ...ACCOUNT_BRIEF_WORKFLOW.states.researching, ...extra } } } };
      expect(owedTransitionOf(turnOn('researching', ran, m).task, m)).toBeNull();
    }
    expect(owedTransitionOf(turnOn('researching', { ...ran, status: 'completed' } as Partial<Task>).task, MACHINES)).toBeNull();
  });
});
