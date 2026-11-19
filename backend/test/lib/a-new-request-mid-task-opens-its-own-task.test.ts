/**
 * A NEW REQUEST MID-TASK OPENS ITS OWN TASK (ADR-067 Appendix A, G15; WT106).
 *
 * What it proves: a task's turn is offered `open_new_request` with the pack's other multi-step intents as a closed enum,
 * and not where there is none; a call opens the request through the turn's door once, and the task the turn is on does
 * not move; an intent outside the set and a second call on the same turn are refused (DENY); the task service names the
 * opened request to the router, which starts its intent's workflow on it, and records the run on it only while it awaits
 * one (DENY: a task of another type than its intent, a task that awaits nothing).
 */
const mockBedrockSend = jest.fn();
const mockSend = jest.fn();
const mockTags = jest.fn();
const mockName = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockTags(...a); },
  ListTagsForResourceCommand: class { constructor(public input: any) {} },
  ListChannelMessagesCommand: jest.fn(), UpdateChannelMessageCommand: jest.fn(), SendChannelMessageCommand: jest.fn(), DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })), InvokeCommand: jest.fn(), InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  QueryCommand: class { __t = 'Query'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
  PutCommand: class { __t = 'Put'; constructor(public input: any) {} },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  DeleteCommand: class { __t = 'Delete'; constructor(public input: any) {} },
  ScanCommand: class { __t = 'Scan'; constructor(public input: any) {} },
}), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn(async () => ({ documents: [] })) }));
jest.mock('../../lambda/src/lib/default-agents', () => ({ liveAssistantsForClassification: jest.fn(async () => []) }));
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  ...jest.requireActual('../../lambda/src/lib/say-through-router'),
  nameTaskThroughRouter: (...a: unknown[]) => mockName(...a),
}));

process.env.TASKS_TABLE = 'tasks';
process.env.USER_TASKS_TABLE = 'user-tasks';
process.env.SERVICE_CLASSIFICATION = 'standard';

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { invokeBedrock } from '../../lambda/src/lib/async-processor-core';
import type { TaskLoopContext } from '../../lambda/src/lib/task-tools';
import { TASK_TOOL_NAMES } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { newRequestIntents, newRequestOf, openNewRequestToolSpec, OPEN_NEW_REQUEST_TOOL_NAME } from '../../lambda/src/lib/new-request-tool';
import { requestAwaitingRun } from '../../lambda/src/lib/workflow-task';
import { isKnownTool } from '../../lambda/src/lib/tool-registry';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../../lambda/src/task-service');

const PACK = { intents: [
  { key: 'support_request', delivery: 'TASK_MULTI_STEP' },
  { key: 'report_generation', delivery: 'TASK_MULTI_STEP' },
  { key: 'general_question', delivery: 'DIRECT' },
  { key: 'image_generation', delivery: 'TASK_MULTI_STEP' },
] };

describe('the intents a new request may be opened under', () => {
  it('are the pack\'s multi-step intents other than the task\'s own type and opening intent', () => {
    expect(newRequestIntents(PACK, { taskType: 'support_request' })).toEqual(['report_generation', 'image_generation']);
    expect(newRequestIntents(PACK, { taskType: 'queued_request', openingIntent: 'report_generation' })).toEqual(['support_request', 'image_generation']);
    expect(newRequestIntents({ intents: [{ key: 'support_request', delivery: 'TASK_MULTI_STEP' }] }, { taskType: 'support_request' })).toEqual([]);
  });

  it('is a closed enum on the tool, held again when the call arrives', () => {
    const spec = openNewRequestToolSpec(['report_generation']);
    expect(spec.toolSpec.inputSchema.json.properties.intent.enum).toEqual(['report_generation']);
    expect(newRequestOf({ intent: 'report_generation', request: ' A Q3 report ' }, ['report_generation'])).toEqual({ intent: 'report_generation', request: 'A Q3 report' });
    expect(newRequestOf({ intent: 'delete_everything', request: 'x' }, ['report_generation'])).toHaveProperty('error');
    expect(newRequestOf({ intent: 'report_generation', request: '  ' }, ['report_generation'])).toHaveProperty('error');
    expect(isKnownTool(OPEN_NEW_REQUEST_TOOL_NAME)).toBe(true);
    expect(TASK_TOOL_NAMES.has(OPEN_NEW_REQUEST_TOOL_NAME)).toBe(true);
  });
});

