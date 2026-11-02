/**
 * AN EVENT STARTS A WORKFLOW (ADR-061): `assistant-joined`, `conversation-opened`, `person-joined`, `invitation-sent` and
 * `invitation-unredeemed`, the deadline a schedule marks.
 *
 * An event workflow is the workflow format with two kinds of step: a `platform` `send` the router posts from a
 * message template, with no model call, and an `agent` step, one turn of the assistant the processor runs from a
 * prompt template. The welcome adds its own two: the `opening` template step and the `prompt` step. On an arrival event
 * the first step is a `send` or an `opening`, so the first message the room reads waits on no model
 * (SPEC-WELCOME-AND-CONTEXT FR2); an invitation's events are events nobody is waiting on, so they may open with
 * an agent step (decision 8, rule 1). The graph is acyclic, so a run is bounded by its step count, and the runtime
 * takes every edge: no model chooses one (tenet D11).
 *
 * WHAT IT RUNS, AND WHAT IT REFUSES. Audiences are `room`, `subject`, `joined`, `{ people: 'event:person' }`,
 * `{ people: 'invitation:inviter' }` and, on a send, `{ participantRole: '<name>' }`; mentions bind `event:person`,
 * `subject`, `invitation:inviter` and `participantRole:<name>`. A participant role is one the workflow's declared
 * `types` declare (DESIGN-CONVERSATION-TYPES section 6.1); a workflow that declares no `types` has its roles checked at
 * run time, where an undeclared one resolves to nobody. A send to people may say the template the addressed person's
 * role confers (`fromRole: 'template'`), and an agent step written for one person the brief it confers
 * (`fromRole: 'brief'`), each falling back to the step's own template. `event:person`
 * exists only at an event that names a person (`conversation-opened`, `person-joined`, and `invitation-sent`, where it
 * is the invitee), `joined` only at `person-joined`, and the inviter only at an invitation's events. An edge is a step name or an ordered list of `{ to, when }` alternatives whose last
 * carries no `when`, and a step may carry a `when` of its own (ADR-060 decision 6): the runtime evaluates each through
 * the variable resolver with the values its call site holds, so an unresolved value takes the unconditioned edge and
 * a step whose `when` does not hold posts nothing. After an `agent` step the processor hands the run back to the
 * router, which runs the steps that follow (`continueAfter`). An agent step may propose one consequential act
 * (`PROPOSAL_OPS`), which the runtime offers its one addressee to confirm and never executes; it may open a task the
 * room then works on (`workflow:`, `EVENT_TASK_MACHINES`) and read the room's recent messages (`reads: messages`). An
 * `action` step offers the onboarding intake (`start_intake`) with no model call.
 *
 * WHICH WORKFLOW AN EVENT RUNS. Every event selects its own workflow from the version's `eventWorkflows`. The WELCOME
 * is the `assistant-joined` workflow, which `WelcomeIntent` starts (`welcomeWorkflowOf`): the one whose `types` name the
 * room's conversation type, else the one that names no type, else the platform's `welcome`. Its opening is a template
 * step (`opening`, the structured opening), a prompt step after it (`prompt`), or steps that greet and then continue.
 * A room an event opens runs the `conversation-opened` workflow whose `types` name its type (`openedWorkflowOf`). A
 * version declares at most one `person-joined`, `invitation-sent`, `invitation-unredeemed` and `alarm-state-changed`
 * workflow (`declaredWorkflowOn`). `person-joined` always runs: the version's own with the join recap after it, or the
 * platform's `join-recap` (`personJoinedWorkflowOf`). An intent pack declares none: every event workflow is the
 * assistant's own, on its version. What each step says is a template the assistant can edit (ADR-062).
 */
import { CONVERSATION_TYPES } from '../../../lib/config/conversation-types.js';
import {
  PARTICIPANT_ROLE_AUDIENCE_CAP, PARTICIPANT_ROLE_NAME, isAudienceRole, participantRoleOf, participantRolesOf, typeIsMixedTrust,
} from '../../../lib/config/participant-roles.js';
import { isKnownTool, toolChangesState } from './tool-registry.js';
import { inertMention } from './message-markers.js';
import {
  buildSourceTable, insertionErrors, sourceLookup, whenErrors, whenHolds, whenKeys,
  type SourceLookup, type VariableValue, type VersionVariable, type When,
} from './variables.js';
import type { CallSiteCapabilities } from './context-source-shapes.js';
import { shippedMessageTemplates } from './shipped-message-templates.js';
import type { ParsedTemplate } from './document-template.js';
import { personIdFromArn } from './person-arn.js';
import { openingStepErrors, type WelcomeOpeningStep } from './welcome-orientation.js';
import {
  TASK_STATE_SOURCE, TASK_STEP_OUTCOMES, machinesAStepMayOpen, taskOutcomeOf, taskStateSource, taskStepErrors, type TaskStep,
} from './task-step.js';
import type { TaskStateMachine } from './task-state-machines.js';

export const EVENT_WORKFLOW_EVENTS = ['assistant-joined', 'conversation-opened', 'person-joined', 'invitation-sent', 'invitation-unredeemed', 'alarm-state-changed'] as const;
export type WorkflowEvent = typeof EVENT_WORKFLOW_EVENTS[number];

/**
 * THE INCIDENT WATCH (ADR-061 slice 5): `alarm-state-changed`, whose one source is the CloudWatch alarm state change on the
 * account's default bus, delivered by an EventBridge rule on the classification stack whose conversation types declare an
 * opener that maps `watchesAlarm`. It runs in the conversation that watches the alarm (`watchedAlarm` on its
 * channel-context row, the watch record the creator writes), once per state the alarm entered, after the router has read
 * the alarm's state back from CloudWatch. Nobody is waiting on it, so it may open with an agent step.
 */
export const ALARM_STATES = ['ALARM', 'OK', 'INSUFFICIENT_DATA'] as const;
export type AlarmState = typeof ALARM_STATES[number];
export const isAlarmState = (v: unknown): v is AlarmState => (ALARM_STATES as readonly unknown[]).includes(v);
/** A CloudWatch alarm name: printable, at most 255 characters. */
export const ALARM_NAME = /^[A-Za-z0-9 ._:/#+()-]{1,255}$/;
/** The key of the record that names the conversation watching an alarm, in the channel-context table. */
export const alarmWatchKey = (alarmName: string): string => `watch#alarm#${alarmName}`;

/**
 * THE EVENTS A DEADLINE MARKS (decision 1, "a deadline is a one-shot schedule, never a poll"): each comes from one
 * schedule the router creates when it handles the event that starts the thing it times, at the deadline the workflow
 * declares (`deadline.afterMinutes`). `invitation-unredeemed` is timed from `invitation-sent`.
 */
export const DEADLINE_EVENTS = ['invitation-unredeemed'] as const;
export type DeadlineEvent = typeof DEADLINE_EVENTS[number];
export const isDeadlineEvent = (v: unknown): v is DeadlineEvent => (DEADLINE_EVENTS as readonly unknown[]).includes(v);
/** The earliest and latest a deadline workflow may declare its deadline after the thing it times started. */
export const MIN_DEADLINE_MINUTES = 5;
export const MAX_DEADLINE_MINUTES = 30 * 24 * 60;
/** Where a deadline that could not be scheduled is counted, the metric the classification's alarm watches. */
export const DEADLINE_METRIC_NAMESPACE = 'AgentEchelon/EventDeadlines';
export const DEADLINE_SCHEDULE_FAILED_METRIC = 'DeadlineScheduleFailed';

/** The events an invitation names, whose natural key is the invitation and whose people are its record's. */
export const INVITATION_EVENTS: readonly WorkflowEvent[] = ['invitation-sent', 'invitation-unredeemed'];
export const isInvitationEvent = (event: WorkflowEvent): boolean => INVITATION_EVENTS.includes(event);

/**
 * The events that name a person, which `event:person` holds (ADR-061 decision 1, "What it names"). At `invitation-sent`
 * it is the invitee the invitation's record names.
 */
export const EVENTS_NAMING_A_PERSON: readonly WorkflowEvent[] = ['conversation-opened', 'person-joined', 'invitation-sent', 'invitation-unredeemed'];
const namesAPerson = (event: WorkflowEvent): boolean => EVENTS_NAMING_A_PERSON.includes(event);

/**
 * THE ARRIVAL EVENTS (decision 8, rule 1): people have just arrived and read what is posted, so the opening is a
 * platform send and no model call stands before it. `invitation-sent` is not one: the invitee has not arrived.
 */
export const ARRIVAL_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'conversation-opened', 'person-joined'];
const isArrival = (event: WorkflowEvent): boolean => ARRIVAL_EVENTS.includes(event);

/**
 * THE EVENTS THAT SELECT THEIR OWN WORKFLOW (decision 1, "one workflow per event per version"): no welcome names a
 * workflow on them, so a version declares at most one on each, and the event runs it (`declaredWorkflowOn`).
 */
export const EVENTS_SELECTING_THEIR_WORKFLOW: readonly WorkflowEvent[] = ['person-joined', 'invitation-sent', 'invitation-unredeemed', 'alarm-state-changed'];

/**
 * THE EVENTS WHOSE WORKFLOW THE ROOM'S CONVERSATION TYPE SELECTS (W1): the welcome on `assistant-joined`, and the room an
 * event opens on `conversation-opened`. A version may declare one per type, and on `assistant-joined` one that names
 * no type, which answers for every other room.
 */
export const TYPE_SELECTED_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'conversation-opened'];

/**
 * THE TASK MACHINES AN AGENT STEP MAY OPEN (`workflow:`, ADR-061 decision 8): platform machines whose initial step awaits
 * nobody, because a task an event opens has no requester. The runtime opens the task before the turn, the turn runs the
 * initial step, and the runtime takes that step's one transition once the turn posted, so the task rests on its next step
 * as the room's work. `task-state-machines.ts` declares each, and a test holds this list to those declarations.
 */
export const EVENT_TASK_MACHINES = ['incident_first_look'] as const;
export const isEventTaskMachine = (v: unknown): boolean => (EVENT_TASK_MACHINES as readonly unknown[]).includes(v);

/**
 * THE INTAKE AS A STEP (ADR-061 decision 2): `start_intake` offers the onboarding intake to the one person the step names,
 * with no model call. It is the subject at `assistant-joined`, the person who joined at `person-joined`, and the person
 * the opening named at `conversation-opened`. A person already onboarded, an assistant with no intake, or one whose every
 * field is already known is offered nothing and the run goes on.
 */
export interface IntakeAction {
  tool: 'start_intake';
  to: 'subject' | 'joined' | { people: 'event:person' };
}
/** Where an intake may be offered: the events that name its one person. */
const INTAKE_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'conversation-opened', 'person-joined'];

/**
 * Who a send or an agent step's output is for (ADR-061 decision 3, the built subset). `joined` is the person
 * `person-joined` names, once the router has verified their membership. `{ people: 'invitation:inviter' }` is the member
 * who issued the invitation `invitation-sent` names, read from its record.
 */
export type EventAudience = 'room' | 'subject' | 'joined' | { people: 'event:person' } | { people: 'invitation:inviter' } | { participantRole: string };
/**
 * Whose display name a mention field renders (ADR-061 decision 2 and 6). `participantRole:<name>` renders the role's
 * holders who are members, as a list.
 */
export type MentionSource = 'event:person' | 'subject' | 'invitation:inviter' | `participantRole:${string}`;
export const MENTION_SOURCES: readonly string[] = ['event:person', 'subject', 'invitation:inviter', 'participantRole:<name>'];
/** The participant role a mention source names, or undefined. */
export const mentionedRole = (source: unknown): string | undefined => {
  if (typeof source !== 'string' || !source.startsWith('participantRole:')) return undefined;
  const name = source.slice('participantRole:'.length);
  return PARTICIPANT_ROLE_NAME.test(name) ? name : undefined;
};
/** The participant role an audience names, or undefined. */
export const audienceRole = (to: unknown): string | undefined =>
  isObject(to) && Object.keys(to).length === 1 && typeof to.participantRole === 'string' && PARTICIPANT_ROLE_NAME.test(to.participantRole) ? to.participantRole : undefined;
/** The audiences that name exactly one person, which a brief drafted for one person may address. */
const ONE_PERSON_AUDIENCES: readonly unknown[] = ['joined', 'subject', { people: 'event:person' }, { people: 'invitation:inviter' }];
/** The most holders a role mention names before it closes with a count of the rest (ADR-061 decision 2). */
export const MAX_MENTIONED_HOLDERS = 5;

export interface SendStep {
  to: EventAudience;
  /** A message template (ADR-062), selected assistant first, then the classification's, then the shipped one. */
  template: string;
  /** Template field to the person whose display name it renders, inert. */
  mention?: Record<string, MentionSource>;
  /**
   * Say the message template the addressed person's participant role confers (`confers.template`, the first held role
   * in declaration order that confers one), and `template` where none does (DESIGN-CONVERSATION-TYPES section 6.1).
   */
  fromRole?: 'template';
}

