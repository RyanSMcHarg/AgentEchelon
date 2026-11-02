/**
 * A WORKFLOW STEP THAT ASSIGNS A TASK (ADR-063 decision 1).
 *
 * A `task` step opens one task of a declared machine and waits for it to settle. It names the person the task is for
 * (`for`: its requester and owner), who does the work (`by`: a person, a participant role's one holder, or an assistant
 * role; absent, the run's own assistant), the task's visibility and priority, and its deadline. It never overrides the
 * machine's waits: the machine's `awaits` decides who holds the task at each state (`requester`, `worker`, or nobody,
 * which is the task's assistant), through the one writer of the assignee (ADR-024).
 *
 * What it guarantees:
 *  - A REFERENCE, NEVER AN ID. `for` and `by` name references the run resolves when the step runs; a free principal id is
 *    refused when the workflow is stored.
 *  - ONE HOLDER. A participant role a task names is one every declared type gives one holder (decision B1), because a task
 *    has one owner and one worker.
 *  - A MACHINE A STEP MAY OPEN. One the version selects or the platform ships as a reference, never one of the queue's
 *    own machines, whose states code depends on by name.
 *  - AN END. Every task step declares its deadline (decision F1), within the bounds deadline events use.
 *  - THE SHAPE THE VISUAL BUILDER DRAWS. One node with the edges `onSuccess`, `onFailure` and `onDeadline`.
 *
 * Pure: no AWS call, no clock. The router opens the task (`router-agent-handler.ts`, `openWorkflowTask`), the task
 * service writes it, and the runner waits on it (`runEventWorkflow`).
 */
import { PARTICIPANT_ROLE_NAME, participantRoleOf } from '../../../lib/config/participant-roles.js';
import {
  DEFAULT_TASK_STATE_MACHINES, PLATFORM_TASK_MACHINE_KEYS, awaitedPartyOf, type TaskStateMachine,
} from './task-state-machines.js';
import type { VariableSource } from './variables.js';

/** The people a task may be for, or worked by: the references an audience resolves to one person (ADR-061 decision 3). */
export type TaskPerson = 'subject' | 'joined' | { people: 'event:person' } | { people: 'invitation:inviter' } | { participantRole: string };
/** Who does a task's work: a person reference, or an assistant by the role it holds in the classification. */
export type TaskWorker = TaskPerson | { assistantRole: string };

export const TASK_VISIBILITIES = ['conversation', 'private'] as const;
export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskStepPriority = typeof TASK_PRIORITIES[number];

export interface TaskStep {
  /** The machine the task follows: one the version selects, or a platform reference machine. */
  machine: string;
  /** The person the task is for: its requester and owner. Absent, the task is for nobody. */
  for?: TaskPerson;
  /** Who does the work. Absent, the run's own assistant. */
  by?: TaskWorker;
  /** Who may see the task exists. Absent reads as private, as every task does (ADR-033). */
  visibility?: typeof TASK_VISIBILITIES[number];
  /** How urgent the work is, in the order an idle assistant takes its tasks up (decision 5). Absent is normal. */
  priority?: TaskStepPriority;
  /** When the task ends if nobody has finished it (decision 4). */
  deadline: { afterMinutes: number };
}

/** The fields a task step declares, in the order the console and the visual builder show them. */
export const TASK_STEP_FIELDS = ['machine', 'for', 'by', 'visibility', 'priority', 'deadline'] as const;

/** The variable a task step's own edges read: the terminal state the task ended in (decision 1). */
export const TASK_STATE_SOURCE = 'task:state';

/** The outcome a run records for a task step, and the edge each takes (decision 3). */
export const TASK_STEP_OUTCOMES = { opened: 'opened', deadline: 'task:deadline' } as const;
/** The outcome naming how a task ended: `task:<terminal kind>:<terminal state>`. */
export const taskEndedOutcome = (kind: string, state: string): string => `task:${kind}:${state}`;

