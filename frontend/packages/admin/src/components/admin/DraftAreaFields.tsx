/**
 * ONE AREA OF A DRAFT, EDITED ALONE: the controls an assistant's page and the creation wizard show in a section.
 *
 * Each area seeds its controls from the draft (the saved draft with the area's unsaved edit laid over it) and reports a patch of its own fields ONLY ONCE EDITED, so saving
 * one area never rewrites a field another area or the CLI set. The controls are the console's existing ones (the
 * welcome, the event workflow editor, the message templates, the routing rules); this file decides which belong
 * together, not how a field is edited. Which fields an area owns is `draftAreas.ts`.
 */
import React, { useState } from 'react';
import { WELCOME_TOKENS } from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import { useTranslation } from 'react-i18next';
import { InfoTooltip, GuideLinks, guideSection } from './AdminHelp';
import {
  EditPath,
  EventWorkflowsFields,
  GuardrailAndSources,
  RetiredCopyNote,
} from './AssistantConfigFields';
import MessageTemplatesEditor from './MessageTemplatesEditor';
import { tableFromPublished, versionVariablesErrors } from '../../../../../../backend/lambda/src/lib/variables.ts';
import RoutingRulesEditor from './RoutingRulesEditor';
import { ProcessesFields } from './ProcessesFields';
import type { DraftArea } from './draftAreas';
import { contextSourceGroups, definitionKey, platformGroups, type VariableRow } from './variableGroups';
import type {
  ClassificationCatalog,
  FieldDecision,
  ProfileDefinitionBody,
  ProfileDraftPatch,
  ToolDescriptor,
} from '../../services/profileService';

/** The task tools tied at runtime (`async-processor-core.ts`): a version allowing the first is offered the second. */
const ADVANCE_TASK_STATE = 'advance_task_state';
const DELIVER_DOCUMENT = 'deliver_document';

/** The backend's own cap (`active-profile.ts`), mirrored so the field bounds what the API accepts. */
export const MAX_PERSONA_LENGTH = 20000;

type T = (key: string, opts?: Record<string, unknown>) => string;

/** The persona box: a textarea in the input look, sized by the stylesheet (admin-forms-are-styled.test.ts). */
const PERSONA_INPUT = ['textarea', 'input', 'profiles-persona-input'].join(' ');

/** What every area is handed. */
export interface AreaProps {
  /** The draft the controls start from: the saved draft with this area's unsaved edit laid over it. */
  draft: ProfileDefinitionBody;
  /** The area's own fields, once edited, merged into the step's unsaved patch. */
  onPatch: (patch: ProfileDraftPatch) => void;
  profileName: string;
  /** The name a version that sets none inherits: the one the identity is provisioned with (`provisionedDisplayName`). */
  provisionedName?: string;
  role?: string;
  catalog?: ClassificationCatalog;
  /** The tool registry, served with the listing. */
  tools: ToolDescriptor[];
  decisions: Record<string, FieldDecision>;
  /** Saving a template is an activation (`activate-profiles`). */
  canActivate: boolean;
  /** Choosing which template a message uses is a draft edit (`edit-profiles`). */
  canEdit: boolean;
  /** The draft's saved workflow canvas layout (ADR-061 decision 7). */
  layout?: import('../../../../../../backend/lambda/src/lib/workflow-layout.ts').WorkflowLayout;
  /** The draft's kept welcome (ADR-067 G40), which the welcome's form restores on a switch back to Workflow. */
  keptWelcome?: import('../../../../../../backend/lambda/src/lib/event-workflow.ts').EventWorkflow;
  /** The errors of the draft's last Validate, which the workflow builder anchors to its steps. */
  validationErrors?: readonly string[];
  /** The workflow the builder opens on: the one the page's Edit in a draft chose. */
  focusWorkflow?: string;
  /** Opens the version's Workflows section, where the process wizard sends a person to create a workflow. */
  onOpenWorkflows?: () => void;
  /** The configId of the draft shown, which a process import adds to (SPEC-PROCESSES P13). */
  draftConfigId?: string;
  /** Reads the draft again once a process import landed in it, or kept a newer one. */
  onProcessImported?: (landed: boolean) => void | Promise<void>;
}

