/**
 * CREATING AN ASSISTANT: ONE WIZARD (ADR-048, `manage-assistants`).
 *
 * The steps are `CREATION_STEPS`. The first two are this component and make the assistant: its classification and role
 * (ones the deployment already declares), identifier, name and owning team; then its starting point and models. The
 * create builds the assistant, and the build makes its first draft. The remaining steps are the assistant's page itself
 * (`AssistantPage` with `wizard`): Behavioral, Workflows, Scope and models, Tools and context, then the page's draft
 * banner with Validate and Activate. The fields here use the page's labels and help, stacked label, help, then control,
 * and the classifier and default model are the page's own control (`ModelChoice`), so the two read alike.
 *
 * THE STARTING POINT IS THE DRAFT'S CONTENT (`starting-point.ts` on the server). The classification's defaults
 * (its intents, workflows and persona), a profile file in the export format, or a copy of another assistant's
 * active version in the same classification. The step says what the draft will hold, so nobody has to create an
 * assistant to find out which intents it got. A file is read in the browser for that summary only; the server
 * checks it against the classification before it takes the name, with the same rules an import follows, and a
 * refusal arrives with each reason.
 *
 * THE CREATE'S OWN CHOICES WIN. The name, the base model and the classifier model chosen here are written over
 * whatever the file or the copy says. The models are filled in from a file where the file names a model this
 * classification selects.
 *
 * THE MODELS OFFERED ARE THE CLASSIFICATION'S, as the server serves them with the listing
 * (`classification-catalog.ts`), so the choice is bounded by the same selection the route checks. A listing
 * that carried no catalog (a team that owns no assistant yet) falls back to the shared copy of the model
 * strategy, and the route still refuses a model the classification does not select.
 *
 * WHAT A DEPLOY DOES IS SAID BEHIND THE STEP'S HELP, NOT A FIELD. A classification or role not in the list is
 * declared in `deploy.config.json` and deployed, because it changes IAM; the route refuses one the deployment
 * does not declare.
 *
 * A team member creates for their own team only: the owner field offers only their teams, the copy offers only
 * the assistants their listing shows, and the team route refuses another team, an unowned assistant, a copy of an
 * assistant the team does not own and a classification their clearance does not reach.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEL_STRATEGY_MODELS, classificationOf } from '@ae/shared';
import { classificationSelectsModel } from '@ae/shared/config/modelStrategy.ts';
import { createAssistant, type StartingPoint } from '../../services/rosterService';
import type { ClassificationCatalog, ProfileManifest, RosterTarget } from '../../services/profileService';
import { ReasonDeclinedError } from '../../services/adminReason';
import TeamSelector, { ANY_TEAM } from './TeamSelector';
import { GuideLinks, HelpToggle, guide, guideSection } from './AdminHelp';
import { StackedField } from './AssistantConfigFields';
import { ModelChoice } from './AssistantPage';
import { readManifest, type ManifestSummary } from './ImportVersion';
import WorkflowGroups from './WorkflowGroups';
import WizardSteps from './WizardSteps';
import { creationSteps } from './assistantSections';

/** The steps this component shows: the two that make the assistant, then the wait for its build. */
type Step = 'assistant' | 'start' | 'building';
type StartKind = StartingPoint['kind'];

/** The identifier rule the route applies (`ASSISTANT_ID_PATTERN`), so a bad one is caught before a round trip. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The classifier model that follows the deployment's own classifier (`DEFAULT_MODEL` on the server). */
const PLATFORM_CLASSIFIER = 'default';

/** An assistant the copy may start from: one the listing shows with an active version. */
export interface CopySource {
  profileName: string;
  label: string;
  classification: string;
  activeVersion: number;
}

