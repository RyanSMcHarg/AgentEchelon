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
export type TaskPerson = 'subject' | 'joined' | 'requester' | { people: 'event:person' } | { people: 'invitation:inviter' } | { participantRole: string };
/** Who does a task's work: a person reference, or an assistant by the role it holds in the classification. */
export type TaskWorker = TaskPerson | { assistantRole: string };

export const TASK_VISIBILITIES = ['conversation', 'private'] as const;
export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskStepPriority = typeof TASK_PRIORITIES[number];

export interface TaskStep {
  /** The machine the task follows: one the version selects, or a platform reference machine. */
  machine: string;
  /**
   * WHAT THE ASKED ASSISTANT'S ANSWER IS DELIVERED AS, on a step that asks one (`ask`): `file` attaches it as a
   * Markdown file whatever the intent declares, so the workflow decides that a draft is a document.
   */
  deliver?: 'file';
  /**
   * THE CARD IS KEPT AT THE TOP OF THE CONVERSATION: its choices are offered in the conversation's pinned band,
   * beside where it stands, and its message keeps its words without them, so a decision as weighty as resolving an incident
   * is taken from the top, with the state in view, never from an early message by reflex.
   */
  pinned?: true;
  /**
   * WHO DECIDES IT, BESIDES ITS ASSIGNEE: the participant roles whose holders may take its choices, and reopen it where its
   * machine declares a reopen. Checked against the conversation's own record of who holds each role when the choice is
   * pressed, never against the request. A step that names deciders is moved only by a press: no assistant's turn moves it.
   */
  decidedBy?: string[];
  /**
   * THE STEP TAKES THE TASK WHOSE REOPEN STARTED ITS RUN (`reopened`), rather than opening another: on a `task-reopened`
   * workflow, the reopened task is this step's, so its next ending continues this run.
   */
  takes?: 'reopened';
  /** The person the task is for: its requester and owner. Absent, the task is for nobody. */
  for?: TaskPerson;
  /** Who does the work. Absent, the run's own assistant. */
  by?: TaskWorker;
  /** Who may see the task exists. Absent reads as private, as every task does (ADR-033). */
  visibility?: typeof TASK_VISIBILITIES[number];
  /** How urgent the work is, in the order an idle assistant takes its tasks up (decision 5). Absent is normal. */
  priority?: TaskStepPriority;
  /**
   * When the task ends if nobody has finished it (decision 4). Required, except on a step that continues once its task
   * opens (`continue: 'opened'`), whose run no longer waits on the task: the task row's expiry bounds it (ADR-067 OPEN 3).
   */
  deadline?: TaskStepDeadline;
  /**
   * WHEN THE RUN GOES ON (ADR-067 decision 2, WT18): absent, once the task settles; `opened`, once the task leaves the
   * state it opened in, on `onSuccess`, and never again when it returns there, so a task that rests does not hold the run;
   * `alongside`, as soon as the task is opened, on `onSuccess`, with the run's end waiting on it: the run's later steps go on
   * while the task is open, and the run ends only once it has settled (an incident's lead holds it while the runbook runs).
   */
  continue?: typeof TASK_STEP_CONTINUES[number];
  /**
   * WHAT THE ROOM IS TOLD WHEN THE TASK OPENS, in place of the platform's assignment notice: a message template of this
   * assistant's (a drift offer says what the offer is, WT89), said to the room, or to the person alone where their message
   * was private. `redirect` is said instead where detection found a conversation already about the subject.
   */
  notice?: { template: string; redirect?: string };
  /**
   * THE FORM'S FIELDS (WT50), on a step that opens the `form` machine only: each a name and a type, at most eight. The
   * card shows each field by its name, in the reader's language where the deployment words it; the answers are kept on
   * the task as written, member text, which is read and never decides.
   */
  fields?: FormField[];
  /**
   * WHAT THE ASKING ASSISTANT NEEDS, on a request to another assistant's role only (WT118): one of the asking assistant's own
   * message templates, rendered with the run's values in the conversation's language, and handed to the owning assistant
   * as the request. The owner declares what it delivers and how; the ask says, precisely, what is needed.
   */
  ask?: { template: string };
  /**
   * WHAT THE PERSON WHO HOLDS IT IS TOLD, in place of the platform's `workflow-task-assigned`: one of this assistant's
   * message templates, said to them privately with the task's card and emailed as a `task` notice, so the notice can say
   * what the task is, the steps to take and when it is done. `withoutMeetings` is said instead where the deployment declares
   * no `meetings` capability, so a task whose steps include a call says nothing of one where there is none to start.
   */
  assigned?: { template: string; withoutMeetings?: string };
  /**
   * ITS SETTLEMENT ENDS THE RUN, on a step that goes on alongside its task only: where the run
   * has not reached its end when the task settles, the run ends now, on its success terminal, its other open tasks are
   * cancelled with the run's end as their reason, and the conversation that opened this one is told how it ended. Absent,
   * the settlement is recorded and the run ends once it reaches its end.
   */
  endsRun?: true;
  /**
   * ITS SUCCESS MOVES THE RUN ON INSTEAD OF ENDING IT (DESIGN-PROCESSES O15), on a step that `endsRun` only: the run's open tasks
   * are cancelled as `endsRun` cancels them, except those it went on alongside (an investigation stays open), and the run goes
   * on at this step. A settlement that is not a success ends the run as `endsRun` does.
   */
  movesTo?: string;
  /**
   * SETTLING IT WHILE THE RUN IS MID-WAY IS CONFIRMED FIRST, on a step that `endsRun` only: a state of the task's machine
   * that awaits the worker and offers choices. A card press that would settle the task while the run has not reached its
   * end moves it here instead, by an edge the machine declares from every state with a settling choice, and the worker is
   * asked in this state's notice, which names the run's steps still open. Where the run already reached its end, the press
   * settles the task as chosen.
   */
  confirmEnd?: string;
}

