/**
 * A WORKFLOW STEP OPENS A TASK FOR A PERSON (ADR-063 slices T1 and T2).
 *
 * What it proves: a `task` step is declared with a machine, the person it is for and who does the work, and is refused
 * with each reason ADR-063 decision 1 names; the awaited party `worker` holds a state for whoever the step named, through
 * the one writer of the assignee; the reference machines `approval` and `acknowledgement` validate and declare their card
 * choices; a run opens the task once and waits on it; the task settling continues the run once, on the edge its ending
 * chose, with `task:state` readable on that step's edges and nowhere else.
 */
import {
  continueAfter, eventWorkflowErrors, runEventWorkflow, versionEventWorkflowsErrors,
  type EventRunContext, type EventRunDeps, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import {
  AWAITED_PARTIES, DEFAULT_TASK_STATE_MACHINES, TaskMachineValidationError, validateTaskStateMachine, type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import {
  TASK_STATE_SOURCE, machinesAStepMayOpen, taskEndedOutcome, taskOutcomeOf, terminalStatesOf,
} from '../../lambda/src/lib/task-step';
import { pickupWarnings, stepRoleWarnings, welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import { patchShapeErrors } from '../../lambda/src/lib/profile-copy-fields';
import { createTask, workerOf, type Task } from '../../lambda/src/lib/task-tracking';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** A welcome that asks its subject to approve, then says which way it went. */
const APPROVE: EventWorkflow = {
  on: 'assistant-joined',
  initial: 'opening',
  states: {
    opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'review', onFailure: 'done' },
    review: {
      task: { machine: 'approval', for: 'subject', by: 'subject', visibility: 'private', priority: 'high', deadline: { afterMinutes: 60 } },
      onSuccess: [{ to: 'approved', when: { [TASK_STATE_SOURCE]: 'approved' } }, { to: 'declined' }],
      onFailure: 'done',
      onDeadline: 'chase',
    },
    approved: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done', onFailure: 'done' },
    declined: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
    chase: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

describe('T1: the task step is declared and validated (ADR-063 decision 1)', () => {
  it('a task step with its machine, its people, its edges and its deadline validates', () => {
    expect(eventWorkflowErrors('approve', APPROVE)).toEqual([]);
    expect(versionEventWorkflowsErrors({ approve: APPROVE })).toEqual([]);
  });

  const refused = (mutate: (wf: any) => void, pattern: RegExp) => {
    const wf = clone(APPROVE);
    mutate(wf);
    expect(eventWorkflowErrors('x', wf).join('\n')).toMatch(pattern);
  };

  it('a machine no step may open is refused: unknown, or one of the turn queue\'s own', () => {
    refused((wf) => { wf.states.review.task.machine = 'nope'; }, /machine names nope, which is not a task machine this version may open/);
    refused((wf) => { wf.states.review.task.machine = 'queued_request'; }, /one of the turn queue's own machines, which no step opens/);
  });

  it('a free principal id, the room, or an unknown field is refused: references only', () => {
    refused((wf) => { wf.states.review.task.for = 'arn:aws:chime:us-east-1:1:app-instance/x/user/abc'; }, /review\.task\.for/);
    refused((wf) => { wf.states.review.task.by = 'room'; }, /names one person, never the room/);
    refused((wf) => { wf.states.review.task.assignee = 'subject'; }, /assignee is not a field of a task step/);
    refused((wf) => { wf.states.review.task.for = { assistantRole: 'ops' }; }, /an assistant does the work \(by\), and is never a task's requester/);
  });

  it('a machine with a step awaiting the requester needs `for`', () => {
    refused((wf) => { wf.states.review.task.machine = 'guided_troubleshooting'; delete wf.states.review.task.for; }, /for is required/);
  });

  it('a participant role with several holders is refused (decision B1), and a role needs declared types', () => {
    refused((wf) => { wf.states.review.task.by = { participantRole: 'lead' }; }, /declares the types it runs in, each giving the role one holder/);
    const ops = clone(APPROVE) as any;
    ops.types = ['ops'];
    ops.states.review.task.by = { participantRole: 'responder' };
    expect(eventWorkflowErrors('x', ops).join('\n')).toMatch(/type ops does not give one holder/);
    ops.states.review.task.by = { participantRole: 'lead' };
    expect(eventWorkflowErrors('x', ops).join('\n')).not.toMatch(/holder/);
  });

  it('a deadline is required and bounded (decision F1); visibility and priority are closed', () => {
    refused((wf) => { delete wf.states.review.task.deadline; }, /every task a workflow assigns has an end/);
    refused((wf) => { wf.states.review.task.deadline = { afterMinutes: 1 }; }, /from 5 to 43200/);
    refused((wf) => { wf.states.review.task.visibility = 'public'; }, /visibility is conversation or private/);
    refused((wf) => { wf.states.review.task.priority = 'urgent'; }, /priority is high, normal, low/);
  });

  it('onDeadline is a task step\'s alone, and `task:state` is read on its edges and nowhere else', () => {
    refused((wf) => { wf.states.opening.onDeadline = 'done'; }, /only a task step declares it/);
    refused((wf) => { wf.states.opening.onSuccess = [{ to: 'review', when: { [TASK_STATE_SOURCE]: 'approved' } }, { to: 'done' }]; }, /task:state is read only on the edges of the task step/);
    refused((wf) => { wf.states.review.onSuccess = [{ to: 'approved', when: { [TASK_STATE_SOURCE]: 'maybe' } }, { to: 'declined' }]; }, /"task:state" is an enum of approved, declined/);
  });

  it('the graph stays acyclic through onDeadline', () => {
    refused((wf) => { wf.states.chase.onSuccess = 'review'; }, /has a cycle/);
  });

  it('a version checks the machine against its own selection, and a machine no router runs is refused', () => {
    const body = { eventWorkflows: { approve: APPROVE }, workflows: ['report_generation'] } as any;
    expect(welcomeWorkflowErrors(body).join('\n')).toMatch(/opens a approval task, which this version's workflows do not include/);
    expect(welcomeWorkflowErrors({ ...body, workflows: ['approval'] })).toEqual([]);
    const own = clone(APPROVE) as any;
    own.states.review.task.machine = 'sign_off';
    own.states.review.onSuccess = 'approved';
    const signOff: TaskStateMachine = { initial: 'asked', states: { asked: { transitions: ['done'], awaits: { party: 'worker' }, choices: ['done'] }, done: { transitions: [], terminal: 'success' } } };
    expect(welcomeWorkflowErrors({ eventWorkflows: { approve: own } } as any).join('\n')).toMatch(/sign_off/);
    expect(patchShapeErrors({ eventWorkflows: { approve: own } } as any).join(' ')).toMatch(/sign_off/);
    expect(eventWorkflowErrors('approve', own, { machines: { sign_off: signOff } })).toEqual([]);
  });

  it('an assistant role the classification does not declare is said, never refused, as `as` is', () => {
    const wf = clone(APPROVE) as any;
    wf.states.review.task.by = { assistantRole: 'ops' };
    expect(eventWorkflowErrors('x', wf)).toEqual([]);
    expect(stepRoleWarnings({ eventWorkflows: { x: wf } } as any, []).join('\n')).toMatch(/assigns its task to the ops assistant/);
    expect(stepRoleWarnings({ eventWorkflows: { x: wf } } as any, ['ops'])).toEqual([]);
  });

  it('work for an assistant where the turn queue is off validates with a warning (decision H1)', () => {
    const wf = clone(APPROVE) as any;
    wf.states.review.task.by = { assistantRole: 'ops' };
    expect(pickupWarnings({ eventWorkflows: { x: wf } } as any, false).join('\n')).toMatch(/the turn queue is off/);
    expect(pickupWarnings({ eventWorkflows: { x: wf } } as any, true)).toEqual([]);
    expect(pickupWarnings({ eventWorkflows: { approve: APPROVE } } as any, false)).toEqual([]);
  });
});

describe('T1: the machines (ADR-063 decisions 1, 2 and 5)', () => {
  it('`worker` is an awaited party beside `requester`', () => {
    expect([...AWAITED_PARTIES]).toEqual(['requester', 'worker']);
  });

  it('the reference machines validate, await the worker and offer their choices', () => {
    for (const key of ['approval', 'acknowledgement']) {
      const m = DEFAULT_TASK_STATE_MACHINES[key];
      expect(() => validateTaskStateMachine(key, m)).not.toThrow();
      expect(m.states[m.initial].awaits).toEqual({ party: 'worker' });
    }
    expect(DEFAULT_TASK_STATE_MACHINES.approval.states.deciding.choices).toEqual(['approved', 'declined']);
    expect(terminalStatesOf(DEFAULT_TASK_STATE_MACHINES.approval)).toEqual(['approved', 'declined']);
    expect(Object.keys(machinesAStepMayOpen())).not.toContain('queue_drain');
  });

  const bad = (m: TaskStateMachine, pattern: RegExp) => {
    expect(() => validateTaskStateMachine('m', m)).toThrow(TaskMachineValidationError);
    expect(() => validateTaskStateMachine('m', m)).toThrow(pattern);
  };

  it('a choice is one of the state\'s own transitions, on a state that awaits somebody', () => {
    bad({ initial: 'a', states: { a: { transitions: ['b'], choices: ['b'] }, b: { transitions: [], terminal: 'success' } } }, /declares choices but awaits nobody/);
    bad({ initial: 'a', states: { a: { transitions: ['b'], awaits: { party: 'worker' }, choices: ['c'] }, b: { transitions: [], terminal: 'success' } } }, /not its transitions/);
  });

  it('a resting state awaits nobody and is not terminal', () => {
    bad({ initial: 'a', states: { a: { transitions: ['b'], awaits: { party: 'requester' }, rests: true }, b: { transitions: [], terminal: 'success' } } }, /rests but awaits somebody/);
    expect(DEFAULT_TASK_STATE_MACHINES.incident_first_look.states.findings_shared.rests).toBe(true);
    expect(Object.entries(DEFAULT_TASK_STATE_MACHINES.queue_drain.states).filter(([, d]) => d.transitions.length).every(([, d]) => d.rests === true)).toBe(true);
  });
});

describe('T1: the worker holds what awaits it, through the one writer (ADR-024, ADR-063 decision 1)', () => {
  const machines = { approval: DEFAULT_TASK_STATE_MACHINES.approval, guided_troubleshooting: DEFAULT_TASK_STATE_MACHINES.guided_troubleshooting };
  const event = (sender: string) => ({ requestAttributes: { 'CHIME.channel.arn': 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c', 'CHIME.sender.arn': sender } });
  const person = (id: string) => `arn:aws:chime:us-east-1:1:app-instance/i/user/${id}`;

  it('a task whose first state awaits the worker starts with the worker, and records the worker and the run', async () => {
    const task = await createTask(event(person('owner')), DeliveryOption.TASK_MULTI_STEP, 'approval', undefined, {
      machines, worker: { id: 'approver', type: 'user' }, assistantId: 'bot1',
      workflowRun: { runKey: 'k', workflow: 'w', step: 's', event: 'assistant-joined', botArn: 'b' },
    });
    expect({ assigneeId: task.assigneeId, assigneeType: task.assigneeType }).toEqual({ assigneeId: 'approver', assigneeType: 'user' });
    expect(task.ownerPersonId).toBe('owner');
    expect(workerOf(task)).toEqual({ id: 'approver', type: 'user' });
    expect(task.workflowRun?.runKey).toBe('k');
  });

  it('an assistant worker holds the state that awaits it', async () => {
    const task = await createTask(event(person('owner')), DeliveryOption.TASK_MULTI_STEP, 'approval', undefined, {
      machines, worker: { id: 'opsbot', type: 'assistant' }, assistantId: 'opsbot',
    });
    expect({ id: task.assigneeId, type: task.assigneeType }).toEqual({ id: 'opsbot', type: 'assistant' });
  });

  it('a task no step opened is unchanged: the requester holds a state that awaits the requester', async () => {
    const task: Task = await createTask(event(person('p1')), DeliveryOption.TASK_MULTI_STEP, 'guided_troubleshooting', undefined, { machines });
    expect({ id: task.assigneeId, type: task.assigneeType }).toEqual({ id: 'p1', type: 'user' });
    expect(workerOf(task)).toBeNull();
  });
});

describe('T1/T2: the run opens the task once and the settlement continues it once (ADR-063 decision 3)', () => {
  const SUBJECT = 'arn:aws:chime:us-east-1:1:app-instance/i/user/subject';
  const ctx = (): EventRunContext => ({ event: 'assistant-joined', channelArn: 'arn:c', subject: SUBJECT, values: {}, gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as any } });
  function deps(claims = new Set<string>(), over: Partial<EventRunDeps> = {}) {
    const sent: string[] = [];
    const opened: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => !claims.has('run') && !!claims.add('run'),
      claimStep: async (step) => !claims.has(step) && !!claims.add(step),
      mentionName: async () => 'Sam',
      send: async ({ step }) => { sent.push(step); return true; },
      dispatchAgent: async () => true,
      openTask: async (step) => { opened.push(step); return 'opened'; },
      ...over,
    };
    return { d, sent, opened, claims };
  }

  it('the run posts its opening, opens the task and stops there', async () => {
    const { d, sent, opened } = deps();
    const out = await runEventWorkflow('approve', APPROVE, ctx(), d);
    expect(sent).toEqual(['opening']);
    expect(opened).toEqual(['review']);
    expect(out.steps.map((s) => s.outcome)).toEqual(['posted', 'opened']);
    expect(out.ended).toBeUndefined();
  });

  it('a redelivered event opens nothing twice and waits as the first run does', async () => {
    const claims = new Set<string>(['review']);
    const { d, opened } = deps(claims);
    const out = await runEventWorkflow('approve', APPROVE, ctx(), d);
    expect(opened).toEqual([]);
    expect(out.steps.at(-1)).toEqual({ step: 'review', outcome: 'already-claimed' });
  });

  it('nobody to do the work takes the failure edge at once', async () => {
    const { d, sent } = deps(undefined, { openTask: async () => 'no-worker' });
    const out = await runEventWorkflow('approve', APPROVE, ctx(), d);
    expect(out.steps.map((s) => s.outcome)).toEqual(['posted', 'no-worker']);
    expect(out.ended).toBe('success');
    expect(sent).toEqual(['opening']);
  });

  it('the task settling continues the run on the edge its ending chose, with task:state on that step\'s edges', async () => {
    const approved = deps();
    await continueAfter('approve', APPROVE, ctx(), { step: 'review', outcome: taskEndedOutcome('success', 'approved') }, approved.d);
    expect(approved.sent).toEqual(['approved']);
    const declined = deps();
    await continueAfter('approve', APPROVE, ctx(), { step: 'review', outcome: taskEndedOutcome('success', 'declined') }, declined.d);
    expect(declined.sent).toEqual(['declined']);
    const late = deps();
    await continueAfter('approve', APPROVE, ctx(), { step: 'review', outcome: 'task:deadline' }, late.d);
    expect(late.sent).toEqual(['chase']);
    const failed = deps();
    await continueAfter('approve', APPROVE, ctx(), { step: 'review', outcome: taskEndedOutcome('handoff', 'declined') }, failed.d);
    expect(failed.sent).toEqual([]);
  });

  it('a settlement named twice continues the run once', async () => {
    const claims = new Set<string>();
    const first = deps(claims);
    await continueAfter('approve', APPROVE, ctx(), { step: 'review', outcome: taskEndedOutcome('success', 'approved') }, first.d);
    const again = deps(claims);
    const out = await continueAfter('approve', APPROVE, ctx(), { step: 'review', outcome: taskEndedOutcome('success', 'approved') }, again.d);
    expect(out.ran).toBe(false);
    expect(again.sent).toEqual([]);
  });

  it('an outcome reads as its edge and nothing else', () => {
    expect(taskOutcomeOf('task:success:approved')).toEqual({ edge: 'success', state: 'approved' });
    expect(taskOutcomeOf('task:deadline')).toEqual({ edge: 'deadline' });
    expect(taskOutcomeOf('task:failure:x')).toEqual({ edge: 'failure', state: 'x' });
    expect(taskOutcomeOf('anything')).toEqual({ edge: 'failure' });
  });
});

describe('T6: a participant role\'s one holder is the person a task is for or worked by (ADR-063 decision B1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { participantRoleReferences, audienceOf } = require('../../lambda/src/lib/event-workflow');
  const wf = JSON.parse(JSON.stringify(APPROVE));
  wf.types = ['ops'];
  wf.states.review.task.by = { participantRole: 'lead' };

  it('a role a task step names is read as an audience\'s is, so the run holds its holdings', () => {
    expect(eventWorkflowErrors('x', wf)).toEqual([]);
    expect([...participantRoleReferences(wf).roles]).toEqual(['lead']);
  });

  it('it resolves to the role\'s holder who is a member, and to nobody when none is', () => {
    const ctx = { event: 'assistant-joined', channelArn: 'c', values: {}, roles: { lead: ['arn:x/user/lead'] } };
    expect(audienceOf({ participantRole: 'lead' }, ctx)).toEqual(['arn:x/user/lead']);
    expect(audienceOf({ participantRole: 'lead' }, { ...ctx, roles: {} })).toEqual([]);
  });
});

describe('T1: validation reads the machines the runtime runs, the classification\'s pack over the platform\'s (ADR-063 decision 1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { deploymentTaskMachines, hasTaskStep } = require('../../lambda/src/lib/profile-lifecycle');
  const signOff = { initial: 'asked', states: { asked: { transitions: ['done'], awaits: { party: 'worker' }, choices: ['done'] }, done: { transitions: [], terminal: 'success' } } };
  const pack = JSON.stringify({ extends: 'default', intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }], machines: { sign_off: signOff } });
  const ssmWith = (answer: (c: any) => Promise<unknown>) => ({ send: answer }) as never;
  const own = (() => {
    const wf = clone(APPROVE) as any;
    wf.states.review.task.machine = 'sign_off';
    wf.states.review.onSuccess = 'approved';
    return wf;
  })();

  it('a machine the classification\'s pack declares may be opened, read from the parameter the runtime hydrates', async () => {
    const asked: string[] = [];
    const read = await deploymentTaskMachines(ssmWith(async (c: any) => { asked.push(c.input.Name); return { Parameter: { Value: pack } }; }), '/ae', 'advisor');
    expect(asked).toEqual(['/ae/assistant/premium/assistant-intent-pack']);
    expect(Object.keys(read.machines)).toEqual(expect.arrayContaining(['sign_off', 'approval', 'queued_request']));
    expect(welcomeWorkflowErrors({ eventWorkflows: { approve: own } } as any, read.machines)).toEqual([]);
    expect(patchShapeErrors({ eventWorkflows: { approve: own } } as any, { machines: read.machines })).toEqual([]);
  });

  it('no pack is the platform\'s set; an unreadable pack is a refusal that says so, never the platform\'s set in its place', async () => {
    const none = await deploymentTaskMachines(ssmWith(async () => { throw Object.assign(new Error('x'), { name: 'ParameterNotFound' }); }), '/ae', 'advisor');
    expect(none.machines.sign_off).toBeUndefined();
    expect(welcomeWorkflowErrors({ eventWorkflows: { approve: own } } as any, none.machines).join(' ')).toMatch(/sign_off/);
    const broken = await deploymentTaskMachines(ssmWith(async () => { throw Object.assign(new Error('x'), { name: 'ThrottlingException' }); }), '/ae', 'advisor');
    expect(broken.error).toMatch(/could not be read \(ThrottlingException\)/);
  });

  it('the pack is read only where a step assigns a task', () => {
    expect(hasTaskStep({ approve: APPROVE })).toBe(true);
    expect(hasTaskStep({ x: { states: { a: { send: {} } } } })).toBe(false);
    expect(hasTaskStep(undefined)).toBe(false);
  });
});
