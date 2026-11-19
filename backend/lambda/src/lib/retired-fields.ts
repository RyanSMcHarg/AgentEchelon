/**
 * A STORED VERSION'S RETIRED FIELDS, REWRITTEN INTO THE CURRENT FORM FOR A NEW DRAFT (ADR-067 stage 4, decision 5).
 *
 * A version is immutable by its `configId`, so a stored version is never rewritten in place and the runtime keeps reading
 * what it stores. A NEW draft, and an import, is written in the current form: a draft cloned from a stored version, or a
 * manifest exported before the fields retired, is rewritten here before it is saved, and the validator refuses the
 * retired fields on anything saved after.
 *
 * WHAT RETIRES, AND WHAT IT BECOMES:
 *  - `agent.workflow` (an agent step whose runtime opened a task in the room and ran its first step) becomes a create-task
 *    step on the same machine, worked by the step's assistant (`as`, else the run's own), visible to the room, and going
 *    on once the task leaves its first step (`continue: 'opened'`), which is what the agent step's turn did. The step's
 *    fallback messages are kept as sends on its failure edge: the absent message where nobody holds the step's role
 *    (`task:outcome` is `no-worker`), the fallback where the task could not open.
 *  - `workflows` (the selection of which multi-step intents may open a task, ADR-047) becomes what each intent is: an
 *    intent that has a workflow is multi-step and opens work, and one that has none is single-turn. So each multi-step
 *    intent of the version's own pack that the selection left out is made single-turn there, which is exactly what it
 *    did at run time, and the selection is dropped. A version whose pack is the classification's is handed that pack as
 *    its own first (`pack`); with neither, the selection stays and the validator refuses it by name.
 *
 * Pure: no AWS call. Returns the body unchanged, and no rewrites, where it holds no retired field.
 */
import type { AgentStep, EventEdge, EventStepDef, EventWorkflow, SendStep } from './event-workflow.js';
import { OWNER_DECIDED_STEP_FIELDS, workerAssistantRole } from './task-step.js';
import type { ProfileDefinitionBody } from './active-profile.js';

/** The rewritten body and what was rewritten, by path, so the caller can say it. */
export interface CurrentForm {
  body: ProfileDefinitionBody;
  rewritten: string[];
}

const NO_WORKER = 'no-worker';

