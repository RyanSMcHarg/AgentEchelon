/**
 * A QUIET STEP RUNS WITH NO MODEL AND NO MESSAGE (DESIGN-CONVERSATION-DASHBOARDS section 8.1).
 *
 * Driven through `invokeBedrock`, the real tool loop, with the model, the dashboard publisher and the task store mocked. A
 * `dashboard_runbook` task taken up as a quiet step runs its declared action on the assistant's own session, draws the
 * runbook it carries on each dashboard already published, takes its edge marked quiet, and ends the turn: no model call and
 * no message (DENY). The runbook is taken only from a step a platform machine declares: a model's call that carries one
 * draws none of it, and neither does a version's own machine declaring the same arguments (DENY).
 */
const mockBedrockSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockRefresh = jest.fn();
const mockPublish = jest.fn();
const mockClaim = jest.fn();
const mockAdvance = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMessagesCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(),
  DeleteChannelMessageCommand: jest.fn(),
  DescribeChannelCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn(async () => ({ documents: [] })) }));
jest.mock('../../lambda/src/lib/dashboard-tool', () => ({
  ...jest.requireActual('../../lambda/src/lib/dashboard-tool'),
  refreshDashboardRunbook: (...a: unknown[]) => mockRefresh(...a),
  publishDashboard: (...a: unknown[]) => mockPublish(...a),
}));
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  claimStateAction: (...a: unknown[]) => mockClaim(...a),
  advanceTaskStateTo: (...a: unknown[]) => mockAdvance(...a),
}));

import { invokeBedrock } from '../../lambda/src/lib/async-processor-core';
import { adoptAssistantSession, releaseAssistantSession } from '../../lambda/src/lib/assistant-session';
import { DEFAULT_TASK_STATE_MACHINES, DASHBOARD_RUNBOOK_MACHINE, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import type { TaskLoopContext } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import type { RunbookProgress } from '../../lambda/src/lib/runbook-progress';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
const CH = `${I}/channel/incident`;
const BOT = `${I}/bot/opsbot`;
const RUNBOOK: RunbookProgress = { asOf: '2026-11-20T10:00:00.000Z', workflow: 'incident', steps: [{ step: 'first-look', label: 'First look', status: 'done' }] };

const config = {
  model: 'anthropic.claude-3-haiku-20240307-v1:0', maxTokens: 1024, userType: 'premium' as const,
  tools: ['publish_dashboard'],
  conversation: { channelArn: CH, classification: 'premium', botArn: BOT, assistant: 'ops-premium' },
};

const ctxFor = (taskType: string, machines: Record<string, TaskStateMachine>, quiet = true): TaskLoopContext => {
  const task = {
    taskId: 'evt-r', channelArn: CH, userArn: '', taskType, taskState: 'drawing', status: 'pending',
    details: { runbook: JSON.stringify(RUNBOOK) }, stateHistory: [], createdAt: 'now', updatedAt: 'now',
  } as unknown as Task;
  return { task, machines, initialState: 'drawing', transitions: [], ...(quiet ? { quiet: true as const } : {}) };
};

beforeEach(() => {
  mockBedrockSend.mockReset();
  mockMessagingSend.mockReset().mockResolvedValue({});
  mockRefresh.mockReset().mockResolvedValue([{ published: true, kind: 'snapshot' }]);
  mockPublish.mockReset().mockResolvedValue({ published: true, kind: 'snapshot' });
  mockClaim.mockReset().mockResolvedValue({ claimed: true, key: 'drawing#0' });
  mockAdvance.mockReset().mockImplementation(async (a: { toState: string }) => ({ ok: true, from: 'drawing', to: a.toState, terminal: a.toState === 'drawn' ? 'success' : 'failure' }));
  process.env.DASHBOARD_BUCKET = 'dashboards';
  adoptAssistantSession({ assistant: 'ops-premium', role: 'ops', botArn: BOT, credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' } });
});
afterEach(() => {
  releaseAssistantSession();
  delete process.env.DASHBOARD_BUCKET;
});

describe('a quiet step taken up', () => {
  it('runs its declared action on the assistant\'s session and ends the turn: no model call and no message', async () => {
    const ctx = ctxFor(DASHBOARD_RUNBOOK_MACHINE, DEFAULT_TASK_STATE_MACHINES);
    const r = await invokeBedrock('', [], config, undefined, false, false, undefined, undefined, ctx);

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockMessagingSend).not.toHaveBeenCalled();
    expect(r.response).toBe('');
    expect(r.inputTokens + r.outputTokens).toBe(0);
    // The runbook the task carries, drawn on the dashboards already published that this turn may publish.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.calls[0][0]).toMatchObject({ runbook: RUNBOOK, modes: ['snapshot'], channelArn: CH, botArn: BOT });
    expect(mockPublish).not.toHaveBeenCalled();
    // Its edge is marked quiet, so the task service closes and archives the settlement no message carries.
    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({ toState: 'drawn', by: 'system', quiet: true, action: { tool: 'publish_dashboard', outcome: 'success' } }));
    // The step is the turn's measured record: a platform action, at no model cost.
    expect(r.steps).toEqual([expect.objectContaining({ stepLabel: 'platform-action:publish_dashboard', modelId: 'platform', estCostUsd: 0 })]);
  });

  it('a step whose drawing fails takes its failure edge, still with no model call', async () => {
    mockRefresh.mockResolvedValue([{ published: false, error: 'AccessDenied' }]);
    const ctx = ctxFor(DASHBOARD_RUNBOOK_MACHINE, DEFAULT_TASK_STATE_MACHINES);
    await invokeBedrock('', [], config, undefined, false, false, undefined, undefined, ctx);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({ toState: 'failed', quiet: true }));
  });

  it('DENY: a turn whose allowlist does not offer the dashboard tool draws nothing', async () => {
    const ctx = ctxFor(DASHBOARD_RUNBOOK_MACHINE, DEFAULT_TASK_STATE_MACHINES);
    await invokeBedrock('', [], { ...config, tools: ['read_deployment_health'] }, undefined, false, false, undefined, undefined, ctx);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });
});

