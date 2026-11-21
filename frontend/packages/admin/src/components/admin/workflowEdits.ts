/**
 * THE ONE SET OF EDITS A WORKFLOW TAKES, whichever view makes them (ADR-061 decision 7).
 *
 * The visual builder (`WorkflowBuilder.tsx`) and the list editor (`EventWorkflowEditor.tsx`) change a version's event
 * workflows through these functions and nothing else: a step of each kind starts valid, a step changed to another kind
 * keeps what the new kind has, a step's name follows it into every edge, a removed step leaves no edge pointing at it,
 * and the step the run starts at changes only when a step is made the start (`startAt`) or the start is removed. A run
 * follows its edges from the start, never the order steps are listed in, so a step no edge reaches never runs
 * (`unreachableSteps`). Each returns a new workflow and never invents a field the runtime does not run
 * (`event-workflow.ts`).
 */
import {
  EVENTS_NAMING_A_PERSON, EVENTS_SELECTING_THEIR_WORKFLOW, INTAKE_EVENTS, INTENT_TRIGGER, MAX_EVENT_WORKFLOW_STEPS, TYPE_SELECTED_EVENTS, edgeTargets, isMeetingAction,
  type EventEdge, type EventStepDef, type EventWorkflow, type IntakeAction, type WorkflowEvent,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { TASK_STEP_ALONGSIDE, type TaskPerson } from '../../../../../../backend/lambda/src/lib/task-step.ts';
import { isAudienceRole, participantRoleOf, participantRolesOf } from '../../../../../../backend/lib/config/participant-roles.ts';

export type Kind = 'send' | 'agent' | 'intake' | 'task' | 'wait' | 'meeting' | 'opening' | 'prompt' | 'open' | 'handoff' | 'end';
export type EdgeName = 'onSuccess' | 'onFailure' | 'onDeadline';

/** A step or workflow name the server accepts. */
export const STEP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The page's request to open the builder on creating a workflow: never a name STEP_NAME accepts, so never a workflow's. */
export const NEW_WORKFLOW_FOCUS = '+new';

/**
 * THE ONE PERSON A TASK STEP AT THIS EVENT IS FOR AND WORKED BY, as a new task step names them: the subject at
 * `assistant-joined`, the person the event names where it names one, else a participant role every type the workflow
 * declares gives one addressable holder. Undefined when the event names nobody a task could be for.
 */
export function taskPersonAt(on: EventWorkflow['on'] | undefined, types?: readonly string[]): TaskPerson | undefined {
  if (on === 'assistant-joined') return 'subject';
  // AN INTENT'S RUN is for the person who asked (ADR-067 G17).
  if (on === INTENT_TRIGGER) return 'requester';
  if (on && EVENTS_NAMING_A_PERSON.includes(on)) return { people: 'event:person' };
  if (!types?.length) return undefined;
  const role = Object.keys(participantRolesOf(types[0])).sort().find((r) => types.every((t) => {
    const decl = participantRoleOf(t, r);
    return isAudienceRole(decl) && decl?.holders === 'one';
  }));
  return role ? { participantRole: role } : undefined;
}

/**
 * The kinds a workflow on this event may take, as validation accepts them: the welcome's own two only on
 * `assistant-joined`, an intake only where the event names its one person (`INTAKE_EVENTS`), and a task only where
 * someone may be its one person (`taskPersonAt`).
 */
export const kindsFor = (on: EventWorkflow['on'] | undefined, types?: readonly string[]): Kind[] => {
  const all: Kind[] = on === 'assistant-joined' ? ['opening', 'send', 'agent', 'intake', 'task', 'wait', 'meeting', 'prompt', 'end'] : ['send', 'agent', 'intake', 'task', 'wait', 'meeting', 'end'];
  return all.filter((k) => (k !== 'intake' || (!!on && INTAKE_EVENTS.includes(on))) && (k !== 'task' || !!taskPersonAt(on, types)));
};

export const kindOf = (def: EventStepDef): Kind => (def.send ? 'send' : def.agent ? 'agent' : def.action ? (isMeetingAction(def.action) ? 'meeting' : 'intake') : def.task ? 'task' : def.wait ? 'wait' : def.opening ? 'opening' : def.prompt ? 'prompt' : def.open ? 'open' : def.handoff ? 'handoff' : 'end');

/** The one person an intake is offered to at an event: the subject, the person who joined, or the person the opening named. */
const intakeTo = (on: EventWorkflow['on'] | undefined): IntakeAction['to'] => (on === 'assistant-joined' ? 'subject' : on === 'person-joined' ? 'joined' : { people: 'event:person' });

/** A step of the given kind, filled with the first templates available so it is valid as soon as it is added. */
export function stepOf(kind: Kind, messages: string[], prompts: string[], next?: string, on?: EventWorkflow['on'], types?: readonly string[]): EventStepDef {
  if (kind === 'end') return { disposition: 'success' };
  const edges = next ? { onSuccess: next, onFailure: next } : {};
  if (kind === 'intake') return { action: { tool: 'start_intake', to: intakeTo(on) }, ...edges };
  // A MEETING: started, the room rings for the deployment's ring length, told, and emailed the join link.
  if (kind === 'meeting') return { action: { tool: 'start_meeting', email: true }, ...edges };
  // A TASK STEP (ADR-063): an acknowledgement for the one person the event names (`taskPersonAt`), with a day to answer.
  if (kind === 'task') {
    const person = taskPersonAt(on, types) ?? { people: 'event:person' };
    return { task: { machine: 'acknowledgement', for: person, by: person, deadline: { afterMinutes: 1440 } }, ...edges };
  }
  // A WAIT (WT20): an hour, from which the run goes on.
  if (kind === 'wait') return { wait: { minutes: 60 }, ...edges };
  if (kind === 'opening') return { opening: {}, ...edges };
  if (kind === 'prompt') return { prompt: { template: prompts[0] ?? '' }, ...edges };
  if (kind === 'send') return { send: { to: 'room', template: messages[0] ?? '' }, ...edges };
  return {
    agent: { prompt: prompts[0] ?? '', tools: [], to: 'room', deadlineMs: 20_000, fallback: { send: { to: 'room', template: messages[0] ?? '' } } },
    ...edges,
  };
}

/**
 * A STEP CHANGED TO ANOTHER KIND: its edges kept where the new kind has them (an end has none), its audience kept
 * between a send and an agent step, a participant role's included (an agent step addresses a role's holders as a send
 * does), and every field the new kind does not have cleared.
 */
export function convertStep(def: EventStepDef, kind: Kind, messages: string[], prompts: string[], on?: EventWorkflow['on'], types?: readonly string[]): EventStepDef {
  if (kind === kindOf(def)) return def;
  if (kind === 'end') return { disposition: 'success' };
  const fresh = stepOf(kind, messages, prompts, undefined, on, types);
  const to = def.send?.to ?? def.agent?.to;
  const edges = { ...(def.onSuccess ? { onSuccess: def.onSuccess } : {}), ...(def.onFailure ? { onFailure: def.onFailure } : {}) };
  if (fresh.action) return { action: fresh.action, ...edges };
  if (fresh.task) return { task: fresh.task, ...edges };
  if (fresh.wait) return { wait: fresh.wait, ...edges };
  if (fresh.opening) return { opening: fresh.opening, ...edges };
  if (fresh.prompt) return { prompt: fresh.prompt, ...edges };
  if (fresh.send) return { send: { ...fresh.send, ...(to ? { to } : {}) }, ...edges };
  return { agent: { ...fresh.agent!, ...(to ? { to } : {}) }, ...edges };
}

/**
 * An edge with a step renamed (`to`) or removed (`undefined`): a step name follows it, and a conditioned edge's
 * alternatives follow it, losing the ones that went to a removed step. A conditioned edge always ends on an alternative
 * with no condition, which a run takes when no earlier one holds: when that one went to a removed step, it goes to `end`
 * (the workflow's end step) instead, and with no end step the edge goes, as a plain edge to a removed step does.
 */
export function retarget(edge: EventEdge | undefined, from: string, to: string | undefined, end?: string): EventEdge | undefined {
  if (edge === undefined || typeof edge === 'string') return edge === from ? to : edge;
  const kept = edge.flatMap((alt) => (alt.to !== from ? [alt] : to ? [{ ...alt, to }] : []));
  if (!kept.length || kept[kept.length - 1].when === undefined) return kept.length ? kept : undefined;
  return end && end !== from ? [...kept, { to: end }] : undefined;
}

/** A step with each of its edges retargeted, an edge left with nowhere to go dropped. */
function retargetStep(def: EventStepDef, from: string, to: string | undefined, end?: string): EventStepDef {
  const out: EventStepDef = { ...def };
  for (const edge of ['onSuccess', 'onFailure', 'onDeadline'] as const) {
    const next = retarget(def[edge], from, to, end);
    if (next === undefined) delete out[edge];
    else out[edge] = next;
  }
  // A RESOLVE THAT MOVES THE RUN ON (`movesTo`, O15) follows the step it names; with that step gone, the task ends the run.
  if (def.task?.movesTo === from) {
    const { movesTo: _gone, ...task } = def.task;
    out.task = to ? { ...task, movesTo: to } : task;
  }
  return out;
}

/** The steps in order, with the step the run starts at listed first. */
export function orderedSteps(wf: EventWorkflow): Array<[string, EventStepDef]> {
  const entries = Object.entries(wf.states);
  return [...entries.filter(([k]) => k === wf.initial), ...entries.filter(([k]) => k !== wf.initial)];
}

/**
 * Rebuild a workflow from ordered steps. The run starts where it did (`initial` when given, else the workflow's own) while
 * that step is still declared, so reordering the list never moves the start; with it gone, at the first step listed.
 */
export function withSteps(wf: EventWorkflow, steps: Array<[string, EventStepDef]>, initial: string = wf.initial): EventWorkflow {
  const start = steps.some(([k]) => k === initial) ? initial : steps[0]?.[0] ?? '';
  return { ...wf, initial: start, states: Object.fromEntries(steps) };
}

/**
 * THE STEPS A RUN REACHES: from the start, along every step's success, failure and deadline edges (each conditioned
 * edge's alternatives included), as the runtime follows them. List order plays no part.
 */
export function reachableSteps(wf: EventWorkflow): Set<string> {
  const states = wf.states ?? {};
  const seen = new Set<string>();
  const queue = states[wf.initial] ? [wf.initial] : [];
  while (queue.length) {
    const at = queue.shift()!;
    if (seen.has(at) || !states[at]) continue;
    seen.add(at);
    const def = states[at];
    queue.push(...[def.onSuccess, def.onFailure, def.onDeadline].flatMap((e) => edgeTargets(e)));
    // A RESOLVE THAT MOVES THE RUN ON reaches the step it names (`movesTo`, O15).
    if (def.task?.movesTo) queue.push(def.task.movesTo);
  }
  return seen;
}

/** The steps no edge from the start reaches, in list order: steps that never run. */
export function unreachableSteps(wf: EventWorkflow): string[] {
  const reached = reachableSteps(wf);
  return Object.keys(wf.states ?? {}).filter((k) => !reached.has(k));
}

/**
 * THE VERSION'S WORKFLOW A NEW ONE WOULD CONFLICT WITH, as `versionEventWorkflowsErrors` refuses the pair: a second
 * workflow on an event that selects its own, a second naming no type on an event the room's type selects on, or one
 * naming a type another already answers for there. Undefined when there is none.
 */
export function conflictingWorkflow(own: Readonly<Record<string, EventWorkflow>> | null | undefined, wf: Pick<EventWorkflow, 'on' | 'types'>): string | undefined {
  const on = Object.entries(own ?? {}).filter(([, w]) => w?.on === wf.on);
  if (EVENTS_SELECTING_THEIR_WORKFLOW.includes(wf.on)) return on[0]?.[0];
  if (!TYPE_SELECTED_EVENTS.includes(wf.on)) return undefined;
  if (!wf.types?.length) return on.find(([, w]) => !w.types?.length)?.[0];
  return on.find(([, w]) => (w.types ?? []).some((t) => wf.types!.includes(t)))?.[0];
}

/** The events a new workflow may start on, in the order one is chosen: each is valid opening with a send to the room. */
const NEW_WORKFLOW_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'person-joined', 'invitation-sent', 'alarm-state-changed', 'invitation-unredeemed'];

