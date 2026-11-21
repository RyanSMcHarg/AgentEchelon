/**
 * A VERSION'S PROCESSES (SPEC-PROCESSES P1), on the assistant's page beside Workflows.
 *
 * Each `processes` entry is a label, the workflows it links (this version's own event workflows and request-started workflows,
 * the latter keyed by the intent each runs on) and its metrics. The draft's
 * controls edit them as one area (`draftAreas.ts`), saved and activated with the version through the draft's own save and
 * activate, so the same IAM that edits the version edits its processes. An entry is checked as it is written by the
 * validator the server applies (`versionProcessesErrors`), and every refusal is said through its reason code's copy
 * (`admin.processes.errors.*`), so the console and the server refuse the same entries in the same words.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmAction } from './ConfirmAction';
import {
  MAX_VERSION_PROCESSES, versionProcessesErrors, type ProcessMetric, type VersionProcess,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { processRefusalKey } from './DraftControls';
import {
  exportProcess, importProcess, type ProcessManifest, type ProcessRefusal, type ProfileDefinitionBody, type ProfileDraftPatch,
} from '../../services/profileService';
import { draftConflictOf } from '../../services/draftConflict';
import { shippedMessageTemplates } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';
import { chainFrom, linkableOf, opensNext, phaseOf, processLayout, startedByRequest, type PhaseStage } from './processChain';
import ProcessFlow from './ProcessFlow';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** The small buttons of a metric's row, as class lists built from single names. */
const REMOVE_METRIC = ['btn-danger', 'btn-sm'].join(' ');
const ADD_METRIC = ['btn-secondary', 'btn-sm'].join(' ');
/** The process form: the console's form fields, in one column, so its groups read top to bottom. */
const PROCESS_FORM = ['admin-form-grid', 'admin-process-form'].join(' ');
/** A step of the wizard's step list, the current one and the others. */
const STEP_ON = ['btn-primary', 'btn-sm'].join(' ');
const STEP_OFF = ['btn-secondary', 'btn-sm'].join(' ');
/** A step whose phases run in parallel. */
const STEP_PARALLEL = ['admin-process-step', 'admin-process-step-parallel'].join(' ');
type Processes = Record<string, VersionProcess>;

/** The refusals among `errors` that belong to processes, in the console's words; the rest are left to their own area. */
export function processRefusals(errors: readonly string[] | undefined, t: T, under = 'processes'): string[] {
  return (errors ?? []).flatMap((e) => {
    const r = processRefusalKey(e);
    return r && (r.at === under || r.at.startsWith(`${under}.`) || r.at === 'processes') ? [t(r.key, { at: r.at })] : [];
  });
}

/** What a process manifest file is offered as, and what it is saved as. */
const MANIFEST_ACCEPT = ['application/json', '.json'].join(',');
const manifestFileName = (assistant: string, processName: string) => [assistant, processName, 'process.json'].join('-');

/**
 * EACH REFUSAL OF A PROCESS IMPORT, EXPORT OR ACTIVATION IN THE CONSOLE'S WORDS (SPEC-PROCESSES P13): its code's copy
 * (`admin.processes.errors.*`), with the names of what is missing filled in.
 */
export function processManifestRefusals(refusals: readonly ProcessRefusal[] | undefined, t: T): string[] {
  return (refusals ?? []).map((r) => t(`admin.processes.errors.${r.code}`, { ...r }));
}

/** A chosen or pasted file read as a process manifest, or null for anything else; the server checks the rest. */
export function readProcessManifestText(raw: string): ProcessManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!isRecord(parsed)) return null;
  if (parsed.kind !== 'process' || !isText(parsed.processName) || !isText(parsed.ownerProfileName) || !isRecord(parsed.process)) return null;
  return parsed as unknown as ProcessManifest;
}

