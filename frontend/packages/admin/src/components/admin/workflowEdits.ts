/**
 * THE ONE SET OF EDITS A WORKFLOW TAKES, whichever view makes them (ADR-061 decision 7).
 *
 * The visual builder (`WorkflowBuilder.tsx`) and the list editor (`EventWorkflowEditor.tsx`) change a version's event
 * workflows through these functions and nothing else: a step of each kind starts valid, a step changed to another kind
 * keeps what the new kind has, a step's name follows it into every edge, a removed step leaves no edge pointing at it,
 * and the first step in order is where the run starts. Each returns a new workflow and never invents a field the runtime
 * does not run (`event-workflow.ts`).
 */
import type {
  EventEdge, EventStepDef, EventWorkflow, IntakeAction,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

export type Kind = 'send' | 'agent' | 'intake' | 'task' | 'opening' | 'prompt' | 'end';
export type EdgeName = 'onSuccess' | 'onFailure' | 'onDeadline';

/** A step or workflow name the server accepts. */
export const STEP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The kinds a workflow on this event may take: the welcome's own two only on `assistant-joined`. */
export const kindsFor = (on: EventWorkflow['on'] | undefined): Kind[] => (on === 'assistant-joined'
  ? ['opening', 'send', 'agent', 'intake', 'task', 'prompt', 'end'] : ['send', 'agent', 'intake', 'task', 'end']);

export const kindOf = (def: EventStepDef): Kind => (def.send ? 'send' : def.agent ? 'agent' : def.action ? 'intake' : def.task ? 'task' : def.opening ? 'opening' : def.prompt ? 'prompt' : 'end');

/** The one person an intake is offered to at an event: the subject, the person who joined, or the person the opening named. */
const intakeTo = (on: EventWorkflow['on'] | undefined): IntakeAction['to'] => (on === 'assistant-joined' ? 'subject' : on === 'person-joined' ? 'joined' : { people: 'event:person' });

/** A step of the given kind, filled with the first templates available so it is valid as soon as it is added. */
export function stepOf(kind: Kind, messages: string[], prompts: string[], next?: string, on?: EventWorkflow['on']): EventStepDef {
  if (kind === 'end') return { disposition: 'success' };
  const edges = next ? { onSuccess: next, onFailure: next } : {};
  if (kind === 'intake') return { action: { tool: 'start_intake', to: intakeTo(on) }, ...edges };
  // A TASK STEP (ADR-063): an acknowledgement for the person the event names, with a day to answer.
  if (kind === 'task') return { task: { machine: 'acknowledgement', for: on === 'assistant-joined' ? 'subject' : { people: 'event:person' }, by: on === 'assistant-joined' ? 'subject' : { people: 'event:person' }, deadline: { afterMinutes: 1440 } }, ...edges };
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
export function convertStep(def: EventStepDef, kind: Kind, messages: string[], prompts: string[], on?: EventWorkflow['on']): EventStepDef {
  if (kind === kindOf(def)) return def;
  if (kind === 'end') return { disposition: 'success' };
  const fresh = stepOf(kind, messages, prompts, undefined, on);
  const to = def.send?.to ?? def.agent?.to;
  const edges = { ...(def.onSuccess ? { onSuccess: def.onSuccess } : {}), ...(def.onFailure ? { onFailure: def.onFailure } : {}) };
  if (fresh.action) return { action: fresh.action, ...edges };
  if (fresh.task) return { task: fresh.task, ...edges };
  if (fresh.opening) return { opening: fresh.opening, ...edges };
  if (fresh.prompt) return { prompt: fresh.prompt, ...edges };
  if (fresh.send) return { send: { ...fresh.send, ...(to ? { to } : {}) }, ...edges };
  return { agent: { ...fresh.agent!, ...(to ? { to } : {}) }, ...edges };
}

/**
 * An edge with a step renamed (`to`) or removed (`undefined`): a step name follows it, and a conditioned edge's
 * alternatives follow it, losing the ones that went to a removed step.
 */
export function retarget(edge: EventEdge | undefined, from: string, to: string | undefined): EventEdge | undefined {
  if (edge === undefined || typeof edge === 'string') return edge === from ? to : edge;
  const kept = edge.flatMap((alt) => (alt.to !== from ? [alt] : to ? [{ ...alt, to }] : []));
  return kept.length ? kept : undefined;
}

/** A step with each of its edges retargeted, an edge left with nowhere to go dropped. */
function retargetStep(def: EventStepDef, from: string, to: string | undefined): EventStepDef {
  const out: EventStepDef = { ...def };
  for (const edge of ['onSuccess', 'onFailure', 'onDeadline'] as const) {
    const next = retarget(def[edge], from, to);
    if (next === undefined) delete out[edge];
    else out[edge] = next;
  }
  return out;
}

/** The steps in order, with the workflow's initial step first. */
export function orderedSteps(wf: EventWorkflow): Array<[string, EventStepDef]> {
  const entries = Object.entries(wf.states);
  return [...entries.filter(([k]) => k === wf.initial), ...entries.filter(([k]) => k !== wf.initial)];
}

/** Rebuild a workflow from ordered steps: the first is where the run starts. */
export function withSteps(wf: EventWorkflow, steps: Array<[string, EventStepDef]>): EventWorkflow {
  return { ...wf, initial: steps[0]?.[0] ?? '', states: Object.fromEntries(steps) };
}

/** A new workflow: a send to the room from the first message template, then the end. Valid as it stands. */
export function newWorkflow(messages: string[], prompts: string[]): EventWorkflow {
  return { on: 'assistant-joined', initial: 'opening', states: { opening: stepOf('send', messages, prompts, 'done'), done: { disposition: 'success' } } };
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
  const def = stepOf(kind, messages, prompts, kind === 'end' ? undefined : next, wf.on);
  let steps = [...orderedSteps(wf), [key, def] as [string, EventStepDef]];
  if (through) steps = steps.map(([k, d]) => [k, k === opts.after ? { ...d, onSuccess: key } : d]);
  return { workflow: withSteps(wf, steps), key };
}

/** Remove a step and every edge that went to it. Removing the first step makes the next one where the run starts. */
export function removeStep(wf: EventWorkflow, key: string): EventWorkflow {
  return withSteps(wf, orderedSteps(wf).filter(([k]) => k !== key).map(([k, d]) => [k, retargetStep(d, key, undefined)]));
}

/** Rename a step; every edge follows it. Null when the name is not one the server accepts or is taken. */
export function renameStep(wf: EventWorkflow, key: string, to: string): EventWorkflow | null {
  if (!to || to === key || !STEP_NAME.test(to) || wf.states[to]) return null;
  return withSteps(wf, orderedSteps(wf).map(([k, d]) => [k === key ? to : k, retargetStep(d, key, to)]));
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
