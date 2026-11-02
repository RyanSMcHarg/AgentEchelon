/**
 * A VERSION'S OWN EVENT WORKFLOWS, EDITED STEP BY STEP (ADR-061 decision 1, as built).
 *
 * Each workflow runs on `assistant-joined`, `conversation-opened`, `person-joined`, `invitation-sent` or the deadline
 * `invitation-unredeemed`, which declares how long after the invitation was sent it fires. Its steps are listed in order, the first being
 * where the run starts: a send posts a message template to an audience, an agent step is one turn of the assistant
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
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_AGENT_DEADLINE_MS,
  MAX_DEADLINE_MINUTES,
  MIN_DEADLINE_MINUTES,
  EVENT_TASK_MACHINES,
  PLATFORM_EVENT_WORKFLOWS,
  PROPOSAL_OPS,
  isDeadlineEvent,
  isInvitationEvent,
  inertMention,
  type MentionSource,
  type SendStep,
  versionEventWorkflowsErrors,
  edgeAudience,
  type ConditionedEdge,
  type EventAudience,
  type EventEdge,
  type EventStepDef,
  type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import {
  MAX_TASK_DEADLINE_MINUTES, MIN_TASK_DEADLINE_MINUTES, TASK_PRIORITIES, machinesAStepMayOpen, workerAssistantRole,
  type TaskPerson, type TaskStep,
} from '../../../../../../backend/lambda/src/lib/task-step.ts';
import { promptPreview, type WelcomePromptOption } from './welcomeWorkflow';
import { previewMessageTemplate, sampleValue } from './MessageTemplatesEditor';
import { parseTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import type { ToolDescriptor } from '../../services/profileService';
import ConditionBuilder from './ConditionBuilder';
import { declaredParticipantRoleNames } from '../../../../../../backend/lib/config/participant-roles.ts';
import type { PickableSource, PublishedVariables, VersionVariable } from '../../../../../../backend/lambda/src/lib/variables.ts';
import {
  STEP_NAME, addStep, convertStep, kindOf, kindsFor, newWorkflow, orderedSteps, removeStep, renameStep, retarget, updateStep, withSteps,
  type Kind,
} from './workflowEdits';

export { convertStep, retarget };

/** What the router reads at an event (`routerGate`): no context source, reply preference or onboarding answer. */
export const routerReads = (src: PickableSource): boolean => !/^(ctx|pref|fact):/.test(src.source);

type T = (key: string, opts?: Record<string, unknown>) => string;
type Workflows = Record<string, EventWorkflow>;
/** The machines a task step may open: the platform's reference machines (a version's own are edited as JSON). */
const TASK_MACHINES = Object.keys(machinesAStepMayOpen()).sort();
/** Who a task is for or worked by, keyed as an audience is; `assistantRole:<role>` names an assistant worker. */
const TASK_PEOPLE = ['subject', 'joined', 'event:person', 'invitation:inviter'] as const;
const taskRefKey = (ref: unknown): string => {
  const role = workerAssistantRole(ref);
  if (role) return `assistantRole:${role}`;
  return ref === undefined ? '' : audienceKey(ref as EventAudience);
};
const taskRefOf = (key: string): TaskStep['by'] | undefined => (!key ? undefined
  : key.startsWith('assistantRole:') ? { assistantRole: key.slice('assistantRole:'.length) } : audienceOf(key) as TaskPerson);

const AUDIENCES = ['room', 'subject', 'joined', 'event:person', 'invitation:inviter'] as const;
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
          {!names.length && <option value="">{t('admin.workflowEditor.none')}</option>}
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
          <option value="" />
          {Object.keys(PLATFORM_EVENT_WORKFLOWS).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <button type="button" className="btn-secondary" data-testid="event-workflow-copy" disabled={!copyFrom || !newName}
        onClick={() => add(PLATFORM_EVENT_WORKFLOWS[copyFrom])}>
        {t('admin.workflowEditor.copy')}
      </button>
    </div>
  );
};

/** A workflow under a new name, empty or a copy; null when the name is not one the server accepts or is taken. */
export function workflowsWith(workflows: Workflows, name: string, from: EventWorkflow | undefined, templates: WelcomePromptOption[] | undefined): Workflows | null {
  if (!STEP_NAME.test(name) || workflows[name]) return null;
  const { messages, prompts } = templateNames(templates);
  return { ...workflows, [name]: from ? JSON.parse(JSON.stringify(from)) as EventWorkflow : newWorkflow(messages, prompts) };
}

