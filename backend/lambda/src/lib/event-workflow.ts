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
import { eventUnreachableReason, isLeafType, membershipSourceFor, opensWithARun, relationOf, CONVERSATION_TYPES } from '../../../lib/config/conversation-types.js';
import {
  PARTICIPANT_ROLE_AUDIENCE_CAP, PARTICIPANT_ROLE_NAME, isAudienceRole, participantRoleOf, participantRolesOf, sourceKindOf, typeIsMixedTrust,
} from '../../../lib/config/participant-roles.js';
import { toolListErrors } from './step-fields.js';
import { inertMention } from './message-markers.js';
import {
  buildSourceTable, insertionErrors, sourceLookup, whenErrors, whenHolds, whenKeys,
  type SourceLookup, type VariableValue, type VersionVariable, type When,
} from './variables.js';
import type { CallSiteCapabilities } from './context-source-shapes.js';
import { shippedMessageTemplates } from './shipped-message-templates.js';
import type { ParsedTemplate } from './document-template.js';
import { openingStepErrors, type WelcomeOpeningStep } from './welcome-orientation.js';
import { MIN_RING_SECONDS, MAX_RING_SECONDS } from './meeting-ring.js';
import {
  TASK_OUTCOME_SOURCE, TASK_STATE_SOURCE, TASK_STEP_ALONGSIDE, TASK_STEP_FAILURES, TASK_STEP_OUTCOMES, type TaskStepFailure, machinesAStepMayOpen, taskFailureOf, taskOutcomeOf, taskOutcomeSource, taskStateSource, taskStepErrors, workerAssistantRole, type TaskStep,
} from './task-step.js';
import { TASK_VALUE_SOURCE_PREFIX, machineRecords, taskSourceLookup, typedRunValue, type TaskStateMachine } from './task-state-machines.js';

export const EVENT_WORKFLOW_EVENTS = ['assistant-joined', 'conversation-opened', 'person-joined', 'invitation-sent', 'invitation-unredeemed', 'alarm-state-changed', 'task-reopened', 'event-received', 'subject-changed', 'meeting-started', 'meeting-ended'] as const;
/** A conversation's meeting started, or ended (the `meetings` capability), raised once per meeting by the router. */
export const MEETING_EVENTS: readonly WorkflowEvent[] = ['meeting-started', 'meeting-ended'];
export const isMeetingEvent = (event: WorkflowEvent): boolean => MEETING_EVENTS.includes(event);
/**
 * WHAT STARTS A RUN: one of the events a version declares a workflow on, or `intent`, a person's request through the intent
 * the classifier labeled it with (ADR-067 decision 1). `intent` is never declared in `eventWorkflows` (its `on` is one of
 * `EVENT_WORKFLOW_EVENTS`): an intent's workflow lives in `intentWorkflows`, keyed by the intent, and runs on this trigger.
 */
export const INTENT_TRIGGER = 'intent' as const;
export type WorkflowEvent = typeof EVENT_WORKFLOW_EVENTS[number] | typeof INTENT_TRIGGER;

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
/** The key of a watched key's item (DESIGN-EVENT-TARGETS section 3): per classification, so one cannot read or evict another's. */
export const refWatchKey = (classification: string, kind: string, id: string): string => `watch#ref#${classification}#${kind}#${id}`;

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
export const EVENTS_NAMING_A_PERSON: readonly WorkflowEvent[] = ['conversation-opened', 'person-joined', 'invitation-sent', 'invitation-unredeemed', 'task-reopened', 'subject-changed'];
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
export const EVENTS_SELECTING_THEIR_WORKFLOW: readonly WorkflowEvent[] = ['person-joined', 'invitation-sent', 'invitation-unredeemed', 'alarm-state-changed', 'task-reopened', 'meeting-started', 'meeting-ended'];

/**
 * A TASK THAT REOPENS (ADR-067 decision 2, WT104): a finished task taken back into one of its `reopens` states. The steps a
 * request's workflow ran after the task's first ending do not run again; a team that wants something to happen on each
 * reopen (approve the revision again, tell the room) declares a workflow on this event. Its person (`event:person`) is the
 * task's requester, and the run takes the task's visibility (WT111): a private task's run reaches no one but them.
 */
export const TASK_REOPENED: WorkflowEvent = 'task-reopened';

/**
 * THE EVENTS WHOSE WORKFLOW THE ROOM'S CONVERSATION TYPE SELECTS (W1): the welcome on `assistant-joined`, the room an
 * event opens on `conversation-opened`, and a subject change on `subject-changed` (WT88). A version may declare one per type, and on `assistant-joined` one that names
 * no type, which answers for every other room.
 */
export const TYPE_SELECTED_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'conversation-opened', 'subject-changed'];

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
export const INTAKE_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'conversation-opened', 'person-joined'];

/**
 * A MEETING AS A STEP (the `meetings` capability): `start_meeting` starts the conversation's Amazon Chime SDK meeting, or
 * finds the one running, with no model call. Then:
 *  - EVERY MEMBER WITH THE APP OPEN HEARS A RING, for `ringSeconds` (absent, the deployment's `meetingRingSeconds`, 10 unless
 *    set): a control message, delivered to connected members only and never stored, which their app rings for and
 *    stops ringing for on its own once the time is up.
 *  - THE ROOM IS TOLD, in the message template `notice` names (absent, the shipped `meeting-started`), and with `email`
 *    each member is emailed it, its button opening the meeting window, where they sign in to join.
 * The meeting's link is the run value `meeting_link`, so a following send names it too. A deployment without the
 * capability, or a conversation whose meeting cannot be started, takes the failure edge.
 */
export interface MeetingAction {
  tool: 'start_meeting';
  /** How long a connected member's app rings, in whole seconds, between {@link MIN_RING_SECONDS} and {@link MAX_RING_SECONDS}. */
  ringSeconds?: number;
  /** The message template the room is told in. */
  notice?: string;
  /** Email each member the notice, with a button into the meeting. */
  email?: boolean;
}
export { MIN_RING_SECONDS, MAX_RING_SECONDS };
/** The run value holding the started meeting's link, which a following send names. */
export const MEETING_LINK_VALUE = 'meeting_link';
/** The run value holding how long an ended meeting ran, in whole minutes, as the shipped `meeting-ended` template reads it. */
export const MEETING_DURATION_VALUE = 'duration_minutes';
/**
 * THE RUN VALUES A MEETING EVENT CARRIES, named as the shipped meeting templates read them, and the event field
 * (`event:meetingLink`, `event:meetingDuration`) each one is read through.
 */
export const MEETING_EVENT_VALUES: Readonly<Record<string, { value: string; field: string }>> = {
  'meeting-started': { value: MEETING_LINK_VALUE, field: 'event:meetingLink' },
  'meeting-ended': { value: MEETING_DURATION_VALUE, field: 'event:meetingDuration' },
};
/** The shipped template a meeting's room notice is said in, absent the step's own. */
export const MEETING_NOTICE_TEMPLATE = 'meeting-started';
/** The shipped template a person's start is announced in where the room watches an alarm: the incident it is about. */
export const MEETING_INCIDENT_TEMPLATE = 'meeting-started-incident';
/** Whether a step's action starts a meeting. */
export const isMeetingAction = (a: unknown): a is MeetingAction => isObject(a) && a.tool === 'start_meeting';
/** Whether a step starts a meeting, which rings, tells and can email the whole room. */
const startsMeeting = (def: unknown): boolean => isObject(def) && isMeetingAction(def.action);
/** The events a meeting step is refused at: a meeting that ended starts no other, which would end and start again. */
export const MEETING_STEP_REFUSED_EVENTS: readonly WorkflowEvent[] = ['meeting-ended'];
/** The platform machine a meeting is offered on before a meeting step, and the ending that starts the meeting. */
export const MEETING_OFFER_MACHINE = 'meeting_offer';
export const MEETING_OFFER_START = 'start';
/** Whether an offer's success edge goes on to a meeting step when the person asked chose to start it. */
function meetingOfferStartsMeeting(edge: unknown, states: Readonly<Record<string, unknown>>): boolean {
  const isStart = (v: unknown) => v === MEETING_OFFER_START || (isObject(v) && v.op === 'eq' && v.value === MEETING_OFFER_START);
  return Array.isArray(edge) && edge.some((alt) => isObject(alt) && isObject(alt.when)
    && isStart(alt.when['task:state']) && typeof alt.to === 'string' && startsMeeting(states[alt.to]));
}

/**
 * A STEP THAT OPENS A CHILD CONVERSATION (WT90, WT120): one conversation of a declared type, at the parent's classification,
 * its members the type's and its lead the one person `for` names. The step opens it proactively: a workflow that wants a
 * person's answer first puts a task in front of it, as drift puts its offer. The run waits and goes on with `conversation_link`,
 * so a following send tells the room where the child is, in the assistant's own words.
 */
export interface OpenStep {
  /** The declared conversation type the child is. */
  type: string;
  /**
   * The child's lead: its member and moderator, one person. A person this run names, or `{ typeRole }`, a group-sourced role
   * of the opened type with one holder (`on-call:ops`), whose holder the creator reads when it opens the room, for an event
   * that names nobody.
   */
  for: EventAudience | { typeRole: string };
  /**
   * MOVE: the subject a person's message changed leaves this room for a conversation of `type` (WT90), on `subject-changed`
   * only. The platform's drift creator opens it at this room's classification, with the triggering message's audience
   * (WT92), links it from here and leaves the moved exchange out of this room's context; where detection found a
   * conversation already about the subject, the sender is pointed there instead and nothing is opened. A child may drift
   * again: a `type` with drift off is how a workflow stops that.
   */
  mode?: 'move';
}
/** The events a step never opens a conversation at: each already runs in a room just opened, so one would open the next. */
export const OPEN_STEP_REFUSED_EVENTS: readonly WorkflowEvent[] = ['assistant-joined', 'conversation-opened'];
/** The run value holding the opened child's link, which a following send names. */
export const CHILD_LINK_VALUE = 'conversation_link';
/**
 * THE FACTS AN INCIDENT CARRIES TO EVERY CONVERSATION ITS RUNS OPEN (DESIGN-PROCESSES O28): when the event that started it
 * arrived (`since`, in UTC) and the AWS Region its resource names (`region`). Read from the event once, each kept only in its
 * own shape, and handed on by each `open` step, so customer messaging drafts its notices from what the incident knows.
 */
export const INCIDENT_FACT_VALUES = ['since', 'region'] as const;
export type IncidentFacts = Partial<Record<(typeof INCIDENT_FACT_VALUES)[number], string>>;
const SINCE_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;
const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** The incident facts an event names: its time, as minutes in UTC, and the Region of an ARN resource. */
export function incidentFactsOfEvent(at: string, resource: string): IncidentFacts {
  const t = Date.parse(at);
  const since = Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  const region = resource.startsWith('arn:') ? resource.split(':')[3] ?? '' : '';
  return incidentFactsOf({ since, region });
}

/** The incident facts in a set of values, each kept only where it has its shape, so nothing else rides as one. */
export function incidentFactsOf(values: Readonly<Record<string, unknown>> | undefined): IncidentFacts {
  const since = values?.since;
  const region = values?.region;
  return {
    ...(typeof since === 'string' && SINCE_SHAPE.test(since) ? { since } : {}),
    ...(typeof region === 'string' && REGION_SHAPE.test(region) ? { region } : {}),
  };
}
/**
 * WHETHER CUSTOMERS ARE IMPACTED, as a person confirmed it on a card (DESIGN-PROCESSES O27): the ending of a `customer_impact`
 * task, recorded as data and never read from what anyone wrote (D11). An `open` step carries the latest such ending of its
 * run to the opened conversation's run, which reads it as `event:customerImpact`.
 */
export const CUSTOMER_IMPACT_VALUES = ['impacted', 'not_impacted'] as const;
export type CustomerImpact = typeof CUSTOMER_IMPACT_VALUES[number];
export const isCustomerImpact = (v: unknown): v is CustomerImpact => (CUSTOMER_IMPACT_VALUES as readonly unknown[]).includes(v);
/** The machine whose ending says whether customers are impacted. */
export const CUSTOMER_IMPACT_MACHINE = 'customer_impact';
/**
 * The latest customer impact a `customer_impact` task of the run ended in, read from its transitions, or undefined. Only a step
 * of the run's own workflow whose task is that machine counts, so another machine's ending that shares a state name says nothing.
 */
export function customerImpactOf(
  transitions: readonly { step: string; outcome: string }[], wf: Pick<EventWorkflow, 'states'> | undefined,
): CustomerImpact | undefined {
  for (let i = transitions.length - 1; i >= 0; i -= 1) {
    if (wf?.states[transitions[i].step]?.task?.machine !== CUSTOMER_IMPACT_MACHINE) continue;
    const t = taskOutcomeOf(transitions[i].outcome);
    if (t.edge === 'success' && isCustomerImpact(t.state)) return t.state;
  }
  return undefined;
}

/** How `conversation-opened` says what opened the room: a workflow's `open` step, or an event an opener declared. */
export const OPENED_BY_VALUES = ['workflow', 'event'] as const;
/** How an open step ended, as the creator hands it back: `opened`, or anything else for the failure edge. */
export const OPEN_STEP_OPENED = 'opened';

/**
 * Who a send or an agent step's output is for (ADR-061 decision 3, the built subset). `joined` is the person
 * `person-joined` names, once the router has verified their membership. `{ people: 'invitation:inviter' }` is the member
 * who issued the invitation `invitation-sent` names, read from its record.
 */
/**
 * Who a step addresses. `requester` is the person whose request started an intent's run (ADR-067 G17, G18), read from the
 * task the run opened, and named only on an intent trigger.
 */
export type EventAudience = 'room' | 'subject' | 'joined' | 'requester' | { people: 'event:person' } | { people: 'invitation:inviter' } | { participantRole: string };
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
  /**
   * THE CONVERSATION THE STEP POSTS IN (DESIGN-PROCESSES O24): absent, the run's own; `opener`, the conversation that opened
   * this one, by the ARN this conversation's row records (its parent link), at the same classification. The assistant posts
   * there as itself, to the room, and Amazon Chime SDK membership decides: where it is not a member, the post is refused and
   * `refused` is the step's outcome. A step of a `conversation-opened` workflow only. `opened` (O33): the conversation this run's
   * own `open` step opened, by the link the step handed back, checked against the parent link that conversation's row records;
   * where the run opened none, nothing is said and `refused` is the outcome.
   */
  in?: typeof SEND_IN_VALUES[number];
}

/**
 * The conversations a send step may post in beside its run's own: the one that opened it (`opener`, O24), and the one its own
 * `open` step opened (`opened`, O33), by the link the open step handed back and the parent link that conversation's row records.
 */
export const SEND_IN_VALUES = ['opener', 'opened'] as const;

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
 *  - `add_to_meeting`: people added to the conversation's running meeting, to its own conversation alone, confirmed by
 *    the meeting's host or a moderator (`lib/meeting-invites.ts`). A request's turn proposes it through its tool
 *    (`propose_meeting_invites`), so no event's step does. What it drafts (each person's arrival brief) reaches people
 *    who are not reading the room.
 */
