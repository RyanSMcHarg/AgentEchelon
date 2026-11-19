/**
 * A VERSION'S OWN EVENT WORKFLOWS, EDITED STEP BY STEP (ADR-061 decision 1, as built).
 *
 * Each workflow runs on `assistant-joined`, `conversation-opened`, `person-joined`, `invitation-sent` or the deadline
 * `invitation-unredeemed`, which declares how long after the invitation was sent it fires. Its steps are listed in order, the first being
 * where the run starts, and the run follows each step's edges from there, never the list's order, so a step no edge
 * reaches is flagged as never running: a send posts a message template to an audience, an agent step is one turn of the assistant
 * from a prompt template with read tools, a deadline and a fallback send, and an end step finishes the run. Each
 * step names where the run goes when it succeeds and when it fails, and a step's kind can be changed in place. A send
 * may bind a template field to a person (`mention:`, decision 2): the person the event names or the person the
 * conversation was opened for, whose display name renders inert, as the runtime renders it (`inertMention`). A
 * platform workflow can be copied in and edited. An agent step may propose one consequential act (`propose`), which the
 * person it addresses confirms on a card; the step then executes nothing itself.
 *
 * THE WELCOME IS ONE OF THEM (W1): a workflow on `assistant-joined`, which `WelcomeIntent` starts, selected by the room's
 * conversation type. It alone takes two more kinds of step: the opening (a template step whose orientation fields and own
 * text the platform's composition renders) and a prompt step after it (one model turn from a prompt template, with read
 * tools). The Welcome section edits a welcome's opening and prompt turn; a welcome that greets and then continues is
 * edited here, step by step.
 *
 * A STEP AND ITS EDGES MAY BE CONDITIONED (ADR-061 decision 2, ADR-060 decision 6). A step's `when` gates whether it
 * posts, and an outcome edge may be an ordered list of `{ to, when }` whose last alternative carries none: each condition
 * is built from declared variables (`ConditionBuilder`), held to who reads what it selects (`edgeAudience`), and offers
 * only what the router reads at an event, so no context source, preference or onboarding answer is offered there.
 *
 * ONE SET OF CONTROLS, TWO VIEWS (ADR-061 decision 7). The controls here are the ones the visual builder's inspector shows
 * (`WorkflowBuilder.tsx`): `WorkflowPicker`, `WorkflowSettings` and `StepFields`, over the edits in `workflowEdits.ts`.
 * This list is the builder's accessible form view, and nothing about a step is edited anywhere else.
 *
 * THE RULES ARE THE SERVER'S. Every error shown under a workflow is `versionEventWorkflowsErrors`, the function the
 * draft, activation and import refuse with (`backend/lambda/src/lib/event-workflow.ts`), and each template preview
 * renders through the runtime's own renderer, so what the editor accepts is what the server accepts.
 */
