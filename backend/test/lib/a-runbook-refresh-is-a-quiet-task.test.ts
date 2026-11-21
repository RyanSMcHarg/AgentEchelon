/**
 * A RUN'S RUNBOOK REFRESH IS A QUIET TASK ON THE ESTABLISHED PATH (DESIGN-CONVERSATION-DASHBOARDS section 8.1).
 *
 * What it proves: the run opens one `dashboard_runbook` task through the task service, under the platform's own run, carrying
 * the progress as its opening details; one state of the run names one task, whatever the time it was read, so a second
 * refresh of the same state opens nothing; the task is never the conversation's open work, takes no reference and shows no
 * card; its settlement continues no run and the run's end leaves it alone; a quiet step's settlement is closed and archived
 * by the task service, since no message carries it; and only an assistant that offers the dashboard tool and advertises the
 * `dashboard_runbook` intent is given one (DENY: no tool, no allowlisted tool, no advertised intent).
 */
const mockSend = jest.fn();
const mockTags = jest.fn();
const mockLive = jest.fn();
const mockName = jest.fn();
const mockFact = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  QueryCommand: class { __t = 'Query'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
  PutCommand: class { __t = 'Put'; constructor(public input: any) {} },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  DeleteCommand: class { __t = 'Delete'; constructor(public input: any) {} },
  ScanCommand: class { __t = 'Scan'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockTags(...a); },
  ListTagsForResourceCommand: class { constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/default-agents', () => ({ liveAssistantsForClassification: (...a: unknown[]) => mockLive(...a) }));
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  ...jest.requireActual('../../lambda/src/lib/say-through-router'),
  nameTaskThroughRouter: (...a: unknown[]) => mockName(...a),
}));
jest.mock('../../lambda/src/lib/archive-facts', () => ({
  ...jest.requireActual('../../lambda/src/lib/archive-facts'),
  putTaskSettledFact: (...a: unknown[]) => mockFact(...a),
}));

process.env.TASKS_TABLE = 'tasks';
process.env.USER_TASKS_TABLE = 'user-tasks';
process.env.SERVICE_CLASSIFICATION = 'standard';

import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../../lambda/src/task-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tracking = require('../../lambda/src/lib/task-tracking');
import { DASHBOARD_RUNBOOK_MACHINE, DEFAULT_TASK_STATE_MACHINES, PLATFORM_MACHINE_KEYS, isQuietStep } from '../../lambda/src/lib/task-state-machines';
import { DASHBOARD_RUNBOOK_RUN, PLATFORM_RUN_NAMES, eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';
import { eventTaskId, runbookRefreshRunKey, runbookRefreshTaskId } from '../../lambda/src/lib/event-task';
import { runbookConsent } from '../../lambda/src/lib/dashboard-tool';
import { taskCardOf } from '../../lambda/src/lib/workflow-task';
import type { RunbookProgress } from '../../lambda/src/lib/runbook-progress';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
const OPS_BOT = `${I}/bot/opsbot`;
let seq = 0;
const nextChannel = () => `${I}/channel/runbook${++seq}`;

const RUN_KEY = 'alarm-state-changed#c#incident';
const progress = (asOf: string, status: 'in-progress' | 'done' = 'in-progress'): RunbookProgress => ({
  asOf, workflow: 'incident', steps: [{ step: 'first-look', label: 'First look', status }],
});

beforeEach(() => {
  mockSend.mockReset();
  mockFact.mockReset().mockResolvedValue(true);
  mockTags.mockReset().mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
  mockLive.mockReset().mockResolvedValue([{ botArn: OPS_BOT, role: 'ops', handle: 'ops' }]);
  mockName.mockReset().mockResolvedValue(true);
});

const puts = () => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === 'Put' && c.input.TableName === 'tasks');

const openRefresh = (channelArn: string, runbook: RunbookProgress, over: Record<string, unknown> = {}) => svc.openWorkflowTask({
  channelArn, taskId: runbookRefreshTaskId(RUN_KEY, runbook), machine: DASHBOARD_RUNBOOK_MACHINE, keepForSeconds: 3600,
  worker: { id: 'opsbot', type: 'assistant' }, assistantId: 'opsbot',
  workflowRun: { runKey: runbookRefreshRunKey(RUN_KEY), workflow: DASHBOARD_RUNBOOK_RUN, step: 'refresh', event: 'alarm-state-changed', botArn: OPS_BOT, values: {} },
  details: { runbook: JSON.stringify(runbook) },
  ...over,
});