/** WHO IT IS: the name people see and the persona it answers with. */
export const IdentityFields: React.FC<AreaProps> = ({ draft, onPatch, profileName, provisionedName, catalog }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [name, setName] = useState(draft.displayName ?? '');
  const [persona, setPersona] = useState(draft.persona ?? '');
  const [boundary, setBoundary] = useState(draft.boundary ?? '');
  return (
    <div className="admin-form-grid">
      <label><span className="admin-field-label">{t('admin.profiles.assistantName')} <InfoTooltip label={t('admin.profiles.assistantName')} content={t('admin.profiles.field.assistantName')} /></span>
        <input type="text" className="input" data-testid="draft-name" value={name} maxLength={100}
          placeholder={t('admin.draftCards.inheritName', { name: provisionedName || profileName })}
          // A cleared name is sent as `null`, which inherits the provisioned name (the patch is a merge).
          onChange={(e) => { setName(e.target.value); onPatch({ displayName: e.target.value.trim() || null }); }} />
      </label>
      {/* THE PERSONA spans the grid: it is prose, often hundreds of words. NOT TRIMMED: whitespace in a prompt is the author's. */}
      <label className="profiles-persona-field"><span className="admin-field-label">{t('admin.profiles.persona')} <InfoTooltip label={t('admin.profiles.persona')} content={t('admin.profiles.field.persona')} /></span>
        <textarea data-testid="draft-persona" className={PERSONA_INPUT} value={persona}
          maxLength={MAX_PERSONA_LENGTH} rows={12}
          // WHAT A BLANK PERSONA READS, as the turn reads it: the classification parameter only for its primary.
          placeholder={catalog?.primaryAssistant && catalog.primaryAssistant !== profileName
            ? t('admin.draftCards.personaPlaceholderNotPrimary', { primary: catalog.primaryAssistant })
            : t('admin.profiles.blankFallBackToThe')}
          onChange={(e) => { setPersona(e.target.value); onPatch({ persona: e.target.value || null }); }} />
        <span className="admin-field-hint">{t('admin.draftCards.personaLength', { chars: persona.length.toLocaleString(), max: MAX_PERSONA_LENGTH.toLocaleString() })}</span>
      </label>
      <label className="profiles-persona-field"><span className="admin-field-label">{t('admin.assistantPage.field.boundary')}</span>
        <textarea data-testid="draft-boundary" className={PERSONA_INPUT} value={boundary} rows={3}
          onChange={(e) => { setBoundary(e.target.value); onPatch({ boundary: e.target.value.trim() || null }); }} />
        <span className="admin-field-hint">{t('admin.assistantPage.help.boundary')}</span>
      </label>
    </div>
  );
};

/**
 * WHAT IT CAN DO: the tools it is offered and the context sources it reads. The tool
 * list changes what it is offered, not what its classification's processor role may reach.
 */
export const AbilitiesFields: React.FC<AreaProps> = ({ draft, onPatch, catalog, tools, role }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  // NULL RATHER THAN AN EMPTY LIST when the registry has not arrived: `[]` would mean "no tools at all".
  const [chosen, setChosen] = useState<string[] | null>(() => (draft.tools ? [...draft.tools] : (tools.length ? tools.map((x) => x.name) : null)));
  const advancing = (chosen ?? []).includes(ADVANCE_TASK_STATE);
  return (
    <div className="admin-form-grid">
      <div className="profiles-persona-field" data-testid="draft-tools">
        <h4>{t('admin.profiles.tools')} <InfoTooltip label={t('admin.profiles.tools')} content={t('admin.profiles.thisAssistantSToolSurface')} /></h4>
        <div className="admin-filter-group">
          {tools.map((tool) => {
            const selected = (chosen ?? []).includes(tool.name);
            // A TOOL OFFERED ONLY TO OTHER ROLES (`roles`, read by the loop's `toolOfferedToRole`) is never offered to this
            // assistant: not offered here, and a version that already selects it keeps it, explained.
            const otherRoles = !!role && !!tool.roles && !tool.roles.includes(role);
            // DELIVER_DOCUMENT TRAVELS WITH THE ADVANCE TOOL at runtime, so while advance_task_state is selected it is shown
            // as included and cannot be removed alone.
            const riding = tool.name === DELIVER_DOCUMENT && advancing;
            return (
              <label key={tool.name} className="admin-check" data-testid={`draft-tool-${tool.name}`} title={t('admin.profiles.needs', { description: tool.description, requires: tool.requires })}>
                <input type="checkbox" checked={selected || riding} disabled={riding || (otherRoles && !selected)} onChange={(e) => {
                  const set = new Set(chosen ?? []);
                  if (e.target.checked) set.add(tool.name); else set.delete(tool.name);
                  const next = [...set];
                  setChosen(next);
                  onPatch({ tools: next });
                }} />
                <code>{tool.name}</code>
                {otherRoles && <span className="admin-field-hint" data-testid={`draft-tool-role-${tool.name}`}> {t('admin.profiles.toolRoleRequired', { roles: (tool.roles ?? []).join(', '), role })}</span>}
                {riding && <span className="admin-field-hint" data-testid={`draft-tool-riding-${tool.name}`}> {t('admin.profiles.toolIncludedWithAdvance')}</span>}
              </label>
            );
          })}
        </div>
      </div>
      <GuardrailAndSources only="sources" config={draft} catalog={catalog} onPatch={onPatch} role={role} />
    </div>
  );
};