/**
 * A new workflow: a send to the room from the first message template, then the end, on the first event none of the
 * version's workflows already holds (`conflictingWorkflow`), so adding one never makes the version refused. With
 * every such event taken it is a welcome, which then names the types it runs in.
 */
export function newWorkflow(messages: string[], prompts: string[], own?: Readonly<Record<string, EventWorkflow>> | null): EventWorkflow {
  const on = NEW_WORKFLOW_EVENTS.find((e) => !conflictingWorkflow(own, { on: e })) ?? 'assistant-joined';
  return {
    on,
    ...(on === 'invitation-unredeemed' ? { deadline: { afterMinutes: 3 * 24 * 60 } } : {}),
    initial: 'opening',
    states: { opening: stepOf('send', messages, prompts, 'done', on), done: { disposition: 'success' } },
  };
}

/** The next free `step-N` name. */
export function freeStepName(wf: EventWorkflow): string {
  const keys = Object.keys(wf.states);
  let n = keys.length + 1;
  while (keys.includes(`step-${n}`)) n++;
  return `step-${n}`;
}

/** The workflow's first end step, where a new step goes on by default. */
export const endStepOf = (wf: EventWorkflow): string | undefined => Object.keys(wf.states).find((k) => wf.states[k].disposition);

/** Whether the workflow holds the most steps validation accepts (`MAX_EVENT_WORKFLOW_STEPS`), so no step can be added. */
export const atStepLimit = (wf: EventWorkflow): boolean => Object.keys(wf.states ?? {}).length >= MAX_EVENT_WORKFLOW_STEPS;