describe('a task\'s turn opens the new request and leaves its task where it is', () => {
  const turn = (): TaskLoopContext => ({
    task: {
      taskId: 't-1', channelArn: 'arn:c', userArn: '', taskType: 'support_request', taskState: 'diagnosing', status: 'in_progress',
      assigneeId: 'advisor', assigneeType: 'assistant', assistantId: 'advisor', details: {}, stateHistory: [], createdAt: 'now', updatedAt: 'now',
    } as unknown as Task,
    machines: DEFAULT_TASK_STATE_MACHINES, initialState: 'diagnosing', transitions: [], assistantId: 'advisor',
  });
  const call = (input: Record<string, unknown>, id = 'u1') => ({
    stopReason: 'tool_use',
    output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name: OPEN_NEW_REQUEST_TOOL_NAME, input } }] } },
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  const endTurn = (text: string) => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text }] } }, usage: { inputTokens: 100, outputTokens: 10 } });
  const offered = (i = 0) => mockBedrockSend.mock.calls[i][0].input.toolConfig?.tools?.map((t: any) => t.toolSpec.name) ?? [];
  /** Every tool result the loop returned, read from the history the last call carried. */
  const toolResults = () => JSON.stringify(mockBedrockSend.mock.calls[mockBedrockSend.mock.calls.length - 1][0].input.messages);

  beforeEach(() => mockBedrockSend.mockReset());

  it('opens it once through the turn\'s door, and the task does not move', async () => {
    const open = jest.fn(async () => ({ taskRef: 7 }));
    mockBedrockSend
      .mockResolvedValueOnce(call({ intent: 'report_generation', request: 'A Q3 report' }))
      .mockResolvedValueOnce(call({ intent: 'report_generation', request: 'A Q3 report again' }, 'u2'))
      .mockResolvedValueOnce(endTurn('I have opened the report as its own request.'));
    const ctx = turn();
    const config = { model: 'm', maxTokens: 512, userType: 'standard' as const, newRequest: { intents: ['report_generation'], open } };
    await invokeBedrock('sys', [{ role: 'user', content: 'also, can you write me a Q3 report?' }], config, undefined, false, false, undefined, undefined, ctx);
    expect(offered()).toContain(OPEN_NEW_REQUEST_TOOL_NAME);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('report_generation', 'A Q3 report');
    expect(toolResults()).toContain('"opened":true');
    // DENY: the second call on the same turn is refused.
    expect(toolResults()).toContain('already open from this message');
    expect(ctx.task.taskState).toBe('diagnosing');
    expect(ctx.transitions).toEqual([]);
  });

  it('DENY: an intent outside the offered set opens nothing', async () => {
    const open = jest.fn(async () => ({}));
    mockBedrockSend.mockResolvedValueOnce(call({ intent: 'support_request', request: 'x' })).mockResolvedValueOnce(endTurn('ok'));
    await invokeBedrock('sys', [{ role: 'user', content: 'x' }], { model: 'm', maxTokens: 512, userType: 'standard' as const, newRequest: { intents: ['report_generation'], open } }, undefined, false, false, undefined, undefined, turn());
    expect(open).not.toHaveBeenCalled();
    expect(toolResults()).toContain('intent must be one of');
  });

  it('is not offered with no other intent, nor outside a task, nor where the allowlist withholds the task tools', async () => {
    mockBedrockSend.mockResolvedValue(endTurn('hi'));
    await invokeBedrock('sys', [{ role: 'user', content: 'hi' }], { model: 'm', maxTokens: 512, userType: 'standard' as const, newRequest: { intents: [], open: jest.fn() } }, undefined, false, false, undefined, undefined, turn());
    await invokeBedrock('sys', [{ role: 'user', content: 'hi' }], { model: 'm', maxTokens: 512, userType: 'standard' as const, newRequest: { intents: ['report_generation'], open: jest.fn() } }, undefined, false);
    await invokeBedrock('sys', [{ role: 'user', content: 'hi' }], { model: 'm', maxTokens: 512, userType: 'standard' as const, tools: ['load_company_context'], newRequest: { intents: ['report_generation'], open: jest.fn() } }, undefined, false, false, undefined, undefined, turn());
    expect(offered(0)).not.toContain(OPEN_NEW_REQUEST_TOOL_NAME);
    expect(offered(1)).not.toContain(OPEN_NEW_REQUEST_TOOL_NAME);
    expect(offered(2)).not.toContain(OPEN_NEW_REQUEST_TOOL_NAME);
  });
});