describe('the runbook is taken only from a platform machine\'s declared step', () => {
  it('DENY: a model\'s publish_dashboard call that carries a runbook draws none of it', async () => {
    mockBedrockSend
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'publish_dashboard', input: { runbook: JSON.stringify(RUNBOOK), onlyIfPublished: true } } }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValueOnce({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: 'Published.' }] } }, usage: { inputTokens: 10, outputTokens: 5 } });
    await invokeBedrock('sys', [{ role: 'user', content: 'publish the dashboard' }], config);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).not.toHaveProperty('runbook');
    expect(mockPublish.mock.calls[0][0]).not.toHaveProperty('onlyIfPublished');
  });

  it('DENY: a version\'s own machine declaring the same arguments draws none of its runbook', async () => {
    const own = { my_refresh: DEFAULT_TASK_STATE_MACHINES[DASHBOARD_RUNBOOK_MACHINE] };
    const ctx = ctxFor('my_refresh', own);
    await invokeBedrock('', [], config, undefined, false, false, undefined, undefined, ctx);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockPublish.mock.calls.every((c) => !('runbook' in c[0]))).toBe(true);
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });
});

describe('the processor takes a quiet step from the task\'s own machine', () => {
  it('marks the turn quiet only where the state it was taken up in is quiet, and returns before anything is posted', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts'), 'utf8');
    const at = src.indexOf('if (event.taskPickup && taskContext && taskContext.task.taskState === event.taskPickup.state');
    expect(at).toBeGreaterThan(0);
    const branch = src.slice(at, src.indexOf('\n    }\n', at));
    expect(branch).toContain('isQuietStep(turnMachines[taskContext.task.taskType ?? \'\']?.states?.[event.taskPickup.state])');
    expect(branch).toContain('taskContext.quiet = true;');
    expect(branch).toContain('return;');
    expect(branch).not.toMatch(/sendChannelMessage|UpdateChannelMessage|invokeBedrockWithFallback/);
    // Before the attachment, the model call and every post of the ordinary turn.
    expect(at).toBeLessThan(src.indexOf('let imageInput: BedrockImageInput | undefined;'));
  });
});
