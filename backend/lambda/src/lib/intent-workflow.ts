/**
 * AN INTENT'S WORKFLOW (ADR-067 decision 1, stage 3): what a person's request runs, once the classifier has labeled it
 * with a multi-step intent.
 *
 * A version declares it in `intentWorkflows`, keyed by the intent, in the event workflow format with `on: { intent }`.
 * It runs on the router's runner like an event's workflow, under the intent trigger (`INTENT_TRIGGER`), and its own
 * task step, the one that opens the intent's machine, is the task today's rule opens: the turn that classified the
 * request opens it and works its first step. What it adds is what comes after: an approval, a send, a second task, on
 * the task's ending.
 *
 * THE RULES IT IS HELD TO, beyond an event workflow's:
 *  - Its key is a multi-step intent the version's pack declares, and its `on` names that intent.
 *  - It opens the intent's own machine in exactly one task step, and only sends come before that step, so the request's
 *    turn reaches it with no model call and no wait in front of it (decision 1, "The turn that triggered it").
 *  - That step's deadline is optional (the canonical step's exemption), and no task step continues before it settles
 *    (`continue: opened` is refused, WT113): a request's run waits on its task's ending.
 *  - `requester` names the person who asked; `subject` and an event's people name nobody here.
 * A version that declares none for an intent runs the canonical workflow (`canonicalIntentWorkflow`), which is today's
 * rule as a workflow: one task step on the intent's machine, for the requester.
 */
import { workerAssistantRole } from './task-step.js';
import { eventWorkflowErrors, INTENT_TRIGGER, type EventStepDef, type EventWorkflow, type WorkflowValidation } from './event-workflow.js';

/** An intent's workflow as a version stores it. */
export interface IntentWorkflow extends Omit<EventWorkflow, 'on' | 'deadline'> {
  on: { intent: string };
}

/** The most intent workflows one version declares, and the bytes they may take together. */
export const MAX_INTENT_WORKFLOWS = 16;
export const MAX_INTENT_WORKFLOWS_BYTES = 32_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The run-level shape of an intent's workflow, as the runner and the event workflow validator read it. */
export function asRun(wf: IntentWorkflow): EventWorkflow {
  return { ...wf, on: INTENT_TRIGGER } as unknown as EventWorkflow;
}

/**
 * THE WORKFLOW AN INTENT RUNS WHERE ITS VERSION DECLARES NONE (decision 1, the canonical workflow): today's rule, one
 * task step on the intent's machine for the person who asked, no deadline, ending when it settles.
 */
