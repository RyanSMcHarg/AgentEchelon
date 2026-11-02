/**
 * PREVIEW RUN: A WORKFLOW WALKED WITH SAMPLE VALUES, SAYING NOTHING AND WRITING NOTHING (ADR-061 decision 7).
 *
 * The console's Preview run asks what a workflow would do at its event. This walks it through the runtime's own runner
 * (`runEventWorkflow`, `continueAfter`), so every step, gate and edge is decided exactly as a real run decides it, with
 * dependencies that record instead of act: a send records the template, the audience and the values it would be said
 * with; an agent step, a prompt turn, an intake and a task record that they would start; and every claim is held in
 * memory for the length of the walk. Nothing here holds or builds an AWS client, so a preview cannot post to a room,
 * write a record or invoke a function (`a-preview-run-says-nothing-and-writes-nothing.test.ts`).
 *
 * WHAT A PREVIEW IS GIVEN. The people an event names are sample people, one per role the workflow's types declare, so a
 * send to a role or to the person who joined reaches someone. A condition reads the sample values the caller gives, by
 * source, through the classification's own source table and the version's variables; a value not given is unresolved,
 * as it is at run time, so its condition does not hold. How each agent or task step ends is the caller's choice
 * (`outcomes`), success by default, and a task's ending reads `task:state` as its first terminal state of that kind.
 */
import {
  continueAfter, participantRoleReferences, runEventWorkflow,
  type EventGate, type EventRunContext, type EventRunDeps, type EventWorkflow, type StepOutcome,
} from './event-workflow.js';
import { buildSourceTable, versionLookup, type VariableValue, type VersionVariable } from './variables.js';
import { TASK_STEP_OUTCOMES, machinesAStepMayOpen, taskEndedOutcome } from './task-step.js';
import type { TaskStateMachine } from './task-state-machines.js';

/** How an agent step or a task step ends in a preview. */
export type PreviewEnding = 'success' | 'failure' | 'deadline';
export const PREVIEW_ENDINGS: readonly PreviewEnding[] = ['success', 'failure', 'deadline'];

export interface PreviewOptions {
  /** The version's variables, so a condition naming one reads its source. */
  variables?: Readonly<Record<string, VersionVariable>>;
  /** The deployment's classifications, the closed set `person:clearance` and `conversation:classification` read. */
  classifications?: readonly string[];
  /** Sample values by source (`conversation:type`, `person:onboarded`, ...). A source not given is unresolved. */
  values?: Readonly<Record<string, VariableValue>>;
  /** How each agent or task step ends, by step name. Absent, success. */
  outcomes?: Readonly<Record<string, PreviewEnding>>;
  /** The machines a task step may open (the classification's pack over the platform's). */
  machines?: Readonly<Record<string, TaskStateMachine>>;
}

/** What one step would do. `to` is `room`, or the sample people a targeted send reaches. */
export interface PreviewAct {
  step: string;
  act: 'send' | 'opening' | 'prompt' | 'agent' | 'intake' | 'task';
  template?: string;
  to?: 'room' | string[];
  values?: Record<string, string>;
  /** An agent step's fallback, said with no model call. */
  fallback?: boolean;
}

export interface PreviewResult {
  steps: Array<{ step: string; outcome: StepOutcome }>;
  acts: PreviewAct[];
  ended?: 'success' | 'failure';
}

/** The sample people a preview names, as AppInstanceUser ARNs a reader can recognize. */
export const PREVIEW_CHANNEL = 'arn:aws:chime:us-east-1:000000000000:app-instance/preview/channel/preview';
export const samplePerson = (who: string): string => `arn:aws:chime:us-east-1:000000000000:app-instance/preview/user/sample-${who}`;
/** The sample person's label, as the console shows it: the part after `sample-`. */
export const sampleLabel = (arn: string): string => arn.slice(arn.lastIndexOf('/sample-') + '/sample-'.length);

/** Values a preview may be given: a scalar or a list of strings, by source name. Refused otherwise. */
export function previewValuesErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['values maps a source name to a sample value'];
  return Object.entries(raw as Record<string, unknown>).flatMap(([k, v]) => (
    ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
      ? [] : [`values.${k} is a string, a number, a boolean or a list of strings`]));
}

