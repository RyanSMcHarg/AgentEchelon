/**
 * ONE ASSISTANT'S PAGE: what serves, and the draft, edited in place (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * A header names the assistant, its classification, role and active version, links to its performance (Effectiveness
 * for the active version, and Conversations, each narrowed to the assistant), and holds one toggle between the active
 * version and the draft. The draft is edited in the same sections the active version is read in, so starting one never
 * means scrolling to it: the toggle says Edit when there is none and Draft (n changed) when there is, and switching back
 * to the active version keeps the draft. While the draft shows, a banner above the sections holds Discard draft (behind
 * a confirm naming what is lost), Validate and Activate.
 *
 * The sections are one at a time, from a menu that says in one line what each holds and marks each the draft changes
 * (`assistantSections.ts`). Every field reads label, help, then value, on every width. What a version edits has a control
 * in the draft; what only a pack, the CLI or a deploy changes says where and how (`EditPath`); nothing is a fake setting.
 *
 * AN UNSAVED EDIT IS KEPT UNTIL IT IS SAVED, RESET OR KNOWINGLY DROPPED (`unsavedAreas.ts`). Each area's edit is held by
 * the tab, not by its controls, so switching sections, the Active/Draft toggle and another area's save all keep it; the
 * menu marks a section holding one, and Activate and Discard name what they would drop before they drop it.
 *
 * THE CREATION WIZARD IS THIS PAGE TOO. Once the build has made the first draft, the wizard (`wizard`) shows the same
 * sections as steps (`CREATION_STEPS`), edited by the same controls, and ends on the same draft banner. So a field reads
 * and behaves the same while an assistant is being created as it does on its page afterwards.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GreetedWith, welcomeContextFor } from './WelcomeEditorGuide';
import { classificationName } from '@ae/shared/config/classifications.ts';
import { groupPlatformWorkflows } from './platformWorkflowGroups';
import { useTranslation } from 'react-i18next';
import WizardSteps from './WizardSteps';
import { DocLink, GuideLinks, guide, guideSection, type Guide } from './AdminHelp';
import {
  useTemplateOptions, ClassifierModeRow, ContextGroup, EditPath, FixedForLife, PersonaExtras, PlatformSection, Row, StackedField, WordsGroup,
} from './AssistantConfigFields';
import { VariablesFields, type InlineArea } from './DraftAreaFields';
import { ProcessList } from './ProcessesFields';
import { linkableOf } from './processChain';
import MessageTemplatesEditor from './MessageTemplatesEditor';
import { DiscardDraft, DraftDiff, DraftStep, DraftValidationResult, MoveIntoPersona, holdsActivate, type AreaContext, type DraftValidation } from './DraftControls';
import { combinedPatch, draftWith, unsavedAreas, type Unsaved } from './unsavedAreas';
import {
  RouteRefusals, StepModelControl, StepModelsHelp, cardRefusals, fallbacksFor, machineStepsOf, modelsOfKind, offersImageModel, refusalsFor, stepKind, withImageModel, withPrimary,
  withRoute, withTextModel,
} from './IntentRouteModels';
import WorkflowGroups from './WorkflowGroups';
import GoldenRunPanel, { type PastGateOutcome } from './GoldenRunPanel';
import GoldenUploadPanel from './GoldenUploadPanel';
import { areaSummary, type DraftArea } from './draftAreas';
import {
  CREATION_STEPS, SECTIONS, SECTION_AREAS, WIZARD_SECTIONS, changedSections, changesOtherFields, creationSteps, intentCards, intentsRunning, ownWorkflows, servedIntents,
  hasOwnTextModel, inheritedImageModel, platformCopyConflict, platformIntentRows, platformRouteServing, refusedIntentKeys, workflowSelected, platformWorkflows, platformWorkflowsRunByDefault, withPlatformCopy, type IntentCard, type Section, type WizardSection,
} from './assistantSections';
import { linkSearch, type AssistantLink, type WorkflowEditorLink } from './assistantLinks';
import EventWorkflowSummary from './EventWorkflowSummary';
import RoomTypeWorkflows from './RoomTypeWorkflows';
import {
  DEFAULT_MODEL,
  type ClassificationCatalog, type FieldDecision, type IntentRoute, type MachineStep, type ProfileDefinitionBody, type ProfileDraftPatch,
  type ProfileListing, type ProfileModels, type RouteError, type ToolDescriptor, type PastGateConfirmation,
} from '../../services/profileService';
import { bedrockGuardrailUrl, bedrockGuardrailsUrl, bedrockModelsUrl, cloudwatchLogsUrl, lambdaFunctionUrl, lambdaFunctionsUrl } from '../../services/awsConsole';
import { EVENT_WORKFLOW_EVENTS, SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { DEFAULT_TASK_STATE_MACHINES, isPlatformMachineKey, isPlatformRaisedMachine, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import { TaskMachineBuilder } from './WorkflowBuilder';
import { NEW_WORKFLOW_FOCUS } from './workflowEdits';
import { ConfirmAction, ConfirmPanel } from './ConfirmAction';
import { declaredParticipantRoles } from './useTaskMachineSource';
import { assignedTasksOf } from './IntentWorkflowsFields';
import { canonicalIntentWorkflow, type IntentWorkflow } from '../../../../../../backend/lambda/src/lib/intent-workflow.ts';
import { packWithMachine } from './machineEdits';
import { machineLayoutKey, type StepPosition } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { useUrlView, viewParam } from './consoleViewUrl';

/** Whether the platform raises an intent's tasks itself (`isPlatformRaisedMachine`), so it has no classified turns to measure. */
export function platformRaised(card: Pick<IntentCard, 'key' | 'machine'>): boolean {
  return isPlatformRaisedMachine(card.machine) || isPlatformRaisedMachine(card.key);
}

/** Whether a value names one of the page's sections. */
const isSection = (v: string | null): v is Section => !!v && (SECTIONS as readonly string[]).includes(v);
/** The section a link opens the page on, or null. */
const sectionFromUrl = (): Section | null => { const v = viewParam('section'); return isSection(v) ? v : null; };

type T = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The entry a record holds under its own key, never one it inherits: a workflow or task name comes from a link's URL, so
 * `constructor` or `__proto__` names nothing.
 */
const ownEntry = <V,>(rec: Record<string, V> | undefined, key: string): V | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * The element a test id names, matched as a plain string: a workflow, intent or step name comes from a link's URL and may
 * carry any character, so it is never written into a selector.
 */
function byTestId(id: string): Element | undefined {
  return Array.from(document.querySelectorAll('[data-testid]')).find((el) => el.getAttribute('data-testid') === id);
}

/** The two kinds of model a route names (ADR-064 decision C). */
const TEXT = 'text';
const IMAGE = 'image';

/** A class list from single names; a falsy entry is left out. */
const STACK = ['admin-config-list', 'admin-config-stack'].join(' ');
const cx = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

/** The guide each section points to, and why a reader would open it. */
const SECTION_GUIDES: Partial<Record<Section, (t: T) => Guide[]>> = {
  behavioral: (t) => [guide(t('admin.guides.config.identity'), 'roleDesign')],
  workflows: (t) => [guideSection(t('admin.assistantPage.guideLead'), 'globalWorkflows')],
  processes: (t) => [guide(t('admin.guides.config.processes'), 'processes')],
  messages: (t) => [guideSection(t('admin.assistantPage.guideLead'), 'messageTemplates')],
  tools: (t) => [guide(t('admin.guides.config.context'), 'contextGuide')],
  scope: (t) => [guide(t('admin.guides.config.intents'), 'intentPack', t('admin.guides.config.intentsTail')), guide(t('admin.guides.config.models'), 'modelStrategy', t('admin.guides.config.modelsTail'))],
  versions: (t) => [guideSection(t('admin.guides.config.versions'), 'manageProfile')],
};

export interface AssistantPageProps {
  selected: ProfileListing;
  /** The tasks other assistants' workflows give to this assistant's role (WT78), by assistant, workflow, step and intent. */
  roleTasks?: Array<{ assistant: string; workflow: string; step: string; machine: string }>;
  /** The active version's body, or the draft's while nothing is active. */
  config: ProfileDefinitionBody | null;
  configLoading: boolean;
  /** The draft's body, once read; null while there is none or it is loading. */
  draft: ProfileDefinitionBody | null;
  /** The configId the draft was read at; the inline controls re-seed when it changes. */
  draftKey: string;
  catalog?: ClassificationCatalog;
  tools: ToolDescriptor[];
  decisions: Record<string, FieldDecision>;
  ctx: AreaContext;
  busy: boolean;
  validation: DraftValidation | null;
  /** Which version the sections show. */
  mode: 'active' | 'draft';
  onModeChange: (mode: 'active' | 'draft') => void;
  /** Start a draft from the active version (or the classification's defaults while none is active), then show it. */
  onStartDraft: () => void;
  onSave: (patch: ProfileDraftPatch) => Promise<boolean>;
  /** Each area's edit not yet saved, held by the tab so it outlives the controls that made it. */
  unsaved: Unsaved;
  /** A change to one area's fields, merged into its unsaved edit. */
  onUnsavedPatch: (area: DraftArea, patch: ProfileDraftPatch) => void;
  /** Forget these areas' unsaved edits: once saved, or reset. */
  onUnsavedDrop: (areas: readonly DraftArea[]) => void;
  onValidate: () => void;
  onActivate: () => void;
  /** Activate the draft past the golden gate's refusal (ADR-065 decision 5); offered by the golden panel to an administrator. */
  onActivatePastGate?: (confirm: PastGateConfirmation) => Promise<PastGateOutcome>;
  /** What each reading of the golden gate says for the draft: whether Activate would pass it. */
  onGoldenOutcome?: (proceed: boolean) => void;
  onDiscard: () => void;
  onBack: () => void;
  onOpenLink?: (link: AssistantLink) => void;
  /**
   * THE WORKFLOW A LINK OPENS THE PAGE ON (`WorkflowEditorLink`), once: the Workflows section, on that workflow. Where there
   * is a draft and the person may edit it, the draft's editor opens on it; otherwise the active version's view marks it.
   */
  linkedWorkflow?: WorkflowEditorLink | null;
  canEdit: boolean;
  canValidate: boolean;
  /** Rendered by the tab, which owns their reads and writes. */
  notices?: React.ReactNode;
  ownerControl: React.ReactNode;
  limits: React.ReactNode;
  infrastructure: React.ReactNode;
  versions: React.ReactNode;
  /** The creation wizard, continued on the built assistant's first draft: the sections as steps, ending on the banner. */
  wizard?: { onFinishLater: () => void };
}

/** A link the console opens without a reload, which is also a real URL for a new tab or a colleague. */
const ConsoleLink: React.FC<{ link: AssistantLink; onOpen?: (link: AssistantLink) => void; testId: string; title?: string; children: React.ReactNode }> = ({ link, onOpen, testId, title, children }) => (
  <a href={linkSearch(link)} data-testid={testId} title={title}
    onClick={(e) => {
      if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onOpen(link);
    }}>{children}</a>
);

/**
 * A model choice as a person reads it: the default by name, or the model's key linked to the Bedrock console. Given the
 * classification's default, a base model that follows it names the model it serves on.
 */
const ModelValue: React.FC<{ model?: string; classificationDefault?: string }> = ({ model, classificationDefault }) => {
  const { t } = useTranslation();
  if (model && model !== DEFAULT_MODEL) return <DocLink href={bedrockModelsUrl()}><code>{model}</code></DocLink>;
  return classificationDefault
    ? <span className="admin-muted" data-testid="model-classification-default">{t('admin.assistantPage.modelClassificationDefault')} <code>{classificationDefault}</code></span>
    : <span className="admin-muted">{t('admin.assistantPage.modelDefault')}</span>;
};