/**
 * ADD A STEP. Appended after every other step and going on to the workflow's end; or, `after` a step, put between that
 * step and where its success edge went, so the run passes through it (B3, click to insert). A step whose success edge is
 * conditioned keeps it, and the new step is added unconnected for the person to connect.
 */
export function addStep(
  wf: EventWorkflow, kind: Kind, messages: string[], prompts: string[], opts: { after?: string; name?: string } = {},
): { workflow: EventWorkflow; key: string } {
  const key = opts.name && STEP_NAME.test(opts.name) && !wf.states[opts.name] ? opts.name : freeStepName(wf);
  const after = opts.after ? wf.states[opts.after] : undefined;
  const through = after && !after.disposition && (after.onSuccess === undefined || typeof after.onSuccess === 'string');
  const next = through ? (after!.onSuccess as string | undefined) ?? endStepOf(wf) : endStepOf(wf);
  const def = stepOf(kind, messages, prompts, kind === 'end' ? undefined : next, wf.on, wf.types);
  let steps = [...orderedSteps(wf), [key, def] as [string, EventStepDef]];
  if (through) steps = steps.map(([k, d]) => [k, k === opts.after ? { ...d, onSuccess: key } : d]);
  return { workflow: withSteps(wf, steps), key };
}

/**
 * Remove a step and every edge that went to it. Removing the start makes the next step listed where the run starts. A
 * meeting step that asks first goes with its offer, so no card offers a meeting that is no longer there, and the last
 * step that opens a conversation goes with each wait on that conversation (`withoutChildWaits`). A conditioned edge whose
 * unconditioned alternative went to the step goes to the workflow's end step instead (`retarget`).
 */