/** The context a preview runs in: the event's sample people, a holder for each role, and the sample values. */
function previewContext(wf: EventWorkflow, opts: PreviewOptions): EventRunContext {
  const roles = Object.fromEntries([...participantRoleReferences(wf, opts.variables).roles].map((r) => [r, [samplePerson(`${r}-holder`)]]));
  const invitation = wf.on === 'invitation-sent' || wf.on === 'invitation-unredeemed';
  const gate: EventGate = {
    lookup: versionLookup(buildSourceTable({ catalog: [], ...(opts.classifications ? { classifications: opts.classifications } : {}), participantRoleTypes: wf.types }), opts.variables),
    ...(opts.variables ? { variables: opts.variables } : {}),
    values: { ...(opts.values ?? {}) },
    callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true },
  };
  return {
    event: wf.on,
    channelArn: PREVIEW_CHANNEL,
    subject: samplePerson('subject'),
    ...(wf.on === 'assistant-joined' || wf.on === 'alarm-state-changed' ? {} : { eventPerson: samplePerson(invitation ? 'invitee' : 'person') }),
    ...(invitation ? { invitationId: 'preview', inviter: samplePerson('inviter') } : {}),
    ...(wf.on === 'alarm-state-changed' ? { alarm: { name: 'sample-alarm', state: 'ALARM' as const, changedAt: 0 } } : {}),
    roles,
    ...(wf.types?.[0] ? { conversationType: wf.types[0] } : {}),
    values: {},
    gate,
  };
}

/** The outcome a step's continuation is handed for the ending the caller chose. */
function endingOutcome(wf: EventWorkflow, step: string, ending: PreviewEnding, machines: Readonly<Record<string, TaskStateMachine>>): string {
  const def = wf.states[step];
  if (def?.task) {
    if (ending === 'deadline') return TASK_STEP_OUTCOMES.deadline;
    const machine = machinesAStepMayOpen(machines)[def.task.machine];
    const terminal = Object.entries(machine?.states ?? {}).find(([, d]) => !d.transitions.length && (d.terminal === 'success') === (ending === 'success'));
    return terminal ? taskEndedOutcome(terminal[1].terminal ?? ending, terminal[0]) : (ending === 'success' ? taskEndedOutcome('success', 'done') : 'task:failure:failed');
  }
  return ending === 'success' ? 'posted' : 'failed';
}

/** Walk a workflow from its initial step to its end, recording what each step would do. Never throws. */
export async function previewWorkflowRun(name: string, wf: EventWorkflow, opts: PreviewOptions = {}): Promise<PreviewResult> {
  const ctx = previewContext(wf, opts);
  const machines = opts.machines ?? machinesAStepMayOpen();
  const claims = new Set<string>();
  const acts: PreviewAct[] = [];
  const paused: string[] = [];
  const deps: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step, outcome) => {
      const key = step.startsWith('after#') ? step : `${step}#${outcome.startsWith('fallback:') ? 'fallback' : 'step'}`;
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    mentionName: async (arn) => sampleLabel(arn),
    listLanguage: async () => undefined,
    send: async ({ template, values, to, step, fallback }) => {
      acts.push({ step, act: 'send', template, to: to.length ? to.map(sampleLabel) : 'room', values, ...(fallback ? { fallback } : {}) });
      return true;
    },
    dispatchAgent: async (step, def) => {
      acts.push({ step, act: 'agent', template: def.prompt, to: def.to === 'room' ? 'room' : [] });
      paused.push(step);
      return true;
    },
    startIntake: async (person, step) => { acts.push({ step, act: 'intake', to: [sampleLabel(person)] }); return 'started'; },
    opening: async (step) => { acts.push({ step, act: 'opening', to: 'room' }); return true; },
    prompt: async (step, def) => { acts.push({ step, act: 'prompt', template: def.template, to: 'room' }); return true; },
    openTask: async (step, def) => { acts.push({ step, act: 'task', template: def.machine }); paused.push(step); return 'opened'; },
  };
  const steps: PreviewResult['steps'] = [];
  let out = await runEventWorkflow(name, wf, ctx, deps).catch(() => ({ ran: false, steps: [] as PreviewResult['steps'], ended: undefined }));
  steps.push(...out.steps);
  // A PAUSED RUN GOES ON AS ITS STEP'S CHOSEN ENDING WOULD TAKE IT, bounded by the workflow's own step cap.
  for (let n = 0; !out.ended && paused.length && n < Object.keys(wf.states).length; n++) {
    const step = paused.shift()!;
    const outcome = endingOutcome(wf, step, opts.outcomes?.[step] ?? 'success', machines);
    out = await continueAfter(name, wf, ctx, { step, outcome }, deps, machines).catch(() => ({ ran: false, steps: [] as PreviewResult['steps'], ended: undefined }));
    steps.push(...out.steps);
  }
  return { steps, acts, ...(out.ended ? { ended: out.ended } : {}) };
}