/** ROUTING: the version's rules, each a condition and the model that serves a turn it holds for. */
export const RoutingFields: React.FC<AreaProps> = ({ draft, onPatch, catalog }) => {
  const [models, setModels] = useState(() => draft.models ?? {});
  return (
    <RoutingRulesEditor rules={models.routing ?? []} models={catalog?.models.text ?? []} published={catalog?.variables}
      contextSources={(draft.contextSources ?? []).map((c) => (typeof c === 'string' ? c : (c as { key: string }).key))}
      onChange={(routing) => {
        const { routing: _old, ...rest } = models;
        const next = routing ? { ...rest, routing } : rest;
        setModels(next);
        onPatch({ models: next });
      }} />
  );
};

/** WHAT IT SAYS: its own templates, saved to the store and in use at once, and which template each message uses in this version. */
export const MessagesFields: React.FC<AreaProps> = ({ draft, onPatch, profileName, catalog, canActivate, canEdit }) => (
  <>
    <MessageTemplatesEditor profileName={profileName} messages={draft.messages} canSave={canActivate}
      onMessagesChange={canEdit ? (next) => onPatch({ messages: next }) : undefined}
      published={catalog?.variables} variables={draft.variables} deploymentLines={catalog?.deploymentLines}
      contextSources={(draft.contextSources ?? []).map((c) => (typeof c === 'string' ? c : (c as { key: string }).key))} />
    <RetiredCopyNote config={draft} onPatch={onPatch} />
  </>
);

