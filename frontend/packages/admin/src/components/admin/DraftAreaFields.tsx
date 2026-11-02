/**
 * ONE AREA OF A DRAFT, EDITED ALONE: the controls an assistant's page and the creation wizard show in a section.
 *
 * Each area seeds its controls from the draft (the saved draft with the area's unsaved edit laid over it) and reports a patch of its own fields ONLY ONCE EDITED, so saving
 * one area never rewrites a field another area or the CLI set. The controls are the console's existing ones (the
 * welcome, the event workflow editor, the message templates, the routing rules); this file decides which belong
 * together, not how a field is edited. Which fields an area owns is `draftAreas.ts`.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from './AdminHelp';
import {
  EditPath,
  EventWorkflowsFields,
  GuardrailAndSources,
  RetiredCopyNote,
  WelcomeFields,
} from './AssistantConfigFields';
import MessageTemplatesEditor from './MessageTemplatesEditor';
import RoutingRulesEditor from './RoutingRulesEditor';
import type { DraftArea } from './draftAreas';
import type {
  ClassificationCatalog,
  FieldDecision,
  ProfileDefinitionBody,
  ProfileDraftPatch,
  ToolDescriptor,
} from '../../services/profileService';

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
  /** The errors of the draft's last Validate, which the workflow builder anchors to its steps. */
  validationErrors?: readonly string[];
  /** The workflow the builder opens on: the one the page's Edit in a draft chose. */
  focusWorkflow?: string;
}

/** WHO IT IS: the name people see and the persona it answers with. */
export const IdentityFields: React.FC<AreaProps> = ({ draft, onPatch, profileName }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [name, setName] = useState(draft.displayName ?? '');
  const [persona, setPersona] = useState(draft.persona ?? '');
  return (
    <div className="admin-form-grid">
      <label><span className="admin-field-label">{t('admin.profiles.assistantName')} <InfoTooltip label={t('admin.profiles.assistantName')} content={t('admin.profiles.field.assistantName')} /></span>
        <input type="text" className="input" data-testid="draft-name" value={name} maxLength={100}
          placeholder={t('admin.draftCards.inheritName', { name: profileName })}
          // A cleared name is sent as `null`, which inherits the provisioned name (the patch is a merge).
          onChange={(e) => { setName(e.target.value); onPatch({ displayName: e.target.value.trim() || null }); }} />
      </label>
      {/* THE PERSONA spans the grid: it is prose, often hundreds of words. NOT TRIMMED: whitespace in a prompt is the author's. */}
      <label className="profiles-persona-field"><span className="admin-field-label">{t('admin.profiles.persona')} <InfoTooltip label={t('admin.profiles.persona')} content={t('admin.profiles.field.persona')} /></span>
        <textarea data-testid="draft-persona" className={PERSONA_INPUT} value={persona}
          maxLength={MAX_PERSONA_LENGTH} rows={12} placeholder={t('admin.profiles.blankFallBackToThe')}
          onChange={(e) => { setPersona(e.target.value); onPatch({ persona: e.target.value || null }); }} />
        <span className="admin-field-hint">{t('admin.draftCards.personaLength', { chars: persona.length.toLocaleString(), max: MAX_PERSONA_LENGTH.toLocaleString() })}</span>
      </label>
    </div>
  );
};

/**
 * WHAT IT CAN DO: the tools it is offered, the guardrail on every reply and the context sources it reads. The tool
 * list changes what it is offered, not what its classification's processor role may reach.
 */
export const AbilitiesFields: React.FC<AreaProps> = ({ draft, onPatch, catalog, tools }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  // NULL RATHER THAN AN EMPTY LIST when the registry has not arrived: `[]` would mean "no tools at all".
  const [chosen, setChosen] = useState<string[] | null>(() => (draft.tools ? [...draft.tools] : (tools.length ? tools.map((x) => x.name) : null)));
  return (
    <div className="admin-form-grid">
      <div className="profiles-persona-field" data-testid="draft-tools">
        <h5>{t('admin.profiles.tools')} <InfoTooltip label={t('admin.profiles.tools')} content={t('admin.profiles.thisAssistantSToolSurface')} /></h5>
        <div className="admin-filter-group">
          {tools.map((tool) => (
            <label key={tool.name} className="admin-check" title={t('admin.profiles.needs', { description: tool.description, requires: tool.requires })}>
              <input type="checkbox" checked={(chosen ?? []).includes(tool.name)} onChange={(e) => {
                const set = new Set(chosen ?? []);
                if (e.target.checked) set.add(tool.name); else set.delete(tool.name);
                const next = [...set];
                setChosen(next);
                onPatch({ tools: next });
              }} />
              <code>{tool.name}</code>
            </label>
          ))}
        </div>
      </div>
      <GuardrailAndSources config={draft} catalog={catalog} onPatch={onPatch} />
    </div>
  );
};

/** ROUTING: the version's rules, each a condition and the model that serves a turn it holds for. */
export const RoutingFields: React.FC<AreaProps> = ({ draft, onPatch, catalog }) => {
  const [models, setModels] = useState(() => draft.models ?? {});
  return (
    <RoutingRulesEditor rules={models.routing ?? []} models={catalog?.models.text ?? []} published={catalog?.variables}
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
      published={catalog?.variables} variables={draft.variables} />
    <RetiredCopyNote config={draft} onPatch={onPatch} />
  </>
);

/** VARIABLES: edited as JSON, so this step lists them and says where and how they change (editable-or-explained). */
export const VariablesFields: React.FC<AreaProps> = ({ draft, decisions }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const entries = Object.entries(draft.variables ?? {});
  return (
    <div data-testid="draft-variables">
      {entries.length ? (
        <table className="admin-mini-table">
          <thead><tr><th>{t('admin.draftCards.variableName')}</th><th>{t('admin.draftCards.variableSource')}</th><th>{t('admin.draftCards.variableFallback')}</th></tr></thead>
          <tbody>
            {entries.map(([name, v]) => (
              <tr key={name}><td><code>{name}</code></td><td><code>{v.source}</code></td><td>{v.fallback ?? '-'}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <span className="admin-muted">{t('admin.draftCards.summary.variablesNone')}</span>}
      <EditPath field="variables" decision={decisions.variables} />
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
    case 'routing': return <RoutingFields {...props} />;
    case 'welcome': return <WelcomeFields config={props.draft} catalog={props.catalog} onPatch={props.onPatch} role={props.role} profileName={props.profileName} tools={props.tools} />;
    case 'messages': return <MessagesFields {...props} />;
    case 'events': return <EventWorkflowsFields config={props.draft} catalog={props.catalog} onPatch={props.onPatch} profileName={props.profileName} tools={props.tools} layout={props.layout} serverErrors={props.validationErrors} focusWorkflow={props.focusWorkflow} />;
    case 'variables': return <VariablesFields {...props} />;
  }
};
