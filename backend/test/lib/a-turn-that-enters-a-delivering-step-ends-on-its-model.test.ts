/**
 * A TURN THAT ENTERS A DELIVERING STEP MID-TURN ENDS ON THAT STEP'S MODEL (ADR-064 decision B and decision 4).
 *
 * A confirming turn starts on the general route; its advance enters the step that delivers the document, and the rest of
 * the loop moves onto the report route. Driven here through `invokeBedrock`, the real tool loop, with the model mocked:
 *  - the loop returns the model it ended on and the step's choice (its fallback and the rule that chose it), and the
 *    resilient wrapper reports that model as the one used, so the turn's `bedrock_model` names the model that wrote it;
 *  - each call is a step priced on the model it ran on, so the turn is not priced at one rate;
 *  - the processor's follow-on calls (the corrections before delivery) run on the model the turn ended on and its
 *    fallback, and the turn's `model_from` names the rule that chose that model while `task_step` stays the step it
 *    started in;
 *  - the turns list prices a turn from its summed steps, and returns the step it ended in beside the one it started in.
 *
 * THE DOCUMENT IS WRITTEN ON THE STEP'S MODEL (decision B). Where the delivering step's model is not the one the turn is
 * running on, the move into it is accepted without the document and the step's model declares it (`deliver_document`);
 * where the models are the same the document still rides the move. A turn that enters the step and ends without the
 * document leaves the task waiting there, and the pickup (ADR-063) writes it on the step's model; a step delivered from
 * in its current entry is not taken up again. The version a turn serves, an experiment arm's included, decides which
 * model the step runs on, and a pickup turn serves the task's arm.
 */
const mockBedrockSend = jest.fn();
const mockResolveTaskArm = jest.fn();
jest.mock('../../lambda/src/lib/experiment-manager', () => ({
  ...jest.requireActual('../../lambda/src/lib/experiment-manager'),
  resolveTaskArm: (...args: unknown[]) => mockResolveTaskArm(...args),
}));
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
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn(async () => ({ documents: [] })) }));
const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { invokeBedrock } from '../../lambda/src/lib/async-processor-core';
import { invokeBedrockWithFallback } from '../../lambda/src/lib/bedrock-resilience';
import { documentWrittenOnStep, enteredStepModel, modelTheTurnEndedOn, stepOutputOf, type StepModelChoice } from '../../lambda/src/lib/step-models';
import { estimateStepCostUsd } from '../../lambda/src/lib/model-rate-table';
import { handleAdvanceTaskStateTool, taskToolSpecsFor, type TaskLoopContext } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { buildTaskSystemPrompt } from '../../lambda/src/lib/task-step-prompt';
import { pickupReadiness } from '../../lambda/src/lib/workflow-task';
import { resolveModelPlan, routedModel } from '../../lambda/src/lib/resolve-model-plan';
import { buildIntentStrategy } from '../../lambda/src/lib/active-profile';
import { pickupArmFields } from '../../lambda/src/router-agent-handler';
import { getModelCatalog, type BackendModelDefinition, type BackendModelKey } from '../../lib/config/model-strategy';

process.env.ADMIN_IAM_ENFORCEMENT = 'true';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: analyticsHandler, flowTurnCost } = require('../../lambda/src/analytics-aurora/analytics-query');

const catalog = getModelCatalog('us-east-1', '111122223333') as Record<BackendModelKey, BackendModelDefinition>;
const HAIKU = catalog.haiku.bedrockModelId;
const SONNET = catalog.sonnet.bedrockModelId;
const OPUS = catalog.opus.bedrockModelId;
const BOT = 'advisor';

/** A report workflow in small: a confirming step that produces text, and a step that delivers the document. */
const REPORT: TaskStateMachine = {
  initial: 'confirming',
  states: {
    confirming: { transitions: ['writing'] },
    writing: { transitions: ['done'], produces: 'document' },
    done: { transitions: [], terminal: 'completed' },
  },
} as unknown as TaskStateMachine;

