/**
 * A STEP NAMES WHO DECIDES IT, AND A FINISHED TASK IS REOPENED BY THEM.
 *
 * A task step declares `decidedBy`, the participant roles whose holders may take its choices besides its assignee, and reopen
 * it where its machine's ending declares `reopens`. Every rule here is general: the incident's owner step is one declaration.
 *  - the press is held to the roles the caller holds by the conversation's record, read by the user-tasks function, never
 *    from the request; a non-decider is refused, and a reopen is a decider's alone;
 *  - a step with deciders is moved by a press only: no assistant's turn takes its choices from what somebody wrote;
 *  - the band is told who decides and what they may choose now (`decisionOf`);
 *  - a reopen runs the version's `task-reopened` workflow for that machine, whose step takes the reopened task back.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { assigneeAdvanceRefusal } from '../../lambda/src/lib/workflow-task';
import { authorizeTransition, DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { decisionOf } from '../../lambda/src/lib/runbook-progress';
import { SHIPPED_EVENT_WORKFLOWS, declaredWorkflowOn, eventWorkflowErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import type { Task } from '../../lambda/src/lib/task-tracking';

const machines = DEFAULT_TASK_STATE_MACHINES;
const ROLES = ['on-call:ops', 'secondary:ops', 'lead'];
const task = (over: Partial<Task> = {}) => ({
  taskId: 't1', channelArn: 'c', taskType: 'incident_ownership', taskState: 'open', status: 'in_progress',
  assigneeId: 'jordan', assigneeType: 'user', workflowRun: { runKey: 'r1', workflow: 'ops-room', step: 'lead-task', decidedBy: ROLES },
  ...over,
}) as unknown as Task;
const press = (over: Record<string, unknown> = {}) => ({ callerPersonId: 'priya', state: 'open', choice: 'resolved', ...over });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const SRC = (f: string) => readFileSync(join(__dirname, '../../lambda/src', f), 'utf8');

describe('a press is held to the step\'s deciders', () => {
  it('its assignee may press, and so may a holder of a deciding role', () => {
    expect(assigneeAdvanceRefusal(task(), machines, press({ callerPersonId: 'jordan' }))).toBeUndefined();
    expect(assigneeAdvanceRefusal(task(), machines, press({ callerRoles: ['secondary:ops'] }))).toBeUndefined();
  });

  it('DENY: a member holding no deciding role is refused, and so is one whose role the step does not name', () => {
    expect(assigneeAdvanceRefusal(task(), machines, press())).toBe('NOT_ASSIGNEE');
    expect(assigneeAdvanceRefusal(task(), machines, press({ callerRoles: ['participant'] }))).toBe('NOT_ASSIGNEE');
    // A STEP THAT NAMES NO DECIDERS ADMITS ITS ASSIGNEE ALONE, whatever roles the caller holds.
    expect(assigneeAdvanceRefusal(task({ workflowRun: { runKey: 'r1', workflow: 'w', step: 's' } as never }), machines, press({ callerRoles: ['lead'] }))).toBe('NOT_ASSIGNEE');
  });

  it('the roles come from the conversation\'s own record, read by the user-tasks function, never from the request body', () => {
    const api = SRC('user-tasks-api.ts');
    expect(api).toMatch(/const callerRoles = await rolesHeldBy\(channelArn, personId\);/);
    expect(api).toMatch(/getChannelContext\(channelArn, \{ consistent: true \}\)/);
    expect(api).not.toMatch(/body\?\.callerRoles|body\?\.roles/);
  });
});

describe('a finished task is reopened by its deciders alone', () => {
  const resolved = () => task({ taskState: 'resolved', status: 'completed', assigneeId: 'ops-bot', assigneeType: 'assistant' });

  it('a decider reopens a resolved incident into the state its ending declares', () => {
    expect(machines.incident_ownership.states.resolved.reopens).toEqual(['open']);
    expect(assigneeAdvanceRefusal(resolved(), machines, press({ state: 'resolved', choice: 'open', callerRoles: ['on-call:ops'] }))).toBeUndefined();
  });

  it('DENY: a non-decider cannot reopen it, nor can anyone into a state its ending does not declare, nor from a state it left', () => {
    expect(assigneeAdvanceRefusal(resolved(), machines, press({ state: 'resolved', choice: 'open' }))).toBe('NOT_ASSIGNEE');
    expect(assigneeAdvanceRefusal(resolved(), machines, press({ state: 'resolved', choice: 'confirming_resolve', callerRoles: ['lead'] }))).toBe('SETTLED');
    expect(assigneeAdvanceRefusal(resolved(), machines, press({ state: 'open', choice: 'open', callerRoles: ['lead'] }))).toBe('STATE_MOVED');
    // A TASK WHOSE STEP NAMES NO DECIDERS IS NOT REOPENED BY A PRESS.
    expect(assigneeAdvanceRefusal(task({ taskState: 'resolved', status: 'completed', workflowRun: { runKey: 'r', workflow: 'w', step: 's' } as never }), machines, press({ state: 'resolved', choice: 'open', callerRoles: ['lead'] }))).toBe('SETTLED');
  });

  it('DENY: a runtime writer cannot take a reopen unless it is a decider\'s press', () => {
    expect(authorizeTransition('incident_ownership', 'resolved', 'open', machines, { by: 'system' })).toMatchObject({ ok: false, error: 'illegal_transition' });
    expect(authorizeTransition('incident_ownership', 'resolved', 'open', machines, { by: 'system', reopenByDecider: true })).toMatchObject({ ok: true, reopen: true });
  });

  it('DENY: no assistant\'s turn moves a step with deciders', () => {
    expect(SRC('lib/task-tracking.ts')).toMatch(/if \(args\.by === 'tool' && task\.workflowRun\?\.decidedBy\?\.length\) \{\n\s+return \{ ok: false, error: 'illegal_transition'/);
  });
});

describe('the band is told who decides the pinned step and what they may choose', () => {
  const wf = SHIPPED_EVENT_WORKFLOWS['ops-room'];
  const roles = { 'on-call:ops': ['arn:aws:chime:r:1:app-instance/i/user/jordan'], lead: ['arn:aws:chime:r:1:app-instance/i/user/jordan'], 'secondary:ops': ['arn:aws:chime:r:1:app-instance/i/user/priya'] };
  it('open: its state\'s choices; resolved: the states its ending reopens into; each person once', () => {
    expect(decisionOf(wf, { 'lead-task': task() }, roles, () => machines)).toEqual({ taskId: 't1', state: 'open', choices: ['resolved'], by: ['jordan', 'priya'] });
    expect(decisionOf(wf, { 'lead-task': task({ taskState: 'resolved' }) }, roles, () => machines)).toEqual({ taskId: 't1', state: 'resolved', choices: ['open'], by: ['jordan', 'priya'], reopen: true });
  });
  it('nothing where nobody holds a deciding role, or no step names deciders', () => {
    expect(decisionOf(wf, { 'lead-task': task() }, {}, () => machines)).toBeUndefined();
    const none = clone(wf); delete (none.states['lead-task'].task as { decidedBy?: string[] }).decidedBy;
    expect(decisionOf(none, { 'lead-task': task() }, roles, () => machines)).toBeUndefined();
  });
});

describe('a reopen runs the version\'s workflow for that machine, which takes the task back', () => {
  it('the workflow naming the reopened machine is chosen, else one naming none', () => {
    const generic = { on: 'task-reopened', initial: 'a', states: { a: { disposition: 'success' } } } as unknown as EventWorkflow;
    const own = { generic, 'incident-reopened': SHIPPED_EVENT_WORKFLOWS['incident-reopened'] };
    expect(declaredWorkflowOn(own, 'task-reopened', 'incident_ownership')?.name).toBe('incident-reopened');
    expect(declaredWorkflowOn(own, 'task-reopened', 'report_generation')?.name).toBe('generic');
    expect(declaredWorkflowOn({ 'incident-reopened': SHIPPED_EVENT_WORKFLOWS['incident-reopened'] }, 'task-reopened', 'report_generation')).toBeUndefined();
  });

  it('the shipped reopen validates: its owner step takes the reopened task, pinned and decided by the same roles', () => {
    const wf = SHIPPED_EVENT_WORKFLOWS['incident-reopened'];
    expect(eventWorkflowErrors('incident-reopened', wf)).toEqual([]);
    expect(wf.states.owner.task).toMatchObject({ machine: 'incident_ownership', takes: 'reopened', pinned: true, decidedBy: ROLES });
    expect(SHIPPED_EVENT_WORKFLOWS['ops-room'].states['lead-task'].task?.decidedBy).toEqual(ROLES);
  });

  it('DENY: takes and reopens belong to a reopen workflow; deciders are role names on a step a participant role works', () => {
    const ops = clone(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    (ops.states['lead-task'].task as unknown as Record<string, unknown>).takes = 'reopened';
    (ops as unknown as Record<string, unknown>).reopens = 'incident_ownership';
    const errs = eventWorkflowErrors('ops-room', ops).join('\n');
    expect(errs).toMatch(/task\.takes is on a workflow that runs on task-reopened/);
    expect(errs).toMatch(/reopens names a machine, on a workflow that runs on task-reopened/);
    const bad = clone(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    bad.states['lead-task'].task!.decidedBy = ['Not A Role'];
    bad.states['customer-impact'].task!.decidedBy = ['lead'];
    const e2 = eventWorkflowErrors('ops-room', bad).join('\n');
    expect(e2).toMatch(/decidedBy is a list of 1 to 4 participant role names/);
    expect(e2).toMatch(/decidedBy is on a step a participant role works/);
  });

  it('a reopen ends what the reopened task\'s run went on to, and carries that run\'s values', () => {
    const router = SRC('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('async function handleTaskReopened('), router.indexOf('async function handleRequestAwaitingRun('));
    expect(fn).toMatch(/declaredWorkflowOn\(served\?\.version\.eventWorkflows, 'task-reopened', task\.taskType\)/);
    expect(fn).toMatch(/claimEventStep\(\{ runKey: from\.runKey, channelArn: task\.channelArn, step: RUN_END_CLAIM, outcome: 'reopened' \}\)/);
    expect(fn).toContain('endRunTasks(task.channelArn, from.runKey, { keepAlongside: true, keepTaskId: task.taskId })');
    expect(fn).toMatch(/values: \{ \.\.\.\(from\?\.values \?\? \{\}\) \}/);
  });
});
