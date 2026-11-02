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
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import WizardSteps from './WizardSteps';
import { DocLink, GuideLinks, guide, guideSection, type Guide } from './AdminHelp';
import {
  ClassifierModeRow, ContextGroup, EditPath, FixedForLife, PersonaExtras, PlatformSection, Row, StackedField, WordsGroup,
} from './AssistantConfigFields';
import { VariablesFields, type InlineArea } from './DraftAreaFields';
import { DiscardDraft, DraftDiff, DraftStep, DraftValidationResult, MoveIntoPersona, type AreaContext, type DraftValidation } from './DraftControls';
import { combinedPatch, draftWith, unsavedAreas, type Unsaved } from './unsavedAreas';
import {
  RouteRefusals, cardRefusals, fallbacksFor, machineStepsOf, modelsOfKind, offersImageModel, refusalsFor, stepKind, withImageModel, withPrimary,
  withRoute, withStepModel, withTextModel,
} from './IntentRouteModels';
import WorkflowGroups from './WorkflowGroups';
import GoldenRunPanel, { type PastGateOutcome } from './GoldenRunPanel';
import GoldenUploadPanel from './GoldenUploadPanel';
import { areaSummary, type DraftArea } from './draftAreas';
import {
  CREATION_STEPS, SECTIONS, SECTION_AREAS, WIZARD_SECTIONS, changedSections, creationSteps, intentCards, intentsRunning, ownWorkflows,
  packIntentKeys, platformIntentRows, platformWorkflows, withPlatformCopy, type IntentCard, type Section, type WizardSection,
} from './assistantSections';
import { linkSearch, type AssistantLink } from './assistantLinks';
import EventWorkflowSummary from './EventWorkflowSummary';
import {
  DEFAULT_MODEL,
  type ClassificationCatalog, type FieldDecision, type IntentRoute, type MachineStep, type ProfileDefinitionBody, type ProfileDraftPatch,
  type ProfileListing, type ProfileModels, type RouteError, type ToolDescriptor, type PastGateConfirmation,
} from '../../services/profileService';
import { bedrockGuardrailUrl, bedrockGuardrailsUrl, bedrockModelsUrl, cloudwatchLogsUrl, lambdaFunctionUrl, lambdaFunctionsUrl } from '../../services/awsConsole';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

type T = (key: string, opts?: Record<string, unknown>) => string;

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
  scope: (t) => [guide(t('admin.guides.config.intents'), 'intentPack'), guide(t('admin.guides.config.models'), 'modelStrategy')],
  versions: (t) => [guideSection(t('admin.guides.config.versions'), 'manageProfile')],
};