/** VARIABLES: edited as JSON, so this step lists them and says where and how they change (editable-or-explained). */
/** One group's values: the name, what it holds, its type and who wrote it. */
const VariableTable: React.FC<{ t: T; rows: VariableRow[]; definition: (r: VariableRow) => string }> = ({ t, rows, definition }) => (
  <table className="admin-mini-table">
    <thead>
      <tr>
        <th>{t('admin.variables.col.name')}</th>
        <th>{t('admin.draftCards.variableGroups.welcome.holds')}</th>
        <th>{t('admin.variables.col.type')}</th>
        <th>{t('admin.variables.col.trust')}</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr key={r.source}>
          <td><code>{r.source}</code></td>
          <td>{definition(r)}</td>
          <td><code>{r.type}</code></td>
          <td>{t(`admin.variables.trust.${r.trust}`)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export const VariablesFields: React.FC<AreaProps> = ({ draft, decisions, catalog }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const entries = Object.entries(draft.variables ?? {});
  // WHAT VALIDATE REFUSES, read once per render over the served table.
  const variableErrors = catalog?.variables && entries.length > 0 ? versionVariablesErrors(draft.variables, tableFromPublished(catalog.variables)) : [];
  const contextGroups = contextSourceGroups(catalog?.variables, catalog?.contextSources);
  const platform = platformGroups(catalog?.variables);
  const definition = (source: string) => {
    const { key, values } = definitionKey(source);
    return t(key, values);
  };
  return (
    <div data-testid="draft-variables">
      <h4>{t('admin.draftCards.variableGroups.own.title')}</h4>
      <p className="admin-field-hint">{t('admin.draftCards.variableGroups.own.help')}</p>
      {entries.length ? (
        <table className="admin-mini-table">
          <thead><tr><th>{t('admin.draftCards.variableName')}</th><th>{t('admin.draftCards.variableSource')}</th><th>{t('admin.draftCards.variableFallback')}</th></tr></thead>
          <tbody>
            {entries.map(([name, v]) => (
              <tr key={name}><td><code>{name}</code></td><td><code>{v.source}</code></td><td>{v.fallback === undefined ? '-' : Array.isArray(v.fallback) ? v.fallback.join(', ') : String(v.fallback)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <span className="admin-muted">{t('admin.draftCards.summary.variablesNone')}</span>}
      {/* WHAT VALIDATE REFUSES, said here where the variables are listed (`versionVariablesErrors` over the served table). */}
      {variableErrors.length > 0 && (
        <ul role="alert" className="admin-error" data-testid="draft-variables-errors">
          {variableErrors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <EditPath field="variables" decision={decisions.variables} />
      {/* THE FIELDS A WELCOME'S OPENING TEXT CAN NAME, each with what it holds. */}
      <section data-testid="variables-group-welcome">
        <h4>{t('admin.draftCards.variableGroups.welcome.title')}</h4>
        <p className="admin-field-hint">{t('admin.draftCards.variableGroups.welcome.help')}</p>
        <table className="admin-mini-table">
          <thead><tr><th>{t('admin.variables.col.name')}</th><th>{t('admin.draftCards.variableGroups.welcome.holds')}</th></tr></thead>
          <tbody>
            {WELCOME_TOKENS.map((token) => <tr key={token}><td><code>{token}</code></td><td>{t(`admin.welcome.token.${token}`)}</td></tr>)}
          </tbody>
        </table>
      </section>
      {/* WHAT EACH CONTEXT SOURCE PUBLISHES, in the words its catalog declares. */}
      <section data-testid="variables-group-classification">
        <h4>{t('admin.draftCards.variableGroups.classification.title')}</h4>
        <p className="admin-field-hint">{t('admin.draftCards.variableGroups.classification.help')}</p>
        <GuideLinks guides={[guideSection(t('admin.assistantPage.guideLead'), 'contextSources')]} />
        {contextGroups.length ? contextGroups.map((g) => (
          <div key={g.key} data-testid={`variables-source-${g.key}`}>
            <h5>{g.title}</h5>
            <VariableTable t={t} rows={g.rows} definition={(r) => r.description ?? g.description ?? ''} />
          </div>
        )) : <span className="admin-muted">{t('admin.assistantPage.none')}</span>}
      </section>
      {/* THE PLATFORM'S OWN VALUES, by what each describes. */}
      <section data-testid="variables-group-platform">
        <h4>{t('admin.draftCards.variableGroups.platform.title')}</h4>
        <p className="admin-field-hint">{t('admin.draftCards.variableGroups.platform.help')}</p>
        {platform.length ? platform.map((g) => (
          <div key={g.id} data-testid={`variables-group-${g.id}`}>
            <h5>{t(`admin.draftCards.variableGroups.groups.${g.id}.title`)}</h5>
            <p className="admin-field-hint">{t(`admin.draftCards.variableGroups.groups.${g.id}.help`)}</p>
            <VariableTable t={t} rows={g.rows} definition={(r) => definition(r.source)} />
          </div>
        )) : <span className="admin-muted">{t('admin.assistantPage.none')}</span>}
      </section>
    </div>
  );
};

/**
 * The areas these controls edit. The models are edited in Scope and models (`ScopeDraft` on the assistant's page),
 * beside the intent card each route belongs to.
 */
export type InlineArea = Exclude<DraftArea, 'models'>;

/** The editor for one area, by name. */
export const AreaFields: React.FC<AreaProps & { area: InlineArea }> = ({ area, ...props }) => {
  switch (area) {
    case 'identity': return <IdentityFields {...props} />;
    case 'abilities': return <AbilitiesFields {...props} />;
    case 'settings': return <GuardrailAndSources only="guardrail" config={props.draft} catalog={props.catalog} onPatch={props.onPatch} role={props.role} />;
    case 'routing': return <RoutingFields {...props} />;
    case 'messages': return <MessagesFields {...props} />;
    case 'events': return <EventWorkflowsFields config={props.draft} catalog={props.catalog} onPatch={props.onPatch} profileName={props.profileName} tools={props.tools} layout={props.layout} keptWelcome={props.keptWelcome} serverErrors={props.validationErrors} focusWorkflow={props.focusWorkflow} role={props.role} provisionedName={props.provisionedName} />;
    case 'processes': return <ProcessesFields draft={props.draft} onPatch={props.onPatch} canEdit={props.canEdit} profileName={props.draft.displayName || props.provisionedName || props.profileName} validationErrors={props.validationErrors} onOpenWorkflows={props.onOpenWorkflows}
      assistant={props.profileName} draftConfigId={props.draftConfigId} onProcessImported={props.onProcessImported} />;
    case 'variables': return <VariablesFields {...props} />;
  }
};
