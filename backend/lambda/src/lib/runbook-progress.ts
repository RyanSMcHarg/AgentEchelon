/**
 * WHERE A CONVERSATION'S RUN STANDS, STEP BY STEP (DESIGN-CONVERSATION-DASHBOARDS section 8): the runbook section of its
 * dashboard.
 *
 * Read from the run's own record, one source (tenet D7): the step claims the run wrote as it went (`readEventSteps`) and the
 * tasks its task steps opened. Only the steps the workflow names with a `label` are listed, in the order the workflow
 * declares them, so the section reads as the runbook its author wrote rather than as the engine's internals.
 *
 * IDS AND DECLARED WORDS ONLY. A step's label and description are the workflow author's; a holder is a member's display
 * name; nothing a person or a model wrote in the conversation reaches the section.
 */
import type { EventWorkflow } from './event-workflow.js';
import { continuationClaim, RUN_END_CLAIM } from './event-workflow.js';
import type { Task } from './task-tracking.js';
import type { TaskStateMachine } from './task-state-machines.js';
import { settlementOutcome } from './workflow-task.js';
import { TASK_STEP_OUTCOMES } from './task-step.js';
import { personIdFromArn } from './person-arn.js';

/** How far a step has got. `waiting` is a step held by a person; `in-progress` one an assistant or the platform holds. */
export type RunbookStatus = 'not-started' | 'in-progress' | 'waiting' | 'done' | 'skipped' | 'timed-out' | 'failed';

export interface RunbookStep {
  step: string;
  label: string;
  description?: string;
  status: RunbookStatus;
  /** The member holding it, by display name, while a person holds it. */
  holder?: string;
  /** ISO times from the step's task, where it opened one. */
  startedAt?: string;
  settledAt?: string;
  /** The task whose card the step is answered on, which the section links to. */
  taskId?: string;
  /** The step whose card is pinned: where the conversation stands (`runbookStanding`). */
  pinned?: true;
}

export interface RunbookProgress {
  /** When it was read, so an older read never replaces a newer one. */
  asOf: string;
  workflow: string;
  steps: RunbookStep[];
  /**
   * WHO HOLDS THE CONVERSATION'S ROLES NOW (its on-call, secondary and lead), by role key and display name, read from the
   * conversation's own record when the run's runbook moved. Members only: shown to the people already in the conversation.
   */
  people?: RunbookPerson[];
  /** Who may decide the pinned step and what they may choose now (`decisionOf`). */
  decide?: RunbookDecision;
}

export interface RunbookPerson { role: string; name: string }

/** The most people the pinned status names, and the longest name or label it carries. */
export const MAX_PINNED_PEOPLE = 4;
export const MAX_PINNED_TEXT = 60;

/**
 * WHERE THE CONVERSATION STANDS, read from its pinned step: open while that step is open, resolved once it settled
 * done, ended where it settled any other way. Undefined where no step is pinned.
 */
export function runbookStanding(runbook: RunbookProgress | undefined): 'open' | 'resolved' | 'ended' | undefined {
  const step = runbook?.steps.find((s) => s.pinned);
  if (!step) return undefined;
  if (step.status === 'done') return 'resolved';
  if (step.status === 'skipped' || step.status === 'timed-out' || step.status === 'failed') return 'ended';
  return 'open';
}

/**
 * WHO MAY DECIDE THE PINNED STEP, AND WHAT THEY MAY CHOOSE NOW: the people holding the roles the step names (`decidedBy`), by
 * person id from the run's role record, and the choices its task's state offers, or the states its ending may reopen into.
 * The band offers these; the task service holds every press to the roles again, read from the conversation's record then.
 */
export interface RunbookDecision {
  taskId: string;
  state: string;
  choices: string[];
  /** The person ids who may take them. */
  by: string[];
  /** Its task has ended, and its choices are the states it may be reopened into. */
  reopen?: true;
}

export function decisionOf(
  wf: EventWorkflow,
  tasks: Readonly<Record<string, Task>>,
  roles: Readonly<Record<string, readonly string[]>> | undefined,
  machinesOf: (task: Task) => Record<string, TaskStateMachine>,
): RunbookDecision | undefined {
  const step = Object.keys(wf.states).find((k) => wf.states[k]?.task?.pinned && wf.states[k]?.task?.decidedBy?.length);
  const task = step ? tasks[step] : undefined;
  if (!step || !task?.taskType || !task.taskState) return undefined;
  const state = machinesOf(task)[task.taskType]?.states[task.taskState];
  if (!state) return undefined;
  const choices = (state.transitions.length ? state.choices ?? [] : state.reopens ?? []).slice(0, 4);
  const by = [...new Set((wf.states[step].task!.decidedBy ?? []).flatMap((r) => [...(roles?.[r] ?? [])]))]
    .map((arn) => personIdFromArn(arn)).filter((id): id is string => !!id).slice(0, 16);
  if (!choices.length || !by.length) return undefined;
  return { taskId: task.taskId, state: task.taskState, choices, by, ...(state.transitions.length ? {} : { reopen: true as const }) };
}