export interface AssistantPageProps {
  selected: ProfileListing;
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
  onDiscard: () => void;
  onBack: () => void;
  onOpenLink?: (link: AssistantLink) => void;
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

/** A model choice as a person reads it: the default by name, or the model's key linked to the Bedrock console. */
const ModelValue: React.FC<{ model?: string }> = ({ model }) => {
  const { t } = useTranslation();
  return !model || model === DEFAULT_MODEL
    ? <span className="admin-muted">{t('admin.assistantPage.modelDefault')}</span>
    : <DocLink href={bedrockModelsUrl()}><code>{model}</code></DocLink>;
};

const AssistantPage: React.FC<AssistantPageProps> = (props) => {
  const {
    selected, config, configLoading, draft, draftKey, catalog, tools, decisions, ctx, busy, validation, mode, onModeChange,
    onStartDraft, onSave, unsaved, onUnsavedPatch, onUnsavedDrop, onValidate, onActivate, onActivatePastGate, onDiscard, onBack, onOpenLink, canEdit, canValidate,
    notices, ownerControl, limits, infrastructure, versions, wizard,
  } = props;
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [section, setSection] = useState<Section>('behavioral');
  /** The wizard's step, once the build has made the draft: a section, or the review. */
  const [step, setStep] = useState<WizardSection | 'review'>(WIZARD_SECTIONS[0]);
  /** A task machine open on its own view, and the section it was opened from. */
  const [machine, setMachine] = useState<{ key: string; from: Section } | null>(null);
  const [showPlatform, setShowPlatform] = useState(false);
  /** Bumped by Reset, so every inline control re-seeds from the saved draft. */
  const [reset, setReset] = useState(0);
  /** The workflow Edit in a draft opened, which the draft's builder shows selected. */
  const [focusWorkflow, setFocusWorkflow] = useState<string | null>(null);

  const name = config?.displayName || selected.displayName || selected.profileName;
  const active = selected.activeVersion;
  // WHAT THE DRAFT IS COMPARED WITH: the active version, or nothing while no version has been activated.
  const activeBody = active === null ? null : config;
  const editing = (!!wizard || mode === 'draft') && !!selected.hasDraft;
  const body = editing ? draft : config;
  const changed = changedSections(activeBody, draft);
  const assistant = selected.profileName;

  const go = (s: Section) => { setSection(s); setMachine(null); };
  const openMachine = (key: string, from: Section) => setMachine({ key, from });
  // The builder Edit in a draft opened is brought into view once the draft is read.
  const builderReady = editing && !!draft && section === 'workflows' && !!focusWorkflow;
  useEffect(() => {
    if (builderReady) document.getElementById('draft-step-events')?.scrollIntoView?.({ block: 'start' });
  }, [builderReady, focusWorkflow]);

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
      ctx={area === 'events' && focusWorkflow ? { ...ctx, focusWorkflow } : ctx}
      unsaved={unsaved[area]} onUnsavedPatch={(p) => onUnsavedPatch(area, p)} actions={(edited) => (
        <>
          <button type="button" className="btn-ghost" disabled={busy || !edited} data-testid="draft-step-cancel" onClick={() => resetArea(area)}>{t('admin.assistantPage.reset')}</button>
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
    : t('admin.assistantPage.mode.draft', { count: changed.size });
  const header = (
    <header className="admin-assistant-header">
      <div className="admin-assistant-title">
        <div className="admin-assistant-name">
          <h3>{name}</h3>
          {selected.classification && <span className="admin-chip">{selected.classification}</span>}
          {selected.role && <span className="admin-chip">{selected.role}</span>}
          {active !== null && <span className={cx('admin-badge', 'admin-badge-active')}>{t('admin.assistantPage.activeShort', { version: active })}</span>}
        </div>
        <p className="admin-tab-description">
          {t('admin.profiles.activeVersion')} <strong>{active ?? '-'}</strong>
          {' · '}{t('admin.config.identifier')} <code>{assistant}</code>
          {selected.versions.find((v) => v.active)?.configId && <> {' · '}{t('admin.assistantPage.configId')} <code>{selected.versions.find((v) => v.active)!.configId.slice(0, 12)}</code></>}
          {' · '}{t(`admin.assistants.origin.${selected.origin ?? 'deployed'}`)}
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
  const banner = editing && (
    <section className="admin-draft-banner" aria-labelledby="assistant-draft-title" data-testid="assistant-draft">
      <div className="admin-draft-banner-text">
        <strong id="assistant-draft-title">{active === null
          ? t('admin.assistantPage.banner.first', { name })
          : t('admin.assistantPage.banner.editing', { version: active })}</strong>{' '}
        <span>{t('admin.assistantPage.banner.changed', { count: changed.size })}{' '}
          {active !== null && t('admin.assistantPage.banner.keepsServing', { version: active })}</span>
      </div>
      <div className={cx('admin-config-actions', 'admin-draft-banner-actions')}>
        {draft && <DiscardDraft draft={draft} active={activeBody} busy={busy} canEdit={canEdit} unsaved={pending.map((a) => t(`admin.draftCards.area.${a}`))} onDiscard={onDiscard} />}
        {canValidate && <button type="button" className="btn-secondary" disabled={busy || !draft} onClick={onValidate}>{t('admin.profiles.validate')}</button>}
        <button type="button" className="btn-primary" disabled={busy || !draft || (validation ? !validation.valid : false) || !ctx.canActivate} onClick={activate}>
          {t('admin.assistantPage.banner.activate', { version: next })}
        </button>
      </div>
      <DraftValidationResult validation={validation} />
      {/* The draft's run against the golden set, which Activate reads (ADR-065). */}
      {draft && canValidate && <GoldenRunPanel profileName={selected.profileName} draftConfigId={draftKey} canRun={canEdit} onActivatePastGate={activatePastGate} />}
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
    scope: t('admin.assistantPage.sections.scope.note', { count: cards.length, multi: cards.filter((c) => c.multiStep).length }),
    tools: t('admin.assistantPage.sections.tools.note', { count: body?.tools?.length ?? 0, sources: body?.contextSources?.length ?? 0 }),
    variables: t('admin.assistantPage.sections.variables.note'),
    versions: t('admin.assistantPage.sections.versions.note'),
  };
  const menu = (
    <nav className="admin-assistant-menu" aria-label={t('admin.config.sectionsLabel')}>
      <ul>
        {SECTIONS.map((s) => {
          const on = !machine && section === s;
          return (
            <li key={s}>
              <button type="button" className={cx('admin-assistant-menu-btn', on && 'active')} aria-current={on ? 'page' : undefined}
                data-testid={`assistant-nav-${s}`} onClick={() => go(s)}>
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
      <h4 id={`assistant-section-${s}-title`}>{t(`admin.assistantPage.sections.${s}.title`)}</h4>
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
                : <span className="admin-muted">{t('admin.profiles.inheritsTheProvisionedNameIdentifier')} <code>{assistant}</code></span>}
            </Row>
            <Row testId="field-persona" label={t('admin.profiles.persona')} help={t('admin.assistantPage.help.persona')}>
              {config.persona
                ? <details><summary>{t('admin.assistantPage.personaShow', { count: config.persona.length })}</summary><pre className="profiles-persona-readout">{config.persona}</pre></details>
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
      {body && <PersonaExtras config={body} decisions={decisions} moveAction={editing && draft ? (
        <MoveIntoPersona key={draftKey} draft={draft} busy={busy} canEdit={canEdit} personaUnsaved={!!unsaved.identity && 'persona' in unsaved.identity}
          onSave={onSave} />
      ) : undefined} />}
    </>
  ), 'assistant-config-identity');

  // ---- Workflows ----
  const platformCount = platformWorkflows(true).length + platformWorkflows(false).length;
  /** Copy a platform workflow in over the area's unsaved edit, which is saved with it rather than dropped. */
  const copyIn = (wfName: string, area: 'welcome' | 'events') => {
    if (!draft) return;
    const base = draftWith(area, draft, unsaved[area]);
    void onSave({ eventWorkflows: withPlatformCopy(base.eventWorkflows, wfName).workflows }).then((saved) => { if (saved) onUnsavedDrop([area]); });
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
  const workflowItem = (wfName: string, wf: EventWorkflow, own: boolean, area: 'welcome' | 'events') => (
    <li key={`${own ? 'own' : 'platform'}:${wfName}`} className={cx('admin-workflow-item', !own && 'admin-workflow-item-platform')}
      data-testid={`assistant-workflow-${own ? 'own' : 'platform'}-${wfName}`}>
      <div className="admin-workflow-item-head">
        <code>{wfName}</code>{own ? ownChip : platformChip}
        {!own && editing && canEdit && (
          <button type="button" className="btn-secondary" disabled={busy || !draft} data-testid={`assistant-copy-${wfName}`} onClick={() => copyIn(wfName, area)}>
            {t('admin.assistantPage.copyTo', { name })}
          </button>
        )}
        {own && !editing && canOpenDraft && (
          <button type="button" className={cx('btn-secondary', 'btn-sm')} disabled={busy} data-testid={`assistant-edit-workflow-${wfName}`}
            aria-label={t('admin.eventWorkflows.editLabel', { name: wfName })} onClick={() => editInDraft(wfName)}>
            {t('admin.eventWorkflows.edit')}
          </button>
        )}
      </div>
      <EventWorkflowSummary name={wfName} workflow={wf} role={selected.role} />
    </li>
  );
  const messageUses = (entry: unknown): string => {
    if (typeof entry === 'string') {
      if (entry === '@classification') return t('admin.assistantPage.messages.classification', { classification: selected.classification ?? '' });
      if (entry === '@shipped') return t('admin.assistantPage.messages.shipped');
      return t('admin.assistantPage.messages.own', { name, template: entry });
    }
    if (Array.isArray(entry)) return t('admin.assistantPage.messages.byCondition', { templates: entry.map((e) => (e as { template?: string }).template ?? '').join(', ') });
    return '-';
  };
  const workflows = () => sectionCard('workflows', !body ? (editing ? draftLoading : notRead) : (
    <>
      <div className="admin-workflow-ownership">
        <p className="admin-config-group-help">{t('admin.assistantPage.ownership', { name })}</p>
        <button type="button" className="btn-secondary" aria-pressed={showPlatform} data-testid="assistant-show-platform" onClick={() => setShowPlatform((v) => !v)}>
          {showPlatform ? t('admin.assistantPage.hidePlatform') : t('admin.assistantPage.showPlatform', { count: platformCount })}
        </button>
      </div>
      {/* AN ASSISTANT WITH NO EVENT WORKFLOW OF ITS OWN says so, and how it welcomes people instead. */}
      {ownCount === 0 && (
        <p className="admin-field-hint" data-testid="event-workflows-none">
          {body.onboarding ? t('admin.eventWorkflows.noneOnboarding', { name }) : t('admin.eventWorkflows.none')}
        </p>
      )}

      <h5>{t('admin.assistantPage.sub.welcome')}</h5>
      <p className="admin-field-hint">{t('admin.assistantPage.sub.welcomeHelp', { name })}</p>
      <ul className="admin-workflow-list" data-testid="field-welcome">
        {ownWorkflows(body, true).map(([n, wf]) => workflowItem(n, wf, true, 'welcome'))}
        {showPlatform && platformWorkflows(true).map(([n, wf]) => workflowItem(n, wf, false, 'welcome'))}
        {!ownWorkflows(body, true).length && <li className="admin-muted">{t('admin.assistantPage.help.welcomePlatform')}</li>}
      </ul>
      {editing && inline('welcome')}

      <h5>{t('admin.assistantPage.sub.events')}</h5>
      <p className="admin-field-hint">{t('admin.assistantPage.sub.eventsHelp')}</p>
      <ul className="admin-workflow-list" data-testid="field-event-workflows">
        {ownWorkflows(body, false).map(([n, wf]) => workflowItem(n, wf, true, 'events'))}
        {showPlatform && platformWorkflows(false).map(([n, wf]) => workflowItem(n, wf, false, 'events'))}
        {!ownWorkflows(body, false).length && <li className="admin-muted">{t('admin.assistantPage.noOwnEvents', { name })}</li>}
      </ul>
      {editing && inline('events')}

      <h5>{t('admin.assistantPage.sub.tasks')}</h5>
      <p className="admin-field-hint">{t('admin.assistantPage.sub.tasksHelp', { classification: selected.classification ?? '', name })}</p>
      {catalog?.workflows?.length ? (
        <ul className="admin-workflow-list" data-testid="field-machines">
          {catalog.workflows.map((w) => {
            const answers = intentsRunning(catalog, w.key);
            return (
              <li key={w.key} className={cx('admin-workflow-item', 'admin-workflow-item-platform')}>
                <div className="admin-workflow-item-head">
                  <code>{w.key}</code>
                  <span className={cx('admin-chip', 'admin-chip-platform')}>{w.source === 'platform'
                    ? t('admin.assistantPage.shipped')
                    : t('admin.assistantPage.packOf', { classification: catalog.classification })}</span>
                  <button type="button" className="btn-secondary" data-testid={`assistant-machine-${w.key}`} onClick={() => openMachine(w.key, 'workflows')}>
                    {t('admin.assistantPage.viewSteps')}
                  </button>
                </div>
                <span>{answers.length ? t('admin.assistantPage.answers', { intents: answers.join(', ') })
                  : w.required ? t('admin.assistantPage.requiredMachine') : t('admin.assistantPage.answersNone')}</span>
              </li>
            );
          })}
        </ul>
      ) : <span className="admin-muted">{t('admin.assistantPage.unreadable')}</span>}
      <EditPath field="machines" decision={decisions.machines} />
      <dl className={STACK}>
        <Row testId="field-workflows" label={t('admin.assistantPage.field.workflows')} help={t('admin.assistantPage.help.workflows')}
          path={<EditPath field="workflows" decision={decisions.workflows} />}>
          {body.workflows?.length
            ? body.workflows.map((w) => <code key={w} className="admin-chip">{w}</code>)
            : <span className="admin-muted">{t('admin.assistantPage.none')}</span>}
        </Row>
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

      <h5>{t('admin.assistantPage.sub.messages')}</h5>
      <p className="admin-field-hint">{t('admin.assistantPage.sub.messagesHelp', { name, classification: selected.classification ?? '' })}</p>
      {editing ? inline('messages') : (
        Object.keys(body.messages ?? {}).length ? (
          <table className="admin-mini-table" data-testid="field-messages">
            <thead><tr><th>{t('admin.assistantPage.messages.message')}</th><th>{t('admin.assistantPage.messages.uses')}</th></tr></thead>
            <tbody>
              {Object.entries(body.messages ?? {}).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{messageUses(v)}</td></tr>)}
            </tbody>
          </table>
        ) : <p className="admin-muted" data-testid="field-messages">{t('admin.draftCards.summary.messagesNone')}</p>
      )}
      <div className="admin-config-stack-wrap"><WordsGroup config={body} decisions={decisions} /></div>

      <PlatformSection />
    </>
  ));

  // ---- Scope and models ----
  const scope = () => sectionCard('scope', !body ? (editing ? draftLoading : notRead) : (
    <>
      <dl className={STACK}>
        <Row testId="field-intentPack" label={t('admin.assistantPage.field.intentPack')}
          help={body.intentPack?.intents ? t('admin.assistantPage.help.intentPack') : `${t('admin.assistantPage.help.intentPack')} ${t('admin.assistantPage.help.intentsInherited')}`}
          path={<EditPath field="intentPack" decision={decisions.intentPack} />}>
          {/* The pack's intents only: a route for an intent no pack names has its card below, and is not in the pack. */}
          {packIntentKeys(body, catalog).length
            ? packIntentKeys(body, catalog).map((k) => <code key={k} className="admin-chip">{k}</code>)
            : <span className="admin-muted">{t('admin.assistantPage.none')}</span>}
        </Row>
      </dl>
      {editing ? (
        <ScopeDraft key={`scope:${draftKey}:${reset}`} draft={body} catalog={catalog} busy={busy} canEdit={canEdit} name={name} assistant={assistant}
          unsaved={unsaved.models} onUnsavedPatch={(p) => onUnsavedPatch('models', p)}
          onSave={() => { void saveAreas(['models']); }} onReset={() => resetArea('models')}
          onOpenMachine={(k) => openMachine(k, 'scope')} onOpenLink={onOpenLink} refusals={validation?.errorDetails} />
      ) : (
        <>
          <dl className={STACK}>
            <Row testId="field-classifierModel" label={t('admin.profiles.classifierModel')} help={t('admin.assistantPage.help.classifierModel')}>
              <ModelValue model={body.models?.classifier} />
            </Row>
            <Row testId="field-defaultModel" label={t('admin.assistantPage.field.defaultModel')} help={t('admin.assistantPage.help.defaultModel')}>
              <ModelValue model={body.models?.default ?? body.modelKey} />
            </Row>
            <ClassifierModeRow selected={selected} />
            <Row testId="field-routing" label={t('admin.draftCards.area.routing')} help={t('admin.draftCards.help.routing')}>
              {areaSummary('routing', body, t, assistant)}
            </Row>
          </dl>
          <IntentCards cards={cards} catalog={catalog} name={name} assistant={assistant} onOpenMachine={(k) => openMachine(k, 'scope')} onOpenLink={onOpenLink} />
        </>
      )}
      <PlatformIntents body={body} catalog={catalog} />
      {editing && inline('routing')}
    </>
  ));

  // ---- Tools and context ----
  const toolsSection = () => {
    const fn = selected.resolved?.processorFunctionName;
    const region = selected.resolved?.region;
    const gid = body?.guardrailId || selected.resolved?.guardrailId;
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
        <div className="admin-config-stack-wrap">
          <ContextGroup config={body} configLoading={configLoading && !editing} catalog={catalog} role={selected.role} />
        </div>
        <h5>{t('admin.config.group.limits')}</h5>
        <p className="admin-field-hint">{t('admin.config.help.limits')}</p>
        <div className="admin-config-stack-wrap" data-testid="assistant-config-limits">{limits}</div>
        {infrastructure}
      </>
    ));
  };

  // ---- Variables ----
  const variables = () => sectionCard('variables', !body ? (editing ? draftLoading : notRead) : (
    <VariablesFields {...ctx} draft={body} onPatch={() => undefined} />
  ));

  // ---- One task machine ----
  const machineView = () => {
    const m = catalog?.workflows?.find((w) => w.key === machine!.key);
    const answers = intentsRunning(catalog, machine!.key);
    return (
      <section className="admin-config-group" aria-labelledby="assistant-machine-title" data-testid="assistant-machine-view">
        <div>
          <button type="button" className="btn-link" data-testid="assistant-machine-back" onClick={() => setMachine(null)}>
            ← {t('admin.assistantPage.backTo', { section: t(`admin.assistantPage.sections.${machine!.from}.title`) })}
          </button>
        </div>
        <div className="admin-workflow-item-head">
          <h4 id="assistant-machine-title"><code>{machine!.key}</code></h4>
          {m && <span className={cx('admin-chip', 'admin-chip-platform')}>{m.source === 'platform'
            ? t('admin.assistantPage.shipped') : t('admin.assistantPage.packOf', { classification: catalog!.classification })}</span>}
          <span className="admin-chip">{t('admin.assistantPage.readOnlyChip')}</span>
        </div>
        <p className="admin-config-group-help">
          {m?.source === 'platform'
            ? t('admin.assistantPage.machine.shippedHelp', { classification: selected.classification ?? '' })
            : t('admin.assistantPage.machine.packHelp', { classification: selected.classification ?? '' })}{' '}
          {answers.length ? t('admin.assistantPage.answers', { intents: answers.join(', ') }) : t('admin.assistantPage.answersNone')}{' '}
          {t('admin.assistantPage.machine.stepsHelp')}
        </p>
        <GuideLinks guides={[guide(t('admin.assistantPage.platform.taskLifecycleGuide'), 'taskStates')]} />
        {!m ? <span className="admin-muted">{t('admin.assistantPage.unreadable')}</span>
          : m.steps?.length ? <MachineSteps steps={m.steps} name={name} />
            : <WorkflowGroups workflows={[m]} testId="assistant-machine-states" />}
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
        : s === 'scope' ? scope()
          : s === 'tools' ? toolsSection()
            : s === 'variables' ? variables()
              : sectionCard('versions', <>{versions}<GoldenUploadPanel profileName={selected.profileName} /></>));

  const breadcrumb = (
    <div className="admin-tab-header">
      <nav className="admin-breadcrumb" aria-label={t('admin.config.path')}>
        <button className="btn-link" onClick={onBack}>← {t('admin.config.back')}</button>
        <span> / </span>
        <span>{name}</span>
      </nav>
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
        <h3>{name}</h3>
        {notices}
        <section className="admin-config-group" aria-labelledby="assistant-setup-title" data-testid="assistant-setup">
          <h4 id="assistant-setup-title">{t('admin.create.title')}</h4>
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
    <div className={cx('admin-tab', 'admin-assistant-page')}>
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
const MachineSteps: React.FC<{ steps: MachineStep[]; name: string }> = ({ steps, name }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const who = (s: MachineStep) => (s.terminal
    ? t(`admin.assistantPage.machine.terminal.${s.terminal}`)
    : s.awaits ? t(`admin.assistantPage.machine.awaits.${s.awaits}`) : t('admin.assistantPage.machine.works', { name }));
  return (
    <ol className="admin-machine-steps" data-testid="assistant-machine-steps">
      {steps.map((s, i) => (
        <li key={s.key} className="admin-workflow-item" data-testid={`assistant-machine-step-${s.key}`}>
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

/** What an intent card shows above its model: the key, single turn or its machine, its purpose and its instructions. */
const IntentHead: React.FC<{ card: IntentCard; assistant: string; name: string; onOpenMachine: (k: string) => void; onOpenLink?: (link: AssistantLink) => void }> = ({ card, assistant, name, onOpenMachine, onOpenLink }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  return (
    <>
      <div className="admin-workflow-item-head">
        <code>{card.key}</code>
        {card.machine
          ? <button type="button" className={cx('btn-secondary', 'admin-chip-multi')} data-testid={`intent-machine-${card.key}`} onClick={() => onOpenMachine(card.machine!)}>
            {t('admin.assistantPage.multiStep', { machine: card.machine })} ›</button>
          : <span className="admin-chip">{card.multiStep ? t('admin.assistantPage.multiStepNoMachine') : t('admin.assistantPage.singleTurn')}</span>}
        <ConsoleLink link={{ tab: 'effectiveness', assistant, intent: card.key }} onOpen={onOpenLink} testId={`intent-performance-${card.key}`}
          title={t('admin.assistantPage.intentPerformanceTitle', { name, intent: card.key })}>
          {t('admin.assistantPage.performanceLink')}
        </ConsoleLink>
      </div>
      {card.purpose && <p className="admin-intent-purpose">{card.purpose}</p>}
      <details>
        <summary>{t('admin.assistantPage.instructions')}</summary>
        {card.instructions ? <p className="admin-pre-line">{card.instructions}</p> : <p className="admin-muted">{t('admin.assistantPage.noInstructions', { name })}</p>}
        {card.description && <p className="admin-field-hint">{t('admin.assistantPage.classifierReads', { description: card.description })}</p>}
      </details>
    </>
  );
};

/** Where an intent with no text model of its own is answered: the general route, or the default model. */
const unroutedAnswer = (key: string, catalog: ClassificationCatalog | undefined, t: T): string =>
  t(catalog?.platformIntents?.find((p) => p.key === key)?.answersThroughGeneral
    ? 'admin.assistantPage.intentModels.answersGeneral' : 'admin.assistantPage.intentModels.answersBase');

/**
 * AN INTENT CARD'S MODELS (ADR-064 decision 5, SPEC-ADMIN-CONSOLE FR60): the text model and fallback; the image model and
 * fallback where a step of its workflow produces an image or the intent needs one; and each step of its workflow with what
 * it produces and the model it runs on, the route's by default. Read-only on the active version; in the draft each is a
 * select offering only the models of its kind the classification selects. A refusal Validate returned for this card or
 * one of its steps sits under it, placed by its structured params (tenet D11).
 */
const IntentModels: React.FC<{
  card: IntentCard; catalog?: ClassificationCatalog; name: string; assistant: string;
  /** The draft's route change; absent on the active version, which is read-only. */
  onRoute?: (route: IntentRoute | undefined) => void;
  refusals?: RouteError[];
  onOpenLink?: (link: AssistantLink) => void;
}> = ({ card, catalog, name, assistant, onRoute, refusals, onOpenLink }) => {
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
              ? t('admin.assistantPage.intentModels.noText', { answers: unroutedAnswer(card.key, catalog, t) })
              : t('admin.assistantPage.intentModels.noImage')}</option>
            {kind === TEXT && <option value="default">{t('admin.profiles.baseUseTheBaseModel')}</option>}
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
        <span data-testid={`intent-${card.key}-${kind}-model`}>{pair?.primary
          ? <ModelValue model={pair.primary} />
          : <span className="admin-muted">{kind === 'text'
            ? t('admin.assistantPage.intentModels.noText', { answers: unroutedAnswer(card.key, catalog, t) })
            : t('admin.assistantPage.intentModels.noImage')}</span>}</span></div>
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
          <span className="admin-field-hint">{t('admin.assistantPage.intentModels.stepsHelp')}</span>
          <ol className="admin-machine-steps">
            {steps.map((s) => {
              const kind = stepKind(s);
              const own = r?.steps?.[s.key];
              const byRoute = t(kind === 'image' ? 'admin.assistantPage.intentModels.routeImage' : 'admin.assistantPage.intentModels.routeText');
              return (
                <li key={s.key} className="admin-workflow-item" data-testid={`intent-step-${card.key}-${s.key}`}>
                  <div className="admin-workflow-item-head">
                    <code>{s.key}</code>
                    <span className="admin-chip" data-testid={`intent-step-${card.key}-${s.key}-produces`}>{t(`admin.assistantPage.intentModels.produces.${s.produces ?? 'text'}`)}</span>
                    <ConsoleLink link={{ tab: 'effectiveness', assistant, intent: card.key, step: s.key }} onOpen={onOpenLink} testId={`intent-step-performance-${card.key}-${s.key}`}
                      title={t('admin.assistantPage.intentModels.stepPerformanceTitle', { state: s.key, intent: card.key, name })}>
                      {t('admin.assistantPage.intentModels.stepPerformance')}
                    </ConsoleLink>
                  </div>
                  {editing ? (
                    <select className="select" aria-label={t('admin.assistantPage.intentModels.stepModelFor', { state: s.key, intent: card.key })}
                      data-testid={`draft-step-${card.key}-${s.key}`} value={own?.primary ?? ''}
                      onChange={(e) => set(withStepModel(r, s.key, withPrimary(own, e.target.value)))}>
                      <option value="">{byRoute}</option>
                      {modelsOfKind(kind, catalog).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <span data-testid={`intent-step-${card.key}-${s.key}-model`}>{own?.primary ? <ModelValue model={own.primary} /> : <span className="admin-muted">{byRoute}</span>}</span>
                  )}
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
      <h5>{t('admin.assistantPage.platformIntents.title')}</h5>
      <p className="admin-field-hint">{t('admin.assistantPage.platformIntents.help')}</p>
      {rows.length ? (
        <ul className="admin-workflow-list">
          {rows.map((p) => (
            <li key={p.key} className={cx('admin-workflow-item', 'admin-workflow-item-platform')} data-testid={`platform-intent-${p.key}`}>
              <div className="admin-workflow-item-head">
                <code>{p.key}</code>
                <span className="admin-chip" data-testid={`platform-intent-${p.key}-answers`}>{t(`admin.assistantPage.platformIntents.${p.answers}`)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : <span className="admin-muted">{t('admin.assistantPage.platformIntents.unreadable')}</span>}
    </div>
  );
};

/** The intents, one card each, with the models the version routes each to and its steps (read-only). */
const IntentCards: React.FC<{
  cards: IntentCard[]; catalog?: ClassificationCatalog; name: string; assistant: string;
  onOpenMachine: (k: string) => void; onOpenLink?: (link: AssistantLink) => void;
}> = ({ cards, catalog, name, assistant, onOpenMachine, onOpenLink }) => {
  const { t } = useTranslation();
  if (!cards.length) return <p className="admin-muted">{t('admin.assistantPage.none')}</p>;
  return (
    <ul className="admin-workflow-list" data-testid="assistant-intents">
      {cards.map((c) => (
        <li key={c.key} className="admin-workflow-item" data-testid={`intent-card-${c.key}`}>
          <IntentHead card={c} assistant={assistant} name={name} onOpenMachine={onOpenMachine} onOpenLink={onOpenLink} />
          <IntentModels card={c} catalog={catalog} name={name} assistant={assistant} onOpenLink={onOpenLink} />
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
  onOpenMachine: (k: string) => void; onOpenLink?: (link: AssistantLink) => void;
  /** The refusals the last Validate returned, anchored under the card or step each names. */
  refusals?: RouteError[];
}> = ({ draft, catalog, busy, canEdit, name, assistant, unsaved, onUnsavedPatch, onSave, onReset, onOpenMachine, onOpenLink, refusals }) => {
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
      <ModelChoice kind="classifier" value={models.classifier ?? 'default'} models={text.map((m) => ({ key: m, label: m }))}
        onChange={(v) => change({ ...models, classifier: v })} />
      <ModelChoice kind="default" value={models.default ?? ''} models={text.map((m) => ({ key: m, label: m }))}
        onChange={(v) => change({ ...models, default: v || undefined })} />
      <h5>{t('admin.assistantPage.intents')}</h5>
      <ul className="admin-workflow-list" data-testid="assistant-intents">
        {cards.map((c) => (
          <li key={c.key} className="admin-workflow-item" data-testid={`intent-card-${c.key}`}>
            <IntentHead card={c} assistant={assistant} name={name} onOpenMachine={onOpenMachine} onOpenLink={onOpenLink} />
            <IntentModels card={c} catalog={catalog} name={name} assistant={assistant} onOpenLink={onOpenLink} refusals={refusals}
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