export interface AgentStep {
  /** A prompt template (ADR-062). */
  prompt: string;
  /** Draft from the brief the addressed person's participant role confers (`confers.brief`), and `prompt` where none does. */
  fromRole?: 'brief';
  /** Read tools only, each among the own tools of the assistant that takes the step (`as`, else the primary). */
  tools?: string[];
  to: EventAudience;
  deadlineMs: number;
  /**
   * Posted when the turn does not deliver: past the deadline, on a model error, a guardrail or a refused meter. `absent`,
   * on a step that names `as`, is posted in its place when no assistant holding that role is in the room, so the room is
   * told plainly that the assistant who would have answered is not there. It is a room message with no mention.
   */
  fallback: { send: SendStep; absent?: { to: 'room'; template: string } };
  /**
   * THE ASSISTANT THAT TAKES THIS ONE STEP, BY ITS ROLE (`{ role: 'ops' }`): the room's assistant of this classification
   * that holds the role, as itself, on its own session and with its own grants, never the primary's. The run stays the
   * primary's (its claims, its version and its continuation); only this step's turn is handed to the role's assistant, as
   * a person's question is handed to an ops roommate. Where no assistant holding the role is in the room the step is not
   * dispatched: it posts `fallback.absent` (else `fallback.send`) and takes its failure edge, and no turn runs, so no tool
   * is called.
   */
  as?: { role: string };
  /**
   * THE ONE CONSEQUENTIAL ACT THE STEP PROPOSES, NEVER EXECUTES (decision 8, rules 5, 7 and 8): a `PROPOSAL_OPS` name.
   * The turn drafts the proposal; the runtime records it, addressed to the step's one person (`to`), and offers it to
   * them as a confirmation card. Nothing happens until that person applies it.
   */
  propose?: string[];
  /** For `open_conversation`: the conversation type the proposal opens, a declared type. */
  opens?: string;
  /**
   * A TASK THE RUNTIME OPENS BEFORE THE TURN, whose first step the turn runs (decision 8): one of `EVENT_TASK_MACHINES`.
   * Opening it is the runtime's act, never a tool the model calls.
   */
  workflow?: string;
  /**
   * THE ROOM'S RECENT MESSAGES, READ AS THE TURN READS THEM (`'messages'`): the conversation the room's assistant reads under
   * its own grants, with every targeted message kept out (`privateReaderOf`). The join recap reads them. A step whose draft
   * reaches a person outside the room never does (rule 6).
   */
  reads?: 'messages';
}

/** Whether a step is a join recap: an agent step that reads the room's recent messages, written for the person who joined. */
export function isJoinRecapStep(def: Pick<EventStepDef, 'agent'> | undefined): boolean {
  return !!def?.agent && def.agent.reads === 'messages' && def.agent.to === 'joined';
}

/**
 * WHETHER A STEP HAS NOTHING TO SAY (`skipped`): a join recap, whose one job is to recount what people said, in a room
 * where no person has said anything yet. Every other step that reads the room reads it as context for its own work (the
 * incident watch's re-read reads the first look before it), so a room no person has spoken in still runs it.
 */
export function nothingToRecap(def: Pick<EventStepDef, 'agent'> | undefined, personSpoke: boolean): boolean {
  return isJoinRecapStep(def) && !personSpoke;
}

/**
 * WHETHER AN AGENT STEP DELIVERED WHAT IT OWES, which takes its success edge: its output posted, or a join recap with
 * nothing to recount (`skipped`). Every other outcome takes the failure edge.
 */
export function agentStepDelivered(def: Pick<EventStepDef, 'agent'> | undefined, outcome: string): boolean {
  return outcome === 'posted' || (outcome === 'skipped' && isJoinRecapStep(def));
}

/**
 * WHAT AN AGENT STEP MAY PROPOSE (decision 8, rule 7: consequence is a proposal a person confirms). Each op names the
 * events it may be proposed at, whom the proposal is addressed to, and whether what it drafts reaches a person not
 * reading the room, in which case the turn is given no conversation and no tools (rule 6).
 *
 *  - `send_nudge`: at `invitation-unredeemed`, to the invitation's inviter, who confirms an email reminding the invitee.
 *    The drafted note reaches the invitee, who is not reading the room.
 *  - `open_conversation`: a conversation of the step's declared type (`opens`), opened by the conversation's
 *    classification's creator for the person who confirms it, who holds each participant role the type sources from
 *    `{ creator: true }` (DESIGN-CONVERSATION-TYPES section 6.1). The drafted text is the new conversation's label.
 */
export const PROPOSAL_OPS = {
  send_nudge: { events: ['invitation-unredeemed'] as readonly WorkflowEvent[], addressee: { people: 'invitation:inviter' } as EventAudience, reachesOutside: true },
  open_conversation: { events: EVENT_WORKFLOW_EVENTS as readonly WorkflowEvent[], addressee: undefined, reachesOutside: false },
} as const;
export type ProposalOp = keyof typeof PROPOSAL_OPS;
export const isProposalOp = (v: unknown): v is ProposalOp => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROPOSAL_OPS, v);
/** The op an agent step proposes, or undefined. */
export const proposalOf = (agent: Pick<AgentStep, 'propose'> | undefined): ProposalOp | undefined => {
  const op = agent?.propose?.[0];
  return isProposalOp(op) ? op : undefined;
};
/**
 * WHETHER AN AGENT STEP'S TURN IS NARROWED (decision 8, rule 6): what it drafts reaches a person not reading the room, so
 * it reads only its prompt and the event's declared values, as data, with no conversation and no tools.
 */
export const agentStepIsNarrowed = (agent: Pick<AgentStep, 'propose'> | undefined): boolean => {
  const op = proposalOf(agent);
  return !!op && PROPOSAL_OPS[op].reachesOutside;
};

/**
 * THE WELCOME'S PROMPT STEP (SPEC-WELCOME-AND-CONTEXT FR24): one model turn of the joining assistant from a prompt
 * template, after its opening. The turn is the assistant's own, dispatched with no lock and metered `machineWritten`,
 * and its tools are read tools. Nothing follows it in the run, because its turn posts after the run has moved on.
 */
export interface PromptWelcomeStep {
  /** A prompt template (ADR-062): a shipped one, or one the assistant or its classification holds. */
  template: string;
  /** Read tools only. */
  tools?: string[];
}

/** The event whose workflow is the assistant's welcome, the one event the welcome's own steps (`opening`, `prompt`) run on. */
export const WELCOME_EVENT: WorkflowEvent = 'assistant-joined';

/** One alternative of a conditioned edge: the step it goes to, and the condition that selects it. */
export interface ConditionedEdge {
  to: string;
  /** Absent on the last alternative only, which the runtime takes when no earlier `when` holds. */
  when?: When;
}

/** An outcome edge: a step name, or an ordered list of `{ to, when }` alternatives (ADR-061 decision 2). */
export type EventEdge = string | readonly ConditionedEdge[];

export interface EventStepDef {
  send?: SendStep;
  agent?: AgentStep;
  /**
   * THE WELCOME'S TEMPLATE STEP: the room's opening, rendered by the platform's composition (`composeOpening`) from the
   * orientation fields it carries, or from its own `text`, and with no field at all from the deployment's orientation.
   * Said with no model call, so it may open an arrival.
   */
  opening?: WelcomeOpeningStep;
  /** THE WELCOME'S PROMPT STEP: one model turn after the opening (`PromptWelcomeStep`). */
  prompt?: PromptWelcomeStep;
  /** A platform action the router runs with no model call: today the intake (`start_intake`). */
  action?: IntakeAction;
  /**
   * A TASK THE STEP ASSIGNS (ADR-063 decision 1): one task of a declared machine, for a person and worked by a person, a
   * participant role's one holder or an assistant. The run waits on it and continues when it settles: `onSuccess` for a
   * terminal of kind success, `onDeadline` (else `onFailure`) when its deadline cancelled it, `onFailure` otherwise.
   */
  task?: TaskStep;
  onSuccess?: EventEdge;
  onFailure?: EventEdge;
  /** A task step only: the edge taken when the task's deadline cancelled it. Absent, `onFailure`. */
  onDeadline?: EventEdge;
  /**
   * The step's own condition (ADR-060 decision 6). Where it does not hold the step posts nothing and the run takes
   * its `onSuccess`, as a send whose audience resolves to nobody does.
   */
  when?: When;
  /** Present on a terminal step. */
  disposition?: 'success' | 'failure';
}

export interface EventWorkflow {
  on: WorkflowEvent;
  /** The conversation types it runs in. Required on `conversation-opened`, each declaring `openedBy`. */
  types?: string[];
  initial: string;
  states: Record<string, EventStepDef>;
  /**
   * On a deadline event only, and required there: how long after the thing it times started the deadline falls. The
   * router brings it forward to before the timed thing's own expiry (`deadlineAt`).
   */
  deadline?: { afterMinutes: number };
}

/** The longest an `agent` step may wait on its model before its fallback is posted. */
export const MAX_AGENT_DEADLINE_MS = 60_000;
/** The most steps one run takes, which bounds a run whatever its graph. */
export const MAX_EVENT_RUN_STEPS = 16;

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * THE PLATFORM'S EVENT WORKFLOWS. `ops-room` is ADR-061's example (a), the ops room's first look; `opening-and-subject`
 * opens a room and greets the person it was opened for. Each step's words are shipped templates the assistant can
 * replace with its own (`shipped-message-templates.ts`).
 */