const confirmingTurn = (): TaskLoopContext => {
  const task = {
    taskId: 't-1', channelArn: 'arn:c', userArn: '', taskType: 'report', taskState: 'confirming', status: 'in_progress',
    assigneeId: BOT, assigneeType: 'assistant', workerId: BOT, workerType: 'assistant', assistantId: BOT,
    details: {}, stateHistory: [], createdAt: 'now', updatedAt: 'now',
  } as unknown as Task;
  return { task, machines: { report: REPORT }, initialState: 'confirming', transitions: [], assistantId: BOT };
};

/** The report route's choice for the step that delivers, as the processor's `stepModel` returns it. */
const REPORT_ROUTE: StepModelChoice = { modelId: SONNET, fallbackModelId: OPUS, from: 'route' };
const stepModel = (_type: string | undefined, state: string | undefined) => (state === 'writing' ? REPORT_ROUTE : undefined);
const config = { model: HAIKU, maxTokens: 1024, userType: 'premium' as const, stepModel };

// THE DOCUMENT IS WRITTEN ON THE STEP'S MODEL: the move into the step is made without it, and the step declares it.
const DOCUMENT = '# Q2 status\n\nProgress, risks and next steps.';
const advance = (to: string, document?: string) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'advance_task_state', input: { to_state: to, reason: 'the outline is approved', ...(document ? { document } : {}) } } }] } },
  usage: { inputTokens: 1000, outputTokens: 50 },
});
const deliver = (document: string) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u2', name: 'deliver_document', input: { document } } }] } },
  usage: { inputTokens: 2000, outputTokens: 1400 },
});
const endTurn = (text: string, usage = { inputTokens: 2000, outputTokens: 1400 }) => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text }] } }, usage });
const REPLY_USAGE = { inputTokens: 300, outputTokens: 40 };

/** The Converse calls the loop made: each one's model, and the tools it offered. */
const converseCalls = () => mockBedrockSend.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === 'Converse').map((c) => c.input);
/** What the loop handed back for each tool call, in order, read off the conversation the last call carried. */
const toolResults = (): Array<Record<string, unknown>> => {
  const calls = converseCalls();
  const messages = (calls[calls.length - 1]?.messages ?? []) as Array<{ content?: Array<{ toolResult?: { content: Array<{ json: Record<string, unknown> }> } }> }>;
  return messages.flatMap((m) => (m.content ?? []).flatMap((b) => (b.toolResult ? [b.toolResult.content[0].json] : [])));
};
const offeredTool = (input: { toolConfig?: { tools: Array<{ toolSpec: { name: string; description: string } }> } }, name: string) =>
  input.toolConfig?.tools.find((t) => t.toolSpec.name === name)?.toolSpec;

beforeEach(() => {
  mockBedrockSend.mockReset();
  mockDbQuery.mockReset().mockResolvedValue({ rows: [] });
  mockResolveTaskArm.mockReset();
});

