/**
 * THE FIELDS OF AN ASSISTANT'S PAGE THAT ARE NOT ITS FIRST CONTROLS (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The owner's rule: every element is editable at runtime (a control and its help), editable only as JSON
 * where agreed (the page says exactly where and how), or not editable (the page says what drives it and how
 * it changes). Which is which is the backend's declared table (`profile-field-decisions.ts`), served with the
 * listing, so this page and the write path cannot disagree about which fields have a control.
 *
 * What a control offers is the classification's catalog, served with the listing (`classification-catalog.ts`):
 * the console offers only what is allowed, and the draft route refuses anything else.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmAction } from './ConfirmAction';
import { GuideLinks, guide, guideSection, InfoTooltip, type Guide } from './AdminHelp';
import { DOC_SECTIONS } from '../../config/docLinks';
import { setTurnLimit } from '../../services/rosterService';
import { welcomeContextFor } from './WelcomeEditorGuide';
import { type WelcomePromptOption } from './welcomeWorkflow';
import { SHIPPED_EVENT_WORKFLOWS, welcomeWorkflowOf } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import WorkflowBuilder from './WorkflowBuilder';
import { NEW_WORKFLOW_FOCUS } from './workflowEdits';
import IntentWorkflowsFields from './IntentWorkflowsFields';
import { useTaskMachineSource } from './useTaskMachineSource';
import WelcomeModeEditor from './WelcomeModeEditor';
import { declaredTypesFor, processesRenamed } from './EventWorkflowEditor';
import { welcomeHolding, welcomeNameFor, welcomeTypeOf } from './welcomeWorkflow';
import { parseTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import { s3PrefixUrl } from '../../services/awsConsole';
import { readableByRole } from '../../../../../../backend/lambda/src/lib/context-source-reach.ts';
import { resolveGuardrailSelection } from '../../../../../../backend/lambda/src/lib/guardrail-selection.ts';
import type {
  AssistantCopy,
  ClassificationCatalog,
  FieldDecision,
  ProfileDefinitionBody,
  ProfileDraftPatch,
  ProfileListing,
  ToolDescriptor,
} from '../../services/profileService';
import type { WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { listMessageTemplates } from '../../services/profileService';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** The guide section each JSON or read-only field points to. */
const FIELD_GUIDES: Record<string, keyof typeof DOC_SECTIONS> = {
  personaOrPack: 'personaOrPack',
  globalWorkflows: 'globalWorkflows',
  onboarding: 'onboarding',
  boundary: 'liveVersusDeploy',
  experiments: 'personaOrPack',
  models: 'modelsSection',
  messages: 'messageTemplates',
  variables: 'variables',
  welcome: 'welcomeOrientation',
  goldenSet: 'goldenSet',
};

/** "Fixed for the assistant's life", as the create flow says it, with its guide. Explanation, not a warning. */
export const FixedForLife: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="admin-field-hint" data-testid="fixed-for-life">
      {t('admin.assistantPage.fixedForLife')}
      <GuideLinks guides={[guideSection(t('admin.assistantPage.fixedForLifeGuide'), 'addRole')]} />
    </div>
  );
};

/**
 * How a JSON-only or read-only field is changed: the decision's command and guide, said in place.
 * Renders nothing for a field with a control.
 */
export const EditPath: React.FC<{ field: string; decision?: FieldDecision }> = ({ field, decision }) => {
  const { t } = useTranslation();
  if (!decision || decision.kind === 'control') return null;
  const section = FIELD_GUIDES[decision.guide];
  const guides: Guide[] = section ? [guideSection(t('admin.assistantPage.guideLead'), section)] : [];
  return (
    <div className="admin-field-hint" data-testid={`edit-path-${field}`}>
      <strong>{t(decision.kind === 'json' ? 'admin.assistantPage.editedAsJson' : 'admin.assistantPage.readOnly')}.</strong>{' '}
      {decision.kind === 'json'
        ? <>{t('admin.assistantPage.jsonPath', { field })} <code>{decision.command}</code></>
        : t(`admin.assistantPage.drivenBy.${decision.drivenBy}`)}
      {guides.length > 0 && <GuideLinks guides={guides} />}
    </div>
  );
};

/** A read-only row: its label, its help, its value, then the line that says how it changes, in that order on every width. */
export const Row: React.FC<{ testId: string; label: string; help?: string; children: React.ReactNode; path?: React.ReactNode }> = ({ testId, label, help, children, path }) => (
  <>
    <dt>{label}</dt>
    <dd data-testid={testId}>
      {help && <div className="admin-field-hint">{help}</div>}
      <div className="admin-config-value">{children}</div>
      {path}
    </dd>
  </>
);