/** One field of a form: its name (lowercase, digits, underscores) and what it takes. */
export interface FormField {
  name: string;
  type: 'text' | 'number' | 'yes-no';
  /** Absent, the field may be left empty. */
  required?: boolean;
}
export const FORM_MACHINE = 'form';
export const MAX_FORM_FIELDS = 8;
export const MAX_FORM_TEXT = 2000;

/** Why a form's fields are refused, or nothing. */
export function formFieldErrors(fields: unknown, at: string): string[] {
  if (!Array.isArray(fields) || !fields.length || fields.length > MAX_FORM_FIELDS) return [`${at} is a list of 1 to ${MAX_FORM_FIELDS} fields`];
  const errs: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const o = f as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(o.name)
      || !['text', 'number', 'yes-no'].includes(String(o.type)) || (o.required !== undefined && typeof o.required !== 'boolean')
      || Object.keys(o).some((k) => k !== 'name' && k !== 'type' && k !== 'required')) {
      errs.push(`${at}[${i}] is { name, type: text, number or yes-no, required? }`);
      return;
    }
    if (seen.has(o.name)) errs.push(`${at}[${i}] repeats the field ${o.name}`);
    seen.add(o.name as string);
  });
  return errs;
}

/** The answers a person submitted, held to the fields: each known, of its type, text bounded; null when any is refused. */
export function formAnswersOf(fields: readonly FormField[], raw: unknown): Record<string, string | number | boolean> | null {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = fields.find((x) => x.name === k);
    if (!f) return null;
    if (f.type === 'text' && (typeof v !== 'string' || v.length > MAX_FORM_TEXT)) return null;
    if (f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return null;
    if (f.type === 'yes-no' && typeof v !== 'boolean') return null;
    if (f.type === 'text' && !(v as string).trim()) continue;
    out[k] = f.type === 'text' ? (v as string).trim() : v as number | boolean;
  }
  for (const f of fields) if (f.required && out[f.name] === undefined) return null;
  return out;
}