describe('the loop ends on the model of the step the task entered', () => {
  it('moves onto the report route after the advance, writes the document there, and returns that model with its fallback and rule', async () => {
    mockBedrockSend.mockResolvedValueOnce(advance('writing')).mockResolvedValueOnce(deliver(DOCUMENT)).mockResolvedValueOnce(endTurn('Here is the report.', REPLY_USAGE));
    const ctx = confirmingTurn();
    const r = await invokeBedrock('sys', [{ role: 'user', content: 'Looks good.' }], config, undefined, false, false, undefined, undefined, ctx);
    expect(converseCalls().map((c) => c.modelId)).toEqual([HAIKU, SONNET, SONNET]);
    expect(ctx.task.taskState).toBe('writing');
    expect(ctx.declaredDocument).toBe(DOCUMENT);
    expect(r.model).toBe(SONNET);
    expect(r.enteredStep).toEqual(REPORT_ROUTE);
  });

  it('prices each call on the model it ran on, so a turn on two models is not priced at one rate', async () => {
    mockBedrockSend.mockResolvedValueOnce(advance('writing')).mockResolvedValueOnce(deliver(DOCUMENT)).mockResolvedValueOnce(endTurn('Here is the report.', REPLY_USAGE));
    const r = await invokeBedrock('sys', [{ role: 'user', content: 'Looks good.' }], config, undefined, false, false, undefined, undefined, confirmingTurn());
    const modelSteps = r.steps.filter((s) => s.modelId !== 'platform');
    expect(modelSteps.map((s) => s.modelId)).toEqual([HAIKU, SONNET, SONNET]);
    const haikuCost = estimateStepCostUsd({ modelId: HAIKU, tokensIn: 1000, tokensOut: 50 });
    const documentCost = estimateStepCostUsd({ modelId: SONNET, tokensIn: 2000, tokensOut: 1400 });
    const replyCost = estimateStepCostUsd({ modelId: SONNET, tokensIn: 300, tokensOut: 40 });
    expect(modelSteps.map((s) => s.estCostUsd)).toEqual([haikuCost, documentCost, replyCost]);
    // The turn's tokens are every call's; priced at the sonnet rate alone they would cost more than the steps did.
    expect(r.inputTokens).toBe(3300);
    expect(r.outputTokens).toBe(1490);
    const atOneRate = estimateStepCostUsd({ modelId: SONNET, tokensIn: r.inputTokens, tokensOut: r.outputTokens })!;
    expect(atOneRate).toBeGreaterThan(haikuCost! + documentCost! + replyCost!);
  });

  it('keeps the turn\'s model, and names no step choice, where the task enters no step with a model of its own', async () => {
    mockBedrockSend.mockResolvedValueOnce(endTurn('Shall I write it?'));
    const r = await invokeBedrock('sys', [{ role: 'user', content: 'Looks good.' }], config, undefined, false, false, undefined, undefined, confirmingTurn());
    expect(r.model).toBe(HAIKU);
    expect(r.enteredStep).toBeUndefined();
  });

  it('the resilient wrapper reports the model that wrote the reply as the one used', async () => {
    mockBedrockSend.mockResolvedValueOnce(advance('writing')).mockResolvedValueOnce(deliver(DOCUMENT)).mockResolvedValueOnce(endTurn('Here is the report.', REPLY_USAGE));
    const r = await invokeBedrockWithFallback('sys', [{ role: 'user', content: 'Looks good.' }], config, HAIKU, { taskContext: confirmingTurn() });
    expect(r.modelUsed).toBe(SONNET);
    expect(r.wasFallback).toBe(false);
    expect(r.enteredStep).toEqual(REPORT_ROUTE);
  });
});