/**
 * A field's control, read the way a row is: its label, its help, then the control, on every width. The help describes
 * the control (`aria-describedby`), so the label alone names it. The draft's controls and the creation wizard's share it.
 */
export const StackedField: React.FC<{
  label: string;
  help?: React.ReactNode;
  testId?: string;
  children: (ids: { id: string; describedBy?: string }) => React.ReactNode;
}> = ({ label, help, testId, children }) => {
  const id = React.useId();
  const helpId = `${id}-help`;
  return (
    <div className="admin-stacked-field" data-testid={testId}>
      <label className="admin-field-label" htmlFor={id}>{label}</label>
      {help && <span className="admin-field-hint" id={helpId}>{help}</span>}
      {children({ id, ...(help ? { describedBy: helpId } : {}) })}
    </div>
  );
};

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="admin-muted">{children}</span>;

/**
 * What a row that reads the version shows before that version is in hand: loading while it is read, and unreadable
 * when the read failed. Neither says the version holds nothing, which only a version that was read can say.
 */
const VersionNotRead: React.FC<{ loading?: boolean }> = ({ loading }) => {
  const { t } = useTranslation();
  return <Muted>{t(loading ? 'admin.profiles.loadingConfiguration' : 'admin.assistantPage.unreadable')}</Muted>;
};

/** Classifier mode, read where the router reads it, and how it changes for this kind of assistant. */
export const ClassifierModeRow: React.FC<{ selected: ProfileListing }> = ({ selected }) => {
  const { t } = useTranslation();
  const mode = selected.deployedClassifierMode;
  return (
    <Row testId="field-classifierMode" label={t('admin.assistantPage.field.classifierMode')} help={t('admin.assistantPage.help.classifierMode')}
      path={<div className="admin-field-hint">{t(selected.origin === 'console' ? 'admin.assistantPage.help.classifierModeConsole' : 'admin.assistantPage.help.classifierModeDeclared')}
        <GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'seedFields')]} /></div>}>
      {mode ? <code>{mode}</code> : <Muted>{t('admin.assistantPage.unreadable')}</Muted>}
    </Row>
  );
};

/**
 * The tested instruction an experiment left on the version, and on the active version the boundary line. On a
 * draft, `moveAction` is the action that moves the instruction into the persona (`MoveIntoPersona`).
 */
export const PersonaExtras: React.FC<{ config: ProfileDefinitionBody; decisions: Record<string, FieldDecision>; moveAction?: React.ReactNode; editing?: boolean }> = ({ config, decisions, moveAction, editing }) => {
  const { t } = useTranslation();
  return (
    <dl className="admin-config-list">
      <Row testId="field-systemPromptAddendum" label={t('admin.assistantPage.field.systemPromptAddendum')} help={t('admin.assistantPage.help.systemPromptAddendum')}
        path={<><EditPath field="systemPromptAddendum" decision={decisions.systemPromptAddendum} />{moveAction}</>}>
        {config.systemPromptAddendum ? <code>{config.systemPromptAddendum}</code> : <Muted>{t('admin.assistantPage.notSet')}</Muted>}
      </Row>
      {/* ON A DRAFT IT IS EDITED IN THE IDENTITY AREA ABOVE. */}
      {!editing && (
        <Row testId="field-boundary" label={t('admin.assistantPage.field.boundary')} help={t('admin.assistantPage.help.boundary')}>
          {config.boundary ? <span>{config.boundary}</span> : <Muted>{t('admin.assistantPage.notSet')}</Muted>}
        </Row>
      )}
    </dl>
  );
};

/**
 * The retired welcome and lines, onboarding and reply preferences, as the active version carries them. The welcome
 * itself is the version's assistant-joined workflows, which the Workflows section lists with every other event workflow.
 */