export function removeStep(wf: EventWorkflow, key: string): EventWorkflow {
  return dropStep(withoutChildWaits(startMeetingAutomatically(wf, key), key), key);
}

/** One step removed, every edge that went to it retargeted (`retargetStep`) toward the end step that remains. */
function dropStep(wf: EventWorkflow, key: string): EventWorkflow {
  const end = Object.keys(wf.states).find((k) => k !== key && wf.states[k].disposition);
  return withSteps(wf, orderedSteps(wf).filter(([k]) => k !== key).map(([k, d]) => [k, retargetStep(d, key, undefined, end)]));
}

/** Whether a step opens a conversation whose own run a wait may wait on: an open step that is not a move. */
const opensAChild = (def: EventStepDef | undefined): boolean => !!def?.open && def.open.mode !== 'move';

/**
 * A WAIT ON THE OPENED CONVERSATION (`wait: { child }`) WAITS ON A CONVERSATION THE RUN OPENS. When `key` is the last step
 * that opens one and it is removed or becomes another kind, each such wait is removed with it, so no wait is left on a
 * conversation the run no longer opens.
 */
function withoutChildWaits(wf: EventWorkflow, key: string): EventWorkflow {
  // A WAIT ON THE TASKS THE RUN GOES ON ALONGSIDE (`wait: { alongside }`) goes the same way with the last such task.
  const alongside = (def: EventStepDef | undefined) => def?.task?.continue === TASK_STEP_ALONGSIDE;
  const lastOf = (is: (d: EventStepDef | undefined) => boolean) => is(wf.states[key]) && !Object.entries(wf.states).some(([k, d]) => k !== key && is(d));
  const drop = [
    ...(lastOf(opensAChild) ? Object.keys(wf.states).filter((k) => wf.states[k].wait?.child !== undefined) : []),
    ...(lastOf(alongside) ? Object.keys(wf.states).filter((k) => wf.states[k].wait?.alongside !== undefined) : []),
  ];
  return drop.reduce(dropStep, wf);
}