const AssistantPage: React.FC<AssistantPageProps> = (props) => {
  const {
    selected, config, configLoading, draft, draftKey, catalog, tools, decisions, ctx, busy, validation, mode, onModeChange,
    onStartDraft, onSave, unsaved, onUnsavedPatch, onUnsavedDrop, onValidate, onActivate, onActivatePastGate, onGoldenOutcome, onDiscard, onBack, onOpenLink, canEdit, canValidate,
    notices, ownerControl, limits, infrastructure, versions, wizard,
  } = props;
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [section, setSection] = useState<Section>(() => sectionFromUrl() ?? 'behavioral');
  // THE OPEN SECTION IS THE ADDRESS (`&section=`): a link opens the assistant on it. It corrects the current entry rather than
  // adding one, so Back leaves the assistant in one step, as it always has. The first
  // section is the page's own, so it names none.
  useUrlView('section', section === 'behavioral' ? null : section, (v) => setSection(isSection(v) ? v : 'behavioral'), { replace: true });
  /** The wizard's step, once the build has made the draft: a section, or the review. */
  const [step, setStep] = useState<WizardSection | 'review'>(WIZARD_SECTIONS[0]);
  /** A task machine open on its own view, and the section it was opened from. */
  const [machine, setMachine] = useState<{ key: string; from: Section } | null>(null);
  /** The step of the open machine a link opened it on, shown selected. */
  const [focusStep, setFocusStep] = useState<string | null>(null);
  /** Bumped by Reset, so every inline control re-seeds from the saved draft. */
  const [reset, setReset] = useState(0);
  /** An intent's task steps as the machine builder edits them, until they are saved or reset; null while unchanged. */
  const [machineEdit, setMachineEdit] = useState<TaskStateMachine | null>(null);
  /** Where the open machine's steps were moved to, saved with it. */
  const [machinePoints, setMachinePoints] = useState<Record<string, StepPosition> | null>(null);
  /** The workflow Edit in a draft opened, which the draft's builder shows selected. */
  const [focusWorkflow, setFocusWorkflow] = useState<string | null>(null);

  const name = config?.displayName || selected.displayName || selected.profileName;
  const active = selected.activeVersion;
  // WHAT THE DRAFT IS COMPARED WITH: the active version, or nothing while no version has been activated.
  const activeBody = active === null ? null : config;
  const editing = (!!wizard || mode === 'draft') && !!selected.hasDraft;
  const body = editing ? draft : config;
  const changed = changedSections(activeBody, draft);
  // A field no section edits counts too, so a draft that changes only those never reads as unchanged.
  const otherChanged = changesOtherFields(activeBody, draft);
  const assistant = selected.profileName;

  const go = (s: Section) => { setSection(s); setMachine(null); };
  /** A request to leave an open workflow that holds unsaved edits, waiting on the inline confirm. */
  const [leaving, setLeaving] = useState(false);
  /** The intent whose Workflows entry a card's link opened, shown marked and scrolled to (ADR-067 decision 4, WT97). */
  const [focusIntent, setFocusIntent] = useState<string | null>(null);
  const showInWorkflows = (key: string) => { go('workflows'); setFocusIntent(key); };
  useEffect(() => {
    if (!focusIntent || section !== 'workflows') return;
    byTestId(`workflow-intent-${focusIntent}`)?.scrollIntoView?.({ block: 'center' });
  }, [focusIntent, section]);
  const openMachine = (key: string, from: Section) => { setMachineEdit(null); setMachinePoints(null); setMachine({ key, from }); setFocusStep(null); };
  /**
   * EDIT AN INTENT'S TASK STEPS IN A DRAFT (ADR-067 stage 1): the machine's view, in the draft. A draft is started from the
   * active version when there is none, as Edit on an event workflow does.
   */
  const editMachineInDraft = (key: string) => {
    setSection('workflows');
    openMachine(key, 'workflows');
    if (selected.hasDraft) onModeChange('draft');
    else onStartDraft();
  };
  // A task's steps are brought into view when they open, past the page's header and notes.
  useEffect(() => {
    if (machine && editing) document.querySelector('[data-testid="mb-canvas"]')?.scrollIntoView?.({ block: 'center' });
  }, [machine?.key, editing]);
  // The builder Edit in a draft opened is brought into view once the draft is read.
  const builderReady = editing && !!draft && section === 'workflows' && !!focusWorkflow;
  useEffect(() => {
    if (builderReady) document.getElementById('draft-step-events')?.scrollIntoView?.({ block: 'start' });
  }, [builderReady, focusWorkflow]);

  /** The event workflow a link marked in the Workflows list, where the person reads it rather than editing a draft. */
  const [focusEvent, setFocusEvent] = useState<string | null>(null);
  useEffect(() => {
    if (!focusEvent || section !== 'workflows') return;
    (byTestId(`assistant-workflow-own-${focusEvent}`) ?? byTestId(`assistant-workflow-platform-${focusEvent}`))?.scrollIntoView?.({ block: 'center' });
  }, [focusEvent, section]);
  /**
   * A WORKFLOW LINK OPENS THE WORKFLOWS SECTION ON ITS WORKFLOW, once. A task opens its machine's steps. A name is the event
   * workflow the version or the platform names so, and otherwise an intent's, so it is read once a body is in hand. An event
   * workflow opens in the draft's builder where there is a draft the person may edit, and is marked in the list otherwise;
   * the link never starts a draft.
   */
  const linkApplied = useRef(false);
  useEffect(() => {
    const link = props.linkedWorkflow;
    if (!link || linkApplied.current) return;
    const inDraft = !!selected.hasDraft && canEdit;
    if (link.task || !link.workflow) {
      linkApplied.current = true;
      go('workflows');
      if (link.task) openMachine(link.task, 'workflows');
      if (link.task && inDraft) onModeChange('draft');
      return;
    }
    // A STEP OF AN INTENT'S WORKFLOW opens the intent's task machine on that step, the machine read as the runtime reads it
    // (`servedIntents`, over `catalogIntentOf`), or the classification's machine of the intent's key where no intents are listed.
    if (link.step) {
      if (!catalog || (!config && !draft)) { if (section !== 'workflows') go('workflows'); return; }
      const served = servedIntents(config ?? draft, catalog);
      const machineKey = served ? served.find((i) => i.key === link.workflow)?.machine
        : catalog.workflows?.find((w) => w.key === link.workflow)?.key;
      linkApplied.current = true;
      if (!machineKey) { showInWorkflows(link.workflow); return; }
      go('workflows');
      openMachine(machineKey, 'workflows');
      setFocusStep(link.step);
      if (inDraft) onModeChange('draft');
      return;
    }
    const wfName = link.workflow;
    const isEvent = !!ownEntry(SHIPPED_EVENT_WORKFLOWS, wfName) || !!ownEntry(config?.eventWorkflows, wfName) || !!ownEntry(draft?.eventWorkflows, wfName);
    if (!isEvent && !config && !draft) { if (section !== 'workflows') go('workflows'); return; }
    linkApplied.current = true;
    if (!isEvent) showInWorkflows(wfName);
    else if (inDraft) { setFocusWorkflow(wfName); go('workflows'); onModeChange('draft'); }
    else { go('workflows'); setFocusEvent(wfName); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.linkedWorkflow, config, draft, catalog]);

  /**
   * BACK TO THE WORKFLOWS LIST, NOTHING OPEN: from the side nav, the breadcrumb or the editor's own back link, every time. An
   * open workflow holding unsaved edits asks first, and leaving drops them.
   */
  const toWorkflowList = () => {
    if (focusWorkflow && unsavedAreas(unsaved, ['events']).length) { setLeaving(true); return; }
    setFocusWorkflow(null);
    setFocusEvent(null);
    go('workflows');
  };
  const leaveWorkflow = () => { onUnsavedDrop(['events']); setLeaving(false); setFocusWorkflow(null); setFocusEvent(null); go('workflows'); };
  const areaNames = (areas: readonly DraftArea[]) => areas.map((a) => t(`admin.draftCards.area.${a}`)).join(', ');
  const pending = unsavedAreas(unsaved);

  /** Save these areas' unsaved edits as one patch, laid over the latest draft; each is forgotten once saved. */
  const saveAreas = async (areas: readonly DraftArea[]): Promise<boolean> => {
    const held = unsavedAreas(unsaved, areas);
    if (!draft || !held.length) return true;
    const saved = await onSave(combinedPatch(draft, unsaved, held));
    if (saved) onUnsavedDrop(held);
    return saved;
  };
  /** Forget one area's unsaved edit; every inline control re-seeds from the saved draft and its own edit. */
  const resetArea = (area: DraftArea) => { onUnsavedDrop([area]); setReset((n) => n + 1); };

  /** One draft area, inline in its section, saved alone. The builder opens on the workflow Edit in a draft chose. */
  const inline = (area: InlineArea) => draft && (
    <DraftStep key={`${area}:${draftKey}:${reset}`} area={area} draft={draft} autoFocus={false}
      ctx={area === 'events' && focusWorkflow ? { ...ctx, focusWorkflow, onLeaveWorkflow: () => setFocusWorkflow(null), onFocusWorkflow: setFocusWorkflow } : area === 'processes' ? { ...ctx, onOpenWorkflows: () => go('workflows') } : ctx}
      unsaved={unsaved[area]} onUnsavedPatch={(p) => onUnsavedPatch(area, p)} actions={(edited) => (
        <>
          <ConfirmAction testId="draft-step-cancel" className="btn-ghost" disabled={busy || !edited} label={t('admin.assistantPage.reset')}
            title={t('admin.confirm.areaReset')} confirmLabel={t('admin.confirm.discard')} cancelLabel={t('admin.confirm.cancel')} onConfirm={() => resetArea(area)} />
          <button type="button" className="btn-primary" disabled={busy || !edited || !canEdit} data-testid="draft-step-save" onClick={() => { void saveAreas([area]); }}>
            {t('admin.draftCards.save')}
          </button>
        </>
      )} />
  );

  /** Activate the draft. An unsaved edit is not in it, so the person is asked before that edit is dropped. */
  const activate = () => {
    if (pending.length && !window.confirm(t('admin.assistantPage.unsaved.activate', { areas: areaNames(pending), name }))) return;
    onActivate();
  };

  /** The same question before activating past the gate: an unsaved edit is not in the draft it activates. */
  const activatePastGate = onActivatePastGate && (async (confirm: PastGateConfirmation): Promise<PastGateOutcome> => {
    if (pending.length && !window.confirm(t('admin.assistantPage.unsaved.activate', { areas: areaNames(pending), name }))) return { activated: false };
    return onActivatePastGate(confirm);
  });

  const notRead = configLoading
    ? <div className="admin-tab-loading">{t('admin.profiles.loadingConfiguration')}</div>
    : <p className="admin-muted">{t('admin.assistantPage.unreadable')}</p>;
  const draftLoading = <div className="admin-tab-loading">{t('admin.profiles.loadingConfiguration')}</div>;

  // ---- The header ----
  const draftLabel = !selected.hasDraft
    ? t(active === null ? 'admin.profiles.startFirstDraft' : 'admin.assistantPage.mode.edit')
    : !otherChanged ? t('admin.assistantPage.mode.draft', { count: changed.size })
      : changed.size ? t('admin.assistantPage.mode.draftOther', { count: changed.size }) : t('admin.assistantPage.mode.draftOtherOnly');
  const header = (
    <header className="admin-assistant-header">
      <div className="admin-assistant-title">
        <div className="admin-assistant-name">
          <h2>{name}</h2>
          {selected.classification && <span className="admin-chip">{selected.classification}</span>}
          {selected.role && <span className="admin-chip">{selected.role}</span>}
          {active !== null && <span className={cx('admin-badge', 'admin-badge-active')}>{t('admin.assistantPage.activeShort', { version: active })}</span>}
        </div>
        <p className="admin-tab-description">
          {t('admin.profiles.activeVersion')} <strong>{active ?? '-'}</strong>
          {' · '}{t('admin.config.identifier')} <code>{assistant}</code>
          {selected.versions.find((v) => v.active)?.configId && <> {' · '}{t('admin.assistantPage.configId')} <code>{selected.versions.find((v) => v.active)!.configId.slice(0, 12)}</code></>}
        </p>
        <nav className="admin-assistant-perf" aria-label={t('admin.assistantPage.performance')} data-testid="assistant-performance-links">
          <span className="admin-muted">{t('admin.assistantPage.performance')}</span>
          {active !== null && (
            <ConsoleLink link={{ tab: 'effectiveness', assistant, version: active }} onOpen={onOpenLink} testId="assistant-link-effectiveness"
              title={t('admin.assistantPage.effectivenessTitle', { name, version: active })}>
              {t('admin.assistantPage.effectivenessFor', { version: active })}
            </ConsoleLink>
          )}
          <ConsoleLink link={{ tab: 'conversations', assistant }} onOpen={onOpenLink} testId="assistant-link-conversations"
            title={t('admin.assistantPage.conversationsTitle', { name })}>
            {t('admin.assistantPage.conversations')}
          </ConsoleLink>
        </nav>
      </div>
      <div className="admin-assistant-mode" role="group" aria-label={t('admin.assistantPage.mode.label')}>
        <button type="button" className={cx('admin-mode-btn', !editing && 'active')} aria-pressed={!editing} disabled={active === null}
          data-testid="assistant-mode-active" onClick={() => onModeChange('active')}>
          {active === null ? t('admin.assistantPage.mode.notActive') : t('admin.assistantPage.activeShort', { version: active })}
        </button>
        {(selected.hasDraft || canEdit) && (
          <button type="button" className={cx('admin-mode-btn', 'admin-mode-draft', editing && 'active')} aria-pressed={editing} disabled={busy}
            data-testid={selected.hasDraft ? 'assistant-mode-draft' : 'new-version'}
            title={selected.hasDraft ? undefined : t(active === null ? 'admin.profiles.startFirstDraftHelp' : 'admin.profiles.newVersionHelp')}
            onClick={() => (selected.hasDraft ? onModeChange('draft') : onStartDraft())}>
            {draftLabel}
          </button>
        )}
      </div>
      {!selected.hasDraft && !canEdit && <p className="admin-muted" data-testid="new-version-not-held">{t('admin.profiles.newVersionNotHeld')}</p>}
    </header>
  );

  // ---- The draft banner ----
  const next = (selected.versions.reduce((m, v) => Math.max(m, Number(v.version) || 0), 0)) + 1;
  // THE DRAFT IS NAMED BY WHERE IT WAS STARTED, as the draft records it: a rollback since moves what is active, not that.
  const from = selected.draftCreatedFrom;
  const draftTitle = active === null ? t('admin.assistantPage.banner.first', { name })
    : selected.draftBasedOnVersion !== undefined ? t('admin.assistantPage.banner.editing', { version: selected.draftBasedOnVersion })
      : from?.profileName && from.version !== undefined ? t('admin.assistantPage.banner.editingFrom', { assistant: from.profileName, version: from.version })
        : from?.profileName ? t('admin.assistantPage.banner.editingFromAssistant', { assistant: from.profileName })
          : t('admin.assistantPage.banner.editingUnrecorded');
  const changedLine = !otherChanged ? t('admin.assistantPage.banner.changed', { count: changed.size })
    : changed.size ? t('admin.assistantPage.banner.changedOther', { count: changed.size }) : t('admin.assistantPage.banner.changedOtherOnly');
  const banner = editing && (
    <section className="admin-draft-banner" aria-labelledby="assistant-draft-title" data-testid="assistant-draft">
      <div className="admin-draft-banner-text">
        <strong id="assistant-draft-title">{draftTitle}</strong>{' '}
        <span>{changedLine}{' '}
          {active !== null && t('admin.assistantPage.banner.keepsServing', { version: active })}</span>
      </div>
      <div className={cx('admin-config-actions', 'admin-draft-banner-actions')}>
        {draft && <DiscardDraft draft={draft} active={activeBody} busy={busy} canEdit={canEdit} unsaved={pending.map((a) => t(`admin.draftCards.area.${a}`))} onDiscard={onDiscard} />}
        {canValidate && <button type="button" className="btn-secondary" disabled={busy || !draft} onClick={onValidate}>{t('admin.profiles.validate')}</button>}
        <button type="button" className="btn-primary" disabled={busy || !draft || holdsActivate(validation) || !ctx.canActivate} onClick={activate}>
          {t('admin.assistantPage.banner.activate', { version: next })}
        </button>
      </div>
      <DraftValidationResult validation={validation} />
      {/* The draft's run against the golden set, which Activate reads (ADR-065). */}
      {draft && canValidate && <GoldenRunPanel profileName={selected.profileName} draftConfigId={draftKey} canRun={canEdit} onActivatePastGate={activatePastGate} onOutcome={onGoldenOutcome} />}
      {pending.length > 0 && <p className="admin-field-hint" role="status" data-testid="assistant-draft-unsaved">{t('admin.assistantPage.unsaved.banner', { areas: areaNames(pending) })}</p>}
      {draft && (
        <details className="admin-draft-banner-diff" open={wizard ? true : undefined}>
          <summary>{t('admin.assistantPage.banner.whatChanges')}</summary>
          <DraftDiff draft={draft} active={activeBody} />
        </details>
      )}
    </section>
  );

  // ---- The menu ----
  const ownCount = ownWorkflows(body, true).length + ownWorkflows(body, false).length;
  const cards = intentCards(body, catalog);
  const notes: Record<Section, string> = {
    behavioral: t('admin.assistantPage.sections.behavioral.note'),
    workflows: t('admin.assistantPage.sections.workflows.note', { count: ownCount, name }),
    processes: t('admin.assistantPage.sections.processes.note', { count: Object.keys(body?.processes ?? {}).length }),
    messages: t('admin.assistantPage.sections.messages.note', { name }),
    scope: t('admin.assistantPage.sections.scope.note', { count: cards.length, multi: cards.filter((c) => c.multiStep).length }),
    tools: t('admin.assistantPage.sections.tools.note', { count: body?.tools?.length ?? 0, sources: body?.contextSources?.length ?? 0 }),
    variables: t('admin.assistantPage.sections.variables.note'),
    versions: t('admin.assistantPage.sections.versions.note'),
    settings: t('admin.assistantPage.sections.settings.note'),
    infrastructure: t('admin.assistantPage.sections.infrastructure.note'),
  };
  const menu = (
    <nav className="admin-assistant-menu" aria-label={t('admin.config.sectionsLabel')}>
      <ul>
        {SECTIONS.map((s) => {
          const on = !machine && section === s;
          return (
            <li key={s}>
              <button type="button" className={cx('admin-assistant-menu-btn', on && 'active')} aria-current={on ? 'page' : undefined}
                data-testid={`assistant-nav-${s}`} onClick={() => (s === 'workflows' ? toWorkflowList() : go(s))}>
                <span>{t(`admin.assistantPage.sections.${s}.title`)}</span>
                {editing && changed.has(s) && (
                  <span className="admin-changed-dot" role="img" aria-label={t('admin.assistantPage.changedInDraft')} data-testid={`assistant-nav-${s}-changed`} />
                )}
                {unsavedAreas(unsaved, SECTION_AREAS[s]).length > 0 && (
                  <span className="admin-badge" data-testid={`assistant-nav-${s}-unsaved`}>{t('admin.assistantPage.unsaved.mark')}</span>
                )}
              </button>
              <p className="admin-assistant-menu-note">{notes[s]}</p>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  const sectionCard = (s: Section, children: React.ReactNode, testId?: string) => (
    <section className="admin-config-group" aria-labelledby={`assistant-section-${s}-title`} data-testid={testId ?? `assistant-section-${s}`}>
      <h3 id={`assistant-section-${s}-title`}>{t(`admin.assistantPage.sections.${s}.title`)}</h3>
      <p className="admin-config-group-help">{t(`admin.assistantPage.sections.${s}.help`, { name, classification: selected.classification ?? '' })}</p>
      {SECTION_GUIDES[s] && <GuideLinks guides={SECTION_GUIDES[s]!(t)} />}
      {children}
    </section>
  );

  // ---- Behavioral ----
  const behavioral = () => sectionCard('behavioral', (
    <>
      {editing ? (draft ? inline('identity') : draftLoading) : null}
      <dl className={STACK}>
        {!editing && (config ? (
          <>
            <Row testId="field-displayName" label={t('admin.profiles.assistantName')} help={t('admin.assistantPage.help.displayName', { name })}>
              {config.displayName
                ? <strong>{config.displayName}</strong>
                : <span className="admin-muted" data-testid="field-displayName-inherited">{t('admin.profiles.inheritsProvisionedName')} <strong>{selected.provisionedDisplayName || assistant}</strong></span>}
            </Row>
            <Row testId="field-persona" label={t('admin.profiles.persona')} help={t('admin.assistantPage.help.persona')}>
              {config.persona
                ? <details><summary>{t('admin.assistantPage.personaShow', { count: config.persona.length })}</summary><pre className="profiles-persona-readout">{config.persona}</pre></details>
                : catalog?.primaryAssistant && catalog.primaryAssistant !== assistant
                  ? <span className="admin-muted" data-testid="field-persona-not-primary">{t('admin.profiles.personaFallsBackNotPrimary', { primary: catalog.primaryAssistant })}</span>
                  : <span className="admin-muted">{t('admin.profiles.personaFallsBack')} <code>assistant-system-prompt</code> {t('admin.profiles.parameterIfThatClassificationWas')}</span>}
            </Row>
          </>
        ) : <dd>{notRead}</dd>)}
        <Row testId="field-classificationRole" label={t('admin.assistantPage.field.classificationRole')} help={t('admin.assistantPage.help.classificationRole')}>
          {selected.classification ?? '-'}{' · '}{selected.role ?? '-'}
          <FixedForLife />
        </Row>
        <Row testId="field-owner" label={t('admin.ownerControl.label')} help={t('admin.ownerControl.help')}>
          {ownerControl}
        </Row>
      </dl>
      {body && <PersonaExtras config={body} decisions={decisions} editing={editing} moveAction={editing && draft ? (
        <MoveIntoPersona key={draftKey} draft={draft} busy={busy} canEdit={canEdit} personaUnsaved={!!unsaved.identity && 'persona' in unsaved.identity}
          onSave={onSave} />
      ) : undefined} />}
    </>
  ), 'assistant-config-identity');

  // ---- Workflows ----
  const runByDefault = platformWorkflowsRunByDefault();
  /**
   * Copy a platform workflow in over the area's unsaved edit, which is saved with it rather than dropped: its workflows,
   * its canvas layout and every other field it holds. A copy that would conflict with one of the version's workflows (a
   * second untyped welcome, a second workflow on an event that selects its own) replaces it, once the person confirms.
   */
  const copyIn = (wfName: string) => {
    if (!draft) return;
    const base = draftWith('events', draft, unsaved.events);
    const conflict = platformCopyConflict(base.eventWorkflows, wfName);
    if (conflict && !window.confirm(t('admin.eventWorkflows.copyReplaces', { copy: wfName, replaced: conflict, name }))) return;
    const { workflows: next } = withPlatformCopy(base.eventWorkflows, wfName, { replace: !!conflict });
    void onSave({ ...(unsaved.events ?? {}), eventWorkflows: next }).then((saved) => { if (saved) onUnsavedDrop(['events']); });
  };
  const ownChip = <span className={cx('admin-chip', 'admin-chip-own')}>{t('admin.assistantPage.ownedBy', { name })}</span>;
  const platformChip = <span className={cx('admin-chip', 'admin-chip-platform')}>{t('admin.assistantPage.platformChip')}</span>;
  /**
   * EDIT IN A DRAFT: the draft's Workflows section, with the builder open on this workflow. A draft is started from the
   * active version when there is none.
   */
  const canOpenDraft = selected.hasDraft || canEdit;
  const editInDraft = (wfName: string) => {
    setFocusWorkflow(wfName);
    go('workflows');
    if (selected.hasDraft) onModeChange('draft');
    else onStartDraft();
  };
  const workflowItem = (wfName: string, wf: EventWorkflow, own: boolean, extra?: { note?: React.ReactNode; details?: React.ReactNode }) => (
    <li key={`${own ? 'own' : 'platform'}:${wfName}`} className={cx('admin-workflow-item', !own && 'admin-workflow-item-platform', focusEvent === wfName && 'admin-workflow-item-focus')}
      data-testid={`assistant-workflow-${own ? 'own' : 'platform'}-${wfName}`} aria-current={focusEvent === wfName ? 'true' : undefined}>
      <div className="admin-workflow-item-head">
        <code>{wfName}</code>{own ? ownChip : platformChip}
        {!own && (
          <span className={cx('admin-chip', 'admin-chip-platform')} data-testid={`assistant-workflow-platform-${wfName}-runs`}>
            {runByDefault.has(wfName) ? t('admin.eventWorkflows.runsByDefault') : t('admin.eventWorkflows.runsOnceCopied')}
          </span>
        )}
        {!own && !runByDefault.has(wfName) && editing && canEdit && (
          <button type="button" className="btn-secondary" disabled={busy || !draft} data-testid={`assistant-copy-${wfName}`} onClick={() => copyIn(wfName)}>
            {t('admin.assistantPage.copyTo', { name })}
          </button>
        )}
        {/* ONE WAY IN FOR EVERY WORKFLOW THAT RUNS: a shipped one reaches the draft as this assistant's own on its first change. */}
        {(own || runByDefault.has(wfName)) && canOpenDraft && (
          <button type="button" className={cx('btn-secondary', 'btn-sm')} disabled={busy} data-testid={`assistant-edit-workflow-${wfName}`}
            aria-label={t('admin.eventWorkflows.editLabel', { name: wfName })} onClick={() => editInDraft(wfName)}>
            {t('admin.eventWorkflows.edit')}
          </button>
        )}
      </div>
      {extra?.note}
      <details data-testid={`assistant-workflow-${own ? 'own' : 'platform'}-${wfName}-details`} open={focusEvent === wfName || undefined}>
        <summary>{t('admin.workflowsList.details')}</summary>
        <EventWorkflowSummary name={wfName} workflow={wf} role={selected.role} all={body?.eventWorkflows} />
        {extra?.details}
      </details>
      {/* AN AGENT STEP THAT OPENS A TASK (`agent.workflow`, a stored version's shape) runs the platform's steps for it; a task step runs the version's own (ADR-067 stage 2). */}
      {Object.values(wf.states ?? {}).some((d) => d?.agent?.workflow) && (
        <span className="admin-field-hint" data-testid={`assistant-workflow-${wfName}-first-look`}>{t('admin.workflowsList.firstLook')}</span>
      )}
    </li>
  );
  /** A task workflow's row actions, at the row's right edge as every workflow row's are: its steps, and Edit where the version may own them. */
  const machineActions = (key: string) => (
    <span className="admin-workflow-item-actions">
      <button type="button" className={cx('btn-secondary', 'btn-sm')} data-testid={`assistant-machine-${key}`} onClick={() => openMachine(key, 'workflows')}>
        {t('admin.assistantPage.viewSteps')}
      </button>
      {!isPlatformMachineKey(key) && canOpenDraft && (
        <button type="button" className={cx('btn-secondary', 'btn-sm')} disabled={busy} data-testid={`assistant-edit-machine-${key}`}
          aria-label={t('admin.eventWorkflows.editLabel', { name: key })} onClick={() => editMachineInDraft(key)}>
          {t('admin.eventWorkflows.edit')}
        </button>
      )}
    </span>
  );
  /**
   * THE REQUESTS THAT OPEN A TASK, one row per multi-step intent the version serves. A catalog that lists no intents (an
   * older API) falls back to the version's non-platform workflows, keyed by the machine, so the list is never empty for
   * want of a field.
   */
  const served = servedIntents(body, catalog);
  const intentRows: Array<{ key: string; machine?: string }> | undefined = served
    ? served.filter((i) => i.multiStep).map((i) => ({ key: i.key, machine: i.machine }))
    : catalog?.workflows ? catalog.workflows.filter((w) => !isPlatformMachineKey(w.key)).map((w) => ({ key: w.key, machine: w.key })) : undefined;
  // THE VERSION'S OWN MACHINES, from its pack: they run over the classification's (`withVersionMachines`), so a row reads them first.
  const ownMachines = (body?.intentPack as { machines?: Record<string, TaskStateMachine> } | undefined)?.machines ?? {};
  const machineSource = (key: string): 'platform' | 'classification' | 'own' | undefined =>
    ownMachines[key] && !isPlatformMachineKey(key) ? 'own' : catalog?.workflows?.find((x) => x.key === key)?.source;
  // A MACHINE NO LISTED INTENT RUNS is still the version's or the classification's, so it is listed under its own key.
  const unlinkedMachines = intentRows ? [...new Set([...Object.keys(ownMachines), ...(catalog?.workflows ?? []).filter((w) => w.source === 'classification').map((w) => w.key)])]
    .filter((k) => !isPlatformMachineKey(k) && !intentRows.some((i) => i.machine === k)) : [];
  // A WORKFLOW OPENED FOR EDIT IS THE WHOLE VIEW: its editor and the way back, with the other workflows out of the way.
  const workflowFocused = editing && !!focusWorkflow;
  const workflows = () => sectionCard('workflows', !body ? (editing ? draftLoading : notRead) : workflowFocused ? (
    <>
      <button type="button" className="btn-link" data-testid="welcome-focus-back" onClick={toWorkflowList}>{t('admin.workflowsList.backToAll')}</button>
      {inline('events')}
    </>
  ) : (
    <>
      {/* THE PAGE OPENS ON THE LIST, NOTHING OPENED: a workflow opens from its row, and a new one from here, for whoever may edit. */}
      {canEdit && (
        <div className="admin-workflow-item-actions">
          <button type="button" className="btn-primary" disabled={busy} data-testid="workflows-new" onClick={() => editInDraft(NEW_WORKFLOW_FOCUS)}>
            {t('admin.workflowEditor.newWorkflow')}
          </button>
        </div>
      )}
      {/* ONE WORKFLOWS LIST, GROUPED BY WHAT STARTS EACH (ADR-067 stage 1): the welcome first, then each event, then the
          requests a person makes, then the platform's own, which no team edits. */}
      <h3 data-testid="workflows-heading-events">{t('admin.assistantPage.eventWorkflowsHeading')}</h3>
      <h4 data-testid="workflows-group-welcome">{t('admin.eventWorkflows.eventShort.assistant-joined')}</h4>
      <p className="admin-field-hint">{t('admin.assistantPage.sub.welcomeHelp', { name })}</p>
      <ul className="admin-workflow-list" data-testid="field-welcome">
        {ownWorkflows(body, true).map(([n, wf]) => workflowItem(n, wf, true))}
        {/* THE WELCOME THAT RUNS WHERE THIS VERSION DECLARES NO DEFAULT OF ITS OWN: a row like any other workflow. */}
        {!ownWorkflows(body, true).some(([, wf]) => !wf.types?.length) && workflowItem('welcome', platformWorkflows(true).find(([n]) => n === 'welcome')![1], false, {
          note: (
            <span className="admin-field-hint" data-testid="assistant-welcome-built-in">
              {catalog?.welcomeOrientation && (!catalog.primaryAssistant || catalog.primaryAssistant === assistant)
                ? t('admin.assistantPage.help.welcomeClassification', { classification: classificationName(selected.classification ?? '') })
                : t('admin.assistantPage.help.welcomePlatform')}
            </span>
          ),
          details: <GreetedWith workflows={body.eventWorkflows} classification={selected.classification} role={selected.role}
            context={welcomeContextFor({ version: body, catalog, assistant, role: selected.role, provisionedName: selected.provisionedDisplayName })} />,
        })}
      </ul>

      <div data-testid="field-event-workflows">
        {EVENT_WORKFLOW_EVENTS.filter((on) => on !== 'assistant-joined').map((on) => {
          const own = ownWorkflows(body, false).filter(([, wf]) => wf.on === on);
          // A SHIPPED WORKFLOW THAT IS RUNNING appears under its event, until this assistant has its own for that event.
          const defaults = own.length ? [] : platformWorkflows(false).filter(([n, wf]) => wf.on === on && runByDefault.has(n));
          if (!own.length && !defaults.length) return null;
          return (
            <section key={on} data-testid={`workflows-group-${on}`}>
              <h4>{t(`admin.eventWorkflows.eventShort.${on}`)}</h4>
              <p className="admin-field-hint">{t(`admin.eventWorkflows.event.${on}`)}</p>
              {/* THE PLATFORM ADDS join-recap AS THE LAST STEP of every person-joined workflow at runtime; it is never in the draft. */}
              {on === 'person-joined' && own.length > 0 && <p className="admin-field-hint" data-testid="workflows-join-recap">{t('admin.workflowsList.joinRecap')}</p>}
              <ul className="admin-workflow-list">
                {own.map(([n, wf]) => workflowItem(n, wf, true))}
                {defaults.map(([n, wf]) => workflowItem(n, wf, false))}
              </ul>
            </section>
          );
        })}
      </div>
      {/* THE SAME WORKFLOWS, BY THE ROOM THEY RUN IN: what runs in the ops team room, an ops room, a meeting's conversation. */}
      {!editing && <RoomTypeWorkflows name={name} workflows={body?.eventWorkflows} classification={selected.classification} />}

      {/* WHEN SOMEONE ASKS: every multi-step intent, drawn as the default workflow the router runs for it (one task of its
          machine). Only a task's steps differ by version; in stage 1 they are read here, and the steps around the task are
          the runtime's until stage 3. */}
      <h3 data-testid="workflows-group-intents">{t('admin.workflowsList.whenAsked')}</h3>
      <p className="admin-field-hint">{t('admin.workflowsList.whenAskedHelp', { name })}</p>
      {!intentRows ? <span className="admin-muted">{t('admin.assistantPage.unreadable')}</span> : (
        <ul className="admin-workflow-list" data-testid="field-machines">
          {intentRows.map((i) => {
            const machineKey = i.machine;
            const source = machineKey ? machineSource(machineKey) : undefined;
            const w = source ? { source } : undefined;
            const offered = machineKey ? workflowSelected(body, catalog, machineKey) : true;
            const reason = !machineKey || !w ? t('admin.workflowsList.reason.general')
              : isPlatformMachineKey(machineKey) ? t('admin.workflowsList.reason.platformItem')
                : !offered ? t('admin.workflowsList.reason.notOffered', { name })
                  : t('admin.workflowsList.reason.runLevel');
            return (
              <li key={i.key} className={cx('admin-workflow-item', 'admin-workflow-item-platform', focusIntent === i.key && 'admin-workflow-item-focus')}
                data-testid={`workflow-intent-${i.key}`} aria-current={focusIntent === i.key ? 'true' : undefined}>
                <div className="admin-workflow-item-head">
                  <code>{i.key}</code>
                  {machineKey && w && <code className="admin-chip">{machineKey}</code>}
                  {w && (
                    <span className={cx('admin-chip', w.source === 'own' ? 'admin-chip-own' : 'admin-chip-platform')}>{w.source === 'platform'
                      ? t('admin.assistantPage.shipped')
                      : w.source === 'own' ? t('admin.machineBuilder.ownChip', { name })
                        : t('admin.assistantPage.packOf', { classification: catalog?.classification ?? '' })}</span>
                  )}
                  {machineKey && w && (
                    <span className={cx('admin-chip', offered && 'admin-chip-own')} data-testid={`assistant-machine-${machineKey}-selected`}>
                      {offered ? t('admin.assistantPage.workflowSelected') : t('admin.assistantPage.workflowNotSelected')}
                    </span>
                  )}
                  {machineKey && w && machineActions(machineKey)}
                </div>
                <span className="admin-field-hint" data-testid={`workflow-intent-${i.key}-reason`}>{reason}</span>
                {/* THE WORKFLOW'S ASSIGNED TASKS, EACH WITH ITS STATES: the version's declared workflow, or for one
                    stored before every workflow was declared, the task it opens today. */}
                {(() => {
                  const wf = (body.intentWorkflows as Record<string, IntentWorkflow> | undefined)?.[i.key] ?? (machineKey && offered ? canonicalIntentWorkflow(i.key) : undefined);
                  const tasks = wf ? assignedTasksOf(wf, { ...DEFAULT_TASK_STATE_MACHINES, ...(catalog?.storedPack?.machines ?? {}), ...ownMachines }, (m) => catalog?.workflows?.find((w) => w.key === m)?.states) : [];
                  return tasks.length ? (
                    <ul className="admin-plain-list" data-testid={`workflow-intent-${i.key}-tasks`}>
                      {tasks.map((task) => (
                        <li key={task.step}>{t('admin.intentWorkflows.assignedTask', { step: task.step })} <code>{task.machine}</code>{' '}
                          <span className="admin-muted">{task.states.join(' → ')}</span></li>
                      ))}
                    </ul>
                  ) : null;
                })()}
              </li>
            );
          })}
          {unlinkedMachines.map((k) => (
            <li key={`machine:${k}`} className={cx('admin-workflow-item', 'admin-workflow-item-platform')} data-testid={`workflow-machine-${k}`}>
              <div className="admin-workflow-item-head">
                <code>{k}</code>
                <span className={cx('admin-chip', machineSource(k) === 'own' ? 'admin-chip-own' : 'admin-chip-platform')}>{machineSource(k) === 'own'
                  ? t('admin.machineBuilder.ownChip', { name }) : t('admin.assistantPage.packOf', { classification: catalog?.classification ?? '' })}</span>
                {machineActions(k)}
              </div>
              <span className="admin-field-hint" data-testid={`workflow-machine-${k}-reason`}>{t('admin.workflowsList.reason.noIntent')}</span>
            </li>
          ))}
          {!intentRows.length && !unlinkedMachines.length && <li className="admin-muted">{t('admin.workflowsList.noIntents')}</li>}
        </ul>
      )}

      {/* THE TASKS THIS ROLE IS GIVEN (ADR-067 WT78): another assistant's workflow gives this assistant's role a task, which
          runs the named request's workflow from this version; listed so the team knows what it is asked to do. */}
      {selected.role && (
        <>
          <h4 data-testid="workflows-group-role-tasks">{t('admin.workflowsList.roleTasks', { role: selected.role })}</h4>
          <p className="admin-field-hint">{t('admin.workflowsList.roleTasksHelp', { name })}</p>
          <ul className="admin-workflow-list" data-testid="field-role-tasks">
            {(props.roleTasks ?? []).map((r) => (
              <li key={`${r.assistant}-${r.workflow}-${r.step}`} data-testid={`role-task-${r.workflow}-${r.step}`}>
                {/* A REQUEST FOR AN INTENT THIS ASSISTANT ADVERTISES (WT78, WT118): the task's machine is the intent asked for. */}
                <span>{t('admin.workflowsList.roleTaskFrom', { assistant: r.assistant, machine: r.machine, workflow: r.workflow, step: r.step })}</span>
              </li>
            ))}
            {!(props.roleTasks ?? []).length && <li className="admin-muted" data-testid="role-tasks-none">{t('admin.workflowsList.roleTasksNone')}</li>}
          </ul>
        </>
      )}

      <dl className={STACK}>
        <Row testId="field-confirm-brief" label={t('admin.assistantPage.field.confirmBrief')} help={t('admin.assistantPage.help.confirmBrief')}
          path={<EditPath field="confirmBrief" decision={decisions.confirmBrief} />}>
          {Object.keys(body.confirmBrief ?? {}).length
            ? Object.entries(body.confirmBrief!).map(([w, p]) => <span key={w} className="admin-chip"><code>{w}</code> <code>{p}</code></span>)
            : <span className="admin-muted">{t('admin.assistantPage.none')}</span>}
        </Row>
        <Row testId="field-templates" label={t('admin.assistantPage.field.templates')} help={t('admin.assistantPage.help.templates')}
          path={<div className="admin-field-hint">
            <code>npm run template -- put|activate|rollback|list|check {catalog?.classification ?? '<classification>'}</code>{' '}
            <code>templates/{catalog?.classification ?? '<classification>'}/</code>
            <GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'documentTemplates')]} />
          </div>}>
          {catalog?.templates === undefined
            ? <span className="admin-muted">{t('admin.assistantPage.unreadable')}</span>
            : catalog.templates.length === 0
              ? <span className="admin-muted">{t('admin.assistantPage.none')}</span>
              : catalog.templates.map((tpl) => <span key={tpl.name} className="admin-chip"><code>{tpl.name}</code> <code>{tpl.active.slice(0, 12)}</code></span>)}
        </Row>
      </dl>

      <div className="admin-config-stack-wrap"><WordsGroup config={body} decisions={decisions} catalog={catalog} profileName={assistant} /></div>

      {/* EVERYTHING THE PLATFORM OWNS, IN ONE PLACE AND CLOSED: the same for every assistant, so it is reference and not this assistant's. */}
      <details data-testid="workflows-platform-details">
        <summary>{t('admin.workflowsList.platformDetails')}</summary>
        <h4>{t('admin.workflowsList.shippedTitle')}</h4>
        <p className="admin-field-hint">{t('admin.workflowsList.shippedHelp')}</p>
        <ul className="admin-workflow-list" data-testid="workflows-shipped">
          {[...platformWorkflows(true), ...platformWorkflows(false)].filter(([n]) => !runByDefault.has(n)).map(([n, wf]) => workflowItem(n, wf, false))}
        </ul>
        {/* THE PLATFORM'S WORKFLOWS: the ones that open, show, close and queue tasks. Fixed for every
            assistant so they behave the same everywhere; read here, never edited or copied. */}
        <section className="admin-workflow-platform" data-testid="workflows-platform-section" aria-labelledby="workflows-platform-title">
          <h4 id="workflows-platform-title">{t('admin.workflowsList.platformTitle')} <span className="admin-badge">{t('admin.assistantPage.platform.badge')}</span></h4>
          {groupPlatformWorkflows((catalog?.workflows ?? []).filter((w) => isPlatformMachineKey(w.key))).map((group) => (
            <div key={group.id} data-testid={`workflows-platform-group-${group.id}`}>
              <h5>{t(`admin.workflowsList.platformGroup.${group.id}.title`)}</h5>
              <p className="admin-field-hint">{t(`admin.workflowsList.platformGroup.${group.id}.help`)}</p>
              <ul className="admin-workflow-list">
                {group.workflows.map((w) => (
                  <li key={w.key} className={cx('admin-workflow-item', 'admin-workflow-item-platform')} data-testid={`assistant-machine-row-${w.key}`}>
                    <div className="admin-workflow-item-head">
                      <code>{w.key}</code>
                      <span className={cx('admin-chip', 'admin-chip-platform')}>{t('admin.assistantPage.platform.badge')}</span>
                      <button type="button" className={cx('btn-secondary', 'btn-sm')} data-testid={`assistant-machine-${w.key}`} onClick={() => openMachine(w.key, 'workflows')}>
                        {t('admin.assistantPage.viewSteps')}
                      </button>
                    </div>
                    <span>{w.required ? t('admin.assistantPage.requiredMachine') : t('admin.workflowsList.platformMachine')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
        <EditPath field="machines" decision={decisions.machines} />
        <PlatformSection />
      </details>
    </>
  ));

  // ---- Scope and models ----
  // WHERE THE INTENTS COME FROM, above the list of them.
  const intentsNote = () => (
    <div data-testid="field-intentPack">
      <p className="admin-field-hint">{[
        t('admin.assistantPage.help.intentPack'),
        ...(body?.intentPack?.intents ? [] : [t('admin.assistantPage.help.intentsInherited')]),
        // A classification that sets no pack serves the platform's default pack, as the runtime does.
        ...(!body?.intentPack?.intents && catalog?.packSource === 'platform' ? [t('admin.assistantPage.help.intentsPlatformDefault')] : []),
      ].join(' ')}</p>
      <EditPath field="intentPack" decision={decisions.intentPack} />
    </div>
  );
  // ---- Messages ----
  // A TEMPLATE IS READ AND SAVED APART FROM ANY VERSION, so the section shows and edits every template with no draft open;
  // which template a version uses for a message is the one part that waits for a draft.
  const messagesSection = () => sectionCard('messages', !body ? (editing ? draftLoading : notRead) : (
    <>
      {editing ? inline('messages') : (
        <MessageTemplatesEditor key={JSON.stringify(body.messages ?? null)} profileName={assistant} messages={body.messages} canSave={ctx.canActivate} picksNote={t('admin.messageChoices.inDraft')}
          published={catalog?.variables} variables={body.variables} deploymentLines={catalog?.deploymentLines}
          contextSources={(body.contextSources ?? []).map((c) => (typeof c === 'string' ? c : (c as { key: string }).key))} />
      )}
    </>
  ));

  const scope = () => sectionCard('scope', !body ? (editing ? draftLoading : notRead) : (
    <>
      {editing ? (
        <ScopeDraft key={`scope:${draftKey}:${reset}`} modeRow={<dl className={STACK}><ClassifierModeRow selected={selected} /></dl>} intentsNote={intentsNote()} draft={body} catalog={catalog} busy={busy} canEdit={canEdit} name={name} assistant={assistant}
          classifierMode={selected.deployedClassifierMode}
          unsaved={unsaved.models} onUnsavedPatch={(p) => onUnsavedPatch('models', p)}
          onSave={() => { void saveAreas(['models']); }} onReset={() => resetArea('models')}
          onOpenLink={onOpenLink} onOpenWorkflows={showInWorkflows} refusals={validation?.errorDetails} />
      ) : (
        <>
          <h4>{t('admin.assistantPage.classificationHeading')}</h4>
          <dl className={STACK}>
            <ClassifierModeRow selected={selected} />
            {selected.deployedClassifierMode !== 'keyword' && (
              <Row testId="field-classifierModel" label={t('admin.profiles.classifierModel')} help={t('admin.assistantPage.help.classifierModel')}>
                <ModelValue model={body.models?.classifier} />
              </Row>
            )}
          </dl>
          <h4>{t('admin.assistantPage.intents')}</h4>
          <dl className={STACK}>
            <Row testId="field-defaultModel" label={t('admin.assistantPage.field.defaultModel')} help={t('admin.assistantPage.help.defaultModel')}>
              {/* What serves: `models.default` when concrete, else `modelKey`, else the classification default (`resolveFromDefinition`). */}
              <ModelValue model={body.models?.default && body.models.default !== DEFAULT_MODEL ? body.models.default : body.modelKey}
                classificationDefault={catalog?.models.default} />
            </Row>
          </dl>
          {intentsNote()}
          <IntentCards cards={cards} body={body} catalog={catalog} name={name} assistant={assistant} onOpenLink={onOpenLink} onOpenWorkflows={showInWorkflows} />
        </>
      )}
      <dl className={STACK}>
        {!editing && (
          <Row testId="field-routing" label={t('admin.draftCards.area.routing')} help={t('admin.draftCards.help.routing')}>
            {areaSummary('routing', body, t, assistant)}
          </Row>
        )}
      </dl>
      <PlatformIntents body={body} catalog={catalog} />
      <dl className={STACK}>
        {/* THE PLATFORM INTENTS THE SERVED PACK LEAVES OUT, which the router declines (`refusedPlatformIntents`). */}
        <Row testId="field-refusedIntents" label={t('admin.assistantPage.field.refusedIntents')} help={t('admin.assistantPage.help.refusedIntents')}>
          {refusedIntentKeys(body, catalog).length
            ? refusedIntentKeys(body, catalog).map((k) => <code key={k} className="admin-chip">{k}</code>)
            : <span className="admin-muted">{t('admin.assistantPage.refusedNone')}</span>}
        </Row>
      </dl>
      {editing && inline('routing')}
    </>
  ));

  // ---- Tools and context ----
  const toolsSection = () => {
    const fn = selected.resolved?.processorFunctionName;
    const region = selected.resolved?.region;
    return sectionCard('tools', !body ? (editing ? draftLoading : notRead) : (
      <>
        {editing ? inline('abilities') : (
          <dl className={STACK}>
            <Row testId="field-tools" label={t('admin.profiles.tools')} help={t('admin.assistantPage.toolsHelp')}>
              {!body.tools?.length ? <span className="admin-muted">{t('admin.profiles.noToolsEnabledForThis')}</span> : (
                <ul className="admin-tool-list">
                  {body.tools.map((tool) => {
                    const info = tools.find((x) => x.name === tool);
                    return (
                      <li key={tool}>
                        <code className="admin-chip">{tool}</code>{' '}
                        <DocLink href={fn ? cloudwatchLogsUrl(fn, tool, region) : lambdaFunctionsUrl()}>{t('admin.assistantPage.toolLogs')}</DocLink>
                        {info && <span className="admin-field-hint"> {info.description} {t('admin.assistantPage.toolNeeds', { requires: info.requires })}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {fn && body.tools?.length ? (
                <DocLink href={lambdaFunctionUrl(fn, region)}>{t('admin.assistantPage.toolLoopLambda', { fn })}</DocLink>
              ) : null}
            </Row>
          </dl>
        )}
        <div className="admin-config-stack-wrap">
          <ContextGroup config={body} configLoading={configLoading && !editing} catalog={catalog} role={selected.role} />
        </div>
      </>
    ));
  };

  // ---- Settings ----
  const settings = () => {
    const gid = body?.guardrailId || selected.resolved?.guardrailId;
    return sectionCard('settings', !body ? (editing ? draftLoading : notRead) : (
      <>
        {editing ? inline('settings') : (
          <dl className={STACK}>
            <Row testId="field-guardrail" label={t('admin.profiles.guardrail')} help={t('admin.assistantPage.help.guardrail')}>
              {gid
                ? (gid === selected.resolved?.guardrailId && selected.resolved?.guardrailName
                  ? <DocLink href={bedrockGuardrailUrl(selected.resolved.guardrailName, gid, selected.resolved.region)}><code>{gid}</code></DocLink>
                  : <code>{gid}</code>)
                : <span className="admin-muted">{t('admin.assistantPage.help.guardrailDefault')} <DocLink href={bedrockGuardrailsUrl()}>{t('admin.assistantPage.guardrailsConsole')}</DocLink></span>}
              <div data-testid="guardrail-edit-path"><GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'changeGuardrail')]} /></div>
            </Row>
          </dl>
        )}
        <h4>{t('admin.config.group.limits')}</h4>
        <p className="admin-field-hint">{t('admin.config.help.limits')}</p>
        <div className="admin-config-stack-wrap" data-testid="assistant-config-limits">{limits}</div>
      </>
    ));
  };

  // ---- Infrastructure ----
  const infrastructureSection = () => sectionCard('infrastructure', infrastructure);

  // ---- Processes (SPEC-PROCESSES P1): the version's processes; in the draft, edited and saved as one area. ----
  const processesSection = () => sectionCard('processes', !body ? (editing ? draftLoading : notRead)
    : editing ? (draft ? inline('processes') : draftLoading)
      : <ProcessList processes={body.processes} name={name} workflows={linkableOf({ eventWorkflows: body.eventWorkflows, intentWorkflows: (body as { intentWorkflows?: unknown }).intentWorkflows })} onOpenWorkflows={() => go('workflows')}
        assistant={selected.profileName} draft={selected.activeVersion === null} />);

  // ---- Variables ----
  const variables = () => sectionCard('variables', !body ? (editing ? draftLoading : notRead) : (
    <VariablesFields {...ctx} draft={body} onPatch={() => undefined} />
  ));

  // ---- One task machine ----
  const machineView = () => {
    const m = catalog?.workflows?.find((w) => w.key === machine!.key);
    // AN INTENT THE PLATFORM RAISES HAS NO CLASSIFIED TURNS, so no performance link is offered for it.
    const answers = isPlatformRaisedMachine(machine!.key) ? [] : intentsRunning(body, catalog, machine!.key);
    const key = machine!.key;
    // WHICH TASK STEPS A TEAM EDITS (ADR-067 stages 1 and 2): an intent's own machine, and a machine a workflow step opens
    // (the incident first look), on the version. The platform's machines are fixed for every assistant.
    const editableKey = !isPlatformMachineKey(key);
    const own = editing ? ownEntry((draft?.intentPack as { machines?: Record<string, TaskStateMachine> } | undefined)?.machines, key) : undefined;
    const canEditHere = editing && canEdit && !!draft && editableKey;
    // WHAT A COPY STARTS FROM: the shipped machine, or the classification pack's own, read from the pack as it is stored.
    const starting = m?.source === 'platform' ? ownEntry(DEFAULT_TASK_STATE_MACHINES, key) : ownEntry(catalog?.storedPack?.machines, key);
    const shown = machineEdit ?? own;
    // WHERE ITS STEPS SIT rides the version's layout under the machine's own key, saved with the machine (ADR-061 decision 7).
    const layoutKey = machineLayoutKey(key);
    const savedPoints = ctx.layout?.[layoutKey];
    // A STEP'S MODEL is the version's route (`models.byIntent[<intent>].steps`), held as the models area's unsaved edit, so
    // the intent card under Purview shows the same value, and saved with the machine.
    const stepModels = draft ? draftWith('models', draft, unsaved.models).models : undefined;
    const stepModelBody = draft ? { ...draft, models: stepModels } : null;
    const routesStep = answers.includes(key);
    const saveMachine = (next: TaskStateMachine) => {
      if (!draft) return;
      void onSave({
        ...(unsaved.models ?? {}),
        intentPack: packWithMachine(draft.intentPack as Parameters<typeof packWithMachine>[0], key, next, catalog?.storedPack) as ProfileDraftPatch['intentPack'],
        ...(machinePoints ? { layout: { ...(ctx.layout ?? {}), [layoutKey]: machinePoints as Record<string, StepPosition> } } : {}),
      }).then((saved) => { if (saved) { setMachineEdit(null); setMachinePoints(null); if (unsaved.models) onUnsavedDrop(['models']); } });
    };
    const machineChanged = !!machineEdit || !!machinePoints || !!unsaved.models;
    return (
      <section className="admin-config-group" aria-labelledby="assistant-machine-title" data-testid="assistant-machine-view">
        <div>
          <button type="button" className="btn-link" data-testid="assistant-machine-back" onClick={() => setMachine(null)}>
            ← {t('admin.assistantPage.backTo', { section: t(`admin.assistantPage.sections.${machine!.from}.title`) })}
          </button>
        </div>
        <div className="admin-workflow-item-head">
          <h3 id="assistant-machine-title"><code>{machine!.key}</code></h3>
          {m && <span className={cx('admin-chip', 'admin-chip-platform')}>{m.source === 'platform'
            ? t('admin.assistantPage.shipped') : t('admin.assistantPage.packOf', { classification: catalog!.classification })}</span>}
          {canEditHere && own
            ? <span className={cx('admin-chip', 'admin-chip-own')}>{t('admin.machineBuilder.ownChip', { name })}</span>
            : <span className="admin-chip">{t('admin.assistantPage.readOnlyChip')}</span>}
          {!editing && editableKey && canOpenDraft && m && (
            <button type="button" className={cx('btn-secondary', 'btn-sm')} disabled={busy} data-testid="assistant-machine-edit"
              onClick={() => editMachineInDraft(key)}>{t('admin.machineBuilder.editInDraft')}</button>
          )}
        </div>
        <p className="admin-config-group-help">
          {m?.source === 'platform'
            ? t('admin.assistantPage.machine.shippedHelp', { classification: selected.classification ?? '' })
            : t('admin.assistantPage.machine.packHelp', { classification: selected.classification ?? '' })}{' '}
          {answers.length ? t('admin.assistantPage.answers', { intents: answers.join(', ') }) : t('admin.assistantPage.answersNone')}{' '}
          {t('admin.assistantPage.machine.stepsHelp')}
        </p>
        {canEditHere && shown ? (
          <div data-testid="assistant-machine-editor">
            <p className="admin-field-hint">{t('admin.machineBuilder.editHelp', { name })}</p>
            <MachineBuilderWithTemplates profileName={assistant} emailConfigured={catalog?.emailConfigured} participantRoles={declaredParticipantRoles(catalog)} name={key} machine={shown} onChange={setMachineEdit} initialStep={focusStep ?? undefined} tools={tools} versionTools={draft?.tools}
              serverErrors={validation?.errors} layout={machinePoints ?? savedPoints} onLayoutChange={setMachinePoints}
              renderStepModel={routesStep ? (state, def) => (
                <>
                  <StepModelControl body={stepModelBody} catalog={catalog} intent={key} step={{ key: state, produces: def.produces }}
                    onRoute={(route) => onUnsavedPatch('models', { models: withRoute(stepModels, key, route) })} />
                  <StepModelsHelp />
                </>
              ) : undefined} />
            <div className="admin-config-actions">
              <ConfirmAction testId="assistant-machine-reset" className="btn-ghost" disabled={busy || (!machineEdit && !machinePoints)} label={t('admin.assistantPage.reset')}
                title={t('admin.confirm.machineReset')} confirmLabel={t('admin.confirm.discard')} cancelLabel={t('admin.confirm.cancel')}
                onConfirm={() => { setMachineEdit(null); setMachinePoints(null); }} />
              <button type="button" className="btn-primary" disabled={busy || !machineChanged} data-testid="assistant-machine-save" onClick={() => saveMachine(machineEdit ?? shown)}>
                {t('admin.draftCards.save')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {canEditHere && !own && (
              starting ? (
                <p className="admin-field-hint" data-testid="assistant-machine-copy-row">
                  {t('admin.machineBuilder.copyHelp', { name })}{' '}
                  <button type="button" className="btn-secondary" disabled={busy} data-testid="assistant-machine-copy"
                    onClick={() => saveMachine(JSON.parse(JSON.stringify(starting)) as TaskStateMachine)}>
                    {t('admin.machineBuilder.copyIn', { name })}
                  </button>
                </p>
              ) : <p className="admin-field-hint" data-testid="assistant-machine-not-copied">{t('admin.machineBuilder.notCopied', { name })}</p>
            )}
            {editing && !editableKey && <p className="admin-field-hint" data-testid="assistant-machine-fixed">{t('admin.machineBuilder.platformFixed')}</p>}
            {!m ? <span className="admin-muted">{t('admin.assistantPage.unreadable')}</span>
              : m.steps?.length ? <MachineSteps steps={m.steps} name={name} focus={focusStep} />
                : <WorkflowGroups workflows={[m]} testId="assistant-machine-states" />}
          </>
        )}
        {answers.length > 0 && (
          <div className="admin-assistant-perf">
            <span className="admin-muted">{t('admin.assistantPage.performance')}</span>
            {answers.map((i) => (
              <ConsoleLink key={i} link={{ tab: 'effectiveness', assistant, intent: i }} onOpen={onOpenLink} testId={`assistant-machine-perf-${i}`}
                title={t('admin.assistantPage.intentPerformanceTitle', { name, intent: i })}>
                {t('admin.assistantPage.intentPerformance', { intent: i })}
              </ConsoleLink>
            ))}
          </div>
        )}
      </section>
    );
  };

  const sectionBody = (s: Section) => (machine ? machineView()
    : s === 'behavioral' ? behavioral()
      : s === 'workflows' ? workflows()
        : s === 'processes' ? processesSection()
        : s === 'messages' ? messagesSection()
        : s === 'scope' ? scope()
          : s === 'tools' ? toolsSection()
          : s === 'settings' ? settings()
          : s === 'infrastructure' ? infrastructureSection()
            : s === 'variables' ? variables()
              : sectionCard('versions', <>{versions}<GoldenUploadPanel profileName={selected.profileName} /></>));

  const breadcrumb = (
    <div className="admin-tab-header">
      <nav className="admin-breadcrumb" aria-label={t('admin.config.path')}>
        <button className="btn-link" onClick={onBack}>← {t('admin.config.back')}</button>
        <span> / </span>
        <span>{name}</span>
        {/* THE WORKFLOWS LEVEL: a link back to the list while a workflow or the create view is open, the trail's end on the list. */}
        {section === 'workflows' && !machine && (
          <>
            <span> / </span>
            {editing && focusWorkflow
              ? <button type="button" className="btn-link" data-testid="breadcrumb-workflows" onClick={toWorkflowList}>{t('admin.assistantPage.sections.workflows.title')}</button>
              : <span data-testid="breadcrumb-workflows" aria-current="page">{t('admin.assistantPage.sections.workflows.title')}</span>}
            {editing && focusWorkflow && (
              <>
                <span> / </span>
                <span data-testid="breadcrumb-workflow" aria-current="page">{focusWorkflow === NEW_WORKFLOW_FOCUS ? t('admin.workflowEditor.newWorkflowCrumb') : focusWorkflow}</span>
              </>
            )}
          </>
        )}
      </nav>
      {leaving && (
        <ConfirmPanel testId="workflow-leave" title={t('admin.confirm.leaveWorkflow')} body={t('admin.confirm.leaveWorkflowBody')}
          confirmLabel={t('admin.confirm.leave')} cancelLabel={t('admin.confirm.cancel')} onConfirm={leaveWorkflow} onCancel={() => setLeaving(false)} />
      )}
    </div>
  );

  // ---- The creation wizard, on the built assistant's first draft ----
  if (wizard) {
    const at = CREATION_STEPS.indexOf(step);
    const order = [...WIZARD_SECTIONS, 'review'] as const;
    const i = order.indexOf(step);
    const go = (to: number) => { setMachine(null); setStep(order[Math.max(0, Math.min(order.length - 1, to))]); };
    const held = step === 'review' ? [] : unsavedAreas(unsaved, SECTION_AREAS[step]);
    return (
      <div className={cx('admin-tab', 'admin-assistant-page')}>
        {breadcrumb}
        <h2>{name}</h2>
        {notices}
        <section className="admin-config-group" aria-labelledby="assistant-setup-title" data-testid="assistant-setup">
          <h3 id="assistant-setup-title">{t('admin.create.title')}</h3>
          <WizardSteps steps={creationSteps(t)} current={at} headingTestId="setup-step-heading" />
          {step === 'review' ? banner : sectionBody(step)}
          <div className="admin-config-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={wizard.onFinishLater} data-testid="setup-finish-later">{t('admin.create.finishLater')}</button>
            {i > 0 && <button type="button" className="btn-secondary" disabled={busy} onClick={() => go(i - 1)}>{t('admin.create.back')}</button>}
            {step !== 'review' && (
              // Next saves this step's unsaved edits first, as one patch; a save that does not land keeps the step.
              <button type="button" className="btn-primary" disabled={busy || (held.length > 0 && !canEdit)} data-testid="setup-next"
                onClick={() => (held.length ? void saveAreas(held).then((saved) => { if (saved) go(i + 1); }) : go(i + 1))}>
                {t(held.length ? 'admin.create.saveAndNext' : 'admin.create.next')}
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    // THE WORKFLOWS SECTION CARRIES A FLOW, ITS TRIGGERS AND A STEP INSPECTOR SIDE BY SIDE, so it takes the console's widest column.
    <div className={cx('admin-tab', 'admin-assistant-page', section === 'workflows' && 'admin-assistant-page-wide')}>
      {breadcrumb}
      {header}
      {notices}
      {banner}
      {!editing && selected.hasDraft && (
        <p className="admin-field-hint" role="status" data-testid="draft-kept">{t('admin.assistantPage.draftKept')}</p>
      )}
      <div className="admin-assistant-layout">
        {menu}
        <div className="admin-assistant-main">{sectionBody(section)}</div>
      </div>
    </div>
  );
};

/** The steps of a task machine, in order: who each waits on, what it does and needs, what it delivers, where it goes. */
const MachineSteps: React.FC<{ steps: MachineStep[]; name: string; focus?: string | null }> = ({ steps, name, focus }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  // The step a link opened the machine on is marked and brought into view.
  useEffect(() => {
    if (focus) byTestId(`assistant-machine-step-${focus}`)?.scrollIntoView?.({ block: 'center' });
  }, [focus]);
  const who = (s: MachineStep) => (s.terminal
    ? t(`admin.assistantPage.machine.terminal.${s.terminal}`)
    : s.awaits ? t(`admin.assistantPage.machine.awaits.${s.awaits}`) : t('admin.assistantPage.machine.works', { name }));
  return (
    <ol className="admin-machine-steps" data-testid="assistant-machine-steps">
      {steps.map((s, i) => (
        <li key={s.key} className={cx('admin-workflow-item', focus === s.key && 'admin-workflow-item-focus')} data-testid={`assistant-machine-step-${s.key}`}
          aria-current={focus === s.key ? 'true' : undefined}>
          <div className="admin-workflow-item-head">
            <span className="admin-muted">{t('admin.assistantPage.machine.step', { n: i + 1 })}</span>
            <code>{s.key}</code>
            <span className={cx('admin-chip', s.terminal ? 'admin-chip-own' : !s.awaits && 'admin-chip-platform')}>{who(s)}</span>
            {s.produces === 'document' && (
              <span className="admin-chip">{s.templates?.length
                ? t('admin.assistantPage.machine.delivers', { templates: s.templates.join(', ') })
                : t('admin.assistantPage.machine.deliversNoTemplate')}</span>
            )}
          </div>
          {s.label && <span>{s.label}</span>}
          {stepKind(s) === IMAGE && <span className="admin-chip" data-testid={`assistant-machine-step-${s.key}-image`}>{t('admin.assistantPage.machine.producesImage')}</span>}
          {s.action && <span>{t('admin.assistantPage.machine.action', { tool: s.action })}</span>}
          {s.requiresTool?.length ? <span className="admin-field-hint">{t('admin.assistantPage.machine.requiresTool', { tools: s.requiresTool.join(', ') })}</span> : null}
          {s.requires?.length ? <span className="admin-field-hint">{t('admin.assistantPage.machine.needs', { needs: s.requires.join(', ') })}</span> : null}
          <span>
            <strong>{t('admin.assistantPage.machine.next')}</strong>{' '}
            {s.transitions.length ? s.transitions.join(', ') : t('admin.assistantPage.none')}
            {s.reopens?.length ? <> {' · '}{t('admin.assistantPage.machine.reopens', { states: s.reopens.join(', ') })}</> : null}
          </span>
          {s.defaultTemplate && <span className="admin-field-hint">{t('admin.assistantPage.machine.defaultTemplate', { template: s.defaultTemplate })}</span>}
          <details>
            <summary>{t('admin.assistantPage.machine.instructions')}</summary>
            {s.prompt ? <p className="admin-pre-line">{s.prompt}</p> : <p className="admin-muted">{t('admin.assistantPage.machine.noInstructions')}</p>}
          </details>
        </li>
      ))}
    </ol>
  );
};

/** The task-step builder, given the message templates this assistant can say. */
const MachineBuilderWithTemplates: React.FC<React.ComponentProps<typeof TaskMachineBuilder> & { profileName: string }> = ({ profileName, ...props }) => {
  const { prompts } = useTemplateOptions(profileName);
  return <TaskMachineBuilder {...props} templates={prompts} />;
};

/** What an intent card shows above its model: the key, single turn or its machine, its purpose and its instructions. */
const IntentHead: React.FC<{
  card: IntentCard; assistant: string; name: string; onOpenLink?: (link: AssistantLink) => void;
  /** Open the Workflows list at this intent's entry, where its workflow is edited (WT97). */
  onOpenWorkflows?: (intent: string) => void;
}> = ({ card, assistant, name, onOpenLink, onOpenWorkflows }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const platformAbout = t(`admin.assistantPage.platformIntents.about.${card.key}`, { defaultValue: '' });
  const whatItIs = card.purpose ?? (platformAbout || t('admin.assistantPage.intentNoDescription'));
  return (
    <>
      <div className="admin-workflow-item-head">
        <code>{card.key}</code>
        {/* HOW THE INTENT RUNS, marked the same way on every card. */}
        {card.machine
          ? (
            <span className={cx('admin-chip', 'admin-chip-multi')} data-testid={`intent-machine-${card.key}`}>
              {/* A machine the version's selection leaves out opens no workflow, as the router's gate decides. */}
              {t(card.machineSelected === false ? 'admin.assistantPage.multiStepDeselected' : 'admin.assistantPage.multiStep', { machine: card.machine })}
            </span>
          )
          : <span className="admin-chip" data-testid={`intent-kind-${card.key}`}>{card.multiStep ? t('admin.assistantPage.multiStepNoMachine') : t('admin.assistantPage.singleTurn')}</span>}
        {/* A MULTI-STEP INTENT'S WORKFLOW IS SEEN AND EDITED IN THE ONE WORKFLOWS LIST (ADR-067 decision 4), and this is the card's one way there. */}
        {(card.multiStep || card.machine) && onOpenWorkflows && (
          <button type="button" className="btn-secondary" data-testid={`intent-workflows-${card.key}`} onClick={() => onOpenWorkflows(card.key)}>
            {t('admin.assistantPage.inWorkflows')}
          </button>
        )}
        {/* AN INTENT THE PLATFORM RAISES (a quiet runbook refresh, a required dashboard refresh) has no classified turns, so no link. */}
        {!platformRaised(card) && (
          <ConsoleLink link={{ tab: 'effectiveness', assistant, intent: card.key }} onOpen={onOpenLink} testId={`intent-performance-${card.key}`}
            title={t('admin.assistantPage.intentPerformanceTitle', { name, intent: card.key })}>
            {t('admin.assistantPage.performanceLink')}
          </ConsoleLink>
        )}
      </div>
      {/* WHAT THE INTENT IS: the description the classifier chooses by, or the platform's words for an intent the platform declares. */}
      <p className="admin-intent-purpose" data-testid={`intent-purpose-${card.key}`}>
        {whatItIs}
      </p>
      {/* THE PACK INTENT'S TOOL NARROWING, within the version's allowlist (`toolsForIntent`). Absent: every allowed tool. */}
      {card.tools && (
        <p className="admin-field-hint" data-testid={`intent-tools-${card.key}`}>
          {card.tools.length ? t('admin.assistantPage.intentTools', { tools: card.tools.join(', ') }) : t('admin.assistantPage.intentToolsNone')}
        </p>
      )}
      <details>
        <summary>{t('admin.assistantPage.instructions')}</summary>
        {card.instructions ? <p className="admin-pre-line">{card.instructions}</p> : <p className="admin-muted">{t('admin.assistantPage.noInstructions', { name })}</p>}
      </details>
    </>
  );
};

/** Whether an intent with no text model of its own answers through the `general` route (`ANSWERS_THROUGH_GENERAL`). */
const throughGeneral = (key: string, catalog: ClassificationCatalog | undefined): boolean =>
  !!catalog?.platformIntents?.find((p) => p.key === key)?.answersThroughGeneral;

/**
 * Where an intent with no text model of its own is answered: on the platform's route while the version names no text
 * route at all (`platformRouteServing`), else through the general route, or on the default model.
 */
const unroutedAnswer = (body: Partial<ProfileDefinitionBody> | null, key: string, catalog: ClassificationCatalog | undefined, t: T): string => {
  const served = platformRouteServing(body, catalog, key);
  if (served) {
    return t(served.via === 'general' ? 'admin.assistantPage.intentModels.answersPlatformGeneral' : 'admin.assistantPage.intentModels.answersPlatform', { model: served.primary });
  }
  return t(throughGeneral(key, catalog) ? 'admin.assistantPage.intentModels.answersGeneral' : 'admin.assistantPage.intentModels.answersBase');
};

/**
 * What an intent's image turns are drawn on when its route names no image model: an intent that needs an image takes the
 * `image_generation` route's (`resolveTurnImageRoute`), and fails, saying why, where that names none either.
 */
const unroutedImage = (body: Partial<ProfileDefinitionBody> | null, card: IntentCard, t: T): string => {
  if (card.needs !== 'image') return t('admin.assistantPage.intentModels.noImage');
  const inherited = inheritedImageModel(body, card.key);
  return inherited
    ? t('admin.assistantPage.intentModels.imageInherited', { model: inherited })
    : t('admin.assistantPage.intentModels.imageNeededNone');
};

/**
 * AN INTENT CARD'S MODELS (ADR-064 decision 5, SPEC-ADMIN-CONSOLE FR60): the text model and fallback; the image model and
 * fallback where a step of its workflow produces an image or the intent needs one; and each step of its workflow with what
 * it produces and the model it runs on, the route's by default. Read-only on the active version; in the draft each is a
 * select offering only the models of its kind the classification selects. A refusal Validate returned for this card or
 * one of its steps sits under it, placed by its structured params (tenet D11).
 */
const IntentModels: React.FC<{
  card: IntentCard; catalog?: ClassificationCatalog; name: string; assistant: string;
  /** The version the card is read from: what an unrouted intent answers on depends on its other routes and base model. */
  body: Partial<ProfileDefinitionBody> | null;
  /** The draft's route change; absent on the active version, which is read-only. */
  onRoute?: (route: IntentRoute | undefined) => void;
  refusals?: RouteError[];
  onOpenLink?: (link: AssistantLink) => void;
}> = ({ card, catalog, name, assistant, body, onRoute, refusals, onOpenLink }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const r = card.route;
  const editing = !!onRoute;
  const steps = machineStepsOf(catalog, card.machine).filter((s) => !s.terminal);
  const withImage = offersImageModel(card, catalog);
  const imageModels = modelsOfKind('image', catalog);
  const set = (next: IntentRoute) => onRoute?.(next);
  const pairSelects = (kind: 'text' | 'image', pair: { primary?: string; fallback?: string } | undefined, onPair: (p: { primary: string; fallback?: string } | undefined) => void) => {
    const label = kind === 'text' ? 'text' : 'image';
    return (
      <>
        <label className="admin-stacked-field"><span className="admin-field-label">{t(`admin.assistantPage.intentModels.${label}`)}</span>
          <span className="admin-field-hint">{t(`admin.assistantPage.intentModels.${label}Help`)}</span>
          <select className="select" aria-label={t(`admin.assistantPage.intentModels.${label}For`, { intent: card.key })} data-testid={`draft-route-${card.key}-${kind === 'text' ? 'primary' : 'image'}`}
            value={pair?.primary ?? ''} onChange={(e) => onPair(withPrimary(pair, e.target.value))}>
            <option value="">{kind === 'text'
              ? t('admin.assistantPage.intentModels.noText', { answers: unroutedAnswer(body, card.key, catalog, t) })
              : unroutedImage(body, card, t)}</option>
            {/* `default` names no model: the route is left out of the strategy, so the intent answers as it would unrouted. */}
            {kind === TEXT && <option value="default">{throughGeneral(card.key, catalog)
              ? t('admin.assistantPage.intentModels.defaultGeneral') : t('admin.profiles.baseUseTheBaseModel')}</option>}
            {modelsOfKind(kind, catalog).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.assistantPage.intentModels.fallback')}</span>
          <select className="select" aria-label={t(`admin.assistantPage.intentModels.${label}FallbackFor`, { intent: card.key })}
            data-testid={`draft-route-${card.key}-${kind === 'text' ? 'fallback' : 'image-fallback'}`}
            value={pair?.fallback ?? ''} disabled={!pair?.primary}
            onChange={(e) => pair?.primary && onPair({ primary: pair.primary, ...(e.target.value ? { fallback: e.target.value } : {}) })}>
            <option value="">{t('admin.assistantPage.intentModels.noFallback')}</option>
            {fallbacksFor(kind, pair?.primary, catalog).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </>
    );
  };
  const readPair = (kind: 'text' | 'image', pair: { primary?: string; fallback?: string } | undefined) => (
    <>
      <div><span className="admin-field-label">{t(`admin.assistantPage.intentModels.${kind}`)}</span>
        {/* A `default` text primary names no model, so the card says what the turn answers on instead. */}
        <span data-testid={`intent-${card.key}-${kind}-model`}>{pair?.primary && (kind === IMAGE || hasOwnTextModel(pair))
          ? <ModelValue model={pair.primary} />
          : <span className="admin-muted">{kind === 'text'
            ? t('admin.assistantPage.intentModels.noText', { answers: unroutedAnswer(body, card.key, catalog, t) })
            : unroutedImage(body, card, t)}</span>}</span></div>
      <div><span className="admin-field-label">{t('admin.assistantPage.intentModels.fallback')}</span>
        <span>{pair?.fallback ? <ModelValue model={pair.fallback} /> : <span className="admin-muted">{t('admin.assistantPage.intentModels.noFallback')}</span>}</span></div>
    </>
  );
  return (
    <>
      <div className="admin-intent-models" data-testid={editing ? `draft-route-${card.key}` : `intent-models-${card.key}`}>
        {editing
          ? pairSelects('text', r, (p) => set(withTextModel(r, p)))
          : readPair('text', r)}
      </div>
      {withImage && (
        <div className="admin-intent-models" data-testid={`intent-image-${card.key}`}>
          {imageModels.length === 0
            ? <span className="admin-muted">{t('admin.assistantPage.intentModels.noImageOffered')}</span>
            : editing ? pairSelects('image', r?.image, (p) => set(withImageModel(r, p))) : readPair('image', r?.image)}
        </div>
      )}
      {steps.length > 0 && (
        <div className="admin-intent-steps" data-testid={`intent-steps-${card.key}`}>
          <span className="admin-field-label">{t('admin.assistantPage.intentModels.steps')}</span>
          <StepModelsHelp />
          <ol className="admin-machine-steps">
            {steps.map((s) => {
              return (
                <li key={s.key} className="admin-workflow-item" data-testid={`intent-step-${card.key}-${s.key}`}>
                  <div className="admin-workflow-item-head">
                    <code>{s.key}</code>
                    <span className="admin-chip" data-testid={`intent-step-${card.key}-${s.key}-produces`}>{t(`admin.assistantPage.intentModels.produces.${s.produces ?? 'text'}`)}</span>
                    {!platformRaised(card) && (
                      <ConsoleLink link={{ tab: 'effectiveness', assistant, intent: card.key, step: s.key }} onOpen={onOpenLink} testId={`intent-step-performance-${card.key}-${s.key}`}
                        title={t('admin.assistantPage.intentModels.stepPerformanceTitle', { state: s.key, intent: card.key, name })}>
                        {t('admin.assistantPage.intentModels.stepPerformance')}
                      </ConsoleLink>
                    )}
                  </div>
                  <StepModelControl body={body} catalog={catalog} intent={card.key} step={s} onRoute={editing ? (next) => set(next ?? {}) : undefined} />
                  {s.requiresTool?.length ? (
                    <span className="admin-field-hint" data-testid={`intent-step-${card.key}-${s.key}-requires-tool`}>
                      {t('admin.assistantPage.intentModels.requiresTool', { tools: s.requiresTool.join(', ') })}
                    </span>
                  ) : null}
                  <RouteRefusals errors={refusalsFor(refusals, card, s.key)} testId={`intent-step-refusals-${card.key}-${s.key}`} />
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <RouteRefusals errors={cardRefusals(refusals, card, steps.map((s) => s.key))} testId={`intent-refusals-${card.key}`} />
    </>
  );
};

/** THE PLATFORM INTENTS GROUP (ADR-064 decision 5): read-only, each with where its turns are answered in this version. */
const PlatformIntents: React.FC<{ body: Partial<ProfileDefinitionBody> | null; catalog?: ClassificationCatalog }> = ({ body, catalog }) => {
  const { t } = useTranslation();
  const rows = platformIntentRows(body, catalog);
  return (
    <div className="admin-config-stack-wrap" data-testid="assistant-platform-intents">
      <h4>{t('admin.assistantPage.platformIntents.title')}</h4>
      <p className="admin-field-hint">{t('admin.assistantPage.platformIntents.help')}</p>
      {rows.length ? (
        <ul className="admin-workflow-list">
          {rows.map((p) => (
            <li key={p.key} className={cx('admin-workflow-item', 'admin-workflow-item-platform')} data-testid={`platform-intent-${p.key}`}>
              <div className="admin-workflow-item-head">
                <code>{p.key}</code>
                <span className="admin-chip" data-testid={`platform-intent-${p.key}-answers`}>{t(`admin.assistantPage.platformIntents.${p.answers}`)}</span>
              </div>
              <span className="admin-field-hint" data-testid={`platform-intent-${p.key}-about`}>{t(`admin.assistantPage.platformIntents.about.${p.key}`, { defaultValue: '' })}</span>
            </li>
          ))}
        </ul>
      ) : <span className="admin-muted">{t('admin.assistantPage.platformIntents.unreadable')}</span>}
    </div>
  );
};

/** The intents, one card each, with the models the version routes each to and its steps (read-only). */
const IntentCards: React.FC<{
  cards: IntentCard[]; body: Partial<ProfileDefinitionBody> | null; catalog?: ClassificationCatalog; name: string; assistant: string;
  onOpenLink?: (link: AssistantLink) => void; onOpenWorkflows?: (intent: string) => void;
}> = ({ cards, body, catalog, name, assistant, onOpenLink, onOpenWorkflows }) => {
  const { t } = useTranslation();
  if (!cards.length) return <p className="admin-muted">{t('admin.assistantPage.none')}</p>;
  return (
    <ul className="admin-workflow-list" data-testid="assistant-intents">
      {cards.map((c) => (
        <li key={c.key} className="admin-workflow-item" data-testid={`intent-card-${c.key}`}>
          <IntentHead card={c} assistant={assistant} name={name} onOpenLink={onOpenLink} onOpenWorkflows={onOpenWorkflows} />
          <IntentModels card={c} body={body} catalog={catalog} name={name} assistant={assistant} onOpenLink={onOpenLink} />
        </li>
      ))}
    </ul>
  );
};

/**
 * SCOPE AND MODELS IN THE DRAFT: the classifier, the default model, and each intent's card with its text model, image
 * model and step overrides, from the models the classification selects. One patch of `models`, held as the area's unsaved
 * edit until saved alone.
 */
const ScopeDraft: React.FC<{
  draft: ProfileDefinitionBody; catalog?: ClassificationCatalog; busy: boolean; canEdit: boolean; name: string; assistant: string;
  /** The models area's unsaved edit, held by the tab. */
  unsaved?: ProfileDraftPatch;
  onUnsavedPatch: (patch: ProfileDraftPatch) => void;
  onSave: () => void; onReset: () => void;
  onOpenLink?: (link: AssistantLink) => void; onOpenWorkflows?: (intent: string) => void;
  /** The refusals the last Validate returned, anchored under the card or step each names. */
  refusals?: RouteError[];
  /** How the router classifies a turn for this assistant: the classifier model is read only in `llm` mode. */
  classifierMode?: 'keyword' | 'llm';
  /** How intents are classified, read-only, after the two models. */
  modeRow?: React.ReactNode;
  /** Where the intents come from, above the list. */
  intentsNote?: React.ReactNode;
}> = ({ draft, catalog, busy, canEdit, name, assistant, unsaved, onUnsavedPatch, onSave, onReset, onOpenLink, onOpenWorkflows, refusals, classifierMode, modeRow, intentsNote }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [models, setModels] = useState<ProfileModels>(() => draftWith('models', draft, unsaved).models ?? {});
  const edited = !!unsaved && Object.keys(unsaved).length > 0;
  const change = (next: ProfileModels) => { setModels(next); onUnsavedPatch({ models: next }); };
  const text = modelsOfKind('text', catalog);
  // A card the draft opened with stays while its route is cleared, so clearing a model never takes the control away.
  const [opened] = useState(() => Object.keys(models.byIntent ?? {}));
  const cards = intentCards({ ...draft, models }, catalog);
  for (const k of opened) if (!cards.some((c) => c.key === k)) cards.push({ key: k, multiStep: false });
  return (
    <div className="admin-edit-step" data-testid="draft-step-models">
      <h4>{t('admin.assistantPage.classificationHeading')}</h4>
      {modeRow}
      {classifierMode !== 'keyword' && (
        <ModelChoice kind="classifier" value={models.classifier ?? 'default'} models={text.map((m) => ({ key: m, label: m }))}
          onChange={(v) => change({ ...models, classifier: v })} />
      )}
      <h4>{t('admin.assistantPage.intents')}</h4>
      <ModelChoice kind="default" value={models.default ?? ''} models={text.map((m) => ({ key: m, label: m }))}
        onChange={(v) => {
          // THE CLASSIFICATION DEFAULT IS NO BASE MODEL: `models` is sent without `default`, and `editDraft` sets `modelKey`
          // to the sentinel, so the turn serves the classification's default.
          const { default: _base, ...rest } = models;
          change(v ? { ...models, default: v } : rest);
        }} />
      {intentsNote}
      <ul className="admin-workflow-list" data-testid="assistant-intents">
        {cards.map((c) => (
          <li key={c.key} className="admin-workflow-item" data-testid={`intent-card-${c.key}`}>
            <IntentHead card={c} assistant={assistant} name={name} onOpenLink={onOpenLink} onOpenWorkflows={onOpenWorkflows} />
            <IntentModels card={c} body={{ ...draft, models }} catalog={catalog} name={name} assistant={assistant} onOpenLink={onOpenLink} refusals={refusals}
              onRoute={(route) => change(withRoute(models, c.key, route))} />
          </li>
        ))}
      </ul>
      <div className="admin-config-actions">
        <button type="button" className="btn-ghost" disabled={busy || !edited} data-testid="draft-step-cancel" onClick={onReset}>{t('admin.assistantPage.reset')}</button>
        <button type="button" className="btn-primary" disabled={busy || !edited || !canEdit} data-testid="draft-step-save" onClick={onSave}>
          {t('admin.draftCards.save')}
        </button>
      </div>
      {edited && <span className="admin-badge" data-testid="draft-step-models-unsaved">{t('admin.assistantPage.unsaved.mark')}</span>}
    </div>
  );
};

/**
 * THE CLASSIFIER OR THE DEFAULT MODEL, as one stacked field: label, help, then the select, from the models offered. The
 * draft's Scope and models and the creation wizard's models step both render this, so the two read and choose alike.
 */
export const ModelChoice: React.FC<{
  kind: 'classifier' | 'default';
  value: string;
  models: ReadonlyArray<{ key: string; label: string }>;
  onChange: (value: string) => void;
  /** A first option asking for a choice, where blank is not a valid answer (the create's default model). */
  placeholder?: string;
  disabled?: boolean;
  /** A line under the help, such as why the control is off. */
  note?: string;
}> = ({ kind, value, models, onChange, placeholder, disabled, note }) => {
  const { t } = useTranslation();
  const classifier = kind === 'classifier';
  const help = classifier
    ? t('admin.assistantPage.help.classifierModel')
    : `${t('admin.assistantPage.help.defaultModel')} ${t('admin.assistantPage.help.models')}`;
  return (
    <StackedField label={t(classifier ? 'admin.profiles.classifierModel' : 'admin.assistantPage.field.defaultModel')} help={note ? <>{help} <span>{note}</span></> : help}>
      {({ id, describedBy }) => (
        <select id={id} aria-describedby={describedBy} className="select" disabled={disabled}
          data-testid={classifier ? 'draft-classifier-model' : 'draft-base-model'} value={value} onChange={(e) => onChange(e.target.value)}>
          {classifier
            ? <option value="default">{t('admin.profiles.defaultFollowThePlatformClassifier')}</option>
            : <option value="">{placeholder ?? t('admin.profiles.defaultInheritClassificationDefault')}</option>}
          {models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      )}
    </StackedField>
  );
};

export default AssistantPage;