export const WordsGroup: React.FC<{ config: ProfileDefinitionBody; decisions: Record<string, FieldDecision>; catalog?: ClassificationCatalog; profileName?: string }> = ({ config, decisions, catalog, profileName }) => {
  const { t } = useTranslation();
  const copyKeys = Object.keys(config.copy ?? {});
  return (
    <dl className="admin-config-list">
      {config.welcome !== undefined && (
        <Row testId="field-retired-welcome" label={t('admin.assistantPage.field.retiredWelcome')} help={t('admin.assistantPage.help.retiredWelcome')}
          path={<EditPath field="welcome" decision={decisions.welcome} />}>
          <Muted>{t('admin.assistantPage.help.retiredWelcomeRead')}</Muted>
        </Row>
      )}
      {/* RETIRED LINES are shown only where a version stored before message templates still carries them, with how they
          move: nothing reads them, and what this assistant says is edited under Message templates. */}
      {copyKeys.length > 0 && (
        <Row testId="field-copy" label={t('admin.assistantPage.field.copy')} help={t('admin.assistantPage.help.copy')}
          path={<EditPath field="copy" decision={decisions.copy} />}>
          <details>
            <summary>{t('admin.assistantPage.help.copyRetired', { count: copyKeys.length })}</summary>
            <table className="admin-mini-table"><tbody>
              {copyKeys.map((k) => {
                const v = (config.copy as AssistantCopy)[k];
                return <tr key={k}><td><code>{k}</code></td><td>{typeof v === 'string' ? v : JSON.stringify(v)}</td></tr>;
              })}
            </tbody></table>
          </details>
        </Row>
      )}
      <Row testId="field-onboarding" label={t('admin.assistantPage.field.onboarding')} help={t('admin.assistantPage.help.onboarding')}
        path={<EditPath field="onboarding" decision={decisions.onboarding} />}>
        {config.onboarding ? (
          <details>
            <summary>{config.onboarding.greeting ?? ''}</summary>
            <ul>{(config.onboarding.fields ?? []).map((f) => <li key={f.key}><code>{f.key}</code> {f.prompt}</li>)}</ul>
          </details>
        ) : catalog?.onboardingIntake && (!catalog.primaryAssistant || catalog.primaryAssistant === profileName) ? (
          <details data-testid="field-onboarding-deployment">
            <summary>{t('admin.assistantPage.help.onboardingDeployment', { param: `/agent-echelon/assistant/${catalog.classification}/onboarding-intake` })}</summary>
            {catalog.onboardingIntake.greeting && <p>{catalog.onboardingIntake.greeting}</p>}
            <ul>{catalog.onboardingIntake.questions.map((q) => <li key={q}>{q}</li>)}</ul>
          </details>
        ) : <Muted>{t('admin.assistantPage.notSet')}</Muted>}
      </Row>
      <Row testId="field-replyPreferences" label={t('admin.assistantPage.field.replyPreferences')} help={t('admin.assistantPage.help.replyPreferences')}
        path={<GuideLinks guides={[guide(t('admin.assistantPage.guideLead'), 'userProfile')]} />}>
        <Muted>{t('admin.assistantPage.readOnly')}</Muted>
      </Row>
    </dl>
  );
};

/** What it reads into each turn and the company context it may reach. */
export const ContextGroup: React.FC<{
  config: ProfileDefinitionBody | null;
  /** The version is being read; until it is, the sources and tools it selects are not known. */
  configLoading?: boolean;
  catalog?: ClassificationCatalog;
  role?: string;
}> = ({ config, configLoading, catalog, role }) => {
  const { t } = useTranslation();
  const read = !configLoading && !!config;
  // EACH PREFIX IS A LOCATION IN THE DEPLOYMENT'S COMPANY BUCKET, named with its bucket and linked to it, so
  // nobody has to guess where `context/premium/` is.
  const bucket = catalog?.contextBucket;
  const prefixes = (list: string[] | undefined) => (list?.length
    ? list.map((p) => (bucket
      ? <a key={p} className="admin-chip" href={s3PrefixUrl(bucket, p)} target="_blank" rel="noreferrer"><code>{bucket}/{p}</code></a>
      : <code key={p} className="admin-chip">{p}</code>))
    : <Muted>{t('admin.assistantPage.none')}</Muted>);
  const roleReach = role ? catalog?.roles?.[role]?.contextPrefixes : undefined;
  // THE COMPANY DOCUMENT MENU AND ITS TOOL, as the turn decides them: offered when the version's tools allow
  // load_company_context (no list allows every tool) and the role reads company context.
  const companyDocuments = !read ? null
    : config?.tools && !config.tools.includes('load_company_context') ? 'NoTool'
      : roleReach && roleReach.length === 0 ? 'NoReach'
        : roleReach ? 'Included' : null;
  return (
    <dl className="admin-config-list">
      <Row testId="field-companyDocuments" label={t('admin.assistantPage.field.companyDocuments')} help={t('admin.assistantPage.help.companyDocuments')}
        path={<GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'contextDocuments')]} />}>
        {companyDocuments
          ? <Muted>{t(`admin.assistantPage.help.companyDocuments${companyDocuments}`)}</Muted>
          : !read ? <VersionNotRead loading={configLoading} /> : <Muted>{t('admin.assistantPage.unreadable')}</Muted>}
      </Row>
      <Row testId="field-contextSources" label={t('admin.assistantPage.field.contextSources')} help={t('admin.assistantPage.help.contextSources')}
        path={<GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'contextSources')]} />}>
        {!read ? <VersionNotRead loading={configLoading} /> : config?.contextSources?.length
          ? <ol>{config.contextSources.map((k) => <li key={k}><code>{k}</code></li>)}</ol>
          : <Muted>{t('admin.assistantPage.none')}</Muted>}
      </Row>
      <Row testId="field-retrievalReach" label={t('admin.assistantPage.field.retrievalReach')} help={t('admin.assistantPage.help.retrievalReach')}
        path={<GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'retrievalScope')]} />}>
        {prefixes(catalog?.retrievalReach)}
      </Row>
      <Row testId="field-roleReach" label={t('admin.assistantPage.field.roleReach')} help={t('admin.assistantPage.help.roleReach')}>
        {prefixes(roleReach)}
      </Row>
      <Row testId="field-toolsAllowlist" label={t('admin.assistantPage.field.toolsAllowlist')} help={t('admin.assistantPage.help.toolsAllowlist')}
        path={<GuideLinks guides={[guide(t('admin.assistantPage.guideLead'), 'roleDesign')]} />}>
        {!read ? <VersionNotRead loading={configLoading} /> : config?.tools?.length ? config.tools.map((x) => <code key={x} className="admin-chip">{x}</code>) : <Muted>{t('admin.assistantPage.none')}</Muted>}
      </Row>
    </dl>
  );
};

