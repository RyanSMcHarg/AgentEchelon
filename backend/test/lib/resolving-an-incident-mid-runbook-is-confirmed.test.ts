/**
 * RESOLVING AN INCIDENT WHILE ITS RUNBOOK HAS STEPS OPEN IS CONFIRMED FIRST, AND A CONFIRMED RESOLVE ENDS THE RUN
 * (SPEC-WORKFLOWS-AND-TASKS, the alongside requirement).
 *
 * What it proves:
 *  - the `ops-room` step that opens the incident declares that its settlement ends the run (`endsRun`) and that a settling
 *    press while the run is mid-way is confirmed in `confirming_resolve` (`confirmEnd`), and the incident machine declares
 *    that state and its edges, so the move is authorized like any other;
 *  - a press of Resolved while the run has steps open moves the task to the confirmation, settling nothing; pressed where
 *    the run already reached its end, it resolves at once; the confirmation resolves it or keeps it open;
 *  - DENY: only the incident's assignee, the on-call, may press or confirm, and a field shape the validator does not
 *    declare is refused;
 *  - where the run stands is read from its own claims: the current step and the steps still to come, in order, by label;
 *  - a run a settlement ended goes on with nothing afterwards, and its open runbook tasks are cancelled with the run's end
 *    as their reason; the ending tells the opener it resolved, once, through the existing end path;
 *  - the confirmation and the kept-open notice are message templates naming the open steps, never fixed English in code.
 */
const mockSend = jest.fn();
const mockTags = jest.fn();
const mockLive = jest.fn();
const mockName = jest.fn();

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

process.env.TASKS_TABLE = 'tasks';
process.env.USER_TASKS_TABLE = 'user-tasks';
process.env.SERVICE_CLASSIFICATION = 'standard';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../../lambda/src/task-service');
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  RUN_END_CLAIM, SHIPPED_EVENT_WORKFLOWS, continuationClaim, continueAfter, endingTerminal, endsMidway, eventWorkflowErrors, runEnding,
  runStanding, runStandingClaims, stepLabel, type EventRunDeps, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { endsRunErrors, pressTarget } from '../../lambda/src/lib/task-step';
import { TASK_RUN_ENDED_ENDING, settlementOutcome } from '../../lambda/src/lib/workflow-task';
import { alongsideEndWaitId } from '../../lambda/src/lib/held-run';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
let seq = 0;
const nextRoom = () => `${I}/channel/ops${++seq}`;
const OWN_BOT = `${I}/bot/opsbot`;
const RUN_KEY = 'conversation-opened#ops#ops';
const run = {
  runKey: RUN_KEY, workflow: 'ops-room', step: 'lead-task', event: 'conversation-opened', botArn: OWN_BOT, deadlineAt: 2_000_000_000,
  holdsEnd: true, endsRun: true, confirmEnd: 'confirming_resolve', values: { label: 'Customer API errors' },
};
const M = DEFAULT_TASK_STATE_MACHINES;
const wf = SHIPPED_EVENT_WORKFLOWS['ops-room'];
const incident = (channelArn: string, over: Record<string, unknown> = {}) => ({
  taskId: 'evt-lead', channelArn, status: 'in_progress', taskType: 'incident_ownership', taskState: 'open',
  assigneeId: 'oncall', assigneeType: 'user', workerId: 'oncall', workerType: 'user', assistantId: 'opsbot',
  stateHistory: [], workflowRun: run, createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', ...over,
});