/** How a task step's continuation outcome reads: which edge it takes, and the terminal state for `task:state`. */
export function taskOutcomeOf(outcome: string): { edge: 'success' | 'deadline' | 'failure'; state?: string } {
  if (outcome === TASK_STEP_OUTCOMES.deadline) return { edge: 'deadline' };
  const m = /^task:(success|failure|handoff):([a-z0-9_]{1,64})$/.exec(outcome);
  if (!m) return { edge: 'failure' };
  return { edge: m[1] === 'success' ? 'success' : 'failure', state: m[2] };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The participant role a reference names, or undefined. */
export const taskRole = (ref: unknown): string | undefined =>
  isObject(ref) && Object.keys(ref).length === 1 && typeof ref.participantRole === 'string' && PARTICIPANT_ROLE_NAME.test(ref.participantRole) ? ref.participantRole : undefined;
/** The assistant role a worker names, or undefined. */
export const workerAssistantRole = (by: unknown): string | undefined =>
  isObject(by) && Object.keys(by).length === 1 && typeof by.assistantRole === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(by.assistantRole) ? by.assistantRole : undefined;

/**
 * THE MACHINES A STEP MAY OPEN: the version's own selection where it has one, else the platform's reference machines,
 * never the queue's own machines.
 */
export function machinesAStepMayOpen(machines: Readonly<Record<string, TaskStateMachine>> = DEFAULT_TASK_STATE_MACHINES): Record<string, TaskStateMachine> {
  return Object.fromEntries(Object.entries(machines).filter(([k]) => !(PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(k)));
}

/** The terminal states of a machine, in declaration order: the values `task:state` may take. */
export function terminalStatesOf(machine: TaskStateMachine): string[] {
  return Object.entries(machine.states).filter(([, d]) => !d.transitions.length).map(([k]) => k);
}

/** The `task:state` source a task step's edges read: an enum of the machine's terminal states, platform trust. */
export function taskStateSource(machine: TaskStateMachine): VariableSource {
  return {
    source: TASK_STATE_SOURCE, type: 'enum', trust: 'platform', describesPerson: false,
    values: Object.freeze(terminalStatesOf(machine)), availability: 'always', insertAs: 'id',
    origin: 'the task the step opened, read back when it settles (ADR-063 decision 3)',
  };
}

/** Whether any state of a machine awaits a party. */
export function machineAwaits(machine: TaskStateMachine, party: 'requester' | 'worker'): boolean {
  return Object.values(machine.states).some((d) => awaitedPartyOf(d)?.party === party);
}

/** The earliest and latest a task step's deadline may fall after it runs, the bounds deadline events use. */
export const MIN_TASK_DEADLINE_MINUTES = 5;
export const MAX_TASK_DEADLINE_MINUTES = 30 * 24 * 60;

/**
 * WHY A TASK STEP IS REFUSED, or nothing. `personErrors` checks a person reference exactly as an audience is checked at
 * the workflow's event (`audienceErrors`), so `for` and `by` accept what a send's `to` accepts for one person.
 */
export function taskStepErrors(
  step: unknown,
  at: string,
  ctx: {
    types?: readonly string[];
    machines?: Readonly<Record<string, TaskStateMachine>>;
    personErrors: (ref: unknown, at: string) => string[];
  },
): string[] {
  if (!isObject(step)) return [`${at} is { machine, for, by, visibility, priority, deadline }`];
  const errs: string[] = [];
  for (const k of Object.keys(step)) {
    if (!(TASK_STEP_FIELDS as readonly string[]).includes(k)) errs.push(`${at}.${k} is not a field of a task step; it is { ${TASK_STEP_FIELDS.join(', ')} }`);
  }
  const allowed = machinesAStepMayOpen(ctx.machines);
  const machine = typeof step.machine === 'string' ? allowed[step.machine] : undefined;
  if (!machine) {
    errs.push(typeof step.machine === 'string' && (PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(step.machine)
      ? `${at}.machine names ${step.machine}, one of the turn queue's own machines, which no step opens`
      : `${at}.machine names ${typeof step.machine === 'string' ? step.machine : 'nothing'}, which is not a task machine this version may open (${Object.keys(allowed).sort().join(', ')})`);
  }
  // ONE HOLDER (decision B1): a role a task names is one every declared type gives one holder.
  const oneHolder = (ref: unknown, field: string) => {
    const role = taskRole(ref);
    if (!role) return [];
    if (!ctx.types?.length) return [`${at}.${field} names participant role ${role}, so the workflow declares the types it runs in, each giving the role one holder`];
    return ctx.types.filter((t) => participantRoleOf(t, role)?.holders !== 'one')
      .map((t) => `${at}.${field} names participant role ${role}, which type ${t} does not give one holder (holders: one); a task has one owner and one worker`);
  };
  if (step.for !== undefined) {
    if (isObject(step.for) && 'assistantRole' in step.for) errs.push(`${at}.for names the person the task is for; an assistant does the work (by), and is never a task's requester`);
    else errs.push(...ctx.personErrors(step.for, `${at}.for`), ...oneHolder(step.for, 'for'));
  } else if (machine && machineAwaits(machine, 'requester')) {
    errs.push(`${at}.for is required: ${String(step.machine)} has a step that awaits the requester, the person the task is for`);
  }
  if (step.by !== undefined) {
    if (isObject(step.by) && 'assistantRole' in step.by) {
      if (!workerAssistantRole(step.by)) errs.push(`${at}.by is { assistantRole: '<role>' }, naming the role of the assistant that does the work`);
    } else {
      errs.push(...ctx.personErrors(step.by, `${at}.by`), ...oneHolder(step.by, 'by'));
    }
  }
  if (step.visibility !== undefined && !(TASK_VISIBILITIES as readonly unknown[]).includes(step.visibility)) errs.push(`${at}.visibility is ${TASK_VISIBILITIES.join(' or ')}`);
  if (step.priority !== undefined && !(TASK_PRIORITIES as readonly unknown[]).includes(step.priority)) errs.push(`${at}.priority is ${TASK_PRIORITIES.join(', ')}`);
  const after = isObject(step.deadline) ? step.deadline.afterMinutes : undefined;
  if (!isObject(step.deadline) || Object.keys(step.deadline).some((k) => k !== 'afterMinutes')
    || typeof after !== 'number' || !Number.isInteger(after) || after < MIN_TASK_DEADLINE_MINUTES || after > MAX_TASK_DEADLINE_MINUTES) {
    errs.push(`${at}.deadline is { afterMinutes }, a whole number of minutes from ${MIN_TASK_DEADLINE_MINUTES} to ${MAX_TASK_DEADLINE_MINUTES}: every task a workflow assigns has an end`);
  }
  return errs;
}