/**
 * Turns per hour: a control for a console-created assistant the session may manage (the route refuses the
 * rest), and the deployed value with its edit path for a declared one. Then the deployed sizing and budgets.
 */
export const LimitsGroup: React.FC<{
  selected: ProfileListing;
  catalog?: ClassificationCatalog;
  canEditLimit: boolean;
  /** A team member's own team, when the session is a team's. */
  team?: string;
  onSaved: () => void;
}> = ({ selected, catalog, canEditLimit, team, onSaved }) => {
  const { t } = useTranslation();
  const isConsole = selected.origin === 'console';
  const editable = isConsole && canEditLimit;
  const [value, setValue] = useState<string>(selected.deployedTurnLimit ? String(selected.deployedTurnLimit) : '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { setValue(selected.deployedTurnLimit ? String(selected.deployedTurnLimit) : ''); }, [selected.deployedTurnLimit, selected.profileName]);
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const n = value.trim() ? Number(value.trim()) : null;
      await setTurnLimit(selected.profileName, n, team);
      setStatus(t('admin.assistantPage.saved'));
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const topo = catalog?.topology;
  const budgets = catalog?.budgets;
  return (
    <dl className="admin-config-list">
      <Row testId="assistant-rate-limit" label={t('admin.config.rateLimit')} help={t('admin.config.rateLimitHelp')}
        path={<div className="admin-field-hint">{t(selected.origin === 'console' ? 'admin.assistantPage.help.turnLimitConsole' : 'admin.assistantPage.help.turnLimitDeclared')}
          {!isConsole && <GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'seedFields')]} />}</div>}>
        {editable ? (
          <span>
            <input className="input" type="number" min={1} step={1} value={value} aria-label={t('admin.assistantPage.help.turnLimitInput')}
              placeholder={t('admin.config.rateLimitNone')} onChange={(e) => setValue(e.target.value)} data-testid="turn-limit-input" />{' '}
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { void save(); }}>{t('admin.assistantPage.save')}</button>
            {status && <span role="status" className="admin-field-hint"> {status}</span>}
          </span>
        ) : selected.deployedTurnLimit
          ? t('admin.config.rateLimitValue', { count: selected.deployedTurnLimit })
          : t('admin.config.rateLimitNone')}
      </Row>
      <Row testId="field-topology" label={t('admin.assistantPage.field.topology')} help={t('admin.assistantPage.help.topology', { classification: selected.classification ?? '' })}
        path={<GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'topology')]} />}>
        {topo ? <code>{topo.processorTimeout}s · {topo.memorySize} MB{topo.maxTokens ? ` · ${topo.maxTokens} tokens` : ''}</code> : <Muted>{t('admin.assistantPage.unreadable')}</Muted>}
      </Row>
      <Row testId="field-budgets" label={t('admin.assistantPage.field.budgets')} help={t('admin.assistantPage.help.budgets')}>
        {budgets ? <code>{budgets.userHourly ?? '-'} / {budgets.globalHourly ?? '-'}</code> : <Muted>{t('admin.assistantPage.unreadable')}</Muted>}
      </Row>
    </dl>
  );
};