/** The task service's table, in memory: the incident's row, and whether the run's end is held on it. */
function table(room: string, opts: { row?: Record<string, unknown>; endHeld?: boolean; endClaimed?: boolean; open?: Record<string, unknown>[] } = {}) {
  mockSend.mockImplementation(async (cmd: any) => {
    if (cmd.__t === 'Query') return { Items: opts.open ?? [] };
    if (cmd.__t !== 'Get') return {};
    const id = String(cmd.input.Key?.taskId ?? '');
    if (id === `event-run#wait#${alongsideEndWaitId('evt-lead')}`) return opts.endHeld ? { Item: { eventRun: true, continuation: { runKey: RUN_KEY, step: 'done' } } } : {};
    if (id === `event-run#${RUN_KEY}#step#${RUN_END_CLAIM}`) return opts.endClaimed ? { Item: { eventRun: true, outcome: 'success' } } : {};
    if (id === 'evt-lead') return { Item: opts.row ?? incident(room) };
    return {};
  });
}
const calls = (t: string) => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === t);
const movedTo = () => (calls('Update').find((c: any) => String(c.input.UpdateExpression).includes('taskState = :to')) as any)?.input.ExpressionAttributeValues[':to'];

beforeEach(() => {
  mockSend.mockReset();
  mockTags.mockReset().mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
  mockLive.mockReset().mockResolvedValue([{ botArn: OWN_BOT, role: 'ops', handle: 'ops' }]);
  mockName.mockReset().mockResolvedValue(true);
});