export function canonicalIntentWorkflow(intent: string): IntentWorkflow {
  return {
    on: { intent },
    initial: 'work',
    states: {
      work: { task: { machine: intent, for: 'requester' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  } as IntentWorkflow;
}

/** The step that opens the intent's own machine, reached from the start through sends only; undefined when none is. */
export function intentTaskStep(wf: Pick<IntentWorkflow, 'initial' | 'states'>, intent: string): string | undefined {
  const seen = new Set<string>();
  let at: string | undefined = wf.initial;
  while (at && !seen.has(at)) {
    seen.add(at);
    const def = wf.states[at] as EventStepDef | undefined;
    if (!def) return undefined;
    if (def.task) return def.task.machine === intent ? at : undefined;
    if (!def.send || typeof def.onSuccess !== 'string' || def.onFailure !== def.onSuccess) return undefined;
    at = def.onSuccess;
  }
  return undefined;
}

/** Why one intent's workflow is refused, or nothing. */
export function intentWorkflowErrors(
  intent: string,
  wf: unknown,
  opts: WorkflowValidation & {
    multiStepIntents: readonly string[];
    /** Every intent the version's pack declares. Absent, the multi-step ones, the only ones that had a workflow before. */
    intents?: readonly string[];
  },
): string[] {
  const at = `intentWorkflows.${intent}`;
  if (!isObject(wf)) return [`${at} must be a workflow`];
  const errs: string[] = [];
  const multiStep = opts.multiStepIntents.includes(intent);
  if (!multiStep && !(opts.intents ?? []).includes(intent)) {
    errs.push(`${at} names ${intent}, which is not an intent this version's pack declares`);
  }
  const on = wf.on;
  if (!isObject(on) || on.intent !== intent || Object.keys(on).length !== 1) errs.push(`${at}.on is { intent: '${intent}' }`);
  if (wf.deadline !== undefined) errs.push(`${at}.deadline is an event's, and an intent's workflow declares none`);
  const asEvent = { ...wf, on: INTENT_TRIGGER };
  errs.push(...eventWorkflowErrors(intent, asEvent, { ...opts, intent }));
  if (errs.length) return errs;
  const states = wf.states as Record<string, EventStepDef>;
  const own = Object.entries(states).filter(([, d]) => d.task?.machine === intent).map(([k]) => k);
  // THE AUTHOR DECIDES WHETHER THE REQUEST OPENS A TASK. A multi-step intent's workflow opens the
  // request's own task, once, reached through sends only so the request's turn opens it; a single-turn intent's workflow
  // runs beside its one-turn answer and opens no task of the request's own (it may still give someone else a task).
  if (multiStep) {
    if (own.length !== 1) errs.push(`${at} opens ${intent}, the intent's own task, in exactly one task step (found ${own.length}); make ${intent} single-turn for a workflow that opens no task of the request's own`);
    const first = intentTaskStep(wf as unknown as IntentWorkflow, intent);
    if (own.length === 1 && !first) {
      errs.push(`${at}.initial reaches the step that opens ${intent} through sends only, each going on to the next whatever its outcome: the request's turn opens its task with nothing waited on before it`);
    }
    // THE REQUEST'S OWN TASK is the requester's and worked by the assistant answering it, as the request's turn opens it; its
    // author decides how quickly it is done (its deadline) and nothing else about who holds it.
    if (own.length === 1) {
      const task = states[own[0]].task as unknown as Record<string, unknown>;
      for (const field of ['by', 'visibility', 'priority', 'fields']) {
        if (task[field] !== undefined) errs.push(`${at}.states.${own[0]}.task.${field}: the request's own task is the requester's, worked by the assistant answering it, so its step declares its deadline and nothing else`);
      }
      if (task.for !== undefined && task.for !== 'requester') errs.push(`${at}.states.${own[0]}.task.for is requester: the request's own task is for the person who asked`);
      // ITS DEADLINE IS A TIME FROM NOW: the request's task is the run's first, so no earlier task recorded a time for it, and a
      // reminder goes only to a person who holds a task, which the request's own task starts without.
      const deadline = task.deadline as { at?: unknown; kind?: unknown } | undefined;
      if (deadline?.at !== undefined) errs.push(`${at}.states.${own[0]}.task.deadline.at: the request's own task is the run's first, so no earlier task recorded a time; declare afterMinutes`);
      if (deadline?.kind === 'remind') errs.push(`${at}.states.${own[0]}.task.deadline.kind is timeout or due: the request's own task is worked by the assistant answering it, and a reminder goes only to a person who holds a task`);
    }
  } else {
    // A SINGLE-TURN INTENT'S RUN HAS NO TASK OF ITS OWN to continue from, so its workflow says its sends in the request's turn
    // and ends there: a step that would wait for a continuation (a wait, a task, an agent turn) is refused until one exists.
    for (const [key, def] of Object.entries(states)) {
      if (def.wait || (def.task && def.task.machine !== intent) || def.agent) errs.push(`${at}.states.${key}: a single-turn intent's workflow runs in its request's turn, so it takes sends and an end; a wait, a task or an agent turn needs the request to be multi-step`);
    }
  }
  if (!multiStep && own.length) {
    errs.push(`${at} opens ${intent}, the intent's own task, which a single-turn intent does not: make ${intent} multi-step to open it`);
  }
  for (const [key, def] of Object.entries(states)) {
    if (def.task?.continue !== undefined) errs.push(`${at}.states.${key}.task.continue: a request's run waits on its task's ending, so no task step continues before it`);
    if (def.opening !== undefined || def.prompt !== undefined) errs.push(`${at}.states.${key} is a welcome's step, which an intent's workflow does not take`);
  }
  return errs;
}

/** Why a version's `intentWorkflows` is refused, or nothing. */
export function versionIntentWorkflowsErrors(
  raw: unknown,
  opts: WorkflowValidation & {
    multiStepIntents: readonly string[];
    intents?: readonly string[];
    /** Whether every multi-step intent must declare its workflow: where a body store holds them (withDeclaredWorkflows). */
    requireDeclared?: boolean;
  },
): string[] {
  const declared = isObject(raw) ? raw : {};
  // A MULTI-STEP INTENT HAS A WORKFLOW: declared on the version, never one the platform fills in.
  const missing = (opts.requireDeclared ? opts.multiStepIntents : []).filter((i) => !Object.prototype.hasOwnProperty.call(declared, i))
    .map((i) => `intentWorkflows has no workflow for ${i}, a multi-step intent: declare one, or make ${i} single-turn`);
  if (raw === undefined || raw === null) return missing;
  if (!isObject(raw)) return ['intentWorkflows maps an intent to its workflow'];
  const keys = Object.keys(raw);
  const errs: string[] = [...missing];
  if (keys.length > MAX_INTENT_WORKFLOWS) errs.push(`intentWorkflows holds at most ${MAX_INTENT_WORKFLOWS} workflows`);
  if (JSON.stringify(raw).length > MAX_INTENT_WORKFLOWS_BYTES) errs.push(`intentWorkflows is at most ${MAX_INTENT_WORKFLOWS_BYTES} characters`);
  for (const k of keys) errs.push(...intentWorkflowErrors(k, raw[k], opts));
  return errs;
}

/** The workflow a version runs for an intent: its own, else the canonical one. */
export function intentWorkflowFor(declared: Readonly<Record<string, IntentWorkflow>> | undefined, intent: string): { workflow: IntentWorkflow; declared: boolean } {
  const own = declared?.[intent];
  return own ? { workflow: own, declared: true } : { workflow: canonicalIntentWorkflow(intent), declared: false };
}

/** A version's intent workflows as the runner reads them, by intent, each on the intent trigger. */
export function intentRunWorkflows(declared: Readonly<Record<string, IntentWorkflow>> | null | undefined): Record<string, EventWorkflow> {
  return Object.fromEntries(Object.entries(declared ?? {}).map(([k, wf]) => [k, asRun(wf)]));
}

/** The claim key of an intent's run (decision 1): `intent#<correlationId>#<assistant>`. */
export const intentRunKey = (correlationId: string, assistant: string): string => `${INTENT_TRIGGER}#${correlationId}#${assistant}`;

/**
 * THE RUN-LEVEL STEPS A GOLDEN WALK DOES NOT SIMULATE (ADR-067 decision 1, "The golden set"): every step of an intent's
 * workflow other than its own task step and its ends, in declaration order. A walk runs the intent's machine; a send, an
 * approval by another person or a second task around it is reported not exercised, by name, until the walk simulates it.
 */
export function runStepsNotWalked(wf: Pick<IntentWorkflow, 'initial' | 'states'>, intent: string): string[] {
  const own = intentTaskStep(wf, intent);
  return Object.entries(wf.states ?? {}).filter(([k, d]) => k !== own && !(d as EventStepDef).disposition).map(([k]) => k);
}

/**
 * EVERY MULTI-STEP INTENT'S WORKFLOW, DECLARED: the version's own, and for each multi-step intent that
 * declares none, its standard workflow written out (`canonicalIntentWorkflow`), which is exactly what the request ran when
 * none was declared. A new draft and an import start from this, so nothing a person meets changes and every workflow is
 * the version's to see and edit. Undefined where there is nothing to declare.
 */
export function withIntentWorkflowsDeclared(
  declared: Readonly<Record<string, IntentWorkflow>> | undefined,
  multiStepIntents: readonly string[],
): Record<string, IntentWorkflow> | undefined {
  const out: Record<string, IntentWorkflow> = { ...(declared ?? {}) };
  for (const intent of multiStepIntents) if (!out[intent]) out[intent] = canonicalIntentWorkflow(intent);
  return Object.keys(out).length ? out : undefined;
}

/** One task a workflow gives to an assistant role: its workflow, step, role and the intent it names (WT78). */
export interface RoleTask { workflow: string; step: string; role: string; machine: string }

/** The tasks a set of workflows gives to an assistant role, in declaration order, by name only. */
export function roleTasksOf(workflows: Readonly<Record<string, { states?: Record<string, { task?: { machine?: unknown; by?: unknown } }> }>> | undefined): RoleTask[] {
  const out: RoleTask[] = [];
  for (const [workflow, wf] of Object.entries(workflows ?? {})) {
    for (const [step, st] of Object.entries(wf?.states ?? {})) {
      const role = workerAssistantRole(st?.task?.by);
      if (role && typeof st?.task?.machine === 'string') out.push({ workflow, step, role, machine: st.task.machine });
    }
  }
  return out;
}