describe('the refresh is the platform\'s quiet machine', () => {
  it('one step whose declared action draws the runbook, with no prompt, no choice and nobody awaited', () => {
    const m = DEFAULT_TASK_STATE_MACHINES[DASHBOARD_RUNBOOK_MACHINE];
    expect(PLATFORM_MACHINE_KEYS).toContain(DASHBOARD_RUNBOOK_MACHINE);
    expect(m.states.drawing.action).toEqual({ tool: 'publish_dashboard', args: { runbook: 'detail:runbook', onlyIfPublished: true } });
    for (const def of Object.values(m.states)) {
      expect(def.prompt).toBeUndefined();
      expect(def.choices).toBeUndefined();
      expect(def.awaits).toBeUndefined();
    }
    expect(isQuietStep(m.states.drawing)).toBe(true);
  });

  it('DENY: a step that speaks, or hands something to a reply, is never quiet', () => {
    // The alarm's refresh says one line once it publishes.
    expect(isQuietStep(DEFAULT_TASK_STATE_MACHINES.dashboard_refresh.states.publishing)).toBe(false);
    // A drawn image rides the turn's reply.
    expect(isQuietStep({ action: { tool: 'generate_image' } })).toBe(false);
    expect(isQuietStep({ action: { tool: 'deliver_document' } })).toBe(false);
    expect(isQuietStep({ action: { tool: 'publish_dashboard' }, produces: 'text' })).toBe(false);
    expect(isQuietStep({ prompt: 'x' })).toBe(false);
    expect(isQuietStep(undefined)).toBe(false);
  });

  it('DENY: no card, since no state offers a choice', () => {
    const t = { taskId: 'evt-r', channelArn: 'c', taskType: DASHBOARD_RUNBOOK_MACHINE, taskState: 'drawing', assigneeId: 'opsbot', assigneeType: 'assistant', stateHistory: [] };
    expect(taskCardOf(t as never, DEFAULT_TASK_STATE_MACHINES)).toBeFalsy();
  });
});