describe('the document is written on the model of the step it belongs to (decision B)', () => {
  it('different model: the move is accepted without the document, and the step\'s model writes it', async () => {
    // The starting model passes a document anyway; the move is accepted, and only the step's model's document is declared.
    mockBedrockSend.mockResolvedValueOnce(advance('writing', 'a draft on the confirming model'))
      .mockResolvedValueOnce(deliver(DOCUMENT)).mockResolvedValueOnce(endTurn('Here is the report.', REPLY_USAGE));
    const ctx = confirmingTurn();
    await invokeBedrock('sys', [{ role: 'user', content: 'Looks good.' }], config, undefined, false, false, undefined, undefined, ctx);
    const [moved, delivered] = toolResults();
    expect(moved).toMatchObject({ ok: true, to: 'writing', delivers: true, writes_document: true });
    expect(moved).not.toHaveProperty('document_received');
    expect(String(moved.next)).toContain('deliver_document');
    expect(delivered).toMatchObject({ ok: true, document_received: true });
    expect(ctx.declaredDocument).toBe(DOCUMENT);
    // The model the turn started on is told the contract before it moves: the move carries no document, and the
    // declaration the step's model writes it with is offered from the start.
    const [first, second] = converseCalls();
    expect(first.modelId).toBe(HAIKU);
    expect(second.modelId).toBe(SONNET);
    expect(offeredTool(first, 'advance_task_state')!.description).toContain('Moving to "writing" starts the step that writes the document, on a model of its own: make the move without `document`.');
    expect(offeredTool(first, 'advance_task_state')!.description).not.toContain('hands over the finished document');
    expect(offeredTool(first, 'deliver_document')).toBeDefined();
  });

  it('same model: the document is still required on the move', async () => {
    const sameModel = { ...config, stepModel: (_t: string | undefined, s: string | undefined) => (s === 'writing' ? { modelId: HAIKU, fallbackModelId: null, from: 'route' } : undefined) };
    mockBedrockSend.mockResolvedValueOnce(advance('writing')).mockResolvedValueOnce(advance('writing', DOCUMENT)).mockResolvedValueOnce(endTurn('Here is the report.', REPLY_USAGE));
    const ctx = confirmingTurn();
    const r = await invokeBedrock('sys', [{ role: 'user', content: 'Looks good.' }], sameModel, undefined, false, false, undefined, undefined, ctx);
    const [refused, moved] = toolResults();
    expect(refused).toMatchObject({ ok: false, error: 'document_required' });
    expect(moved).toMatchObject({ ok: true, to: 'writing', document_received: true });
    expect(moved).not.toHaveProperty('writes_document');
    expect(ctx.declaredDocument).toBe(DOCUMENT);
    expect(converseCalls().map((c) => c.modelId)).toEqual([HAIKU, HAIKU, HAIKU]);
    expect(r.enteredStep).toBeUndefined();
    const first = converseCalls()[0];
    expect(offeredTool(first, 'advance_task_state')!.description).toContain('Moving to "writing" hands over the finished document: pass it whole in `document`.');
    expect(offeredTool(first, 'deliver_document')).toBeUndefined();
  });

  it('a turn whose model no step moves (an experiment, a routing rule or a duel chose it) still writes the document on the move', async () => {
    const ctx = confirmingTurn();
    const refused = await handleAdvanceTaskStateTool({ task: ctx.task, input: { to_state: 'writing', reason: 'approved' }, machines: ctx.machines });
    expect(refused.payload).toMatchObject({ ok: false, error: 'document_required' });
    const specs = taskToolSpecsFor('report', ctx.machines, 'confirming');
    expect(specs.map((s) => s.toolSpec.name)).toEqual(['advance_task_state']);
  });

  it('the step prompt names who writes the document, and the delivering contract names the declaration that follows the move', () => {
    const report = DEFAULT_TASK_STATE_MACHINES;
    const writtenThere = buildTaskSystemPrompt('report_generation', 'drafting_outline', report, undefined, (s) => s === 'generating');
    expect(writtenThere).toContain('advance to `generating` without a `document`: that step writes the document on a model of its own and declares it there with `deliver_document`.');
    const onTheMove = buildTaskSystemPrompt('report_generation', 'drafting_outline', report);
    expect(onTheMove).toContain('advance to that step and declare the document in that call');
    expect(onTheMove).not.toContain('without a `document`');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deliveringContract } = require('../../lambda/src/lib/task-tracking');
    expect(deliveringContract()).toContain('when the move into\n  this step carried no document, because this step writes it');
    // The processor renders the step's section again from the same builder once the turn's model is chosen.
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(src).toMatch(/const rendered = renderTaskStep\(\(state\) => documentWrittenOnStep\(\s*stepOutputOf\(turnMachines\[turnTaskType\]\?\.states\?\.\[state\]\), turnStepModel\(turnTaskType, state\), bedrockInvokeConfig\.model,/);
  });
});

describe('a turn that ends without the document leaves the task to the pickup, which writes it once', () => {
  const ENTERED = '2026-10-30T10:00:00.000Z';
  const waitingRow = (over: Partial<Task> = {}) => ({
    ...confirmingTurn().task, taskState: 'writing', turnsInState: 0, deliveries: [],
    stateHistory: [{ from: 'confirming', to: 'writing', at: ENTERED, by: 'tool' }], ...over,
  } as Task);

  it('no delivery before the turn ends: the task waits in the step, the pickup takes it up on the step\'s model, and writes it', async () => {
    mockBedrockSend.mockResolvedValueOnce(advance('writing')).mockResolvedValueOnce(endTurn('I am writing the report now.', REPLY_USAGE));
    const ctx = confirmingTurn();
    await invokeBedrock('sys', [{ role: 'user', content: 'Looks good.' }], config, undefined, false, false, undefined, undefined, ctx);
    expect(ctx.task.taskState).toBe('writing');
    expect(ctx.declaredDocument).toBeUndefined();
    // The row that turn leaves: moved into a new entry, worked by no turn there, nothing delivered from it.
    expect(pickupReadiness(waitingRow(), { report: REPORT }, BOT)).toEqual({ ready: true });

    // THE PICKUP TURN starts in the delivering step, so its plan routes it onto the step's model (the shipped report
    // workflow's generating step on the report route), and the declaration is offered from its first call.
    const routes = { general: { primary: 'haiku' }, report_generation: { primary: 'sonnet', fallback: 'opus' } };
    const plan = resolveModelPlan({
      classification: 'premium', intent: '', continuesActiveWork: true,
      task: { intent: 'report_generation', step: 'generating', produces: 'document' },
    }, { catalog, strategy: buildIntentStrategy({ byIntent: routes })!, models: { selected: ['haiku', 'sonnet', 'opus'], default: 'opus' }, routes });
    expect(plan).toMatchObject({ ref: { modelKey: 'sonnet' }, modelFrom: 'route' });

    mockBedrockSend.mockReset();
    mockBedrockSend.mockResolvedValueOnce(deliver(DOCUMENT)).mockResolvedValueOnce(endTurn('Here is the report.', REPLY_USAGE));
    const pickup: TaskLoopContext = { ...confirmingTurn(), initialState: 'writing' };
    pickup.task.taskState = 'writing';
    await invokeBedrock('sys', [{ role: 'user', content: 'Take up the step you hold.' }], { ...config, model: SONNET }, undefined, false, false, undefined, undefined, pickup);
    expect(converseCalls().map((c) => c.modelId)).toEqual([SONNET, SONNET]);
    expect(offeredTool(converseCalls()[0], 'deliver_document')).toBeDefined();
    expect(pickup.declaredDocument).toBe(DOCUMENT);
  });

  it('no double generation: a step delivered from in its current entry is not taken up again', () => {
    // Attached: the delivery closes the task, which then waits on nobody.
    expect(pickupReadiness(waitingRow({ taskState: 'done' }), { report: REPORT }, BOT)).toMatchObject({ hold: 'terminal' });
    // Posted inline, which leaves the task in the step: the record of that hand-over holds it.
    const inline = { name: 'posted inline', at: '2026-10-30T10:00:05.000Z', fromState: 'writing' };
    expect(pickupReadiness(waitingRow({ deliveries: [inline] }), { report: REPORT }, BOT)).toMatchObject({ hold: 'delivered-this-entry' });
    // A delivery from an earlier entry of the step does not hold a new one.
    const earlier = { ...inline, at: '2026-10-29T09:00:00.000Z' };
    expect(pickupReadiness(waitingRow({ deliveries: [earlier] }), { report: REPORT }, BOT)).toEqual({ ready: true });
    // The processor records a document posted inline on the task whether or not the step declares a template.
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(src).toMatch(/if \(event\.taskId\) \{\s*await recordTaskDelivery\(event\.taskId, event\.channelArn, \{\s*name: 'posted inline',/);
  });
});

describe('the version a turn serves decides which model writes the document', () => {
  const premium = { selected: ['haiku', 'sonnet', 'opus'], default: 'opus' };
  const baseRoutes = { general: { primary: 'haiku' }, report_generation: { primary: 'sonnet', fallback: 'opus' } };
  const armRoutes = { ...baseRoutes, report_generation: { ...baseRoutes.report_generation, steps: { generating: { primary: 'haiku' } } } };
  const report = DEFAULT_TASK_STATE_MACHINES.report_generation;
  /** The route's choice for a step of the report, under a version's routes, for a "looks good" turn. */
  const routedFor = (routes: Record<string, unknown>, step: string) => routedModel({
    classification: 'premium', intent: 'acknowledgment', continuesActiveWork: true,
    task: { intent: 'report_generation', step, produces: stepOutputOf(report.states[step]) },
  }, { catalog, strategy: buildIntentStrategy({ byIntent: routes as never })!, models: premium, routes: routes as never });
  /** Whether a confirming turn under these routes moves into generating without the document, as the processor decides it. */
  const writtenOnStepUnder = (routes: Record<string, unknown>) => documentWrittenOnStep(
    'document',
    enteredStepModel(routedFor(routes, 'generating'), 'document'),
    routedFor(routes, 'drafting_outline').primaryModelId,
  );

  it('an arm whose version runs the step on the turn\'s model keeps the document on the move; the base\'s does not', () => {
    expect(routedFor(baseRoutes, 'drafting_outline').primaryModelKey).toBe('haiku');
    expect(routedFor(baseRoutes, 'generating').primaryModelKey).toBe('sonnet');
    expect(routedFor(armRoutes, 'generating').primaryModelKey).toBe('haiku');
    expect(writtenOnStepUnder(baseRoutes)).toBe(true);
    expect(writtenOnStepUnder(armRoutes)).toBe(false);
    expect(documentWrittenOnStep('text', enteredStepModel(routedFor(baseRoutes, 'generating'), 'document'), HAIKU)).toBe(false);
    // The processor's `stepModel` reads the served version's routes: the arm's, which the router resolved for the task.
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(src).toMatch(/const activeProfile = event\.variantProfile\s*\?/);
    expect(src).toMatch(/const active = activeProfile;/);
    expect(src).toMatch(/\}, \{ catalog, strategy: profileStrategy, models: baseModelSelection, routes: active\.models\?\.byIntent \}\);\s*return enteredStepModel\(chosen, produces\);/);
  });

  it('a pickup turn serves the arm its task was opened under while the experiment holds it, and the live version after', async () => {
    const variantProfile = { profileName: 'advisor', configId: 'cfg-arm', models: { byIntent: armRoutes } };
    mockResolveTaskArm.mockResolvedValueOnce({
      experimentId: 'exp-1', variantId: 'arm-b', modelKey: 'haiku', bedrockModelId: HAIKU, variantProfile, variantVersion: 3,
      experimentType: 'intent', intent: 'report_generation',
    });
    const task = { experimentArm: { experimentId: 'exp-1', variantId: 'arm-b' }, createdAt: '2026-10-29T00:00:00.000Z', channelArn: 'arn:c', taskType: 'report_generation' } as unknown as Task;
    const fields = await pickupArmFields(task);
    expect(mockResolveTaskArm).toHaveBeenCalledWith({ experimentId: 'exp-1', variantId: 'arm-b' }, '2026-10-29T00:00:00.000Z', expect.any(String), 'arn:c', expect.any(Object));
    expect(fields).toMatchObject({ variantProfile, variantVersion: 3, experimentId: 'exp-1', variantId: 'arm-b', routedVariant: expect.objectContaining({ modelKeys: ['haiku'] }) });
    // Once the experiment stops, the arm is not served and the live version takes the turn.
    mockResolveTaskArm.mockResolvedValueOnce(null);
    expect(await pickupArmFields(task)).toEqual({});
    // A task opened under no arm reads nothing.
    mockResolveTaskArm.mockClear();
    expect(await pickupArmFields({ ...task, experimentArm: undefined } as Task)).toEqual({});
    expect(mockResolveTaskArm).not.toHaveBeenCalled();
    // The dispatch carries it.
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/taskPickup: \{ taskId: task\.taskId, state: task\.taskState \},\s*\.\.\.await pickupArmFields\(task\),/);
  });
});

describe('what the turn ran its follow-on calls on and what it records', () => {
  const start = { model: HAIKU, fallbackModelId: null, modelFrom: 'general' };

  it('a step that delivers a document, or one the version overrides, has a model of its own; any other step does not', () => {
    expect(enteredStepModel({ from: 'route', primaryModelId: SONNET, fallbackModelId: OPUS }, 'document')).toEqual(REPORT_ROUTE);
    expect(enteredStepModel({ from: 'step', primaryModelId: OPUS, fallbackModelId: null }, 'text')).toEqual({ modelId: OPUS, fallbackModelId: null, from: 'step' });
    expect(enteredStepModel({ from: 'general', primaryModelId: HAIKU, fallbackModelId: null }, 'text')).toBeUndefined();
  });

  it('a turn that entered such a step ends on its model, its fallback and the rule that chose it', () => {
    expect(modelTheTurnEndedOn(start, REPORT_ROUTE)).toEqual({ model: SONNET, fallbackModelId: OPUS, modelFrom: 'route' });
    expect(modelTheTurnEndedOn(start, undefined)).toBe(start);
  });

  it('the processor runs every correction on the model the turn ended on, records its rule, and adds each call to the turn', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    const after = src.slice(src.indexOf('const endedOn = modelTheTurnEndedOn('));
    expect(after.length).toBeLessThan(src.length);
    expect(after).toContain('modelChoice.modelFrom = endedOn.modelFrom;');
    // No call after the loop runs on the turn's starting model and its fallback.
    expect(after).not.toMatch(/invokeConfig,\s*resolution\.fallbackModelId/);
    const corrections = after.match(/invokeBedrockWithFallback\([\s\S]*?\n\s*\);/g) ?? [];
    expect(corrections.length).toBe(2);
    for (const call of corrections) expect(call).toMatch(/followOnConfig,\s*endedOn\.fallbackModelId,/);
    expect(after.match(/recordFollowOn\('correction-(answer|deliverable)', corrected\)/g)?.length).toBe(2);
    expect(after).toContain('steps: followOnSteps.length ? [...(bedrockResult.steps ?? []), ...followOnSteps] : bedrockResult.steps');
    expect(after).toContain('model: bedrockResult.modelUsed,');
  });
});