/** Export: one process downloaded as its own manifest, from the draft or the active version. */
const ExportProcess: React.FC<{ assistant: string; processName: string; label: string; draft?: boolean }> = ({ assistant, processName, label, draft }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const manifest = await exportProcess(assistant, processName, draft);
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = manifestFileName(assistant, processName);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const refusals = (err as { body?: { refusals?: ProcessRefusal[] } }).body?.refusals;
      setError(refusals?.length ? processManifestRefusals(refusals, t).join(' ') : t('admin.processes.portable.exportFailed', { reason: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn-link" data-testid={`process-export-${processName}`} disabled={busy}
        aria-label={t('admin.processes.portable.exportAria', { label })} onClick={() => { void download(); }}>
        {t(busy ? 'admin.processes.portable.exporting' : 'admin.processes.portable.export')}
      </button>
      {error && <span className="admin-error" role="alert" data-testid={`process-export-refused-${processName}`}>{error}</span>}
    </>
  );
};

/**
 * IMPORT A PROCESS INTO THIS ASSISTANT'S DRAFT (SPEC-PROCESSES P13): a manifest file, or its JSON pasted. The server checks
 * what the process needs against this deployment and lands it in the draft, never the active version; a refusal is said here
 * code by code, and nothing is written. The import names the draft it adds to, so a draft saved since is kept.
 */
export const ImportProcess: React.FC<{
  assistant: string;
  /** The configId of the draft the process is added to, as the page read it. */
  draftConfigId?: string;
  disabled?: boolean;
  /** Called once the server landed the process (true) or kept a newer draft (false), so the page reads the draft again. */
  onImported?: (landed: boolean) => void | Promise<void>;
}> = ({ assistant, draftConfigId, disabled, onImported }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; reasons: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manifest = text.trim() ? readProcessManifestText(text) : null;

  const choose = (file: File) => {
    setRefusal(null);
    setNotice(null);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const confirm = async () => {
    if (!manifest) {
      setRefusal({ message: t('admin.processes.portable.notManifest'), reasons: [] });
      return;
    }
    setBusy(true);
    setRefusal(null);
    setNotice(null);
    try {
      const r = await importProcess(manifest, draftConfigId, assistant);
      setText('');
      setNotice(t('admin.processes.portable.landed', { process: r.imported, label: manifest.process.label }));
      await onImported?.(true);
    } catch (err) {
      if (draftConflictOf(err)) {
        setRefusal({ message: t('admin.processes.portable.draftChanged'), reasons: [] });
        await onImported?.(false);
        return;
      }
      const body = (err as { body?: { refusals?: ProcessRefusal[]; errors?: unknown } }).body;
      const errors = Array.isArray(body?.errors) ? body!.errors.filter((e): e is string => typeof e === 'string') : [];
      const reasons = [...processManifestRefusals(body?.refusals, t), ...processRefusals(errors, t)];
      setRefusal({ message: reasons.length ? t('admin.processes.portable.refused') : t('admin.processes.portable.failed', { reason: (err as Error).message }), reasons });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-process-form-group" aria-labelledby="process-import-title" data-testid="process-import">
      <h5 id="process-import-title">{t('admin.processes.portable.importTitle')}</h5>
      <p className="admin-field-hint">{t('admin.processes.portable.importHelp')}</p>
      <div className="admin-config-actions">
        <label className="btn-secondary">
          {t('admin.processes.portable.choose')}
          <input type="file" data-testid="process-import-file" hidden accept={MANIFEST_ACCEPT} disabled={disabled || busy}
            aria-label={t('admin.processes.portable.choose')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); e.target.value = ''; }} />
        </label>
      </div>
      <label>
        <span className="admin-field-label">{t('admin.processes.portable.paste')}</span>
        <textarea className="input" rows={4} data-testid="process-import-text" value={text} disabled={disabled || busy}
          onChange={(e) => { setText(e.target.value); setRefusal(null); setNotice(null); }} />
      </label>
      {manifest && (
        <p className="admin-field-hint" data-testid="process-import-preview">
          {t('admin.processes.portable.preview', { label: manifest.process.label, process: manifest.processName, owner: manifest.ownerProfileName })}
        </p>
      )}
      {refusal && (
        <div className="admin-error" role="alert" data-testid="process-import-refused">
          <span>{refusal.message}</span>
          {refusal.reasons.length > 0 && <ul>{refusal.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
      {notice && <div className="admin-info-banner" role="status" data-testid="process-import-landed"><span>{notice}</span></div>}
      <div className="admin-config-actions">
        <button type="button" className="btn-primary" data-testid="process-import-confirm" disabled={disabled || busy || !text.trim()} onClick={() => { void confirm(); }}>
          {t(busy ? 'admin.processes.portable.importing' : 'admin.processes.portable.confirm')}
        </button>
      </div>
    </section>
  );
};

/** One entry as the form holds it: the name it is saved under (fixed once saved) and the entry. */
/** The wizard's step: 0 what starts it, 1 name and owner, 2 phases and hand-offs, 3 metrics and review. */
interface Editing { saved: string | null; name: string; entry: VersionProcess; step: number }

const blankMetric = (workflow: string): ProcessMetric => ({ id: '', label: '', workflow });

/** A metric with its optional fields left out where empty, so the entry says only what was chosen. */
function cleanMetric(m: ProcessMetric): ProcessMetric {
  return {
    id: m.id.trim(), label: m.label, workflow: m.workflow,
    ...(m.step ? { step: m.step } : {}),
    ...(m.outcome?.trim() ? { outcome: m.outcome.trim() } : {}),
    ...(m.within?.trim() ? { within: m.within.trim() } : {}),
    ...(m.target !== undefined && !Number.isNaN(m.target) ? { target: m.target } : {}),
  };
}

function cleanEntry(p: VersionProcess): VersionProcess {
  return { label: p.label, ...(p.description?.trim() ? { description: p.description.trim() } : {}), workflows: p.workflows, ...(p.metrics?.length ? { metrics: p.metrics.map(cleanMetric) } : {}) };
}

/** The version's processes as read: each label, its name, the workflows it links and its metrics. */
export const ProcessList: React.FC<{
  processes: Processes | undefined;
  name: string;
  /** Edit and Remove for each entry, where the reader may edit the draft. */
  actions?: (processName: string) => React.ReactNode;
  /** The version's linkable workflows (`linkableOf`), from which each process's flow is read; without them no flow is offered. */
  workflows?: Record<string, unknown>;
  /** Opens the version's Workflows section, from a stage of a flow. */
  onOpenWorkflows?: () => void;
  /** The assistant's profile name: given, each entry offers Export, of the draft where `draft` is set, else of the active version. */
  assistant?: string;
  draft?: boolean;
}> = ({ processes, name, actions, workflows, onOpenWorkflows, assistant, draft }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [flowOf, setFlowOf] = useState<string | null>(null);
  const entries = Object.entries(processes ?? {});
  if (!entries.length) return <p className="admin-muted" data-testid="processes-none">{t('admin.processes.editor.none', { name })}</p>;
  return (
    <ul className="admin-plain-list" data-testid="processes-list">
      {entries.map(([key, p]) => (
        <li key={key} data-testid={`process-entry-${key}`}>
          <strong>{p.label}</strong> <code>{key}</code>
          <div className="admin-field-hint">
            {t('admin.processes.editor.links', { workflows: (p.workflows ?? []).join(', ') })}
            {' · '}
            {t('admin.processes.editor.metricCount', { count: p.metrics?.length ?? 0 })}
          </div>
          {p.metrics?.length ? (
            <ul className="admin-plain-list" data-testid={`process-metrics-${key}`}>
              {p.metrics.map((m) => (
                <li key={m.id} className="admin-field-hint">
                  {m.label} <code>{[m.workflow, m.step, m.outcome, m.within].filter(Boolean).join(' / ')}</code>
                  {m.target !== undefined && <> {t('admin.processes.editor.targetShown', { target: Math.round(m.target * 100) })}</>}
                </li>
              ))}
            </ul>
          ) : null}
          {workflows && (
            <button type="button" className="btn-link" aria-expanded={flowOf === key} data-testid={`process-flow-toggle-${key}`}
              onClick={() => setFlowOf(flowOf === key ? null : key)}>
              {flowOf === key ? t('admin.processes.flowView.hide') : t('admin.processes.flowView.show')}
            </button>
          )}
          {workflows && flowOf === key && <ProcessFlow workflows={workflows} process={p} onOpenWorkflows={onOpenWorkflows} />}
          {/* ONE ROW OF ACTIONS: the edits at its start, Export alone at its far end, so a press meant for Edit never downloads. */}
          {(assistant || actions) && (
            <div className="admin-process-actions" data-testid={`process-actions-${key}`}>
              {actions?.(key)}
              {assistant && <span className="admin-process-export"><ExportProcess assistant={assistant} processName={key} label={p.label || key} draft={draft} /></span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};

/**
 * THE PROCESSES AREA'S CONTROLS: the list, and one entry's form at a time. A finished entry goes into the area's patch,
 * which the page's Save writes to the draft; nothing is sent from here.
 */
export const ProcessesFields: React.FC<{
  draft: ProfileDefinitionBody;
  onPatch: (patch: ProfileDraftPatch) => void;
  canEdit: boolean;
  profileName: string;
  /** The errors of the draft's last Validate or activation, whose process refusals are said here too. */
  validationErrors?: readonly string[];
  /** Opens the version's Workflows section, where a new workflow is created. */
  onOpenWorkflows?: () => void;
  /** The assistant's profile name, which Export and Import process name; without it neither is offered. */
  assistant?: string;
  /** The configId of the draft shown, which an imported process is added to. */
  draftConfigId?: string;
  /** Called once an imported process landed in the draft, or a newer draft was kept, so the page reads the draft again. */
  onProcessImported?: (landed: boolean) => void | Promise<void>;
}> = ({ draft, onPatch, canEdit, profileName, validationErrors, onOpenWorkflows, assistant, draftConfigId, onProcessImported }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [processes, setProcesses] = useState<Processes>(() => ({ ...(draft.processes ?? {}) }));
  const [editing, setEditing] = useState<Editing | null>(null);
  /** The wizard's phases as a list or as a flow. */
  const [phaseView, setPhaseView] = useState<'list' | 'flow'>('list');
  // KEYBOARD FOCUS FOLLOWS THE VIEW: onto the form's heading when it opens, back onto Add process when it closes.
  const formHeading = useRef<HTMLHeadingElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (editing && !opened.current) formHeading.current?.focus();
    if (!editing && opened.current) addButton.current?.focus();
    opened.current = !!editing;
  }, [editing]);
  // EVERY WORKFLOW A PROCESS MAY LINK: the event workflows, and the request-started ones keyed by their intents (`linkableOf`).
  const intentWorkflows = (draft as { intentWorkflows?: Record<string, unknown> }).intentWorkflows;
  const own = linkableOf({ eventWorkflows: draft.eventWorkflows, intentWorkflows });
  const workflowNames = Object.keys(own);
  const eventNames = workflowNames.filter((wf) => !startedByRequest(own, wf));
  const intentNames = workflowNames.filter((wf) => startedByRequest(own, wf));
  // WHAT STARTS EACH WORKFLOW: its event, and the conversation types it runs in, read from its own definition; or a request.
  const onOf = (wf: string) => String((own[wf] as { on?: unknown } | undefined)?.on ?? '');
  const startGroups = [...new Set(eventNames.map(onOf))].map((on) => ({ on, names: eventNames.filter((wf) => onOf(wf) === on) }));
  const startsOf = (wf: string) => {
    const types = (own[wf] as { types?: unknown } | undefined)?.types;
    const rooms = Array.isArray(types) && types.length ? types.join(', ') : t('admin.eventWorkflows.roomsEvery');
    if (startedByRequest(own, wf)) return t('admin.processes.wizard.startsByRequest', { intent: wf, rooms });
    return t('admin.eventWorkflows.starts', { event: t(`admin.eventWorkflows.event.${onOf(wf)}`), rooms });
  };

  const write = (next: Processes) => {
    setProcesses(next);
    onPatch({ processes: Object.keys(next).length ? next : null });
  };

  const serverRefusals = processRefusals(validationErrors, t);

  if (editing) {
    const { entry } = editing;
    const name = editing.name.trim();
    const set = (patch: Partial<VersionProcess>) => setEditing({ ...editing, entry: { ...entry, ...patch } });
    const setMetric = (i: number, patch: Partial<ProcessMetric>) =>
      set({ metrics: (entry.metrics ?? []).map((m, j) => (j === i ? { ...m, ...patch } : m)) });
    // THE ENTRY AS IT WOULD BE SAVED, checked against the rest of the version by the server's own validator.
    const others = Object.fromEntries(Object.entries(processes).filter(([k]) => k !== editing.saved));
    const taken = editing.saved !== name && name in others;
    const refusals = [
      ...(name ? processRefusals(versionProcessesErrors({ ...others, [name]: cleanEntry(entry) }, draft.eventWorkflows, intentWorkflows), t, `processes.${name}`) : []),
      ...(!name ? [t('admin.processes.errors.PROCESS_NAME', { at: 'processes' })] : []),
      ...(taken ? [t('admin.processes.editor.nameTaken', { name })] : []),
    ];
    const done = () => {
      const next: Processes = {};
      for (const [k, v] of Object.entries(processes)) if (k !== editing.saved) next[k] = v;
      next[name] = cleanEntry(entry);
      write(next);
      setEditing(null);
    };
    const step = editing.step;
    const go = (n: number) => setEditing({ ...editing, step: n });
    const roleWords = (role: string) => {
      const [r, team] = role.split(':');
      return team ? t('admin.processes.who.person', { role: r.replace(/[-_]+/g, ' '), team }) : r.replace(/[-_]+/g, ' ');
    };
    const whoWords = (r: PhaseStage['responsible']) => (r.kind === 'person' ? (r.team ? t('admin.processes.who.person', { role: r.role, team: r.team }) : r.role)
      : r.kind === 'assistant' ? t('admin.processes.wizard.assistantRole', { role: r.role }) : t('admin.processes.who.platform'));
    const whenWords = (c: { source: string; value: string }) => (c.source === 'event:customerImpact' ? t('admin.processes.wizard.whenImpact', { value: c.value.replace(/_/g, ' ') })
      : c.source === 'task:state' ? t('admin.processes.wizard.whenCard', { value: c.value.replace(/_/g, ' ') })
        : t('admin.processes.wizard.whenOther', { source: c.source, value: c.value }));
    const toldWords = (name: string) => shippedMessageTemplates().get(name)?.entry.description ?? name;
    const remaining = workflowNames.filter((wf) => !entry.workflows.includes(wf));
    // THE PHASES IN ORDERED STEPS (`processLayout`): a step holds one phase, or several that run in parallel.
    const layout = processLayout(own, entry.workflows);
    // PHASES ARE NUMBERED IN THE ORDER THEY RUN; a group of parallel phases is named by its range.
    const runOrder = layout.steps.flatMap((st) => st.phases);
    const groupWords = (ps: string[]) => t('admin.processes.wizard.group', { count: ps.length, from: runOrder.indexOf(ps[0]) + 1, to: runOrder.indexOf(ps[ps.length - 1]) + 1 });
    const handoffs = entry.workflows.map((wf) => layout.places[wf]?.handoff);
    const STEPS = ['start', 'owner', 'phases', 'review'] as const;
    // A START OPTION: the workflow, what starts it, what it does (its stages, each with who answers it) and what it hands on to
    // (the workflows its open steps start, which choosing it adds as the next phases), all read from its own definition.
    const startOption = (wf: string, testId: string) => {
      const stages = phaseOf(own, wf).stages;
      const next = opensNext(own, wf);
      return (
        <label key={wf} className="admin-process-form-wf">
          <input type="radio" name="process-start" data-testid={testId} checked={entry.workflows[0] === wf}
            aria-label={wf} aria-describedby={`process-wf-starts-${wf} process-wf-does-${wf} process-wf-next-${wf}`} onChange={() => set({ workflows: chainFrom(own, wf) })} />
          <span>
            <code>{wf}</code>
            <span className="admin-field-hint" id={`process-wf-starts-${wf}`}>{startsOf(wf)}</span>
            <span className="admin-field-hint" id={`process-wf-does-${wf}`} data-testid={`process-wf-does-${wf}`}>
              {stages.length
                ? t('admin.processes.wizard.doesStages', { stages: stages.map((s) => t('admin.processes.wizard.stageWho', { label: s.label, who: whoWords(s.responsible) })).join(', ') })
                : t('admin.processes.wizard.doesNoStage')}
            </span>
            <span className="admin-field-hint" id={`process-wf-next-${wf}`} data-testid={`process-wf-next-${wf}`}>
              {next.length
                ? t('admin.processes.wizard.thenOpens', { opened: next.map((n) => t('admin.processes.wizard.openedIn', { workflow: n.workflow, type: n.type })).join(', ') })
                : t('admin.processes.wizard.opensNothing')}
            </span>
          </span>
        </label>
      );
    };

    const startStep = (
      <fieldset className="admin-process-form-group" data-testid="process-start">
        <legend className="admin-field-label">{t('admin.processes.wizard.startTitle')}</legend>
        <span className="admin-field-hint">{t('admin.processes.wizard.startHelp')}</span>
        {startGroups.map((g) => (
          <div key={g.on} className="admin-process-form-wfgroup" data-testid={`process-workflows-${g.on}`}>
            <span className="admin-process-form-wfhead">{t(`admin.eventWorkflows.eventShort.${g.on}`)}</span>
            {g.names.map((wf) => startOption(wf, `process-start-${wf}`))}
          </div>
        ))}
        {intentNames.length > 0 && (
          <div className="admin-process-form-wfgroup" data-testid="process-workflows-request">
            <span className="admin-process-form-wfhead">{t('admin.processes.editor.byRequest')}</span>
            <span className="admin-field-hint">{t('admin.processes.editor.byRequestHelp')}</span>
            {intentNames.map((wf) => startOption(wf, `process-workflow-request-${wf}`))}
          </div>
        )}
        {!workflowNames.length && <span className="admin-muted" data-testid="process-no-workflows">{t('admin.processes.editor.noWorkflows', { name: profileName })}</span>}
        {onOpenWorkflows && (
          <button type="button" className="btn-link" data-testid="process-create-workflow" onClick={onOpenWorkflows}>{t('admin.processes.wizard.createWorkflow')}</button>
        )}
      </fieldset>
    );

    const ownerStep = (
      <>
        <label>
          <span className="admin-field-label">{t('admin.processes.editor.name')}</span>
          {editing.saved
            ? <code data-testid="process-name-fixed">{editing.saved}</code>
            : <input type="text" className="input" data-testid="process-name" value={editing.name} maxLength={63}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}
          <span className="admin-field-hint">{t('admin.processes.editor.nameHelp')}</span>
        </label>
        <label>
          <span className="admin-field-label">{t('admin.processes.editor.label')}</span>
          <input type="text" className="input" data-testid="process-label" value={entry.label} maxLength={80}
            onChange={(e) => set({ label: e.target.value })} />
        </label>
        <label>
          <span className="admin-field-label">{t('admin.processes.editor.description')}</span>
          <textarea className="input" data-testid="process-description" value={entry.description ?? ''} maxLength={300} rows={2}
            onChange={(e) => set({ description: e.target.value || undefined })} />
          <span className="admin-field-hint">{t('admin.processes.editor.descriptionHelp')}</span>
        </label>
        <p className="admin-field-hint" data-testid="process-owner">{t('admin.processes.wizard.owner', { name: profileName })}</p>
      </>
    );

    // EACH PHASE IS ONE WORKFLOW, AND BETWEEN TWO PHASES THE HAND-OFF THEIR DEFINITIONS DECLARE: where the work goes, how, on
    // what condition, who leads it there, what it carries, whether the phase before waits, and what is told across.
    const phasesStep = (
      <div className="admin-process-phases" data-testid="process-phases">
        <p className="admin-field-hint">{t('admin.processes.wizard.phasesHelp')}</p>
        <div className="admin-process-steps" role="group" aria-label={t('admin.processes.flowView.viewAs')}>
          {(['list', 'flow'] as const).map((v) => (
            <button key={v} type="button" className={phaseView === v ? STEP_ON : STEP_OFF} aria-pressed={phaseView === v}
              data-testid={`process-view-${v}`} onClick={() => setPhaseView(v)}>{t(`admin.processes.flowView.${v}`)}</button>
          ))}
        </div>
        {phaseView === 'flow' && <ProcessFlow workflows={own} process={cleanEntry(entry)} onOpenWorkflows={onOpenWorkflows} />}
        {phaseView === 'list' && layout.steps.map((st, si) => (
        <section key={st.phases.join('|')} className={st.phases.length > 1 ? STEP_PARALLEL : 'admin-process-step'} data-testid={`process-phase-group-${si + 1}`}
          aria-label={groupWords(st.phases)}>
          {st.phases.length > 1 && <div className="admin-process-step-head"><strong>{groupWords(st.phases)}</strong></div>}
          {st.forks.map((f) => (
            <p key={f.from} className="admin-process-fork" data-testid={`process-fork-${f.from}`}>{t('admin.processes.wizard.fork', { from: f.from, to: f.to.join(', ') })}</p>
          ))}
          <div className="admin-process-step-phases">
        {st.phases.map((wf) => {
          const i = entry.workflows.indexOf(wf);
          const phase = phaseOf(own, wf);
          const place = layout.places[wf];
          const h = place?.handoff;
          const metrics = (entry.metrics ?? []).filter((m) => m.workflow === wf);
          return (
            <div key={wf} className="admin-process-step-phase">
              {i > 0 && (h ? (
                <section className="admin-process-handoff" data-testid={`process-handoff-${wf}`} aria-label={t('admin.processes.wizard.handoffTo', { workflow: wf })}>
                  <strong>{t('admin.processes.wizard.handoffTo', { workflow: wf })}</strong>
                  <dl>
                    <dt>{t('admin.processes.wizard.where')}</dt><dd>{t('admin.processes.wizard.whereValue', { type: h.type })}</dd>
                    <dt>{t('admin.processes.wizard.how')}</dt>
                    <dd>
                      {t('admin.processes.wizard.howValue', { step: h.label ?? h.step })}
                      {h.when.length > 0 && <> {t('admin.processes.wizard.when', { conditions: h.when.map(whenWords).join(t('admin.processes.wizard.or')) })}</>}
                    </dd>
                    {h.ledBy && <><dt>{t('admin.processes.wizard.ledBy')}</dt><dd>{roleWords(h.ledBy)}</dd></>}
                    <dt>{t('admin.processes.wizard.carries')}</dt><dd>{t('admin.processes.wizard.carriesValue')}</dd>
                    <dt>{t('admin.processes.wizard.waitsLabel')}</dt><dd>{h.waits ? t('admin.processes.wizard.waits', { workflow: h.from }) : t('admin.processes.wizard.alongside')}</dd>
                    {(h.toldForward.length > 0 || h.toldBack.length > 0) && (
                      <>
                        <dt>{t('admin.processes.wizard.told')}</dt>
                        <dd>
                          <ul className="admin-plain-list">
                            {h.toldForward.map((n) => <li key={`f-${n}`}>{t('admin.processes.wizard.toldForward', { what: toldWords(n) })}</li>)}
                            {h.toldBack.map((n) => <li key={`b-${n}`}>{t('admin.processes.wizard.toldBack', { what: toldWords(n) })}</li>)}
                          </ul>
                        </dd>
                      </>
                    )}
                  </dl>
                </section>
              ) : <p className="admin-info-banner" data-testid={`process-no-handoff-${wf}`}>{t('admin.processes.wizard.noHandoff', { from: entry.workflows[i - 1], to: wf })}</p>)}
              <section className="admin-process-phase" data-testid={`process-phase-${wf}`}>
                <div className="admin-process-phase-head">
                  <span>
                    <span className="admin-field-hint">{t('admin.processes.wizard.phaseN', { n: runOrder.indexOf(wf) + 1 })}</span>{' '}
                    <code>{wf}</code>
                  </span>
                  {i > 0 && (
                    <button type="button" className="btn-link" data-testid={`process-phase-remove-${wf}`}
                      onClick={() => set({ workflows: entry.workflows.filter((w) => w !== wf), metrics: (entry.metrics ?? []).filter((m) => m.workflow !== wf) })}>
                      {t('admin.processes.wizard.removePhase')}
                    </button>
                  )}
                </div>
                <p className="admin-field-hint">{startsOf(wf)}</p>
                {place?.alongsideOf && (
                  <p className="admin-process-alongside" data-testid={`process-alongside-${wf}`}>{t('admin.processes.wizard.runsAlongside', { workflow: place.alongsideOf })}</p>
                )}
                {phase.stages.length ? (
                  <ol className="admin-process-phase-stages">
                    {phase.stages.map((s) => (
                      <li key={s.step}>
                        <strong>{s.label}</strong> <span className="admin-field-hint">{whoWords(s.responsible)}{s.dueMinutes ? ` · ${t('admin.processes.wizard.due', { minutes: s.dueMinutes })}` : ''}</span>
                        {s.description && <div className="admin-field-hint">{s.description}</div>}
                      </li>
                    ))}
                  </ol>
                ) : <p className="admin-muted">{t('admin.processes.wizard.noStages')}</p>}
                {metrics.length > 0 && (
                  <p className="admin-field-hint" data-testid={`process-phase-metrics-${wf}`}>
                    {t('admin.processes.wizard.metricsOn', { metrics: metrics.map((m) => m.label || m.id).join(', ') })}
                  </p>
                )}
                {place?.joins.map((j) => (
                  <p key={j.step} className="admin-process-join" data-testid={`process-join-${wf}-${j.step}`}>
                    {t(j.when === 'any' ? 'admin.processes.wizard.joinAny' : 'admin.processes.wizard.joinAll', { stage: j.label ?? j.step, parts: j.parts.map((x) => x.words).join(', ') })}
                  </p>
                ))}
              </section>
            </div>
          );
        })}
          </div>
        </section>
        ))}
        {remaining.length > 0 && (
          <label>
            <span className="admin-field-label">{t('admin.processes.wizard.addPhase')}</span>
            <select className="select" data-testid="process-phase-add" value="" onChange={(e) => { if (e.target.value) set({ workflows: [...entry.workflows, e.target.value] }); }}>
              <option value="">{t('admin.processes.wizard.chooseWorkflow')}</option>
              {remaining.map((wf) => <option key={wf} value={wf}>{wf}</option>)}
            </select>
          </label>
        )}
      </div>
    );

    const reviewStep = (
      <>
        <dl className="admin-process-review" data-testid="process-review">
          <dt>{t('admin.processes.wizard.reviewStarts')}</dt><dd>{entry.workflows[0] ? <><code>{entry.workflows[0]}</code> {startsOf(entry.workflows[0])}</> : '—'}</dd>
          <dt>{t('admin.processes.wizard.reviewPhases')}</dt><dd>{entry.workflows.join(' → ') || '—'}</dd>
          <dt>{t('admin.processes.wizard.reviewHandoffs')}</dt><dd>{t('admin.processes.wizard.handoffCount', { count: handoffs.filter(Boolean).length })}</dd>
        </dl>
          <fieldset className="admin-process-form-group" data-testid="process-metrics">
            <legend className="admin-field-label">{t('admin.processes.editor.metrics')}</legend>
            <span className="admin-field-hint">{t('admin.processes.editor.metricsHelp')}</span>
            {(entry.metrics ?? []).map((m, i) => {
              const states = Object.keys((own[m.workflow] as { states?: Record<string, unknown> } | undefined)?.states ?? {});
              const n = i + 1;
              return (
                <div key={i} className="admin-form-grid" role="group" aria-label={t('admin.processes.editor.metricN', { n })} data-testid={`process-metric-${i}`}>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.id')}</span>
                    <input type="text" className="input" data-testid={`process-metric-${i}-id`} value={m.id} maxLength={63} onChange={(e) => setMetric(i, { id: e.target.value })} />
                  </label>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.label')}</span>
                    <input type="text" className="input" data-testid={`process-metric-${i}-label`} value={m.label} maxLength={80} onChange={(e) => setMetric(i, { label: e.target.value })} />
                  </label>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.workflow')}</span>
                    <select className="select" data-testid={`process-metric-${i}-workflow`} value={m.workflow}
                      onChange={(e) => setMetric(i, { workflow: e.target.value, step: undefined })}>
                      {!entry.workflows.includes(m.workflow) && <option value={m.workflow}>{m.workflow || t('admin.processes.editor.metric.chooseWorkflow')}</option>}
                      {entry.workflows.map((wf) => <option key={wf} value={wf}>{wf}</option>)}
                    </select>
                  </label>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.step')}</span>
                    <select className="select" data-testid={`process-metric-${i}-step`} value={m.step ?? ''}
                      onChange={(e) => setMetric(i, { step: e.target.value || undefined })}>
                      <option value="">{t('admin.processes.editor.metric.runEnd')}</option>
                      {states.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.outcome')}</span>
                    <input type="text" className="input" data-testid={`process-metric-${i}-outcome`} value={m.outcome ?? ''} maxLength={63}
                      onChange={(e) => setMetric(i, { outcome: e.target.value })} />
                  </label>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.within')}</span>
                    <input type="text" className="input" data-testid={`process-metric-${i}-within`} value={m.within ?? ''} maxLength={16}
                      onChange={(e) => setMetric(i, { within: e.target.value })} />
                    <span className="admin-field-hint">{t('admin.processes.editor.metric.withinHelp')}</span>
                  </label>
                  <label>
                    <span className="admin-field-label">{t('admin.processes.editor.metric.target')}</span>
                    <input type="number" className="input" data-testid={`process-metric-${i}-target`} min={0} max={1} step={0.05}
                      value={m.target ?? ''} onChange={(e) => setMetric(i, { target: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </label>
                  <div className="admin-config-actions">
                    <button type="button" className={REMOVE_METRIC} data-testid={`process-metric-${i}-remove`}
                      onClick={() => set({ metrics: (entry.metrics ?? []).filter((_, j) => j !== i) })}>
                      {t('admin.processes.editor.removeMetric', { n })}
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="admin-config-actions">
              <button type="button" className={ADD_METRIC} data-testid="process-metric-add" disabled={!entry.workflows.length}
                onClick={() => set({ metrics: [...(entry.metrics ?? []), blankMetric(entry.workflows[0] ?? '')] })}>
                {t('admin.processes.editor.addMetric')}
              </button>
            </div>
          </fieldset>
      </>
    );

    return (
      <section className={PROCESS_FORM} aria-labelledby="process-form-title" data-testid="process-form">
        <h4 id="process-form-title" ref={formHeading} tabIndex={-1}>{editing.saved ? t('admin.processes.editor.editTitle', { label: entry.label || editing.saved }) : t('admin.processes.editor.addTitle')}</h4>
        <nav aria-label={t('admin.processes.wizard.stepsLabel')} className="admin-process-steps" data-testid="process-steps">
          {STEPS.map((k, i) => (
            <button key={k} type="button" className={i === step ? STEP_ON : STEP_OFF} aria-current={i === step ? 'step' : undefined}
              data-testid={`process-step-${k}`} onClick={() => go(i)}>
              {t('admin.processes.wizard.stepN', { n: i + 1, name: t(`admin.processes.wizard.step.${k}`) })}
            </button>
          ))}
        </nav>
        {step === 0 ? startStep : step === 1 ? ownerStep : step === 2 ? phasesStep : reviewStep}
        {refusals.length > 0 && step === STEPS.length - 1 && (
          <div className="admin-error" role="alert" data-testid="process-refusals">
            <span>{t('admin.processes.editor.refused')}</span>
            <ul>{refusals.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        )}
        <div className="admin-config-actions">
          <button type="button" className="btn-ghost" data-testid="process-cancel" onClick={() => setEditing(null)}>{t('admin.processes.editor.cancel')}</button>
          {step > 0 && <button type="button" className="btn-secondary" data-testid="process-back" onClick={() => go(step - 1)}>{t('admin.processes.wizard.back')}</button>}
          {step < STEPS.length - 1
            ? <button type="button" className="btn-primary" data-testid="process-next" disabled={step === 0 && !entry.workflows.length} onClick={() => go(step + 1)}>{t('admin.processes.wizard.next')}</button>
            : <button type="button" className="btn-primary" data-testid="process-done" disabled={refusals.length > 0} onClick={done}>{t('admin.processes.editor.done')}</button>}
        </div>
      </section>
    );
  }

  const full = Object.keys(processes).length >= MAX_VERSION_PROCESSES;
  return (
    <div data-testid="processes-fields">
      {serverRefusals.length > 0 && (
        <div className="admin-error" role="alert" data-testid="processes-server-refusals">
          <span>{t('admin.processes.editor.refused')}</span>
          <ul>{serverRefusals.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      <ProcessList processes={processes} name={profileName} workflows={own} onOpenWorkflows={onOpenWorkflows} assistant={assistant} draft actions={canEdit ? (key) => (
        <>
          <button type="button" className="btn-link" data-testid={`process-edit-${key}`}
            aria-label={t('admin.processes.editor.editAria', { label: processes[key].label || key })}
            onClick={() => setEditing({ saved: key, name: key, step: 2, entry: { ...processes[key], workflows: [...(processes[key].workflows ?? [])] } })}>
            {t('admin.processes.editor.edit')}
          </button>
          <ConfirmAction testId={`process-remove-${key}`} className="btn-link"
            ariaLabel={t('admin.processes.editor.removeAria', { label: processes[key].label || key })}
            title={t('admin.confirm.processRemove', { label: processes[key].label || key })} confirmLabel={t('admin.confirm.remove')} cancelLabel={t('admin.confirm.cancel')}
            onConfirm={() => { const { [key]: _gone, ...rest } = processes; write(rest); }}
            label={t('admin.processes.editor.remove')} />
        </>
      ) : undefined} />
      {canEdit && (
        <div className="admin-config-actions">
          <button type="button" ref={addButton} className="btn-secondary" data-testid="process-add" disabled={full || !workflowNames.length}
            onClick={() => setEditing({ saved: null, name: '', step: 0, entry: { label: '', workflows: [] } })}>
            {t('admin.processes.editor.add')}
          </button>
          {full && <span className="admin-field-hint">{t('admin.processes.editor.full', { max: MAX_VERSION_PROCESSES })}</span>}
          {!workflowNames.length && <span className="admin-field-hint">{t('admin.processes.editor.noWorkflows', { name: profileName })}</span>}
        </div>
      )}
      {canEdit && assistant && <ImportProcess assistant={assistant} draftConfigId={draftConfigId} onImported={onProcessImported} />}
    </div>
  );
};