describe('one task per state of the run', () => {
  it('the same state names the same task whatever the time it was read, and a new state a new one', () => {
    const a = runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:00:00.000Z'));
    expect(runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:00:05.000Z'))).toBe(a);
    expect(runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:00:05.000Z', 'done'))).not.toBe(a);
    expect(runbookRefreshTaskId('another-run', progress('2026-11-20T10:00:00.000Z'))).not.toBe(a);
    expect(a).toMatch(/^evt-[0-9a-f]{24}$/);
  });

  it('a later move that returns the section to a state it showed before draws a new task; the same moves name the same one', () => {
    const first = runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:00:00.000Z'), ['after#lead-task=task:success:resolved']);
    const back = runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:30:00.000Z'), ['after#owner=task:opened']);
    expect(back).not.toBe(first);
    // THE SAME MOVES, in any order, are the same refresh: a run's claims are each won once, so only a redelivery could repeat them.
    expect(runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:00:09.000Z'), ['b=1', 'a=2'])).toBe(runbookRefreshTaskId(RUN_KEY, progress('2026-11-20T10:00:00.000Z'), ['a=2', 'b=1']));
    const router = read('router-agent-handler.ts');
    expect(router).toContain('if (won && (step === RUN_END_CLAIM || marks.has(baseOf(step)))) { moved = true; moves.push(`${step}=${outcome}`); }');
    expect(router).toContain('channelArn, taskId: runbookRefreshTaskId(runKey, runbook, moves), machine: DASHBOARD_RUNBOOK_MACHINE,');
  });

  it('opens under the platform\'s run, never the run\'s own, so the run\'s end and its steps never name it', () => {
    expect(runbookRefreshRunKey(RUN_KEY)).toBe(`${DASHBOARD_RUNBOOK_RUN}#${RUN_KEY}`);
    expect(runbookRefreshTaskId(RUN_KEY, progress('x'))).not.toBe(eventTaskId(RUN_KEY, 'first-look'));
    expect(PLATFORM_RUN_NAMES).toContain(DASHBOARD_RUNBOOK_RUN);
    expect(eventWorkflowErrors(DASHBOARD_RUNBOOK_RUN, { on: 'alarm-state-changed', initial: 'a', states: {} }).join(' ')).toMatch(/names a run the platform makes itself/);
  });

  it('the task service writes it with the progress, no reference, held by the assistant, and names it ready', async () => {
    const CH = nextChannel();
    let row: Record<string, unknown> | undefined;
    mockSend.mockImplementation(async (c: any) => {
      if (c.__t === 'Put' && c.input.TableName === 'tasks') row = c.input.Item;
      if (c.__t === 'Get') return { Item: row };
      return {};
    });
    const rb = progress('2026-11-20T10:00:00.000Z');
    const task = await openRefresh(CH, rb);
    expect(task).toMatchObject({ taskType: DASHBOARD_RUNBOOK_MACHINE, taskState: 'drawing', assigneeId: 'opsbot', assigneeType: 'assistant' });
    expect(JSON.parse(String(task.details.runbook))).toEqual(rb);
    expect(task.taskRef).toBeUndefined();
    expect(task.visibility).toBeUndefined();
    expect(mockName).toHaveBeenCalledWith('standard', { kind: 'ready', channelArn: CH, taskId: task.taskId });
  });

  it('DENY: a second refresh of the same state opens nothing and names nothing', async () => {
    const CH = nextChannel();
    const existing = { taskId: runbookRefreshTaskId(RUN_KEY, progress('a')), channelArn: CH, taskType: DASHBOARD_RUNBOOK_MACHINE, taskState: 'drawn', status: 'completed' };
    mockSend.mockImplementation(async (c: any) => (c.__t === 'Get' ? { Item: existing } : {}));
    const again = await openRefresh(CH, progress('b'));
    expect(again).toMatchObject({ taskId: existing.taskId, taskState: 'drawn' });
    expect(puts()).toEqual([]);
    expect(mockName).not.toHaveBeenCalled();
  });

  it('DENY: opening details that are not top-level text, or are over their bound, are refused and nothing is written', async () => {
    mockSend.mockResolvedValue({});
    expect(await openRefresh(nextChannel(), progress('a'), { details: { runbook: { nested: true } } })).toBeNull();
    expect(await openRefresh(nextChannel(), progress('a'), { details: { runbook: 'x'.repeat(svc.MAX_OPENING_DETAILS_CHARS + 1) } })).toBeNull();
    expect(await openRefresh(nextChannel(), progress('a'), { details: ['x'] })).toBeNull();
    expect(puts()).toEqual([]);
  });
});

describe('never the conversation\'s open work', () => {
  it('DENY: an open refresh is left out of the conversation\'s open tasks, while the rest are listed', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({ Items: [
      { taskId: 'evt-r', channelArn: CH, status: 'pending', taskType: DASHBOARD_RUNBOOK_MACHINE, taskState: 'drawing', assistantId: 'opsbot', visibility: 'conversation' },
      { taskId: 'evt-w', channelArn: CH, status: 'in_progress', taskType: 'incident_first_look', taskState: 'looking', assistantId: 'opsbot', visibility: 'conversation' },
    ] });
    const open = await tracking.getOpenTasksForConversation(CH, { limit: 10 });
    expect(open.map((t: { taskId: string }) => t.taskId)).toEqual(['evt-w']);
  });
});

describe('a quiet step\'s settlement is closed and archived by the task service', () => {
  const quietTask = (channelArn: string) => ({
    taskId: 'evt-r', channelArn, userArn: '', status: 'pending', taskType: DASHBOARD_RUNBOOK_MACHINE, taskState: 'drawing',
    assigneeId: 'opsbot', assigneeType: 'assistant', assistantId: 'opsbot', stateHistory: [],
    workflowRun: { runKey: runbookRefreshRunKey(RUN_KEY), workflow: DASHBOARD_RUNBOOK_RUN, step: 'refresh', event: 'alarm-state-changed', botArn: OPS_BOT },
    createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
  });

  it('the action\'s edge to its ending completes the task and records one platform-step fact', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({ Item: quietTask(CH) });
    const out = await svc.advanceTask({
      taskId: 'evt-r', channelArn: CH, toState: 'drawn', by: 'system', machines: DEFAULT_TASK_STATE_MACHINES,
      action: { tool: 'publish_dashboard', outcome: 'success' }, quiet: true,
    });
    expect(out).toMatchObject({ ok: true, to: 'drawn', terminal: 'success' });
    const status = mockSend.mock.calls.map((c) => c[0]).find((c: any) => c.__t === 'Update' && JSON.stringify(c.input).includes('completed'));
    expect(status).toBeDefined();
    expect(mockFact).toHaveBeenCalledTimes(1);
    expect(mockFact.mock.calls[0][0]).toMatchObject({
      cause: 'platform-step', taskId: 'evt-r', taskType: DASHBOARD_RUNBOOK_MACHINE, fromState: 'drawing', toState: 'drawn', terminal: 'success',
      action: { tool: 'publish_dashboard', outcome: 'success' }, runKey: runbookRefreshRunKey(RUN_KEY), workflow: DASHBOARD_RUNBOOK_RUN,
    });
  });

  it('DENY: a move a turn\'s message carries records no platform-step fact', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({ Item: quietTask(CH) });
    await svc.advanceTask({ taskId: 'evt-r', channelArn: CH, toState: 'drawn', by: 'system', machines: DEFAULT_TASK_STATE_MACHINES, action: { tool: 'publish_dashboard', outcome: 'success' } });
    expect(mockFact).not.toHaveBeenCalled();
  });
});