import MarkdownHelp from './MarkdownHelp';
import React, { useState } from 'react';
import EventTriggerPanel from './EventTriggerPanel';
import { useTranslation } from 'react-i18next';
import {
  MAX_AGENT_DEADLINE_MS,
  MAX_DEADLINE_MINUTES,
  MIN_DEADLINE_MINUTES,
  EVENT_TASK_MACHINES,
  EVENTS_NAMING_A_PERSON,
  SHIPPED_EVENT_WORKFLOWS,
  PROPOSAL_OPS,
  isDeadlineEvent,
  isInvitationEvent,
  inertMention,
  agentStepIsNarrowed,
  type MentionSource,
  type SendStep,
  versionEventWorkflowsErrors,
  edgeAudience,
  type ConditionedEdge,
  type EventAudience,
  type EventEdge,
  type EventStepDef,
  type EventWorkflow,
  MAX_WAIT_MINUTES,
  MAX_EVENT_WORKFLOW_STEPS,
  WAIT_CHILD_VALUES,
  WAIT_ALONGSIDE_VALUES,
  MAX_RING_SECONDS,
  MIN_RING_SECONDS,
  isMeetingAction,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { OWNER_DECIDED_STEP_FIELDS, TASK_STEP_ALONGSIDE,
  MAX_TASK_DEADLINE_MINUTES, MIN_TASK_DEADLINE_MINUTES, TASK_PRIORITIES, machinesAStepMayOpen, workerAssistantRole,
  type TaskPerson, type TaskStep,
  DEFAULT_TASK_REMINDERS, MAX_TASK_REMINDERS, TASK_DEADLINE_KINDS, FORM_MACHINE, MAX_FORM_FIELDS, type FormField,
} from '../../../../../../backend/lambda/src/lib/task-step.ts';
import { promptPreview, type WelcomePromptOption } from './welcomeWorkflow';
import { previewMessageTemplate, sampleValue } from './MessageTemplatesEditor';
import { parseTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import type { ToolDescriptor } from '../../services/profileService';
import ConditionBuilder from './ConditionBuilder';
import VariablePicker from './VariablePicker';
import { WELCOME_TOKENS } from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import WelcomeEditorGuide, { type WelcomePreviewContext } from './WelcomeEditorGuide';
import { CONVERSATION_TYPES, classificationAllowedForType, eventUnreachableReason, opensWithARun } from '../../../../../../backend/lib/config/conversation-types.ts';
import { declaredParticipantRoleNames } from '../../../../../../backend/lib/config/participant-roles.ts';
import { routerHeldVariables, routerHoldsAt, type PickableSource, type PublishedVariables, type VersionVariable } from '../../../../../../backend/lambda/src/lib/variables.ts';
import {
  MEETING_OFFER_MINUTES, STEP_NAME, addStep, atStepLimit, askBeforeMeeting, changeStepKind, convertStep, kindOf, kindsFor, meetingOfferOf, newWorkflow, orderedSteps, removeStep, renameStep, retarget,
  startAt, startMeetingAutomatically, taskPersonAt, unreachableSteps, updateStep, withSteps,
  type Kind,
} from './workflowEdits';

export { convertStep, retarget };

/**
 * HOW LONG THE PERSON ASKED HAS TO ANSWER A MEETING OFFER: the field shows what is typed, and only a whole number of
 * minutes inside a task deadline's bounds reaches the workflow, so the offer always holds a deadline validation accepts.
 */
const OfferMinutes: React.FC<{ value: number; testId: string; label: string; onCommit: (minutes: number) => void }> = ({ value, testId, label, onCommit }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const inBounds = (raw: string) => {
    const m = Number(raw);
    return raw.trim() !== '' && Number.isInteger(m) && m >= MIN_TASK_DEADLINE_MINUTES && m <= MAX_TASK_DEADLINE_MINUTES;
  };
  return (
    <label><span className="admin-field-label">{label}</span>
      <input type="number" className="input" min={MIN_TASK_DEADLINE_MINUTES} max={MAX_TASK_DEADLINE_MINUTES} step={1} data-testid={testId}
        value={shown} aria-invalid={!inBounds(shown)}
        onChange={(e) => { setDraft(e.target.value); if (inBounds(e.target.value)) onCommit(Number(e.target.value)); }}
        onBlur={() => setDraft(null)} />
    </label>
  );
};

/** What the router reads at an event (`routerGate`): no context source, reply preference or onboarding answer. */
export const routerReads = (src: PickableSource): boolean => !/^(ctx|pref|fact):/.test(src.source);

type T = (key: string, opts?: Record<string, unknown>) => string;
type Workflows = Record<string, EventWorkflow>;
/** The machines a task step may open: the platform's reference machines (a version's own are edited as JSON). */
/** A task step that goes on once its task leaves its first state (WT18). */
const OPENED = 'opened' as const;
/** What a form's field takes (WT50), in the order the console offers them. */
const FORM_FIELD_TYPES: ReadonlyArray<FormField['type']> = ['text', 'number', 'yes-no'];
/** A deadline that ends the task (the default), and one that reminds (WT21). */
const TIMEOUT = 'timeout' as const;
const REMIND = 'remind' as const;
const TASK_MACHINES = Object.keys(machinesAStepMayOpen()).sort();
/** Who a task is for or worked by, keyed as an audience is (`audiencesAt`); `assistantRole:<role>` names an assistant worker. */
const taskRefKey = (ref: unknown): string => {
  const role = workerAssistantRole(ref);
  if (role) return `assistantRole:${role}`;
  return ref === undefined ? '' : audienceKey(ref as EventAudience);
};
const taskRefOf = (key: string): TaskStep['by'] | undefined => (!key ? undefined
  : key.startsWith('assistantRole:') ? { assistantRole: key.slice('assistantRole:'.length) } : audienceOf(key) as TaskPerson);

const AUDIENCES = ['room', 'subject', 'joined', 'event:person', 'invitation:inviter'] as const;

/**
 * THE AUDIENCES A STEP AT THIS EVENT MAY NAME, as validation accepts them and the router resolves them: the room for a
 * send or an agent step (a task is for one person), the subject on `assistant-joined` alone, the person who joined on
 * `person-joined`, the person the event names where it names one (`EVENTS_NAMING_A_PERSON`; never the invitee for an
 * agent step, who reads nothing in the room), and the inviter at an invitation's events. `current` stays listed, so a
 * stored step always shows what it names and can be changed.
 */
export function audiencesAt(on: EventWorkflow['on'], kind: 'send' | 'agent' | 'task', current?: string): string[] {
  const offered: string[] = AUDIENCES.filter((a) => {
    if (a === 'room') return kind !== 'task';
    if (a === 'subject') return on === 'assistant-joined';
    if (a === 'joined') return on === 'person-joined';
    if (a === 'event:person') return EVENTS_NAMING_A_PERSON.includes(on) && !(kind === 'agent' && isInvitationEvent(on));
    return isInvitationEvent(on);
  });
  return current && (AUDIENCES as readonly string[]).includes(current) && !offered.includes(current) ? [...offered, current] : offered;
}

/** The people a mention at this event may name: the event's person, the subject on `assistant-joined`, the inviter at an invitation's events. */
export function mentionSourcesAt(on: EventWorkflow['on'], current?: string): string[] {
  const offered = [
    ...(EVENTS_NAMING_A_PERSON.includes(on) ? ['event:person'] : []),
    ...(on === 'assistant-joined' ? ['subject'] : []),
    ...(isInvitationEvent(on) ? ['invitation:inviter'] : []),
  ];
  return current && !current.startsWith('participantRole:') && !offered.includes(current) ? [...offered, current] : offered;
}
/** A participant-role audience is keyed `participantRole:<name>`, as its mention source is. */
export const audienceKey = (to: EventAudience | undefined): string => (typeof to === 'string' ? to : !to ? 'room' : 'participantRole' in to ? `participantRole:${to.participantRole}` : to.people);
const audienceOf = (key: string): EventAudience => key.startsWith('participantRole:') ? { participantRole: key.slice('participantRole:'.length) } : (key === 'event:person' || key === 'invitation:inviter'
  ? { people: key }
  : key as 'room' | 'subject' | 'joined');

/** What every view of the workflows is given to offer its choices. */
export interface WorkflowOptions {
  /** Every template the assistant says, by kind, for the pickers and previews. */
  templates?: WelcomePromptOption[];
  tools: ToolDescriptor[];
  /** The classification's published variable sources, and the version's own variables, for conditions. */
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
  /** The version's own tools: a step the assistant takes itself may use only these (Validate refuses any other). Absent, any. */
  versionTools?: readonly string[];
  /** The assistant's classification, which narrows the conversation types a workflow may name. */
  classification?: string;
  /** What a welcome's opening is built from beyond the draft, for the opening step's preview. */
  welcomeContext?: WelcomePreviewContext;
}

/**
 * THE CONVERSATION TYPES A WORKFLOW MAY NAME: the ones the deployment declares (`conversation-types.ts`), which this
 * classification may carry, and for `conversation-opened` only those an event or a workflow opens - the rules Validate applies.
 */
export function declaredTypesFor(on: EventWorkflow['on'], classification: string | undefined): string[] {
  return Object.keys(CONVERSATION_TYPES).filter((type) => !typeLeftOut(type, on, classification));
}

/** Why a declared type is not offered for this event and classification, or undefined when it is. */
export type TypeLeftOutReason = 'classification' | 'notOpenedByEvent' | 'meeting' | 'noWatchedKey';
export function typeLeftOut(type: string, on: EventWorkflow['on'], classification: string | undefined): TypeLeftOutReason | undefined {
  if (classification && !classificationAllowedForType(type, classification)) return 'classification';
  if (on === 'conversation-opened' && !opensWithARun(type)) return 'notOpenedByEvent';
  // AN AWS EVENT RUNS ONLY IN A TYPE IT REACHES, the rule Validate and the trigger API read (`eventUnreachableReason`).
  if (on === 'event-received') {
    const why = eventUnreachableReason(type);
    if (why === 'meeting' || why === 'noWatchedKey') return why;
  }
  return undefined;
}

/** The declared types a workflow on this event may not name here, each with why: said beside the list, so a short list is explained. */
export function typesLeftOut(on: EventWorkflow['on'], classification: string | undefined): Array<{ type: string; reason: TypeLeftOutReason }> {
  return Object.keys(CONVERSATION_TYPES).flatMap((type) => {
    const reason = typeLeftOut(type, on, classification);
    return reason ? [{ type, reason }] : [];
  });
}

/** The read tools a step may use: the version's own for a step the assistant takes itself, any read tool otherwise. */
/** The `{{field}}` names an opening's text uses that are neither a welcome field nor one of the version's variables: a line naming one is always dropped. */
export function unknownOpeningFields(text: string | undefined, variables: Readonly<Record<string, VersionVariable>> | undefined): string[] {
  const named = [...(text ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(named.filter((n) => !(WELCOME_TOKENS as readonly string[]).includes(n) && !Object.prototype.hasOwnProperty.call(variables ?? {}, n)))];
}

export function stepReadTools(tools: ToolDescriptor[], versionTools: readonly string[] | undefined, own: boolean): ToolDescriptor[] {
  return tools.filter((d) => !d.changesState && (!own || !versionTools || versionTools.includes(d.name)));
}

/** The message and prompt template names a step may pick, by kind. */
export const templateNames = (templates: WelcomePromptOption[] | undefined) => ({
  messages: (templates ?? []).filter((x) => x.kind !== 'prompt').map((x) => x.name),
  prompts: (templates ?? []).filter((x) => x.kind === 'prompt').map((x) => x.name),
});

/** The label of an audience, a participant role's included. */
export function useAudienceLabel(): (a: string) => string {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  return (a: string): string => (a.startsWith('participantRole:')
    ? t('admin.workflowEditor.audience_participantRole', { role: a.slice('participantRole:'.length) })
    : t(`admin.workflowEditor.audience_${a.replace(':', '_')}`));
}

/** CHOOSE, ADD OR COPY A WORKFLOW: the version's own, an empty one under a new name, or a platform workflow copied in. */
export const WorkflowPicker: React.FC<{
  workflows: Workflows;
  selected: string;
  onSelect: (name: string) => void;
  /** Add a workflow under a name, empty or copied; false when the name is not one the server accepts or is taken. */
  onAdd: (name: string, from?: EventWorkflow) => boolean;
}> = ({ workflows, selected, onSelect, onAdd }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const names = Object.keys(workflows);
  const [newName, setNewName] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const add = (from?: EventWorkflow) => { if (onAdd(newName, from)) setNewName(''); };
  return (
    <div className="admin-filter-group">
      <label><span className="admin-field-label">{t('admin.workflowEditor.workflow')}</span>
        <select className="select" data-testid="event-workflow-select" value={selected} onChange={(e) => onSelect(e.target.value)}>
          {!names.length && <option value="" className="select-placeholder" disabled hidden>{t('admin.workflowEditor.none')}</option>}
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label><span className="admin-field-label">{t('admin.workflowEditor.newName')}</span>
        <input type="text" className="input" data-testid="event-workflow-new-name" value={newName} onChange={(e) => setNewName(e.target.value.trim())} />
      </label>
      <button type="button" className="btn-secondary" data-testid="event-workflow-add" disabled={!newName} onClick={() => add()}>
        {t('admin.workflowEditor.add')}
      </button>
      <label><span className="admin-field-label">{t('admin.workflowEditor.copyFrom')}</span>
        <select className="select" data-testid="event-workflow-copy-from" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="" className="select-placeholder" disabled hidden>{t('admin.workflowEditor.copyPick')}</option>
          {Object.keys(SHIPPED_EVENT_WORKFLOWS).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <button type="button" className="btn-secondary" data-testid="event-workflow-copy" disabled={!copyFrom || !newName}
        onClick={() => add(SHIPPED_EVENT_WORKFLOWS[copyFrom])}>
        {t('admin.workflowEditor.copy')}
      </button>
    </div>
  );
};

/** A workflow under a new name, empty or a copy; null when the name is not one the server accepts or is taken. */
export function workflowsWith(workflows: Workflows, name: string, from: EventWorkflow | undefined, templates: WelcomePromptOption[] | undefined): Workflows | null {
  if (!STEP_NAME.test(name) || workflows[name]) return null;
  const { messages, prompts } = templateNames(templates);
  return { ...workflows, [name]: from ? JSON.parse(JSON.stringify(from)) as EventWorkflow : newWorkflow(messages, prompts, workflows) };
}

/** WHAT A WORKFLOW RUNS ON: its event, a deadline event's deadline, the conversation types it runs in, and removing it. */
export const WorkflowSettings: React.FC<{
  wf: EventWorkflow;
  onPut: (next: EventWorkflow) => void;
  onRemove: () => void;
  classification?: string;
  /** The workflow's key on the version, which an event trigger names. */
  name?: string;
  /** The assistant whose version holds it, which an event trigger records. */
  assistant?: string;
}> = ({ name, wf, onPut, onRemove, classification, assistant }) => {
  const offered = declaredTypesFor(wf.on, classification);
  // A type the workflow already names stays listed, so an undeclared one can be cleared rather than hidden.
  const listed = [...offered, ...(wf.types ?? []).filter((x) => !offered.includes(x))];
  const leftOut = typesLeftOut(wf.on, classification).filter((x) => !listed.includes(x.type));
  const setTypes = (types: string[]) => { const { types: _old, ...rest } = wf; onPut(types.length ? { ...rest, types } : rest); };
  const requiredWelcome = wf.on === 'assistant-joined' && !wf.types?.length;
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  return (
    <div className="admin-filter-group">
      <label><span className="admin-field-label">{t('admin.workflowEditor.on')}</span>
        <select className="select" data-testid="event-workflow-on" value={wf.on} onChange={(e) => {
          const on = e.target.value as EventWorkflow['on'];
          // A DEADLINE EVENT DECLARES ITS DEADLINE, and no other event does (`eventWorkflowErrors`).
          const { deadline: _d, ...rest } = wf;
          onPut(isDeadlineEvent(on) ? { ...rest, on, deadline: wf.deadline ?? { afterMinutes: 3 * 24 * 60 } } : { ...rest, on });
        }}>
          <option value="assistant-joined">assistant-joined</option>
          <option value="conversation-opened">conversation-opened</option>
          <option value="person-joined">person-joined</option>
          <option value="invitation-sent">invitation-sent</option>
          <option value="invitation-unredeemed">invitation-unredeemed</option>
          <option value="alarm-state-changed">alarm-state-changed</option>
          <option value="event-received">event-received</option>
        </select>
      </label>
      {isDeadlineEvent(wf.on) && (
        <label><span className="admin-field-label">{t('admin.workflowEditor.deadlineAfter', { min: MIN_DEADLINE_MINUTES, max: MAX_DEADLINE_MINUTES })}</span>
          <input type="number" className="input" min={MIN_DEADLINE_MINUTES} max={MAX_DEADLINE_MINUTES} data-testid="event-workflow-deadline-after"
            value={wf.deadline?.afterMinutes ?? ''}
            onChange={(e) => onPut({ ...wf, deadline: { afterMinutes: Math.round(Number(e.target.value)) } })} />
          <span className="admin-field-hint">{t('admin.workflowEditor.deadlineAfterHelp')}</span>
        </label>
      )}
      {wf.on === 'event-received' && name && <EventTriggerPanel workflow={name} typeKey={wf.types?.[0]} assistant={assistant} />}
      <fieldset className="admin-filter-group" data-testid="event-workflow-types">
        <legend className="admin-field-label">{t('admin.workflowEditor.types')}</legend>
        {listed.map((type) => (
          <label key={type} className="admin-check">
            <input type="checkbox" data-testid={`event-workflow-type-${type}`} checked={(wf.types ?? []).includes(type)}
              onChange={(e) => setTypes(e.target.checked ? [...(wf.types ?? []), type] : (wf.types ?? []).filter((x) => x !== type))} />
            <code>{type}</code>
          </label>
        ))}
        <span className="admin-field-hint">{t('admin.workflowEditor.typesHelp')}{wf.on === 'conversation-opened' ? ` ${t('admin.workflowEditor.typesOpenedHelp')}` : ''}{wf.on === 'event-received' ? ` ${t('admin.workflowEditor.typesEventHelp')}` : ''}</span>
        {leftOut.length > 0 && (
          <span className="admin-field-hint" data-testid="event-workflow-types-left-out">
            {t('admin.workflowEditor.typesLeftOut')}{' '}
            {leftOut.map((x, i) => (
              <span key={x.type} data-testid={`event-workflow-type-left-out-${x.type}`}>
                {i > 0 ? '; ' : ''}<code>{x.type}</code> ({t(`admin.workflowEditor.typeLeftOut_${x.reason}`, { classification: classification ?? '' })})
              </span>
            ))}
          </span>
        )}
      </fieldset>
      {requiredWelcome && <span className="admin-field-hint" data-testid="event-workflow-required">{t('admin.workflowEditor.requiredWelcome')}</span>}
      <button type="button" className="btn-secondary" data-testid="event-workflow-remove" onClick={onRemove}>
        {requiredWelcome ? t('admin.workflowEditor.removeWelcome') : t('admin.workflowEditor.remove')}
      </button>
    </div>
  );
};

/**
 * ONE STEP'S CONTROLS: its name, its kind, the fields its kind has, its own condition and its edges. The list editor shows
 * one per step, and the visual builder shows the selected step's as its inspector. `testId` prefixes every control.
 */
export const StepFields: React.FC<WorkflowOptions & {
  wf: EventWorkflow;
  stepKey: string;
  testId: string;
  onChange: (def: EventStepDef) => void;
  /** A change to the whole workflow, for an edit that adds or removes a step around this one (a meeting's offer). */
  onWorkflow?: (wf: EventWorkflow) => void;
  onRename: (to: string) => void;
  /** Controls the view adds beside the name and kind (the list's move and remove). */
  headerExtra?: React.ReactNode;
  /** The form around it decides the steps, so a step's name, kind, condition and next step are the workflow builder's alone. */
  fixedIdentity?: boolean;
}> = ({ wf, stepKey: key, testId, onChange, onWorkflow, onRename, headerExtra, fixedIdentity, templates, tools, published, variables, versionTools, classification, welcomeContext }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const audienceLabel = useAudienceLabel();
  const def = wf.states[key];
  const keys = Object.keys(wf.states);
  const { messages, prompts } = templateNames(templates);
  // AN AGENT STEP IS THE ASSISTANT'S OWN TURN (WT118), so it uses only the version's own tools.
  const agentTools = stepReadTools(tools, versionTools, true);
  const promptTools = stepReadTools(tools, versionTools, true);
  /** A tool the step names that it may not use, said so it can be cleared rather than refused at Validate. */
  const dropped = (named: string[] | undefined, offered: ToolDescriptor[]) => (named ?? []).filter((x) => !offered.some((d) => d.name === x)).map((x) => (
    <span key={x} role="alert" className="admin-field-hint" data-testid={`${testId}-tool-dropped-${x}`}>{t('admin.workflowEditor.toolDropped', { tool: x })}</span>
  ));
  const opensOffered = Object.keys(CONVERSATION_TYPES).filter((type) => CONVERSATION_TYPES[type].initiation !== 'system'
    && (!classification || classificationAllowedForType(type, classification)));
  const sourceOf = (name: string) => (templates ?? []).find((x) => x.name === name)?.source;
  const fieldsOf = (name: string): string[] => {
    try { return Object.keys(parseTemplate(sourceOf(name) ?? '').fields ?? {}); } catch { return []; }
  };
  const update = (next: EventStepDef) => onChange(next);
  /** A step of this run opens a conversation whose own run a wait may wait on (an open step that is not a move). */
  const opensChild = Object.values(wf.states).some((d) => !!d.open && d.open.mode !== 'move');
  /** A task step of this run goes on alongside its task, whose settlement a wait may wait on. */
  const goesAlongside = Object.values(wf.states).some((d) => d.task?.continue === TASK_STEP_ALONGSIDE);
  if (!def) return null;
  const kind = kindOf(def);

  /** A send's preview: each field a sample, and each mention field a sample name rendered inert, as the runtime does. */
  const sendPreview = (send: SendStep): string => {
    const src = sourceOf(send.template);
    if (!src) return '';
    let fields: Record<string, unknown> = {};
    try { fields = parseTemplate(src).fields ?? {}; } catch { return ''; }
    const values = Object.fromEntries(Object.entries(fields).map(([f, b]) => [f, sampleValue(f, String(b))]));
    for (const field of Object.keys(send.mention ?? {})) values[field] = inertMention(t('admin.workflowEditor.sampleName'));
    const r = previewMessageTemplate(src, values);
    if ('error' in r) return r.error;
    return r.sections.chat ?? Object.values(r.sections)[0] ?? '';
  };

  /**
   * The participant roles a send may address or mention: the roles the workflow's declared types declare addressable,
   * or every registered type's when it declares none (validated against the conversation's type at run time). A role
   * already bound stays listed, so a stored workflow always shows what it names.
   */
  const roleKeys = (current?: string): string[] => {
    const all = declaredParticipantRoleNames(wf.types?.length ? wf.types : undefined, { audienceOnly: true }).map((r) => `participantRole:${r}`);
    return current?.startsWith('participantRole:') && !all.includes(current) ? [...all, current] : all;
  };

  /** The mention bindings of a send: each template field bound to the person whose name it renders. */
  const mentionEditor = (send: SendStep, onSend: (next: SendStep) => void, id: string) => {
    const bound = send.mention ?? {};
    const free = fieldsOf(send.template).filter((f) => !(f in bound));
    // A new mention names the event's own person, else a role's holders; an event that names neither offers none.
    const mentionDefault = (mentionSourcesAt(wf.on)[0] ?? roleKeys()[0]) as MentionSource | undefined;
    const set = (next: Record<string, MentionSource>) => {
      const { mention: _m, ...rest } = send;
      onSend(Object.keys(next).length ? { ...rest, mention: next } : rest);
    };
    return (
      <div data-testid={id}>
        <span className="admin-field-label">{t('admin.workflowEditor.mentions')}</span>
        {Object.entries(bound).map(([field, source]) => (
          <div key={field} className="admin-filter-group">
            <code>{field}</code>
            <select className="select" aria-label={t('admin.workflowEditor.mentionSource', { field })} data-testid={`${id}-${field}`} value={source}
              onChange={(e) => set({ ...bound, [field]: e.target.value as MentionSource })}>
              {mentionSourcesAt(wf.on, source).map((m) => <option key={m} value={m}>{t(`admin.workflowEditor.mention_${m.replace(':', '_')}`)}</option>)}
              {roleKeys(source).map((k) => <option key={k} value={k}>{t('admin.workflowEditor.mention_participantRole', { role: k.slice('participantRole:'.length) })}</option>)}
            </select>
            <button type="button" className="btn-secondary" data-testid={`${id}-${field}-remove`} onClick={() => {
              const { [field]: _gone, ...rest } = bound;
              set(rest);
            }}>{t('admin.workflowEditor.mentionRemove')}</button>
          </div>
        ))}
        {free.length > 0 && mentionDefault && (
          <select className="select" aria-label={t('admin.workflowEditor.mentionAdd')} data-testid={`${id}-add`} value=""
            onChange={(e) => e.target.value && set({ ...bound, [e.target.value]: mentionDefault })}>
            <option value="" className="select-placeholder" disabled hidden>{t('admin.workflowEditor.mentionAdd')}</option>
            {free.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
        <span className="admin-field-hint">{t('admin.workflowEditor.mentionHelp')}</span>
        {sourceOf(send.template) && <pre className="admin-welcome-preview" data-testid={`${id}-preview`}>{sendPreview(send)}</pre>}
      </div>
    );
  };

  const templatePicker = (value: string, options: string[], onPick: (v: string) => void, id: string) => (
    <>
      <select className="select" data-testid={id} value={value} onChange={(e) => onPick(e.target.value)}>
        {!options.includes(value) && <option value={value}>{value ? t('admin.assistantPage.help.welcomePromptUnlisted', { name: value }) : ''}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {sourceOf(value) && <pre className="admin-welcome-preview">{promptPreview(sourceOf(value)!)}</pre>}
    </>
  );
  const conditionProps = { published, variables, event: wf.on, only: (src: PickableSource) => routerHoldsAt(src.source, wf.on), hiddenNote: t('admin.workflowEditor.routerReads', { event: wf.on }) };
  /**
   * An outcome edge: a step, or a list of { to, when } alternatives whose last carries no condition. Choosing
   * "conditioned" keeps the current step as the alternative taken otherwise; each alternative added goes before it.
   */
  const edgePicker = (label: string, value: EventEdge | undefined, onPick: (v: EventEdge | undefined) => void, id: string) => {
    const targets = keys.filter((k) => k !== key);
    const conditioned = value !== undefined && typeof value !== 'string';
    const mode = conditioned ? '__conditioned' : value ?? '';
    const list: ConditionedEdge[] = conditioned ? [...(value as readonly ConditionedEdge[])] : [];
    const selects = conditioned ? edgeAudience(list, wf.states) : 'addressed';
    const setAlt = (i: number, next: ConditionedEdge | undefined) => {
      const out = next ? list.map((alt, j) => (j === i ? next : alt)) : list.filter((_, j) => j !== i);
      onPick(out.length === 1 && out[0].when === undefined ? out[0].to : out.length ? out : undefined);
    };
    return (
      <div data-testid={id}>
        <label><span className="admin-field-label">{label}</span>
          <select className="select" data-testid={`${id}-mode`} value={mode} onChange={(e) => {
            const v = e.target.value;
            if (v === '__conditioned') onPick([{ to: (typeof value === 'string' && value) || targets[0] || '' }]);
            else onPick(v || undefined);
          }}>
            <option value="">{t('admin.workflowEditor.edgeNone')}</option>
            {targets.map((k) => <option key={k} value={k}>{k}</option>)}
            <option value="__conditioned">{t('admin.workflowEditor.edgeConditionedOption')}</option>
          </select>
        </label>
        {conditioned && (
          <ol data-testid={`${id}-alternatives`}>
            {list.map((alt, i) => {
              const last = i === list.length - 1;
              return (
                <li key={i} data-testid={`${id}-alt-${i}`}>
                  <span className="admin-field-label">{t(last ? 'admin.workflowEditor.edgeOtherwise' : 'admin.workflowEditor.edgeWhen')}</span>
                  <select className="select" data-testid={`${id}-alt-${i}-to`} aria-label={t('admin.workflowEditor.edgeTo')} value={alt.to}
                    onChange={(e) => setAlt(i, { ...alt, to: e.target.value })}>
                    {!targets.includes(alt.to) && <option value={alt.to}>{alt.to}</option>}
                    {targets.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  {!last && (
                    <>
                      <ConditionBuilder value={alt.when} selects={selects} testId={`${id}-alt-${i}-when`} {...conditionProps}
                        onChange={(when) => setAlt(i, when === undefined ? { to: alt.to } : { to: alt.to, when })} />
                      <button type="button" className="btn-secondary" data-testid={`${id}-alt-${i}-remove`} onClick={() => setAlt(i, undefined)}>
                        {t('admin.workflowEditor.edgeRemoveAlternative')}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {conditioned && (
          <button type="button" className="btn-secondary" data-testid={`${id}-add-alternative`}
            onClick={() => onPick([...list.slice(0, -1), { to: targets[0] ?? '' }, list[list.length - 1]])}>
            {t('admin.workflowEditor.edgeAddAlternative')}
          </button>
        )}
      </div>
    );
  };

  const insertOpeningField = (name: string) => {
    const text = def.opening!.text ?? '';
    update({ ...def, opening: { ...def.opening!, text: text && !text.endsWith('\n') ? `${text} {{${name}}}` : `${text}{{${name}}}` } });
  };

  return (
    <>
      {!fixedIdentity && <div className="admin-filter-group">
        <label><span className="admin-field-label">{t('admin.workflowEditor.stepName')}</span>
          <input type="text" className="input" defaultValue={key} aria-label={t('admin.workflowEditor.stepName')} data-testid={`${testId}-name`}
            onBlur={(e) => onRename(e.target.value.trim())} />
        </label>
        <label><span className="admin-field-label">{t('admin.workflowEditor.kind')}</span>
          <select className="select" data-testid={`${testId}-kind`} value={kind}
            onChange={(e) => (onWorkflow
              ? onWorkflow(changeStepKind(wf, key, e.target.value as Kind, messages, prompts))
              : update(convertStep(def, e.target.value as Kind, messages, prompts, wf.on, wf.types)))}>
            {[...new Set([...kindsFor(wf.on, wf.types), kind])].map((k) => <option key={k} value={k}>{t(`admin.workflowEditor.kind_${k}`)}</option>)}
          </select>
        </label>
        {headerExtra}
      </div>}
      {def.send && (
        <div className="admin-filter-group">
          <label><span className="admin-field-label">{t('admin.workflowEditor.audience')}</span>
            <select className="select" data-testid={`${testId}-audience`} value={audienceKey(def.send.to)} onChange={(e) => update({ ...def, send: { ...def.send!, to: audienceOf(e.target.value) } })}>
              {[...audiencesAt(wf.on, 'send', audienceKey(def.send.to)), ...roleKeys(audienceKey(def.send.to))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.template')}</span>
            {templatePicker(def.send.template, messages, (v) => update({ ...def, send: { ...def.send!, template: v } }), `${testId}-template`)}
          </label>
          {mentionEditor(def.send, (send) => update({ ...def, send }), `${testId}-mention`)}
          {/* SAID IN THE CONVERSATION THAT OPENED THIS ONE (O24), set in the version's JSON. */}
          {def.send.in === 'opener' && (
            <span className="admin-field-hint" data-testid={`${testId}-in-opener`}>{t('admin.workflowEditor.sendInOpener')}</span>
          )}
          {/* SAID IN THE CONVERSATION THIS RUN'S OWN OPEN STEP OPENED (O33), set in the version's JSON. */}
          {def.send.in === 'opened' && (
            <span className="admin-field-hint" data-testid={`${testId}-in-opened`}>{t('admin.workflowEditor.sendInOpened')}</span>
          )}
          {def.send.to !== 'room' && (
            <label>
              <input type="checkbox" data-testid={`${testId}-from-role`} checked={def.send.fromRole === 'template'}
                onChange={(e) => { const { fromRole: _f, ...rest } = def.send!; update({ ...def, send: e.target.checked ? { ...rest, fromRole: 'template' } : rest }); }} />
              {' '}{t('admin.workflowEditor.fromRoleTemplate')}
            </label>
          )}
        </div>
      )}
      {def.agent && (
        <div className="admin-filter-group">
          <label><span className="admin-field-label">{t('admin.workflowEditor.prompt')}</span>
            {templatePicker(def.agent.prompt, prompts, (v) => update({ ...def, agent: { ...def.agent!, prompt: v } }), `${testId}-prompt`)}
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.audience')}</span>
            <select className="select" data-testid={`${testId}-agent-audience`} value={audienceKey(def.agent.to)} onChange={(e) => update({ ...def, agent: { ...def.agent!, to: audienceOf(e.target.value) } })}>
              {[...audiencesAt(wf.on, 'agent', audienceKey(def.agent.to)), ...roleKeys(audienceKey(def.agent.to))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
            </select>
          </label>
          {/* THE ROOM'S MESSAGES are read only where the step's reader reads the room: never at an invitation's events, and
              never by a step whose draft reaches someone outside it. One already set stays shown, so it can be cleared. */}
          {(def.agent.reads === 'messages' || (!isInvitationEvent(wf.on) && !agentStepIsNarrowed(def.agent))) && (
            <label>
              <input type="checkbox" data-testid={`${testId}-reads`} checked={def.agent.reads === 'messages'}
                onChange={(e) => { const { reads: _r, ...rest } = def.agent!; update({ ...def, agent: e.target.checked ? { ...rest, reads: 'messages' } : rest }); }} />
              {' '}{t('admin.workflowEditor.readsMessages')}
            </label>
          )}
          {def.agent.to === 'room' && (
            <label><span className="admin-field-label">{t('admin.workflowEditor.opensTask')}</span>
              <select className="select" data-testid={`${testId}-opens-task`} value={def.agent.workflow ?? ''}
                onChange={(e) => { const { workflow: _w, ...rest } = def.agent!; update({ ...def, agent: e.target.value ? { ...rest, workflow: e.target.value } : rest }); }}>
                <option value="">{t('admin.workflowEditor.opensTask_none')}</option>
                {EVENT_TASK_MACHINES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="admin-field-hint">{t('admin.workflowEditor.opensTaskHelp')}</span>
            </label>
          )}
          {['joined', 'subject', 'event:person', 'invitation:inviter'].includes(audienceKey(def.agent.to)) && (
            <label>
              <input type="checkbox" data-testid={`${testId}-from-role`} checked={def.agent.fromRole === 'brief'}
                onChange={(e) => { const { fromRole: _f, ...rest } = def.agent!; update({ ...def, agent: e.target.checked ? { ...rest, fromRole: 'brief' } : rest }); }} />
              {' '}{t('admin.workflowEditor.fromRoleBrief')}
            </label>
          )}
          <label><span className="admin-field-label">{t('admin.workflowEditor.deadline', { max: MAX_AGENT_DEADLINE_MS / 1000 })}</span>
            <input type="number" className="input" min={1} max={MAX_AGENT_DEADLINE_MS / 1000} data-testid={`${testId}-deadline`}
              value={Math.round(def.agent.deadlineMs / 1000)}
              onChange={(e) => update({ ...def, agent: { ...def.agent!, deadlineMs: Math.round(Number(e.target.value) * 1000) } })} />
          </label>
          <div>
            <span className="admin-field-label">{t('admin.workflowEditor.tools')}</span>
            {agentTools.map((d) => (
              <label key={d.name} className="admin-check" title={d.description}>
                <input type="checkbox" checked={(def.agent!.tools ?? []).includes(d.name)} onChange={(e) => update({
                  ...def,
                  agent: { ...def.agent!, tools: e.target.checked ? [...(def.agent!.tools ?? []), d.name] : (def.agent!.tools ?? []).filter((x) => x !== d.name) },
                })} />
                <code>{d.name}</code>
              </label>
            ))}
            {!agentTools.length && <span className="admin-field-hint">{t('admin.workflowEditor.toolsNone')}</span>}
            {dropped(def.agent.tools, agentTools)}
            <span className="admin-field-hint">{t('admin.assistantPage.help.welcomeToolsHelp')}</span>
          </div>
          <label><span className="admin-field-label">{t('admin.workflowEditor.propose')}</span>
            <select className="select" data-testid={`${testId}-propose`} value={def.agent.propose?.[0] ?? ''}
              onChange={(e) => {
                const { propose: _p, opens: _o, ...rest } = def.agent!;
                const op = e.target.value;
                update({ ...def, agent: op ? { ...rest, propose: [op], ...(op === 'open_conversation' ? { opens: def.agent!.opens ?? '' } : {}) } : rest });
              }}>
              <option value="">{t('admin.workflowEditor.propose_none')}</option>
              {Object.keys(PROPOSAL_OPS).filter((op) => (PROPOSAL_OPS[op as keyof typeof PROPOSAL_OPS].events as readonly string[]).includes(wf.on)).map((op) => (
                <option key={op} value={op}>{t(`admin.workflowEditor.propose_${op}`)}</option>
              ))}
            </select>
            <span className="admin-field-hint">{t('admin.workflowEditor.proposeHelp')}</span>
          </label>
          {def.agent.propose?.[0] === 'open_conversation' && (
            <label><span className="admin-field-label">{t('admin.workflowEditor.opens')}</span>
              <select className="select" data-testid={`${testId}-opens`} value={def.agent.opens ?? ''}
                onChange={(e) => update({ ...def, agent: { ...def.agent!, opens: e.target.value } })}>
                <option value="" className="select-placeholder" disabled hidden>{t('admin.workflowEditor.opensPick')}</option>
                {[...opensOffered, ...(def.agent.opens && !opensOffered.includes(def.agent.opens) ? [def.agent.opens] : [])].map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <span className="admin-field-hint">{t('admin.workflowEditor.opensHelp')}</span>
            </label>
          )}
          <label><span className="admin-field-label">{t('admin.workflowEditor.fallback')}</span>
            {templatePicker(def.agent.fallback.send.template, messages, (v) => update({
              ...def, agent: { ...def.agent!, fallback: { ...def.agent!.fallback, send: { ...def.agent!.fallback.send, template: v } } },
            }), `${testId}-fallback`)}
          </label>
          {/* A step another assistant takes (`as`) keeps its role and its absent message through every edit. */}
          {mentionEditor(def.agent.fallback.send, (send) => update({ ...def, agent: { ...def.agent!, fallback: { ...def.agent!.fallback, send } } }), `${testId}-fallback-mention`)}
        </div>
      )}
      {def.opening && (
        <div className="admin-filter-group" data-testid={`${testId}-opening`}>
          <label><span className="admin-field-label">{t('admin.workflowEditor.openingText')}</span>
            <textarea className="textarea" rows={3} data-testid={`${testId}-opening-text`} value={def.opening.text ?? ''}
              onChange={(e) => { const { text: _x, ...rest } = def.opening!; update({ ...def, opening: e.target.value.trim() ? { ...rest, text: e.target.value } : rest }); }} />
            <MarkdownHelp testId={`${testId}-opening-markdown`} />
          </label>
          <span className="admin-field-hint">{t('admin.workflowEditor.openingHelp')}</span>
          {/* THE WELCOME'S OWN AIDS, on its opening step: the fields it may name and a preview of what the room reads, through
              the router's selection and renderer, for this workflow in the first type it names. */}
          {/* AT A JOIN THE ROUTER HOLDS ONLY THE CONVERSATION'S CLASSIFICATION AND TYPE (`routerHeldVariables`): any other
              variable says its fallback, so one with neither is not offered. */}
          {unknownOpeningFields(def.opening.text, variables).length > 0 && (
            <span role="alert" className="admin-field-hint" data-testid={`${testId}-opening-unknown`}>
              {t('admin.workflowEditor.openingUnknown', { fields: unknownOpeningFields(def.opening.text, variables).map((f) => `{{${f}}}`).join(', ') })}
            </span>
          )}
          <VariablePicker variablesOnly published={published} variables={variables} purpose="insert" audience="room" testId={`${testId}-opening-variable`}
            only={(src, row) => !!row.variable && (src.source === 'conversation:classification' || src.source === 'conversation:type' || variables?.[row.variable]?.fallback !== undefined)}
            builtIns={WELCOME_TOKENS.map((name) => ({ name, help: t(`admin.welcome.token.${name}`) }))}
            onPickBuiltIn={insertOpeningField}
            onPick={insertOpeningField} />
          <WelcomeEditorGuide workflows={{ [wf.types?.length ? 'typed' : 'default']: wf }} conversationType={wf.types?.[0]}
            classification={classification} role={welcomeContext?.role}
            context={{ ...welcomeContext, classification, published, variables }} />
        </div>
      )}
      {def.prompt && (
        <div className="admin-filter-group" data-testid={`${testId}-prompt-step`}>
          <label><span className="admin-field-label">{t('admin.workflowEditor.prompt')}</span>
            {templatePicker(def.prompt.template, prompts, (v) => update({ ...def, prompt: { ...def.prompt!, template: v } }), `${testId}-prompt-template`)}
          </label>
          <div>
            <span className="admin-field-label">{t('admin.workflowEditor.tools')}</span>
            {promptTools.map((d) => (
              <label key={d.name} className="admin-check" title={d.description}>
                <input type="checkbox" checked={(def.prompt!.tools ?? []).includes(d.name)} onChange={(e) => {
                  const now = def.prompt!.tools ?? [];
                  const next = e.target.checked ? [...now, d.name] : now.filter((x) => x !== d.name);
                  const { tools: _x, ...rest } = def.prompt!;
                  update({ ...def, prompt: next.length ? { ...rest, tools: next } : rest });
                }} />
                <code>{d.name}</code>
              </label>
            ))}
          </div>
          {!promptTools.length && <span className="admin-field-hint">{t('admin.workflowEditor.toolsNone')}</span>}
          {dropped(def.prompt.tools, promptTools)}
          <span className="admin-field-hint">{t('admin.workflowEditor.promptStepHelp')}</span>
        </div>
      )}
      {/* A WAIT (WT20): how long the run holds here before it goes on, until a time a task of the run recorded, until the
          conversation the run opened has ended its own run, which is offered only where a step of the run opens one, or until the
          tasks the run went on alongside have settled, offered only where a step goes on alongside its task (WT129). */}
      {/* A JOIN (`wait: { join }`) is said, with where its parts are edited, and no other wait's field is offered over it. */}
      {def.wait?.join && (
        <div className="admin-wfb-field">
          <span className="admin-field-hint" data-testid={`${testId}-wait-join`}>
            {t(def.wait.join.when === 'any' ? 'admin.workflowEditor.waitJoinAny' : 'admin.workflowEditor.waitJoinAll', { parts: def.wait.join.of.join(', ') })}
          </span>
        </div>
      )}
      {def.wait && !def.wait.join && (
        <div className="admin-wfb-field">
          {(def.wait.child !== undefined || opensChild || def.wait.alongside !== undefined || goesAlongside) && (
            <label><span className="admin-field-label">{t('admin.workflowEditor.waitFor')}</span>
              <select className="select" data-testid={`${testId}-wait-for`} value={def.wait.child !== undefined ? 'child' : def.wait.alongside !== undefined ? 'alongside' : 'time'}
                onChange={(e) => update({ ...def, wait: e.target.value === 'child' ? { child: WAIT_CHILD_VALUES[0] } : e.target.value === 'alongside' ? { alongside: WAIT_ALONGSIDE_VALUES[0] } : { minutes: 60 } })}>
                <option value="time">{t('admin.workflowEditor.waitFor_time')}</option>
                {(def.wait.child !== undefined || opensChild) && <option value="child">{t('admin.workflowEditor.waitFor_child')}</option>}
                {(def.wait.alongside !== undefined || goesAlongside) && <option value="alongside">{t('admin.workflowEditor.waitFor_alongside')}</option>}
              </select>
            </label>
          )}
          {def.wait.child !== undefined && <span className="admin-field-hint" data-testid={`${testId}-wait-child`}>{t('admin.workflowEditor.waitChildHelp')}</span>}
          {def.wait.alongside !== undefined && <span className="admin-field-hint" data-testid={`${testId}-wait-alongside`}>{t('admin.workflowEditor.waitAlongsideHelp')}</span>}
          {def.wait.child === undefined && def.wait.until === undefined && def.wait.alongside === undefined && (
            <label><span className="admin-field-label">{t('admin.workflowEditor.waitMinutes', { max: MAX_WAIT_MINUTES })}</span>
              <input type="number" className="input" min={1} max={MAX_WAIT_MINUTES} data-testid={`${testId}-wait-minutes`} value={def.wait.minutes ?? ''}
                onChange={(e) => update({ ...def, wait: { minutes: Math.round(Number(e.target.value)) } })} />
            </label>
          )}
          {def.wait.child === undefined && def.wait.alongside === undefined && <label><span className="admin-field-label">{t('admin.workflowEditor.waitUntil')}</span>
            <input type="text" className="input" data-testid={`${testId}-wait-until`} value={def.wait.until ?? ''} placeholder={t('admin.workflowEditor.recordedTimePlaceholder')}
              onChange={(e) => {
                const until = e.target.value.trim();
                update({ ...def, wait: until ? { until } : { minutes: 60 } });
              }} />
          </label>}
          <span className="admin-field-hint">{t('admin.workflowEditor.waitHelp')}</span>
        </div>
      )}
      {def.task && (
        <div className="admin-filter-group" data-testid={`${testId}-task`}>
          {/* A REQUEST NAMES AN INTENT ITS OWNER ADVERTISES (WT118), single-turn or multi-step, which this version's machines say nothing about. */}
          {workerAssistantRole(def.task.by) ? (
            <label><span className="admin-field-label">{t('admin.workflowEditor.taskIntent')}</span>
              <input type="text" className="input" data-testid={`${testId}-task-intent`} value={def.task.machine}
                onChange={(e) => update({ ...def, task: { ...def.task!, machine: e.target.value.trim() } })} />
            </label>
          ) : (
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskMachine')}</span>
            <select className="select" data-testid={`${testId}-task-machine`} value={def.task.machine}
              onChange={(e) => {
                // A FORM HAS FIELDS (WT50): opening one starts with a written answer; leaving it drops them.
                const { fields: _f, ...task } = def.task!;
                const machine = e.target.value;
                update({ ...def, task: machine === FORM_MACHINE ? { ...task, machine, fields: def.task!.fields ?? [{ name: 'answer', type: FORM_FIELD_TYPES[0], required: true }] } : { ...task, machine } });
              }}>
              {[...new Set([...TASK_MACHINES, def.task.machine])].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          )}
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskFor')}</span>
            <select className="select" data-testid={`${testId}-task-for`} value={taskRefKey(def.task.for)}
              onChange={(e) => { const { for: _f, ...rest } = def.task!; const ref = taskRefOf(e.target.value) as TaskPerson | undefined; update({ ...def, task: ref ? { ...rest, for: ref } : rest }); }}>
              <option value="">{t('admin.workflowEditor.taskForNobody')}</option>
              {[...audiencesAt(wf.on, 'task', taskRefKey(def.task.for)), ...roleKeys(taskRefKey(def.task.for))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskBy')}</span>
            <select className="select" data-testid={`${testId}-task-by`} value={taskRefKey(def.task.by)}
              onChange={(e) => { const { by: _b, ...rest } = def.task!; const ref = taskRefOf(e.target.value); update({ ...def, task: ref ? { ...rest, by: ref } : rest }); }}>
              <option value="">{t('admin.workflowEditor.taskByThisAssistant')}</option>
              {[...audiencesAt(wf.on, 'task', taskRefKey(def.task.by)), ...roleKeys(taskRefKey(def.task.by))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
              {taskRefKey(def.task.by).startsWith('assistantRole:') && <option value={taskRefKey(def.task.by)}>{taskRefKey(def.task.by)}</option>}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskAssistantRole')}</span>
            <input type="text" className="input" data-testid={`${testId}-task-assistant-role`} defaultValue={workerAssistantRole(def.task.by) ?? ''}
              onBlur={(e) => {
                const role = e.target.value.trim();
                const { by: _b, ...rest } = def.task!;
                if (role) {
                  // A REQUEST TO ANOTHER ASSISTANT'S ROLE (WT118): who sees the work, its urgency, its form and its deadline are
                  // the owning assistant's, so they leave the step, and with them the deadline's edge.
                  // A request goes on once the work starts or once it ends, never alongside it, which is a task of the run's own.
                  const asked = Object.fromEntries(Object.entries(rest).filter(([f, v]) => !(OWNER_DECIDED_STEP_FIELDS as readonly string[]).includes(f)
                    && !(f === 'continue' && v === TASK_STEP_ALONGSIDE))) as typeof rest;
                  const { onDeadline: _od, ...step } = def as typeof def & { onDeadline?: unknown };
                  update({ ...step, task: { ...asked, by: { assistantRole: role } } });
                } else if (workerAssistantRole(def.task!.by)) {
                  const { ask: _a, ...own } = rest as typeof rest & { ask?: unknown };
                  update({ ...def, task: own });
                }
              }} />
          </label>
          {workerAssistantRole(def.task.by) ? (
            <>
              {/* WHAT IS NEEDED (WT118): one of this assistant's message templates, handed to the owning assistant as the request. */}
              <label><span className="admin-field-label">{t('admin.workflowEditor.taskAsk')}</span>
                <select className="select" data-testid={`${testId}-task-ask`} value={def.task.ask?.template ?? ''}
                  onChange={(e) => { const { ask: _a, ...task } = def.task!; update({ ...def, task: e.target.value ? { ...task, ask: { template: e.target.value } } : task }); }}>
                  <option value="">{t('admin.workflowEditor.taskAskNone')}</option>
                  {[...new Set([...messages, ...(def.task.ask?.template ? [def.task.ask.template] : [])])].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <p className="admin-field-hint" data-testid={`${testId}-task-owner-decides`}>{t('admin.workflowEditor.taskOwnerDecides')}</p>
            </>
          ) : (<>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskVisibility')}</span>
            <select className="select" value={def.task.visibility ?? 'private'}
              onChange={(e) => update({ ...def, task: { ...def.task!, visibility: e.target.value as 'private' | 'conversation' } })}>
              <option value="private">{t('admin.workflowEditor.taskVisibility_private')}</option>
              <option value="conversation">{t('admin.workflowEditor.taskVisibility_conversation')}</option>
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskPriority')}</span>
            <select className="select" value={def.task.priority ?? 'normal'}
              onChange={(e) => update({ ...def, task: { ...def.task!, priority: e.target.value as TaskStep['priority'] } })}>
              {TASK_PRIORITIES.map((pr) => <option key={pr} value={pr}>{t(`admin.workflowEditor.taskPriority_${pr}`)}</option>)}
            </select>
          </label>
          </>)}
          {/* WHEN THE RUN GOES ON (WT18): at the task's ending, or once it leaves its first step, so a resting task never holds the run. */}
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskContinue')}</span>
            <select className="select" data-testid={`${testId}-task-continue`} value={def.task.continue ?? ''}
              onChange={(e) => {
                const { continue: _c, ...task } = def.task!;
                // A REQUEST WAITS AS LONG AS THE OWNING ASSISTANT'S OWN DEADLINE SAYS (WT118), so it takes none of its own.
                const toRole = !!workerAssistantRole(task.by);
                // ALONGSIDE, THE RUN ENDS ONLY ONCE THE TASK HAS (a task of the run's own), so the task keeps a deadline that ends it.
                const deadlined = { ...task, deadline: task.deadline ?? { afterMinutes: 1440 } };
                update({ ...def, task: e.target.value === OPENED ? { ...task, continue: OPENED } : e.target.value === TASK_STEP_ALONGSIDE ? { ...deadlined, continue: TASK_STEP_ALONGSIDE } : toRole ? task : deadlined });
              }}>
              <option value="">{t('admin.workflowEditor.taskContinue_settled')}</option>
              <option value={OPENED}>{t('admin.workflowEditor.taskContinue_opened')}</option>
              {(!workerAssistantRole(def.task.by) || def.task.continue === TASK_STEP_ALONGSIDE) && <option value={TASK_STEP_ALONGSIDE}>{t('admin.workflowEditor.taskContinue_alongside')}</option>}
            </select>
            {def.task.continue === TASK_STEP_ALONGSIDE && <span className="admin-field-hint" data-testid={`${testId}-task-alongside`}>{t('admin.workflowEditor.taskContinueAlongsideHelp')}</span>}
          </label>
          {!workerAssistantRole(def.task.by) && (<>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskDeadline', { min: MIN_TASK_DEADLINE_MINUTES, max: MAX_TASK_DEADLINE_MINUTES })}</span>
            <input type="number" className="input" min={MIN_TASK_DEADLINE_MINUTES} max={MAX_TASK_DEADLINE_MINUTES} data-testid={`${testId}-task-deadline`}
              value={def.task.deadline?.afterMinutes ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const { deadline: _d, ...task } = def.task!;
                // A step that goes on once its task opens may leave the deadline out; one that waits on the task never does.
                const leftOut = !raw && task.continue === OPENED;
                update({ ...def, task: leftOut ? task : { ...task, deadline: { afterMinutes: Math.round(Number(raw)) } } });
              }} />
            {def.task.continue === OPENED && <span className="admin-field-hint">{t('admin.workflowEditor.taskDeadlineOptional')}</span>}
          </label>
          {/* OR AT A TIME AN EARLIER TASK OF THE RUN RECORDED (WT21), never a reminder's. */}
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskDeadlineAt')}</span>
            <input type="text" className="input" data-testid={`${testId}-task-deadline-at`} value={def.task.deadline?.at ?? ''} placeholder={t('admin.workflowEditor.recordedTimePlaceholder')}
              onChange={(e) => {
                const at = e.target.value.trim();
                const { deadline: _d, ...task } = def.task!;
                const kind = def.task!.deadline?.kind;
                update({ ...def, task: at ? { ...task, deadline: { at, ...(kind && kind !== 'remind' ? { kind } : {}) } } : { ...task, deadline: { afterMinutes: 1440 } } });
              }} />
          </label>
          </>)}
          {/* A FORM'S FIELDS (WT50): each a name and what it takes, shown on the card of the person the form is for. */}
          {def.task.machine === FORM_MACHINE && (
            <fieldset className="admin-wfb-field" data-testid={`${testId}-form-fields`}>
              <legend className="admin-field-label">{t('admin.workflowEditor.formFields', { max: MAX_FORM_FIELDS })}</legend>
              {(def.task.fields ?? []).map((f, i) => {
                const put = (next: FormField | null) => {
                  const list = [...(def.task!.fields ?? [])];
                  if (next) list[i] = next; else list.splice(i, 1);
                  update({ ...def, task: { ...def.task!, fields: list } });
                };
                return (
                  <div key={i} className="admin-filter-group" data-testid={`${testId}-form-field-${i}`}>
                    <input className="input" aria-label={t('admin.workflowEditor.formFieldName')} value={f.name}
                      onChange={(e) => put({ ...f, name: e.target.value.trim() })} />
                    <select className="select" aria-label={t('admin.workflowEditor.formFieldType')} value={f.type}
                      onChange={(e) => put({ ...f, type: e.target.value as FormField['type'] })}>
                      {FORM_FIELD_TYPES.map((ty) => <option key={ty} value={ty}>{t(`admin.workflowEditor.formFieldType_${ty}`)}</option>)}
                    </select>
                    <label><input type="checkbox" checked={!!f.required} onChange={(e) => put(e.target.checked ? { ...f, required: true } : { name: f.name, type: f.type })} /> {t('admin.workflowEditor.formFieldRequired')}</label>
                    <button type="button" className="btn-link" onClick={() => put(null)}>{t('admin.workflowEditor.formFieldRemove')}</button>
                  </div>
                );
              })}
              {(def.task.fields ?? []).length < MAX_FORM_FIELDS && (
                <button type="button" className="btn-secondary" data-testid={`${testId}-form-field-add`}
                  onClick={() => update({ ...def, task: { ...def.task!, fields: [...(def.task!.fields ?? []), { name: `field_${(def.task!.fields ?? []).length + 1}`, type: FORM_FIELD_TYPES[0] }] } })}>
                  {t('admin.workflowEditor.formFieldAdd')}
                </button>
              )}
            </fieldset>
          )}
          {/* WHAT THE TIME DOES (WT21): ends the task, is shown as its due time, or reminds whoever holds it. */}
          {def.task.deadline && (
            <label><span className="admin-field-label">{t('admin.workflowEditor.taskDeadlineKind')}</span>
              <select className="select" data-testid={`${testId}-task-deadline-kind`} value={def.task.deadline.kind ?? TIMEOUT}
                onChange={(e) => {
                  const { kind: _k, times: _t, ...deadline } = def.task!.deadline!;
                  const kind = e.target.value as NonNullable<TaskStep['deadline']>['kind'];
                  update({ ...def, task: { ...def.task!, deadline: kind === TIMEOUT ? deadline : { ...deadline, kind } } });
                }}>
                {TASK_DEADLINE_KINDS.map((k) => <option key={k} value={k}>{t(`admin.workflowEditor.taskDeadlineKind_${k}`)}</option>)}
              </select>
            </label>
          )}
          {def.task.deadline?.kind === REMIND && (
            <label><span className="admin-field-label">{t('admin.workflowEditor.taskReminders', { max: MAX_TASK_REMINDERS })}</span>
              <input type="number" className="input" min={1} max={MAX_TASK_REMINDERS} data-testid={`${testId}-task-reminders`}
                value={def.task.deadline.times ?? DEFAULT_TASK_REMINDERS}
                onChange={(e) => update({ ...def, task: { ...def.task!, deadline: { ...def.task!.deadline!, times: Math.round(Number(e.target.value)) } } })} />
            </label>
          )}
          <span className="admin-field-hint">{t('admin.workflowEditor.taskHelp')}</span>
        </div>
      )}
      {def.open && (
        <div className="admin-filter-group" data-testid={`${testId}-open`}>
          <span className="admin-field-label">{t('admin.workflowEditor.openStep', { type: def.open.type })}</span>
          <span className="admin-field-hint">{t('admin.workflowEditor.openHelp')}</span>
        </div>
      )}
      {isMeetingAction(def.action) && (() => {
        const meeting = def.action;
        // ASK FIRST: an offer step in front of this one, a card for the person asked (`askBeforeMeeting`).
        const offerKey = meetingOfferOf(wf, key);
        const offerTask = offerKey ? wf.states[offerKey].task : undefined;
        const askedKey = taskRefKey(offerTask?.by);
        const askOptions = [...new Set([...audiencesAt(wf.on, 'task', askedKey), ...roleKeys(askedKey)])].filter((a) => taskRefOf(a));
        const firstAsk = taskRefKey(taskPersonAt(wf.on, wf.types)) || askOptions[0];
        const ask = (who: string, minutes?: number) => {
          const by = taskRefOf(who) as TaskPerson | undefined;
          if (by && onWorkflow) onWorkflow(askBeforeMeeting(wf, key, by, minutes));
        };
        return (
          <div className="admin-wfb-field" data-testid={`${testId}-meeting`}>
            {onWorkflow && (
              <>
                <label><span className="admin-field-label">{t('admin.workflowEditor.meetingStart')}</span>
                  <select className="select" data-testid={`${testId}-meeting-start`} value={offerKey ? 'ask' : 'auto'}
                    onChange={(e) => (e.target.value === 'ask' ? firstAsk && ask(firstAsk) : onWorkflow(startMeetingAutomatically(wf, key)))}>
                    <option value="auto">{t('admin.workflowEditor.meetingStartAuto')}</option>
                    <option value="ask" disabled={!firstAsk || (!offerKey && atStepLimit(wf))}>{t('admin.workflowEditor.meetingStartAsk')}</option>
                  </select>
                </label>
                {offerKey && (
                  <>
                    <label><span className="admin-field-label">{t('admin.workflowEditor.meetingAskBy')}</span>
                      <select className="select" data-testid={`${testId}-meeting-ask-by`} value={askedKey} onChange={(e) => ask(e.target.value)}>
                        {askOptions.map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
                      </select>
                    </label>
                    <OfferMinutes testId={`${testId}-meeting-ask-minutes`} value={offerTask?.deadline?.afterMinutes ?? MEETING_OFFER_MINUTES}
                      label={t('admin.workflowEditor.meetingAskMinutes', { min: MIN_TASK_DEADLINE_MINUTES, max: MAX_TASK_DEADLINE_MINUTES })}
                      onCommit={(m) => ask(askedKey, m)} />
                  </>
                )}
                <span className="admin-field-hint">{t('admin.workflowEditor.meetingAskHelp')}</span>
              </>
            )}
            <label><span className="admin-field-label">{t('admin.workflowEditor.meetingRing', { min: MIN_RING_SECONDS, max: MAX_RING_SECONDS })}</span>
              <input type="number" className="input" min={MIN_RING_SECONDS} max={MAX_RING_SECONDS} data-testid={`${testId}-meeting-ring`}
                value={meeting.ringSeconds ?? ''} placeholder={t('admin.workflowEditor.meetingRingDefault')}
                onChange={(e) => {
                  const { ringSeconds: _r, ...rest } = meeting;
                  update({ ...def, action: e.target.value === '' ? rest : { ...rest, ringSeconds: Math.round(Number(e.target.value)) } });
                }} />
            </label>
            <label><span className="admin-field-label">{t('admin.workflowEditor.meetingNotice')}</span>
              <select className="select" data-testid={`${testId}-meeting-notice`} value={meeting.notice ?? ''}
                onChange={(e) => { const { notice: _n, ...rest } = meeting; update({ ...def, action: e.target.value ? { ...rest, notice: e.target.value } : rest }); }}>
                <option value="">{t('admin.workflowEditor.meetingNoticeShipped')}</option>
                {[...new Set([...messages, ...(meeting.notice ? [meeting.notice] : [])])].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label><input type="checkbox" data-testid={`${testId}-meeting-email`} checked={!!meeting.email}
              onChange={(e) => { const { email: _e, ...rest } = meeting; update({ ...def, action: e.target.checked ? { ...rest, email: true } : rest }); }} />
              {' '}{t('admin.workflowEditor.meetingEmail')}</label>
            <span className="admin-field-hint">{t('admin.workflowEditor.meetingHelp')}</span>
          </div>
        );
      })()}
      {def.action && !isMeetingAction(def.action) && (
        <div className="admin-filter-group" data-testid={`${testId}-intake`}>
          <span className="admin-field-label">{t('admin.workflowEditor.intakeTo', { who: audienceLabel(audienceKey(def.action.to)) })}</span>
          <span className="admin-field-hint">{t('admin.workflowEditor.intakeHelp')}</span>
        </div>
      )}
      {kind !== 'end' && !fixedIdentity && (
        <div data-testid={`${testId}-when`} id={`${testId}-when`}>
          <span className="admin-field-label">{t('admin.workflowEditor.stepWhen')}</span>
          <span className="admin-field-hint">{t('admin.workflowEditor.stepWhenHelp')}</span>
          <ConditionBuilder value={def.when} testId={`${testId}-when-builder`} {...conditionProps}
            selects={def.task ? 'addressed' : def.opening || def.prompt || audienceKey(def.send?.to ?? def.agent?.to ?? (isMeetingAction(def.action) ? 'room' : def.action?.to)) === 'room' ? 'room' : 'addressed'}
            onChange={(when) => {
              const { when: _old, ...rest } = def;
              update(when === undefined ? rest : { ...rest, when });
            }} />
        </div>
      )}
      {kind !== 'end' && !fixedIdentity && (
        <div className="admin-filter-group">
          {edgePicker(t('admin.workflowEditor.onSuccess'), def.onSuccess, (v) => update({ ...def, onSuccess: v }), `${testId}-success`)}
          {edgePicker(t('admin.workflowEditor.onFailure'), def.onFailure, (v) => update({ ...def, onFailure: v }), `${testId}-failure`)}
          {def.task && edgePicker(t('admin.workflowEditor.onDeadline'), def.onDeadline, (v) => { const { onDeadline: _d, ...rest } = def; update(v === undefined ? rest : { ...rest, onDeadline: v }); }, `${testId}-deadline-edge`)}
        </div>
      )}
    </>
  );
};

/** THE LIST VIEW: every step of the selected workflow in order, each with its controls, and the server's rules beneath. */
const EventWorkflowEditor: React.FC<WorkflowOptions & {
  workflows: Workflows;
  onChange: (next: Workflows | null) => void;
  /** The workflow shown first, so switching views keeps the person's place. */
  initialSelected?: string;
  onSelect?: (name: string) => void;
  /** The assistant whose version this is: a trigger attached here runs this version's workflow. */
  assistant?: string;
}> = ({ workflows, onChange, templates, tools, published, variables, versionTools, classification, welcomeContext, initialSelected, onSelect, assistant }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const names = Object.keys(workflows);
  const [selected, setSelectedState] = useState(initialSelected && workflows[initialSelected] ? initialSelected : names[0] ?? '');
  const setSelected = (name: string) => { setSelectedState(name); onSelect?.(name); };
  const { messages, prompts } = templateNames(templates);
  const wf = workflows[selected];
  const errors = wf ? versionEventWorkflowsErrors({ [selected]: wf }, { lookup: routerHeldVariables(variables).lookup }) : [];

  const save = (next: Workflows) => onChange(Object.keys(next).length ? next : null);
  const put = (next: EventWorkflow) => save({ ...workflows, [selected]: next });
  const steps = wf ? orderedSteps(wf) : [];
  const unreached = wf ? unreachableSteps(wf) : [];
  // THE START IS LISTED FIRST AND STAYS THE START: Up and Down reorder the other steps, and only Start here moves it.
  const move = (i: number, by: number) => {
    const j = i + by;
    if (!wf || i === 0 || j < 1 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    put(withSteps(wf, next));
  };

  return (
    <div className="profiles-persona-field" data-testid="event-workflow-editor">
      <h4>{t('admin.workflowEditor.title')}</h4>
      <span className="admin-field-hint">{t('admin.workflowEditor.help')}</span>
      <WorkflowPicker workflows={workflows} selected={selected} onSelect={setSelected} onAdd={(name, from) => {
        const next = workflowsWith(workflows, name, from, templates);
        if (!next) return false;
        save(next);
        setSelected(name);
        return true;
      }} />

      {wf && (
        <>
          <WorkflowSettings name={selected} wf={wf} onPut={put} classification={classification} assistant={assistant} onRemove={() => {
            const { [selected]: _gone, ...rest } = workflows;
            save(rest);
            setSelected(Object.keys(rest)[0] ?? '');
          }} />

          <ol data-testid="event-workflow-steps">
            {steps.map(([key], i) => (
              <li key={key} data-testid={`event-workflow-step-${i}`}>
                {unreached.includes(key) && (
                  <span role="note" className="admin-field-hint" data-testid={`event-workflow-step-${i}-unreached`}>{t('admin.workflowEditor.unreached', { step: key })}</span>
                )}
                <StepFields wf={wf} stepKey={key} testId={`event-workflow-step-${i}`} templates={templates} tools={tools} published={published} variables={variables} versionTools={versionTools} classification={classification} welcomeContext={welcomeContext}
                  onChange={(def) => put(updateStep(wf, key, def))} onWorkflow={put}
                  onRename={(to) => { const next = renameStep(wf, key, to); if (next) put(next); }}
                  headerExtra={(
                    <>
                      {i === 0
                        ? <span className="admin-field-hint" data-testid={`event-workflow-step-${i}-is-start`}>{t('admin.workflowBuilder.isStart')}</span>
                        : <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-start`} onClick={() => put(startAt(wf, key))}>{t('admin.workflowBuilder.startHere')}</button>}
                      <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-up`} disabled={i <= 1} onClick={() => move(i, -1)}>{t('admin.workflowEditor.up')}</button>
                      <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-down`} disabled={i === 0 || i === steps.length - 1} onClick={() => move(i, 1)}>{t('admin.workflowEditor.down')}</button>
                      <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-remove`} onClick={() => put(removeStep(wf, key))}>{t('admin.workflowEditor.removeStep')}</button>
                    </>
                  )} />
              </li>
            ))}
          </ol>
          {atStepLimit(wf) && <p className="admin-field-hint" role="status" data-testid="event-workflow-step-limit">{t('admin.workflowBuilder.atStepLimit', { max: MAX_EVENT_WORKFLOW_STEPS })}</p>}
          <div className="admin-filter-group">
            {kindsFor(wf.on, wf.types).map((k) => (
              <button key={k} type="button" className="btn-secondary" data-testid={`event-workflow-add-${k}`} disabled={atStepLimit(wf)} onClick={() => put(addStep(wf, k, messages, prompts).workflow)}>
                {t(`admin.workflowEditor.add_${k}`)}
              </button>
            ))}
          </div>
          {errors.length > 0 && (
            <ul role="alert" data-testid="event-workflow-errors">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

export default EventWorkflowEditor;