/** What a chosen profile file holds, read in the browser for the summary and the models. */
interface FileChoice {
  fileName: string;
  manifest: ProfileManifest;
  summary: ManifestSummary;
  intents: string[];
  hasWelcome: boolean;
  hasPersona: boolean;
  modelKey?: string;
  classifierModelKey?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function fileChoiceOf(fileName: string, raw: string): FileChoice | null {
  const read = readManifest(raw);
  if (!read) return null;
  const body = read.manifest.body as Record<string, unknown>;
  const pack = body.intentPack as { intents?: Array<{ key?: unknown }> } | undefined;
  const models = (body.models ?? {}) as Record<string, unknown>;
  return {
    fileName,
    ...read,
    intents: (pack?.intents ?? []).map((i) => str(i?.key)).filter((k): k is string => !!k),
    // Its own welcome is an assistant-joined workflow (W1); a manifest exported before W1 carries a retired `welcome`.
    hasWelcome: Object.values((body.eventWorkflows ?? {}) as Record<string, { on?: unknown }>).some((wf) => wf?.on === 'assistant-joined')
      || body.welcome !== undefined || body.copy !== undefined,
    hasPersona: !!str(body.persona),
    modelKey: str(models.default) ?? str(body.modelKey),
    classifierModelKey: str(models.classifier),
  };
}

interface CreateAssistantFlowProps {
  targets: RosterTarget[];
  /** The teams the owner field offers: every team for an admin, the person's own for a team member. */
  ownerTeams: readonly string[];
  /** An admin may leave an assistant unowned and creates on the admin route. */
  isAdmin: boolean;
  /** Each classification's catalog, served with the listing: its models, intents, workflows and templates. */
  catalogs?: Readonly<Record<string, ClassificationCatalog>>;
  /** The assistants a copy may start from. Absent: none. */
  copySources?: readonly CopySource[];
  /** The assistant was created; the wizard waits for its build and continues on its draft. */
  onCreated: (assistantId: string) => void;
  /** Read the listing again, which is how the wizard learns the build finished (no timer). */
  onCheckBuild?: () => void;
  onCancel: () => void;
}

const CreateAssistantFlow: React.FC<CreateAssistantFlowProps> = ({ targets, ownerTeams, isAdmin, catalogs, copySources = [], onCreated, onCheckBuild, onCancel }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('assistant');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reasons: string[] } | null>(null);
  const [form, setForm] = useState({
    classification: targets[0]?.classification ?? '',
    role: targets[0]?.roles[0] ?? '',
    start: 'defaults' as StartKind,
    copyFrom: '',
    assistantId: '',
    displayName: '',
    ownerTeam: isAdmin ? ANY_TEAM : ownerTeams[0] ?? ANY_TEAM,
    modelKey: '',
    classifierMode: 'llm' as 'llm' | 'keyword',
    classifierModelKey: PLATFORM_CLASSIFIER,
    rateLimitPerHour: '',
  });
  const [file, setFile] = useState<FileChoice | null>(null);
  const [fileRefused, setFileRefused] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const catalog = catalogs?.[form.classification];
  const roles = targets.find((tg) => tg.classification === form.classification)?.roles ?? [];
  const models = useMemo(() => {
    const served = catalog?.models.text;
    if (!served) return MODEL_STRATEGY_MODELS.filter((m) => classificationSelectsModel(classificationOf(form.classification), m.key));
    return served.map((key) => ({ key, displayName: MODEL_STRATEGY_MODELS.find((m) => m.key === key)?.displayName ?? key }));
  }, [form.classification, catalog]);
  const selectable = (key: string | undefined): key is string => !!key && models.some((m) => m.key === key);
  const sources = copySources.filter((s) => s.classification === form.classification);
  const source = sources.find((s) => s.profileName === form.copyFrom);
  const limitText = form.rateLimitPerHour.trim();
  const limit = limitText ? Number(limitText) : undefined;
  const limitValid = limit === undefined || (Number.isInteger(limit) && limit > 0);

  const id = form.assistantId.trim();
  const validAssistant = !!form.classification && roles.includes(form.role)
    && ID_PATTERN.test(id) && !id.includes('--') && !!form.displayName.trim() && (isAdmin || !!form.ownerTeam);
  const validStart = form.start === 'defaults' || (form.start === 'manifest' && !!file) || (form.start === 'copy' && !!source);
  const validModels = validStart && !!form.modelKey && limitValid;
  /** Intents decided by keyword rules, which take no classifier model. */
  const keywordRules = form.classifierMode === 'keyword';
  // While the build runs, the step it opens (the first of the draft's sections) is the current one.
  const index = step === 'assistant' ? 0 : step === 'start' ? 1 : 2;