export const PROPOSAL_OPS = {
  send_nudge: { events: ['invitation-unredeemed'] as readonly WorkflowEvent[], addressee: { people: 'invitation:inviter' } as EventAudience, reachesOutside: true },
  open_conversation: { events: EVENT_WORKFLOW_EVENTS as readonly WorkflowEvent[], addressee: undefined, reachesOutside: false },
  add_to_meeting: { events: [] as readonly WorkflowEvent[], addressee: undefined, reachesOutside: true },
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

/** The longest a run's wait may hold it, in minutes: the longest a task step's deadline may (30 days). */
export const MAX_WAIT_MINUTES = 30 * 24 * 60;

/**
 * A RUN-LEVEL WAIT (ADR-067 decision 2, WT20): the run holds here for a time, on the classification's one-shot scheduler,
 * never a poll, then goes on `onSuccess`; `onFailure` where the wait could not be scheduled. Nobody's open work holds it.
 * A wait for an inbound event is the connectors pass.
 */
export interface WaitStep {
  /** How long the run holds here, in whole minutes. Absent where `until` or `child` names what it waits for. */
  minutes?: number;
  /** A TIME AN EARLIER TASK OF THE RUN RECORDED (`task:value:<need>`, recorded as `time`, WT20): the run holds until then. */
  until?: string;
  /**
   * THE CONVERSATION THIS RUN OPENED ENDS ITS OWN RUN (`ended`): the run holds until the `conversation-opened` run of the
   * conversation its `open` step opened has ended, which that run tells it through the parent link its conversation's row
   * records, then goes on `onSuccess`. The child's work is the child's own: this run holds no task of it.
   */
  child?: typeof WAIT_CHILD_VALUES[number];
  /**
   * THE TASKS THE RUN WENT ON ALONGSIDE HAVE SETTLED (`settled`, WT129): the run holds until each of its `continue: alongside`
   * tasks still open has settled, on the same held record its end holds on, then goes on `onSuccess` where each settled in a
   * success, else `onFailure`, whose conditions read how (`task:outcome`). A post-incident review follows a resolve this way,
   * once the investigation beside the work is complete.
   */
  alongside?: typeof WAIT_ALONGSIDE_VALUES[number];
  /**
   * SEVERAL PARTS THE RUN STARTED IN PARALLEL HAVE ENDED (`join`, SPEC-PROCESSES P14): all of them, or any one (`WaitJoin`). The only
   * key of its wait.
   */
  join?: WaitJoin;
}

/**
 * A JOIN (`wait: { join: { of, when, minutes? } }`): the run holds until the parts it names have ended, then goes on.
 *  - EACH PART IS A STEP OF THIS WORKFLOW that started something in parallel: an `open` step that opens a conversation (the
 *    part is that conversation's own run, which ends as `wait: { child }` reads it), or a task step that goes on alongside
 *    (`continue: 'alongside'`, which ends when its task settles, as `wait: { alongside }` reads it). Two to eight, each once.
 *  - `all` GOES ON ONCE EVERY PART THAT STARTED HAS ENDED; `any` at the first part to end. A part whose step the run never
 *    reached (an `open` behind a condition that did not hold) holds nothing, and the join records it as skipped.
 *  - ITS EDGE: `onSuccess` where every part counted ended in a success, else `onFailure`, whose conditions read why the first
 *    part that did not succeed ended (`task:outcome`), as the single waits read theirs. Past `minutes` (absent, the backstop a
 *    wait on an opened conversation has) it goes on `onDeadline`, else `onFailure`, with `task:outcome` `timed-out`.
 *  - IT IS WOKEN BY THE HAND-BACKS THE SINGLE WAITS USE (an opened conversation's run ending, an alongside task settling), each
 *    held on that part's own record and claimed once per part (`joinPartClaim`), and it goes on once (`continuationClaim`).
 *  - ITS OUTCOME NAMES EVERY PART AND HOW IT ENDED, and which part it waited on last (`joinOutcome`), so the run's end record,
 *    which carries its steps, tells the console what the join waited for.
 */
export interface WaitJoin {
  /** The steps whose parts it waits on, in the order a person reads them. */
  of: string[];
  when: typeof JOIN_WHEN_VALUES[number];
  /** The longest it holds, in whole minutes, before it goes on its deadline edge. */
  minutes?: number;
}
/** Whether a join waits on every part that started, or on the first to end. */
export const JOIN_WHEN_VALUES = ['all', 'any'] as const;
/** The fewest and the most parts a join names. */
export const MIN_JOIN_PARTS = 2;
export const MAX_JOIN_PARTS = 8;
/** A part's step name, as the join's outcome carries it: letters, digits, `-` and `_`. */
const JOIN_PART_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** What a part of a join is: an opened conversation's run, or a task the run went on alongside. */
export type JoinPartKind = 'open' | 'alongside';
/** Where a part stands: never started (`skipped`), still running (`open`), or how it ended. */
export type JoinPartState = 'skipped' | 'open' | ChildEnding;
/** The mark a join's hold adds to the continuation it leaves on a part's record, naming that part: `{ step: <part>, outcome }`. */
export const JOIN_PART = 'join-part';
/** The claim a join takes for one part's ending, once, with how that part ended. */
export const joinPartClaim = (step: string, part: string): string => `${continuationClaim(step)}#${part}`;
/** The run value holding the link one `open` step's conversation was handed back with, so a join finds each part's conversation. */
export const openedLinkValue = (step: string): string => `${CHILD_LINK_VALUE}#${step}`;
const JOINED = 'joined';

/** A join's parts by step, and which kind each is, as the workflow declares them. */
export function joinParts(wf: EventWorkflow, join: WaitJoin): Array<{ step: string; kind: JoinPartKind }> {
  return join.of.flatMap((step): Array<{ step: string; kind: JoinPartKind }> => {
    const def = wf.states[step];
    if (def?.open && def.open.mode !== 'move') return [{ step, kind: 'open' as const }];
    if (def?.task?.continue === TASK_STEP_ALONGSIDE) return [{ step, kind: 'alongside' as const }];
    return [];
  });
}

/** The steps any join of a workflow names as its parts. */
export function joinedSteps(wf: EventWorkflow): string[] {
  return Object.values(wf.states).flatMap((d) => d?.wait?.join?.of ?? []);
}

/** How one part ended, from the outcome its hand-back carried: an opened conversation's (`waited`, `waited:<why>`), or a task's. */
export function joinPartEnding(kind: JoinPartKind, outcome: string): ChildEnding {
  if (kind === 'open') return outcome === WAIT_CAME ? 'success' : childEndingOf(outcome) ?? 'failed';
  return runEnding('success', [outcome]);
}

/**
 * A JOIN'S OUTCOME: `joined:<edge>:<last>:<part>=<state>,...`, its edge (`success`, `failure` or `deadline`), the part it waited
 * on last (`-` for none), and every part with where it stood when the join went on.
 */
export function joinOutcome(edge: 'success' | 'failure' | 'deadline', last: string | undefined, parts: Readonly<Record<string, JoinPartState>>): string {
  return `${JOINED}:${edge}:${last ?? '-'}:${Object.entries(parts).map(([p, s]) => `${p}=${s}`).join(',')}`;
}

/** A join's outcome read back, or undefined for any other outcome. */
export function joinOutcomeOf(outcome: string): { edge: 'success' | 'failure' | 'deadline'; last?: string; parts: Record<string, JoinPartState> } | undefined {
  const m = /^joined:(success|failure|deadline):([A-Za-z0-9_-]{1,64}|-):(.*)$/.exec(outcome);
  if (!m) return undefined;
  const states: readonly string[] = ['skipped', 'open', 'success', ...TASK_STEP_FAILURES];
  const parts: Record<string, JoinPartState> = {};
  for (const pair of m[3] ? m[3].split(',') : []) {
    const [p, s] = pair.split('=');
    if (!p || !JOIN_PART_NAME.test(p) || !states.includes(s)) return undefined;
    parts[p] = s as JoinPartState;
  }
  return { edge: m[1] as 'success' | 'failure' | 'deadline', ...(m[2] !== '-' ? { last: m[2] } : {}), parts };
}

/**
 * WHETHER A JOIN GOES ON NOW, from where each part stands, and with what outcome; undefined while it still holds. `last` is the
 * part whose ending is being read, where one is; else the last part, in the order the join names them, that has ended.
 */
export function joinDecision(join: WaitJoin, parts: Readonly<Record<string, JoinPartState>>, last?: string): string | undefined {
  const counted = join.of.filter((p) => parts[p] !== undefined && parts[p] !== 'skipped');
  const ended = counted.filter((p) => parts[p] !== 'open');
  const met = join.when === 'all' ? ended.length === counted.length : ended.length > 0 || counted.length === 0;
  if (!met) return undefined;
  const waitedOn = last && ended.includes(last) ? last : ended[ended.length - 1];
  const ordered = Object.fromEntries(join.of.map((p) => [p, parts[p] ?? 'skipped'] as const));
  return joinOutcome(ended.every((p) => parts[p] === 'success') ? 'success' : 'failure', waitedOn, ordered);
}

/** Why a join did not go on as a success, in the `task:outcome` words: its deadline, or the first part that did not succeed. */
function joinFailureOf(outcome: string): TaskStepFailure | undefined {
  const read = joinOutcomeOf(outcome);
  if (!read || read.edge === 'success') return read ? undefined : 'failed';
  if (read.edge === 'deadline') return 'timed-out';
  const why = Object.values(read.parts).find((s) => s !== 'success' && s !== 'skipped' && s !== 'open');
  return (why as TaskStepFailure | undefined) ?? 'failed';
}

/** What a part stands at, from the run's claims: its step's claim, its open step's or task's continuation, and its join claim. */
export function joinPartStates(wf: EventWorkflow, step: string, join: WaitJoin, claims: Readonly<Record<string, string>>): Record<string, JoinPartState> {
  const out: Record<string, JoinPartState> = {};
  for (const { step: part, kind } of joinParts(wf, join)) {
    const ended = claims[joinPartClaim(step, part)];
    const started = claims[continuationClaim(part)];
    if (claims[part] === undefined) out[part] = 'skipped';
    else if (ended !== undefined) out[part] = joinPartEnding(kind, ended);
    // A PART THAT NEVER STARTED ITS WORK (the conversation could not be opened, nobody to do the task) ended as it failed.
    else if (started !== undefined && started !== OPEN_STEP_OPENED && started !== TASK_STEP_OUTCOMES.opened) out[part] = taskFailureOf(started) ?? 'failed';
    else out[part] = 'open';
  }
  return out;
}

/** The claims a join's parts are read from (`joinPartStates`). */
export function joinClaims(step: string, join: WaitJoin): string[] {
  return join.of.flatMap((part) => [part, continuationClaim(part), joinPartClaim(step, part)]);
}

/** What a wait on the opened conversation waits for: its own run's end. */
export const WAIT_CHILD_VALUES = ['ended'] as const;
/** What a wait on the tasks the run went on alongside waits for: their settlement. */
export const WAIT_ALONGSIDE_VALUES = ['settled'] as const;
/** The outcome a wait goes on with when what it waits for came: its time, or the opened conversation's run ending. */
export const WAIT_CAME = 'waited';

/**
 * HOW AN OPENED CONVERSATION'S RUN ENDED, as the wait of the run that opened it reads it: `success` where its run ended as it
 * declares and every task it went on alongside settled in a success, else why not, in the `task:outcome` words (its task's
 * deadline ended it, `timed-out`; it was cancelled or its conversation archived, `ended`; anything else, `failed`).
 */
export type ChildEnding = 'success' | TaskStepFailure;
const CHILD_ENDED = `${WAIT_CAME}:`;
/** The outcome the opener's wait goes on with: `waited` for a success, else `waited:<why>`, which takes its failure edge. */
export const childEndedOutcome = (ending: ChildEnding): string => (ending === 'success' ? WAIT_CAME : `${CHILD_ENDED}${ending}`);
/** Why an opened conversation's run ended without succeeding, from its opener's wait outcome; undefined for any other outcome. */
export function childEndingOf(outcome: string): TaskStepFailure | undefined {
  const why = outcome.startsWith(CHILD_ENDED) ? outcome.slice(CHILD_ENDED.length) : '';
  return (TASK_STEP_FAILURES as readonly string[]).includes(why) ? why as TaskStepFailure : undefined;
}
/**
 * HOW A RUN ENDED, by how each task it went on alongside settled (`runEnding`), except after a resolve that moved it on
 * (`movesTo`, DESIGN-PROCESSES O15): then the moving task's success alone decides it, so a task beside it that did not succeed
 * (an investigation cancelled or past its deadline) never turns a resolved run into one that ended unresolved, and the
 * conversation that opened it, told "resolved" at the resolve, hears nothing after it. `by` names each settled task's step.
 */
export function runEndingAfterMove(wf: EventWorkflow, disposition: 'success' | 'failure', settled: readonly string[], by: Readonly<Record<string, string>>): ChildEnding {
  const moved = Object.entries(by).some(([step, outcome]) => !!wf.states[step]?.task?.movesTo && taskOutcomeOf(outcome).edge === 'success');
  return runEnding(disposition, moved ? [] : settled);
}

/**
 * WHETHER A RESOLVE MOVED THE RUN ON (`movesTo`, O15): its transitions record the moving task's success followed by the step it
 * moves to, or its end was freed by that task's success.
 */
export function runMovedOn(wf: EventWorkflow, transitions: readonly EventTransition[], by: Readonly<Record<string, string>> = {}): boolean {
  const movesTo = (step: string) => wf.states[step]?.task?.movesTo;
  if (Object.entries(by).some(([step, outcome]) => !!movesTo(step) && taskOutcomeOf(outcome).edge === 'success')) return true;
  return transitions.some((t, i) => !!movesTo(t.step) && taskOutcomeOf(t.outcome).edge === 'success' && transitions[i + 1]?.step === movesTo(t.step));
}

/** How a run with tasks alongside it ended: the first of them that did not settle in a success says why, else its disposition. */
export function runEnding(disposition: 'success' | 'failure', alongsideOutcomes: readonly string[]): ChildEnding {
  for (const o of alongsideOutcomes) {
    const why = taskFailureOf(o) ?? (taskOutcomeOf(o).edge === 'success' ? undefined : 'failed');
    if (why) return why;
  }
  return disposition === 'success' ? 'success' : 'failed';
}

export interface EventStepDef {
  send?: SendStep;
  agent?: AgentStep;
  wait?: WaitStep;
  /**
   * THE WELCOME'S TEMPLATE STEP: the room's opening, rendered by the platform's composition (`composeOpening`) from the
   * orientation fields it carries, or from its own `text`, and with no field at all from the deployment's orientation.
   * Said with no model call, so it may open an arrival.
   */
  opening?: WelcomeOpeningStep;
  /** THE WELCOME'S PROMPT STEP: one model turn after the opening (`PromptWelcomeStep`). */
  prompt?: PromptWelcomeStep;
  /** A platform action the router runs with no model call: the intake (`start_intake`) or a meeting (`start_meeting`). */
  action?: IntakeAction | MeetingAction;
  /** A CHILD CONVERSATION THE STEP OPENS (WT120): the run waits for it, and goes on knowing the child's link (`OpenStep`). */
  open?: OpenStep;
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
  /**
   * WHAT THE STEP IS CALLED WHEN A PERSON IS TOLD WHERE THE RUN STANDS (`runStanding`): the steps still open when a task that
   * ends the run is settled mid-way, and a meeting's card in its own conversation. Absent, the step's name. A labeled step is
   * also a stage of its run in the console's process view (SPEC-PROCESSES P9), and a step with no label is an internal move
   * the view does not show.
   */
  label?: string;
  /**
   * WHAT THIS STAGE IS FOR, in the team's own words, beside its label in the console's process view (SPEC-PROCESSES P9). What
   * the step runs is read from its definition and shown beside it, so this says why, never how.
   */
  description?: string;
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
export const MAX_EVENT_RUN_STEPS = 32;

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * THE PLATFORM'S EVENT WORKFLOWS. `ops-room` is ADR-061's example (a), the ops room's first look; `opening-and-subject`
 * opens a room and greets the person it was opened for. Each step's words are shipped templates the assistant can
 * replace with its own (`shipped-message-templates.ts`).
 */
export const SHIPPED_EVENT_WORKFLOWS: Readonly<Record<string, EventWorkflow>> = {
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
      // A CONVERSATION A WORKFLOW OPENED (an incident) GIVES ITS LEAD THE INCIDENT'S TASK, which says what to do and when it
      // is done, so the lead is told once; one an event opened greets its lead here.
      opening: {
        send: { to: 'room', template: 'ops-room-opening', mention: { lead: 'participantRole:lead' } },
        onSuccess: [{ to: 'lead-task', when: { 'event:openedBy': 'workflow' } }, { to: 'greet-lead' }],
        onFailure: [{ to: 'lead-task', when: { 'event:openedBy': 'workflow' } }, { to: 'greet-lead' }],
      },
      'greet-lead': { send: { to: { participantRole: 'lead' }, template: 'ops-lead-welcome' }, onSuccess: 'first-look', onFailure: 'first-look' },
      // THE INCIDENT IS THE ON-CALL'S, HELD IN ITS OWN CONVERSATION until they resolve it there. The run goes on alongside it
      // with the first look, the call and the runbook, and does not end before it is resolved, so the run ends when the work
      // does and is measured so, and its end tells the conversation that opened this one (`incident-triage`'s `hold`). Its end
      // is the conversation's: thirty days, after which the conversation expires and the incident with it.
      'lead-task': {
        label: 'Incident owner', description: 'The on-call owns the incident from here until they resolve it.',
        task: {
          machine: 'incident_ownership', by: { participantRole: 'on-call:ops' }, continue: 'alongside',
          assigned: { template: 'incident-owner-task', withoutMeetings: 'incident-owner-task-no-call' }, deadline: { afterMinutes: 43_200 },
          // RESOLVING IT ENDS THE RUN (owner decision 2026-11-14): settled while the runbook has steps open, the on-call is asked
          // first, and once confirmed the run ends now as resolved, its open runbook tasks cancelled, and the team is told.
          endsRun: true, confirmEnd: 'confirming_resolve',
          // RESOLVING MOVES THE RUN ON (WT129, DESIGN-PROCESSES O15): the runbook's open tasks are cancelled, the investigation stays
          // open, and the run goes on to tell the room, then the post-incident review follows once the investigation is complete.
          movesTo: 'resolved',
        },
        onSuccess: 'investigation', onFailure: 'investigation',
      },
      // THE ROOT-CAUSE INVESTIGATION (WT129): one living task, open beside the work, where people and the assistant add
      // findings. Never required before resolve; the post-incident review waits on it (`investigation-complete`).
      investigation: {
        label: 'Root-cause investigation', description: 'Findings toward the root cause, gathered beside the work; the review waits for it.',
        task: { machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, continue: 'alongside', assigned: { template: 'incident-investigation' }, deadline: { afterMinutes: 43_200 } },
        onSuccess: [{ to: 'messaging-now', when: { 'event:customerImpact': 'impacted' } }, { to: 'first-look' }],
        onFailure: [{ to: 'messaging-now', when: { 'event:customerImpact': 'impacted' } }, { to: 'first-look' }],
      },
      // CUSTOMER MESSAGING STARTS AS SOON AS CUSTOMER IMPACT IS KNOWN (DESIGN-PROCESSES O26 to O28): triage said so on its card,
      // so the account team's conversation opens beside the incident now, led by the account team's lead. The run goes on once
      // the conversation stands (seconds); its run is its own, and its end tells this run nothing it holds for. Where it cannot
      // open, the room is told, so customer impact is never confirmed in silence.
      'messaging-now': {
        open: { type: 'customer-messaging', for: { typeRole: 'lead:accounts' } },
        onSuccess: 'tell-messaging-now', onFailure: 'tell-messaging-now-failed',
      },
      'tell-messaging-now': { send: { to: 'room', template: 'customer-messaging-opened' }, onSuccess: 'first-look', onFailure: 'first-look' },
      'tell-messaging-now-failed': { send: { to: 'room', template: 'customer-messaging-not-opened' }, onSuccess: 'first-look', onFailure: 'first-look' },
      // THE FIRST LOOK IS A REQUEST TO THE OPS ASSISTANT (WT118): `incident_first_look` is an intent it advertises, which its
      // own version runs, on its own session and its role's telemetry grant, and its declared move (`auto`) rests the task on
      // its findings. The run goes on once the work starts (`continue: opened`), so a resting first look never holds it.
      'first-look': {
        label: 'First look', description: "The ops assistant reads the deployment's health and posts what it sees.",
        task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened' },
        onSuccess: [{ to: 'dashboard', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }],
        // WHY IT FAILED DECIDES WHAT THE ROOM IS TOLD (G23): no ops assistant here, or a first look that could not open.
        onFailure: [{ to: 'tell-absent', when: { 'task:outcome': 'no-worker' } }, { to: 'tell-unavailable' }],
      },
      // ESCALATE (WT129): the shared dashboard is posted for everyone the incident brings in, by the ops assistant's declared action.
      dashboard: {
        label: 'Shared dashboard', description: 'One dashboard everyone brought into the incident reads from.',
        task: { machine: 'dashboard_refresh', by: { assistantRole: 'ops' }, continue: 'opened' },
        onSuccess: 'offer-call', onFailure: 'offer-call',
      },
      // AN INCIDENT SUGGESTS ITS CALL: the lead is offered the conversation's meeting once the investigation has started, and
      // starting it rings everyone in the conversation. Unanswered within ten minutes, the offer ends and the runbook goes on
      // without it. Where the deployment declares no meetings, the offer is skipped and the runbook goes on at once.
      'offer-call': {
        label: 'Incident call', description: 'The lead decides whether to start a call for the incident.',
        task: { machine: MEETING_OFFER_MACHINE, by: { participantRole: 'lead' }, assigned: { template: 'incident-call-offer' }, deadline: { afterMinutes: 10 } },
        onSuccess: [{ to: 'start-call', when: { 'task:state': MEETING_OFFER_START } }, { to: 'customer-impact' }],
        onFailure: 'customer-impact',
      },
      'start-call': { action: { tool: 'start_meeting', ringSeconds: 30, email: true }, onSuccess: 'customer-impact', onFailure: 'customer-impact' },
      // THE RUNBOOK, EACH STEP THE WORK OF THE ASSISTANT WHOSE GRANT IT NEEDS, AND EVERY DECISION THE ON-CALL'S. A reading is a
      // request to a role (WT118) naming an intent its assistant advertises, which that assistant's own version runs with its
      // own tools: the ops assistant reads the telemetry, the room's primary reads the customer record. A change is the
      // on-call's to decide and make on a card, so neither assistant holds a write. A room whose assistant advertises no such
      // step goes on without it.
      //
      // CUSTOMER IMPACT FIRST, once the call is running: the primary lists the accounts the incident reaches with their
      // account contacts, and offers a card that brings their account teams into the call. The request is for the lead
      // (`for`), the one person that card may be addressed to, so the lead confirms the add and the add is checked again then.
      'customer-impact': {
        label: 'Customer impact', description: 'The accounts this incident reaches, with their account contacts.',
        task: { machine: 'impacted_accounts', for: { participantRole: 'lead' }, by: { assistantRole: 'primary' }, ask: { template: 'customer-impact' } },
        onSuccess: [{ to: 'runbook-cause', when: { 'event:customerImpact': 'impacted' } }, { to: 'impact-confirm' }],
        onFailure: [{ to: 'runbook-cause', when: { 'event:customerImpact': 'impacted' } }, { to: 'impact-confirm' }],
      },
      // CUSTOMERS IMPACTED? ASKED OF THE LEAD where triage did not already say yes (O27), once the lookup has named the accounts.
      // A yes opens customer messaging beside the incident; a no, or no answer in ten minutes, and the runbook goes on.
      'impact-confirm': {
        label: 'Customers impacted?', description: 'The lead confirms whether customers are impacted, which starts customer messaging.',
        task: { machine: 'customer_impact', by: { participantRole: 'lead' }, assigned: { template: 'customer-impact-confirm' }, deadline: { afterMinutes: 10 } },
        onSuccess: [{ to: 'messaging', when: { 'task:state': 'impacted' } }, { to: 'runbook-cause' }],
        onFailure: 'runbook-cause',
      },
      messaging: {
        open: { type: 'customer-messaging', for: { typeRole: 'lead:accounts' } },
        onSuccess: 'tell-messaging', onFailure: 'tell-messaging-failed',
      },
      'tell-messaging': { send: { to: 'room', template: 'customer-messaging-opened' }, onSuccess: 'runbook-cause', onFailure: 'runbook-cause' },
      'tell-messaging-failed': { send: { to: 'room', template: 'customer-messaging-not-opened' }, onSuccess: 'runbook-cause', onFailure: 'runbook-cause' },
      'runbook-cause': {
        label: 'Cause and recommended action', description: 'The ops assistant names the likely cause and the change it recommends.',
        task: { machine: 'runbook_cause', by: { assistantRole: 'ops' }, ask: { template: 'runbook-cause' } },
        // NO RECOMMENDATION, NO DECISION CARD: a reading that was not made leaves nothing to approve, and the runbook goes on.
        onSuccess: 'runbook-decide', onFailure: 'runbook-verify',
      },
      // THE ON-CALL DECIDES the runbook's recommended change: approved, they make it and confirm; declined, the runbook goes on.
      'runbook-decide': {
        label: 'Mitigation decision', description: 'The on-call approves or declines the recommended change.',
        task: { machine: 'approval', by: { participantRole: 'lead' }, assigned: { template: 'runbook-decision' }, deadline: { afterMinutes: 30 } },
        onSuccess: [{ to: 'tell-messaging-mitigating', when: { 'task:state': 'approved' } }, { to: 'runbook-verify' }],
        onFailure: 'runbook-verify',
      },
      // CUSTOMER MESSAGING HEARS THE APPROVED MITIGATION (O28), a confirmed status its next update drafts from. Where no messaging
      // was opened, the send is refused and the runbook goes on either way.
      'tell-messaging-mitigating': { send: { to: 'room', in: 'opened', template: 'customer-messaging-mitigating' }, onSuccess: 'runbook-act', onFailure: 'runbook-act' },
      'runbook-act': {
        label: 'Mitigation change', description: 'The on-call makes the approved change and confirms it is done.',
        task: { machine: 'acknowledgement', by: { participantRole: 'lead' }, assigned: { template: 'runbook-act' }, deadline: { afterMinutes: 30 } },
        onSuccess: 'runbook-verify', onFailure: 'runbook-verify',
      },
      // THE RUNBOOK ENDS ON THE RECOVERY READING, and the run then waits on the lead's task, whose card says when to resolve it.
      'runbook-verify': {
        label: 'Recovery check', description: 'The ops assistant checks that the service recovered.',
        task: { machine: 'runbook_verify', by: { assistantRole: 'ops' }, ask: { template: 'runbook-verify' } },
        onSuccess: 'done', onFailure: 'done',
      },
      // A FIRST LOOK THAT COULD NOT BE MADE DOES NOT END AN INCIDENT: the room is told, and its call offer and runbook go on.
      'tell-absent': { send: { to: 'room', template: 'ops-assistant-absent' }, onSuccess: [{ to: 'offer-call', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }], onFailure: [{ to: 'offer-call', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }] },
      'tell-unavailable': { send: { to: 'room', template: 'ops-first-look-unavailable' }, onSuccess: [{ to: 'offer-call', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }], onFailure: [{ to: 'offer-call', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }] },
      // RESOLVED (WT129): the room is told, then the team conversation that opened this one, once, at the resolve itself (O24),
      // and the run waits on the investigation beside the work.
      resolved: { label: 'Resolve', description: 'The incident is resolved; its conversation is told.', send: { to: 'room', template: 'incident-resolved' }, onSuccess: 'tell-team', onFailure: 'tell-team' },
      // THE TEAM HEARS "RESOLVED" HERE, NOT AT THE RUN'S END: said in the conversation that opened this one, by its recorded
      // link, as the assistant itself, which is refused there unless it is a member. Either way the run goes on.
      'tell-team': { label: 'Team told', description: 'The team conversation that opened it hears it is resolved.', send: { to: 'room', in: 'opener', template: 'incident-resolved-team' }, onSuccess: 'tell-messaging-resolved', onFailure: 'tell-messaging-resolved' },
      // CUSTOMER MESSAGING HEARS "RESOLVED" HERE (O33): said in the conversation this run opened, by the link its open step handed
      // back, where the account team's lead asks for the final notice on their card. Where no messaging was opened, the send is
      // refused and the run goes on as it does either way.
      'tell-messaging-resolved': { send: { to: 'room', in: 'opened', template: 'customer-messaging-resolved' }, onSuccess: 'investigation-complete', onFailure: 'investigation-complete' },
      // THE POST-INCIDENT REVIEW STARTS ONCE RESOLVE IS REACHED AND THE INVESTIGATION IS COMPLETE (WT129, DESIGN-PROCESSES O20): a
      // wait that fails (the investigation cancelled or past its deadline) ends the run with no review.
      'investigation-complete': { label: 'Investigation complete', description: 'The review starts only once the investigation is complete.', wait: { alongside: 'settled' }, onSuccess: 'review-draft', onFailure: 'done' },
      // The ops assistant drafts it here, from the incident's timeline and the investigation's findings, and the on-call completes
      // it on its card; the run ends once it is done.
      'review-draft': {
        label: 'Post-incident review draft', description: "The ops assistant drafts the review from the incident's timeline and findings.",
        agent: { prompt: 'post-incident-review-draft', reads: 'messages', to: 'room', deadlineMs: 60_000, fallback: { send: { to: 'room', template: 'post-incident-review-unavailable' } } },
        onSuccess: 'review', onFailure: 'review',
      },
      review: {
        label: 'Post-incident review', description: 'The on-call completes and signs off the review.',
        task: { machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, assigned: { template: 'post-incident-review' }, deadline: { afterMinutes: 10_080 } },
        onSuccess: 'done', onFailure: 'done',
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
  // and the ops assistant is asked for its one-turn health read, saying what is needed: what changed (WT118). It opens no
  // task, so the room keeps its one resting first look however often the alarm changes.
  // A version copies it into its own `eventWorkflows`, because an event that selects its workflow runs the version's.
  'incident-watch': {
    on: 'alarm-state-changed',
    types: ['ops'],
    initial: 'announce',
    states: {
      announce: { send: { to: 'room', template: 'incident-alarm-changed' }, onSuccess: 'refresh', onFailure: 'refresh' },
      // THE DASHBOARD IS REFRESHED ON EVERY CHANGE, required rather than left to a model (DESIGN-CONVERSATION-DASHBOARDS section 5):
      // the ops assistant's `dashboard_refresh` publishes it on entry. No ops assistant here, and the run goes on to the re-read.
      refresh: { task: { machine: 'dashboard_refresh', by: { assistantRole: 'ops' }, continue: 'opened' }, onSuccess: 'recheck', onFailure: 'recheck' },
      recheck: {
        task: { machine: 'deployment_health', by: { assistantRole: 'ops' }, ask: { template: 'incident-recheck-ask' } },
        onSuccess: 'done',
        onFailure: [{ to: 'tell-absent', when: { 'task:outcome': 'no-worker' } }, { to: 'tell-unavailable' }],
      },
      'tell-absent': { send: { to: 'room', template: 'ops-assistant-absent' }, onSuccess: 'done', onFailure: 'done' },
      'tell-unavailable': { send: { to: 'room', template: 'ops-first-look-unavailable' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  // ADR-061 example (c)'s shape for an invitation: three days after it was sent and still unredeemed, the assistant
  // drafts a reminder and proposes it to the inviter, who confirms before the invitee is emailed (SPEC-ASSISTANT-MEETINGS
  // FR32). A version copies it into its own `eventWorkflows`, because an event that selects its workflow runs the version's.
  // AN EVENT REACHES THE INCIDENT ROOM THAT WATCHES ITS KEY (DESIGN-EVENT-TARGETS): an `ops` room records its incident's id
  // when it opens, and a later event for that incident (updated, resolved) tells the room it arrived.
  'incident-updated': {
    on: 'event-received',
    types: ['ops'],
    initial: 'tell',
    states: {
      tell: { send: { template: 'watched-event', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  // AN EVENT OPENS AN INCIDENT FROM THE TEAM'S CONVERSATION (WT120, WT121): nobody is asked. An `ops` conversation opens, led by the
  // on-call, and the team's conversation is told where it is. The incident is the `ops` conversation's own: its
  // `conversation-opened` workflow (`ops-room`) gives the on-call its task, takes the first look and runs the runbook there.
  'incident-triage': {
    on: 'event-received',
    types: ['ops-team'],
    initial: 'open',
    states: {
      // THE INCIDENT CONVERSATION OPENS AT ONCE (WT120), led by the on-call: nobody is asked first. Triage, and
      // with it customer impact, is the incident conversation's own (`ops-room`). The severity is the incident tool's (O11).
      open: { open: { type: 'ops', for: { typeRole: 'on-call:ops' } }, onSuccess: 'tell', onFailure: 'done' },
      // THE WHOLE TEAM IS TOLD WHY THE INCIDENT CONVERSATION WAS OPENED, with the on-call mentioned and a link to it.
      tell: { send: { template: 'incident-declared', to: 'room', mention: { lead: 'participantRole:on-call:ops' } }, onSuccess: 'hold', onFailure: 'hold' },
      hold: {
        wait: { child: 'ended' }, onSuccess: 'done',
        onFailure: [{ to: 'report-timed-out', when: { 'task:outcome': 'timed-out' } }, { to: 'report-ended', when: { 'task:outcome': 'ended' } }, { to: 'done' }],
      },
      // A THREAD'S END THAT WAS NOT A RESOLVE IS REPORTED TO ITS PARENT (DESIGN-WORKFLOWS-AND-TASKS section 6, rule 3), as it ended.
      'report-timed-out': { send: { template: 'incident-timed-out', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
      'report-ended': { send: { template: 'incident-ended-unresolved', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  // AN INCIDENT'S CUSTOMER MESSAGING (DESIGN-PROCESSES O26 to O33): the run of the account team's conversation an incident opens
  // once customer impact is known. Advisor drafts the initial notice from the account team's template at once, and the account
  // team's lead approves it with the CSMs on a card whose deadline is the process's time to first notice; a miss tells the lead
  // privately and offers the card again, and is recorded as that task's timed-out ending. Each approval is told to the incident.
  // An update and the final notice follow on the lead's card, the final notice once the incident has said it resolved here. The
  // platform sends no notice: the account team sends each through its own tools. Nothing in the incident waits on this run.
  'customer-messaging': {
    on: 'conversation-opened',
    types: ['customer-messaging'],
    initial: 'opening',
    states: {
      opening: { send: { to: 'room', template: 'customer-messaging-opening', mention: { lead: 'participantRole:lead:accounts' } }, onSuccess: 'accounts', onFailure: 'accounts' },
      // THE AFFECTED ACCOUNTS AND THEIR CSMs, read from the account record by the primary (`impacted_accounts`).
      accounts: {
        label: 'Affected accounts', description: 'Advisor names the accounts the incident affects and their CSMs, from the account record.',
        task: { machine: 'impacted_accounts', by: { assistantRole: 'primary' }, ask: { template: 'customer-messaging-accounts' } },
        onSuccess: 'initial-draft', onFailure: 'initial-draft',
      },
      'initial-draft': {
        label: 'Initial notice', description: "Advisor drafts the first customer notice from the incident's confirmed facts.",
        task: { machine: 'customer_notice_draft', by: { assistantRole: 'primary' }, ask: { template: 'customer-notice-initial' } },
        onSuccess: 'initial-approval', onFailure: 'initial-approval',
      },
      // THE TIME TO FIRST NOTICE (O29): fifteen minutes from impact confirmed by default, declared here and tightened by editing it.
      'initial-approval': {
        label: 'Initial notice approval', description: 'The account team lead approves the first notice within the time to first notice.',
        task: { machine: 'approval', by: { participantRole: 'lead:accounts' }, assigned: { template: 'customer-notice-approval' }, deadline: { afterMinutes: 15 } },
        onSuccess: [{ to: 'tell-initial', when: { 'task:state': 'approved' } }, { to: 'initial-revise' }],
        onDeadline: 'initial-late',
        onFailure: 'updates',
      },
      // A MISSED DEADLINE TELLS THE LEAD PRIVATELY, AND THE CARD IS OFFERED AGAIN.
      'initial-late': { send: { to: { participantRole: 'lead:accounts' }, template: 'customer-notice-late' }, onSuccess: 'initial-revise', onFailure: 'initial-revise' },
      'initial-revise': {
        task: { machine: 'approval', by: { participantRole: 'lead:accounts' }, assigned: { template: 'customer-notice-approval' }, deadline: { afterMinutes: 43_200 } },
        onSuccess: [{ to: 'tell-initial', when: { 'task:state': 'approved' } }, { to: 'updates' }],
        onFailure: 'updates',
      },
      'tell-initial': { send: { to: 'room', in: 'opener', template: 'customer-notice-approved' }, onSuccess: 'updates', onFailure: 'updates' },
      updates: {
        label: 'Updates', description: 'The account team asks for an update while the incident is open, or for the final notice.',
        task: { machine: 'customer_updates', by: { participantRole: 'lead:accounts' }, assigned: { template: 'customer-messaging-updates' }, deadline: { afterMinutes: 43_200 } },
        onSuccess: [{ to: 'update-draft', when: { 'task:state': 'draft_update' } }, { to: 'final-draft' }],
        onFailure: 'done',
      },
      'update-draft': {
        task: { machine: 'customer_notice_draft', by: { assistantRole: 'primary' }, ask: { template: 'customer-notice-update' } },
        onSuccess: 'update-approval', onFailure: 'update-approval',
      },
      'update-approval': {
        task: { machine: 'approval', by: { participantRole: 'lead:accounts' }, assigned: { template: 'customer-notice-approval' }, deadline: { afterMinutes: 43_200 } },
        onSuccess: [{ to: 'tell-update', when: { 'task:state': 'approved' } }, { to: 'final-ready' }],
        onFailure: 'final-ready',
      },
      'tell-update': { send: { to: 'room', in: 'opener', template: 'customer-notice-approved' }, onSuccess: 'final-ready', onFailure: 'final-ready' },
      'final-ready': {
        task: { machine: 'final_notice', by: { participantRole: 'lead:accounts' }, assigned: { template: 'customer-messaging-final-ready' }, deadline: { afterMinutes: 43_200 } },
        onSuccess: 'final-draft', onFailure: 'done',
      },
      'final-draft': {
        label: 'Final notice', description: 'Advisor drafts the final notice once the incident is resolved.',
        task: { machine: 'customer_notice_draft', by: { assistantRole: 'primary' }, ask: { template: 'customer-notice-final' } },
        onSuccess: 'final-approval', onFailure: 'final-approval',
      },
      'final-approval': {
        label: 'Final notice approval', description: 'The account team lead approves the final notice.',
        task: { machine: 'approval', by: { participantRole: 'lead:accounts' }, assigned: { template: 'customer-notice-approval' }, deadline: { afterMinutes: 43_200 } },
        onSuccess: [{ to: 'tell-final', when: { 'task:state': 'approved' } }, { to: 'done' }],
        onFailure: 'done',
      },
      'tell-final': { send: { to: 'room', in: 'opener', template: 'customer-notice-approved' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  // THE PLATFORM'S DRIFT (WT89, WT90): a person's message changed the subject. The room is told, and the person is asked
  // whether to move it; their answer alone counts. Move opens an ordinary conversation for it with the message's audience,
  // or sends them to the one detection found. A version copies it to choose the child's type: one with drift off stops the
  // child drifting again.
  drift: {
    on: 'subject-changed',
    initial: 'offer',
    states: {
      offer: {
        // An offer is a question about the last few messages: unanswered after thirty minutes it ends, and the run with it, so
        // a later message is about whatever it says. The detector's sweep closes its record.
        task: { machine: 'drift_offer', by: { people: 'event:person' }, deadline: { afterMinutes: 30 }, notice: { template: 'drift-offer', redirect: 'drift-redirect-offer' } },
        onSuccess: [{ to: 'move', when: { 'task:state': 'move' } }, { to: 'done' }],
        onFailure: 'done',
      },
      move: { open: { type: 'general', for: { people: 'event:person' }, mode: 'move' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
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
  return name && Object.prototype.hasOwnProperty.call(SHIPPED_EVENT_WORKFLOWS, name) ? SHIPPED_EVENT_WORKFLOWS[name] : undefined;
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
  /**
   * An intent's workflow only (ADR-067 decision 1): the intent it runs on. Its own task step, the one that opens the
   * intent's machine, is the canonical step: its deadline is optional, as today's intent tasks have none.
   */
  intent?: string;
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
      errs.push(`${at} mentions participant role ${role} in a message the conversation reads, and type ${t} admits guests or link sessions while the role does not declare visibleToGuests`);
    }
  }
  return errs;
}

function audienceErrors(to: unknown, at: string, event: WorkflowEvent, types?: readonly string[]): string[] {
  if (to === 'room') return [];
  // AN INTENT'S RUN NAMES THE PERSON WHO ASKED (G17); an event's run names its subject. Neither names the other.
  if (to === 'requester') return event === INTENT_TRIGGER ? [] : [`${at}.to is requester, which only an intent's workflow carries`];
  if (to === 'subject') return event === INTENT_TRIGGER ? [`${at}.to is subject, which an intent's workflow names as requester`] : [];
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
  return [`${at}.to is room, subject, requester, joined, { people: event:person }, { people: invitation:inviter } or { participantRole: '<name>' }`];
}

/** The person a mention source names in this run, or undefined. */
function mentionedPerson(source: MentionSource, ctx: Pick<EventRunContext, 'subject' | 'eventPerson' | 'inviter'>): string | undefined {
  if (source === 'subject') return ctx.subject;
  if (source === 'invitation:inviter') return ctx.inviter;
  if (mentionedRole(source)) return undefined;
  return ctx.eventPerson;
}

function sendErrors(send: unknown, at: string, event: WorkflowEvent, opts: WorkflowValidation = {}, types?: readonly string[], step = false): string[] {
  if (!isObject(send)) return [`${at} must be a send step`];
  const errs = audienceErrors(send.to, at, event, types);
  // A SEND IN THE CONVERSATION THAT OPENED THIS ONE (O24) is a step's own, said to that room alone, by a run its opening started.
  if (send.in !== undefined) {
    if (!step || !(SEND_IN_VALUES as readonly unknown[]).includes(send.in)) errs.push(`${at}.in is ${SEND_IN_VALUES.join(' or ')}, on a send step`);
    else if (send.in === 'opener' && event !== 'conversation-opened') errs.push(`${at}.in is opener on a conversation-opened workflow, whose conversation another one opened`);
    else if (send.in === 'opened' && OPEN_STEP_REFUSED_EVENTS.includes(event) && event !== 'conversation-opened') errs.push(`${at}.in is opened on a workflow whose run may open a conversation`);
    // A LEAF OPENS NOTHING (O32), so a leaf's run has no conversation it opened to say anything in.
    else if (send.in === 'opened' && (types ?? []).some((t) => isLeafType(t))) errs.push(`${at}.in is opened: a workflow of a leaf conversation type opens no conversation`);
    else if (send.to !== 'room' || send.mention !== undefined || send.fromRole !== undefined) errs.push(`${at}.in says it to the room of the other conversation, with no mention and no role's template`);
  }
  if (send.fromRole !== undefined) {
    if (send.fromRole !== 'template') errs.push(`${at}.fromRole is template`);
    else if (send.to === 'room') errs.push(`${at}.fromRole says the template a person's role confers, so it is on a send to people, never the conversation`);
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
    errs.push(`${at}.tools: a step whose ${op} draft reaches a person outside the conversation reads only its declared values, so it runs no tools (ADR-061 decision 8, rule 6)`);
  }
  if (op === 'open_conversation') {
    const type = typeof agent.opens === 'string' ? CONVERSATION_TYPES[agent.opens] : undefined;
    if (!type) errs.push(`${at}.opens names the declared conversation type an open_conversation proposal opens`);
    else if (type.initiation === 'system') errs.push(`${at}.opens names ${agent.opens}, which the platform opens on its own (initiation: system)`);
    // THE SAME NESTING AS AN OPEN STEP (O32): a proposal opens a conversation from this one as an open step does.
    errs.push(...nestingErrors(agent.opens, at, event, types));
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
  // AN AGENT STEP IS THE RUN'S OWN ASSISTANT'S TURN, ONLY (WT118): no step of one assistant's workflow runs a turn as another.
  // Work only another assistant may do is a request: a task step by { assistantRole } naming an intent that assistant
  // advertises, which its own version runs.
  if (agent.as !== undefined) {
    errs.push(`${at}.as is retired: an agent step runs as the run's own assistant; ask another assistant for its work with a task step by { assistantRole } naming an intent it advertises`);
  }
  if (isObject(agent.fallback) && agent.fallback.absent !== undefined) {
    errs.push(`${at}.fallback.absent is retired with as: a request to another assistant's role takes its failure edge, with task:outcome no-worker, where no assistant holding the role is in the conversation`);
  }
  // AN AGENT STEP EXECUTES READ TOOLS ONLY (decision 8, rule 5). A consequential act is a proposal (`propose`), never a
  // tool the turn runs. The list is checked as a task step's is (`toolListErrors`, the shared step fields).
  if (agent.tools !== undefined) {
    // AN AGENT STEP MAY PUBLISH ITS OWN CONVERSATION'S DASHBOARD beside its read tools (DESIGN-CONVERSATION-DASHBOARDS section 5);
    // every other write stays refused, and a welcome is given no such exemption.
    errs.push(...toolListErrors(agent.tools, `${at}.tools`, { readOnly: 'an agent step executes read tools only, and proposes a consequential act with propose', dashboardWrites: true }));
  }
  errs.push(...proposeErrors(agent, at, event, types));
  // A TASK AN EVENT OPENS has no requester, so it is a platform machine whose first step awaits nobody, and the turn that
  // runs that step reads the room it is opened in: never a turn narrowed to declared values.
  // RETIRED (ADR-067 stage 4): a task the room works on is opened by a task step. A stored version that carries it still
  // runs it, and a new draft or an import is written as a task step (`inCurrentForm`, retired-fields.ts), so only a
  // draft edited to carry it again meets this.
  if (agent.workflow !== undefined) {
    errs.push(`${at}.workflow is retired: open the task with a task step (task: { machine, by, continue: opened })`);
  }
  // THE ROOM'S RECENT MESSAGES (rule 6): read only where what the step writes reaches members reading the room.
  if (agent.reads !== undefined) {
    if (agent.reads !== 'messages') errs.push(`${at}.reads is messages`);
    else if (agentStepIsNarrowed(agent as Pick<AgentStep, 'propose'>)) errs.push(`${at}.reads: a step whose draft reaches a person outside the conversation reads only its declared values (ADR-061 decision 8, rule 6)`);
    else if (isInvitationEvent(event)) errs.push(`${at}.reads: at ${event} the step's reader is not reading the conversation's messages`);
  }
  return errs;
}

/**
 * A LEAF OPENS NOTHING, AND A CONVERSATION JUST OPENED OPENS ONLY A LEAF (DESIGN-PROCESSES O32): the run of a conversation
 * another one opened may open one conversation of a leaf type beside it, and no further level. Asked of every way a workflow
 * opens a conversation from its own: an `open` step and an `open_conversation` proposal.
 */
function nestingErrors(openedType: unknown, at: string, event: WorkflowEvent, declaredTypes?: readonly string[]): string[] {
  if ((declaredTypes ?? []).some((t) => isLeafType(t))) return [`${at}: a workflow of a leaf conversation type opens no conversation`];
  const leafOpen = typeof openedType === 'string' && isLeafType(openedType);
  if (OPEN_STEP_REFUSED_EVENTS.includes(event) && !(event === 'conversation-opened' && leafOpen)) {
    return [`${at}: ${event} already runs in a conversation just opened, so it opens no conversation of its own${event === 'conversation-opened' ? ' but one of a leaf type' : ''}`];
  }
  return [];
}

/** Why an open step is refused: a type a workflow may open, for one person, at an event that is not itself a room opening. */
function openStepErrors(open: unknown, at: string, event: WorkflowEvent, declaredTypes?: readonly string[]): string[] {
  if (!isObject(open)) return [`${at} is { type, for }`];
  const errs: string[] = [...nestingErrors(open.type, at, event, declaredTypes)];
  const type = typeof open.type === 'string' ? CONVERSATION_TYPES[open.type] : undefined;
  if (!type) errs.push(`${at}.type names a declared conversation type`);
  else if (type.initiation === 'system') errs.push(`${at}.type names ${open.type as string}, which the platform opens on its own (initiation: system)`);
  if (open.for === undefined || open.for === 'room') errs.push(`${at}.for names the one person who leads the child`);
  else if (isObject(open.for) && 'typeRole' in open.for) {
    const role = typeof open.for.typeRole === 'string' ? open.for.typeRole : '';
    const decl = typeof open.type === 'string' ? participantRoleOf(open.type, role) : undefined;
    if (type && (!decl || decl.holders !== 'one' || !decl.from.some((s) => sourceKindOf(s) === 'group'))) {
      errs.push(`${at}.for.typeRole names a role of ${open.type as string} sourced from a group, with one holder`);
    }
  } else errs.push(...audienceErrors(open.for, `${at}.for`, event, declaredTypes));
  if (open.mode !== undefined) {
    if (open.mode !== 'move') errs.push(`${at}.mode is move`);
    else if (event !== 'subject-changed') errs.push(`${at}.mode is move only on subject-changed, where a person's message changed the subject`);
    else {
      // THE SUBJECT IS THE SENDER'S, and a moved subject shares nothing with the room it left (FR26), so a move opens for the
      // person whose message changed it, into a type that does not thread with its parent.
      if (!(isObject(open.for) && open.for.people === 'event:person' && Object.keys(open.for).length === 1)) errs.push(`${at}.for is { people: event:person } in a move: the subject is its sender's`);
      // A ROOM WHOSE MEMBERS COME FROM A GROUP IS THE GROUP'S: a move carries the people of the room it left, and they are not that group.
      if (typeof open.type === 'string' && membershipSourceFor(open.type)) errs.push(`${at}.type names ${open.type}, whose members come from its group; a move carries the conversation's people`);
      if (typeof open.type === 'string' && relationOf(open.type) === 'thread') errs.push(`${at}.type names ${open.type}, which threads with its parent; a moved subject shares nothing with the conversation it left`);
    }
  }
  const unknown = Object.keys(open).filter((k) => k !== 'type' && k !== 'for' && k !== 'mode');
  if (unknown.length) errs.push(`${at} is { type, for, mode }; it does not declare ${unknown.join(', ')}`);
  return errs;
}

/** Why a meeting step is refused: its ring within bounds, a template by name, and nothing it does not declare. */
function meetingActionErrors(action: Record<string, unknown>, at: string): string[] {
  const errs: string[] = [];
  for (const key of Object.keys(action)) {
    if (!['tool', 'ringSeconds', 'notice', 'email'].includes(key)) errs.push(`${at}.${key} is not a field of a meeting step; it is { tool: start_meeting, ringSeconds, notice, email }`);
  }
  const ring = action.ringSeconds;
  if (ring !== undefined && (typeof ring !== 'number' || !Number.isInteger(ring) || ring < MIN_RING_SECONDS || ring > MAX_RING_SECONDS)) {
    errs.push(`${at}.ringSeconds is a whole number of seconds from ${MIN_RING_SECONDS} to ${MAX_RING_SECONDS}`);
  }
  if (action.notice !== undefined && (typeof action.notice !== 'string' || !NAME.test(action.notice))) {
    errs.push(`${at}.notice names a message template (lowercase letters, digits and hyphens)`);
  }
  if (action.email !== undefined && typeof action.email !== 'boolean') errs.push(`${at}.email is true or false`);
  return errs;
}

/** Why an action step is refused: `start_intake`, addressed to the one person its event names, or `start_meeting`. */
function actionErrors(action: unknown, at: string, event: WorkflowEvent): string[] {
  if (isObject(action) && action.tool === 'start_meeting') {
    if (MEETING_STEP_REFUSED_EVENTS.includes(event)) return [`${at}: a meeting is not started at ${event}, which a meeting's end raises, so each start would end and start again`];
    return meetingActionErrors(action, at);
  }
  if (!isObject(action) || action.tool !== 'start_intake') return [`${at} is { tool: start_intake, to } or { tool: start_meeting, ringSeconds, notice, email }`];
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
  // A WELCOME READS AND SAYS; it never changes anything (ADR-061 decision 8, rule 5).
  if (prompt.tools !== undefined) errs.push(...toolListErrors(prompt.tools, `${at}.tools`, { readOnly: 'a welcome may use read tools only' }));
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
  // A MEETING STEP RINGS, TELLS AND CAN EMAIL THE WHOLE ROOM, so it is addressed to nobody alone.
  if (startsMeeting(def)) return false;
  const step = (isObject(def.send) ? def.send : isObject(def.agent) ? def.agent : undefined) as Record<string, unknown> | undefined;
  if (!step) return true;
  return step.to === 'joined' || (isObject(step.to) && step.to.people === 'event:person' && Object.keys(step.to).length === 1);
}

/** Who reads what a step posts: `room` for a room step, `addressed` for one to a person or for a step posting nothing. */
function stepAudience(def: unknown): 'room' | 'addressed' {
  if (!isObject(def)) return 'addressed';
  // The welcome's opening and its prompt turn are said to the room.
  if (def.opening !== undefined || def.prompt !== undefined) return 'room';
  // A meeting step rings, tells and can email the whole room (ADR-060: the room learns whatever selected it).
  if (startsMeeting(def)) return 'room';
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
 * THE NAMES OF RUNS THE PLATFORM MAKES ITSELF, with no workflow behind them: a meeting's summary (`MEETING_SUMMARY_RUN`),
 * whose action items' settlements continue no run. A task's run is read by its workflow's name, so no version's workflow
 * takes one of these names, and every run of a version's workflow goes on when its task settles.
 */
export const PLATFORM_RUN_NAMES: readonly string[] = Object.freeze(['meeting-summary']);

/**
 * WHY A WORKFLOW IS REFUSED, or nothing. Every rule here is one ADR-061 states for what is built; a rule a later
 * slice relaxes is refused with that slice named.
 */
export function eventWorkflowErrors(name: string, wf: unknown, opts: WorkflowValidation = {}): string[] {
  const at = opts.intent !== undefined ? `intentWorkflows.${name}` : `eventWorkflows.${name}`;
  if (PLATFORM_RUN_NAMES.includes(name)) return [`${at}: ${name} names a run the platform makes itself, so a workflow takes another name`];
  if (!isObject(wf)) return [`${at} must be a workflow`];
  // AN INTENT'S WORKFLOW RUNS ON THE INTENT TRIGGER, which no event workflow declares (`intentWorkflowErrors` passes it).
  const triggers: readonly unknown[] = opts.intent !== undefined ? [INTENT_TRIGGER] : EVENT_WORKFLOW_EVENTS;
  if (!triggers.includes(wf.on)) return [`${at}.on is ${opts.intent !== undefined ? `{ intent: ${opts.intent} }` : `one of ${EVENT_WORKFLOW_EVENTS.join(', ')}`}`];
  const event = wf.on as WorkflowEvent;
  const errs: string[] = [];
  const types = wf.types;
  if (types !== undefined && (!Array.isArray(types) || types.some((t) => typeof t !== 'string' || !CONVERSATION_TYPES[t as string]))) {
    errs.push(`${at}.types lists declared conversation types`);
  }
  // AN AWS EVENT RUNS IN ONE TYPE OF CONVERSATION (WT121, DESIGN-EVENT-TARGETS section 6): one an event reaches
  // (`eventUnreachableReason`, the rule the trigger API and the console read too).
  if (event === 'event-received') {
    if (!Array.isArray(types) || types.length !== 1) errs.push(`${at} runs on event-received, so it declares the one conversation type it runs in`);
    else {
      const why = CONVERSATION_TYPES[types[0] as string] ? eventUnreachableReason(types[0] as string) : undefined;
      if (why === 'meeting') errs.push(`${at}.types names ${types[0] as string}, a meeting's conversation, which no event reaches`);
      if (why === 'noWatchedKey') errs.push(`${at}.types names ${types[0] as string}, which no event reaches: it is not a team conversation type and no opener of it watches a key`);
    }
  }
  // A SUBJECT CHANGE IS RAISED ONLY WHERE DRIFT IS ON (WT88), so a workflow on it names only types that have it on.
  if (event === 'subject-changed' && Array.isArray(types)) {
    for (const t of types as string[]) {
      if (CONVERSATION_TYPES[t] && CONVERSATION_TYPES[t].driftEnabled === false) errs.push(`${at}.types names ${t}, which has drift off, so no subject change is raised there`);
    }
  }
  if (event === 'conversation-opened') {
    if (!Array.isArray(types) || types.length === 0) errs.push(`${at} runs on conversation-opened, so it declares the types an event opens`);
    else for (const t of types as string[]) {
      if (CONVERSATION_TYPES[t] && !opensWithARun(t)) errs.push(`${at}.types names ${t}, which no event opens (no openedBy) and no workflow opens (not a leaf)`);
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

  // THE RUN'S END IS HELD ON EACH TASK IT WENT ON ALONGSIDE, in the order declared, and at most one of them ends or moves the run
  // (`endsRun`), so its settlement is the one that decides where the run goes; an investigation beside it only holds the end (WT129).
  const alongside = Object.entries(states).filter(([, s]) => isObject(s) && isObject(s.task) && s.task.continue === TASK_STEP_ALONGSIDE && s.task.endsRun === true).map(([k]) => k);
  if (alongside.length > 1) errs.push(`${at} goes on alongside the tasks of ${alongside.join(', ')}; at most one task the run goes on alongside ends or moves the run (endsRun)`);

  const agents = new Set<string>();
  // THE TIMES THE RUN'S TASKS RECORD (WT20, WT21): what a wait may wait until and a later task's deadline may fall at.
  const recordedTimes = recordedTimesOf(states, opts.machines);
  for (const [key, raw] of Object.entries(states)) {
    const sat = `${at}.states.${key}`;
    if (!isObject(raw)) { errs.push(`${sat} must be a step`); continue; }
    const kinds = ['send', 'agent', 'action', 'opening', 'prompt', 'task', 'wait', 'open', 'disposition'].filter((k) => raw[k] !== undefined);
    if (kinds.length !== 1) { errs.push(`${sat} is exactly one of a send, an agent step, an action, an opening, a prompt, a task, a wait, an open, or a terminal disposition`); continue; }
    // A RESOLVE THAT MOVES THE RUN ON (O15) names a step of this workflow.
    const movesTo = isObject(raw.task) ? raw.task.movesTo : undefined;
    if (typeof movesTo === 'string' && !Object.prototype.hasOwnProperty.call(states, movesTo)) errs.push(`${sat}.task.movesTo names a step of this workflow`);
    if (raw.label !== undefined && (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > MAX_STEP_LABEL)) errs.push(`${sat}.label is the step's name as a person reads it, 1 to ${MAX_STEP_LABEL} characters`);
    if (raw.description !== undefined && (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > MAX_DESCRIPTION)) errs.push(`${sat}.description says what the stage is for, 1 to ${MAX_DESCRIPTION} characters`);
    if (raw.description !== undefined && raw.label === undefined) errs.push(`${sat}.description belongs to a stage, so the step also declares its label`);
    if (raw.wait !== undefined) {
      const w = raw.wait as Record<string, unknown> | null;
      const m = isObject(w) ? w.minutes : undefined;
      if (isObject(w) && w.child !== undefined) {
        // A WAIT ON THE OPENED CONVERSATION follows an open step of this run that opens one (a move opens no run to wait on).
        if (Object.keys(w).some((k) => k !== 'child') || !(WAIT_CHILD_VALUES as readonly unknown[]).includes(w.child)) errs.push(`${sat}.wait is { child: ${WAIT_CHILD_VALUES.join(' or ')} } where it waits on the conversation the run opened`);
        if (!Object.values(states).some((s) => isObject(s) && isObject(s.open) && s.open.mode !== 'move')) errs.push(`${sat}.wait.child waits on the conversation this run opens, so the workflow has an open step that opens one`);
      } else if (isObject(w) && w.join !== undefined) {
        errs.push(...joinErrors(w, sat, states));
      } else if (isObject(w) && w.alongside !== undefined) {
        // A WAIT ON THE TASKS THE RUN WENT ON ALONGSIDE (WT129) needs a step that goes on alongside its task.
        if (Object.keys(w).some((k) => k !== 'alongside') || !(WAIT_ALONGSIDE_VALUES as readonly unknown[]).includes(w.alongside)) errs.push(`${sat}.wait is { alongside: ${WAIT_ALONGSIDE_VALUES.join(' or ')} } where it waits on the tasks the run went on alongside`);
        if (!Object.values(states).some((s) => isObject(s) && isObject(s.task) && s.task.continue === TASK_STEP_ALONGSIDE)) errs.push(`${sat}.wait.alongside waits on the tasks this run goes on alongside, so the workflow has a task step that declares continue: ${TASK_STEP_ALONGSIDE}`);
      } else if (isObject(w) && w.until !== undefined) {
        // A WAIT UNTIL A RECORDED TIME (WT20): a time an earlier task of this run records, and nothing else.
        if (Object.keys(w).some((k) => k !== 'until')) errs.push(`${sat}.wait is { until } where it waits until a recorded time`);
        if (typeof w.until !== 'string' || !recordedTimes.includes(w.until)) {
          errs.push(`${sat}.wait.until names a time a task of this run records (task:value:<need>, recorded as time)${recordedTimes.length ? `: ${recordedTimes.join(', ')}` : '; none does'}`);
        }
      } else if (!isObject(w) || Object.keys(w).some((k) => k !== 'minutes') || typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > MAX_WAIT_MINUTES) {
        errs.push(`${sat}.wait is { minutes }, a whole number of minutes from 1 to ${MAX_WAIT_MINUTES}, or { until }, a recorded time`);
      }
    }
    // A TASK STEP'S EDGES READ HOW ITS TASK ENDED (`task:state`, ADR-063 decision 1), and no other step's do.
    // A TASK GIVEN TO ANOTHER ASSISTANT'S ROLE hands back its ending only (the ownership tenet), so its edges read how it
    // ended and nothing it recorded. It names the owner's intent, whose steps this version never reads, so `task:state` has
    // no states to name there and `task:outcome` says how it ended.
    const handedOff = isObject(raw.task) && workerAssistantRole(raw.task.by) !== undefined;
    const taskMachine = raw.task !== undefined && isObject(raw.task) && typeof raw.task.machine === 'string'
      ? (handedOff ? ASKED_INTENT_MACHINE : machinesAStepMayOpen(opts.machines)[raw.task.machine]) : undefined;
    const withTask = taskMachine ? withTaskState(opts.lookup ?? defaultLookup(), taskMachine, { values: !handedOff }) : undefined;
    // THE OWNER'S STATES ARE ITS OWN: a request's edges read `task:outcome`, and no `task:state` is known to them.
    // A WAIT ON THE OPENED CONVERSATION'S END READS HOW IT ENDED, in the `task:outcome` words (`childEndingOf`).
    const joinWait = isObject(raw.wait) && raw.wait.join !== undefined;
    const childWait = isObject(raw.wait) && (raw.wait.child !== undefined || raw.wait.alongside !== undefined || joinWait);
    const withChild = childWait ? (name: string) => (name === TASK_OUTCOME_SOURCE ? taskOutcomeSource() : (opts.lookup ?? defaultLookup())(name)) : undefined;
    const edgeOpts: WorkflowValidation = withTask ? { ...opts, lookup: handedOff ? (name: string) => (name === TASK_STATE_SOURCE ? undefined : withTask(name)) : withTask }
      : withChild ? { ...opts, lookup: withChild } : opts;
    for (const edge of ['onSuccess', 'onFailure'] as const) {
      if (raw[edge] !== undefined) errs.push(...edgeErrors(raw[edge], `${sat}.${edge}`, states, event, edgeOpts));
    }
    if (raw.onDeadline !== undefined) {
      if (raw.task === undefined && !joinWait) errs.push(`${sat}.onDeadline is taken when a task step's deadline ends its task, so only a task step declares it, or a join, whose deadline it is (wait.join.minutes)`);
      else errs.push(...edgeErrors(raw.onDeadline, `${sat}.onDeadline`, states, event, edgeOpts));
    }
    // A MEETING OFFER ASKS WHETHER TO START A MEETING (`meeting_offer`), so its `start` goes on to the meeting step.
    if (isObject(raw.task) && raw.task.machine === MEETING_OFFER_MACHINE && !meetingOfferStartsMeeting(raw.onSuccess, states)) {
      errs.push(`${sat} offers a meeting, so its onSuccess goes to a start_meeting step when task:state is ${MEETING_OFFER_START}`);
    }
    // AN ASK SAYS WHAT IS NEEDED in one of this assistant's message templates (WT118), so one it cannot say is refused here.
    if (isObject(raw.task) && isObject(raw.task.ask) && typeof raw.task.ask.template === 'string') {
      const askTemplate = (opts.template ?? shippedTemplate)(raw.task.ask.template);
      if (!askTemplate || askTemplate.kind !== 'message') errs.push(`${sat}.task.ask.template names ${raw.task.ask.template}, which is not a message template this assistant has`);
    }
    // WHAT THE HOLDER IS TOLD names a message template this assistant has, as a send does.
    if (isObject(raw.task) && isObject(raw.task.assigned)) {
      for (const field of ['template', 'withoutMeetings'] as const) {
        const named = raw.task.assigned[field];
        if (typeof named !== 'string') continue;
        const assignedTemplate = (opts.template ?? shippedTemplate)(named);
        if (!assignedTemplate || assignedTemplate.kind !== 'message') errs.push(`${sat}.task.assigned.${field} names ${named}, which is not a message template this assistant has`);
      }
    }
    // A TASK STEP'S OWN NOTICE (WT89) names a message template this assistant has, as a send does. It replaces the holder's
    // private assignment notice, so it is an offer's alone: on a subject change, held by the person whose message it was.
    if (isObject(raw.task) && raw.task.notice !== undefined) {
      if (event !== 'subject-changed') errs.push(`${sat}.task.notice is an offer's, said on subject-changed`);
      if (!(isObject(raw.task.by) && raw.task.by.people === 'event:person' && Object.keys(raw.task.by).length === 1)) errs.push(`${sat}.task.notice is said to the person who holds the offer: by is { people: event:person }`);
      const notice = raw.task.notice as Record<string, unknown> | null;
      const says = (name: unknown) => { const t = typeof name === 'string' ? (opts.template ?? shippedTemplate)(name) : undefined; return !!t && t.kind === 'message'; };
      if (!isObject(notice) || Object.keys(notice).some((k) => k !== 'template' && k !== 'redirect')) errs.push(`${sat}.task.notice is { template, redirect }`);
      else {
        if (!says(notice.template)) errs.push(`${sat}.task.notice.template names ${String(notice.template)}, which is not a message template this assistant has`);
        if (notice.redirect !== undefined && !says(notice.redirect)) errs.push(`${sat}.task.notice.redirect names ${String(notice.redirect)}, which is not a message template this assistant has`);
      }
    }
    if (raw.task !== undefined) {
      errs.push(...taskStepErrors(raw.task, `${sat}.task`, {
        // An intent's own task step is the canonical step, whose deadline is optional (decision 1).
        ...(opts.intent !== undefined && isObject(raw.task) && raw.task.machine === opts.intent ? { deadlineOptional: true } : {}),
        recordedTimes,
        ...(declaredTypes ? { types: declaredTypes } : {}),
        ...(opts.machines ? { machines: opts.machines } : {}),
        // A TASK IS FOR ONE PERSON AND WORKED BY ONE: the references an audience resolves to one person at this event.
        personErrors: (ref, rat) => (ref === 'room' ? [`${rat} names one person, never the conversation`] : audienceErrors(ref, rat, event, declaredTypes)),
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
    if (raw.open !== undefined) errs.push(...openStepErrors(raw.open, `${sat}.open`, event, declaredTypes));
    if (raw.send !== undefined) errs.push(...sendErrors(raw.send, `${sat}.send`, event, opts, declaredTypes, true));
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
        if (!edgeTargets(e).every((to) => addressesEventPerson(states[to]) || !(isObject(states[to]) && ((states[to] as Record<string, unknown>).send || (states[to] as Record<string, unknown>).agent || startsMeeting(states[to]))))) {
          errs.push(`${sat}.${edge} chooses on a fact about the person the event names, so each step it may take is addressed to that person alone`);
        }
      }
    }
  }
  // A PROMPT TURN IS SAID BY THE JOIN THAT RUNS THE WELCOME, and only there: a run that goes on past an agent or a task
  // step is continued by that step's hand-back, which says no prompt turn, so no prompt step is reached after one.
  const promptsAfter = new Set<string>();
  for (const [from, raw] of Object.entries(states)) {
    if (!isObject(raw) || (raw.agent === undefined && raw.task === undefined && raw.wait === undefined)) continue;
    const seen = new Set<string>();
    const queue = [raw.onSuccess, raw.onFailure, raw.onDeadline].flatMap((e) => edgeTargets(e));
    while (queue.length) {
      const to = queue.shift()!;
      if (seen.has(to) || !isObject(states[to])) continue;
      seen.add(to);
      const def = states[to] as Record<string, unknown>;
      if (def.prompt !== undefined && !promptsAfter.has(to)) {
        promptsAfter.add(to);
        errs.push(`${at}.states.${to} is a prompt step reached after ${from}, ${raw.agent !== undefined ? 'an agent step' : raw.wait !== undefined ? 'a wait' : 'a task step'}; a run goes on past such a step without the join that says a prompt turn, so a prompt step comes before every agent, task and wait step`);
      }
      queue.push(...[def.onSuccess, def.onFailure, def.onDeadline].flatMap((e) => edgeTargets(e)));
    }
  }
  // A ROOM IS OPENED ONCE: one opening step in a welcome.
  const openings = Object.entries(states).filter(([, raw]) => isObject(raw) && raw.opening !== undefined).map(([k]) => k);
  if (openings.length > 1) errs.push(`${at} has ${openings.length} opening steps (${openings.join(', ')}); a welcome opens the conversation once`);
  // THE OPENING OPENS THE ROOM, so it is the welcome's first step: said before anything else, and by the join that ran it.
  else if (openings.length === 1 && openings[0] !== wf.initial) errs.push(`${at}.states.${openings[0]} is an opening, which opens the conversation, so it is the welcome's first step (initial)`);
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
export function holderOfRole(
  role: string,
  args: { self: { botArn: string; role?: string }; live: ReadonlyArray<{ botArn: string; role: string; handle: string }>; botsInRoom: readonly string[] },
): { botArn: string; assistant?: string } | 'ambiguous' | undefined {
  if (!role || args.self.role === role) return { botArn: args.self.botArn };
  const inRoom = new Set(args.botsInRoom);
  const holders = args.live.filter((a) => a.role === role && a.botArn !== args.self.botArn && inRoom.has(a.botArn));
  // ONE ASSISTANT HOLDS A ROLE IN A ROOM, or the request names nobody: two holders would leave which one owns the work to
  // the order a list happens to be read in, so neither is asked.
  if (holders.length > 1) return 'ambiguous';
  return holders[0] ? { botArn: holders[0].botArn, assistant: holders[0].handle } : undefined;
}

/**
 * WHETHER AN ASSISTANT MAY TAKE A STEP IT WAS HANDED (tenet D1, WT118): only a step of its own version's workflow that names
 * no other assistant's role. A step naming `as` (retired) runs nothing anywhere.
 */
export function stepTakenBy(def: Pick<AgentStep, 'as'>): boolean {
  return !def.as;
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

/** What started an `event-received` run: the rule, its window, and for a watched conversation the kind and key it watches. */
export interface RuleEventRef { rule: string; window: number; watch?: { kind: string; key: string } }

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
  /** What started the run (WT118): a person's request, another assistant's run asking, or a platform event. */
  trigger?: 'person' | 'assistant' | 'event';
  /** The requests that led to this run (WT118, `WorkflowRunRef.askChain`), which bound how far requests may go. */
  askChain?: string[];
  /** The person `conversation-opened` or `person-joined` names, or the invitee `invitation-sent` names, as an AppInstanceUser ARN. */
  eventPerson?: string;
  /**
   * An intent's run only: the person whose request started it, as an AppInstanceUser ARN, read from the task the run
   * opened (its `userArn`), never from a hand-back.
   */
  requester?: string;
  /**
   * An intent's run only: whether its request was private (ADR-067 decision 8). A private run reaches no one but its
   * requester: a step to the room, to another person or to another worker is withheld, and the requester is told.
   */
  privateRun?: boolean;
  /** An intent's run only: the turn's correlation id, which keys the run (`intent#<correlationId>#<assistant>`). */
  correlationId?: string;
  /**
   * An intent's run only: the task its own step opened, whose row is the run's authority on who asked, how the run is
   * keyed and whether it is private. Every later record of the run names it, so a continuation reads that row.
   */
  runTaskId?: string;
  /** `task-reopened` only: the task, and which of its reopens this is. */
  reopened?: { taskId: string; n: number };
  /** `event-received` only: the rule that matched, and the window its event fell in. */
  /** The rule that started the run, its window, and for a watched conversation the key it came through (DESIGN-EVENT-TARGETS). */
  ruleEvent?: RuleEventRef;
  /** The meeting events only: the meeting, read back from the conversation's record by the router. */
  meeting?: { meetingId: string };
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
  /** The process the run belongs to (SPEC-PROCESSES P2): set when it starts, inherited by what it opens, never changed. */
  process?: RunProcess;
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
export function withTaskState(lookup: SourceLookup, machine: TaskStateMachine, opts: { values?: boolean } = {}): SourceLookup {
  const src = taskStateSource(machine);
  const why = taskOutcomeSource();
  // A NUMBER OR A YES-OR-NO THE TASK RECORDED (WT22) is read on its step's edges as `task:value:<need>`, as its own
  // conditions read it.
  const values = taskSourceLookup(machine, lookup);
  return (name: string) => (name === TASK_STATE_SOURCE ? src : name === TASK_OUTCOME_SOURCE ? why
    : name.startsWith(TASK_VALUE_SOURCE_PREFIX) ? (opts.values === false ? undefined : values(name)) : lookup(name));
}

/** The recorded times the run's task steps' machines record, as `task:value:<need>` (WT20, WT21). */
/**
 * WHY A JOIN IS REFUSED AS WRITTEN (`wait: { join }`): it is its wait's only key; it names two to eight parts, each once, each a
 * step of this workflow that starts something in parallel (an `open` step that opens a conversation, or a task step that goes
 * on alongside), and each named by at most one join; it waits for `all` or `any`; and its deadline, where it declares one, is a
 * whole number of minutes. A conversation a join waits on is not also waited on by `wait: { child }`, whose record it shares.
 */
function joinErrors(w: Record<string, unknown>, sat: string, states: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const at = `${sat}.wait.join`;
  const j = w.join;
  if (Object.keys(w).some((k) => k !== 'join')) errs.push(`${sat}.wait is { join } where it waits on several parts`);
  if (!isObject(j) || Object.keys(j).some((k) => !['of', 'when', 'minutes'].includes(k))) return [...errs, `${at} is { of, when, minutes? }: the parts it waits on, and whether it waits for all of them or any one`];
  if (!(JOIN_WHEN_VALUES as readonly unknown[]).includes(j.when)) errs.push(`${at}.when is ${JOIN_WHEN_VALUES.join(' or ')}`);
  if (j.minutes !== undefined && (typeof j.minutes !== 'number' || !Number.isInteger(j.minutes) || j.minutes < 1 || j.minutes > MAX_WAIT_MINUTES)) {
    errs.push(`${at}.minutes is a whole number of minutes from 1 to ${MAX_WAIT_MINUTES}`);
  }
  const of = Array.isArray(j.of) ? j.of : undefined;
  if (!of || of.length < MIN_JOIN_PARTS || of.length > MAX_JOIN_PARTS || of.some((p) => typeof p !== 'string')) {
    return [...errs, `${at}.of names ${MIN_JOIN_PARTS} to ${MAX_JOIN_PARTS} steps of this workflow, each a part the run started in parallel`];
  }
  const dupes = of.filter((p, i) => of.indexOf(p) !== i);
  if (dupes.length) errs.push(`${at}.of names ${[...new Set(dupes)].join(', ')} more than once; each part is named once`);
  const self = sat.slice(sat.lastIndexOf('.') + 1);
  for (const part of new Set(of as string[])) {
    const s = states[part];
    const open = isObject(s) && isObject(s.open) && s.open.mode !== 'move';
    const alongside = isObject(s) && isObject(s.task) && s.task.continue === TASK_STEP_ALONGSIDE;
    if (!JOIN_PART_NAME.test(part) || !Object.prototype.hasOwnProperty.call(states, part)) {
      errs.push(`${at}.of names ${part}, which is not a step of this workflow`);
    } else if (!open && !alongside) {
      errs.push(`${at}.of names ${part}, which is neither an open step that opens a conversation nor a task step that declares continue: ${TASK_STEP_ALONGSIDE}`);
    }
    const other = Object.entries(states).find(([k, d]) => k !== self && isObject(d) && isObject(d.wait) && isObject(d.wait.join) && Array.isArray(d.wait.join.of) && d.wait.join.of.includes(part));
    if (other && Object.keys(states).indexOf(other[0]) < Object.keys(states).indexOf(self)) errs.push(`${at}.of names ${part}, which the join at ${other[0]} already waits on; a part is joined once`);
    if (open && Object.values(states).some((d) => isObject(d) && isObject(d.wait) && d.wait.child !== undefined)) {
      errs.push(`${at}.of names ${part}, an opened conversation, and the workflow also waits with wait: { child }; the join waits on it, so the workflow drops that wait`);
    }
  }
  return errs;
}

function recordedTimesOf(states: Record<string, unknown>, machines: WorkflowValidation['machines']): string[] {
  const out = new Set<string>();
  for (const raw of Object.values(states)) {
    // A task another assistant works records nothing its asking run reads (the ownership tenet).
    const handedOff = isObject(raw) && isObject(raw.task) && workerAssistantRole(raw.task.by) !== undefined;
    const machineKey = !handedOff && isObject(raw) && isObject(raw.task) && typeof raw.task.machine === 'string' ? raw.task.machine : undefined;
    const machine = machineKey ? machinesAStepMayOpen(machines)[machineKey] : undefined;
    for (const [need, type] of Object.entries(machineRecords(machine))) if (type === 'time') out.add(`${TASK_VALUE_SOURCE_PREFIX}${need}`);
  }
  return [...out];
}

/** A wait on the opened conversation's run context with what its edges read: why that run did not succeed (`task:outcome`). */
function withChildEnding(ctx: EventRunContext, outcome: string): EventRunContext {
  return withWaitEnding(ctx, childEndingOf(outcome));
}

/** A join's run context with what its edges read: why it did not go on as a success (`task:outcome`), as a single wait's do. */
function withJoinEnding(ctx: EventRunContext, outcome: string): EventRunContext {
  return withWaitEnding(ctx, joinFailureOf(outcome));
}

function withWaitEnding(ctx: EventRunContext, why: TaskStepFailure | undefined): EventRunContext {
  if (!ctx.gate || !why) return ctx;
  const lookup = ctx.gate.lookup;
  return {
    ...ctx,
    gate: {
      ...ctx.gate,
      lookup: (name: string) => (name === TASK_OUTCOME_SOURCE ? taskOutcomeSource() : lookup(name)),
      values: { ...ctx.gate.values, [TASK_OUTCOME_SOURCE]: why },
    },
  };
}

/** A task step's run context with what its edges read: `task:state` when it ended in a state, `task:outcome` when it failed. */
function withTaskOutcome(ctx: EventRunContext, machine: TaskStateMachine | undefined, outcome: string): EventRunContext {
  // Every run the router starts or continues carries a gate (`routerGate`); a run without one holds no condition at all,
  // so its edges take their last alternative, as every other conditioned edge of that run does.
  if (!machine || !ctx.gate) return ctx;
  const ended = taskOutcomeOf(outcome);
  const why = taskFailureOf(outcome);
  return {
    ...ctx,
    gate: {
      ...ctx.gate,
      lookup: withTaskState(ctx.gate.lookup, machine),
      values: {
        ...ctx.gate.values, ...(ended.state ? { [TASK_STATE_SOURCE]: ended.state } : {}), ...(why ? { [TASK_OUTCOME_SOURCE]: why } : {}),
        // THE VALUES THE TASK RECORDED (WT22), handed to the run when it settled, read as their recorded types.
        ...Object.fromEntries(Object.entries(machineRecords(machine))
          .map(([need, type]) => [`${TASK_VALUE_SOURCE_PREFIX}${need}`, typedRunValue(ctx.values[`${TASK_VALUE_SOURCE_PREFIX}${need}`], type)] as const)
          .filter(([, v]) => v !== undefined)),
      },
    },
  };
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
/** `withheld`: a private request's step that would have reached someone other than the person who asked (decision 8). */
export type StepOutcome = 'posted' | 'skipped' | 'gated' | 'failed' | 'dispatched' | 'not-dispatched' | 'no-role-assistant' | 'already-claimed' | 'opened' | 'no-worker' | 'withheld' | 'waiting' | 'refused';

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
  /** `in`: said in the conversation that opened this one (O24), `refused` where the assistant is not a member there. */
  send: (args: { template: string; values: Record<string, string>; to: string[]; step: string; transitions: EventTransition[]; mentions?: string[]; fallback?: boolean; in?: SendStep['in'] }) => Promise<boolean | 'refused'>;
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
  /**
   * Start the conversation's meeting (`start_meeting`), ring the room and tell it: the meeting's link once it runs and the
   * room was told, else `failed`. Absent where the deployment does not declare meetings.
   */
  startMeeting?: (step: string, def: MeetingAction, transitions: EventTransition[]) => Promise<{ link: string } | 'failed'>;
  /**
   * Ask for a step's child conversation (WT120), once the step is claimed: `requested` when the creator has it and the run
   * now waits for it, `no-person` when the step's `for` names nobody or several, `nested` when this conversation is itself a
   * child, which opens no further one, `failed` when it could not be asked.
   */
  /**
   * Open the step's child. `requested`: the creator opens it and hands the run back. `{ opened }`: it stands now (a move,
   * WT90), and the run goes on at once, carrying its link.
   */
  openChild?: (step: string, def: OpenStep, transitions: EventTransition[]) => Promise<'requested' | 'no-person' | 'nested' | 'failed' | { opened: string }>;
  /** Post the welcome's opening to the room (`opening`), composed as `WelcomeIntent` composes it. True when it posted. */
  opening?: (step: string, def: WelcomeOpeningStep, transitions: EventTransition[]) => Promise<boolean>;
  /** Dispatch the welcome's prompt turn (`prompt`). True when it was handed to the processor. */
  prompt?: (step: string, def: PromptWelcomeStep) => Promise<boolean>;
  /**
   * Open a task step's task (ADR-063 decision 1), once the step is claimed: `opened` when the task service wrote it and the
   * run now waits on it, `no-worker` when nobody the step names to do the work is here (no assistant holding the role,
   * no person the reference resolves to), `failed` when it could not be opened. Absent, a task step takes its failure edge.
   */
  /** `joined`: a join of the run waits on this task (`wait: { join }`), so its settlement also meets that join's record. */
  openTask?: (step: string, def: TaskStep, transitions: EventTransition[], opts?: { joined?: boolean }) => Promise<'opened' | 'no-worker' | 'failed'>;
  log?: (entry: Record<string, unknown>) => void;
  /** The run's version's machines over the platform's, which a task step's edges read (`task:state`, `task:outcome`). */
  machines?: Readonly<Record<string, TaskStateMachine>>;
  /** Tell the person who asked that a step of their private request was not taken (WT110). */
  withheld?: (step: string, transitions: EventTransition[]) => Promise<void>;
  /**
   * Hold the run at a wait step (WT20): `waiting` once its time is scheduled or its record is held, `came` where what it waits
   * for has already happened (the opened conversation's run already ended), so the run goes on now, else `failed`.
   */
  wait?: (step: string, def: WaitStep, transitions: EventTransition[]) => Promise<'waiting' | 'came' | 'failed' | { came: string }>;
  /**
   * THE RUN'S END WAITS ON THE TASK IT OPENED ALONGSIDE (`continue: 'alongside'`): handed the steps whose tasks may still be
   * open, `held` where one is, so the run stops at its end and ends when that task settles; `free` where none is, with how
   * each that settled ended (`{ free }`), and by its step where it says (`by`), which the run's ending reads.
   */
  holdEnd?: (step: string, alongside: readonly string[], transitions: EventTransition[]) => Promise<'held' | 'free' | { free: string[]; by?: Readonly<Record<string, string>> }>;
  /**
   * HOLD A JOIN ON ONE OF ITS PARTS (`wait: { join }`): the run's continuation, marked with the part (`JOIN_PART`), on that
   * part's own record, where its ending meets it, as `wait: { child }` and `holdEnd` hold theirs. `held` where the run now waits
   * on it; `{ came }` with the outcome its hand-back carries where the part ended first; else `failed`.
   */
  holdJoinPart?: (step: string, part: string, kind: JoinPartKind, transitions: EventTransition[]) => Promise<'held' | { came: string } | 'failed'>;
  /** Schedule a join's deadline, once: the run goes on its deadline edge then, unless the join already went on. */
  joinDeadline?: (step: string, join: WaitJoin, transitions: EventTransition[]) => Promise<boolean>;
  /** Which of the run's own claims are held, with the outcomes they recorded; null where they could not be read. */
  readClaims?: (names: string[]) => Promise<Record<string, string> | null>;
  /**
   * WHETHER THE RUN HAS ALREADY ENDED (its end claim is held): a task that `endsRun` ended it mid-way, so a continuation that
   * arrives after, a cancelled task's settlement among them, goes on with nothing. Absent, or a read that fails, it has not.
   */
  hasEnded?: () => Promise<boolean>;
  /** The run reached its end, once (its end claim won): its one archive fact (WT62), and how it ended (`runEnding`). */
  ended?: (disposition: 'success' | 'failure', steps: EventTransition[], ending: ChildEnding) => Promise<void>;
  /**
   * A RUN A RESOLVE MOVED ON (`movesTo`, O15) SETTLES WHAT IT STILL HOLDS OPEN AT ITS END: each live task it opened, and each
   * request it made, is cancelled with the run's end as its reason (`run-ended`), so a runbook task opened beside the resolve
   * (a call offer) is not left pending once the review is done. Called once, after `ended`.
   */
  endTasks?: () => Promise<void>;
}

/**
 * WHETHER A STEP WOULD REACH SOMEONE OTHER THAN THE PERSON WHO ASKED (decision 8): a send, an agent step's output or an
 * intake addressed to the room or to another person, or a task for or worked by another person. A task the run's own
 * assistant or an assistant role works, for the requester, reaches nobody else. An end, an opening and a prompt reach
 * nobody new.
 */
export function reachesBeyondRequester(def: EventStepDef, ctx: EventRunContext): boolean {
  const others = (to: EventAudience | undefined): boolean => {
    if (to === undefined) return false;
    const who = audienceOf(to, ctx);
    return who === 'room' || who.some((p) => p !== ctx.requester);
  };
  if (def.send) return others(def.send.to);
  if (def.agent) return others(def.agent.to as EventAudience);
  // A MEETING RINGS AND TELLS THE ROOM, so a private run starts none.
  if (isMeetingAction(def.action)) return true;
  if (def.action) return others(def.action.to as EventAudience);
  // A child conversation is seen by everyone its type admits, whoever the run is private to. A move takes the audience of
  // the message that changed the subject (WT92), so a private message's move holds its sender alone.
  if (def.open) return def.open.mode !== 'move';
  if (def.task) {
    const person = (ref: unknown) => ref !== undefined && !(typeof ref === 'object' && ref !== null && 'assistantRole' in ref) && others(ref as EventAudience);
    return person(def.task.for) || person(def.task.by);
  }
  return false;
}

/** The people an audience names, or `room`. An empty list is a send to nobody, which posts nothing. */
export function audienceOf(to: EventAudience, ctx: EventRunContext): 'room' | string[] {
  if (to === 'room') return 'room';
  if (to === 'requester') return ctx.requester ? [ctx.requester] : [];
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

/**
 * THE WARNINGS A WORKFLOW NAMING THE SUBJECT OFF `assistant-joined` EARNS. The participant shape's subject is resolved
 * where the assistant joins, and only there, so on any other event a step addressed to `subject` reaches nobody and a
 * `subject` mention renders nothing. Said beside the result and never a refusal, so a version stored with one still
 * validates; the console offers `subject` on `assistant-joined` alone.
 */
export function eventWorkflowSubjectWarnings(name: string, wf: EventWorkflow): string[] {
  if (!isObject(wf) || wf.on === WELCOME_EVENT || !isObject(wf.states)) return [];
  const out: string[] = [];
  const said = (where: string, what: 'addresses' | 'mentions' | 'names') => out.push(
    `${where} ${what} subject, the person the conversation was opened for, who is known on ${WELCOME_EVENT} only; on ${wf.on} it ${what === 'mentions' ? 'renders nothing' : 'reaches nobody'}`);
  const sendWarnings = (send: unknown, where: string) => {
    if (!isObject(send)) return;
    if (send.to === 'subject') said(`${where}.to`, 'addresses');
    if (isObject(send.mention)) for (const [field, source] of Object.entries(send.mention)) if (source === 'subject') said(`${where}.mention.${field}`, 'mentions');
  };
  for (const [key, raw] of Object.entries(wf.states)) {
    if (!isObject(raw)) continue;
    const at = `eventWorkflows.${name}.states.${key}`;
    sendWarnings(raw.send, `${at}.send`);
    if (isObject(raw.agent)) {
      if (raw.agent.to === 'subject') said(`${at}.agent.to`, 'addresses');
      if (isObject(raw.agent.fallback)) sendWarnings(raw.agent.fallback.send, `${at}.agent.fallback.send`);
    }
    if (isObject(raw.task)) for (const field of ['for', 'by'] as const) if (raw.task[field] === 'subject') said(`${at}.task.${field}`, 'names');
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
    for (const ref of [def.task?.for, def.task?.by, ...(def.open?.for && !(typeof def.open.for === 'object' && 'typeRole' in def.open.for) ? [def.open.for] : [])]) { const r = audienceRole(ref); if (r) roles.add(r); }
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

/** The claim the run's end takes, once (WT62). */
export const RUN_END_CLAIM = 'end';

/** The move a run records when a task it went on alongside settled and released its held end, so its end holds on no other. */
export const ALONGSIDE_RELEASED = 'released';
/** The longest a step's `label` may be. */
export const MAX_STEP_LABEL = 80;
/** The longest description a stage or a process carries, in characters. */
export const MAX_DESCRIPTION = 300;

/** A step's name as a person reads it: its declared `label`, else its key. */
export const stepLabel = (wf: EventWorkflow, step: string): string => wf.states[step]?.label?.trim() || step;

/** The claims a run's standing is read from (`runStanding`): each task step's and its continuation's, and the run's end. */
export function runStandingClaims(wf: EventWorkflow): string[] {
  return [...Object.keys(wf.states).filter((k) => !!wf.states[k]?.task).flatMap((k) => [k, continuationClaim(k)]), RUN_END_CLAIM];
}

/**
 * WHERE A RUN STANDS, read from its own claims (the run's transition log, `claimStep`), never from what anybody wrote:
 *  - `current`, the task steps it is at: claimed and not yet continued past, other than a task it went on alongside, whose
 *    settlement is the run's end rather than a step;
 *  - `next`, the task steps not yet reached that its edges can still reach from where it stands, every alternative of a
 *    conditioned edge included, since which one holds is decided when the run gets there.
 * Each in the order the workflow declares its steps. A run that has ended stands nowhere.
 */
export function runStanding(wf: EventWorkflow, claims: Readonly<Record<string, string>>): { current: string[]; next: string[]; ended: boolean } {
  const order = Object.keys(wf.states);
  if (claims[RUN_END_CLAIM] !== undefined) return { current: [], next: [], ended: true };
  const alongside = new Set(alongsideSteps(wf));
  const work = (k: string) => !!wf.states[k]?.task && !alongside.has(k);
  const claimed = (k: string) => claims[k] !== undefined;
  const current = order.filter((k) => work(k) && claimed(k) && claims[continuationClaim(k)] === undefined);
  const targets = (k: string): string[] => {
    const d = wf.states[k];
    return [d?.onSuccess, d?.onFailure, d?.onDeadline].flatMap((e) => (e === undefined ? [] : typeof e === 'string' ? [e] : e.map((alt) => alt.to)));
  };
  // FROM WHERE IT STANDS: its current steps, else (between steps) every task step it has taken. A step that is not a task is
  // passed through, and a task step it already took stops the walk.
  const seen = new Set<string>();
  const queue = current.length ? [...current] : order.filter(claimed);
  while (queue.length) {
    for (const t of targets(queue.shift() as string)) {
      if (seen.has(t) || claimed(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return { current, next: order.filter((k) => seen.has(k) && work(k)), ended: false };
}

/** The task steps a run goes on alongside (`continue: 'alongside'`), whose tasks its end waits on. */
export function alongsideSteps(wf: EventWorkflow): string[] {
  return Object.entries(wf.states).filter(([, d]) => d?.task?.continue === TASK_STEP_ALONGSIDE).map(([k]) => k);
}

/** Whether a task the run goes on alongside may end it mid-way (`endsRun`), so a continuation first asks whether it ended. */
export function endsMidway(wf: EventWorkflow): boolean {
  return Object.values(wf.states).some((d) => d?.task?.continue === TASK_STEP_ALONGSIDE && d.task.endsRun === true);
}

/** The terminal a run a task ended mid-way ends on: its first success terminal, else its first terminal. */
export function endingTerminal(wf: EventWorkflow): string | undefined {
  const terminals = Object.keys(wf.states).filter((k) => wf.states[k]?.disposition);
  return terminals.find((k) => wf.states[k].disposition === 'success') ?? terminals[0];
}

/**
 * THE STEPS A HAND-BACK MAY CONTINUE A RUN FROM: an agent step, a task step, a wait or an open step, and a terminal whose end
 * a task opened alongside held, so a workflow with no such task offers no terminal to continue.
 */
export function continuableStep(wf: EventWorkflow, step: string): boolean {
  const def = wf.states[step];
  if (!def) return false;
  if (def.disposition) return alongsideSteps(wf).length > 0;
  return !!(def.agent || def.task || def.wait || def.open);
}

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
  resume?: {
    from: string | undefined; transitions?: EventTransition[];
    /**
     * The run's end was held on a task opened alongside, which has now settled, so the end is taken without holding again:
     * how that task ended, or `true` where the settlement did not say.
     */
    released?: boolean | string;
  },
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
    /** What this step's edges read: the run's own, and for a task step that failed, why (`task:outcome`). */
    let edgeCtx: EventRunContext = ctx;
    if (def.disposition) {
      // A RUN DOES NOT END BEFORE THE TASKS IT OPENED ALONGSIDE ITS STEPS: where one is still open, the run stops here, and
      // that task's settlement takes the end (`continueAfter`), with the terminal's own disposition, however the task ended.
      // A RELEASE NAMES THE TASK THAT SETTLED (`ALONGSIDE_RELEASED`), so the end goes on to hold on any other still open (an
      // investigation beside the lead's task, WT129); a release that names none is the one task's, and the end is taken.
      const released = transitions.filter((t) => t.outcome === ALONGSIDE_RELEASED).map((t) => t.step);
      const alongside = resume?.released && !released.length ? [] : alongsideSteps(wf).filter((k) => !released.includes(k));
      const settled: string[] = typeof resume?.released === 'string' ? [resume.released] : [];
      const by: Record<string, string> = {};
      if (alongside.length && deps.holdEnd) {
        const held = await deps.holdEnd(at, alongside, [...transitions]).catch(() => 'free' as const);
        if (held === 'held') {
          log({ workflow: name, event: ctx.event, step: at, outcome: 'end-held' });
          return { ran: true, steps };
        }
        if (typeof held === 'object') { settled.push(...held.free); Object.assign(by, held.by ?? {}); }
      }
      // The run's end is claimed too, so a continuation that arrives for a finished run finds nothing to do, and the one
      // invocation that wins it records the run's end (WT62).
      if (await deps.claimStep(RUN_END_CLAIM, def.disposition).catch(() => false)) {
        if (deps.ended) await deps.ended(def.disposition, [...transitions], runEndingAfterMove(wf, def.disposition, settled, by)).catch(() => undefined);
        if (deps.endTasks && runMovedOn(wf, transitions, by)) await deps.endTasks().catch(() => undefined);
      }
      log({ workflow: name, event: ctx.event, step: at, outcome: `end:${def.disposition}` });
      return { ran: true, steps, ended: def.disposition };
    }
    let ok = false;
    try {
      if (ctx.privateRun && reachesBeyondRequester(def, ctx)) {
        // A PRIVATE REQUEST REACHES NO ONE BUT THE PERSON WHO ASKED (ADR-067 decision 8, WT72): the step is not taken,
        // the person is told once (WT110), and the run goes on as the step's failure would take it. Claimed, so a
        // redelivered run tells them nothing twice.
        record(at, 'withheld');
        if (deps.withheld && await deps.claimStep(at, 'withheld').catch(() => false)) await deps.withheld(at, [...transitions]).catch(() => undefined);
        ok = false;
      } else if (def.when !== undefined && !gateHolds(ctx, def.when, stepAudience(def))) {
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
          let refused = false;
          for (const group of to.length ? templatesForPeople(def.send, ctx, to) : [{ template: def.send.template, to }]) {
            const posted = await deps.send({
              template: group.template, values, to: group.to, step: at, transitions: [...transitions, { step: at, outcome: 'posted' }], mentions: Object.keys(def.send.mention ?? {}),
              ...(def.send.in ? { in: def.send.in } : {}),
            });
            // REFUSED BY THE CONVERSATION IT IS SAID IN (O24): the assistant is not a member there, and the step records so.
            if (posted === 'refused') refused = true;
            ok = ok && posted === true;
          }
          record(at, ok ? 'posted' : refused ? 'refused' : 'failed');
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
      } else if (isMeetingAction(def.action)) {
        // A MEETING, STARTED ONCE: claimed before it starts, so a redelivered event rings nobody twice. Its link is the run's
        // to say in a following send.
        if (!deps.startMeeting) {
          record(at, 'not-dispatched');
          log({ workflow: name, event: ctx.event, step: at, outcome: 'meetings-not-declared' });
          ok = false;
        } else if (!(await deps.claimStep(at, 'posted'))) {
          // A STEP THIS RUN DID NOT START HAS NO LINK TO HAND ON, so the run stops here, as an open step's does: the run that
          // holds the claim goes on with the link, and no send says the meeting's link without one, whether the claim was
          // held or could not be written.
          record(at, 'already-claimed');
          log({ workflow: name, event: ctx.event, step: at, outcome: 'meeting-not-started-here' });
          break;
        } else {
          const out = await deps.startMeeting(at, def.action, [...transitions, { step: at, outcome: 'posted' }]);
          if (out === 'failed') {
            record(at, 'failed');
            ok = false;
          } else {
            ctx = { ...ctx, values: { ...(ctx.values ?? {}), [MEETING_LINK_VALUE]: out.link } };
            edgeCtx = ctx;
            record(at, 'posted');
            ok = true;
          }
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
      } else if (def.open) {
        // ONE CHILD PER RUN'S STEP: claimed before it is asked for, so a redelivered event opens nothing twice and, finding the
        // step claimed, waits as the first run does. The creator hands the run back when the child stands or could not.
        if (!deps.openChild) {
          record(at, 'not-dispatched');
          ok = false;
        } else if (!(await deps.claimStep(at, OPEN_STEP_OPENED))) {
          record(at, 'already-claimed');
          break;
        } else {
          const out = await deps.openChild(at, def.open, [...transitions, { step: at, outcome: OPEN_STEP_OPENED }]);
          if (out === 'requested') { record(at, 'waiting'); break; }
          if (typeof out === 'object') {
            // IT STANDS NOW (a move): the run goes on in this invocation, the child's link in its values for a following send.
            ctx = { ...ctx, values: { ...(ctx.values ?? {}), [CHILD_LINK_VALUE]: out.opened } };
            edgeCtx = ctx;
            record(at, OPEN_STEP_OPENED);
            ok = true;
          } else {
          record(at, 'failed');
          log({ workflow: name, event: ctx.event, step: at, outcome: `child-not-opened:${out}` });
          // Nothing was asked for, so nothing will hand the run back: it goes on now, under the claim the hand-back would take.
          if (!(await deps.claimStep(continuationClaim(at), out).catch(() => false))) break;
          ok = false;
          }
        }
      } else if (def.task) {
        // A TASK STEP OPENS ITS TASK ONCE AND THE RUN WAITS ON IT (ADR-063 decision 3): claimed before it is opened, so a
        // redelivered event opens nothing twice and, finding the step claimed, waits as the first run does.
        if (!deps.openTask) {
          record(at, 'not-dispatched');
          ok = false;
        } else if (def.task.machine === MEETING_OFFER_MACHINE && !deps.startMeeting) {
          // NO MEETING TO OFFER WHERE THE DEPLOYMENT DECLARES NONE: the offer is skipped, nobody is asked, and the run takes its
          // success edge with no `task:state`, so its edge to the meeting step is never taken.
          record(at, 'skipped');
          log({ workflow: name, event: ctx.event, step: at, outcome: 'meetings-not-declared' });
          ok = true;
        } else if (!(await deps.claimStep(at, TASK_STEP_OUTCOMES.opened))) {
          record(at, 'already-claimed');
          break;
        } else {
          const joined = def.task.continue === TASK_STEP_ALONGSIDE && joinedSteps(wf).includes(at);
          const openedAt: EventTransition[] = [...transitions, { step: at, outcome: TASK_STEP_OUTCOMES.opened }];
          const opened = joined ? await deps.openTask(at, def.task, openedAt, { joined }) : await deps.openTask(at, def.task, openedAt);
          record(at, opened === 'opened' ? 'opened' : opened);
          // OPENED ALONGSIDE, THE RUN GOES ON NOW, under the continuation claim its settlement would take, so the settlement
          // continues nothing here and takes the run's end instead (`holdEnd`).
          if (opened === 'opened' && def.task.continue === TASK_STEP_ALONGSIDE) {
            if (!(await deps.claimStep(continuationClaim(at), TASK_STEP_OUTCOMES.opened).catch(() => false))) break;
            ok = true;
          } else if (opened === 'opened') {
            // OPENED, THE RUN WAITS: for the task's ending, or, with `continue: opened`, for the task to leave the state it
            // opened in (the task service names `entered`, and the continuation takes `onSuccess` once).
            break;
          } else {
            // Nothing was opened, so nothing will settle: the run goes on now, on the step's failure edge, under the
            // continuation claim the settlement would have taken, and its edges read why (`task:outcome`, G23).
            if (!(await deps.claimStep(continuationClaim(at), opened).catch(() => false))) break;
            edgeCtx = withTaskOutcome(ctx, machinesAStepMayOpen(deps.machines)[def.task.machine], opened);
            ok = false;
          }
        }
      } else if (def.wait?.join) {
        // A JOIN HOLDS ON EACH PART STILL RUNNING, every one at once, so whichever ends hands the run back (`continueAfter`),
        // and goes on now where its parts already decide it. Claimed before it holds, so a redelivered run holds nothing twice.
        if (!deps.holdJoinPart || !deps.readClaims) {
          record(at, 'not-dispatched');
          ok = false;
        } else if (!(await deps.claimStep(at, 'waiting').catch(() => false))) {
          record(at, 'already-claimed');
          break;
        } else {
          const join = def.wait.join;
          const outcome = await holdJoin(at, join, wf, deps, [...transitions, { step: at, outcome: 'waiting' }]);
          record(at, outcome === 'failed' ? 'failed' : 'waiting');
          if (outcome === undefined) break;
          // IT GOES ON NOW, under the claim a part's hand-back would take, so it goes on once; its outcome names its parts.
          if (!(await deps.claimStep(continuationClaim(at), outcome).catch(() => false))) break;
          if (outcome !== 'failed') transitions.push({ step: at, outcome });
          ok = joinOutcomeOf(outcome)?.edge === 'success';
          edgeCtx = withJoinEnding(ctx, outcome);
        }
      } else if (def.wait?.alongside) {
        // A WAIT ON THE TASKS THE RUN WENT ON ALONGSIDE (WT129) holds on each still open, as the run's end does (`holdEnd`), and
        // the settlement that meets it continues the run here (`continueAfter`). All settled already, it goes on now, once.
        if (!deps.holdEnd) {
          record(at, 'not-dispatched');
          ok = false;
        } else if (!(await deps.claimStep(at, 'waiting').catch(() => false))) {
          record(at, 'already-claimed');
          break;
        } else {
          const released = transitions.filter((t) => t.outcome === ALONGSIDE_RELEASED).map((t) => t.step);
          const held = await deps.holdEnd(at, alongsideSteps(wf).filter((k) => !released.includes(k)), [...transitions, { step: at, outcome: 'waiting' }])
            .catch(() => 'failed' as const);
          record(at, held === 'failed' ? 'failed' : 'waiting');
          if (held === 'held') break;
          const outcome = held === 'failed' ? 'failed' : childEndedOutcome(runEnding('success', held === 'free' ? [] : held.free));
          if (!(await deps.claimStep(continuationClaim(at), outcome).catch(() => false))) break;
          ok = outcome === WAIT_CAME;
          edgeCtx = withChildEnding(ctx, outcome);
        }
      } else if (def.wait) {
        // A WAIT HOLDS THE RUN ON ITS ONE-SHOT SCHEDULE (WT20), claimed before it is scheduled so a redelivered run schedules
        // nothing twice; it goes on when the schedule fires. One that could not be scheduled goes on its failure edge now.
        if (!deps.wait) {
          record(at, 'not-dispatched');
          ok = false;
        } else if (!(await deps.claimStep(at, 'waiting').catch(() => false))) {
          record(at, 'already-claimed');
          break;
        } else {
          const held = await deps.wait(at, def.wait, [...transitions, { step: at, outcome: 'waiting' }]);
          record(at, held === 'failed' ? 'failed' : 'waiting');
          if (held === 'waiting') break;
          // WHAT IT WAITS FOR ALREADY CAME (the opened conversation's run ended first): the run goes on now, under the claim the
          // later hand-back would take, so it goes on once, by how it ended. One that could not be held goes on its failure edge now.
          const outcome = typeof held === 'object' ? held.came : held === 'came' ? WAIT_CAME : 'failed';
          if (!(await deps.claimStep(continuationClaim(at), outcome).catch(() => false))) break;
          ok = outcome === WAIT_CAME;
          if (def.wait.child) edgeCtx = withChildEnding(ctx, outcome);
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
      if (err instanceof RunAbandoned) throw err;
      record(at, 'failed');
      log({ workflow: name, event: ctx.event, step: at, outcome: 'failed', err: (err as Error)?.name });
    }
    const edge = ok ? def.onSuccess : def.onFailure;
    const next = nextStep(wf, edge, edgeCtx);
    log({ workflow: name, event: ctx.event, step: at, outcome: steps[steps.length - 1]?.outcome, ...(Array.isArray(edge) ? { edge: next ?? null } : {}) });
    at = next;
  }
  return { ran: true, steps };
}

/**
 * A JOIN REACHED: each part still running is held, a part already ended is claimed with how it ended, and the claims are read
 * back, so an ending that arrived meanwhile is counted. The outcome it goes on with where its parts already decide it, `failed`
 * where a part could not be held or its parts not read, or undefined while it holds (its deadline then scheduled).
 */
async function holdJoin(at: string, join: WaitJoin, wf: EventWorkflow, deps: EventRunDeps, transitions: EventTransition[]): Promise<string | undefined> {
  const before = await deps.readClaims!(joinClaims(at, join)).catch(() => null);
  if (!before) return 'failed';
  const states = joinPartStates(wf, at, join, before);
  for (const { step: part, kind } of joinParts(wf, join)) {
    if (states[part] !== 'open') continue;
    const held = await deps.holdJoinPart!(at, part, kind, transitions).catch(() => 'failed' as const);
    // A PART THAT CANNOT BE HELD could never hand the join back, so the join goes on its failure edge now.
    if (held === 'failed') return 'failed';
    if (typeof held === 'object') {
      await deps.claimStep(joinPartClaim(at, part), held.came).catch(() => false);
      states[part] = joinPartEnding(kind, held.came);
    }
  }
  const after = await deps.readClaims!(joinClaims(at, join)).catch(() => null);
  if (after) for (const [part, s] of Object.entries(joinPartStates(wf, at, join, after))) if (states[part] === 'open') states[part] = s;
  const outcome = joinDecision(join, states);
  if (outcome === undefined && deps.joinDeadline) await deps.joinDeadline(at, join, transitions).catch(() => false);
  return outcome;
}

/** What a request's edges read of the owner's work: no states of its own, because only the ending comes back (WT118). */
const ASKED_INTENT_MACHINE: TaskStateMachine = { initial: '', states: {} };

/**
 * A RUN THAT STOPS WHERE IT IS, taking no edge: thrown by a step whose failure is not the run's to answer (a request's own
 * task that could not be written), so nothing says the request failed and the caller goes on as it would without a run.
 */
export class RunAbandoned extends Error {
  constructor(message: string) { super(message); this.name = 'RunAbandoned'; }
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
  after: {
    step: string; outcome: string; transitions?: EventTransition[];
    /** The machine the step's task actually ran, where it is not the step's (an accepted queued request's own task). */
    machine?: TaskStateMachine;
  },
  deps: EventRunDeps,
  /** A task step's machines, the version's merged over the platform's, for its edges' `task:state`. */
  machines?: Readonly<Record<string, TaskStateMachine>>,
): Promise<{ ran: boolean; steps: Array<{ step: string; outcome: StepOutcome }>; ended?: 'success' | 'failure' }> {
  const def = wf.states[after.step];
  if (!continuableStep(wf, after.step)) return { ran: false, steps: [] };
  // A RUN THAT ALREADY ENDED GOES ON WITH NOTHING: a task that ends the run (`endsRun`) ended it where it stood.
  if (!def.disposition && endsMidway(wf) && deps.hasEnded && await deps.hasEnded().catch(() => false)) {
    deps.log?.({ workflow: name, event: ctx.event, step: after.step, outcome: 'run-already-ended' });
    return { ran: false, steps: [] };
  }
  if (def.wait?.join) return continueJoin(name, wf, ctx, after, deps, def);
  // A WAIT ON THE TASKS THE RUN WENT ON ALONGSIDE is continued once per task whose settlement released it (the release names
  // it, `ALONGSIDE_RELEASED`), so a wait that holds again on another still open is continued by that one's settlement too.
  const releasedBy = def?.wait?.alongside ? [...(after.transitions ?? [])].reverse().find((t) => t.outcome === ALONGSIDE_RELEASED)?.step : undefined;
  const claim = releasedBy ? `${continuationClaim(after.step)}#${releasedBy}` : continuationClaim(after.step);
  if (!(await deps.claimStep(claim, after.outcome).catch(() => false))) {
    deps.log?.({ workflow: name, event: ctx.event, step: after.step, outcome: 'continuation-already-claimed' });
    return { ran: false, steps: [] };
  }
  if (def.disposition) {
    // THE END A TASK OPENED ALONGSIDE HELD (`holdEnd`): that task settled, so the run ends now, as its terminal says, and how
    // the task ended is how the run ended.
    return runEventWorkflow(name, wf, ctx, deps, {
      from: after.step, transitions: [...(after.transitions ?? [])], released: after.outcome.startsWith('task:') ? after.outcome : true,
    });
  }
  if (def.open) {
    // A CHILD THAT STANDS TAKES THE SUCCESS EDGE, carrying its link in the run's values; one that could not be opened, the failure edge.
    return runEventWorkflow(name, wf, ctx, deps, {
      from: nextStep(wf, after.outcome === OPEN_STEP_OPENED ? def.onSuccess : def.onFailure, ctx),
      transitions: [...(after.transitions ?? []), { step: after.step, outcome: after.outcome }],
    });
  }
  if (def.task) {
    // A TASK STEP GOES ON BY HOW ITS TASK ENDED (ADR-063 decision 3): success, its deadline, or any other ending. Its edges
    // read the terminal state as `task:state`, and no other step's do.
    const ended = taskOutcomeOf(after.outcome);
    const machine = after.machine ?? machinesAStepMayOpen(machines)[def.task.machine];
    const taskCtx = withTaskOutcome(ctx, machine, after.outcome);
    // `continue: opened`: the task left the state it opened in, so the run goes on, once, on its success edge.
    const opened = after.outcome === TASK_STEP_OUTCOMES.opened && def.task.continue === 'opened';
    const edge = opened || ended.edge === 'success' ? def.onSuccess : ended.edge === 'deadline' ? (def.onDeadline ?? def.onFailure) : def.onFailure;
    return runEventWorkflow(name, wf, ctx, deps, {
      from: nextStep(wf, edge, taskCtx),
      transitions: [...(after.transitions ?? []), { step: after.step, outcome: after.outcome }],
    });
  }
  if (def.wait?.alongside) {
    // A TASK THE RUN WENT ON ALONGSIDE SETTLED WHILE THE RUN WAITED ON IT (WT129): the wait holds again on any other still open,
    // and once none is, goes on by how they all settled, its success edge only where each settled in a success.
    const transitions = [...(after.transitions ?? [])];
    const released = transitions.filter((t) => t.outcome === ALONGSIDE_RELEASED).map((t) => t.step);
    const rest = alongsideSteps(wf).filter((k) => !released.includes(k));
    const held = rest.length && deps.holdEnd ? await deps.holdEnd(after.step, rest, transitions).catch(() => 'free' as const) : 'free' as const;
    if (held === 'held') return { ran: true, steps: [] };
    const outcome = childEndedOutcome(runEnding('success', [after.outcome, ...(held === 'free' ? [] : held.free)]));
    return runEventWorkflow(name, wf, ctx, deps, {
      from: nextStep(wf, outcome === WAIT_CAME ? def.onSuccess : def.onFailure, withChildEnding(ctx, outcome)),
      transitions: [...transitions, { step: after.step, outcome }],
    });
  }
  if (def.wait) {
    // A WAIT THAT CAME DUE, OR WHOSE OPENED CONVERSATION'S RUN ENDED IN A SUCCESS, goes on its success edge (WT20); one whose
    // opened conversation ended otherwise goes on its failure edge, whose conditions read how (`task:outcome`).
    return runEventWorkflow(name, wf, ctx, deps, {
      from: nextStep(wf, after.outcome === WAIT_CAME ? def.onSuccess : def.onFailure, def.wait.child ? withChildEnding(ctx, after.outcome) : ctx),
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
 * A JOIN IS HANDED BACK: by one part's ending (its record's continuation names the part, `JOIN_PART`), claimed once per part
 * with how it ended, or by its deadline (no part named). The parts are read again from the run's claims, and the join goes on
 * where they now decide it, or at its deadline, once, under its continuation claim.
 */
async function continueJoin(
  name: string, wf: EventWorkflow, ctx: EventRunContext, after: { step: string; outcome: string; transitions?: EventTransition[] }, deps: EventRunDeps, def: EventStepDef,
): Promise<{ ran: boolean; steps: Array<{ step: string; outcome: StepOutcome }>; ended?: 'success' | 'failure' }> {
  const join = def.wait!.join!;
  const transitions = [...(after.transitions ?? [])];
  const mark = transitions[transitions.length - 1];
  const part = mark?.outcome === JOIN_PART ? mark.step : undefined;
  if (part) {
    transitions.pop();
    if (!joinParts(wf, join).some((p) => p.step === part)) return { ran: false, steps: [] };
    if (!(await deps.claimStep(joinPartClaim(after.step, part), after.outcome).catch(() => false))) {
      deps.log?.({ workflow: name, event: ctx.event, step: after.step, part, outcome: 'join-part-already-claimed' });
      return { ran: false, steps: [] };
    }
  }
  const claims = deps.readClaims ? await deps.readClaims(joinClaims(after.step, join)).catch(() => null) : null;
  let outcome: string | undefined;
  if (part) {
    // A PART'S ENDING WHOSE CLAIMS CANNOT BE READ decides nothing: the next ending, or the deadline, reads them again.
    if (!claims) return { ran: false, steps: [] };
    outcome = joinDecision(join, joinPartStates(wf, after.step, join, claims), part);
    if (outcome === undefined) {
      deps.log?.({ workflow: name, event: ctx.event, step: after.step, part, outcome: 'join-holds' });
      return { ran: true, steps: [] };
    }
  } else {
    // ITS DEADLINE CAME: each part as it stands, every part still running where the claims cannot be read.
    const states = claims ? joinPartStates(wf, after.step, join, claims) : Object.fromEntries(join.of.map((p) => [p, 'open' as const]));
    outcome = joinOutcome('deadline', undefined, Object.fromEntries(join.of.map((p) => [p, states[p] ?? 'skipped'])));
  }
  if (!(await deps.claimStep(continuationClaim(after.step), outcome).catch(() => false))) {
    deps.log?.({ workflow: name, event: ctx.event, step: after.step, outcome: 'continuation-already-claimed' });
    return { ran: false, steps: [] };
  }
  const edge = joinOutcomeOf(outcome)?.edge;
  return runEventWorkflow(name, wf, ctx, deps, {
    from: nextStep(wf, edge === 'success' ? def.onSuccess : edge === 'deadline' ? (def.onDeadline ?? def.onFailure) : def.onFailure, withJoinEnding(ctx, outcome)),
    transitions: [...transitions, { step: after.step, outcome }],
  });
}

/**
 * A VERSION DECLARES ITS OWN EVENT WORKFLOWS (ADR-061 decision 1, as built): `eventWorkflows`, by name, in the same
 * format and under the same rules as the platform's, which stay as defaults a version selects or copies. An intent's
 * task machine rides the version's pack the same way (ADR-066); an event workflow is the assistant's own greeting and
 * follow-up, so it rides the version, is hashed into its `configId`, travels with its export and is served by an experiment
 * arm like any other behavior.
 */
export const MAX_VERSION_EVENT_WORKFLOWS = 8;
export const MAX_EVENT_WORKFLOW_STEPS = 32;
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
    if (untyped.length > 1) errs.push(`eventWorkflows declares ${untyped.length} workflows on ${event} that name no type (${untyped.join(', ')}); at most one answers for every other kind of conversation`);
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
    if (name === 'drift' && isObject(wf) && (wf.on !== 'subject-changed' || (Array.isArray(wf.types) && wf.types.length))) {
      errs.push('eventWorkflows.drift names the platform\'s subject-change default, so it runs on subject-changed in every type; give a workflow scoped to some types another name');
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

// ── PROCESSES (SPEC-PROCESSES, DESIGN-PROCESSES sections 2 and 3) ────────────────────────────────────────────────────
//
// A process is a definition on the owner team's version: the workflows it links by id, and optional metrics. Everything else
// is an ordinary workflow run, which carries the process it belongs to.

export interface ProcessMetric { id: string; label: string; workflow: string; step?: string; outcome?: string; within?: string; target?: number }
export interface VersionProcess {
  label: string;
  /** What the process is for and who owns it end to end, in the owner team's words, shown above its stages. */
  description?: string;
  workflows: string[];
  metrics?: ProcessMetric[];
}

/** What a run carries of its process: the id across its runs, the edition its first run started on, and its run's team. */
export interface RunProcess { id: string; name: string; edition?: string; ownerTeam?: string }

/** A process id and an edition: twelve hex characters, as `contentHash12` writes them. */
export const PROCESS_ID = /^[a-f0-9]{12}$/;
export const MAX_VERSION_PROCESSES = 4;
const MAX_PROCESS_METRICS = 8;
const PROCESS_KEYS = ['label', 'description', 'workflows', 'metrics'];
const ISO_DURATION = /^P(?=\d|T\d)(?:\d{1,4}D)?(?:T(?=\d)(?:\d{1,4}H)?(?:\d{1,5}M)?)?$/;

/** Each refusal a `processes` entry is given, as a code the console says from its locale bundle (D11). */
export const PROCESS_REFUSALS = [
  'PROCESSES_SHAPE', 'PROCESSES_TOO_MANY', 'PROCESS_NAME', 'PROCESS_LABEL', 'PROCESS_DESCRIPTION', 'PROCESS_NO_WORKFLOWS', 'PROCESS_WORKFLOW_UNDECLARED',
  'PROCESS_WORKFLOW_LINKED_TWICE', 'METRIC_SHAPE', 'METRIC_WORKFLOW', 'METRIC_STEP',
] as const;
export type ProcessRefusal = typeof PROCESS_REFUSALS[number];
const refusal = (at: string, code: ProcessRefusal): string => `${at}: ${code}`;

/**
 * WHY A VERSION'S `processes` IS REFUSED AS WRITTEN, or nothing (DESIGN-PROCESSES section 2): an entry with a key other than its
 * label, its workflows and its metrics, a linked workflow the version does not declare, a workflow two processes link, and a
 * metric naming a workflow or step the process does not link. A process links the version's event workflows and its
 * request-started workflows (`intentWorkflows`, keyed by the intent) alike (`linkableWorkflows`).
 */
export function versionProcessesErrors(raw: unknown, eventWorkflows: unknown, intentWorkflows?: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!isObject(raw)) return [refusal('processes', 'PROCESSES_SHAPE')];
  const own = linkableWorkflows(eventWorkflows, intentWorkflows);
  const errs: string[] = [];
  const names = Object.keys(raw);
  if (names.length > MAX_VERSION_PROCESSES) errs.push(refusal('processes', 'PROCESSES_TOO_MANY'));
  const linkedBy = new Map<string, string>();
  for (const name of names) {
    const at = `processes.${name}`;
    const p = raw[name];
    if (!NAME.test(name)) { errs.push(refusal(at, 'PROCESS_NAME')); continue; }
    if (!isObject(p) || Object.keys(p).some((k) => !PROCESS_KEYS.includes(k))) { errs.push(refusal(at, 'PROCESSES_SHAPE')); continue; }
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > MAX_STEP_LABEL) errs.push(refusal(`${at}.label`, 'PROCESS_LABEL'));
    if (p.description !== undefined && (typeof p.description !== 'string' || !p.description.trim() || p.description.length > MAX_DESCRIPTION)) errs.push(refusal(`${at}.description`, 'PROCESS_DESCRIPTION'));
    const workflows = Array.isArray(p.workflows) ? p.workflows : [];
    if (!workflows.length || workflows.length > MAX_VERSION_EVENT_WORKFLOWS) errs.push(refusal(`${at}.workflows`, 'PROCESS_NO_WORKFLOWS'));
    for (const wf of workflows) {
      if (typeof wf !== 'string' || !Object.prototype.hasOwnProperty.call(own, wf)) { errs.push(refusal(`${at}.workflows.${String(wf)}`, 'PROCESS_WORKFLOW_UNDECLARED')); continue; }
      const other = linkedBy.get(wf);
      if (other && other !== name) errs.push(refusal(`${at}.workflows.${wf}`, 'PROCESS_WORKFLOW_LINKED_TWICE'));
      else linkedBy.set(wf, name);
    }
    if (p.metrics !== undefined) {
      if (!Array.isArray(p.metrics) || p.metrics.length > MAX_PROCESS_METRICS) errs.push(refusal(`${at}.metrics`, 'METRIC_SHAPE'));
      else p.metrics.forEach((m, i) => errs.push(...metricErrors(`${at}.metrics.${i}`, m, workflows, own)));
    }
  }
  return errs;
}

function metricErrors(at: string, m: unknown, linked: readonly unknown[], own: Record<string, unknown>): string[] {
  if (!isObject(m) || typeof m.id !== 'string' || !NAME.test(m.id) || typeof m.label !== 'string' || !m.label.trim() || m.label.length > MAX_STEP_LABEL
    || (m.within !== undefined && !(typeof m.within === 'string' && ISO_DURATION.test(m.within)))
    || (m.target !== undefined && !(typeof m.target === 'number' && m.target >= 0 && m.target <= 1))
    || (m.outcome !== undefined && !(typeof m.outcome === 'string' && NAME.test(m.outcome)))) return [refusal(at, 'METRIC_SHAPE')];
  if (typeof m.workflow !== 'string' || !linked.includes(m.workflow)) return [refusal(`${at}.workflow`, 'METRIC_WORKFLOW')];
  const states = (own[m.workflow] as { states?: Record<string, unknown> } | undefined)?.states ?? {};
  if (m.step !== undefined && !(typeof m.step === 'string' && Object.prototype.hasOwnProperty.call(states, m.step))) return [refusal(`${at}.step`, 'METRIC_STEP')];
  return [];
}

/**
 * EVERY WORKFLOW A PROCESS MAY LINK, BY NAME: the version's request-started workflows (`intentWorkflows`, keyed by the intent) and
 * its event workflows. Where an event workflow and an intent share a name, the event workflow is the one read.
 */
export function linkableWorkflows(eventWorkflows: unknown, intentWorkflows?: unknown): Record<string, unknown> {
  return { ...(isObject(intentWorkflows) ? intentWorkflows : {}), ...(isObject(eventWorkflows) ? eventWorkflows : {}) };
}

/** The process a version links a workflow into, by the workflow's name, or undefined. One process links a workflow at most. */
export function processOfWorkflow(processes: Readonly<Record<string, VersionProcess>> | undefined, workflow: string): { name: string; process: VersionProcess } | undefined {
  for (const [name, process] of Object.entries(processes ?? {})) if (Array.isArray(process?.workflows) && process.workflows.includes(workflow)) return { name, process };
  return undefined;
}

/** A process a record hands on, kept only where every part has its shape; anything else is none. */
export function runProcessOf(raw: unknown): RunProcess | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string' || !PROCESS_ID.test(raw.id) || (raw.edition !== undefined && !(typeof raw.edition === 'string' && PROCESS_ID.test(raw.edition)))
    || typeof raw.name !== 'string' || !NAME.test(raw.name)) return undefined;
  return {
    id: raw.id, name: raw.name, ...(typeof raw.edition === 'string' ? { edition: raw.edition } : {}),
    ...(typeof raw.ownerTeam === 'string' && TEAM_NAME.test(raw.ownerTeam) ? { ownerTeam: raw.ownerTeam } : {}),
  };
}
const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

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
  const recap = SHIPPED_EVENT_WORKFLOWS['join-recap'].states.recap.agent!;
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
  if (!type || !opensWithARun(type)) return undefined;
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
  return { name: 'join-recap', workflow: SHIPPED_EVENT_WORKFLOWS['join-recap'], declared: false };
}

/**
 * THE WORKFLOW A SUBJECT CHANGE RUNS (WT88): of the version's `subject-changed` workflows, the one whose `types` name the room's
 * type, else the one that names no type, else the platform's `drift`. `declared` says whether the version declared it.
 */
export function subjectChangedWorkflowOf(
  own: Record<string, EventWorkflow> | null | undefined,
  conversationType: string | undefined,
): { name: string; workflow: EventWorkflow; declared: boolean } {
  const on = Object.entries(own ?? {}).filter(([, wf]) => wf?.on === 'subject-changed');
  const typed = conversationType ? on.find(([, wf]) => (wf.types ?? []).includes(conversationType)) : undefined;
  const chosen = typed ?? on.find(([, wf]) => !wf.types?.length);
  if (chosen) return { name: chosen[0], workflow: chosen[1], declared: true };
  return { name: 'drift', workflow: SHIPPED_EVENT_WORKFLOWS.drift, declared: false };
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
  return { name: 'welcome', workflow: SHIPPED_EVENT_WORKFLOWS.welcome, declared: false };
}

/**
 * THE WORKFLOW A ROOM AN EVENT OPENS RUNS (`conversation-opened`, W1): the version's whose `types` name the room's type,
 * which must be one an event opens. None, and the room is opened by its welcome as any other room is.
 */
export function openedWorkflowOf(
  own: Record<string, EventWorkflow> | null | undefined,
  conversationType: string | undefined,
): { name: string; workflow: EventWorkflow } | undefined {
  if (!conversationType || !opensWithARun(conversationType)) return undefined;
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
    // A meeting step's notice is said to the room after the meeting starts, so it must exist before the step runs.
    if (isMeetingAction(def.action) && def.action.notice) out.push({ name: def.action.notice, kind: 'message', at: `${key}.action.notice` });
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