/**
 * CHANGE A STEP'S KIND (`convertStep`) in its workflow. A meeting step that asks first and becomes another kind loses its
 * offer, and every edge that went to the offer goes to the step, so no card offers a meeting the step no longer starts.
 */
export function changeStepKind(
  wf: EventWorkflow, key: string, kind: Kind, messages: string[], prompts: string[],
): EventWorkflow {
  const def = wf.states[key];
  if (!def || kind === kindOf(def)) return wf;
  // The step converts as it stands once its offer and child waits are gone, so it keeps no edge to a removed step.
  const from = withoutChildWaits(startMeetingAutomatically(wf, key), key);
  return updateStep(from, key, convertStep(from.states[key], kind, messages, prompts, wf.on, wf.types));
}

/** Rename a step; every edge follows it. Null when the name is not one the server accepts or is taken. */
export function renameStep(wf: EventWorkflow, key: string, to: string): EventWorkflow | null {
  if (!to || to === key || !STEP_NAME.test(to) || wf.states[to]) return null;
  return withSteps(wf, orderedSteps(wf).map(([k, d]) => [k === key ? to : k, retargetStep(d, key, to)]), wf.initial === key ? to : wf.initial);
}

/** Replace one step's definition. */
export const updateStep = (wf: EventWorkflow, key: string, def: EventStepDef): EventWorkflow =>
  withSteps(wf, orderedSteps(wf).map(([k, d]) => [k, k === key ? def : d]));

/** Make a step the one the run starts at. */
export const startAt = (wf: EventWorkflow, key: string): EventWorkflow => (wf.states[key] ? { ...wf, initial: key } : wf);

/**
 * CONNECT one step's edge to another (B3, reconnect): a step name replaces a plain edge, and on a conditioned edge it
 * becomes the alternative taken otherwise. An end step has no edges, a step never goes to itself, and only a task step
 * has a deadline edge.
 */
export function connect(wf: EventWorkflow, from: string, edge: EdgeName, to: string): EventWorkflow {
  const def = wf.states[from];
  if (!def || def.disposition || from === to || !wf.states[to] || (edge === 'onDeadline' && !def.task)) return wf;
  const current = def[edge];
  const next: EventEdge = current !== undefined && typeof current !== 'string' && current.length > 1
    ? [...current.slice(0, -1), { to }]
    : to;
  return updateStep(wf, from, { ...def, [edge]: next });
}