export const PLATFORM_EVENT_WORKFLOWS: Readonly<Record<string, EventWorkflow>> = {
  // THE WELCOME A VERSION THAT DECLARES NONE RUNS (W1): one template step with no field of its own, so the opening is the
  // deployment's orientation for the classification's primary and the platform's generic opening for any other assistant.
  welcome: {
    on: 'assistant-joined',
    initial: 'opening',
    states: {
      opening: { opening: {}, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  'ops-room': {
    on: 'conversation-opened',
    types: ['ops'],
    initial: 'opening',
    states: {
      opening: { send: { to: 'room', template: 'ops-room-opening', mention: { lead: 'participantRole:lead' } }, onSuccess: 'greet-lead', onFailure: 'greet-lead' },
      'greet-lead': { send: { to: { participantRole: 'lead' }, template: 'ops-lead-welcome' }, onSuccess: 'first-look', onFailure: 'first-look' },
      'first-look': {
        agent: {
          prompt: 'ops-first-look',
          // THE RUNTIME OPENS AN `incident_first_look` TASK IN THE ROOM, and this turn runs its first step.
          workflow: 'incident_first_look',
          // THE OPS ASSISTANT READS THE HEALTH, as itself: telemetry is its role's grant, and no primary holds it.
          as: { role: 'ops' },
          tools: ['read_deployment_health'],
          to: 'room',
          deadlineMs: 20_000,
          fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' }, absent: { to: 'room', template: 'ops-assistant-absent' } },
        },
        onSuccess: 'done',
        onFailure: 'done',
      },
      done: { disposition: 'success' },
    },
  },
  'opening-and-subject': {
    on: 'assistant-joined',
    initial: 'opening',
    states: {
      opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'greet-subject', onFailure: 'done' },
      'greet-subject': { send: { to: 'subject', template: 'workflow-subject-welcome', mention: { name: 'subject' } }, onSuccess: 'intake', onFailure: 'intake' },
      // THE INTAKE FOLLOWS THE GREETING (decision 2): offered to the subject when the assistant has one and they are not
      // onboarded, and nothing otherwise.
      intake: { action: { tool: 'start_intake', to: 'subject' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  // THE JOIN RECAP (decision 5): `person-joined`'s default, the one step a version that declares no `person-joined`
  // workflow runs. One turn of the room's assistant reads the room's recent messages and catches the person who joined
  // up, privately. A version that declares its own workflow keeps it too (`withJoinRecap`).
  'join-recap': {
    on: 'person-joined',
    initial: 'recap',
    states: {
      recap: {
        agent: {
          prompt: 'join-recap',
          reads: 'messages',
          to: 'joined',
          deadlineMs: 20_000,
          fallback: { send: { to: 'joined', template: 'join-recap-unavailable' } },
        },
        onSuccess: 'done',
        onFailure: 'done',
      },
      done: { disposition: 'success' },
    },
  },
  // THE INCIDENT WATCH (slice 5): the alarm the ops room watches changed state. The room is told which state it entered,
  // and the ops assistant reads the deployment's health again and says what changed. A version copies it into its own
  // `eventWorkflows`, because an event that selects its workflow runs the version's.
  'incident-watch': {
    on: 'alarm-state-changed',
    types: ['ops'],
    initial: 'announce',
    states: {
      announce: { send: { to: 'room', template: 'incident-alarm-changed' }, onSuccess: 'recheck', onFailure: 'recheck' },
      recheck: {
        agent: {
          prompt: 'ops-incident-recheck',
          as: { role: 'ops' },
          tools: ['read_deployment_health'],
          reads: 'messages',
          to: 'room',
          deadlineMs: 20_000,
          fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' }, absent: { to: 'room', template: 'ops-assistant-absent' } },
        },
        onSuccess: 'done',
        onFailure: 'done',
      },
      done: { disposition: 'success' },
    },
  },
  // ADR-061 example (c)'s shape for an invitation: three days after it was sent and still unredeemed, the assistant
  // drafts a reminder and proposes it to the inviter, who confirms before the invitee is emailed (SPEC-ASSISTANT-MEETINGS
  // FR32). A version copies it into its own `eventWorkflows`, because an event that selects its workflow runs the version's.
  'chase-unredeemed': {
    on: 'invitation-unredeemed',
    deadline: { afterMinutes: 3 * 24 * 60 },
    initial: 'draft-nudge',
    states: {
      'draft-nudge': {
        agent: {
          prompt: 'invitation-nudge-draft',
          propose: ['send_nudge'],
          to: { people: 'invitation:inviter' },
          deadlineMs: 20_000,
          fallback: { send: { to: { people: 'invitation:inviter' }, template: 'invitation-unredeemed-reminder' } },
        },
        onSuccess: 'done',
        onFailure: 'done',
      },
      done: { disposition: 'success' },
    },
  },
};

/** The workflow a name selects, or undefined. */
export function eventWorkflowNamed(name: string | undefined): EventWorkflow | undefined {
  return name && Object.prototype.hasOwnProperty.call(PLATFORM_EVENT_WORKFLOWS, name) ? PLATFORM_EVENT_WORKFLOWS[name] : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * What a workflow's sends and conditions are checked against (ADR-060 decision 3, first layer): the classification's
 * sources and the version's variables, and the template each send names. Absent, the fixed sources and the shipped
 * templates: a template the version's own family holds is checked again where it is selected
 * (`loadNamedTemplate` with its audience).
 */
export interface WorkflowValidation {
  lookup?: SourceLookup;
  template?: (name: string) => ParsedTemplate | undefined;
  /**
   * The task machines a task step may open (ADR-063 decision 1): the version's selection merged over the platform's.
   * Absent, the platform's reference machines.
   */
  machines?: Readonly<Record<string, TaskStateMachine>>;
}

let fixedLookup: SourceLookup | undefined;
const defaultLookup = (): SourceLookup => (fixedLookup ??= sourceLookup(buildSourceTable({ catalog: [] })));
const shippedTemplate = (name: string): ParsedTemplate | undefined => shippedMessageTemplates().get(name)?.template;

/** Who reads what a send posts: the room, or the people it is addressed to. */
const audienceOfSend = (to: unknown): 'room' | 'addressed' => (to === 'room' ? 'room' : 'addressed');

/**
 * A SEND'S TEMPLATE LEARNS ITS AUDIENCE (decision 3): the template it names is checked against who the step posts
 * to and which fields it mentions, so a fact about a person in a room send, or a mention of anything but a display
 * name, is refused when the workflow is stored.
 */
function sendInsertionErrors(send: Record<string, unknown>, at: string, opts: WorkflowValidation): string[] {
  if (typeof send.template !== 'string') return [];
  const template = (opts.template ?? shippedTemplate)(send.template);
  if (!template || template.kind !== 'message') return [];
  const mentions = isObject(send.mention) ? Object.keys(send.mention) : [];
  return insertionErrors(
    { fields: template.fields ?? {}, sections: template.messageSections ?? {}, audience: audienceOfSend(send.to), mentions },
    opts.lookup ?? defaultLookup(),
  ).map((e) => `${at}.template ${send.template}: ${e}`);
}

/**
 * WHY A PARTICIPANT ROLE A WORKFLOW NAMES IS REFUSED: with declared `types`, every one of them declares it, addressable
 * (`confers.audience`), and, for a mention in a room message, sayable where a guest or a link session reads
 * (`visibleToGuests`). With no `types`, the role is checked at run time against the conversation's type.
 */
function roleErrors(role: string, at: string, types: readonly string[] | undefined, saidInRoom: boolean): string[] {
  if (!types?.length) return [];
  const errs: string[] = [];
  for (const t of types) {
    const decl = participantRoleOf(t, role);
    if (!decl) errs.push(`${at} names participant role ${role}, which type ${t} does not declare`);
    else if (!isAudienceRole(decl)) errs.push(`${at} names participant role ${role}, which type ${t} declares with confers.audience false`);
    else if (saidInRoom && typeIsMixedTrust(t) && decl.visibleToGuests !== true) {
      errs.push(`${at} mentions participant role ${role} in a room message, and type ${t} admits guests or link sessions while the role does not declare visibleToGuests`);
    }
  }
  return errs;
}

function audienceErrors(to: unknown, at: string, event: WorkflowEvent, types?: readonly string[]): string[] {
  if (to === 'room' || to === 'subject') return [];
  if (isObject(to) && 'participantRole' in to) {
    const role = audienceRole(to);
    if (!role) return [`${at}.to is { participantRole: '<name>' } with a declared role name`];
    return roleErrors(role, `${at}.to`, types, false);
  }
  if (to === 'joined') return event === 'person-joined' ? [] : [`${at}.to is joined, which only person-joined carries`];
  if (isObject(to) && to.people === 'event:person' && Object.keys(to).length === 1) {
    return namesAPerson(event) ? [] : [`${at}.to names event:person, which only ${EVENTS_NAMING_A_PERSON.join(', ')} carry`];
  }
  if (isObject(to) && to.people === 'invitation:inviter' && Object.keys(to).length === 1) {
    return isInvitationEvent(event) ? [] : [`${at}.to names invitation:inviter, which only ${INVITATION_EVENTS.join(' and ')} carry`];
  }
  return [`${at}.to is room, subject, joined, { people: event:person }, { people: invitation:inviter } or { participantRole: '<name>' }`];
}

/** The person a mention source names in this run, or undefined. */
function mentionedPerson(source: MentionSource, ctx: Pick<EventRunContext, 'subject' | 'eventPerson' | 'inviter'>): string | undefined {
  if (source === 'subject') return ctx.subject;
  if (source === 'invitation:inviter') return ctx.inviter;
  if (mentionedRole(source)) return undefined;
  return ctx.eventPerson;
}

function sendErrors(send: unknown, at: string, event: WorkflowEvent, opts: WorkflowValidation = {}, types?: readonly string[]): string[] {
  if (!isObject(send)) return [`${at} must be a send step`];
  const errs = audienceErrors(send.to, at, event, types);
  if (send.fromRole !== undefined) {
    if (send.fromRole !== 'template') errs.push(`${at}.fromRole is template`);
    else if (send.to === 'room') errs.push(`${at}.fromRole says the template a person's role confers, so it is on a send to people, never the room`);
  }
  if (typeof send.template !== 'string' || !NAME.test(send.template)) errs.push(`${at}.template names a message template`);
  if (send.mention !== undefined) {
    if (!isObject(send.mention)) errs.push(`${at}.mention maps a template field to ${MENTION_SOURCES.join(', ')}`);
    else {
      for (const [field, source] of Object.entries(send.mention)) {
        const role = mentionedRole(source);
        if (role) {
          errs.push(...roleErrors(role, `${at}.mention.${field}`, types, send.to === 'room'));
        } else if (!(MENTION_SOURCES as readonly unknown[]).includes(source) || source === 'participantRole:<name>') errs.push(`${at}.mention.${field} binds ${MENTION_SOURCES.join(', ')}`);
        else if (source === 'event:person' && !namesAPerson(event)) errs.push(`${at}.mention.${field} binds event:person, which only ${EVENTS_NAMING_A_PERSON.join(', ')} carry`);
        else if (source === 'invitation:inviter' && !isInvitationEvent(event)) errs.push(`${at}.mention.${field} binds invitation:inviter, which only ${INVITATION_EVENTS.join(' and ')} carry`);
      }
    }
  }
  return [...errs, ...sendInsertionErrors(send, at, opts)];
}

/**
 * WHY A STEP'S PROPOSAL IS REFUSED (decision 8, rules 6 to 8): one registered op, at an event it may be proposed at,
 * addressed to exactly one person (the person who confirms it, and for `send_nudge` the inviter), and, where its draft
 * reaches someone outside the room, with no tools, because that turn reads nothing but its declared values.
 */
function proposeErrors(agent: Record<string, unknown>, at: string, event: WorkflowEvent, types?: readonly string[]): string[] {
  if (agent.propose === undefined) {
    return agent.opens !== undefined ? [`${at}.opens names the conversation type an open_conversation proposal opens, and the step proposes none`] : [];
  }
  const ops = agent.propose;
  if (!Array.isArray(ops) || ops.length !== 1 || !isProposalOp(ops[0])) {
    return [`${at}.propose names exactly one of ${Object.keys(PROPOSAL_OPS).join(', ')}`];
  }
  const op = ops[0] as ProposalOp;
  const spec = PROPOSAL_OPS[op];
  const errs: string[] = [];
  if (!spec.events.includes(event)) errs.push(`${at}.propose names ${op}, which is proposed only at ${spec.events.join(', ')}`);
  // A PROPOSAL IS ADDRESSED TO ONE PERSON, who alone may apply it: one of the one-person audiences, or a participant role
  // every declared type gives one holder, whose holding the apply endpoint reads again from the context row.
  const role = audienceRole(agent.to);
  const oneHolderRole = !!role && !!types?.length && types.every((t) => participantRoleOf(t, role)?.holders === 'one');
  if (role && !oneHolderRole) {
    errs.push(`${at}.to addresses a proposal to participant role ${role}, which every type the workflow declares must give one holder (holders: one)`);
  } else if (!role && !ONE_PERSON_AUDIENCES.some((a) => JSON.stringify(a) === JSON.stringify(agent.to))) {
    errs.push(`${at}.to names the one person a proposal is addressed to, who alone may apply it: joined, subject, { people: event:person }, { people: invitation:inviter } or a one-holder participant role`);
  } else if (spec.addressee && JSON.stringify(spec.addressee) !== JSON.stringify(agent.to)) {
    errs.push(`${at}.to addresses ${op} to ${JSON.stringify(spec.addressee)}, the person who may confirm it`);
  }
  if (spec.reachesOutside && Array.isArray(agent.tools) && agent.tools.length) {
    errs.push(`${at}.tools: a step whose ${op} draft reaches a person outside the room reads only its declared values, so it runs no tools (ADR-061 decision 8, rule 6)`);
  }
  if (op === 'open_conversation') {
    const type = typeof agent.opens === 'string' ? CONVERSATION_TYPES[agent.opens] : undefined;
    if (!type) errs.push(`${at}.opens names the declared conversation type an open_conversation proposal opens`);
    else if (type.initiation === 'system') errs.push(`${at}.opens names ${agent.opens}, which the platform opens on its own (initiation: system)`);
  } else if (agent.opens !== undefined) {
    errs.push(`${at}.opens is for open_conversation only`);
  }
  return errs;
}

function agentErrors(agent: unknown, at: string, event: WorkflowEvent, opts: WorkflowValidation = {}, types?: readonly string[]): string[] {
  if (!isObject(agent)) return [`${at} must be an agent step`];
  const errs: string[] = [];
  if (typeof agent.prompt !== 'string' || !NAME.test(agent.prompt)) errs.push(`${at}.prompt names a prompt template`);
  errs.push(...audienceErrors(agent.to, at, event, types));
  if (agent.fromRole !== undefined) {
    if (agent.fromRole !== 'brief') errs.push(`${at}.fromRole is brief`);
    else if (!ONE_PERSON_AUDIENCES.some((a) => JSON.stringify(a) === JSON.stringify(agent.to))) {
      errs.push(`${at}.fromRole drafts one person's brief, so the step is written for one person: joined, subject, { people: event:person } or { people: invitation:inviter }`);
    }
  }
  // AN AGENT STEP POSTS ONLY TO PEOPLE READING THE ROOM (decision 8, rule 6). At an invitation's events the invitee has
  // not redeemed it and reads nothing posted here, so a step addressed to them is refused; a draft that reaches them by
  // email is a proposal to the inviter (`send_nudge`), whose turn is narrowed to its declared values.
  if (isInvitationEvent(event) && isObject(agent.to) && agent.to.people === 'event:person') {
    errs.push(`${at}.to names the invitee, who reads nothing in the conversation until they redeem the invitation; address the inviter, and propose send_nudge to reach the invitee`);
  }
  if (typeof agent.deadlineMs !== 'number' || !Number.isInteger(agent.deadlineMs) || agent.deadlineMs <= 0 || agent.deadlineMs > MAX_AGENT_DEADLINE_MS) {
    errs.push(`${at}.deadlineMs is a whole number of milliseconds, at most ${MAX_AGENT_DEADLINE_MS}`);
  }
  if (!isObject(agent.fallback) || !agent.fallback.send) errs.push(`${at}.fallback must be a send, so a person is never left with nothing`);
  else {
    errs.push(...sendErrors(agent.fallback.send, `${at}.fallback.send`, event, opts, types));
    // THE FALLBACK IS WHAT IS POSTED WHEN THE MODEL DID NOT DELIVER (ADR-062 decision 5), so it never waits on one.
    const named = isObject(agent.fallback.send) && typeof agent.fallback.send.template === 'string' ? agent.fallback.send.template : undefined;
    if (named && (opts.template ?? shippedTemplate)(named)?.fill === 'voice') {
      errs.push(`${at}.fallback.send.template ${named} is fill: voice; a fallback is a platform template, said with no model call`);
    }
  }
  // THE STEP'S ASSISTANT, BY ROLE: a role name, and the message said when nobody holding it is in the room.
  if (agent.as !== undefined && (!isObject(agent.as) || typeof agent.as.role !== 'string' || !NAME.test(agent.as.role) || Object.keys(agent.as).length !== 1)) {
    errs.push(`${at}.as is { role }, naming the role of the assistant that takes the step`);
  }
  if (isObject(agent.fallback) && agent.fallback.absent !== undefined) {
    const absent = agent.fallback.absent;
    if (agent.as === undefined) errs.push(`${at}.fallback.absent is said when the step's role has no assistant in the room, so the step names as`);
    else if (!isObject(absent) || absent.to !== 'room' || typeof absent.template !== 'string' || !NAME.test(absent.template) || Object.keys(absent).length !== 2) {
      errs.push(`${at}.fallback.absent is { to: room, template }`);
    } else if ((opts.template ?? shippedTemplate)(absent.template)?.fill === 'voice') {
      errs.push(`${at}.fallback.absent.template ${absent.template} is fill: voice; a fallback is a platform template, said with no model call`);
    }
  }
  if (agent.tools !== undefined) {
    if (!Array.isArray(agent.tools) || agent.tools.some((t) => typeof t !== 'string')) errs.push(`${at}.tools is a list of tool names`);
    else for (const t of agent.tools as string[]) {
      if (!isKnownTool(t)) errs.push(`${at}.tools names "${t}", which is not a registered tool`);
      // AN AGENT STEP EXECUTES READ TOOLS ONLY (decision 8, rule 5). A consequential act is a proposal (`propose`),
      // never a tool the turn runs.
      else if (toolChangesState(t)) errs.push(`${at}.tools names "${t}", which changes state; an agent step executes read tools only, and proposes a consequential act with propose`);
    }
  }
  errs.push(...proposeErrors(agent, at, event, types));
  // A TASK AN EVENT OPENS has no requester, so it is a platform machine whose first step awaits nobody, and the turn that
  // runs that step reads the room it is opened in: never a turn narrowed to declared values.
  if (agent.workflow !== undefined) {
    if (!isEventTaskMachine(agent.workflow)) errs.push(`${at}.workflow names a task machine an event may open: ${EVENT_TASK_MACHINES.join(', ')}`);
    else if (agentStepIsNarrowed(agent as Pick<AgentStep, 'propose'>)) errs.push(`${at}.workflow opens a task in the room, and a step whose draft reaches a person outside it reads nothing of the room`);
    else if (agent.to !== 'room') errs.push(`${at}.workflow opens a task the room works on, so the step posts to the room`);
  }
  // THE ROOM'S RECENT MESSAGES (rule 6): read only where what the step writes reaches members reading the room.
  if (agent.reads !== undefined) {
    if (agent.reads !== 'messages') errs.push(`${at}.reads is messages`);
    else if (agentStepIsNarrowed(agent as Pick<AgentStep, 'propose'>)) errs.push(`${at}.reads: a step whose draft reaches a person outside the room reads only its declared values (ADR-061 decision 8, rule 6)`);
    else if (isInvitationEvent(event)) errs.push(`${at}.reads: at ${event} the step's reader is not reading the room's messages`);
  }
  return errs;
}

/** Why an action step is refused: `start_intake`, addressed to the one person its event names. */
function actionErrors(action: unknown, at: string, event: WorkflowEvent): string[] {
  if (!isObject(action) || action.tool !== 'start_intake') return [`${at} is { tool: start_intake, to }`];
  if (!INTAKE_EVENTS.includes(event)) return [`${at}: an intake is offered at ${INTAKE_EVENTS.join(', ')}, the events that name its one person`];
  const to = action.to;
  const fits = (event === 'assistant-joined' && to === 'subject')
    || (event === 'person-joined' && (to === 'joined' || (isObject(to) && to.people === 'event:person' && Object.keys(to).length === 1)))
    || (event === 'conversation-opened' && isObject(to) && to.people === 'event:person' && Object.keys(to).length === 1);
  return fits ? [] : [`${at}.to names the one person ${event} names: ${event === 'assistant-joined' ? 'subject' : event === 'person-joined' ? 'joined or { people: event:person }' : '{ people: event:person }'}`];
}

/**
 * Why a welcome's prompt step is refused: a prompt template by name and read tools only. Where it sits in the graph is
 * checked with the whole workflow (`eventWorkflowErrors`).
 */
function promptStepErrors(prompt: unknown, at: string): string[] {
  if (!isObject(prompt)) return [`${at} is { template, tools }`];
  const errs: string[] = [];
  for (const key of Object.keys(prompt)) if (key !== 'template' && key !== 'tools') errs.push(`${at}.${key} is not a field of a prompt step; it is { template, tools }`);
  if (typeof prompt.template !== 'string' || !NAME.test(prompt.template)) errs.push(`${at}.template names a prompt template (lowercase letters, digits and hyphens)`);
  if (prompt.tools !== undefined) {
    if (!Array.isArray(prompt.tools) || prompt.tools.some((t) => typeof t !== 'string')) errs.push(`${at}.tools is a list of tool names`);
    else for (const t of prompt.tools as string[]) {
      if (!isKnownTool(t)) errs.push(`${at}.tools names "${t}", which is not a registered tool`);
      // A WELCOME READS AND SAYS; it never changes anything (ADR-061 decision 8, rule 5).
      else if (toolChangesState(t)) errs.push(`${at}.tools names "${t}", which changes state; a welcome may use read tools only`);
    }
  }
  return errs;
}

/** Every step an edge may go to, in order. */
export function edgeTargets(edge: unknown): string[] {
  if (typeof edge === 'string') return [edge];
  if (!Array.isArray(edge)) return [];
  return edge.flatMap((alt) => (isObject(alt) && typeof alt.to === 'string' ? [alt.to] : []));
}

/** Whether a step posts only to the person the event names: `joined` or `{ people: event:person }`. */
function addressesEventPerson(def: unknown): boolean {
  if (!isObject(def)) return false;
  const step = (isObject(def.send) ? def.send : isObject(def.agent) ? def.agent : undefined) as Record<string, unknown> | undefined;
  if (!step) return true;
  return step.to === 'joined' || (isObject(step.to) && step.to.people === 'event:person' && Object.keys(step.to).length === 1);
}

/** Who reads what a step posts: `room` for a room step, `addressed` for one to a person or for a step posting nothing. */
function stepAudience(def: unknown): 'room' | 'addressed' {
  if (!isObject(def)) return 'addressed';
  // The welcome's opening and its prompt turn are said to the room.
  if (def.opening !== undefined || def.prompt !== undefined) return 'room';
  // A task step says what it asks of a person to that person alone (ADR-063 decision 2).
  if (def.task !== undefined) return 'addressed';
  const step = (isObject(def.send) ? def.send : isObject(def.agent) ? def.agent : undefined) as Record<string, unknown> | undefined;
  return step ? audienceOfSend(step.to) : 'addressed';
}

/**
 * WHO A CONDITIONED EDGE'S CHOICE REACHES (ADR-060 decision 7): the condition decides which of its alternatives runs,
 * so when any of them posts to the room, the room learns which way it went and the condition selects a room message.
 */
export function edgeAudience(edge: unknown, states: Readonly<Record<string, unknown>>): 'room' | 'addressed' {
  return edgeTargets(edge).some((to) => stepAudience(states[to]) === 'room') ? 'room' : 'addressed';
}

/**
 * THE STEP AN EDGE TAKES (ADR-061 decision 2): a step name is taken as written; of a list, the first alternative whose
 * `when` holds, else the alternative that carries none. An unresolved value holds no condition, so a failed read takes
 * the unconditioned edge.
 */
export function chooseEdge(edge: EventEdge | undefined, holds: (when: When) => boolean): string | undefined {
  if (edge === undefined || typeof edge === 'string') return edge;
  for (const alt of edge) if (alt.when !== undefined && holds(alt.when)) return alt.to;
  return edge.find((alt) => alt.when === undefined)?.to;
}

/**
 * Why an edge is refused: a step name that names a declared step, or a non-empty list of `{ to, when }` whose every
 * `to` is a declared step, whose last alternative alone carries no `when`, and whose conditions pass `whenErrors` for
 * the audience the choice reaches (`edgeAudience`).
 */
function edgeErrors(edge: unknown, at: string, states: Readonly<Record<string, unknown>>, event: WorkflowEvent, opts: WorkflowValidation): string[] {
  if (typeof edge === 'string') return states[edge] ? [] : [`${at} names a declared step`];
  if (!Array.isArray(edge) || !edge.length) return [`${at} is a step name or a list of { to, when } alternatives`];
  const errs: string[] = [];
  const selects = edgeAudience(edge, states);
  edge.forEach((alt, i) => {
    const aat = `${at}[${i}]`;
    if (!isObject(alt)) { errs.push(`${aat} is { to, when }`); return; }
    for (const k of Object.keys(alt)) if (k !== 'to' && k !== 'when') errs.push(`${aat}.${k} is not an edge field; an alternative is { to, when }`);
    if (typeof alt.to !== 'string' || !states[alt.to]) errs.push(`${aat}.to names a declared step`);
    const last = i === edge.length - 1;
    if (last && alt.when !== undefined) errs.push(`${aat} is the last alternative, which carries no when, so a failed read still has an edge`);
    if (!last && alt.when === undefined) errs.push(`${aat} carries no when, so the alternatives after it are never taken`);
    if (alt.when !== undefined) {
      errs.push(...whenErrors(alt.when, opts.lookup ?? defaultLookup(), { event, selects }).map((e) => `${aat}.when: ${e}`));
    }
  });
  return errs;
}

/**
 * THE SOURCES A WORKFLOW'S CONDITIONS READ, NARROWED TO ITS TYPES: `participant:role` takes only the role names the
 * declared types declare, and `participantRole:<name>` exists only for a role every one of them declares addressable,
 * so a condition naming a role the types do not declare is refused when the workflow is stored. With no types, the
 * classification's table stands, naming every registered type's roles.
 */
export function rolesOfTypes(lookup: SourceLookup, types: readonly string[] | undefined): SourceLookup {
  if (!types?.length) return lookup;
  const names = [...new Set(types.flatMap((t) => Object.keys(CONVERSATION_TYPES[t]?.participants?.participantRoles ?? {})))].sort();
  return (name: string) => {
    const src = lookup(name);
    if (!src) return src;
    if (src.source === 'participant:role') return { ...src, values: Object.freeze(names) };
    const role = mentionedRole(src.source);
    if (role && !types.every((t) => isAudienceRole(participantRoleOf(t, role)))) return undefined;
    return src;
  };
}

/**
 * WHY A WORKFLOW IS REFUSED, or nothing. Every rule here is one ADR-061 states for what is built; a rule a later
 * slice relaxes is refused with that slice named.
 */
export function eventWorkflowErrors(name: string, wf: unknown, opts: WorkflowValidation = {}): string[] {
  const at = `eventWorkflows.${name}`;
  if (!isObject(wf)) return [`${at} must be a workflow`];
  if (!(EVENT_WORKFLOW_EVENTS as readonly unknown[]).includes(wf.on)) return [`${at}.on is one of ${EVENT_WORKFLOW_EVENTS.join(', ')}`];
  const event = wf.on as WorkflowEvent;
  const errs: string[] = [];
  const types = wf.types;
  if (types !== undefined && (!Array.isArray(types) || types.some((t) => typeof t !== 'string' || !CONVERSATION_TYPES[t as string]))) {
    errs.push(`${at}.types lists declared conversation types`);
  }
  if (event === 'conversation-opened') {
    if (!Array.isArray(types) || types.length === 0) errs.push(`${at} runs on conversation-opened, so it declares the types an event opens`);
    else for (const t of types as string[]) {
      if (CONVERSATION_TYPES[t] && !(CONVERSATION_TYPES[t].openedBy ?? []).length) errs.push(`${at}.types names ${t}, which no event opens (no openedBy)`);
    }
  }
  // A DEADLINE EVENT DECLARES ITS DEADLINE, and no other event does: the router times the schedule from it.
  if (isDeadlineEvent(event)) {
    const after = isObject(wf.deadline) ? wf.deadline.afterMinutes : undefined;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < MIN_DEADLINE_MINUTES || after > MAX_DEADLINE_MINUTES) {
      errs.push(`${at}.deadline.afterMinutes is a whole number of minutes from ${MIN_DEADLINE_MINUTES} to ${MAX_DEADLINE_MINUTES}, when ${event} fires after the thing it times started`);
    }
  } else if (wf.deadline !== undefined) {
    errs.push(`${at}.deadline is declared only on a deadline event (${DEADLINE_EVENTS.join(', ')})`);
  }
  const declaredTypes = Array.isArray(types) && types.every((t) => typeof t === 'string' && CONVERSATION_TYPES[t]) && types.length ? types as string[] : undefined;
  // A CONDITION ON A PARTICIPANT ROLE IS CHECKED AGAINST THE TYPES THE WORKFLOW RUNS IN (ADR-060, participant:role).
  opts = { ...opts, lookup: rolesOfTypes(opts.lookup ?? defaultLookup(), declaredTypes) };
  const states = isObject(wf.states) ? wf.states as Record<string, unknown> : {};
  if (!isObject(wf.states) || !Object.keys(states).length) return [...errs, `${at}.states declares its steps`];
  if (typeof wf.initial !== 'string' || !states[wf.initial]) errs.push(`${at}.initial names a declared step`);

  const agents = new Set<string>();
  for (const [key, raw] of Object.entries(states)) {
    const sat = `${at}.states.${key}`;
    if (!isObject(raw)) { errs.push(`${sat} must be a step`); continue; }
    const kinds = ['send', 'agent', 'action', 'opening', 'prompt', 'task', 'disposition'].filter((k) => raw[k] !== undefined);
    if (kinds.length !== 1) { errs.push(`${sat} is exactly one of a send, an agent step, an action, an opening, a prompt, a task, or a terminal disposition`); continue; }
    // A TASK STEP'S EDGES READ HOW ITS TASK ENDED (`task:state`, ADR-063 decision 1), and no other step's do.
    const taskMachine = raw.task !== undefined && isObject(raw.task) && typeof raw.task.machine === 'string'
      ? machinesAStepMayOpen(opts.machines)[raw.task.machine] : undefined;
    const edgeOpts: WorkflowValidation = taskMachine ? { ...opts, lookup: withTaskState(opts.lookup ?? defaultLookup(), taskMachine) } : opts;
    for (const edge of ['onSuccess', 'onFailure'] as const) {
      if (raw[edge] !== undefined) errs.push(...edgeErrors(raw[edge], `${sat}.${edge}`, states, event, edgeOpts));
    }
    if (raw.onDeadline !== undefined) {
      if (raw.task === undefined) errs.push(`${sat}.onDeadline is taken when a task step's deadline ends its task, so only a task step declares it`);
      else errs.push(...edgeErrors(raw.onDeadline, `${sat}.onDeadline`, states, event, edgeOpts));
    }
    if (raw.task !== undefined) {
      errs.push(...taskStepErrors(raw.task, `${sat}.task`, {
        ...(declaredTypes ? { types: declaredTypes } : {}),
        ...(opts.machines ? { machines: opts.machines } : {}),
        // A TASK IS FOR ONE PERSON AND WORKED BY ONE: the references an audience resolves to one person at this event.
        personErrors: (ref, rat) => (ref === 'room' ? [`${rat} names one person, never the room`] : audienceErrors(ref, rat, event, declaredTypes)),
      }));
    }
    // THE WELCOME'S OWN STEPS run on the event `WelcomeIntent` starts, and nowhere else.
    if ((raw.opening !== undefined || raw.prompt !== undefined) && event !== WELCOME_EVENT) {
      errs.push(`${sat} is ${raw.opening !== undefined ? 'an opening' : 'a prompt step'}, which only the welcome takes (on ${WELCOME_EVENT})`);
    }
    if (raw.opening !== undefined) errs.push(...openingStepErrors(raw.opening, `${sat}.opening`));
    if (raw.prompt !== undefined) {
      errs.push(...promptStepErrors(raw.prompt, `${sat}.prompt`));
      // NOTHING FOLLOWS A PROMPT TURN: it posts after the run has moved on, so a step after it would race it.
      for (const edge of ['onSuccess', 'onFailure'] as const) {
        for (const to of edgeTargets(raw[edge])) {
          if (isObject(states[to]) && (states[to] as Record<string, unknown>).disposition === undefined) errs.push(`${sat}.${edge} goes to ${to}; a prompt step's turn posts after the run has moved on, so it ends the run`);
        }
      }
    }
    if (raw.action !== undefined) errs.push(...actionErrors(raw.action, `${sat}.action`, event));
    if (raw.send !== undefined) errs.push(...sendErrors(raw.send, `${sat}.send`, event, opts, declaredTypes));
    if (raw.agent !== undefined) { agents.add(key); errs.push(...agentErrors(raw.agent, `${sat}.agent`, event, opts, declaredTypes)); }
    // A STEP'S CONDITION IS HELD TO EVERY RULE ADR-060 decision 3 states for a `when` (`whenErrors`): it selects the
    // step's own message, so a fact about a person may gate a step addressed to that person and never a room step.
    if (raw.when !== undefined) {
      if (raw.disposition !== undefined) errs.push(`${sat}.when is on a terminal step, which posts nothing to gate`);
      else errs.push(...whenErrors(raw.when, opts.lookup ?? defaultLookup(), { event, selects: stepAudience(raw) }).map((e) => `${sat}.when: ${e}`));
    }
    if (raw.disposition !== undefined && raw.disposition !== 'success' && raw.disposition !== 'failure') errs.push(`${sat}.disposition is success or failure`);
    // A FACT ABOUT THE PERSON AN EVENT NAMES selects only a message addressed to that person (ADR-060 decision 7): at
    // `person-joined` and an invitation's events the router reads it for them alone, so it never chooses what anyone else reads.
    if (event === 'person-joined' || isInvitationEvent(event)) {
      const lookup = opts.lookup ?? defaultLookup();
      const readsPerson = (w: unknown) => whenKeys(w as When).some((k) => (lookup(k)?.source ?? k).startsWith('person:'));
      if (raw.when !== undefined && readsPerson(raw.when) && !addressesEventPerson(raw)) {
        errs.push(`${sat}.when reads a fact about the person the event names, so the step is addressed to that person alone`);
      }
      for (const edge of ['onSuccess', 'onFailure'] as const) {
        const e = raw[edge];
        if (!Array.isArray(e) || !e.some((alt) => isObject(alt) && alt.when !== undefined && readsPerson(alt.when))) continue;
        if (!edgeTargets(e).every((to) => addressesEventPerson(states[to]) || !(isObject(states[to]) && ((states[to] as Record<string, unknown>).send || (states[to] as Record<string, unknown>).agent)))) {
          errs.push(`${sat}.${edge} chooses on a fact about the person the event names, so each step it may take is addressed to that person alone`);
        }
      }
    }
  }
  // A ROOM IS OPENED ONCE: one opening step in a welcome.
  const openings = Object.entries(states).filter(([, raw]) => isObject(raw) && raw.opening !== undefined).map(([k]) => k);
  if (openings.length > 1) errs.push(`${at} has ${openings.length} opening steps (${openings.join(', ')}); a welcome opens the room once`);
  // THE OPENING OPENS THE ROOM, so it is the welcome's first step: said before anything else, and by the join that ran it.
  else if (openings.length === 1 && openings[0] !== wf.initial) errs.push(`${at}.states.${openings[0]} is an opening, which opens the room, so it is the welcome's first step (initial)`);
  if (errs.length) return errs;

  // THE OPENING IS A PLATFORM SEND ON AN ARRIVAL EVENT (decision 8, rule 1), so no model call stands before the first
  // message its arrivals read. An invitation's events are events nobody is waiting on, and may open with an agent step.
  const opening = isArrival(event) ? states[wf.initial as string] as EventStepDef | undefined : undefined;
  // THE ONE EXCEPTION (rule 1): at `person-joined` a join recap may come first. It is written for the person who joined
  // alone and posts nothing to the room, so no room message waits on it.
  const recapFirst = event === 'person-joined' && isJoinRecapStep(opening);
  if (opening && opening.send === undefined && opening.opening === undefined && !recapFirst) {
    errs.push(`${at}.initial must be a send or an opening: the first message on an arrival event waits on no model`);
  } else if (opening?.send && (opts.template ?? shippedTemplate)(opening.send.template)?.fill === 'voice') {
    // A `voice` template is a model call where no variant is written (ADR-062 decision 4), so it is never the opening.
    errs.push(`${at}.initial sends ${opening.send.template}, which is fill: voice; the first message on an arrival event waits on no model`);
  }
  // ACYCLIC, so a run is bounded by its steps.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (s: string): boolean => {
    if (done.has(s)) return false;
    if (visiting.has(s)) return true;
    visiting.add(s);
    const def = states[s] as EventStepDef;
    const hit = [...edgeTargets(def.onSuccess), ...edgeTargets(def.onFailure), ...edgeTargets(def.onDeadline)].some((n) => cyclic(n));
    visiting.delete(s);
    done.add(s);
    return hit;
  };
  if (cyclic(wf.initial as string)) errs.push(`${at} has a cycle; an event workflow is acyclic`);
  return errs;
}

/**
 * WHICH ASSISTANT TAKES AN AGENT STEP (`as`, ADR-061 decision 1, "Whose workflow runs"): the run's own assistant where the
 * step names no role or that assistant holds it; else a live assistant of the classification that holds the role and is
 * a member of the room now, which takes the step as itself; else nobody, and the step is not dispatched. `assistant` is
 * the handle of the assistant that takes it, set only when that is not the run's own.
 */
export function assistantForStep(
  def: Pick<AgentStep, 'as'>,
  args: { self: { botArn: string; role?: string }; live: ReadonlyArray<{ botArn: string; role: string; handle: string }>; botsInRoom: readonly string[] },
): { botArn: string; assistant?: string } | undefined {
  const role = def.as?.role;
  if (!role || args.self.role === role) return { botArn: args.self.botArn };
  const inRoom = new Set(args.botsInRoom);
  const holder = args.live.find((a) => a.role === role && a.botArn !== args.self.botArn && inRoom.has(a.botArn));
  return holder ? { botArn: holder.botArn, assistant: holder.handle } : undefined;
}

/**
 * WHETHER THE ASSISTANT A STEP WAS HANDED TO MAY TAKE IT (tenet D1): a step naming `as` only by an assistant holding that
 * role, and a step another assistant's version declares (`owner`) only when it names a role. Anything else runs nothing.
 */
export function stepTakenBy(def: Pick<AgentStep, 'as'>, taker: { owner?: string; role?: string }): boolean {
  if (def.as) return !!taker.role && taker.role === def.as.role;
  return !taker.owner;
}

/** The claim key of one run (ADR-061 decision 5): `<event>#<natural key>#<assistant>`. */
export function eventRunKey(event: WorkflowEvent, naturalKey: string, assistant: string): string {
  return `${event}#${naturalKey}#${assistant}`;
}

/** The conversation's id, the natural key of `assistant-joined` and `conversation-opened`. */
export function conversationKey(channelArn: string): string {
  return channelArn.split('/channel/')[1] ?? channelArn;
}

/** An invitation's id as a natural key carries it: the id its record names, never its token. */
export const INVITATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * AN EVENT'S NATURAL KEY (decision 5): the conversation; for `person-joined` the conversation and the person, so each
 * person added is a run of their own and a redelivered add starts no second one; for an invitation's events the
 * invitation, so a redelivered naming or a schedule that fires twice starts no second run and two invitations are two runs;
 * for `alarm-state-changed` the alarm and the time it entered its state, so a redelivered change starts no second run
 * and each state the alarm enters is a run of its own. Undefined for a `person-joined` that
 * names no person, an `invitation-sent` that names no invitation, or an alarm change that names no alarm, which runs nothing.
 */
export function eventNaturalKey(event: WorkflowEvent, channelArn: string, eventPerson?: string, invitationId?: string, alarm?: Pick<AlarmChange, 'name' | 'changedAt'>): string | undefined {
  if (isInvitationEvent(event)) return invitationId && INVITATION_ID.test(invitationId) ? `invitation-${invitationId}` : undefined;
  if (event === 'alarm-state-changed') {
    return alarm && ALARM_NAME.test(alarm.name) && Number.isInteger(alarm.changedAt) && alarm.changedAt > 0
      ? `alarm-${alarm.changedAt}-${alarm.name}` : undefined;
  }
  if (event !== 'person-joined') return conversationKey(channelArn);
  const person = personIdFromArn(eventPerson) ?? undefined;
  return person ? `${conversationKey(channelArn)}#${person}` : undefined;
}

/** The alarm an `alarm-state-changed` run is for: its name, the state it entered, and when, as CloudWatch reports them. */
export interface AlarmChange {
  name: string;
  state: AlarmState;
  /** Epoch milliseconds of the state's update, read from CloudWatch: one run per state the alarm entered. */
  changedAt: number;
}

/** A display name as an inert mention (decision 6), the one the variable resolver renders (`message-markers.ts`). */
export { inertMention };

/** What a run knows about its event: the people it names, and the conversation's fields. */
export interface EventRunContext {
  event: WorkflowEvent;
  channelArn: string;
  /** The person `conversation-opened` or `person-joined` names, or the invitee `invitation-sent` names, as an AppInstanceUser ARN. */
  eventPerson?: string;
  /** An invitation's events only: the invitation's id, and the member who issued it, both read from its record. */
  invitationId?: string;
  inviter?: string;
  /** The participant shape's subject, as an AppInstanceUser ARN; empty in a group conversation. */
  subject?: string;
  /**
   * Each participant role's holders who are members now, as AppInstanceUser ARNs (`holdersByRole`), read from the
   * channel-context row by the router when the workflow names a role. Absent, every role addresses nobody.
   */
  roles?: Readonly<Record<string, readonly string[]>>;
  /** Whether a role's holding may be said in a room message here (`roleSaidInRoom`). Absent, every role may. */
  roleSaidInRoom?: (role: string) => boolean;
  /** The conversation's type, whose role declaration order decides what a person's roles confer (`fromRole`). */
  conversationType?: string;
  /**
   * The holdings a run's conditions may read: `roles` less every holding a creating application asserted (the `host`
   * source), which is member trust and never decides (ADR-060 decision 2). Absent, `roles`.
   */
  decidingRoles?: Readonly<Record<string, readonly string[]>>;
  /** `alarm-state-changed` only: the alarm and the state it entered, as the router read them back from CloudWatch. */
  alarm?: AlarmChange;
  /** The conversation's fields a template may name. */
  values: Record<string, string>;
  /** What the run's conditions read (ADR-060 decision 6). Absent, no condition holds and every edge is unconditioned. */
  gate?: EventGate;
}

/**
 * WHAT A RUN'S CONDITIONS READ: the classification's sources and the version's variables, the values the router holds
 * at this event by source, and what its call site has settled. Nothing is read on demand: a value the router does not
 * hold is unresolved, and a condition on it does not hold.
 */
export interface EventGate {
  lookup: SourceLookup;
  variables?: Readonly<Record<string, VersionVariable>>;
  values: Readonly<Record<string, VariableValue | undefined>>;
  callSite: CallSiteCapabilities;
}

/** Whether a condition holds for a run, for the readers its choice reaches (`room` or `addressed`). */
export function gateHolds(ctx: Pick<EventRunContext, 'gate'>, when: When, audience: 'room' | 'addressed'): boolean {
  const g = ctx.gate;
  if (!g) return false;
  return whenHolds(when, { lookup: g.lookup, ...(g.variables ? { variables: g.variables } : {}), values: g.values, site: { callSite: g.callSite, audience } });
}

/** Every condition a workflow declares: each step's own and each edge alternative's. */
export function workflowConditions(wf: EventWorkflow): When[] {
  const out: When[] = [];
  for (const def of Object.values(wf.states)) {
    if (def.when !== undefined) out.push(def.when);
    for (const edge of [def.onSuccess, def.onFailure, def.onDeadline]) {
      if (Array.isArray(edge)) for (const alt of edge) if (alt.when !== undefined) out.push(alt.when);
    }
  }
  return out;
}

/**
 * THE LOOKUP A TASK STEP'S EDGES READ (ADR-063 decision 1): the workflow's own, with `task:state` an enum of the machine's
 * terminal states. Every other step reads the workflow's lookup, where the `task` kind is not built.
 */
export function withTaskState(lookup: SourceLookup, machine: TaskStateMachine): SourceLookup {
  const src = taskStateSource(machine);
  return (name: string) => (name === TASK_STATE_SOURCE ? src : lookup(name));
}

/**
 * The sources a workflow's conditions read, each version variable named through its source: what a call site reads
 * before a run, so a value no condition names is never read.
 */
export function conditionSources(wf: EventWorkflow, variables?: Readonly<Record<string, VersionVariable>>): Set<string> {
  const keys = workflowConditions(wf).flatMap((w) => whenKeys(w));
  return new Set(keys.map((k) => (variables && Object.prototype.hasOwnProperty.call(variables, k) ? variables[k].source : k)));
}

/** The step an outcome edge takes in this run, with each alternative's condition read for whom the choice reaches. */
export function nextStep(wf: EventWorkflow, edge: EventEdge | undefined, ctx: Pick<EventRunContext, 'gate'>): string | undefined {
  const audience = edgeAudience(edge, wf.states as Record<string, unknown>);
  return chooseEdge(edge, (when) => gateHolds(ctx, when, audience));
}

/** One step's move, as the run's messages carry it to the archive. */
export interface EventTransition { step: string; outcome: string }

/** `gated`: the step's own `when` did not hold, so it posted nothing and the run took its `onSuccess`. */
export type StepOutcome = 'posted' | 'skipped' | 'gated' | 'failed' | 'dispatched' | 'not-dispatched' | 'no-role-assistant' | 'already-claimed' | 'opened' | 'no-worker';

export interface EventRunDeps {
  /** The run's exactly-once claim. False when this run already started. */
  claimRun: () => Promise<boolean>;
  /** One step's claim, with the outcome it records. False when the step already ran. */
  claimStep: (step: string, outcome: string) => Promise<boolean>;
  /** A person's display name, or empty when they are not a member (the line naming them then drops). */
  mentionName: (personArn: string, source: MentionSource) => Promise<string>;
  /**
   * The language a send's readers read (ADR-062 decision 4), as a tag: the one person's preferred language for a
   * targeted send, else the conversation's. A role's list of names is joined in it. Absent or unknown, the runtime's.
   */
  listLanguage?: (to: readonly string[]) => Promise<string | undefined>;
  /** Post a message template: to the room when `to` is empty, else targeted at each person. */
  /** `mentions` are the fields the step renders as inert mentions, which the template's insertions are checked against. */
  /** `fallback`: an agent step's fallback, which is said with no model call even where its template is `fill: voice` (ADR-062 decision 5). */
  send: (args: { template: string; values: Record<string, string>; to: string[]; step: string; transitions: EventTransition[]; mentions?: string[]; fallback?: boolean }) => Promise<boolean>;
  /**
   * Hand an agent step to the processor: true when it was handed over, false when it could not be, and `absent` when the
   * step names `as` and no assistant holding that role is in the room, so nothing was handed to anyone.
   */
  dispatchAgent: (step: string, def: AgentStep, values: Record<string, string>, transitions: EventTransition[]) => Promise<boolean | 'absent'>;
  /** Record that a run greeted a person by name, so their first turn does not greet them again. */
  greeted?: (personArn: string) => Promise<void>;
  /**
   * Offer the onboarding intake to one person (`start_intake`): `started` when its first question was asked and the
   * intake recorded, `skipped` when there is nothing to ask them, `failed` when it could not be recorded or asked.
   */
  startIntake?: (personArn: string, step: string, transitions: EventTransition[]) => Promise<'started' | 'skipped' | 'failed'>;
  /** Post the welcome's opening to the room (`opening`), composed as `WelcomeIntent` composes it. True when it posted. */
  opening?: (step: string, def: WelcomeOpeningStep, transitions: EventTransition[]) => Promise<boolean>;
  /** Dispatch the welcome's prompt turn (`prompt`). True when it was handed to the processor. */
  prompt?: (step: string, def: PromptWelcomeStep) => Promise<boolean>;
  /**
   * Open a task step's task (ADR-063 decision 1), once the step is claimed: `opened` when the task service wrote it and the
   * run now waits on it, `no-worker` when nobody the step names to do the work is here (no assistant holding the role,
   * no person the reference resolves to), `failed` when it could not be opened. Absent, a task step takes its failure edge.
   */
  openTask?: (step: string, def: TaskStep, transitions: EventTransition[]) => Promise<'opened' | 'no-worker' | 'failed'>;
  log?: (entry: Record<string, unknown>) => void;
}

/** The people an audience names, or `room`. An empty list is a send to nobody, which posts nothing. */
export function audienceOf(to: EventAudience, ctx: EventRunContext): 'room' | string[] {
  if (to === 'room') return 'room';
  if (to === 'subject') return ctx.subject ? [ctx.subject] : [];
  if (typeof to === 'object' && 'people' in to && to.people === 'invitation:inviter') return ctx.inviter ? [ctx.inviter] : [];
  // A ROLE'S HOLDERS WHO ARE MEMBERS NOW: a former holder who left is addressed by nothing and emailed nothing.
  const role = audienceRole(to);
  if (role) return [...(ctx.roles?.[role] ?? [])];
  if (typeof to === 'object' && 'participantRole' in to) return [];
  // `joined` and `{ people: event:person }` both name the event's person, whose membership the router verified.
  return ctx.eventPerson ? [ctx.eventPerson] : [];
}

/**
 * THE EMAIL A TARGETED SEND CARRIES (ADR-061 decision 3): at an event that adds a person to a conversation they did
 * not open themselves, a send addressed to people is emailed to them as a `conversation-shared` notice, the kind they
 * can mute, so a person a workflow welcomes is emailed as the `memberWelcome` notice it replaces emailed them.
 * `assistant-joined` emails nobody: its subject is usually the person who opened the conversation.
 *
 * `invitation-sent` EMAILS NOBODY, and the invitation email stays the invitations function's own. That email is
 * transactional: it carries the invitation's link, which is the credential, to the one address the inviter typed, and
 * neither is stored anywhere (K2, `invitations.ts`). A send's email goes through the notification bridge's directive,
 * which admits only the kinds a person can mute (`DIRECTIVE_NOTICE_KINDS`) and finds the address in the directory,
 * where an invitee has none. Admitting `invitation` there would make a transactional email mutable, and handing the
 * address and the link to the router would put an address and a credential into an event's payload, which carries ids
 * only. So the invitee receives one email, the invitation, and a workflow's sends at this event are read in the
 * conversation.
 */
export function workflowSendEmailKind(event: WorkflowEvent, to: readonly string[]): 'conversation-shared' | undefined {
  return to.length && isArrival(event) && namesAPerson(event) ? 'conversation-shared' : undefined;
}

/** The values a send renders: the conversation's fields, then each mention field as an inert display name. */
export async function sendValues(send: SendStep, ctx: EventRunContext, deps: Pick<EventRunDeps, 'mentionName' | 'listLanguage'>, to: readonly string[] = []): Promise<Record<string, string>> {
  const values = { ...ctx.values };
  let language: string | undefined | null = null;
  for (const [field, source] of Object.entries(send.mention ?? {})) {
    const role = mentionedRole(source);
    if (role) {
      // A ROLE'S HOLDERS, as a list of inert display names. In a room a guest or a link session reads, a holding is
      // said only when the role declares `visibleToGuests`; otherwise the field renders empty and its line drops.
      const said = send.to !== 'room' || !ctx.roleSaidInRoom || ctx.roleSaidInRoom(role);
      const names = said
        ? (await Promise.all((ctx.roles?.[role] ?? []).map((arn) => deps.mentionName(arn, source).catch(() => '')))).map((n) => inertMention(n)).filter(Boolean)
        : [];
      if (language === null) language = names.length > 1 && deps.listLanguage ? await deps.listLanguage(to).catch(() => undefined) : undefined;
      const list = holderList(names, language);
      if (list) values[field] = list;
      else delete values[field];
      continue;
    }
    const arn = mentionedPerson(source, ctx);
    const name = arn ? inertMention(await deps.mentionName(arn, source).catch(() => '')) : '';
    if (name) values[field] = name;
    else delete values[field];
  }
  return values;
}

/**
 * A ROLE'S HOLDERS AS ONE LINE: at most `MAX_MENTIONED_HOLDERS` names, joined by the runtime locale's list format
 * (`Intl.ListFormat`), and a count of the rest. Empty when nobody holds it.
 */
export function holderList(names: readonly string[], language?: string): string {
  if (!names.length) return '';
  const locale = (() => { try { return language ? Intl.getCanonicalLocales(language)[0] : undefined; } catch { return undefined; } })();
  const shown = names.slice(0, MAX_MENTIONED_HOLDERS);
  const rest = names.length - shown.length;
  const items = rest > 0 ? [...shown, new Intl.NumberFormat(locale, { signDisplay: 'always' }).format(rest)] : shown;
  return new Intl.ListFormat(locale, { style: 'short', type: 'unit' }).format(items);
}

/**
 * WHAT A PERSON'S PARTICIPANT ROLES CONFER (DESIGN-CONVERSATION-TYPES section 6.1): the `template` or `brief` of the first
 * role they hold, in the type's declaration order, that confers one. Undefined when none does, and the step's own is said.
 */
export function conferredBy(ctx: Pick<EventRunContext, 'roles' | 'conversationType'>, personArn: string | undefined, what: 'template' | 'brief'): string | undefined {
  if (!personArn || !ctx.roles) return undefined;
  for (const [role, decl] of Object.entries(participantRolesOf(ctx.conversationType))) {
    const named = decl.confers?.[what];
    if (named && (ctx.roles[role] ?? []).includes(personArn)) return named;
  }
  return undefined;
}

/** The people of a targeted send grouped by the template each is said: the one their role confers, else the step's. */
export function templatesForPeople(send: SendStep, ctx: Pick<EventRunContext, 'roles' | 'conversationType'>, people: readonly string[]): Array<{ template: string; to: string[] }> {
  if (send.fromRole !== 'template') return [{ template: send.template, to: [...people] }];
  const groups = new Map<string, string[]>();
  for (const p of people) {
    const t = conferredBy(ctx, p, 'template') ?? send.template;
    groups.set(t, [...(groups.get(t) ?? []), p]);
  }
  return [...groups.entries()].map(([template, to]) => ({ template, to }));
}

/**
 * THE WARNINGS A WORKFLOW WITH NO `types` EARNS (ADR-061 decision 1): each participant role it names, with the registered
 * types that do not declare it, where it will address nobody. Recorded at synthesis for the platform's workflows and
 * returned beside a version's validation; never a refusal, because such a workflow runs in every type.
 */
export function eventWorkflowRoleWarnings(name: string, wf: EventWorkflow, variables?: Readonly<Record<string, VersionVariable>>): string[] {
  if (wf.types?.length) return [];
  const out: string[] = [];
  for (const role of [...participantRoleReferences(wf, variables).roles].sort()) {
    const missing = Object.keys(CONVERSATION_TYPES).filter((t) => !isAudienceRole(participantRoleOf(t, role)));
    if (missing.length) out.push(`eventWorkflows.${name} names participant role ${role} and declares no types; in ${missing.join(', ')}, which do not declare it, it addresses nobody`);
  }
  return out;
}

/** The participant roles a workflow names: its audiences, its mentions and its conditions. */
export function participantRoleReferences(wf: EventWorkflow, variables?: Readonly<Record<string, VersionVariable>>): { roles: Set<string>; readsParticipantRole: boolean; fromRole: boolean } {
  const roles = new Set<string>();
  let fromRole = false;
  for (const def of Object.values(wf.states)) {
    if (def.send?.fromRole || def.agent?.fromRole || def.agent?.fallback?.send?.fromRole) fromRole = true;
    // A TASK FOR, OR WORKED BY, A ROLE'S ONE HOLDER (ADR-063 decision 1) reads the role's holdings as an audience does.
    for (const ref of [def.task?.for, def.task?.by]) { const r = audienceRole(ref); if (r) roles.add(r); }
    for (const send of [def.send, def.agent?.fallback?.send]) {
      if (!send) continue;
      const r = audienceRole(send.to);
      if (r) roles.add(r);
      for (const source of Object.values(send.mention ?? {})) { const m = mentionedRole(source); if (m) roles.add(m); }
    }
  }
  const sources = conditionSources(wf, variables);
  for (const src of sources) { const m = mentionedRole(src); if (m) roles.add(m); }
  return { roles, readsParticipantRole: sources.has('participant:role'), fromRole };
}

/** The claim that hands a run on past one agent step, exactly once, whoever completes the step. */
export const continuationClaim = (step: string) => `after#${step}`;

/** Whether a send reaches anyone: the room, or at least one person. */
function hasAudience(send: SendStep, ctx: EventRunContext): boolean {
  const audience = audienceOf(send.to, ctx);
  return audience === 'room' || audience.length > 0;
}

/**
 * SAY AN AGENT STEP'S FALLBACK FROM THE ROUTER, with no model call, for a step no turn completed: nobody holding its role
 * is in the room, the dispatch failed, or the processor refused the turn. The caller holds the claim that says it once.
 */
async function sayAgentFallback(at: string, fallback: SendStep, ctx: EventRunContext, deps: EventRunDeps, transitions: EventTransition[]): Promise<void> {
  const audience = audienceOf(fallback.to, ctx);
  if (audience !== 'room' && !audience.length) return;
  const to = audience === 'room' ? [] : audience;
  const values = await sendValues(fallback, ctx, deps, to);
  for (const group of to.length ? templatesForPeople(fallback, ctx, to) : [{ template: fallback.template, to }]) {
    await deps.send({ template: group.template, values, to: group.to, step: at, transitions: [...transitions], mentions: Object.keys(fallback.mention ?? {}), fallback: true });
  }
}

/**
 * RUN A WORKFLOW'S PLATFORM STEPS, in order, until it ends or reaches an agent step, which is handed to the
 * processor. Claimed once per run and once per step, so a redelivered event greets nobody twice. Started at the
 * workflow's initial step, or, to continue a run past a completed agent step, at that step's edge (`resume`), when
 * the caller has already won the step's continuation claim. Never throws.
 *
 * THE TRANSITIONS REACH THE ARCHIVE ON THE MESSAGES THE RUN POSTS (ADR-061 rule 11), the path a task's transitions
 * take (`taskTransition` on a turn's Metadata): each send carries the run's key and its moves so far, so the run is
 * read back from the archive after its record expires.
 */
export async function runEventWorkflow(
  name: string,
  wf: EventWorkflow,
  ctx: EventRunContext,
  deps: EventRunDeps,
  resume?: { from: string | undefined; transitions?: EventTransition[] },
): Promise<{ ran: boolean; steps: Array<{ step: string; outcome: StepOutcome }>; ended?: 'success' | 'failure' }> {
  const steps: Array<{ step: string; outcome: StepOutcome }> = [];
  const transitions: EventTransition[] = [...(resume?.transitions ?? [])];
  const log = deps.log ?? (() => undefined);
  if (!resume && !(await deps.claimRun().catch(() => false))) {
    log({ workflow: name, event: ctx.event, outcome: 'run-already-claimed' });
    return { ran: false, steps };
  }
  const record = (step: string, outcome: StepOutcome) => { steps.push({ step, outcome }); transitions.push({ step, outcome }); };
  let at: string | undefined = resume ? resume.from : wf.initial;
  // One step more than a version may declare: the join recap a `person-joined` workflow is given (`withJoinRecap`).
  for (let n = 0; at && n <= MAX_EVENT_RUN_STEPS; n++) {
    const def: EventStepDef | undefined = wf.states[at];
    if (!def) break;
    if (def.disposition) {
      // The run's end is claimed too, so a continuation that arrives for a finished run finds nothing to do.
      await deps.claimStep('end', def.disposition).catch(() => false);
      log({ workflow: name, event: ctx.event, step: at, outcome: `end:${def.disposition}` });
      return { ran: true, steps, ended: def.disposition };
    }
    let ok = false;
    try {
      if (def.when !== undefined && !gateHolds(ctx, def.when, stepAudience(def))) {
        // THE STEP'S OWN CONDITION DOES NOT HOLD: it posts nothing, claims nothing, and the run goes on as a send to
        // nobody does. Logged by step, never by the value that decided it.
        record(at, 'gated');
        ok = true;
      } else if (def.send) {
        const audience = audienceOf(def.send.to, ctx);
        if (audience !== 'room' && audience.length === 0) {
          record(at, 'skipped');
          ok = true;
        } else if (audience !== 'room' && audienceRole(def.send.to) && audience.length > PARTICIPANT_ROLE_AUDIENCE_CAP) {
          // A ROLE WITH MORE HOLDERS THAN THE CAP SENDS NOTHING and takes the failure edge (ADR-061 decision 3).
          record(at, 'failed');
          log({ workflow: name, event: ctx.event, step: at, outcome: 'audience-over-cap', holders: audience.length });
          ok = false;
        } else if (!(await deps.claimStep(at, 'posted'))) {
          record(at, 'already-claimed');
          ok = true;
        } else {
          const to = audience === 'room' ? [] : audience;
          const values = await sendValues(def.send, ctx, deps, to);
          ok = true;
          for (const group of to.length ? templatesForPeople(def.send, ctx, to) : [{ template: def.send.template, to }]) {
            const posted = await deps.send({ template: group.template, values, to: group.to, step: at, transitions: [...transitions, { step: at, outcome: 'posted' }], mentions: Object.keys(def.send.mention ?? {}) });
            ok = ok && posted;
          }
          record(at, ok ? 'posted' : 'failed');
          // A GREETING BY NAME IS RECORDED ON ARRIVAL ONLY: naming an invitee or an inviter in the room greets neither.
          if (ok && deps.greeted && isArrival(ctx.event)) {
            for (const [field, source] of Object.entries(def.send.mention ?? {})) {
              // A role's mention names each of its holders, so each is greeted by name when the line rendered.
              const role = mentionedRole(source);
              const named = role ? (values[field] ? [...(ctx.roles?.[role] ?? [])] : []) : [mentionedPerson(source, ctx)];
              for (const arn of named) if (arn && values[field]) await deps.greeted(arn).catch(() => undefined);
            }
          }
        }
      } else if (def.opening || def.prompt) {
        // THE WELCOME'S OPENING AND ITS PROMPT TURN, each claimed before it is said, so a redelivered event says neither twice.
        const say = def.opening ? deps.opening : deps.prompt;
        if (!say) {
          record(at, 'skipped');
          ok = true;
        } else if (!(await deps.claimStep(at, def.opening ? 'posted' : 'dispatched'))) {
          record(at, 'already-claimed');
          ok = true;
        } else if (def.opening) {
          ok = await deps.opening!(at, def.opening, [...transitions, { step: at, outcome: 'posted' }]);
          record(at, ok ? 'posted' : 'failed');
        } else {
          ok = await deps.prompt!(at, def.prompt!);
          record(at, ok ? 'dispatched' : 'not-dispatched');
        }
      } else if (def.action) {
        // THE INTAKE, OFFERED ONCE: claimed before it is asked, so a redelivered event asks nobody twice. A person with
        // nothing to be asked takes the success edge, as a send to nobody does.
        const person = (() => { const a = audienceOf(def.action.to, ctx); return a === 'room' ? undefined : a[0]; })();
        if (!person || !deps.startIntake) {
          record(at, 'skipped');
          ok = true;
        } else if (!(await deps.claimStep(at, 'posted'))) {
          record(at, 'already-claimed');
          ok = true;
        } else {
          const out = await deps.startIntake(person, at, [...transitions, { step: at, outcome: 'posted' }]);
          record(at, out === 'started' ? 'posted' : out);
          ok = out !== 'failed';
        }
      } else if (def.task) {
        // A TASK STEP OPENS ITS TASK ONCE AND THE RUN WAITS ON IT (ADR-063 decision 3): claimed before it is opened, so a
        // redelivered event opens nothing twice and, finding the step claimed, waits as the first run does.
        if (!deps.openTask) {
          record(at, 'not-dispatched');
          ok = false;
        } else if (!(await deps.claimStep(at, TASK_STEP_OUTCOMES.opened))) {
          record(at, 'already-claimed');
          break;
        } else {
          const opened = await deps.openTask(at, def.task, [...transitions, { step: at, outcome: TASK_STEP_OUTCOMES.opened }]);
          record(at, opened === 'opened' ? 'opened' : opened);
          if (opened === 'opened') break;
          // Nothing was opened, so nothing will settle: the run goes on now, on the step's failure edge, under the
          // continuation claim the settlement would have taken.
          if (!(await deps.claimStep(continuationClaim(at), opened).catch(() => false))) break;
          ok = false;
        }
      } else if (def.agent) {
        // THE PROCESSOR COMPLETES IT: one conditional write on the step's claim decides between the turn's output
        // and the fallback, and the processor then names the continuation back to this router (`continueAfter`).
        const dispatched = await deps.dispatchAgent(at, def.agent, ctx.values, [...transitions]);
        // NOBODY HOLDING THE STEP'S ROLE IS IN THE ROOM: no turn runs, so nothing the step names is called, and the room
        // is told so in the step's `absent` message.
        const absent = dispatched === 'absent';
        const missed: StepOutcome = absent ? 'no-role-assistant' : 'not-dispatched';
        record(at, dispatched === true ? 'dispatched' : missed);
        if (dispatched === true) break;
        // A turn that could not be asked for still leaves the person something: the step's fallback, claimed, and
        // the run continues on its failure edge here, under the same continuation claim the processor would take.
        const fallback: SendStep = (absent && def.agent.fallback.absent) || def.agent.fallback.send;
        if (hasAudience(fallback, ctx) && await deps.claimStep(at, `fallback:${missed}`)) await sayAgentFallback(at, fallback, ctx, deps, transitions);
        if (!(await deps.claimStep(continuationClaim(at), missed).catch(() => false))) break;
        ok = false;
      }
    } catch (err) {
      record(at, 'failed');
      log({ workflow: name, event: ctx.event, step: at, outcome: 'failed', err: (err as Error)?.name });
    }
    const edge = ok ? def.onSuccess : def.onFailure;
    const next = nextStep(wf, edge, ctx);
    log({ workflow: name, event: ctx.event, step: at, outcome: steps[steps.length - 1]?.outcome, ...(Array.isArray(edge) ? { edge: next ?? null } : {}) });
    at = next;
  }
  return { ran: true, steps };
}

/**
 * CONTINUE A RUN PAST AN AGENT STEP THE PROCESSOR COMPLETED (ADR-061 decision 5). The continuation is claimed once
 * per step, so a redelivered hand-back, or one for a run that already went on, runs nothing. The edge is the step's
 * `onSuccess` when its output posted, else its `onFailure`, as the runtime always chooses.
 */
export async function continueAfter(
  name: string,
  wf: EventWorkflow,
  ctx: EventRunContext,
  after: { step: string; outcome: string; transitions?: EventTransition[] },
  deps: EventRunDeps,
  /** A task step's machines, the version's merged over the platform's, for its edges' `task:state`. */
  machines?: Readonly<Record<string, TaskStateMachine>>,
): Promise<{ ran: boolean; steps: Array<{ step: string; outcome: StepOutcome }>; ended?: 'success' | 'failure' }> {
  const def = wf.states[after.step];
  if (!def?.agent && !def?.task) return { ran: false, steps: [] };
  if (!(await deps.claimStep(continuationClaim(after.step), after.outcome).catch(() => false))) {
    deps.log?.({ workflow: name, event: ctx.event, step: after.step, outcome: 'continuation-already-claimed' });
    return { ran: false, steps: [] };
  }
  if (def.task) {
    // A TASK STEP GOES ON BY HOW ITS TASK ENDED (ADR-063 decision 3): success, its deadline, or any other ending. Its edges
    // read the terminal state as `task:state`, and no other step's do.
    const ended = taskOutcomeOf(after.outcome);
    const machine = machinesAStepMayOpen(machines)[def.task.machine];
    const taskCtx: EventRunContext = machine && ended.state && ctx.gate
      ? { ...ctx, gate: { ...ctx.gate, lookup: withTaskState(ctx.gate.lookup, machine), values: { ...ctx.gate.values, [TASK_STATE_SOURCE]: ended.state } } }
      : ctx;
    const edge = ended.edge === 'success' ? def.onSuccess : ended.edge === 'deadline' ? (def.onDeadline ?? def.onFailure) : def.onFailure;
    return runEventWorkflow(name, wf, ctx, deps, {
      from: nextStep(wf, edge, taskCtx),
      transitions: [...(after.transitions ?? []), { step: after.step, outcome: after.outcome }],
    });
  }
  if (!def.agent) return { ran: false, steps: [] };
  // A recap with nothing before the person joined to read (`skipped`) delivered what it owed, as a send to nobody does.
  const delivered = agentStepDelivered(def, after.outcome);
  const transitions = [...(after.transitions ?? []), { step: after.step, outcome: after.outcome }];
  // A STEP THAT ENDED WITH NOTHING SAID (a turn the processor refused, or one that posted neither its output nor its
  // fallback) says its fallback here, once, under the continuation claim just won, as a step nobody could take does.
  if (!delivered && !after.outcome.startsWith('fallback:')) {
    deps.log?.({ workflow: name, event: ctx.event, step: after.step, outcome: after.outcome, fallback: 'router' });
    await sayAgentFallback(after.step, def.agent.fallback.send, ctx, deps, transitions).catch((err) => {
      deps.log?.({ workflow: name, event: ctx.event, step: after.step, outcome: 'fallback-failed', err: (err as Error)?.name });
    });
  }
  return runEventWorkflow(name, wf, ctx, deps, {
    from: nextStep(wf, delivered ? def.onSuccess : def.onFailure, ctx),
    transitions,
  });
}

/**
 * A VERSION DECLARES ITS OWN EVENT WORKFLOWS (ADR-061 decision 1, as built): `eventWorkflows`, by name, in the same
 * format and under the same rules as the platform's, which stay as defaults a version selects or copies. Task
 * machines stay global and select-only (ADR-047); an event workflow is the assistant's own greeting and follow-up,
 * so it rides the version, is hashed into its `configId`, travels with its export and is served by an experiment
 * arm like any other behavior.
 */
export const MAX_VERSION_EVENT_WORKFLOWS = 8;
export const MAX_EVENT_WORKFLOW_STEPS = 16;
export const MAX_VERSION_EVENT_WORKFLOWS_BYTES = 32_000;

/** Why a version's `eventWorkflows` is refused as written, or nothing. */
export function versionEventWorkflowsErrors(raw: unknown, opts: WorkflowValidation = {}): string[] {
  if (raw === undefined || raw === null) return [];
  if (!isObject(raw)) return ['eventWorkflows maps a workflow name to an event workflow'];
  const names = Object.keys(raw);
  const errs: string[] = [];
  if (names.length > MAX_VERSION_EVENT_WORKFLOWS) errs.push(`eventWorkflows holds at most ${MAX_VERSION_EVENT_WORKFLOWS} workflows`);
  // ONE WORKFLOW ON AN EVENT THAT SELECTS ITS OWN (decision 1, "one workflow per event per version"): no welcome names
  // it, so the event selects it, and two would leave the choice to the order of a map.
  for (const event of EVENTS_SELECTING_THEIR_WORKFLOW) {
    const on = names.filter((n) => isObject(raw[n]) && (raw[n] as Record<string, unknown>).on === event);
    if (on.length > 1) errs.push(`eventWorkflows declares ${on.length} workflows on ${event} (${on.join(', ')}); a version declares at most one`);
  }
  // ONE WELCOME PER KIND OF ROOM, and one workflow per type an event opens (W1): the room's conversation type selects
  // among them (`welcomeWorkflowOf`, `openedWorkflowOf`), so two that could both answer for one type are refused, and so
  // are two welcomes that name no type.
  for (const event of TYPE_SELECTED_EVENTS) {
    const on = names.filter((n) => isObject(raw[n]) && (raw[n] as Record<string, unknown>).on === event);
    const untyped = on.filter((n) => !Array.isArray((raw[n] as Record<string, unknown>).types) || !((raw[n] as { types: unknown[] }).types.length));
    if (untyped.length > 1) errs.push(`eventWorkflows declares ${untyped.length} workflows on ${event} that name no type (${untyped.join(', ')}); at most one answers for every other kind of room`);
    const byType = new Map<string, string>();
    for (const n of on) {
      const types = (raw[n] as { types?: unknown }).types;
      for (const t of Array.isArray(types) ? types : []) {
        if (typeof t !== 'string') continue;
        const other = byType.get(t);
        if (other) errs.push(`eventWorkflows.${n} and eventWorkflows.${other} both run on ${event} in ${t} conversations; one workflow answers for a type`);
        else byType.set(t, n);
      }
    }
  }
  if (JSON.stringify(raw).length > MAX_VERSION_EVENT_WORKFLOWS_BYTES) errs.push(`eventWorkflows is at most ${MAX_VERSION_EVENT_WORKFLOWS_BYTES} characters`);
  for (const name of names) {
    if (!NAME.test(name)) { errs.push(`eventWorkflows.${name} is not a workflow name (lowercase letters, digits and hyphens)`); continue; }
    const wf = raw[name];
    if (isObject(wf) && isObject(wf.states) && Object.keys(wf.states).length > MAX_EVENT_WORKFLOW_STEPS) {
      errs.push(`eventWorkflows.${name} has at most ${MAX_EVENT_WORKFLOW_STEPS} steps`);
    }
    // THE RECAP'S NAMES ARE THE PLATFORM'S: `join-recap` is the default `person-joined` runs, and the steps `withJoinRecap`
    // adds carry their prefix, so a version's own names never stand in for either.
    if (name === 'join-recap' && isObject(wf) && wf.on !== 'person-joined') errs.push('eventWorkflows.join-recap names the platform\'s person-joined default, so it runs on person-joined');
    if (isObject(wf) && isObject(wf.states)) {
      for (const key of Object.keys(wf.states)) if (key.startsWith(JOIN_RECAP_STEP_PREFIX)) errs.push(`eventWorkflows.${name}.states.${key}: a step name starting ${JOIN_RECAP_STEP_PREFIX} is the join recap's`);
    }
    errs.push(...eventWorkflowErrors(name, wf, opts));
  }
  return errs;
}

/**
 * The workflow a name selects for a version: its own of that name first, then the platform's. A version's own
 * `person-joined` workflow is the one it runs (`withJoinRecap`), so the router and the processor read the same steps.
 */
export function workflowFor(own: Record<string, EventWorkflow> | null | undefined, name: string | undefined): EventWorkflow | undefined {
  if (!name) return undefined;
  if (own && Object.prototype.hasOwnProperty.call(own, name)) return own[name]?.on === 'person-joined' ? withJoinRecap(own[name]) : own[name];
  return eventWorkflowNamed(name);
}

/** The prefix of the recap step `withJoinRecap` adds before each terminal step, which no version step may take. */
export const JOIN_RECAP_STEP_PREFIX = 'join-recap--';

/**
 * A `person-joined` WORKFLOW NEVER COSTS A JOINER THE RECAP (decision 5). A version's workflow that has no join recap of
 * its own runs the platform's after its own steps: each edge into a terminal step goes first to the recap, which then
 * ends the run as that step would have. Its sends still come first, so the room's message waits on no model (rule 1).
 * A workflow that writes its own recap (`isJoinRecapStep`) runs as written.
 */
export function withJoinRecap(wf: EventWorkflow): EventWorkflow {
  if (wf.on !== 'person-joined' || Object.values(wf.states).some((d) => isJoinRecapStep(d))) return wf;
  const recap = PLATFORM_EVENT_WORKFLOWS['join-recap'].states.recap.agent!;
  const terminals = Object.entries(wf.states).filter(([, d]) => d.disposition).map(([k]) => k);
  if (!terminals.length) return wf;
  const via = (to: string) => (terminals.includes(to) ? `${JOIN_RECAP_STEP_PREFIX}${to}` : to);
  const route = (edge: EventEdge | undefined): EventEdge | undefined => (edge === undefined ? edge
    : typeof edge === 'string' ? via(edge) : edge.map((alt) => ({ ...alt, to: via(alt.to) })));
  const states: Record<string, EventStepDef> = {};
  for (const [key, def] of Object.entries(wf.states)) {
    states[key] = def.disposition ? def : {
      ...def,
      ...(def.onSuccess !== undefined ? { onSuccess: route(def.onSuccess) } : {}),
      ...(def.onFailure !== undefined ? { onFailure: route(def.onFailure) } : {}),
      ...(def.onDeadline !== undefined ? { onDeadline: route(def.onDeadline) } : {}),
    };
  }
  for (const t of terminals) states[via(t)] = { agent: recap, onSuccess: t, onFailure: t };
  return { ...wf, initial: via(wf.initial), states };
}

/**
 * WHO `person-joined` MAY RUN FOR (decision 1, "verified on arrival"): of the people a source named, those the live
 * roster holds as people. A person the roster does not hold, or holds as an assistant, starts no run.
 */
export function verifiedJoiners(named: readonly string[], roster: ReadonlyArray<{ arn: string; isBot?: boolean }>): string[] {
  const people = new Set(roster.filter((m) => !m.isBot).map((m) => m.arn));
  return [...new Set(named)].filter((p) => p.includes('/user/') && people.has(p));
}

/**
 * THE WORKFLOW AN EVENT THAT SELECTS ITS OWN RUNS for a version (`person-joined`, `invitation-sent`): the one its own
 * `eventWorkflows` declares on that event, or none. The platform ships none.
 */
export function declaredWorkflowOn(
  own: Record<string, EventWorkflow> | null | undefined,
  event: WorkflowEvent,
): { name: string; workflow: EventWorkflow } | undefined {
  if (!EVENTS_SELECTING_THEIR_WORKFLOW.includes(event)) return undefined;
  const found = Object.entries(own ?? {}).find(([, wf]) => wf?.on === event);
  return found ? { name: found[0], workflow: found[1] } : undefined;
}

/**
 * WHO WELCOMES THE PEOPLE A CONVERSATION WAS OPENED FOR (ADR-061 decision 5, one welcome per person per arrival).
 *
 * A room is opened once and each person in it is welcomed once. The room's opening (the structured opening, a `prompt`
 * welcome's turn, a workflow's room sends) is said to the room, addressed to nobody and emailed to nobody; a person's
 * welcome is the one message addressed to them, with its email. So the question per conversation is which run owns
 * the personal welcome of the people it was opened for, and the answer is read from configuration alone, never from
 * which of two concurrent paths finished first:
 *
 *  - `conversation-opened`: the welcome is a workflow on that event. Its run greets the room and the lead, the join
 *    (`WelcomeIntent`) posts nothing and starts no intake, and the creator names the lead in no `person-joined`.
 *  - `person-joined`: the conversation's type is one an event opens (`openedBy`), so its creator names every person it
 *    admits in `person-joined`, and the version declares a `person-joined` workflow for the type. That run owns every
 *    admitted person's welcome, the participant shape's subject included, so the join greets the room only: a
 *    structured or `prompt` opening is said as always, an `assistant-joined` workflow runs with no subject (its
 *    `subject` steps resolve to nobody, as in a group), and no intake starts, because an intake addresses the subject
 *    and would be a second welcome. An intake never stands in place of the room's opening and never in front of a
 *    question (SPEC-WELCOME-AND-CONTEXT); in such a room the `person-joined` workflow offers it, as a `start_intake`
 *    step addressed to the person who joined, where its author put one.
 *  - undefined: the join owns the room's opening and, where it applies, the subject's intake or `subject` greeting;
 *    each source welcomes the people it adds as before.
 */
export type ArrivalWelcomeOwner = 'conversation-opened' | 'person-joined';

export function arrivalWelcomeOwner(args: {
  conversationType?: string;
  own?: Record<string, EventWorkflow> | null;
}): ArrivalWelcomeOwner | undefined {
  if (openedWorkflowOf(args.own, args.conversationType)) return 'conversation-opened';
  const type = args.conversationType;
  if (!type || !(CONVERSATION_TYPES[type]?.openedBy ?? []).length) return undefined;
  const joined = declaredWorkflowOn(args.own, 'person-joined');
  if (!joined) return undefined;
  return !joined.workflow.types?.length || joined.workflow.types.includes(type) ? 'person-joined' : undefined;
}

/**
 * THE WORKFLOW `person-joined` RUNS for a version (decision 5): its own, with the join recap after its steps where it
 * writes none (`withJoinRecap`), else the platform's `join-recap`. `declared` says whether the version declared one,
 * which alone owns the person's welcome: the platform's recap catches them up and welcomes nobody, so the source that
 * added them still sends its `memberWelcome`.
 */
export function personJoinedWorkflowOf(own: Record<string, EventWorkflow> | null | undefined): { name: string; workflow: EventWorkflow; declared: boolean } {
  const declared = declaredWorkflowOn(own, 'person-joined');
  if (declared) return { name: declared.name, workflow: withJoinRecap(declared.workflow), declared: true };
  return { name: 'join-recap', workflow: PLATFORM_EVENT_WORKFLOWS['join-recap'], declared: false };
}

/**
 * THE WELCOME `WelcomeIntent` STARTS in a room (W1): of the version's `assistant-joined` workflows, the one whose `types`
 * name the room's conversation type, else the one that names no type, else the platform's `welcome`. `declared` says
 * whether the version declared it.
 */
export function welcomeWorkflowOf(
  own: Record<string, EventWorkflow> | null | undefined,
  conversationType: string | undefined,
): { name: string; workflow: EventWorkflow; declared: boolean } {
  const on = Object.entries(own ?? {}).filter(([, wf]) => wf?.on === WELCOME_EVENT);
  const typed = conversationType ? on.find(([, wf]) => (wf.types ?? []).includes(conversationType)) : undefined;
  const chosen = typed ?? on.find(([, wf]) => !wf.types?.length);
  if (chosen) return { name: chosen[0], workflow: chosen[1], declared: true };
  return { name: 'welcome', workflow: PLATFORM_EVENT_WORKFLOWS.welcome, declared: false };
}

/**
 * THE WORKFLOW A ROOM AN EVENT OPENS RUNS (`conversation-opened`, W1): the version's whose `types` name the room's type,
 * which must be one an event opens. None, and the room is opened by its welcome as any other room is.
 */
export function openedWorkflowOf(
  own: Record<string, EventWorkflow> | null | undefined,
  conversationType: string | undefined,
): { name: string; workflow: EventWorkflow } | undefined {
  if (!conversationType || !(CONVERSATION_TYPES[conversationType]?.openedBy ?? []).length) return undefined;
  const found = Object.entries(own ?? {}).find(([, wf]) => wf?.on === 'conversation-opened' && (wf.types ?? []).includes(conversationType));
  return found ? { name: found[0], workflow: found[1] } : undefined;
}

/**
 * HOW A WELCOME IS SAID (W1). A welcome whose first step is its opening, followed by nothing but a prompt turn, is said
 * where `WelcomeIntent` answers: the opening is the intent's own reply (with the intake question after it, or the
 * answer to a drift-spawned room's question), and the prompt turn is dispatched behind it. Any other welcome RUNS: its
 * steps are posted by the router, the opening first, and the intent posts nothing. `opening` is the welcome's template
 * step, its first step where it has one, which also opens a drift-spawned room.
 */
export interface WelcomePlan {
  opening?: WelcomeOpeningStep;
  prompt?: PromptWelcomeStep;
  /** True when the router runs the welcome's steps; false when the intent's reply says it. */
  runs: boolean;
}

export function welcomePlan(wf: EventWorkflow): WelcomePlan {
  const opening = Object.values(wf.states).find((d) => d.opening)?.opening;
  const first = wf.states[wf.initial];
  const endsAt = (edge: EventEdge | undefined): string | undefined => (typeof edge === 'string' ? edge : undefined);
  const terminal = (name: string | undefined) => !name || !!wf.states[name]?.disposition;
  if (!first?.opening || first.when !== undefined) return { ...(opening ? { opening } : {}), runs: true };
  const next = [endsAt(first.onSuccess), endsAt(first.onFailure)];
  if ([first.onSuccess, first.onFailure].some((e) => e !== undefined && typeof e !== 'string')) return { opening, runs: true };
  if (next.every(terminal)) return { opening: first.opening, runs: false };
  // AN OPENING AND ONE PROMPT TURN: today's prompt welcome. Its success edge is the prompt step, and the prompt ends the run.
  const promptAt = next.find((n) => !terminal(n));
  const promptDef = promptAt ? wf.states[promptAt] : undefined;
  const onlyPrompt = next.every((n) => terminal(n) || n === promptAt);
  const promptEnds = !!promptDef && [promptDef.onSuccess, promptDef.onFailure].every((e) => e === undefined || (typeof e === 'string' && terminal(e)));
  if (promptDef?.prompt && promptDef.when === undefined && onlyPrompt && promptEnds) {
    return { opening: first.opening, prompt: promptDef.prompt, runs: false };
  }
  return { opening: first.opening, runs: true };
}

/** Every template a workflow names, with the kind its step needs. */
export function templatesNamedBy(wf: EventWorkflow): Array<{ name: string; kind: 'message' | 'prompt'; at: string }> {
  const out: Array<{ name: string; kind: 'message' | 'prompt'; at: string }> = [];
  for (const [key, def] of Object.entries(wf.states)) {
    if (def.send) out.push({ name: def.send.template, kind: 'message', at: `${key}.send.template` });
    if (def.prompt) out.push({ name: def.prompt.template, kind: 'prompt', at: `${key}.prompt.template` });
    // A template a role confers is said in its place, so it must exist too, in each type the workflow declares.
    for (const [send, at] of [[def.send, `${key}.send`], [def.agent?.fallback.send, `${key}.agent.fallback.send`]] as const) {
      if (send?.fromRole !== 'template') continue;
      for (const t of wf.types ?? []) for (const [role, decl] of Object.entries(participantRolesOf(t))) {
        if (decl.confers?.template) out.push({ name: decl.confers.template, kind: 'message', at: `${at}.fromRole (${t} ${role})` });
      }
    }
    if (def.agent?.fromRole === 'brief') {
      for (const t of wf.types ?? []) for (const [role, decl] of Object.entries(participantRolesOf(t))) {
        if (decl.confers?.brief) out.push({ name: decl.confers.brief, kind: 'prompt', at: `${key}.agent.fromRole (${t} ${role})` });
      }
    }
    if (def.agent) {
      out.push({ name: def.agent.prompt, kind: 'prompt', at: `${key}.agent.prompt` });
      out.push({ name: def.agent.fallback.send.template, kind: 'message', at: `${key}.agent.fallback.send.template` });
      if (def.agent.fallback.absent) out.push({ name: def.agent.fallback.absent.template, kind: 'message', at: `${key}.agent.fallback.absent.template` });
    }
  }
  return out;
}