describe('the incident declares its confirmation as data', () => {
  it('ops-room\'s lead task ends the run and confirms a mid-way settlement in confirming_resolve, and validates', () => {
    expect(wf.states['lead-task'].task).toMatchObject({ continue: 'alongside', endsRun: true, confirmEnd: 'confirming_resolve' });
    expect(eventWorkflowErrors('ops-room', wf)).toEqual([]);
    expect(endsMidway(wf)).toBe(true);
    expect(endingTerminal(wf)).toBe('done');
  });

  it('the machine offers Resolved from open, and Resolved or Keep open from the confirmation, each a declared edge', () => {
    const m = M.incident_ownership;
    expect(m.states.open).toMatchObject({ transitions: ['resolved', 'confirming_resolve'], choices: ['resolved'] });
    expect(m.states.confirming_resolve).toMatchObject({ transitions: ['resolved', 'open'], choices: ['resolved', 'open'], awaits: { party: 'worker' } });
    expect(m.states.confirming_resolve.notice).toEqual({ to: 'worker', template: 'incident-resolve-confirm' });
    expect(m.states.open.notice).toEqual({ to: 'worker', template: 'incident-kept-open' });
  });

  it('DENY: endsRun only alongside, confirmEnd only with endsRun, and only a state that asks the worker with an edge to it', () => {
    const at = 'x.states.s.task';
    expect(endsRunErrors({ machine: 'incident_ownership', endsRun: true }, at, M.incident_ownership).join()).toMatch(/goes on alongside its task/);
    expect(endsRunErrors({ machine: 'incident_ownership', continue: 'alongside', confirmEnd: 'confirming_resolve' }, at, M.incident_ownership).join()).toMatch(/endsRun: true/);
    expect(endsRunErrors({ machine: 'incident_ownership', continue: 'alongside', endsRun: true, confirmEnd: 'resolved' }, at, M.incident_ownership).join()).toMatch(/not terminal, awaits the worker/);
    const noEdge = { ...M.incident_ownership, states: { ...M.incident_ownership.states, open: { ...M.incident_ownership.states.open, transitions: ['resolved'] } } };
    expect(endsRunErrors({ machine: 'incident_ownership', continue: 'alongside', endsRun: true, confirmEnd: 'confirming_resolve' }, at, noEdge).join()).toMatch(/declares no edge to/);
    expect(endsRunErrors({ machine: 'incident_ownership', continue: 'alongside', endsRun: 'yes' }, at, M.incident_ownership).join()).toMatch(/endsRun is true/);
    const bad = JSON.parse(JSON.stringify(wf)) as EventWorkflow;
    (bad.states['lead-task'].task as any).confirmEnd = 'nowhere';
    expect(eventWorkflowErrors('ops-room', bad).join('\n')).toMatch(/confirmEnd names a state of incident_ownership/);
    (bad.states['lead-task'] as any).label = '';
    expect(eventWorkflowErrors('ops-room', bad).join('\n')).toMatch(/label is the step's name/);
  });

  it('where a press goes: the confirmation while the run is mid-way, the choice as pressed at its end or from the confirmation', () => {
    expect(pressTarget(M.incident_ownership, 'open', 'resolved', run, false)).toBe('confirming_resolve');
    expect(pressTarget(M.incident_ownership, 'open', 'resolved', run, true)).toBe('resolved');
    expect(pressTarget(M.incident_ownership, 'confirming_resolve', 'resolved', run, false)).toBe('resolved');
    expect(pressTarget(M.incident_ownership, 'confirming_resolve', 'open', run, false)).toBe('open');
    expect(pressTarget(M.incident_ownership, 'open', 'resolved', { }, false)).toBe('resolved');
  });
});

describe('a press of Resolved on the incident card (the task service)', () => {
  const press = (room: string, over: Record<string, unknown> = {}) => svc.advanceAsAssignee({
    taskId: 'evt-lead', channelArn: room, callerPersonId: 'oncall', state: 'open', choice: 'resolved', ...over,
  });

  it('steps open: moves to the confirmation and settles nothing', async () => {
    const room = nextRoom();
    table(room);
    expect(await press(room)).toEqual({ ok: true, to: 'confirming_resolve' });
    expect(movedTo()).toBe('confirming_resolve');
    expect(JSON.stringify(calls('Update'))).not.toContain('"completed"');
    expect(mockName).not.toHaveBeenCalledWith('standard', expect.objectContaining({ kind: 'settled' }));
  });

  it('nothing open (the run\'s end is held on it, or already claimed): resolves at once', async () => {
    const held = nextRoom();
    table(held, { endHeld: true });
    expect(await press(held)).toEqual({ ok: true, to: 'resolved' });
    const claimed = nextRoom();
    table(claimed, { endClaimed: true });
    expect(await press(claimed)).toEqual({ ok: true, to: 'resolved' });
  });

  it('confirmed: the confirmation resolves it; declined: it goes back to open and stays open', async () => {
    const room = nextRoom();
    table(room, { row: incident(room, { taskState: 'confirming_resolve' }) });
    expect(await press(room, { state: 'confirming_resolve' })).toEqual({ ok: true, to: 'resolved' });
    const kept = nextRoom();
    mockSend.mockReset();
    table(kept, { row: incident(kept, { taskState: 'confirming_resolve' }) });
    expect(await press(kept, { state: 'confirming_resolve', choice: 'open' })).toEqual({ ok: true, to: 'open' });
    expect(movedTo()).toBe('open');
  });

  it('DENY: only the incident\'s assignee, the on-call, may press Resolved or confirm it', async () => {
    const room = nextRoom();
    table(room);
    expect(await press(room, { callerPersonId: 'teammate' })).toEqual({ ok: false, error: 'NOT_ASSIGNEE' });
    table(room, { row: incident(room, { taskState: 'confirming_resolve' }) });
    expect(await press(room, { callerPersonId: 'teammate', state: 'confirming_resolve' })).toEqual({ ok: false, error: 'NOT_ASSIGNEE' });
    expect(calls('Update')).toEqual([]);
  });
});

describe('a run a confirmed resolve ended', () => {
  it('cancels the run\'s open runbook tasks with the run\'s end as their reason, and leaves other runs\' work alone', async () => {
    const room = nextRoom();
    const task = (taskId: string, over: Record<string, unknown> = {}) => ({
      taskId, channelArn: room, status: 'pending', taskType: 'approval', taskState: 'deciding', stateHistory: [], workflowRun: { ...run, step: 'runbook-decide', holdsEnd: undefined }, ...over,
    });
    table(room, { open: [task('evt-decide'), task('evt-asked', { taskType: 'acknowledgement', taskState: 'asked', workflowRun: { runKey: 'intent#x', workflow: 'w', step: 's', event: 'intent', botArn: OWN_BOT }, askedBy: { runKey: RUN_KEY, step: 'runbook-cause' } }), task('evt-other', { workflowRun: { ...run, runKey: 'another-run' } })] });
    expect(await svc.endRunTasks({ channelArn: room, runKey: RUN_KEY })).toEqual({ cancelled: ['evt-decide', 'evt-asked'] });
    const cancels = calls('Update').filter((c: any) => JSON.stringify(c.input.ExpressionAttributeValues ?? {}).includes(TASK_RUN_ENDED_ENDING)) as any[];
    expect(cancels.map((c) => c.input.Key.taskId).sort()).toEqual(['evt-asked', 'evt-decide']);
    expect(settlementOutcome({ taskType: 'approval', taskState: 'deciding', status: 'cancelled', error: TASK_RUN_ENDED_ENDING }, M)).toBe('task:failure:deciding');
  });

  it('goes on with nothing once its end is claimed, so a cancelled task\'s settlement continues no step', async () => {
    const claimed = new Set<string>();
    const deps: EventRunDeps = {
      claimRun: async () => true, claimStep: async (s) => { if (claimed.has(s)) return false; claimed.add(s); return true; },
      mentionName: async () => '', dispatchAgent: async () => true, send: async () => true, openTask: async () => 'opened',
      hasEnded: async () => true,
    };
    const ctx = { event: 'conversation-opened' as const, channelArn: `${I}/channel/c`, values: {} };
    expect((await continueAfter('ops-room', wf, ctx, { step: 'runbook-decide', outcome: 'task:failure:deciding' }, deps)).ran).toBe(false);
    expect(claimed.has(continuationClaim('runbook-decide'))).toBe(false);
  });

  it('ends on its success terminal once, with the resolve as how it ended, which the opener reads as resolved', async () => {
    const claimed = new Set<string>();
    const ended: string[] = [];
    const deps: EventRunDeps = {
      claimRun: async () => true, claimStep: async (s) => { if (claimed.has(s)) return false; claimed.add(s); return true; },
      mentionName: async () => '', dispatchAgent: async () => true, send: async () => true, openTask: async () => 'opened',
      holdEnd: async () => 'held', ended: async (_d, _s, ending) => { ended.push(ending); },
    };
    const ctx = { event: 'conversation-opened' as const, channelArn: `${I}/channel/c`, values: {} };
    const first = await continueAfter('ops-room', wf, ctx, { step: 'done', outcome: 'task:success:resolved' }, deps);
    expect(first.ended).toBe('success');
    expect(ended).toEqual(['success']);
    // ONE ENDING: a second release, or the run reaching its end afterwards, takes no second end.
    expect((await continueAfter('ops-room', wf, ctx, { step: 'done', outcome: 'task:success:resolved' }, deps)).ran).toBe(false);
    expect(ended).toEqual(['success']);
    expect(runEnding('success', ['task:success:resolved'])).toBe('success');
  });

  it('the router ends a run where it stands when a task that ends it settles mid-way, then cancels its open tasks', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const release = router.slice(router.indexOf('async function releaseHeldEnd('), router.indexOf('async function endRunWhereItStands('));
    // A SUCCESS THAT MOVES THE RUN ON moves it (O15); any other settlement of a task that ends the run ends it where it stands.
    expect(release).toContain("return run.movesTo && taskOutcomeOf(outcome).edge === 'success' ? moveRunOn(run, channelArn, taskId, outcome) : endRunWhereItStands(run, channelArn, taskId, outcome);");
    expect(release).toContain("if (!run?.endsRun) return { ran: false, reason: 'the run has not reached its end' };");
    const end = router.slice(router.indexOf('async function endRunWhereItStands('), router.indexOf('async function standingOf('));
    expect(end).toContain('const terminal = wf ? endingTerminal(wf) : undefined;');
    expect(end.indexOf('continueRunOn({ ...run, step: terminal }')).toBeLessThan(end.indexOf('endRunTasks(channelArn, run.runKey)'));
    expect(router).toContain('own && ownOutcome && own.holdsEnd ? releaseHeldEnd(task.taskId, r.channelArn, ownOutcome, own) : undefined,');
    expect(router).toContain("...(def.continue === 'alongside' && def.endsRun ? { endsRun: true as const, ...(def.movesTo ? { movesTo: def.movesTo } : {}), ...(def.confirmEnd ? { confirmEnd: def.confirmEnd } : {}) } : {}),");
  });
});

