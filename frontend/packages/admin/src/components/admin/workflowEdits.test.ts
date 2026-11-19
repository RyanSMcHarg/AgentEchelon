/**
 * THE EDITS BOTH VIEWS MAKE OFFER ONLY WHAT VALIDATION ACCEPTS, AND A RUN FOLLOWS ITS EDGES (ADR-061 decisions 1 and 7).
 *
 * What it proves: an intake is offered only where its event names its one person, and a task only where someone may be
 * its one person; a new task step names that person (a one-holder role on an alarm); reordering never moves the start;
 * the steps a run reaches are read from the edges, not the list; a new workflow lands on an event none of the version's
 * workflows holds, so it is never a second untyped welcome; and each step these edits make passes the server's rules.
 */
import { describe, it, expect } from 'vitest';
import {
  INTAKE_EVENTS, MAX_EVENT_WORKFLOW_STEPS, SHIPPED_EVENT_WORKFLOWS, versionEventWorkflowsErrors, type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import {
  addStep, conflictingWorkflow, kindsFor, newWorkflow, orderedSteps, reachableSteps, removeStep, renameStep, startAt,
  taskPersonAt, unreachableSteps, withSteps, askBeforeMeeting, meetingOfferOf, startMeetingAutomatically, MEETING_OFFER_MINUTES,
  changeStepKind, kindOf, atStepLimit,
} from './workflowEdits';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const WELCOME: EventWorkflow = clone(SHIPPED_EVENT_WORKFLOWS.welcome);

describe('the kinds offered at an event', () => {
  it('offers an intake only at the events that name its one person', () => {
    for (const on of ['assistant-joined', 'conversation-opened', 'person-joined', 'invitation-sent', 'invitation-unredeemed', 'alarm-state-changed'] as const) {
      expect(kindsFor(on).includes('intake')).toBe(INTAKE_EVENTS.includes(on));
    }
  });

  it('offers a task on an alarm only where a role of its types has one holder, and names that role', () => {
    expect(kindsFor('alarm-state-changed')).not.toContain('task');
    expect(taskPersonAt('alarm-state-changed')).toBeUndefined();
    expect(kindsFor('alarm-state-changed', ['ops'])).toContain('task');
    expect(taskPersonAt('alarm-state-changed', ['ops'])).toEqual({ participantRole: 'lead' });
    expect(taskPersonAt('assistant-joined')).toBe('subject');
    expect(taskPersonAt('invitation-sent')).toEqual({ people: 'event:person' });
  });

  it('a task step added to an ops alarm workflow is valid as it stands', () => {
    const wf: EventWorkflow = { ...clone(SHIPPED_EVENT_WORKFLOWS['incident-watch']) };
    const { workflow, key } = addStep(wf, 'task', ['incident-alarm-changed'], ['ops-incident-recheck'], { after: 'announce' });
    expect(workflow.states[key].task).toMatchObject({ for: { participantRole: 'lead' }, by: { participantRole: 'lead' } });
    expect(versionEventWorkflowsErrors({ watch: workflow })).toEqual([]);
  });
});

describe('the start and the steps a run reaches', () => {
  const wf: EventWorkflow = {
    on: 'assistant-joined', initial: 'a',
    states: {
      a: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'b' },
      b: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' },
      orphan: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  };

  it('reordering the steps never moves the start; Start here and removing the start do', () => {
    const steps = orderedSteps(wf);
    expect(withSteps(wf, [steps[1], steps[0], ...steps.slice(2)]).initial).toBe('a');
    expect(startAt(wf, 'b').initial).toBe('b');
    expect(removeStep(wf, 'a').initial).toBe('b');
    expect(renameStep(wf, 'a', 'first')!.initial).toBe('first');
  });

  it('reads the steps a run reaches from the edges, not the list', () => {
    expect([...reachableSteps(wf)].sort()).toEqual(['a', 'b', 'done']);
    expect(unreachableSteps(wf)).toEqual(['orphan']);
    const conditioned: EventWorkflow = { ...wf, states: { ...wf.states, a: { ...wf.states.a, onSuccess: [{ to: 'orphan', when: { 'conversation:type': 'ops' } }, { to: 'b' }] } } };
    expect(unreachableSteps(conditioned)).toEqual([]);
  });
});

describe('a new workflow never conflicts with the version\'s own', () => {
  it('is a welcome while the version has none naming no type, and moves to a free event once it has one', () => {
    expect(newWorkflow(['workflow-opening'], []).on).toBe('assistant-joined');
    const withWelcome = { welcome: WELCOME };
    expect(conflictingWorkflow(withWelcome, { on: 'assistant-joined' })).toBe('welcome');
    expect(conflictingWorkflow(withWelcome, { on: 'assistant-joined', types: ['ops'] })).toBeUndefined();
    const next = newWorkflow(['workflow-opening'], [], withWelcome);
    expect(next.on).toBe('person-joined');
    expect(versionEventWorkflowsErrors({ ...withWelcome, added: next })).toEqual([]);
  });

  it('skips every event a workflow of the version already holds, and gives a deadline event its deadline', () => {
    const own: Record<string, EventWorkflow> = { welcome: WELCOME };
    for (const on of ['person-joined', 'invitation-sent', 'alarm-state-changed'] as const) {
      own[on] = { on, initial: 'say', states: { say: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    }
    const next = newWorkflow(['workflow-opening'], [], own);
    expect(next.on).toBe('invitation-unredeemed');
    expect(next.deadline).toEqual({ afterMinutes: 3 * 24 * 60 });
    expect(versionEventWorkflowsErrors({ added: next })).toEqual([]);
  });
});

describe('a wait step (ADR-067 WT20)', () => {
  it('is offered on every event, added as an hour, and read as its own kind', async () => {
    const { kindsFor, stepOf, kindOf } = await import('./workflowEdits');
    const { eventWorkflowErrors } = await import('../../../../../../backend/lambda/src/lib/event-workflow.ts');
    expect(kindsFor('person-joined')).toContain('wait');
    expect(kindsFor('assistant-joined')).toContain('wait');
    const step = stepOf('wait', ['m'], ['p'], 'done', 'person-joined');
    expect(step).toEqual({ wait: { minutes: 60 }, onSuccess: 'done', onFailure: 'done' });
    expect(kindOf(step)).toBe('wait');
    const wf = { on: 'person-joined', initial: 'hi', states: { hi: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'w', onFailure: 'w' }, w: step, done: { disposition: 'success' } } };
    expect(eventWorkflowErrors('x', wf)).toEqual([]);
  });

  it('a step changed to a wait is a wait that keeps its edges, and the workflow stays valid', () => {
    const esc = clone(SHIPPED_EVENT_WORKFLOWS['incident-triage']);
    const wf = changeStepKind(esc, 'tell', 'wait', ['m'], ['p']);
    const step = wf.states.tell;
    expect(kindOf(step)).toBe('wait');
    expect(step.wait).toEqual({ minutes: 60 });
    expect(step.agent).toBeUndefined();
    expect(step.onSuccess).toBe(esc.states.tell.onSuccess);
    expect(versionEventWorkflowsErrors({ 'incident-triage': wf })).toEqual([]);
  });
});

describe('a step that opens a child conversation changed to another kind', () => {
  it('keeps no edge to the wait on the child it removes, so the workflow stays valid', () => {
    const esc = clone(SHIPPED_EVENT_WORKFLOWS['incident-triage']);
    // The copy goes from the open step straight to the wait on its child.
    const direct = { ...esc, states: { ...esc.states, open: { ...esc.states.open, onSuccess: 'hold' } } } as EventWorkflow;
    delete (direct.states as Record<string, unknown>).tell;
    const changed = changeStepKind(direct, 'open', 'send', ['incident-timed-out'], []);
    expect(changed.states.hold).toBeUndefined();
    expect(kindOf(changed.states.open)).toBe('send');
    expect(Object.values(changed.states).flatMap((d) => [d.onSuccess, d.onFailure]).filter((e) => e !== undefined)
      .every((e) => typeof e === 'string' && e in changed.states)).toBe(true);
    expect(versionEventWorkflowsErrors({ 'incident-triage': changed })).toEqual([]);
  });
});

describe('a meeting step that asks first', () => {
  const ONCALL = { participantRole: 'on-call:ops' } as const;
  const ops = (): EventWorkflow => ({
    on: 'event-received', types: ['ops-team'], initial: 'tell',
    states: {
      tell: { send: { to: 'room', template: 'incident-timed-out' }, onSuccess: 'meet', onFailure: 'meet' },
      meet: { action: { tool: 'start_meeting', email: true }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  }) as unknown as EventWorkflow;

  it('puts an offer for the on-call in front of the meeting, and every edge into the meeting goes through it', () => {
    const wf = askBeforeMeeting(ops(), 'meet', ONCALL);
    expect(meetingOfferOf(wf, 'meet')).toBe('meet-offer');
    expect(wf.states.tell.onSuccess).toBe('meet-offer');
    expect(wf.states.tell.onFailure).toBe('meet-offer');
    expect(wf.states['meet-offer']).toEqual({
      task: { machine: 'meeting_offer', for: ONCALL, by: ONCALL, visibility: 'private', deadline: { afterMinutes: MEETING_OFFER_MINUTES } },
      onSuccess: [{ to: 'meet', when: { 'task:state': 'start' } }, { to: 'done' }],
      onFailure: 'done',
    });
    expect(versionEventWorkflowsErrors({ ops: wf })).toEqual([]);
  });

  it('adds no offer to a workflow at its step limit, so it never becomes one the server refuses', () => {
    const base = ops();
    const states: Record<string, unknown> = { ...base.states };
    for (let i = 0; Object.keys(states).length < MAX_EVENT_WORKFLOW_STEPS; i++) states[`pad-${i}`] = { disposition: 'success' };
    const full = { ...base, states } as EventWorkflow;
    expect(atStepLimit(full)).toBe(true);
    expect(askBeforeMeeting(full, 'meet', ONCALL)).toBe(full);
  });

  it('moves the run\'s start to the offer when the meeting is the first step', () => {
    const first = { ...ops(), initial: 'meet' } as EventWorkflow;
    expect(askBeforeMeeting(first, 'meet', ONCALL).initial).toBe('meet-offer');
  });

  it('updates the offer already there rather than adding a second', () => {
    const once = askBeforeMeeting(ops(), 'meet', ONCALL);
    const twice = askBeforeMeeting(once, 'meet', { people: 'event:person' }, 5);
    expect(Object.keys(twice.states).filter((k) => k.endsWith('-offer'))).toEqual(['meet-offer']);
    expect(twice.states['meet-offer'].task).toEqual(expect.objectContaining({ by: { people: 'event:person' }, deadline: { afterMinutes: 5 } }));
  });

  it('keeps the offer deadline\'s kind and reminder count when its minutes change, and its whole deadline when only the person does', () => {
    const once = askBeforeMeeting(ops(), 'meet', ONCALL);
    const reminding = {
      ...once,
      states: { ...once.states, 'meet-offer': { ...once.states['meet-offer'], task: { ...once.states['meet-offer'].task!, deadline: { afterMinutes: 30, kind: 'remind', times: 2 } } } },
    } as EventWorkflow;
    expect(askBeforeMeeting(reminding, 'meet', ONCALL, 45).states['meet-offer'].task!.deadline).toEqual({ afterMinutes: 45, kind: 'remind', times: 2 });
    expect(askBeforeMeeting(reminding, 'meet', { people: 'event:person' }).states['meet-offer'].task!.deadline).toEqual({ afterMinutes: 30, kind: 'remind', times: 2 });
  });

  it('removing the meeting removes its offer, and no edge is left pointing at either', () => {
    const removed = removeStep(askBeforeMeeting(ops(), 'meet', ONCALL), 'meet');
    expect(Object.keys(removed.states)).toEqual(['tell', 'done']);
    expect(removed.states.tell).toEqual({ send: { to: 'room', template: 'incident-timed-out' } });
  });

  it('changing the meeting to another kind removes its offer, and the edges into the offer go to the changed step', () => {
    const changed = changeStepKind(askBeforeMeeting(ops(), 'meet', ONCALL), 'meet', 'send', ['incident-timed-out'], []);
    expect(meetingOfferOf(changed, 'meet')).toBeUndefined();
    expect(Object.keys(changed.states)).toEqual(['tell', 'meet', 'done']);
    expect(changed.states.tell.onSuccess).toBe('meet');
    expect(kindOf(changed.states.meet)).toBe('send');
    expect(Object.values(changed.states).some((d) => d.task?.machine === 'meeting_offer')).toBe(false);
  });

  it('starts automatically again: the offer goes and its edges return to the meeting', () => {
    const back = startMeetingAutomatically(askBeforeMeeting({ ...ops(), initial: 'meet' } as EventWorkflow, 'meet', ONCALL), 'meet');
    expect(meetingOfferOf(back, 'meet')).toBeUndefined();
    expect(back.initial).toBe('meet');
    expect(back.states).toEqual(ops().states);
  });
});