/** THE STEP THE RUN IS ON NOW: the first labelled step in progress or waiting on a person, with its holder. */
export function runbookNow(runbook: RunbookProgress | undefined): { label: string; status: RunbookStatus; holder?: string } | undefined {
  const step = runbook?.steps.find((s) => s.status === 'waiting' || s.status === 'in-progress');
  if (!step) return undefined;
  return { label: step.label.slice(0, MAX_PINNED_TEXT), status: step.status, ...(step.holder ? { holder: step.holder.slice(0, MAX_PINNED_TEXT) } : {}) };
}

/** The most steps the section lists, past any runbook an author writes (a run takes at most 32 steps). */
export const MAX_RUNBOOK_STEPS = 32;

/** The steps a workflow names with a label, in declaration order. */
export function labeledSteps(wf: EventWorkflow): string[] {
  return Object.entries(wf.states).filter(([, def]) => typeof def.label === 'string' && def.label.trim()).map(([k]) => k).slice(0, MAX_RUNBOOK_STEPS);
}

/** The claims the section reads for these steps: each step, its continuation, and the run's end. */
export function runbookClaimNames(steps: readonly string[]): string[] {
  return [...steps, ...steps.map(continuationClaim), RUN_END_CLAIM];
}

const SKIPPED_OUTCOMES = new Set(['skipped', 'gated', 'withheld']);
const FAILED_OUTCOMES = new Set(['failed', 'not-dispatched', 'no-role-assistant', 'refused', 'no-worker']);

/** A task's status: settled by how it ended, else who holds it. */
function taskStatus(task: Task, machines: Record<string, TaskStateMachine>): RunbookStatus {
  const ended = settlementOutcome(task, machines);
  if (!ended) return task.assigneeType === 'user' ? 'waiting' : 'in-progress';
  if (ended === TASK_STEP_OUTCOMES.deadline) return 'timed-out';
  if (ended.startsWith('task:success:')) return 'done';
  // A RUN THAT ENDED OR MOVED ON CANCELS WHAT IT LEFT OPEN: that step was not needed, which is not a failure.
  return task.status === 'cancelled' ? 'skipped' : 'failed';
}

/**
 * THE RUNBOOK AS THE RECORD HOLDS IT. `claims` is `readEventSteps` over `runbookClaimNames`; `tasks` the rows of the task
 * steps that opened one, by step; `holders` the display names of the people holding them, by step.
 */
export function runbookOf(args: {
  workflow: string;
  wf: EventWorkflow;
  claims: Readonly<Record<string, string>>;
  tasks: Readonly<Record<string, Task>>;
  holders?: Readonly<Record<string, string>>;
  /** Each task's machines, read through the version it started on (`machinesForTask`). */
  machinesOf: (task: Task) => Record<string, TaskStateMachine>;
  now: number;
}): RunbookProgress {
  const ended = args.claims[RUN_END_CLAIM] !== undefined;
  const steps = labeledSteps(args.wf).map((step): RunbookStep => {
    const def = args.wf.states[step];
    const base = { step, label: def.label!.trim(), ...(def.description?.trim() ? { description: def.description.trim() } : {}), ...(def.task?.pinned ? { pinned: true as const } : {}) };
    const claimed = args.claims[step];
    if (claimed === undefined) return { ...base, status: ended ? 'skipped' : 'not-started' };
    const task = args.tasks[step];
    if (def.task && task) {
      const status = taskStatus(task, args.machinesOf(task));
      const settled = status !== 'waiting' && status !== 'in-progress';
      const holder = status === 'waiting' ? args.holders?.[step] : undefined;
      return {
        ...base, status, taskId: task.taskId, startedAt: task.createdAt,
        ...(settled ? { settledAt: task.updatedAt } : {}), ...(holder ? { holder } : {}),
      };
    }
    if (SKIPPED_OUTCOMES.has(claimed)) return { ...base, status: 'skipped' };
    if (FAILED_OUTCOMES.has(claimed)) return { ...base, status: 'failed' };
    // A STEP THAT WAITS (a wait, a task whose row is not read, an opened conversation the run holds for) is done once the
    // run went on past it.
    if (claimed === 'waiting' || claimed === TASK_STEP_OUTCOMES.opened) {
      const after = args.claims[continuationClaim(step)];
      if (after === undefined) return { ...base, status: 'in-progress' };
      if (after === TASK_STEP_OUTCOMES.deadline) return { ...base, status: 'timed-out' };
      return { ...base, status: FAILED_OUTCOMES.has(after) ? 'failed' : 'done' };
    }
    return { ...base, status: 'done' };
  });
  return { asOf: new Date(args.now).toISOString(), workflow: args.workflow, steps };
}

/** Whether a value read back from storage is a runbook this module wrote. */
export function isRunbookProgress(v: unknown): v is RunbookProgress {
  const r = v as RunbookProgress;
  return !!r && typeof r.asOf === 'string' && typeof r.workflow === 'string' && Array.isArray(r.steps)
    && r.steps.every((s) => s && typeof s.step === 'string' && typeof s.label === 'string' && typeof s.status === 'string');
}