  const chooseFile = (chosen: File) => {
    setFileRefused(false);
    setFile(null);
    const reader = new FileReader();
    reader.onload = () => {
      const read = fileChoiceOf(chosen.name, String(reader.result ?? ''));
      if (!read) {
        setFileRefused(true);
        return;
      }
      setFile(read);
      // THE MODELS START FROM THE FILE where the file names a model this classification selects.
      set({
        ...(selectable(read.modelKey) ? { modelKey: read.modelKey } : {}),
        ...(read.classifierModelKey === PLATFORM_CLASSIFIER || selectable(read.classifierModelKey) ? { classifierModelKey: read.classifierModelKey } : {}),
        ...(!form.displayName.trim() && read.summary.displayName ? { displayName: read.summary.displayName } : {}),
      });
    };
    reader.readAsText(chosen);
  };

  const startingPoint = (): StartingPoint | undefined => {
    if (form.start === 'manifest' && file) return { kind: 'manifest', manifest: file.manifest };
    if (form.start === 'copy' && source) return { kind: 'copy', from: source.profileName };
    return undefined;
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const sp = startingPoint();
      await createAssistant({
        assistantId: id,
        classification: form.classification,
        role: form.role,
        displayName: form.displayName.trim(),
        descriptor: {
          modelKey: form.modelKey,
          classifierMode: form.classifierMode,
          ...(form.classifierMode === 'llm' ? { classifierModelKey: form.classifierModelKey } : {}),
          ...(limit !== undefined ? { rateLimitPerHour: limit } : {}),
        },
        ...(form.ownerTeam ? { ownerTeam: form.ownerTeam } : {}),
        ...(sp ? { startingPoint: sp } : {}),
      }, isAdmin ? undefined : form.ownerTeam);
      setStep('building');
      onCreated(id);
    } catch (err) {
      if (err instanceof ReasonDeclinedError) return;
      const body = (err as { body?: { errors?: unknown } }).body;
      const reasons = Array.isArray(body?.errors) ? body!.errors.filter((e): e is string => typeof e === 'string') : [];
      setError({ message: (err as Error).message, reasons });
    } finally {
      setBusy(false);
    }
  };

  const modelName = (key: string) => (key === PLATFORM_CLASSIFIER
    ? t('admin.profiles.defaultFollowThePlatformClassifier')
    : models.find((m) => m.key === key)?.displayName ?? key);
  const noTargets = <p className="admin-muted">{t('admin.create.noTargets')}</p>;
  const fromFile = form.start === 'manifest';
  const startLabel = t(`admin.create.start.${fromFile ? 'file' : form.start}`);
  const steps = creationSteps(t);
  const L = {
    classification: t('admin.create.field.classification'),
    role: t('admin.create.field.role'),
    assistantId: t('admin.config.identifier'),
    displayName: t('admin.profiles.assistantName'),
    ownerTeam: t('admin.ownerControl.label'),
    classifierMode: t('admin.assistantPage.field.classifierMode'),
    classifierModel: t('admin.profiles.classifierModel'),
    defaultModel: t('admin.assistantPage.field.defaultModel'),
    turnLimit: t('admin.assistantPage.field.turnLimit'),
  };

  /** What the first draft will hold, for the step and the preview. */
  const contents = (
    <dl className="admin-config-list" data-testid="create-start-contents">
      {form.start === 'defaults' && (
        <>
          <dt>{t('admin.create.start.intents')}</dt>
          <dd data-testid="create-start-intents">{catalog?.packIntents?.length ? catalog.packIntents.join(', ') : t('admin.create.start.intentsDefault')}</dd>
          {!!catalog?.workflows?.length && <><dt>{t('admin.create.start.workflows')}</dt><dd><WorkflowGroups workflows={catalog.workflows} testId="create-workflow-groups" /></dd></>}
          {!!catalog?.templates?.length && <><dt>{t('admin.create.start.templates')}</dt><dd>{catalog.templates.map((tp) => tp.name).join(', ')}</dd></>}
          <dt>{t('admin.create.start.welcome')}</dt><dd>{t('admin.create.start.welcomePlatform')}</dd>
          <dt>{t('admin.create.start.persona')}</dt><dd>{t('admin.create.start.personaClassification')}</dd>
        </>
      )}
      {form.start === 'manifest' && file && (
        <>
          <dt>{t('admin.create.start.from')}</dt>
          <dd><code data-testid="create-start-source">{t('admin.create.start.fileFrom', { assistant: file.summary.profileName, version: file.summary.version ?? '' }).trim()}</code></dd>
          <dt>{t('admin.create.start.intents')}</dt>
          <dd data-testid="create-start-intents">{file.intents.length ? file.intents.join(', ') : t('admin.create.start.intentsNone')}</dd>
          <dt>{t('admin.create.start.welcome')}</dt><dd>{t(file.hasWelcome ? 'admin.create.start.welcomeOwn' : 'admin.create.start.welcomePlatform')}</dd>
          <dt>{t('admin.create.start.persona')}</dt><dd>{t(file.hasPersona ? 'admin.create.start.personaOwn' : 'admin.create.start.personaClassification')}</dd>
        </>
      )}
      {form.start === 'copy' && source && (
        <>
          <dt>{t('admin.create.start.from')}</dt>
          <dd data-testid="create-start-source">{t('admin.create.start.copyVersion', { assistant: source.label, version: source.activeVersion })}</dd>
        </>
      )}
    </dl>
  );

  /** THE LIVE PREVIEW: what has been chosen so far, which is what the create sends. */
  const preview = (
    <aside className="admin-wizard-preview" aria-labelledby="create-preview-title" data-testid="create-preview">
      <h5 id="create-preview-title">{t('admin.create.preview')}</h5>
      <dl className="admin-config-list" data-testid="create-review">
        <dt>{L.classification}</dt><dd>{form.classification || '-'}</dd>
        <dt>{L.role}</dt><dd>{form.role || '-'}</dd>
        <dt>{L.assistantId}</dt><dd><code>{id || '-'}</code></dd>
        <dt>{L.displayName}</dt><dd>{form.displayName.trim() || '-'}</dd>
        <dt>{L.ownerTeam}</dt><dd>{form.ownerTeam || t('admin.team.none')}</dd>
        {index > 0 && (
          <>
            <dt>{t('admin.create.review.startingPoint')}</dt><dd data-testid="create-review-start">{startLabel}</dd>
            <dt>{L.classifierMode}</dt>
            <dd>{t(form.classifierMode === 'llm' ? 'admin.create.field.classifierLlm' : 'admin.create.field.classifierKeyword')}</dd>
            {form.classifierMode === 'llm' && <><dt>{L.classifierModel}</dt><dd>{modelName(form.classifierModelKey)}</dd></>}
            <dt>{L.defaultModel}</dt><dd>{form.modelKey ? modelName(form.modelKey) : '-'}</dd>
            <dt>{L.turnLimit}</dt>
            <dd>{limit !== undefined && limitValid ? t('admin.config.rateLimitValue', { count: limit }) : t('admin.config.rateLimitNone')}</dd>
          </>
        )}
      </dl>
    </aside>
  );

  return (
    <section className="admin-config-group" aria-labelledby="create-assistant-title" data-testid="create-assistant">
      <div className="admin-edit-card-head">
        <h4 id="create-assistant-title">{t('admin.create.title')}</h4>
        <HelpToggle label={t('admin.create.helpLabel')} testId="create-help"><p>{t('admin.create.intro')}</p></HelpToggle>
      </div>
      <WizardSteps steps={steps} current={index} headingTestId="create-step-heading" />

      {error && (
        <div className="admin-error" role="alert" data-testid="create-refused">
          <span>{error.reasons.length ? t('admin.create.refused') : error.message}</span>
          {error.reasons.length > 0 && <ul>{error.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <button className="btn-secondary" onClick={() => setError(null)}>{t('admin.assistants.dismiss')}</button>
        </div>
      )}

      {step === 'building' ? (
        <div className="admin-callout" role="status" data-testid="create-building">
          <p>{t('admin.create.building', { assistant: id })}</p>
          <div className="admin-review-buttons">
            <button type="button" className="btn-ghost" onClick={onCancel}>{t('admin.create.finishLater')}</button>
            {onCheckBuild && <button type="button" className="btn-primary" onClick={onCheckBuild} data-testid="create-check-build">{t('admin.create.checkBuild')}</button>}
          </div>
        </div>
      ) : (
        <div className="admin-wizard-body">
          <div className="admin-wizard-main">
            {step === 'assistant' && (targets.length === 0 ? noTargets : (
              <>
                <div className="admin-edit-card-head">
                  <span className="admin-field-label">{t('admin.assistantPage.field.classificationRole')}</span>
                  {/* A NEW CLASSIFICATION OR ROLE IS A DEPLOY, said behind the step's help beside the choice it would widen, and not a field. */}
                  <HelpToggle label={t('admin.create.deployStep.title')} testId="create-deploy-help">
                    <div data-testid="create-deploy-step">
                      <p>{t('admin.create.deployStep.body')}</p>
                      <GuideLinks guides={[
                        guideSection(t('admin.guides.create.classification'), 'addClassification'),
                        guideSection(t('admin.guides.create.role'), 'addRole'),
                        guide(t('admin.guides.create.roleDesign'), 'roleDesign'),
                      ]} />
                    </div>
                  </HelpToggle>
                </div>
                <div className="admin-edit-step">
                  <StackedField label={L.classification} help={t('admin.create.help.classification')}>
                    {({ id: fid, describedBy }) => (
                      <select id={fid} aria-describedby={describedBy} className="select" value={form.classification}
                        onChange={(e) => set({ classification: e.target.value, role: targets.find((tg) => tg.classification === e.target.value)?.roles[0] ?? '', modelKey: '', classifierModelKey: PLATFORM_CLASSIFIER, copyFrom: '' })}>
                        {targets.map((tg) => <option key={tg.classification} value={tg.classification}>{tg.classification}</option>)}
                      </select>
                    )}
                  </StackedField>
                  <StackedField label={L.role} help={t('admin.create.help.role')}>
                    {({ id: fid, describedBy }) => (
                      <select id={fid} aria-describedby={describedBy} className="select" value={form.role} onChange={(e) => set({ role: e.target.value })}>
                        {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </StackedField>
                  <StackedField label={L.assistantId} help={t('admin.create.help.assistantId')}>
                    {({ id: fid, describedBy }) => (
                      <input id={fid} aria-describedby={describedBy} className="input" value={form.assistantId}
                        onChange={(e) => set({ assistantId: e.target.value })} placeholder={t('admin.create.field.assistantIdExample')} />
                    )}
                  </StackedField>
                  <StackedField label={L.displayName} help={t('admin.create.help.displayName')}>
                    {({ id: fid, describedBy }) => (
                      <input id={fid} aria-describedby={describedBy} className="input" value={form.displayName}
                        onChange={(e) => set({ displayName: e.target.value })} maxLength={100} />
                    )}
                  </StackedField>
                  {/* The owning team reads as the page's Owner row: its label and help above the team control. */}
                  <div className="admin-stacked-field">
                    {/* One team and no "none" is a fixed line that names itself, so the caption is not repeated. */}
                    {(isAdmin || ownerTeams.length !== 1) && <span className="admin-field-label" aria-hidden="true">{L.ownerTeam}</span>}
                    <span className="admin-field-hint">{t(isAdmin ? 'admin.create.help.ownerTeam' : 'admin.create.help.ownerTeamYours')}</span>
                    <TeamSelector teams={ownerTeams} value={form.ownerTeam} onChange={(team) => set({ ownerTeam: team })}
                      noneOption={isAdmin} label={L.ownerTeam} labelHidden testId="create-owner-team" />
                  </div>
                </div>
              </>
            ))}

            {step === 'start' && (
              <>
                <fieldset className="admin-choice-group" data-testid="create-start">
                  <legend>{t('admin.create.start.label')}</legend>
                  {(['defaults', 'manifest', 'copy'] as const).map((kind) => {
                    const label = kind === 'manifest' ? 'file' : kind;
                    return (
                      <label key={kind} className="admin-choice">
                        <input type="radio" name="create-start" value={kind} checked={form.start === kind} onChange={() => set({ start: kind })} />
                        <span>
                          <strong>{t(`admin.create.start.${label}`)}</strong>
                          <span className="admin-field-hint">{t(`admin.create.start.${label}Help`, { classification: form.classification })}</span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>

                {form.start === 'manifest' && (
                  <div className="admin-review-buttons">
                    <label className="btn-secondary">
                      {t('admin.create.start.chooseFile')}
                      <input type="file" accept="application/json,.json" hidden aria-label={t('admin.create.start.chooseFileLabel')}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) chooseFile(f); e.target.value = ''; }} />
                    </label>
                    {file && <span className="admin-muted">{t('admin.create.start.fileChosen', { file: file.fileName })}</span>}
                  </div>
                )}
                {form.start === 'manifest' && fileRefused && (
                  <div className="admin-error" role="alert" data-testid="create-file-refused"><span>{t('admin.profiles.importVersion.notManifest')}</span></div>
                )}

                {form.start === 'copy' && (sources.length === 0
                  ? <p className="admin-muted" data-testid="create-copy-none">{t('admin.create.start.copyNone', { classification: form.classification })}</p>
                  : (
                    <StackedField label={t('admin.create.start.copyFrom')} help={t('admin.create.start.copyHelp', { classification: form.classification })}>
                      {({ id: fid, describedBy }) => (
                        <select id={fid} aria-describedby={describedBy} className="select" value={form.copyFrom} onChange={(e) => set({ copyFrom: e.target.value })}>
                          <option value="">{t('admin.create.start.chooseCopy')}</option>
                          {sources.map((s) => <option key={s.profileName} value={s.profileName}>{s.label}</option>)}
                        </select>
                      )}
                    </StackedField>
                  ))}

                {validStart && (
                  <section aria-labelledby="create-start-contents-title">
                    <div className="admin-edit-card-head">
                      <h5 id="create-start-contents-title">{t('admin.create.start.contents')}</h5>
                      <HelpToggle label={t('admin.create.start.contentsHelp')} testId="create-start-help">
                        <p>{t('admin.create.start.editLater')}</p>
                        <GuideLinks guides={[guideSection(t('admin.create.start.guide'), 'portability')]} />
                      </HelpToggle>
                    </div>
                    {contents}
                    {fromFile && <p className="admin-field-hint">{t('admin.create.start.checkedAtCreate', { classification: form.classification })}</p>}
                  </section>
                )}

                {fromFile && file && <p className="admin-field-hint" data-testid="create-models-from-file">{t('admin.create.help.modelFromFile')}</p>}
                {/* Scope and models' own order: how intents are decided, the classifier, then the default model. */}
                <div className="admin-edit-step">
                  <StackedField label={L.classifierMode} help={t('admin.create.help.classifierMode')}>
                    {({ id: fid, describedBy }) => (
                      <select id={fid} aria-describedby={describedBy} className="select" value={form.classifierMode}
                        onChange={(e) => set({ classifierMode: e.target.value as 'llm' | 'keyword' })}>
                        <option value="llm">{t('admin.create.field.classifierLlm')}</option>
                        <option value="keyword">{t('admin.create.field.classifierKeyword')}</option>
                      </select>
                    )}
                  </StackedField>
                  <ModelChoice kind="classifier" value={form.classifierModelKey} disabled={keywordRules}
                    note={keywordRules ? t('admin.create.help.classifierModelKeyword') : undefined}
                    models={models.map((m) => ({ key: m.key, label: m.displayName }))} onChange={(v) => set({ classifierModelKey: v })} />
                  <ModelChoice kind="default" value={form.modelKey} placeholder={t('admin.create.field.chooseModel')}
                    models={models.map((m) => ({ key: m.key, label: m.displayName }))} onChange={(v) => set({ modelKey: v })} />
                  <StackedField label={L.turnLimit} help={t('admin.create.help.rateLimit')}>
                    {({ id: fid, describedBy }) => (
                      <input id={fid} aria-describedby={describedBy} aria-invalid={!limitValid} className="input" type="number" min={1} step={1}
                        value={form.rateLimitPerHour} onChange={(e) => set({ rateLimitPerHour: e.target.value })} />
                    )}
                  </StackedField>
                </div>
              </>
            )}
          </div>
          {preview}
        </div>
      )}

      {step !== 'building' && (
        <div className="admin-config-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>{t('admin.create.cancel')}</button>
          {step === 'start' && <button type="button" className="btn-secondary" onClick={() => setStep('assistant')} disabled={busy}>{t('admin.create.back')}</button>}
          {step === 'assistant'
            ? <button type="button" className="btn-primary" onClick={() => setStep('start')} disabled={!validAssistant}>{t('admin.create.next')}</button>
            : <button type="button" className="btn-primary" onClick={() => void create()}
              disabled={busy || !validAssistant || !validModels}>{t('admin.create.create')}</button>}
        </div>
      )}
    </section>
  );
};

export default CreateAssistantFlow;