describe('who is given a runbook to draw', () => {
  it('an ops assistant whose version offers the tool and advertises the intent', () => {
    expect(runbookConsent({ role: 'ops', versionTools: ['publish_dashboard'], advertised: ['dashboard_runbook'] })).toBe('consents');
    expect(runbookConsent({ role: 'ops', versionTools: undefined, advertised: ['incident_first_look', 'dashboard_runbook'] })).toBe('consents');
  });

  it('DENY: a holder whose version lists the tool but advertises no dashboard_runbook intent gets nothing', () => {
    expect(runbookConsent({ role: 'ops', versionTools: ['publish_dashboard'], advertised: ['dashboard_refresh', 'incident_first_look'] })).toBe('unadvertised');
  });

  it('DENY: a holder without the dashboard tool gets nothing, whatever it advertises', () => {
    expect(runbookConsent({ role: 'primary', versionTools: ['publish_dashboard'], advertised: ['dashboard_runbook'] })).toBe('no-tool');
    expect(runbookConsent({ role: 'ops', versionTools: ['read_deployment_health'], advertised: ['dashboard_runbook'] })).toBe('no-tool');
    expect(runbookConsent({ role: '', versionTools: undefined, advertised: ['dashboard_runbook'] })).toBe('no-tool');
  });
});

describe('the router opens the task on the established path', () => {
  const router = read('router-agent-handler.ts');

  it('the run opens a refresh task for its consenting holder, and hands no processor a runbook payload', () => {
    expect(router).toContain('const holder = await dashboardHolder(ctx.channelArn, who, runKey);');
    expect(router).toContain('await openRunbookRefresh(ctx.channelArn, runKey, ctx.event, holder, runbook, drawnBy);');
    expect(router).toContain('const consent = runbookConsent({ role, versionTools: served.tools, advertised: (ad?.intents ?? []).map((i) => i.key) });');
    for (const f of ['router-agent-handler.ts', 'assistant-async-processor.ts', 'lib/async-processor-core.ts']) expect(read(f)).not.toContain('dashboardRefresh');
  });

  it('DENY: a settlement under a platform run continues no run', () => {
    expect(router).toContain("const own = PLATFORM_RUN_NAMES.includes(task.workflowRun?.workflow ?? '') ? undefined : task.workflowRun;");
  });

  it('a quiet step is taken up with nothing posted and no turn lock held', () => {
    expect(router).toContain('if (quietPickup(task, machines)) return dispatchTaskPickup(task, botArn, assistant.profile, correlationId, { quiet: true });');
    // Handed the lock at a turn's exit, it gives it back before it runs.
    expect(router).toMatch(/if \(quietPickup\(task, machines\)\) \{\s*await release\(\);\s*return dispatchTaskPickup\(task, botArn, assistant\.profile, correlationId, \{ quiet: true \}\);/);
    expect(router).toMatch(/if \(!opts\.quiet\) \{\s*const machines = await resolveTaskMachines[\s\S]*?sendChannelMessage[\s\S]*?\n {2}\}\n {2}const handed = await invokeAsync/);
  });
});

describe('an intent the platform raises has no classified turns', () => {
  it('the platform machines whose first step acts on entry are the two dashboard refreshes, and no machine a person answers', async () => {
    const { PLATFORM_MACHINE_KEYS, isPlatformRaisedMachine } = await import('../../lambda/src/lib/task-state-machines');
    expect(PLATFORM_MACHINE_KEYS.filter((k) => isPlatformRaisedMachine(k)).sort()).toEqual(['dashboard_refresh', 'dashboard_runbook']);
    expect(isPlatformRaisedMachine('incident_first_look')).toBe(false);
    expect(isPlatformRaisedMachine(undefined)).toBe(false);
  });
});