/** WHAT A WORKFLOW RUNS ON: its event, a deadline event's deadline, the conversation types it runs in, and removing it. */
export const WorkflowSettings: React.FC<{
  wf: EventWorkflow;
  onPut: (next: EventWorkflow) => void;
  onRemove: () => void;
}> = ({ wf, onPut, onRemove }) => {
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
      <label><span className="admin-field-label">{t('admin.workflowEditor.types')}</span>
        <input type="text" className="input" data-testid="event-workflow-types" value={(wf.types ?? []).join(', ')}
          onChange={(e) => {
            const types = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            const { types: _old, ...rest } = wf;
            onPut(types.length ? { ...rest, types } : rest);
          }} />
      </label>
      <button type="button" className="btn-secondary" data-testid="event-workflow-remove" onClick={onRemove}>{t('admin.workflowEditor.remove')}</button>
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
  onRename: (to: string) => void;
  /** Controls the view adds beside the name and kind (the list's move and remove). */
  headerExtra?: React.ReactNode;
}> = ({ wf, stepKey: key, testId, onChange, onRename, headerExtra, templates, tools, published, variables }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const audienceLabel = useAudienceLabel();
  const def = wf.states[key];
  const keys = Object.keys(wf.states);
  const { messages, prompts } = templateNames(templates);
  const readTools = tools.filter((d) => !d.changesState);
  const sourceOf = (name: string) => (templates ?? []).find((x) => x.name === name)?.source;
  const fieldsOf = (name: string): string[] => {
    try { return Object.keys(parseTemplate(sourceOf(name) ?? '').fields ?? {}); } catch { return []; }
  };
  const update = (next: EventStepDef) => onChange(next);
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
              <option value="event:person">{t('admin.workflowEditor.mention_event_person')}</option>
              <option value="subject">{t('admin.workflowEditor.mention_subject')}</option>
              {(isInvitationEvent(wf.on) || source === 'invitation:inviter') && (
                <option value="invitation:inviter">{t('admin.workflowEditor.mention_invitation_inviter')}</option>
              )}
              {roleKeys(source).map((k) => <option key={k} value={k}>{t('admin.workflowEditor.mention_participantRole', { role: k.slice('participantRole:'.length) })}</option>)}
            </select>
            <button type="button" className="btn-secondary" data-testid={`${id}-${field}-remove`} onClick={() => {
              const { [field]: _gone, ...rest } = bound;
              set(rest);
            }}>{t('admin.workflowEditor.mentionRemove')}</button>
          </div>
        ))}
        {free.length > 0 && (
          <select className="select" aria-label={t('admin.workflowEditor.mentionAdd')} data-testid={`${id}-add`} value=""
            onChange={(e) => e.target.value && set({ ...bound, [e.target.value]: wf.on === 'assistant-joined' ? 'subject' : 'event:person' })}>
            <option value="">{t('admin.workflowEditor.mentionAdd')}</option>
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
  const conditionProps = { published, variables, event: wf.on, only: routerReads, hiddenNote: t('admin.workflowEditor.routerReads') };
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

  return (
    <>
      <div className="admin-filter-group">
        <label><span className="admin-field-label">{t('admin.workflowEditor.stepName')}</span>
          <input type="text" className="input" defaultValue={key} aria-label={t('admin.workflowEditor.stepName')} data-testid={`${testId}-name`}
            onBlur={(e) => onRename(e.target.value.trim())} />
        </label>
        <label><span className="admin-field-label">{t('admin.workflowEditor.kind')}</span>
          <select className="select" data-testid={`${testId}-kind`} value={kind}
            onChange={(e) => update(convertStep(def, e.target.value as Kind, messages, prompts, wf.on))}>
            {[...new Set([...kindsFor(wf.on), kind])].map((k) => <option key={k} value={k}>{t(`admin.workflowEditor.kind_${k}`)}</option>)}
          </select>
        </label>
        {headerExtra}
      </div>
      {def.send && (
        <div className="admin-filter-group">
          <label><span className="admin-field-label">{t('admin.workflowEditor.audience')}</span>
            <select className="select" data-testid={`${testId}-audience`} value={audienceKey(def.send.to)} onChange={(e) => update({ ...def, send: { ...def.send!, to: audienceOf(e.target.value) } })}>
              {[...AUDIENCES, ...roleKeys(audienceKey(def.send.to))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.template')}</span>
            {templatePicker(def.send.template, messages, (v) => update({ ...def, send: { ...def.send!, template: v } }), `${testId}-template`)}
          </label>
          {mentionEditor(def.send, (send) => update({ ...def, send }), `${testId}-mention`)}
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
              {[...AUDIENCES, ...roleKeys(audienceKey(def.agent.to))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
            </select>
          </label>
          <label>
            <input type="checkbox" data-testid={`${testId}-reads`} checked={def.agent.reads === 'messages'}
              onChange={(e) => { const { reads: _r, ...rest } = def.agent!; update({ ...def, agent: e.target.checked ? { ...rest, reads: 'messages' } : rest }); }} />
            {' '}{t('admin.workflowEditor.readsMessages')}
          </label>
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
            {readTools.map((d) => (
              <label key={d.name} className="admin-check" title={d.description}>
                <input type="checkbox" checked={(def.agent!.tools ?? []).includes(d.name)} onChange={(e) => update({
                  ...def,
                  agent: { ...def.agent!, tools: e.target.checked ? [...(def.agent!.tools ?? []), d.name] : (def.agent!.tools ?? []).filter((x) => x !== d.name) },
                })} />
                <code>{d.name}</code>
              </label>
            ))}
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
              <input type="text" className="input" data-testid={`${testId}-opens`} value={def.agent.opens ?? ''}
                onChange={(e) => update({ ...def, agent: { ...def.agent!, opens: e.target.value.trim() } })} />
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
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.openingExamples')}</span>
            <textarea className="textarea" rows={3} data-testid={`${testId}-opening-examples`} value={(def.opening.examples ?? []).join('\n')}
              onChange={(e) => {
                const { examples: _x, ...rest } = def.opening!;
                const ex = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
                update({ ...def, opening: ex.length ? { ...rest, examples: ex } : rest });
              }} />
          </label>
          <span className="admin-field-hint">{t('admin.workflowEditor.openingHelp')}</span>
        </div>
      )}
      {def.prompt && (
        <div className="admin-filter-group" data-testid={`${testId}-prompt-step`}>
          <label><span className="admin-field-label">{t('admin.workflowEditor.prompt')}</span>
            {templatePicker(def.prompt.template, prompts, (v) => update({ ...def, prompt: { ...def.prompt!, template: v } }), `${testId}-prompt-template`)}
          </label>
          <div>
            <span className="admin-field-label">{t('admin.workflowEditor.tools')}</span>
            {readTools.map((d) => (
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
          <span className="admin-field-hint">{t('admin.workflowEditor.promptStepHelp')}</span>
        </div>
      )}
      {def.task && (
        <div className="admin-filter-group" data-testid={`${testId}-task`}>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskMachine')}</span>
            <select className="select" data-testid={`${testId}-task-machine`} value={def.task.machine}
              onChange={(e) => update({ ...def, task: { ...def.task!, machine: e.target.value } })}>
              {[...new Set([...TASK_MACHINES, def.task.machine])].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskFor')}</span>
            <select className="select" data-testid={`${testId}-task-for`} value={taskRefKey(def.task.for)}
              onChange={(e) => { const { for: _f, ...rest } = def.task!; const ref = taskRefOf(e.target.value) as TaskPerson | undefined; update({ ...def, task: ref ? { ...rest, for: ref } : rest }); }}>
              <option value="">{t('admin.workflowEditor.taskForNobody')}</option>
              {[...TASK_PEOPLE, ...roleKeys(taskRefKey(def.task.for))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskBy')}</span>
            <select className="select" data-testid={`${testId}-task-by`} value={taskRefKey(def.task.by)}
              onChange={(e) => { const { by: _b, ...rest } = def.task!; const ref = taskRefOf(e.target.value); update({ ...def, task: ref ? { ...rest, by: ref } : rest }); }}>
              <option value="">{t('admin.workflowEditor.taskByThisAssistant')}</option>
              {[...TASK_PEOPLE, ...roleKeys(taskRefKey(def.task.by))].map((a) => <option key={a} value={a}>{audienceLabel(a)}</option>)}
              {taskRefKey(def.task.by).startsWith('assistantRole:') && <option value={taskRefKey(def.task.by)}>{taskRefKey(def.task.by)}</option>}
            </select>
          </label>
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskAssistantRole')}</span>
            <input type="text" className="input" data-testid={`${testId}-task-assistant-role`} defaultValue={workerAssistantRole(def.task.by) ?? ''}
              onBlur={(e) => { const role = e.target.value.trim(); const { by: _b, ...rest } = def.task!; if (role) update({ ...def, task: { ...rest, by: { assistantRole: role } } }); else if (workerAssistantRole(def.task!.by)) update({ ...def, task: rest }); }} />
          </label>
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
          <label><span className="admin-field-label">{t('admin.workflowEditor.taskDeadline', { min: MIN_TASK_DEADLINE_MINUTES, max: MAX_TASK_DEADLINE_MINUTES })}</span>
            <input type="number" className="input" min={MIN_TASK_DEADLINE_MINUTES} max={MAX_TASK_DEADLINE_MINUTES} data-testid={`${testId}-task-deadline`}
              value={def.task.deadline.afterMinutes}
              onChange={(e) => update({ ...def, task: { ...def.task!, deadline: { afterMinutes: Math.round(Number(e.target.value)) } } })} />
          </label>
          <span className="admin-field-hint">{t('admin.workflowEditor.taskHelp')}</span>
        </div>
      )}
      {def.action && (
        <div className="admin-filter-group" data-testid={`${testId}-intake`}>
          <span className="admin-field-label">{t('admin.workflowEditor.intakeTo', { who: audienceLabel(audienceKey(def.action.to)) })}</span>
          <span className="admin-field-hint">{t('admin.workflowEditor.intakeHelp')}</span>
        </div>
      )}
      {kind !== 'end' && (
        <div data-testid={`${testId}-when`} id={`${testId}-when`}>
          <span className="admin-field-label">{t('admin.workflowEditor.stepWhen')}</span>
          <span className="admin-field-hint">{t('admin.workflowEditor.stepWhenHelp')}</span>
          <ConditionBuilder value={def.when} testId={`${testId}-when-builder`} {...conditionProps}
            selects={def.opening || def.prompt || audienceKey(def.send?.to ?? def.agent?.to ?? def.action?.to) === 'room' ? 'room' : 'addressed'}
            onChange={(when) => {
              const { when: _old, ...rest } = def;
              update(when === undefined ? rest : { ...rest, when });
            }} />
        </div>
      )}
      {kind !== 'end' && (
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
}> = ({ workflows, onChange, templates, tools, published, variables, initialSelected, onSelect }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const names = Object.keys(workflows);
  const [selected, setSelectedState] = useState(initialSelected && workflows[initialSelected] ? initialSelected : names[0] ?? '');
  const setSelected = (name: string) => { setSelectedState(name); onSelect?.(name); };
  const { messages, prompts } = templateNames(templates);
  const wf = workflows[selected];
  const errors = wf ? versionEventWorkflowsErrors({ [selected]: wf }) : [];

  const save = (next: Workflows) => onChange(Object.keys(next).length ? next : null);
  const put = (next: EventWorkflow) => save({ ...workflows, [selected]: next });
  const steps = wf ? orderedSteps(wf) : [];
  const move = (i: number, by: number) => {
    const j = i + by;
    if (!wf || j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    put(withSteps(wf, next));
  };

  return (
    <div className="profiles-persona-field" data-testid="event-workflow-editor">
      <h5>{t('admin.workflowEditor.title')}</h5>
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
          <WorkflowSettings wf={wf} onPut={put} onRemove={() => {
            const { [selected]: _gone, ...rest } = workflows;
            save(rest);
            setSelected(Object.keys(rest)[0] ?? '');
          }} />

          <ol data-testid="event-workflow-steps">
            {steps.map(([key], i) => (
              <li key={key} data-testid={`event-workflow-step-${i}`}>
                <StepFields wf={wf} stepKey={key} testId={`event-workflow-step-${i}`} templates={templates} tools={tools} published={published} variables={variables}
                  onChange={(def) => put(updateStep(wf, key, def))}
                  onRename={(to) => { const next = renameStep(wf, key, to); if (next) put(next); }}
                  headerExtra={(
                    <>
                      <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-up`} disabled={i === 0} onClick={() => move(i, -1)}>{t('admin.workflowEditor.up')}</button>
                      <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>{t('admin.workflowEditor.down')}</button>
                      <button type="button" className="btn-secondary" data-testid={`event-workflow-step-${i}-remove`} onClick={() => put(removeStep(wf, key))}>{t('admin.workflowEditor.removeStep')}</button>
                    </>
                  )} />
              </li>
            ))}
          </ol>
          <div className="admin-filter-group">
            {kindsFor(wf.on).map((k) => (
              <button key={k} type="button" className="btn-secondary" data-testid={`event-workflow-add-${k}`} onClick={() => put(addStep(wf, k, messages, prompts).workflow)}>
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