/** Clear one step's edge. */
export function disconnect(wf: EventWorkflow, from: string, edge: EdgeName): EventWorkflow {
  const def = wf.states[from];
  if (!def || def[edge] === undefined) return wf;
  const { [edge]: _gone, ...rest } = def;
  return updateStep(wf, from, rest);
}

/** The platform machine a meeting is offered on, the choice that starts it, and how long the person asked has by default. */
export const MEETING_OFFER_MACHINE = 'meeting_offer';
export const MEETING_OFFER_START = 'start';
export const MEETING_OFFER_MINUTES = 15;

/**
 * THE OFFER IN FRONT OF A MEETING STEP, when the step asks first: a `meeting_offer` task whose `start` goes on to the meeting
 * step. Undefined when the meeting starts automatically.
 */
export function meetingOfferOf(wf: EventWorkflow, key: string): string | undefined {
  return Object.keys(wf.states).find((k) => {
    const d = wf.states[k];
    return d.task?.machine === MEETING_OFFER_MACHINE && Array.isArray(d.onSuccess)
      && d.onSuccess.some((alt) => alt.to === key && alt.when?.['task:state'] === MEETING_OFFER_START);
  });
}

/**
 * A MEETING STEP THAT ASKS FIRST: an offer step goes in front of it, a `meeting_offer` card for `by` (a person, or a
 * participant role's one holder such as the on-call), and every edge into the meeting step, the run's start included, goes
 * to the offer instead. `start` goes on to the meeting; declined, unanswered or with nobody to ask, the run goes where the
 * meeting step's failure edge goes. With an offer already there, its person is updated, and its minutes when given: the
 * deadline keeps its kind and reminder count, and leaves a recorded time for the minutes.
 */
export function askBeforeMeeting(wf: EventWorkflow, key: string, by: TaskPerson, afterMinutes?: number): EventWorkflow {
  const def = wf.states[key];
  if (!def || !isMeetingAction(def.action)) return wf;
  const existing = meetingOfferOf(wf, key);
  if (existing) {
    const offer = wf.states[existing];
    const { at: _at, ...kept } = offer.task!.deadline ?? {};
    const deadline = afterMinutes === undefined ? offer.task!.deadline : { ...kept, afterMinutes };
    const { deadline: _d, ...task } = offer.task!;
    return updateStep(wf, existing, { ...offer, task: { ...task, for: by, by, ...(deadline ? { deadline } : {}) } });
  }
  // A WORKFLOW AT ITS STEP LIMIT TAKES NO OFFER STEP, so asking first never makes one the server refuses.
  if (atStepLimit(wf)) return wf;
  afterMinutes ??= MEETING_OFFER_MINUTES;
  const named = `${key}-offer`;
  const offerKey = STEP_NAME.test(named) && !wf.states[named] ? named : freeStepName(wf);
  const otherwise = typeof def.onFailure === 'string' ? def.onFailure : endStepOf(wf);
  const offer: EventStepDef = {
    task: { machine: MEETING_OFFER_MACHINE, for: by, by, visibility: 'private', deadline: { afterMinutes } },
    onSuccess: [{ to: key, when: { 'task:state': MEETING_OFFER_START } }, ...(otherwise ? [{ to: otherwise }] : [])],
    ...(otherwise ? { onFailure: otherwise } : {}),
  };
  const steps = orderedSteps(wf).flatMap(([k, d]): Array<[string, EventStepDef]> => (
    k === key ? [[offerKey, offer], [k, d]] : [[k, retargetStep(d, key, offerKey)]]
  ));
  return withSteps(wf, steps, wf.initial === key ? offerKey : wf.initial);
}

/** A MEETING STEP THAT STARTS AUTOMATICALLY: its offer step is removed, and every edge that went to the offer goes to the meeting step. */
export function startMeetingAutomatically(wf: EventWorkflow, key: string): EventWorkflow {
  const offerKey = meetingOfferOf(wf, key);
  if (!offerKey) return wf;
  const steps = orderedSteps(wf).filter(([k]) => k !== offerKey).map(([k, d]): [string, EventStepDef] => [k, retargetStep(d, offerKey, key)]);
  return withSteps(wf, steps, wf.initial === offerKey ? key : wf.initial);
}