/** One agent step that opened a task, as the create-task step and fallback sends that do the same. */
function taskStepFor(key: string, def: EventStepDef, taken: ReadonlySet<string>): Record<string, EventStepDef> {
  const agent = def.agent as AgentStep;
  const machine = agent.workflow as string;
  const after: EventEdge | undefined = def.onFailure;
  const free = (name: string): string => {
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}-${i}`;
    return n;
  };
  const out: Record<string, EventStepDef> = {};
  const failure: Array<{ to: string; when?: Record<string, string> }> = [];
  const sendStep = (send: SendStep): EventStepDef => ({ send, ...(after !== undefined ? { onSuccess: after, onFailure: after } : {}) });
  if (agent.as && agent.fallback?.absent) {
    const absent = free(`${key}-absent`);
    out[absent] = sendStep({ to: agent.fallback.absent.to, template: agent.fallback.absent.template });
    failure.push({ to: absent, when: { 'task:outcome': NO_WORKER } });
  }
  if (agent.fallback?.send) {
    const unavailable = free(`${key}-unavailable`);
    out[unavailable] = sendStep(agent.fallback.send);
    failure.push({ to: unavailable });
  }
  // A CONDITIONED EDGE ENDS ON AN UNCONDITIONED ALTERNATIVE: where only the absent message was kept, every other failure
  // takes the step's own failure edge, or the absent message where that edge was a list or absent.
  if (failure.length && failure[failure.length - 1].when) {
    if (typeof after === 'string') failure.push({ to: after });
    else if (Array.isArray(after)) failure.push(...(after as Array<{ to: string; when?: Record<string, string> }>));
    else {
      // The step's failure ended the run, so every failure but the absent one still does.
      const end = free(`${key}-ended`);
      out[end] = { disposition: 'failure' };
      failure.push({ to: end });
    }
  }
  const onFailure: EventEdge | undefined = failure.length
    ? (failure.length === 1 && !failure[0].when ? failure[0].to : (failure as unknown as EventEdge))
    : after;
  out[key] = {
    task: {
      machine,
      // A REQUEST TO ANOTHER ASSISTANT'S ROLE leaves who sees the work to its owner (WT118); the run's own task is the room's.
      ...(agent.as?.role ? { by: { assistantRole: agent.as.role } } : { visibility: 'conversation' }),
      continue: 'opened',
    },
    ...(def.onSuccess !== undefined ? { onSuccess: def.onSuccess } : {}),
    ...(onFailure !== undefined ? { onFailure } : {}),
    ...(def.when !== undefined ? { when: def.when } : {}),
  } as EventStepDef;
  return out;
}

/**
 * THE INCIDENT WATCH'S RE-READ AS A REQUEST (WT118): the agent step the ops role took becomes a request to that role for
 * `deployment_health`, saying what is needed in `incident-recheck-ask`. Its own absent and fallback messages become the
 * sends its failure edge takes, under names no other step holds, and its success edge, its own failure edge (after them)
 * and its gate are kept.
 */
function recheckRequestFor(key: string, def: EventStepDef, taken: ReadonlySet<string>): Record<string, EventStepDef> {
  const agent = def.agent as AgentStep;
  const used = new Set(taken);
  const free = (name: string): string => {
    let n = name;
    for (let i = 2; used.has(n); i++) n = `${name}-${i}`;
    used.add(n);
    return n;
  };
  const after: EventEdge | undefined = def.onFailure;
  const sendStep = (send: SendStep): EventStepDef => ({ send, ...(after !== undefined ? { onSuccess: after, onFailure: after } : {}) });
  const out: Record<string, EventStepDef> = {};
  const failure: Array<{ to: string; when?: Record<string, string> }> = [];
  if (agent.fallback?.absent) {
    const absent = free(`${key}-absent`);
    out[absent] = sendStep({ to: agent.fallback.absent.to, template: agent.fallback.absent.template });
    failure.push({ to: absent, when: { 'task:outcome': NO_WORKER } });
  }
  if (agent.fallback?.send) {
    const unavailable = free(`${key}-unavailable`);
    out[unavailable] = sendStep(agent.fallback.send);
    failure.push({ to: unavailable });
  } else if (typeof after === 'string') {
    failure.push({ to: after });
  }
  const onFailure: EventEdge | undefined = failure.length
    ? (failure.length === 1 && !failure[0].when ? failure[0].to : (failure as unknown as EventEdge))
    : after;
  out[key] = {
    task: { machine: 'deployment_health', by: { assistantRole: agent.as!.role }, ask: { template: 'incident-recheck-ask' } },
    ...(def.onSuccess !== undefined ? { onSuccess: def.onSuccess } : {}),
    ...(onFailure !== undefined ? { onFailure } : {}),
    ...(def.when !== undefined ? { when: def.when } : {}),
  } as unknown as EventStepDef;
  return out;
}

/** An event workflow with each agent step that opened a task rewritten as a create-task step. */
export function workflowInCurrentForm(wf: EventWorkflow): { workflow: EventWorkflow; rewritten: string[] } {
  const rewritten: string[] = [];
  const taken = new Set(Object.keys(wf.states ?? {}));
  let states: Record<string, EventStepDef> = {};
  for (const [key, def] of Object.entries(wf.states ?? {})) {
    if (def?.agent && (def.agent as AgentStep).workflow !== undefined) {
      const replaced = taskStepFor(key, def, taken);
      for (const k of Object.keys(replaced)) taken.add(k);
      states = { ...states, ...replaced };
      rewritten.push(key);
    } else if (def?.agent && (def.agent as AgentStep).as && (def.agent as AgentStep).prompt === 'ops-incident-recheck' && (def.agent as AgentStep).workflow === undefined) {
      // THE SHIPPED RE-READ AS IT WAS COPIED (an agent step the ops role took, retired by WT118) becomes the shipped request
      // to the ops assistant (`recheckRequestFor`), keeping the step's own messages, edges and gate.
      const replaced = recheckRequestFor(key, def, taken);
      for (const k of Object.keys(replaced)) taken.add(k);
      states = { ...states, ...replaced };
      rewritten.push(key);
    } else if (def?.task && workerAssistantRole(def.task.by) && OWNER_DECIDED_STEP_FIELDS.some((f) => (def.task as unknown as Record<string, unknown>)[f] !== undefined)) {
      // A REQUEST TO ANOTHER ASSISTANT'S ROLE no longer shapes the owner's work (WT118): who sees it, how urgent it is, its
      // form and its deadline are the owner's to declare, so a step written before that keeps its intent, ask and continue.
      const task = Object.fromEntries(Object.entries(def.task).filter(([f]) => !(OWNER_DECIDED_STEP_FIELDS as readonly string[]).includes(f)));
      const { onDeadline: _owners, ...rest } = def as EventStepDef & { onDeadline?: unknown };
      states[key] = { ...rest, task } as EventStepDef;
      rewritten.push(key);
    } else {
      states[key] = def;
    }
  }
  return { workflow: rewritten.length ? { ...wf, states } : wf, rewritten };
}

/** How a multi-step intent is made single-turn: answered in one turn, with a placeholder while it is worked. */
const SINGLE_TURN = 'PLACEHOLDER_UPDATE';
const MULTI_STEP = 'TASK_MULTI_STEP';

/** A body with its `workflows` selection carried into what each intent is, and the intents that became single-turn. */
function selectionInCurrentForm(body: ProfileDefinitionBody, pack?: { intents?: unknown[] }): { body: ProfileDefinitionBody; single: string[] } | null {
  const selected = (body as { workflows?: unknown }).workflows;
  if (!Array.isArray(selected)) return null;
  // AN EMPTY SELECTION ALLOWED EVERY WORKFLOW (`mayOpen`, the router), so it is dropped and no intent changes.
  if (!selected.length) {
    const { workflows: _empty, ...rest } = body as ProfileDefinitionBody & { workflows?: unknown };
    return { body: rest as ProfileDefinitionBody, single: [] };
  }
  const own = body.intentPack as { intents?: unknown[] } | undefined;
  const base = own?.intents ? own : pack?.intents ? { ...(pack as Record<string, unknown>), intents: pack.intents } : undefined;
  if (!base?.intents) return null;
  const single: string[] = [];
  const intents = base.intents.map((raw) => {
    const intent = raw as { key?: string; delivery?: string };
    if (intent?.delivery !== MULTI_STEP || typeof intent.key !== 'string' || selected.includes(intent.key)) return raw;
    single.push(intent.key);
    return { ...intent, delivery: SINGLE_TURN };
  });
  const { workflows: _retired, ...rest } = body as ProfileDefinitionBody & { workflows?: unknown };
  // A workflow declared for an intent that is now single-turn opened the request's task, which a single-turn intent does
  // not: it goes with the selection that kept it from running.
  const kept = Object.fromEntries(Object.entries((rest as { intentWorkflows?: Record<string, unknown> }).intentWorkflows ?? {})
    .filter(([k]) => !single.includes(k)));
  const workflows = Object.keys(kept).length ? { intentWorkflows: kept } : {};
  const { intentWorkflows: _all, ...others } = rest as ProfileDefinitionBody;
  return { body: { ...others, ...workflows, intentPack: { ...(base as Record<string, unknown>), intents } } as ProfileDefinitionBody, single };
}

/**
 * A body in the current form for a new draft or an import: every retired field rewritten, and what was. `pack` is the
 * classification's pack, which a version without one of its own is handed where its selection is carried.
 */
export function inCurrentForm(body: ProfileDefinitionBody, opts: { pack?: { intents?: unknown[] } } = {}): CurrentForm {
  const rewritten: string[] = [];
  const carried = selectionInCurrentForm(body, opts.pack);
  if (carried) {
    body = carried.body;
    rewritten.push('workflows', ...carried.single.map((k) => `intentPack.intents.${k}.delivery`));
  }
  let eventWorkflows = body.eventWorkflows;
  for (const [name, wf] of Object.entries((body.eventWorkflows ?? {}) as Record<string, EventWorkflow>)) {
    const current = workflowInCurrentForm(wf);
    if (!current.rewritten.length) continue;
    eventWorkflows = { ...(eventWorkflows ?? {}), [name]: current.workflow } as ProfileDefinitionBody['eventWorkflows'];
    // EACH REWRITE NAMES THE FIELD IT RETIRED: an agent step's task (`agent.workflow`), its role (`agent.as`), or the
    // fields a request leaves to the owner (`task`).
    rewritten.push(...current.rewritten.map((s) => {
      const def = wf.states?.[s] as EventStepDef | undefined;
      const field = def?.agent && (def.agent as AgentStep).workflow !== undefined ? 'agent.workflow' : def?.agent ? 'agent.as' : 'task';
      return `eventWorkflows.${name}.states.${s}.${field}`;
    }));
  }
  return { body: rewritten.length ? { ...body, eventWorkflows } : body, rewritten };
}