describe('the opened request awaits its intent\'s run', () => {
  const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
  let seq = 0;
  const nextChannel = () => `${I}/channel/midtask${++seq}`;
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({});
    mockTags.mockReset().mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
    mockName.mockReset().mockResolvedValue(true);
  });

  it('the task service opens it awaiting its run and names it to the router', async () => {
    const CH = nextChannel();
    const task = await svc.openTask({
      event: { inputTranscript: 'A Q3 report', requestAttributes: { 'CHIME.channel.arn': CH, 'CHIME.sender.arn': `${I}/user/asker` } },
      deliveryOption: 'TASK_MULTI_STEP', taskType: 'report_generation', correlationId: 'corr-1',
      opts: { assistantId: 'advisor', openingIntent: 'report_generation', userMessageId: 'msg-9', awaitsIntentRun: true, visibility: 'private' },
    });
    expect(task).toMatchObject({ taskType: 'report_generation', openingIntent: 'report_generation', userMessageId: 'msg-9', awaitsIntentRun: true, visibility: 'private' });
    expect(mockName).toHaveBeenCalledWith('standard', { kind: 'request', channelArn: CH, taskId: task.taskId });
  });

  it('a task opened any other way is named nothing', async () => {
    const CH = nextChannel();
    await svc.openTask({
      event: { inputTranscript: 'x', requestAttributes: { 'CHIME.channel.arn': CH, 'CHIME.sender.arn': `${I}/user/asker` } },
      deliveryOption: 'TASK_MULTI_STEP', taskType: 'report_generation', correlationId: 'corr-1',
      opts: { assistantId: 'advisor', openingIntent: 'report_generation', userMessageId: 'msg-9' },
    });
    expect(mockName.mock.calls.filter((c) => c[1]?.kind === 'request')).toEqual([]);
  });

  it('takes its run only while it awaits one, under its own intent', () => {
    const base = { taskType: 'report_generation', taskState: 'gathering', openingIntent: 'report_generation', userMessageId: 'm' };
    expect(requestAwaitingRun({ ...base, awaitsIntentRun: true })).toBe(true);
    // DENY: awaits nothing, is of another type than its intent, or already has its run.
    expect(requestAwaitingRun(base)).toBe(false);
    expect(requestAwaitingRun({ ...base, taskType: 'support_request', awaitsIntentRun: true })).toBe(false);
    expect(requestAwaitingRun({ ...base, awaitsIntentRun: true, workflowRun: { runKey: 'k' } as never })).toBe(false);
  });

  it('the run\'s write clears the mark in the same conditional write', async () => {
    const CH = nextChannel();
    mockSend.mockImplementation(async (cmd: any) => (cmd.__t === 'Get'
      ? { Item: { taskId: 'r-1', channelArn: CH, taskType: 'report_generation', taskState: 'gathering', openingIntent: 'report_generation', userMessageId: 'msg-9', awaitsIntentRun: true } }
      : {}));
    await svc.attachRequestRunOp({ taskId: 'r-1', channelArn: CH, workflowRun: { runKey: 'intent#msg-9#advisor', workflow: 'report_generation', step: 'work', event: 'intent', botArn: `${I}/bot/advisor`, values: {} } });
    const write = mockSend.mock.calls.map((c) => c[0]).find((c: any) => c.__t === 'Update' && c.input.TableName === 'tasks');
    expect(write.input.UpdateExpression).toBe('SET workflowRun = :run, updatedAt = :now REMOVE awaitsIntentRun');
  });

  it('the processor opens it for the sender, holding their message, as private as that message', () => {
    const proc = readFileSync(resolve(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    const block = proc.slice(proc.indexOf('// A NEW REQUEST MID-TASK (ADR-067 G15, WT106)'), proc.indexOf('model: cnBedrockModel ?? effectiveModel,'));
    expect(block).toMatch(/if \(isTriageTurn \|\| battleOn \|\| event\.taskCreated \|\| !turnTaskRow \|\| !sender\?\.includes\('\/user\/'\)\) return \{\};/);
    expect(block).toMatch(/'CHIME\.sender\.arn': sender/);
    expect(block).toMatch(/userMessageId: event\.userMessageId/);
    expect(block).toMatch(/visibility: await requestVisibility\(messagingClient, event\.channelArn, event\.userMessageId, event\.botArn\),/);
    expect(block).toMatch(/awaitsIntentRun: true/);
  });
});