/** The platform's own behavior, labeled platform-level and not editable, apart from the version and the pack. */
export const PlatformSection: React.FC = () => {
  const { t } = useTranslation();
  const items: Array<{ id: string; guide: Guide }> = [
    { id: 'taskLifecycle', guide: guide(t('admin.assistantPage.platform.taskLifecycleGuide'), 'taskStates') },
    { id: 'turnQueue', guide: guide(t('admin.assistantPage.platform.turnQueueGuide'), 'turnQueue') },
    { id: 'triage', guide: guideSection(t('admin.assistantPage.platform.triageGuide'), 'queueTriage') },
    { id: 'queueManagement', guide: guideSection(t('admin.assistantPage.platform.queueManagementGuide'), 'queueClearing') },
    { id: 'deliveryCheck', guide: guideSection(t('admin.assistantPage.platform.deliveryCheckGuide'), 'deliveryChecks') },
  ];
  return (
    <section id="assistant-config-platform" aria-labelledby="assistant-config-platform-title" data-testid="assistant-config-platform">
      <h4 id="assistant-config-platform-title">{t('admin.assistantPage.platform.title')} <span className="admin-badge">{t('admin.assistantPage.platform.badge')}</span></h4>
      <p className="admin-config-group-help">{t('admin.assistantPage.platform.help')}</p>
      <dl className="admin-config-list">
        {items.map((i) => (
          <React.Fragment key={i.id}>
            <dt>{t(`admin.assistantPage.platform.${i.id}Label`)}</dt>
            <dd data-testid={`platform-${i.id}`}>
              {t(`admin.assistantPage.platform.${i.id}`)}
              <GuideLinks guides={[i.guide]} />
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
};


/** Lines of a textarea, trimmed, blanks dropped. */

/**
 * THE TEMPLATES THIS ASSISTANT SAYS, read for the welcome's prompt turn and the event workflows' pickers: its own, its
 * classification's and the shipped ones, by name. `unreadable` when the listing could not be read at all.
 */
export function useTemplateOptions(profileName?: string): { prompts?: WelcomePromptOption[]; unreadable: boolean } {
  const [prompts, setPrompts] = useState<WelcomePromptOption[] | undefined>();
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    if (!profileName) return;
    let live = true;
    // Read inside the promise, so a listing that cannot be read at all says so rather than throwing on render.
    Promise.resolve().then(() => listMessageTemplates(profileName)).then((r) => {
      if (!live) return;
      const out = new Map<string, WelcomePromptOption>();
      for (const l of r.templates) {
        out.set(l.name, l.own ? { name: l.name, kind: l.kind, source: l.own.source, origin: 'assistant' }
          : l.classification ? { name: l.name, kind: l.kind, source: l.classification.source, origin: 'classification' }
            : { name: l.name, kind: l.kind, source: l.shipped, origin: 'shipped' });
      }
      // The assistant's own prompts under names of their own, which no shipped template lists.
      for (const [name, held] of Object.entries(r.family ?? {})) {
        if (out.has(name)) continue;
        try { out.set(name, { name, kind: parseTemplate(held.source).kind === 'prompt' ? 'prompt' : 'message', source: held.source, origin: 'assistant' }); } catch { /* not a template a welcome can name */ }
      }
      setPrompts([...out.values()]);
    }).catch(() => { if (live) setUnreadable(true); });
    return () => { live = false; };
  }, [profileName]);
  return { prompts, unreadable };
}

/**
 * THE GUARDRAIL AND THE CONTEXT SOURCES, the half of "what it can do" this file renders (the tools are the other half,
 * `DraftAreaFields.tsx`). Seeded from the draft and reported ONLY ONCE EDITED, so a save never rewrites a field nobody touched.
 */
export const GuardrailAndSources: React.FC<{
  config: ProfileDefinitionBody | null;
  catalog?: ClassificationCatalog;
  onPatch: (patch: ProfileDraftPatch) => void;
  /** The assistant's role, which decides which company-context sources its turns can read. */
  role?: string;
  /** Which half this section edits. */
  only: 'guardrail' | 'sources';
}> = ({ config, catalog, onPatch, role, only }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const showGuardrail = only === 'guardrail';
  const showSources = only === 'sources';
  // A STORED CATALOG KEY ('strict') IS SHOWN AS THE GUARDRAIL IT NAMES: the draft edit stores the id it maps to.
  const [guardrail, setGuardrail] = useState(() => {
    const stored = config?.guardrailId ?? '';
    const resolved = stored && catalog?.guardrails ? resolveGuardrailSelection(stored, catalog.guardrails) : undefined;
    return resolved && 'guardrailId' in resolved ? resolved.guardrailId : stored;
  });
  const [sources, setSources] = useState<string[]>(config?.contextSources ?? []);
  const catalogSources = catalog?.contextSources ?? [];
  // WHAT THE ROLE CAN READ, by the rule the turn applies (`readableByRole`). Unknown while the role's reach is unread.
  const rolePrefixes = role ? catalog?.roles?.[role]?.contextPrefixes : undefined;
  return (
    <>
      {showGuardrail && <label><span className="admin-field-label">{t('admin.assistantPage.field.guardrail')} <InfoTooltip label={t('admin.assistantPage.field.guardrail')} content={t('admin.assistantPage.help.guardrail')} /></span>
        <select data-testid="draft-guardrail" className="select" value={guardrail}
          onChange={(e) => { setGuardrail(e.target.value); onPatch({ guardrailId: e.target.value || null }); }}>
          <option value="">{t('admin.assistantPage.help.guardrailDefault')}</option>
          {(catalog?.guardrails ?? []).map((g) => <option key={g.key} value={g.guardrailId}>{g.key}</option>)}
        </select>
      </label>}

      {showSources && <div className="profiles-persona-field" data-testid="draft-context-sources">
        <h4>{t('admin.assistantPage.field.contextSources')} <InfoTooltip label={t('admin.assistantPage.field.contextSources')}
          content={`${t('admin.assistantPage.help.contextSources')} ${t('admin.assistantPage.field.companyDocuments')}: ${t('admin.assistantPage.help.companyDocuments')}`} /></h4>
        {catalogSources.length === 0
          ? <span className="admin-muted">{t(catalog?.contextSources ? 'admin.assistantPage.none' : 'admin.assistantPage.unreadable')}</span>
          : (
            <div className="admin-filter-group">
              {catalogSources.map((s) => {
                const at = sources.indexOf(s.key);
                // A SOURCE THE ROLE CANNOT READ is not offered; one a version already selects stays uncheckable, explained.
                const unreadable = !!rolePrefixes && !readableByRole(s, rolePrefixes);
                return (
                  <label key={s.key} className="admin-check" title={s.description} data-testid={`draft-context-source-${s.key}`}>
                    <input type="checkbox" checked={at >= 0} disabled={unreadable && at < 0} onChange={(e) => {
                      const next = e.target.checked ? [...sources, s.key] : sources.filter((k) => k !== s.key);
                      setSources(next);
                      onPatch({ contextSources: next.length ? next : null });
                    }} />
                    <code>{s.key}</code>{at >= 0 && <span className="admin-field-hint"> #{at + 1}</span>}
                    {unreadable && <span className="admin-field-hint" data-testid={`draft-context-source-unreadable-${s.key}`}> {t('admin.assistantPage.help.sourceNotReadableByRole', { role, prefix: s.prefix })}</span>}
                  </label>
                );
              })}
            </div>
          )}
      </div>}
    </>
  );
};

/**
 * A DRAFT CLONED FROM A VERSION STORED BEFORE W1 carries the retired `welcome` field, which nothing reads: what it is,
 * and a control that clears it. The welcome itself is the version's workflow on assistant-joined, in the builder.
 */
export const RetiredWelcomeNote: React.FC<{ config: ProfileDefinitionBody | null; onPatch: (patch: ProfileDraftPatch) => void }> = ({ config, onPatch }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [retired, setRetired] = useState(() => config?.welcome !== undefined && config?.welcome !== null);
  if (!retired) return null;
  return (
    <div className="profiles-persona-field" role="note" data-testid="draft-retired-welcome">
      <h4>{t('admin.assistantPage.field.retiredWelcome')} <InfoTooltip label={t('admin.assistantPage.field.retiredWelcome')} content={t('admin.assistantPage.help.retiredWelcome')} /></h4>
      <p className="admin-field-hint">{t('admin.assistantPage.help.retiredWelcomeDraft')}</p>
      <ConfirmAction testId="draft-retired-welcome-clear" className="btn-secondary" label={t('admin.assistantPage.help.retiredWelcomeClear')}
        title={t('admin.confirm.retiredClear')} confirmLabel={t('admin.confirm.clear')} cancelLabel={t('admin.confirm.cancel')}
        onConfirm={() => { setRetired(false); onPatch({ welcome: null }); }} />
    </div>
  );
};

/** A draft cloned from an older version that still carries retired `copy` lines: what they are, and a control that clears them. */
export const RetiredCopyNote: React.FC<{ config: ProfileDefinitionBody | null; onPatch: (patch: ProfileDraftPatch) => void }> = ({ config, onPatch }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [retiredCopy, setRetiredCopy] = useState<string[]>(() => Object.keys(config?.copy ?? {}));
  if (!retiredCopy.length) return null;
  return (
    <div className="profiles-persona-field" role="note" data-testid="draft-retired-copy">
      <h4>{t('admin.assistantPage.field.copy')} <InfoTooltip label={t('admin.assistantPage.field.copy')} content={t('admin.assistantPage.help.copy')} /></h4>
      <p className="admin-field-hint">{t('admin.assistantPage.help.copyDraft', { keys: retiredCopy.join(', ') })}</p>
      <ConfirmAction testId="draft-retired-copy-clear" className="btn-secondary" label={t('admin.assistantPage.help.copyClear')}
        title={t('admin.confirm.retiredClear')} confirmLabel={t('admin.confirm.clear')} cancelLabel={t('admin.confirm.cancel')}
        onConfirm={() => { setRetiredCopy([]); onPatch({ copy: null }); }} />
    </div>
  );
};

/**
 * EVENTS: the version's event workflows (ADR-061 decision 1). Most of their events (an invitation, a deadline, an
 * alarm) are no welcome; the welcome is one of them, on assistant-joined, and a welcome that greets and then
 * continues is edited here. Edited on the visual builder (ADR-061 decision 7), whose list view is the step-by-step form; where the
 * steps sit is saved with the draft as its layout, which nothing the version does reads.
 */
export const EventWorkflowsFields: React.FC<{
  config: ProfileDefinitionBody | null;
  catalog?: ClassificationCatalog;
  onPatch: (patch: ProfileDraftPatch) => void;
  profileName?: string;
  tools?: ToolDescriptor[];
  /** The draft's saved canvas layout. */
  layout?: WorkflowLayout;
  /** The draft's kept welcome (ADR-067 G40). */
  keptWelcome?: import('../../../../../../backend/lambda/src/lib/event-workflow.ts').EventWorkflow;
  /** The errors of the draft's last Validate, anchored to the steps they name. */
  serverErrors?: readonly string[];
  /** The workflow the builder opens on. */
  focusWorkflow?: string;
  /** Back to the Workflows list, from the create view the page opened. */
  onLeaveWorkflow?: () => void;
  /** The workflow the builder now shows, once one is created or renamed there, so the page's trail names it. */
  onFocusWorkflow?: (name: string) => void;
  /** The assistant's role, for a welcome's preview. */
  role?: string;
  /** The name the assistant was provisioned with, which a welcome says when the version names none. */
  provisionedName?: string;
}> = ({ config, catalog, onPatch, profileName, tools = [], layout: savedLayout, keptWelcome, serverErrors, focusWorkflow, onLeaveWorkflow, onFocusWorkflow, role, provisionedName }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const { prompts, unreadable } = useTemplateOptions(profileName);
  const [eventWorkflows, setEventWorkflows] = useState<NonNullable<ProfileDefinitionBody['eventWorkflows']>>(() => ({ ...(config?.eventWorkflows ?? {}) }));
  const [layout, setLayout] = useState<WorkflowLayout | undefined>(savedLayout);
  /** The version's processes as this editor last patched them, so a second rename follows the first. */
  const [processes, setProcesses] = useState(config?.processes);
  /** A renamed workflow stays linked from each process that linked it. */
  const onRenamed = (from: string, to: string) => {
    if (focusWorkflow === from) onFocusWorkflow?.(to);
    const next = processesRenamed(processes, from, to);
    if (!next) return;
    setProcesses(next);
    onPatch({ processes: next });
  };
  /** The conversation type picked in the welcome form, or null while it shows the welcome that was opened. */
  const [welcomeType, setWelcomeType] = useState<string | null>(null);
  useEffect(() => setWelcomeType(null), [focusWorkflow]);
  // A TASK STEP'S OWN STEPS OPEN ON THE SAME BUILDER (ADR-067 stage 4).
  const taskMachines = useTaskMachineSource(config, catalog, onPatch);
  // THE WELCOME BEING EDITED: the one opened, or the one for the type picked. A type with no welcome yet starts from the
  // words in use, and reaches the draft only when something changes.
  const welcomeName = welcomeType === null ? focusWorkflow : welcomeNameFor(eventWorkflows, welcomeType) ?? (welcomeType ? `welcome-${welcomeType}` : 'welcome');
  const defaultMissing = welcomeName === 'welcome' && !eventWorkflows.welcome && !welcomeWorkflowOf(eventWorkflows, undefined).declared;
  const typeMissing = !!welcomeType && !!welcomeName && !eventWorkflows[welcomeName];
  const holding = catalog?.welcomeOrientation && (!catalog.primaryAssistant || catalog.primaryAssistant === profileName)
    ? welcomeHolding(SHIPPED_EVENT_WORKFLOWS.welcome, catalog.welcomeOrientation)
    : SHIPPED_EVENT_WORKFLOWS.welcome;
  const defaultName = welcomeNameFor(eventWorkflows, '');
  const welcomeFocus = welcomeName && (eventWorkflows[welcomeName]?.on === 'assistant-joined' || defaultMissing || typeMissing) ? welcomeName : undefined;
  // A SHIPPED WORKFLOW OPENED FOR EDIT: shown on the builder, and in the draft as this assistant's own once something changes.
  const shippedFocus = focusWorkflow && !welcomeFocus && !eventWorkflows[focusWorkflow] ? SHIPPED_EVENT_WORKFLOWS[focusWorkflow] : undefined;
  const shownType = welcomeType ?? welcomeTypeOf(welcomeName ? eventWorkflows[welcomeName] : undefined);
  return (
    <div className="profiles-persona-field" data-testid="draft-event-workflows">
      {!focusWorkflow && <h4>{t('admin.assistantPage.field.eventWorkflows')} <InfoTooltip label={t('admin.assistantPage.field.eventWorkflows')} content={t('admin.assistantPage.help.eventWorkflows')} /></h4>}
      <RetiredWelcomeNote config={config} onPatch={onPatch} />
      {/* A step's template is chosen from the listing, so a listing that could not be read is said, not shown as an empty list. */}
      {unreadable ? <p role="alert" className="admin-error" data-testid="draft-event-templates-unreadable">{t('admin.assistantPage.help.eventTemplatesUnreadable')}</p> : null}
      {/* THE WELCOME IS REQUIRED: every version greets the conversations no typed welcome names. One
          with no welcome of its own runs the built-in one, said here; its row in the list opens it to edit. */}
      {!focusWorkflow && !welcomeWorkflowOf(eventWorkflows, undefined).declared && (
        <p className="admin-field-hint" data-testid="draft-welcome-required">
          {t('admin.workflowEditor.welcomeBuiltIn')}
        </p>
      )}
      {(() => {
        const options = {
          templates: prompts, tools, published: catalog?.variables, variables: config?.variables,
          versionTools: config?.tools, classification: catalog?.classification,
          welcomeContext: welcomeContextFor({ version: { ...config, eventWorkflows }, catalog, assistant: profileName, role, provisionedName }),
        };
        const onLayoutChange = (next: WorkflowLayout | null) => { setLayout(next ?? undefined); onPatch({ layout: next }); };
        const onChange = (next: NonNullable<ProfileDefinitionBody['eventWorkflows']> | null) => {
          const all = next ?? {};
          setEventWorkflows(all);
          onPatch({ eventWorkflows: Object.keys(all).length ? all : null });
        };
        // A WELCOME OPENED FOR EDIT GETS ITS OWN FORM (ADR-067 stage 1): Template, Prompt or Workflow, the builder only in Workflow.
        return welcomeFocus ? (
          <>
            <label><span className="admin-field-label">{t('admin.workflowsList.welcomeFor')}</span>
              <select className="select" data-testid="welcome-for-type" value={shownType} onChange={(e) => setWelcomeType(e.target.value)}>
                <option value="">{t('admin.workflowsList.welcomeForDefault')}</option>
                {declaredTypesFor('assistant-joined', catalog?.classification).map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <span className="admin-field-hint">{t('admin.workflowsList.welcomeForHelp')}</span>
            </label>
            <WelcomeModeEditor key={welcomeFocus} name={welcomeFocus} workflows={eventWorkflows} {...options}
              builtIn={defaultMissing ? holding
                : typeMissing ? { ...(defaultName ? eventWorkflows[defaultName] : holding), types: [welcomeType!] } : undefined}
              layout={layout} profileName={profileName}
              kept={keptWelcome} onKeptChange={(next) => onPatch({ keptWelcomeWorkflow: next })}
              serverErrors={serverErrors} onLayoutChange={onLayoutChange} onChange={onChange} />
          </>
        ) : (
          <WorkflowBuilder workflows={shippedFocus ? { ...eventWorkflows, [focusWorkflow!]: shippedFocus } : eventWorkflows} {...options}
            layout={layout} profileName={profileName} serverErrors={serverErrors} initialWorkflow={focusWorkflow} startCreating={focusWorkflow === NEW_WORKFLOW_FOCUS} onCancelCreate={onLeaveWorkflow}
            taskMachines={taskMachines} onLayoutChange={onLayoutChange} onChange={onChange} onRenamed={onRenamed}
            onCreated={focusWorkflow ? onFocusWorkflow : undefined} />
        );
      })()}
      {/* THE WORKFLOW EACH MULTI-STEP INTENT RUNS (ADR-067 decision 1), beside the event workflows on the same builder. */}
      {!focusWorkflow && <IntentWorkflowsFields config={config} catalog={catalog} onPatch={onPatch} profileName={profileName} tools={tools}
        prompts={prompts} serverErrors={serverErrors} focusIntent={focusWorkflow} taskMachines={taskMachines}
        layout={layout} onLayoutChange={(next) => { setLayout(next ?? undefined); onPatch({ layout: next }); }} />}
    </div>
  );
};