/**
 * A TASK STEP'S DEADLINE (ADR-067 G5, WT21): when it falls, and what it does then. `timeout` (the default) ends the task
 * and the run takes `onDeadline`; `due` shows the time on the task (`dueBy`, which the due-date reminders read) and ends
 * nothing; `remind` reminds the person who holds the task, every `afterMinutes`, at most `times` times, and ends nothing.
 */
export interface TaskStepDeadline {
  /** How long after the step runs the deadline falls. Absent where `at` names the time. */
  afterMinutes?: number;
  /**
   * A TIME AN EARLIER TASK OF THE RUN RECORDED (`task:value:<need>`, recorded as `time`, WT21): the deadline falls then.
   * Not on a `remind` deadline, whose `afterMinutes` is the interval.
   */
  at?: string;
  kind?: typeof TASK_DEADLINE_KINDS[number];
  /** `remind` only: how many reminders, at most `MAX_TASK_REMINDERS`. Absent, three. */
  times?: number;
}
export const TASK_DEADLINE_KINDS = ['timeout', 'due', 'remind'] as const;
export const MAX_TASK_REMINDERS = 5;
export const DEFAULT_TASK_REMINDERS = 3;

/** The fields a task step declares, in the order the console and the visual builder show them. */
/** The most participant roles one step names as its deciders. */
export const MAX_DECIDING_ROLES = 4;

export const TASK_STEP_FIELDS = ['machine', 'for', 'by', 'visibility', 'priority', 'deadline', 'continue', 'fields', 'ask', 'notice', 'assigned', 'endsRun', 'movesTo', 'confirmEnd', 'deliver', 'pinned', 'decidedBy', 'takes'] as const;

/**
 * THE FIELDS A REQUEST TO ANOTHER ASSISTANT'S ROLE LEAVES TO THAT ASSISTANT (WT118, DESIGN-WORKFLOWS-AND-TASKS section 1): who
 * sees the work, how urgent it is, what form it takes and how quickly it is done are declared by the owning assistant's
 * version and the team that owns it. The asker names the intent, says what it needs (`ask`), and says whether its run goes
 * on once the work starts (`continue`).
 */
export const OWNER_DECIDED_STEP_FIELDS = ['visibility', 'priority', 'fields', 'deadline'] as const;

/** The value of `continue` whose run goes on as soon as the task opens and ends only once it settles. */
export const TASK_STEP_ALONGSIDE = 'alongside';
/** The values `continue` takes. */
export const TASK_STEP_CONTINUES = ['opened', TASK_STEP_ALONGSIDE] as const;

/**
 * WHY A TASK STEP TOOK ITS FAILURE EDGE (ADR-067 G23, WT25), the `task:outcome` source its edges may read: nobody named to
 * do the work was here (`no-worker`), the task could not be written (`failed`), its deadline ended it (`timed-out`), or
 * it ended in a state other than a success (`ended`). Set by the platform, so a condition on it decides (platform trust).
 */
export const TASK_OUTCOME_SOURCE = 'task:outcome';
export const TASK_STEP_FAILURES = ['no-worker', 'failed', 'timed-out', 'ended'] as const;
export type TaskStepFailure = typeof TASK_STEP_FAILURES[number];

/** The `task:outcome` source: an enum of why a task step failed. */
export function taskOutcomeSource(): VariableSource {
  return {
    source: TASK_OUTCOME_SOURCE, type: 'enum', trust: 'platform', describesPerson: false,
    values: Object.freeze([...TASK_STEP_FAILURES]), availability: 'always', insertAs: 'id',
    origin: 'why the task step took its failure edge (ADR-067 G23)',
  };
}