describe('where the run stands, and what the on-call is asked', () => {
  const at = (steps: Record<string, string>) => runStanding(wf, steps);
  const throughCustomerImpact = {
    'lead-task': 'opened', [continuationClaim('lead-task')]: 'opened', 'first-look': 'opened', [continuationClaim('first-look')]: 'opened',
    'offer-call': 'opened', [continuationClaim('offer-call')]: 'task:success:declined', 'customer-impact': 'opened', [continuationClaim('customer-impact')]: 'task:success:done',
    'impact-confirm': 'opened', [continuationClaim('impact-confirm')]: 'task:success:not_impacted',
  };

  it('is the current step and the steps still to come, in the order the workflow declares them, by label', () => {
    const standing = at({ ...throughCustomerImpact, 'runbook-cause': 'opened' });
    expect(standing.current).toEqual(['runbook-cause']);
    expect(standing.next).toEqual(['runbook-decide', 'runbook-act', 'runbook-verify']);
    expect(standing.current.map((k) => stepLabel(wf, k))).toEqual(['Cause and recommended action']);
    // THE TASK THE RUN'S END WAITS ON is never a step it is at.
    expect(standing.current).not.toContain('lead-task');
    expect(runStandingClaims(wf)).toEqual(expect.arrayContaining(['runbook-cause', continuationClaim('runbook-cause'), RUN_END_CLAIM]));
  });

  it('between steps, it is the steps its edges can still reach; at its end, nowhere', () => {
    expect(at(throughCustomerImpact)).toMatchObject({ current: [], next: ['dashboard', 'runbook-cause', 'runbook-decide', 'runbook-act', 'runbook-verify'] });
    expect(at({ ...throughCustomerImpact, [RUN_END_CLAIM]: 'success' })).toEqual({ current: [], next: [], ended: true });
  });

  it('the confirmation names the open steps from the template, and leaves the line out where none could be read', () => {
    const t = shippedMessageTemplate('incident-resolve-confirm');
    const said = renderMessageTemplate(t, { label: 'Customer API errors', steps: 'Mitigation decision, Recovery check' }, { sections: ['chat'] });
    expect(said.ok && said.sections.chat).toContain('Still open: Mitigation decision, Recovery check');
    expect(said.ok && said.sections.chat).toContain('Customer API errors');
    const none = renderMessageTemplate(t, { label: 'Customer API errors', steps: '' }, { sections: ['chat'] });
    expect(none.ok && none.sections.chat).not.toContain('Still open');
    const kept = renderMessageTemplate(shippedMessageTemplate('incident-kept-open'), { label: 'Customer API errors' }, { sections: ['chat'] });
    expect(kept.ok && kept.sections.chat).toContain('Customer API errors');
  });

  it('the router says a state\'s notice with the run\'s open steps and the card, and never on the state a task opened in', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('async function handleStateNotice('), router.indexOf('async function handleTaskReopened('));
    expect(fn).toContain("if (entries === 0 && machinesForTask(task)[task.taskType ?? '']?.initial === state) return");
    expect(fn).toContain('const steps = standing ? [...standing.current, ...standing.next].join(\', \') : \'\';');
    expect(fn).toContain("const card = notice.to === 'worker' ? taskCardOf(task, machinesForTask(task)) : undefined;");
  });
});