describe('the turns list prices a turn from its steps and names the step it ended in', () => {
  const SUB = '11111111-2222-3333-4444-555555555555';
  const teamPost = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
    httpMethod: 'POST',
    path: '/analytics/assistants/analyst/query',
    pathParameters: { assistant: 'analyst' },
    body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-30' }, ...body }),
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
  } as unknown as APIGatewayProxyEvent);

  it('sums the steps where every step recorded a cost, and prices the tokens on the row\'s model otherwise', () => {
    const row = { bedrock_model: SONNET, input_tokens: 3000, output_tokens: 1450 };
    expect(flowTurnCost({ ...row, steps_cost: { steps: 2, usd: 0.0123, unpriced: 0 } })).toEqual({ ...row, cost_usd: 0.0123 });
    const byTokens = estimateStepCostUsd({ modelId: SONNET, tokensIn: 3000, tokensOut: 1450 });
    expect(flowTurnCost({ ...row, steps_cost: { steps: 2, usd: 0.01, unpriced: 1 } }).cost_usd).toBe(byTokens);
    expect(flowTurnCost({ ...row, steps_cost: { steps: 0, usd: null, unpriced: 0 } }).cost_usd).toBe(byTokens);
    expect(flowTurnCost(row).cost_usd).toBe(byTokens);
  });

  it('flow_turns reads the steps\' cost and the step the turn ended in, and returns no steps_cost', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ message_id: 'm-1', bedrock_model: SONNET, input_tokens: 1, output_tokens: 1, task_step: 'confirming', task_state: 'writing', steps_cost: { steps: 2, usd: 0.5, unpriced: 0 } }] });
    const res = await analyticsHandler(teamPost({ queryType: 'flow_turns' }));
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toContain('e.task_type, e.task_step, e.task_state, e.model_kind, e.model_from');
    expect(sql).toMatch(/jsonb_array_elements\(CASE WHEN jsonb_typeof\(COALESCE\(upd\.metadata, m\.metadata\)->'steps'\) = 'array'/);
    const data = JSON.parse(res.body).data;
    expect(data[0]).toMatchObject({ task_step: 'confirming', task_state: 'writing', cost_usd: 0.5 });
    expect(data[0]).not.toHaveProperty('steps_cost');
  });
});