/** Why a task step's recorded outcome failed, for `task:outcome`; undefined on a success or an `opened` continuation. */
export function taskFailureOf(outcome: string): TaskStepFailure | undefined {
  if (outcome === 'no-worker') return 'no-worker';
  if (outcome === 'failed' || outcome === 'not-dispatched') return 'failed';
  if (outcome === TASK_STEP_OUTCOMES.deadline) return 'timed-out';
  const ended = taskOutcomeOf(outcome);
  return ended.state && ended.edge === 'failure' ? 'ended' : undefined;
}

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
    /** An intent's own task step: its deadline is optional, as an intent's task has none today (ADR-067 decision 1). */
    deadlineOptional?: boolean;
    /** The recorded times an earlier task of the run may hand it (`task:value:<need>`), which a deadline may fall at. */
    recordedTimes?: readonly string[];
  },
): string[] {
  if (!isObject(step)) return [`${at} is { machine, for, by, visibility, priority, deadline, continue }`];
  const errs: string[] = [];
  for (const k of Object.keys(step)) {
    if (!(TASK_STEP_FIELDS as readonly string[]).includes(k)) errs.push(`${at}.${k} is not a field of a task step; it is { ${TASK_STEP_FIELDS.join(', ')} }`);
    if (k === 'deliver' && (step.deliver !== 'file' || !step.ask)) errs.push(`${at}.deliver is file, on a step that asks an assistant (ask)`);
    if (k === 'pinned' && step.pinned !== true) errs.push(`${at}.pinned is true, or left out`);
    if (k === 'decidedBy') {
      const roles = step.decidedBy;
      const ok = Array.isArray(roles) && roles.length >= 1 && roles.length <= MAX_DECIDING_ROLES
        && roles.every((r) => typeof r === 'string' && PARTICIPANT_ROLE_NAME.test(r)) && new Set(roles).size === roles.length;
      if (!ok) errs.push(`${at}.decidedBy is a list of 1 to ${MAX_DECIDING_ROLES} participant role names, each once`);
      if (!isObject(step.by) || typeof (step.by as { participantRole?: unknown }).participantRole !== 'string') errs.push(`${at}.decidedBy is on a step a participant role works (by: { participantRole })`);
    }
    if (k === 'takes' && step.takes !== 'reopened') errs.push(`${at}.takes is reopened, or left out`);
  }
  const allowed = machinesAStepMayOpen(ctx.machines);
  const machine = typeof step.machine === 'string' ? allowed[step.machine] : undefined;
  // A REQUEST NAMES AN INTENT ITS OWNER ADVERTISES (WT118), single-turn or multi-step, which this version's machines say
  // nothing about: the asker never reads the owner's definition. Whether it is advertised is a warning at Validate, because a
  // role may be added to a running deployment, and the step's failure edge at run time.
  const asksRole = isObject(step.by) && 'assistantRole' in step.by;
  if (asksRole) {
    if (typeof step.machine !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(step.machine)) errs.push(`${at}.machine names the intent asked of the role, one its assistant advertises`);
  } else if (!machine) {
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
  const toRole = isObject(step.by) && 'assistantRole' in step.by;
  if (step.by !== undefined) {
    if (toRole) {
      if (!workerAssistantRole(step.by)) errs.push(`${at}.by is { assistantRole: '<role>' }, naming the role of the assistant that does the work`);
      // A REQUEST, NEVER A RUN AS THE OTHER ASSISTANT (WT118): what the owner delivers, and how, is the owner's to declare.
      for (const f of OWNER_DECIDED_STEP_FIELDS) {
        if (step[f] !== undefined) errs.push(`${at}.${f} is the owning assistant's to declare: a request to another assistant's role names its intent, says what it needs (ask), and may go on once the work starts (continue)`);
      }
    } else {
      errs.push(...ctx.personErrors(step.by, `${at}.by`), ...oneHolder(step.by, 'by'));
    }
  }
  if (step.ask !== undefined) {
    if (!toRole) errs.push(`${at}.ask belongs to a request to another assistant's role (by: { assistantRole }); a task of the run's own is described by its machine`);
    else if (!isObject(step.ask) || Object.keys(step.ask).length !== 1 || typeof step.ask.template !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(step.ask.template)) {
      errs.push(`${at}.ask is { template }, naming one of this assistant's message templates that says what it needs`);
    }
  }
  if (step.continue !== undefined && !(TASK_STEP_CONTINUES as readonly unknown[]).includes(step.continue)) {
    errs.push(`${at}.continue is ${TASK_STEP_CONTINUES.join(' or ')}, or absent to go on once the task settles`);
  }
  // A TASK THE RUN GOES ON ALONGSIDE is a person's or the run's own assistant's: a request to another role is that assistant's run,
  // whose end is its own, and the asking run goes on from its ending.
  if (step.continue === TASK_STEP_ALONGSIDE && toRole) errs.push(`${at}.continue is alongside on a task of the run's own; a request to another assistant's role goes on once the work starts (opened) or once it ends`);
  if (step.assigned !== undefined) {
    const name = (v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v);
    if (toRole) errs.push(`${at}.assigned tells the person who holds the task; a request to another assistant's role says what it needs in ask`);
    else if (!isObject(step.assigned) || Object.keys(step.assigned).some((k) => k !== 'template' && k !== 'withoutMeetings') || !name(step.assigned.template)
      || (step.assigned.withoutMeetings !== undefined && !name(step.assigned.withoutMeetings))) {
      errs.push(`${at}.assigned is { template, withoutMeetings? }, naming this assistant's message templates that tell the person what the task is, the second where the deployment declares no meetings`);
    }
  }
  errs.push(...endsRunErrors(step, at, machine));
  if (toRole) return errs;
  if (step.visibility !== undefined && !(TASK_VISIBILITIES as readonly unknown[]).includes(step.visibility)) errs.push(`${at}.visibility is ${TASK_VISIBILITIES.join(' or ')}`);
  if (step.priority !== undefined && !(TASK_PRIORITIES as readonly unknown[]).includes(step.priority)) errs.push(`${at}.priority is ${TASK_PRIORITIES.join(', ')}`);
  // A FORM DECLARES ITS FIELDS, and no other task step does (WT50).
  if (step.machine === FORM_MACHINE) errs.push(...formFieldErrors(step.fields, `${at}.fields`));
  else if (step.fields !== undefined) errs.push(`${at}.fields belongs to a step that opens the form machine`);
  // A RUN THAT WAITS ON ITS TASK GIVES IT AN END; one that goes on once the task opens leaves it to the row's expiry.
  const continuesOnOpen = step.continue === 'opened' || ctx.deadlineOptional === true;
  const after = isObject(step.deadline) ? step.deadline.afterMinutes : undefined;
  if (isObject(step.deadline)) {
    const { kind, times } = step.deadline;
    if (kind !== undefined && !(TASK_DEADLINE_KINDS as readonly unknown[]).includes(kind)) errs.push(`${at}.deadline.kind is ${TASK_DEADLINE_KINDS.join(', ')}`);
    if (times !== undefined && (kind !== 'remind' || typeof times !== 'number' || !Number.isInteger(times) || times < 1 || times > MAX_TASK_REMINDERS)) {
      errs.push(`${at}.deadline.times is on a remind deadline only, a whole number from 1 to ${MAX_TASK_REMINDERS}`);
    }
  }
  // A DEADLINE AT A RECORDED TIME (WT21): a time an earlier task of the run recorded, never on a reminder, whose interval
  // is its `afterMinutes`.
  if (isObject(step.deadline) && step.deadline.at !== undefined) {
    const at2 = step.deadline.at;
    if (Object.keys(step.deadline).some((k) => k !== 'at' && k !== 'kind')) errs.push(`${at}.deadline is { at, kind } where it falls at a recorded time`);
    if (step.deadline.kind === 'remind') errs.push(`${at}.deadline.at is not on a remind deadline, whose afterMinutes is the interval`);
    if (typeof at2 !== 'string' || !(ctx.recordedTimes ?? []).includes(at2)) {
      errs.push(`${at}.deadline.at names a time an earlier task of this run records (task:value:<need>, recorded as time)${(ctx.recordedTimes ?? []).length ? `: ${ctx.recordedTimes!.join(', ')}` : '; none does'}`);
    }
    return errs;
  }
  if ((step.deadline !== undefined || !continuesOnOpen) && (!isObject(step.deadline) || Object.keys(step.deadline).some((k) => k !== 'afterMinutes' && k !== 'kind' && k !== 'times')
    || typeof after !== 'number' || !Number.isInteger(after) || after < MIN_TASK_DEADLINE_MINUTES || after > MAX_TASK_DEADLINE_MINUTES)) {
    errs.push(`${at}.deadline is { afterMinutes }, a whole number of minutes from ${MIN_TASK_DEADLINE_MINUTES} to ${MAX_TASK_DEADLINE_MINUTES}: every task a run waits on has an end (a step that continues once its task opens may leave it out)`);
  }
  return errs;
}


/**
 * WHY A STEP'S `endsRun` OR `confirmEnd` IS REFUSED: `endsRun` is `true`, on a step that goes on alongside its task; and
 * `confirmEnd`, on such a step only, names a state of its machine that is not terminal, awaits the worker and offers
 * choices, reached by a declared edge from every state that offers a settling choice, so the move a press takes is authorized.
 */
export function endsRunErrors(step: Record<string, unknown>, at: string, machine: TaskStateMachine | undefined): string[] {
  const errs: string[] = [];
  if (step.endsRun !== undefined) {
    if (step.endsRun !== true) errs.push(`${at}.endsRun is true, or absent`);
    else if (step.continue !== TASK_STEP_ALONGSIDE) errs.push(`${at}.endsRun is on a step that goes on alongside its task (continue: ${TASK_STEP_ALONGSIDE}), whose settlement is the run's end`);
  }
  if (step.movesTo !== undefined && (step.endsRun !== true || typeof step.movesTo !== 'string')) errs.push(`${at}.movesTo names the step the run goes on to, on a step whose settlement ends the run (endsRun: true)`);
  if (step.confirmEnd === undefined) return errs;
  if (step.endsRun !== true) return [...errs, `${at}.confirmEnd is on a step whose settlement ends the run (endsRun: true)`];
  if (!machine) return errs;
  const name = step.confirmEnd;
  const def = typeof name === 'string' ? machine.states[name] : undefined;
  if (!def || !def.transitions.length || awaitedPartyOf(def)?.party !== 'worker' || !def.choices?.length) {
    return [...errs, `${at}.confirmEnd names a state of ${String(step.machine)} that is not terminal, awaits the worker and offers choices`];
  }
  const settles = (s: string) => machine.states[s]?.transitions.length === 0;
  for (const [key, d] of Object.entries(machine.states)) {
    if (key === name || !(d.choices ?? []).some(settles)) continue;
    if (!d.transitions.includes(name as string)) errs.push(`${at}.confirmEnd names ${String(name)}, which ${key} offers a settling choice from but declares no edge to`);
  }
  return errs;
}

/**
 * WHERE A SETTLING PRESS GOES: the step's `confirmEnd` state, where the press would settle the
 * task from another state while the run has not reached its end; else the choice as pressed.
 */
export function pressTarget(
  machine: TaskStateMachine | undefined, from: string, choice: string, run: { confirmEnd?: string } | undefined, runAtItsEnd: boolean,
): string {
  const confirm = run?.confirmEnd;
  if (!machine || !confirm || runAtItsEnd || from === confirm) return choice;
  const settles = machine.states[choice]?.transitions.length === 0;
  return settles && machine.states[from]?.transitions.includes(confirm) ? confirm : choice;
}

/**
 * THE TEMPLATE THE PERSON WHO HOLDS A STEP'S TASK IS TOLD IN: the step's `assigned` template, or its `withoutMeetings` one where
 * the deployment declares no `meetings` capability (absent means off), and undefined where the step names none.
 */
export function assignedTemplateFor(assigned: TaskStep['assigned'], meetingsDeclared: boolean): string | undefined {
  if (!assigned) return undefined;
  return !meetingsDeclared && assigned.withoutMeetings ? assigned.withoutMeetings : assigned.template;
}
