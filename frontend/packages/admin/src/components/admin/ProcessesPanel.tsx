import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable, { type Column } from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import { exportProfile, listProfiles } from '../../services/profileService';
import type { AnalyticsDateRange } from '@ae/shared';
import { declaredStages, endToEnd, joinWaitsOf, outcomeCopy, percentile, processShapeOf, runStages, shapeOfVersion, stageResponsible, stageSummary, stepTimesOf, type DeclaredStage, type JoinPartRef, type JoinWait, type ProcessShape, type StageRun, type StageSpan } from './processStages';
import WorkflowEditorLink from './WorkflowEditorLink';
import { useUrlViews, viewParam } from './consoleViewUrl';
import './ProcessesPanel.css';

type Row = Record<string, unknown>;
/** A metric a process declares (SPEC-PROCESSES P10), as the active version's listing carries it. */
export interface DeclaredMetric { id: string; label: string; workflow: string; step?: string; outcome?: string; within?: string; target?: number }
/** What the active versions say of a process: its label, the edition its metrics are for, and the metrics. */
export interface DeclaredProcess { label: string; description?: string; edition: string; workflows?: string[]; metrics?: DeclaredMetric[] }

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** A duration as a person reads it: seconds, minutes, hours or days. */
export function fmtDuration(v: unknown): string {
  const ms = num(v);
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** A time as the drill shows it: the date and the minute, in UTC. */
const fmtTime = (v: unknown): string => {
  const ms = num(v);
  if (ms === null) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace(/T/, ' ');
};

/** A legend swatch in a flow node's tone. */
const nodeSwatch = (tone: string): string => ['admin-process-swatch', 'admin-process-node-' + tone].join(' ');

/** A run choice's button, chosen and not. */
const PICKED = ['btn-primary', 'btn-sm'].join(' ');
const UNPICKED = ['btn-secondary', 'btn-sm'].join(' ');

/** The classes of a stage's time cell: its shade (1 to 4), none (0), or open. */
const cellClass = (shade: number | 'open'): string => `admin-process-cell admin-process-cell-${shade}`;

/** An ISO 8601 duration of days, hours and minutes (`P2D`, `PT4H`) in milliseconds, or null. */
export function durationMs(iso: string | undefined): number | null {
  const m = iso ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso) : null;
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000 : null;
}

/**
 * A DECLARED METRIC, READ PER PROCESS EDITION (SPEC-PROCESSES P10): the share of the edition's processes in which a run of the
 * metric's workflow reached its step (or its end) with its outcome, within its time from the process's start. Only processes
 * whose first run started on the edition count, so a changed metric is never applied to processes before it.
 */
export function metricShare(runs: Row[], metric: DeclaredMetric, edition: string): { share: number | null; processes: number } {
  const of = runs.filter((r) => r.process_edition === edition);
  const ids = [...new Set(of.map((r) => String(r.process_id)))];
  const within = durationMs(metric.within);
  const met = ids.filter((id) => of.some((r) => {
    if (r.process_id !== id || r.workflow !== metric.workflow || num(r.ended_at) === null) return false;
    const steps = Array.isArray(r.steps) ? (r.steps as Array<{ step: string; outcome: string }>) : [];
    // A step the run took, with its outcome; with no step named, the run's own ending. A run's end lists only the steps since
    // its last task, so a step that posted is also read from the messages it posted (`step_times`), where no outcome is named.
    const reached = metric.step
      ? steps.some((s) => s.step === metric.step && (!metric.outcome || s.outcome === metric.outcome))
        || (!metric.outcome && stepTimesOf(r as StageRun).some((s) => s.step === metric.step))
      : !metric.outcome || r.disposition === metric.outcome;
    return reached && (within === null || num(r.ended_at)! - num(r.process_started_at)! <= within);
  }));
  return { share: ids.length ? met.length / ids.length : null, processes: ids.length };
}

/** Each outcome the process's runs ended with, and the runs still open (an empty outcome), counted over the runs read. */
export function outcomeCounts(runs: Row[]): Row[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const key = num(r.ended_at) === null ? '' : String(r.disposition ?? '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([outcome, n]) => ({ outcome, runs: n }));
}

/** The width under which the view stacks each run's stages rather than laying them out as a grid. */
export const NARROW_QUERY = '(max-width: 640px)';

/** Whether the console is as narrow as a phone, kept current by the media query's own change event. */
export function useNarrow(): boolean {
  const mq = useMemo(() => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(NARROW_QUERY) : null), []);
  const [narrow, setNarrow] = useState(!!mq?.matches);
  useEffect(() => {
    if (!mq || typeof mq.addEventListener !== 'function') return undefined;
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mq]);
  return narrow;
}

/** The shade a stage's time takes in the grid: one hue, darker where longer, in four steps (under 10m, 30m, 1h, and over). */
export function timeShade(ms: number | null): 0 | 1 | 2 | 3 | 4 {
  if (ms === null) return 0;
  return ms < 10 * 60_000 ? 1 : ms < 30 * 60_000 ? 2 : ms < 60 * 60_000 ? 3 : 4;
}

/**
 * PROCESSES (SPEC-PROCESSES P9, P10). The tab lists every process the active versions declare or the window's runs belong to;
 * nothing opens until one is chosen. A process is owned by the assistant whose version declares it, so it is created and changed
 * on that assistant's page, and the list says so. One process reads as the owner declared it and as its runs went: its
 * description, its key figures, the flow of its stages (how many runs reached each, the median time, where open runs are now),
 * each stage with what it is for, what it runs and the workflow that runs it, where each run spent its time, and the time spent
 * waiting on each team. Every figure is read from the run-ended facts and the runs' messages (`process_runs`), never from what
 * was said. A team reads its own assistants' part on its team route; the platform team reads every part.
 */
const ProcessesPanel: React.FC<{
  dateRange: AnalyticsDateRange | undefined; assistant?: string | null; classification?: string | null;
  /** Opens the Assistants tab, where a process is created and changed on its owning assistant's page. */
  onOpenAssistants?: () => void;
  /** Opens a run's conversation in the Conversations tab, which applies its own access to what it shows. */
  onOpenConversation?: (channelArn: string) => void;
}> = ({ dateRange, assistant, classification, onOpenAssistants, onOpenConversation }) => {
  const { t } = useTranslation();
  const narrow = useNarrow();
  const [state, setState] = useState<{ rows: Row[] | null; unsupported: boolean; error: boolean; truncated?: boolean }>({ rows: null, unsupported: false, error: false });
  const [declared, setDeclared] = useState<Record<string, DeclaredProcess & { owner: string }>>({});
  /** Each process's shape, read from its owner's active version (null where it could not be read). */
  const [shapes, setShapes] = useState<Record<string, ProcessShape | null>>({});
  /** Each assistant's versions, from the listing: which version number a run's version (its config id) is. */
  const [versions, setVersions] = useState<Record<string, Array<{ version: number; configId: string }>>>({});
  /** The process as each version a run ran on declares it, keyed `process|configId` (null where it could not be read). */
  const [versionShapes, setVersionShapes] = useState<Record<string, ProcessShape | null>>({});
  /** Every version's runs, or one version's (its config id). */
  const [versionPick, setVersionPick] = useState<string>('all');
  /** The process opened from the list; none until a person chooses one. */
  const [selected, setSelected] = useState<string | null>(() => viewParam('process'));
  /** The flow shows every run, or one process id's. */
  const [runPick, setRunPick] = useState<string>('all');
  /** One process id opened from the runs, read by that id, with what the read returned (null while it is read). */
  const [drill, setDrill] = useState<{ id: string; rows: Row[] | null; error: boolean } | null>(() => {
    const id = viewParam('processRun');
    return id && /^[a-f0-9]{12}$/.test(id) ? { id, rows: null, error: false } : null;
  });
  // THE PROCESS AND THE PROCESS ID OPEN ARE THE ADDRESS (`?process=`, `&processRun=`): a link opens them, and Back steps out.
  useUrlViews({ process: selected, processRun: drill?.id ?? null }, (v) => {
    setSelected(v.process);
    setDrill((d) => (v.processRun && /^[a-f0-9]{12}$/.test(v.processRun) ? (d?.id === v.processRun ? d : { id: v.processRun, rows: null, error: false }) : null));
  });
  /** The window's first read keeps a process id a link opened; a later change of the window closes it. */
  const firstRead = useRef(true);
  const drillHeading = useRef<HTMLHeadingElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  /**
   * EACH VERSION IS EXPORTED ONCE, however many processes or runs name it: by its owner and its version (the active one where
   * none is named), shared by every reader while the listing stands. A read that fails is forgotten, so the next look asks again.
   */
  const exports = useRef(new Map<string, Promise<unknown>>());
  const exportOnce = useCallback((owner: string, version?: number): Promise<unknown> => {
    const key = `${owner}|${version ?? 'active'}`;
    const held = exports.current.get(key);
    if (held) return held;
    const read = (version === undefined ? exportProfile(owner) : exportProfile(owner, version))
      .catch((err: unknown) => { exports.current.delete(key); throw err; });
    exports.current.set(key, read);
    return read;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ rows: null, unsupported: false, error: false });
    if (firstRead.current) firstRead.current = false; else setDrill(null);
    const extra: Record<string, string> = {};
    if (assistant) extra.agentType = assistant;
    if (classification) extra.conversationClassification = classification;
    Promise.resolve().then(() => queryAnalytics('process_runs', dateRange, extra))
      .then((res) => { if (!cancelled) setState({ rows: (res?.data ?? []) as Row[], unsupported: !!res?.unsupported, error: false, truncated: res?.truncated === true }); })
      .catch(() => { if (!cancelled) setState({ rows: [], unsupported: false, error: true }); });
    // WHAT EACH ACTIVE VERSION DECLARES, and which assistant owns each process, from the versions' listing. A listing this reader
    // cannot read lists only the processes the window's runs name, and their stages under their steps' own names.
    listProfiles().then((ps) => {
      if (cancelled) return;
      // A NEW LISTING MAY NAME A NEWLY ACTIVE VERSION, so the exports are read again from here.
      exports.current.clear();
      const out: Record<string, DeclaredProcess & { owner: string }> = {};
      for (const p of ps) {
        for (const [name, d] of Object.entries((p as { activeProcesses?: Record<string, DeclaredProcess> }).activeProcesses ?? {})) out[name] = { ...d, owner: p.profileName };
      }
      setDeclared(out);
      setVersions(Object.fromEntries(ps.map((p) => [p.profileName, ((p as { versions?: Array<{ version: number; configId: string }> }).versions ?? []).map((v) => ({ version: v.version, configId: v.configId }))])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification]);

  // ONE PROCESS ID, read by that id (`processId`), so the window's run list cannot cut any of its runs.
  const drillId = drill?.id ?? null;
  useEffect(() => {
    if (!drillId) return undefined;
    let cancelled = false;
    drillHeading.current?.focus();
    const extra: Record<string, string> = { processId: drillId };
    if (assistant) extra.agentType = assistant;
    if (classification) extra.conversationClassification = classification;
    Promise.resolve().then(() => queryAnalytics('process_runs', dateRange, extra))
      .then((res) => { if (!cancelled) setDrill({ id: drillId, rows: (res?.data ?? []) as Row[], error: false }); })
      .catch(() => { if (!cancelled) setDrill({ id: drillId, rows: [], error: true }); });
    return () => { cancelled = true; };
  }, [drillId, dateRange, assistant, classification]);

  const rows = state.rows ?? [];
  const of = (d: string) => rows.filter((r) => r.dimension === d);
  const processRows = of('process');
  // EVERY PROCESS: those the versions declare, whether or not they ran in the window, then any the runs name that none declares.
  const names = [...new Set([...Object.keys(declared), ...processRows.map((p) => String(p.process ?? ''))].filter(Boolean))];
  const current = selected && names.includes(selected) ? selected : null;
  const shownProcess = drill ? String((drill.rows ?? []).find((r) => r.dimension === 'run')?.process ?? current ?? '') : current ?? '';
  useEffect(() => { setRunPick('all'); setVersionPick('all'); if (current) detailHeading.current?.focus(); }, [current]);

  // THE STAGES' NAMES, DESCRIPTIONS AND ORDER, from the owner's active version: its workflows and the labels their steps declare.
  // THE OWNER: the assistant whose active version declares the process, else the one whose versions include the version its
  // runs ran on, so a process the active version no longer declares is still read as its runs ran.
  const allRuns = of('run').filter((r) => r.process === (current ?? shownProcess));
  const ownerOfVersion = (configId: unknown) => Object.entries(versions).find(([, vs]) => vs.some((v) => v.configId === configId))?.[0];
  const owner = declared[shownProcess]?.owner ?? allRuns.map((r) => ownerOfVersion(r.origin_config_id)).find(Boolean);
  const versionOf = (configId: unknown) => (owner ? versions[owner]?.find((v) => v.configId === configId)?.version : undefined);
  // THE WORKFLOWS THE PROCESS LINKS, for a version that does not declare it: as the active version declares them, else in the
  // order its runs first started them.
  const knownWorkflows = declared[shownProcess]?.workflows?.length ? declared[shownProcess]!.workflows! : [...new Map([...allRuns].sort((a, b) => (num(a.started_at) ?? 0) - (num(b.started_at) ?? 0)).map((r) => [String(r.workflow), true])).keys()];
  const runVersions = [...new Set(allRuns.map((r) => String(r.origin_config_id ?? '')).filter(Boolean))];
  useEffect(() => {
    if (!owner || !shownProcess) return undefined;
    const missing = runVersions.filter((c) => !(`${shownProcess}|${c}` in versionShapes) && versionOf(c) !== undefined);
    if (!missing.length) return undefined;
    let cancelled = false;
    for (const c of missing) {
      exportOnce(owner, versionOf(c))
        .then((m) => { if (!cancelled) setVersionShapes((v) => ({ ...v, [`${shownProcess}|${c}`]: shapeOfVersion((m as { body?: unknown }).body, shownProcess, knownWorkflows) })); })
        .catch(() => { if (!cancelled) setVersionShapes((v) => ({ ...v, [`${shownProcess}|${c}`]: null })); });
    }
    return () => { cancelled = true; };
  }, [owner, shownProcess, runVersions.join(','), versionOf, versionShapes]);
  useEffect(() => {
    if (!owner || !shownProcess || shownProcess in shapes) return undefined;
    let cancelled = false;
    exportOnce(owner)
      .then((m) => { if (!cancelled) setShapes((s) => ({ ...s, [shownProcess]: processShapeOf((m as { body?: unknown }).body, shownProcess) })); })
      .catch(() => { if (!cancelled) setShapes((s) => ({ ...s, [shownProcess]: null })); });
    return () => { cancelled = true; };
  }, [owner, shownProcess, shapes]);
  const shape = shapes[shownProcess] ?? null;

  const rowOf = (p: string) => processRows.find((r) => r.process === p);
  // EACH RUN READ AGAINST THE VERSION IT RAN ON, and a process's version is its first run's.
  const runShape = (r: Row): ProcessShape | null => versionShapes[`${current ?? shownProcess}|${String(r.origin_config_id ?? '')}`] ?? shape;
  const firstRunOf = new Map<string, Row>();
  for (const r of allRuns) { const k = String(r.process_id); const f = firstRunOf.get(k); if (!f || (num(r.started_at) ?? 0) < (num(f.started_at) ?? 0)) firstRunOf.set(k, r); }
  const processVersion = (id: unknown) => String(firstRunOf.get(String(id))?.origin_config_id ?? '');
  const runs = versionPick === 'all' ? allRuns : allRuns.filter((r) => processVersion(r.process_id) === versionPick);
  const pct = (a: unknown, b: unknown) => (num(b) ? `${Math.round(((num(a) ?? 0) / num(b)!) * 100)}%` : '—');
  const label = (p: unknown) => declared[String(p)]?.label ?? String(p ?? '—');
  const shortId = (v: unknown) => String(v ?? '').slice(0, 6);
  const sayOutcome = (o: unknown) => { const c = outcomeCopy(String(o ?? '')); return t(c.key, c.values); };
  // A JOIN, IN WORDS: the part it waited on last (an opened conversation by its type, a task by its stage), or its deadline.
  const partWords = (part: JoinPartRef) => (part.kind === 'open' && part.type ? t('admin.processes.join.partOpen', { type: part.type }) : part.label ?? part.step);
  const joinSaid = (j: JoinWait) => (j.waitedFor ? t('admin.processes.join.waitedFor', { part: partWords(j.waitedFor) }) : t('admin.processes.join.deadline'));
  const runOutcome = (r: Row) => (num(r.ended_at) === null ? t('admin.processes.open') : sayOutcome(r.disposition));
  const table = (data: Row[], columns: Column<Row>[], testId: string, empty = 'admin.processes.empty') => (data.length ? <div data-testid={testId}><DataTable data={data} columns={columns} /></div> : <p className="admin-tab-empty">{t(empty)}</p>);

  // ── THE LIST ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const listRows: Row[] = names.map((n) => {
    const r = rowOf(n);
    return { process: n, owner: declared[n]?.owner ?? null, workflows: declared[n]?.workflows?.length ?? null, runs: num(r?.runs) ?? 0, ended: num(r?.ended) ?? 0, succeeded: num(r?.succeeded) ?? 0, p50_ms: r?.p50_ms ?? null, p95_ms: r?.p95_ms ?? null };
  });
  const listColumns: Column<Row>[] = [
    { key: 'process', label: t('admin.processes.column.process'), render: (v) => <button type="button" className="btn-link" data-testid={`process-pick-${String(v)}`} onClick={() => { setDrill(null); setSelected(String(v)); }}>{label(v)}</button> },
    { key: 'owner', label: t('admin.processes.column.owner'), render: (v) => String(v ?? '—') },
    { key: 'workflows', label: t('admin.processes.column.workflows'), render: (v) => (num(v) === null ? '—' : String(v)) },
    { key: 'runs', label: t('admin.processes.column.started'), sortable: true },
    { key: 'ended', label: t('admin.processes.column.ended'), sortable: true },
    { key: 'succeeded', label: t('admin.processes.column.success'), render: (v, r) => pct(v, r.ended) },
    { key: 'p50_ms', label: t('admin.processes.column.endToEnd'), render: (v, r) => (num(v) === null ? '—' : `${fmtDuration(v)} / ${fmtDuration(r.p95_ms)}`) },
  ];
  const ownerNote = (
    <p className="admin-info-banner" data-testid="processes-owner-note">
      {t('admin.processes.ownerNote')}{' '}
      {onOpenAssistants && <button type="button" className="btn-link" data-testid="processes-open-assistants" onClick={onOpenAssistants}>{t('admin.processes.openAssistants')}</button>}
    </p>
  );

  // ── ONE PROCESS ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const summary = stageSummary(runs, (r) => runShape(r as Row));
  const byProcess = new Map<string, Row[]>();
  for (const r of runs) byProcess.set(String(r.process_id), [...(byProcess.get(String(r.process_id)) ?? []), r]);
  const startOf = (rs: Row[]) => Math.min(...rs.map((r) => num(r.started_at) ?? Infinity));
  const processIds = [...byProcess.keys()].sort((a, b) => startOf(byProcess.get(b)!) - startOf(byProcess.get(a)!));
  const spansOf = (rs: Row[]) => rs.flatMap((r) => runStages(r, runShape(r)));
  const spanFor = (spans: StageSpan[], s: { workflow: string; step: string }) => spans.find((x) => x.workflow === s.workflow && x.step === s.step);

  // EVERY STAGE THE PROCESS DECLARES, reached or not: its workflows in the process's order, each one's stages as its version
  // declares them. With no version read, the stages its runs took, in run order.
  // THE STAGES SHOWN: the chosen version's, else the active version's, else the newest version its runs ran on.
  const newestVersion = [...runVersions].sort((a, b) => (versionOf(b) ?? 0) - (versionOf(a) ?? 0))[0];
  const displayShape = versionPick !== 'all' ? (versionShapes[`${current}|${versionPick}`] ?? shape) : (shape ?? (newestVersion ? versionShapes[`${current}|${newestVersion}`] ?? null : null));
  const declaredList = declaredStages(displayShape);
  const stages: DeclaredStage[] = declaredList.length ? declaredList : summary.map((s) => ({ workflow: s.workflow, step: s.step, label: s.label }));
  const summaryOf = (s: DeclaredStage) => summary.find((x) => x.workflow === s.workflow && x.step === s.step);
  const openHere = (s: DeclaredStage) => processIds.filter((id) => spanFor(spansOf(byProcess.get(id)!), s)?.end === null).length;

  // WHO ANSWERED EACH STAGE AND WHAT IT COST, from the runs' own step records (`step_costs`): the assistant that posted it, and its
  // model spend per run that reached it, priced on the server from the one rate table.
  type StepCost = { step: string; assistant: string | null; usd: number | null; unpriced?: number };
  const costsOf = (r: Row): StepCost[] => (Array.isArray(r.step_costs) ? r.step_costs as StepCost[] : []);
  const stageUsage = (s: DeclaredStage) => {
    const costs = runs.filter((r) => r.workflow === s.workflow).flatMap((r) => costsOf(r).filter((c) => c.step === s.step));
    const priced = costs.filter((c) => c.usd !== null);
    return { assistant: costs.find((c) => c.assistant)?.assistant ?? null, usd: priced.length ? priced.reduce((a, c) => a + c.usd!, 0) / priced.length : null };
  };
  // FROM A PROCESS DOWN TO ITS WORKFLOWS AND CONVERSATIONS: each run names the assistant whose workflow it is (its run key) and
  // the conversation it ran in, so a workflow opens in that assistant's editor and a run opens where it ran.
  const runAssistant = (r: Row | undefined): string | undefined => String(r?.assistant ?? '') || owner;
  const wfAssistant = (wf: string): string | undefined => runAssistant(allRuns.find((r) => r.workflow === wf));
  const runLinks = (r: Row, testId: string) => (
    <span className="admin-process-run-links">
      <WorkflowEditorLink assistant={runAssistant(r)} workflow={String(r.workflow ?? '')} testId={`${testId}-workflow`}><code>{String(r.workflow ?? '—')}</code></WorkflowEditorLink>
      {onOpenConversation && typeof r.channel_arn === 'string' && r.channel_arn && (
        <>{' '}<button type="button" className="btn-link" data-testid={`${testId}-conversation`} onClick={() => onOpenConversation(String(r.channel_arn))}>{t('admin.processes.openConversation')}</button></>
      )}
    </span>
  );
  // THE SPEND OF STEPS NO STAGE SHOWS (an unlabeled step's turns), per process on average, so the stages and this line add up
  // to the cost per process. Null where no such step was priced.
  const otherSpend = (() => {
    const labeled = new Set(stages.map((st) => st.workflow + '|' + st.step));
    const per = processIds.map((id) => byProcess.get(id)!.flatMap((r) => costsOf(r).filter((c) => c.usd !== null && !labeled.has(String(r.workflow) + '|' + c.step)).map((c) => c.usd!)));
    const any = per.some((xs) => xs.length);
    return any ? per.reduce((a, xs) => a + xs.reduce((b, v) => b + v, 0), 0) / processIds.length : null;
  })();
  const teamOf = (wf: string) => (String(runs.find((r) => r.workflow === wf)?.owner_team ?? '') || null);
  // THE TEAM OR ASSISTANT ANSWERABLE FOR A STAGE, in words: the assistant that answered it and its team, a person's role and
  // team, or the platform; the process's owner team stays answerable for the whole.
  const who = (s: DeclaredStage) => {
    const r = stageResponsible(s.def);
    const team = teamOf(s.workflow) ?? '—';
    if (r.kind === 'assistant') return t('admin.processes.who.assistant', { name: stageUsage(s).assistant ?? r.role });
    if (r.kind === 'person') return t('admin.processes.who.person', { role: r.role, team: r.team ?? team });
    return t('admin.processes.who.platform');
  };
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const fmtUsd = (v: number | null) => (v === null ? '—' : money.format(v));


  // THE KEY FIGURES OF THE PROCESSES SHOWN (every version, or the one chosen), from their own runs.
  const figuresOf = (ids: string[]) => {
    const e2es = ids.map((id) => endToEnd(byProcess.get(id)!));
    const ended = ids.filter((_, i) => e2es[i].ms !== null);
    const succeeded = ended.filter((id) => byProcess.get(id)!.every((r) => r.disposition === 'success'));
    const times = e2es.map((e) => e.ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
    // A PROCESS'S COST IS EVERY PRICED TURN OF EVERY ONE OF ITS RUNS, its unlabeled steps' turns included. A process with no
    // priced turn has no cost, never a cost of nothing, and one whose model the rate table cannot price says so.
    const totals = ids.map((id) => {
      const cs = byProcess.get(id)!.flatMap(costsOf);
      const priced = cs.filter((c) => c.usd !== null);
      return { usd: priced.length ? priced.reduce((a, c) => a + c.usd!, 0) : null, unpriced: cs.some((c) => (c.unpriced ?? 0) > 0) };
    });
    const priced = totals.filter((c) => c.usd !== null).map((c) => c.usd!);
    return {
      started: ids.length, ended: ended.length, succeeded: succeeded.length, p50: percentile(times, 0.5), p95: percentile(times, 0.95),
      usd: priced.length ? priced.reduce((a, v) => a + v, 0) / priced.length : null, unpriced: totals.some((c) => c.unpriced),
    };
  };
  const fig = figuresOf(processIds);
  const kpis = [
    { key: 'started', label: t('admin.processes.kpi.started'), value: String(fig.started), note: '' },
    { key: 'succeeded', label: t('admin.processes.kpi.succeeded'), value: String(fig.succeeded), note: t('admin.processes.kpi.ofEnded', { share: pct(fig.succeeded, fig.ended), ended: fig.ended }) },
    { key: 'open', label: t('admin.processes.kpi.open'), value: String(Math.max(0, fig.started - fig.ended)), note: '' },
    { key: 'e2e', label: t('admin.processes.kpi.endToEnd'), value: fmtDuration(fig.p50), note: t('admin.processes.kpi.p95', { time: fmtDuration(fig.p95) }) },
    {
      key: 'cost', label: t('admin.processes.kpi.cost'), value: fig.usd === null && fig.unpriced ? t('admin.processes.kpi.unpriced') : fmtUsd(fig.usd),
      note: fig.unpriced && fig.usd !== null ? t('admin.processes.kpi.partlyPriced') : t('admin.processes.kpi.costNote'),
    },
  ];

  // THE VERSIONS ITS RUNS RAN ON, newest first, to choose one or to compare them side by side.
  const versionLabel = (c: string) => (versionOf(c) !== undefined ? t('admin.processes.versions.v', { n: versionOf(c) }) : t('admin.processes.versions.unknown'));
  const shownVersions = [...runVersions].sort((a, b) => (versionOf(b) ?? 0) - (versionOf(a) ?? 0));
  const versionPicks = shownVersions.length > 1 || versionPick !== 'all' ? (
    <div className="admin-process-picks" role="group" aria-label={t('admin.processes.versions.pick')} data-testid="process-version-picks">
      <button type="button" className={versionPick === 'all' ? PICKED : UNPICKED} aria-pressed={versionPick === 'all'} onClick={() => { setVersionPick('all'); setRunPick('all'); }}>{t('admin.processes.versions.all')}</button>
      {shownVersions.map((c) => (
        <button key={c} type="button" data-testid={`process-version-pick-${c}`} className={versionPick === c ? PICKED : UNPICKED} aria-pressed={versionPick === c} onClick={() => { setVersionPick(c); setRunPick('all'); }}>{versionLabel(c)}</button>
      ))}
    </div>
  ) : null;
  // VERSIONS COMPARED: each version's processes beside the others', so an edit's effect reads stage by stage.
  const compared = shownVersions.slice(0, 4);
  const idsOfVersion = (c: string) => [...new Set(allRuns.map((r) => String(r.process_id)))].filter((id) => processVersion(id) === c);
  const compareTable = compared.length > 1 ? (() => {
    const allById = new Map<string, Row[]>();
    for (const r of allRuns) allById.set(String(r.process_id), [...(allById.get(String(r.process_id)) ?? []), r]);
    const figOf = (c: string) => {
      const ids = idsOfVersion(c);
      const e2es = ids.map((id) => endToEnd(allById.get(id)!));
      const ended = ids.filter((_, i) => e2es[i].ms !== null);
      const succeeded = ended.filter((id) => allById.get(id)!.every((r) => r.disposition === 'success'));
      const times = e2es.map((e) => e.ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
      const costs = ids.map((id) => allById.get(id)!.flatMap(costsOf).filter((x) => x.usd !== null).reduce((a, x) => a + x.usd!, 0));
      const stageMs = (st: DeclaredStage) => {
        const xs = ids.map((id) => allById.get(id)!.flatMap((r) => runStages(r, runShape(r))).find((x) => x.workflow === st.workflow && x.step === st.step)?.ms).filter((v): v is number => v != null).sort((a, b) => a - b);
        return percentile(xs, 0.5);
      };
      return { ids, ended, succeeded, p50: percentile(times, 0.5), usd: costs.length ? costs.reduce((a, v) => a + v, 0) / costs.length : null, stageMs };
    };
    const figs = compared.map(figOf);
    const rowsOf: Array<{ key: string; label: string; cells: string[] }> = [
      { key: 'processes', label: t('admin.processes.kpi.started'), cells: figs.map((f) => String(f.ids.length)) },
      { key: 'succeeded', label: t('admin.processes.kpi.succeeded'), cells: figs.map((f) => pct(f.succeeded.length, f.ended.length)) },
      { key: 'e2e', label: t('admin.processes.kpi.endToEnd'), cells: figs.map((f) => fmtDuration(f.p50)) },
      { key: 'cost', label: t('admin.processes.kpi.cost'), cells: figs.map((f) => fmtUsd(f.usd)) },
      ...stages.map((st) => ({ key: `${st.workflow}-${st.step}`, label: st.label, cells: figs.map((f) => fmtDuration(f.stageMs(st))) })),
    ];
    return (
      <section className="admin-process-card" aria-labelledby="process-versions-title" data-testid="process-versions">
        <h5 id="process-versions-title">{t('admin.processes.versions.title')}</h5>
        <p className="admin-help-text">{t('admin.processes.versions.help')}</p>
        <div className="admin-process-grid-wrap">
          <table className="admin-process-stage-table">
            <thead><tr><th scope="col">{t('admin.processes.versions.measure')}</th>{compared.map((c) => <th key={c} scope="col">{versionLabel(c)}</th>)}</tr></thead>
            <tbody>
              {rowsOf.map((r) => <tr key={r.key} data-testid={`process-versions-${r.key}`}><th scope="row">{r.label}</th>{r.cells.map((v, i) => <td key={compared[i]}>{v}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      </section>
    );
  })() : null;

  const pickedSpans = runPick !== 'all' && byProcess.has(runPick) ? spansOf(byProcess.get(runPick)!) : null;
  // WHAT EACH JOIN OF THE PICKED RUN WAITED FOR, from its runs' end records (`joinWaitsOf`).
  const pickedJoins = pickedSpans ? byProcess.get(runPick)!.flatMap((r) => joinWaitsOf(r, runShape(r))) : [];
  const joinFor = (st: { workflow: string; step: string }) => pickedJoins.find((j) => j.workflow === st.workflow && j.step === st.step);
  const runChoices = processIds.slice(0, 4);
  // ONE TABLE OF STAGES, AS THE MOCKUP'S FLOW READS: each stage in order with what it is for, who is answerable for it, and, over
  // every run or for the one chosen, whether runs reached it and where open runs are now, its time and its cost. The workflow
  // that runs it is one link away.
  const stageTable = (
    <section className="admin-process-card" aria-labelledby="process-stages-title" data-testid="process-flow">
      <div className="admin-process-card-head">
        <div>
          <h5 id="process-stages-title">{t('admin.processes.stages.title')}</h5>
          <p className="admin-help-text">{pickedSpans ? t('admin.processes.flow.oneRun', { started: fmtTime(startOf(byProcess.get(runPick)!)) }) : t('admin.processes.flow.allRuns', { count: processIds.length })}</p>
        </div>
        {processIds.length > 0 && (
          <div className="admin-process-picks" role="group" aria-label={t('admin.processes.flow.pick')}>
            <button type="button" className={runPick === 'all' ? PICKED : UNPICKED} aria-pressed={runPick === 'all'} onClick={() => setRunPick('all')}>
              {t('admin.processes.flow.all', { count: processIds.length })}
            </button>
            {runChoices.map((id) => (
              <button key={id} type="button" data-testid={`process-flow-pick-${id}`} className={runPick === id ? PICKED : UNPICKED} aria-pressed={runPick === id} onClick={() => setRunPick(id)}>
                {fmtTime(startOf(byProcess.get(id)!))}
              </button>
            ))}
          </div>
        )}
      </div>
      {runPick !== 'all' && byProcess.get(runPick) && (
        <ul className="admin-process-pick-runs" data-testid="process-pick-runs" aria-label={t('admin.processes.flow.runs')}>
          {byProcess.get(runPick)!.map((r) => (
            <li key={`${String(r.workflow)}-${String(r.started_at)}`}>{runLinks(r, `process-pick-run-${String(r.workflow)}`)}</li>
          ))}
        </ul>
      )}
      <p className="admin-help-text">{t('admin.processes.stages.help')}</p>
      {stages.length ? (
        <div className="admin-process-grid-wrap">
          <table className="admin-process-stage-table" data-testid="process-stages">
            <thead>
              <tr>
                <th scope="col">{t('admin.processes.stages.column.stage')}</th>
                <th scope="col">{t('admin.processes.stages.column.who')}</th>
                <th scope="col">{t('admin.processes.stages.column.reached')}</th>
                <th scope="col">{pickedSpans ? t('admin.processes.stages.column.timeOne') : t('admin.processes.stages.column.time')}</th>
                <th scope="col">{pickedSpans ? t('admin.processes.stages.column.costOne') : t('admin.processes.stages.column.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s, i) => {
                const sum = summaryOf(s);
                const span = pickedSpans ? spanFor(pickedSpans, s) : undefined;
                const here = pickedSpans ? span?.end === null : false;
                const stuck = pickedSpans ? 0 : openHere(s);
                const tone = pickedSpans ? (here ? 'now' : span ? 'reached' : 'unreached') : stuck ? 'now' : sum ? 'reached' : 'unreached';
                const oneCost = pickedSpans
                  ? byProcess.get(runPick)!.filter((r) => r.workflow === s.workflow).flatMap(costsOf).filter((c) => c.step === s.step && c.usd !== null).reduce<number | null>((a, c) => (a ?? 0) + c.usd!, null)
                  : null;
                return (
                  <tr key={`${s.workflow}-${s.step}`} className={`admin-process-row-${tone}`} data-testid={`process-stage-${s.workflow}-${s.step}`}>
                    <th scope="row">
                      <span className="admin-process-stage-n">{t('admin.processes.stages.n', { n: i + 1 })}</span>{' '}
                      <span className="admin-process-stage-label">{s.label}</span>
                      {s.description && <span className="admin-process-stage-about">{s.description}</span>}
                      <span className="admin-process-stage-workflow">
                        {t('admin.processes.stages.inWorkflow')}{' '}
                        <WorkflowEditorLink assistant={wfAssistant(s.workflow)} workflow={s.workflow} testId={`process-stage-link-${s.workflow}-${s.step}`}>{s.workflow}</WorkflowEditorLink>
                      </span>
                    </th>
                    <td data-testid={`process-stage-who-${s.workflow}-${s.step}`}>{who(s)}</td>
                    <td data-testid={`process-stage-reached-${s.workflow}-${s.step}`}>
                      {pickedSpans
                        ? (span ? (here ? t('admin.processes.flow.hereNow') : t('admin.processes.flow.done')) : joinFor(s) ? joinSaid(joinFor(s)!) : t('admin.processes.flow.notReached'))
                        : (sum ? t('admin.processes.stages.reachedOf', { count: sum.reached, of: processIds.length }) : t('admin.processes.flow.notReached'))}
                      {stuck > 0 && <span className="admin-process-node-flag">{t('admin.processes.flow.openHere', { count: stuck })}</span>}
                    </td>
                    <td>
                      {pickedSpans
                        ? (span ? (here ? t('admin.processes.open') : fmtDuration(span.ms)) : '—')
                        : (sum ? t('admin.processes.stages.times', { p50: fmtDuration(sum.p50_ms), p95: fmtDuration(sum.p95_ms) }) : '—')}
                    </td>
                    <td data-testid={`process-stage-cost-${s.workflow}-${s.step}`}>{fmtUsd(pickedSpans ? oneCost : stageUsage(s).usd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!pickedSpans && otherSpend !== null && (
            <p className="admin-help-text" data-testid="process-stage-other-cost">{t('admin.processes.stages.otherCost', { cost: fmtUsd(otherSpend) })}</p>
          )}
        </div>
      ) : <p className="admin-tab-empty">{t('admin.processes.stages.undeclared')}</p>}
      <p className="admin-process-legend">
        <span className="admin-process-legend-item"><span className={nodeSwatch('now')} />{t('admin.processes.flow.legendNow')}</span>
        <span className="admin-process-legend-item"><span className={nodeSwatch('unreached')} />{t('admin.processes.flow.legendUnreached')}</span>
      </p>
    </section>
  );

  const cell = (span: StageSpan | undefined, s: { label: string }) => {
    if (!span) return <span className={cellClass(0)}>—</span>;
    const open = span.end === null;
    const text = open ? t('admin.processes.open') : fmtDuration(span.ms);
    return <span className={cellClass(open ? 'open' : timeShade(span.ms))} title={t('admin.processes.spent.cell', { stage: s.label, time: text })}>{text}</span>;
  };
  const runName = (id: string) => (
    <button type="button" className="btn-link" onClick={() => setDrill({ id, rows: null, error: false })} aria-label={t('admin.processes.drill.open', { id: shortId(id) })}>
      {fmtTime(startOf(byProcess.get(id)!))}
    </button>
  );
  const spentGrid = (
    <div className="admin-process-grid-wrap" data-testid="process-spent">
      <table className="admin-process-grid">
        <thead>
          <tr>
            <th scope="col">{t('admin.processes.column.run')}</th>
            {stages.map((s) => <th key={`${s.workflow}-${s.step}`} scope="col">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {processIds.map((id) => {
            const rs = byProcess.get(id)!;
            const spans = spansOf(rs);
            const openRun = rs.some((r) => num(r.ended_at) === null);
            return (
              <tr key={id} data-testid={`process-spent-${id}`}>
                <th scope="row">
                  <span data-testid={`process-drill-${id}`} className="admin-process-run-name">{runName(id)}</span>
                  <span className="admin-help-text">{openRun ? t('admin.processes.open') : sayOutcome(rs.find((r) => r.workflow === shape?.workflows[0])?.disposition ?? rs[0]?.disposition)}</span>
                </th>
                {stages.map((s) => <td key={`${s.workflow}-${s.step}`}>{cell(spanFor(spans, s), s)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  // ON A PHONE, each run is a card of its stages, stacked, each with its time.
  const spentList = (
    <ul className="admin-process-run-cards" data-testid="process-spent">
      {processIds.map((id) => {
        const spans = spansOf(byProcess.get(id)!);
        return (
          <li key={id} className="admin-process-run-card" data-testid={`process-spent-${id}`}>
            <span data-testid={`process-drill-${id}`}>{runName(id)}</span>
            <ol className="admin-process-run-stages">
              {stages.filter((s) => spanFor(spans, s)).map((s) => <li key={`${s.workflow}-${s.step}`}><span>{s.label}</span>{cell(spanFor(spans, s), s)}</li>)}
            </ol>
          </li>
        );
      })}
    </ul>
  );
  const legend = (
    <p className="admin-process-legend" aria-hidden="true">
      {([1, 2, 3, 4] as const).map((n) => (
        <span key={n} className="admin-process-legend-item"><span className={`admin-process-swatch ${cellClass(n)}`} />{t(`admin.processes.spent.shade${n}`)}</span>
      ))}
      <span className="admin-process-legend-item"><span className={`admin-process-swatch ${cellClass('open')}`} />{t('admin.processes.spent.open')}</span>
    </p>
  );

  // TIME WAITING ON EACH PARTY, AS THE MOCKUP READS IT: each stage's time goes to who is answerable for it (a person's team, or
  // the assistants), summed per run, and each party's median over the runs, as a bar against the longest. A message the platform
  // posts waits on nobody, so it counts toward no party. The owner team stays answerable for the whole.
  const partyOf = (s: DeclaredStage): string | null => {
    const r = stageResponsible(s.def);
    if (r.kind === 'person') return t('admin.processes.party.team', { team: r.team ?? teamOf(s.workflow) ?? '—' });
    if (r.kind === 'assistant') return t('admin.processes.party.assistants');
    return null;
  };
  const partyTimes = new Map<string, number[]>();
  for (const id of processIds) {
    const spans = spansOf(byProcess.get(id)!);
    const per = new Map<string, number>();
    for (const s of stages) {
      const party = partyOf(s);
      const span = spanFor(spans, s);
      if (!party || !span || span.ms === null) continue;
      per.set(party, (per.get(party) ?? 0) + span.ms);
    }
    for (const [party, ms] of per) partyTimes.set(party, [...(partyTimes.get(party) ?? []), ms]);
  }
  const partyRows = [...partyTimes.entries()]
    .map(([name, xs]) => ({ name, p50: percentile([...xs].sort((a, b) => a - b), 0.5) ?? 0 }))
    .sort((a, b) => b.p50 - a.p50);
  const longest = Math.max(1, ...partyRows.map((r) => r.p50));
  const teams = (
    <section className="admin-process-card" aria-labelledby="process-teams-title" data-testid="process-teams">
      <h5 id="process-teams-title">{t('admin.processes.teams.title')}</h5>
      <p className="admin-help-text">{t('admin.processes.teams.help')}</p>
      {partyRows.length ? (
        <ul className="admin-process-bars">
          {partyRows.map((r) => (
            <li key={r.name} data-testid="process-party">
              <span>{r.name}</span>
              <span className="admin-process-bar" aria-hidden="true"><span style={{ width: `${Math.round((r.p50 / longest) * 100)}%` }} /></span>
              <span className="admin-process-stage-time">{fmtDuration(r.p50)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="admin-tab-empty">{t('admin.processes.empty')}</p>}
    </section>
  );

  const decl = current ? declared[current] : undefined;
  const metricRows: Row[] = (decl?.metrics ?? []).map((m) => {
    const { share, processes: n } = metricShare(runs, m, decl!.edition);
    return { id: m.id, label: m.label, value: share, target: m.target ?? null, processes: n };
  });
  const metricColumns: Column<Row>[] = [
    { key: 'label', label: t('admin.processes.column.metric') },
    { key: 'value', label: t('admin.processes.column.value'), render: (v, r) => (num(v) === null ? '—' : `${Math.round(num(v)! * 100)}%${num(r.target) !== null && num(v)! < num(r.target)! ? ` (${t('admin.processes.belowTarget')})` : ''}`) },
    { key: 'target', label: t('admin.processes.column.target'), render: (v) => (num(v) === null ? '—' : `${Math.round(num(v)! * 100)}%`) },
    { key: 'processes', label: t('admin.processes.column.processes') },
  ];

  // THE DRILL: one process id, its own row, and each run's stages with their start, end, time and how each ended.
  const drillRuns = (drill?.rows ?? []).filter((r) => r.dimension === 'run' && r.process_id === drill?.id);
  const drillRow = (drill?.rows ?? []).find((r) => r.dimension === 'process');
  const order = (wf: unknown) => { const i = shape?.workflows.indexOf(String(wf)) ?? -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const drillOrdered = [...drillRuns].sort((a, b) => order(a.workflow) - order(b.workflow) || (num(a.started_at) ?? 0) - (num(b.started_at) ?? 0));
  const e2e = endToEnd(drillRuns);
  const drillBody = (
    <>
      <p className="admin-process-drill-summary" data-testid="process-drill-summary">
        {e2e.ms === null
          ? t('admin.processes.drill.stillOpen', { started: fmtTime(e2e.start) })
          : t('admin.processes.drill.endToEnd', { time: fmtDuration(e2e.ms), started: fmtTime(e2e.start), ended: fmtTime(e2e.end) })}
        {drillRow ? ` ${t('admin.processes.drill.state', { ended: num(drillRow.ended) ?? 0, succeeded: num(drillRow.succeeded) ?? 0 })}` : ''}
      </p>
      {drillOrdered.map((r) => {
        const stagesOfRun = runStages(r, runShape(r));
        const runTime = num(r.ended_at) === null ? t('admin.processes.open') : fmtDuration(num(r.ended_at)! - num(r.started_at)!);
        const about = t('admin.processes.drill.run', { team: String(r.owner_team ?? '—'), outcome: runOutcome(r), time: runTime });
        return (
          <section key={`${String(r.workflow)}-${String(r.started_at)}`} className="admin-process-drill-run" data-testid={`process-drill-run-${String(r.workflow)}`}>
            <h5>{runLinks(r, `process-drill-open-${String(r.workflow)}`)}{' '}<span className="admin-help-text">{about}</span></h5>
            {stagesOfRun.length ? (
              <ol className="admin-process-drill-stages">
                {stagesOfRun.map((s) => (
                  <li key={s.step} className="admin-process-drill-stage" data-testid={`process-drill-stage-${s.step}`}>
                    <span className="admin-process-stage-label">{s.label}</span>
                    <span>{t('admin.processes.drill.span', { start: fmtTime(s.start), end: s.end === null ? t('admin.processes.open') : fmtTime(s.end) })}</span>
                    <span className="admin-process-stage-time">{s.end === null ? t('admin.processes.open') : fmtDuration(s.ms)}</span>
                    <span>{s.outcome ? sayOutcome(s.outcome) : ''}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="admin-tab-empty">{t('admin.processes.stages.none')}</p>}
            {joinWaitsOf(r, runShape(r)).map((j) => (
              <p key={j.step} className="admin-process-drill-join" data-testid={`process-drill-join-${j.step}`}>
                <span className="admin-process-stage-label">{j.label}</span>{' '}{joinSaid(j)}{' · '}{sayOutcome(j.edge === 'deadline' ? 'timed-out' : j.edge)}
              </p>
            ))}
          </section>
        );
      })}
    </>
  );

  const detail = current && (
    <section aria-labelledby="process-detail-title" data-testid="process-detail">
      <nav className="admin-breadcrumb" aria-label={t('admin.processes.drill.path')} data-testid="process-breadcrumb">
        <button type="button" className="btn-link" data-testid="process-back" onClick={() => setSelected(null)}>{t('admin.processes.drill.back')}</button>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{label(current)}</span>
      </nav>
      <h4 id="process-detail-title" data-testid="process-current" ref={detailHeading} tabIndex={-1}>{label(current)}</h4>
      {(shape?.description ?? decl?.description) && <p className="admin-process-description" data-testid="process-description">{shape?.description ?? decl?.description}</p>}
      <p className="admin-help-text" data-testid="process-meta">
        {decl?.owner ? t('admin.processes.detail.owned', { owner: decl.owner }) : t('admin.processes.detail.undeclared')}
        {stages.length ? ` · ${t('admin.processes.detail.stages', { count: stages.length, workflows: shape?.workflows.length ?? new Set(stages.map((s) => s.workflow)).size })}` : ''}
      </p>
      {versionPicks}
      <div className="admin-process-kpis" data-testid="process-kpis">
        {kpis.map((k) => (
          <div key={k.key} className="admin-process-kpi" data-testid={`process-kpi-${k.key}`}>
            <span className="admin-process-kpi-label">{k.label}</span>
            <span className="admin-process-kpi-value">{k.value}</span>
            {k.note && <span className="admin-process-kpi-note">{k.note}</span>}
          </div>
        ))}
      </div>
      {stageTable}
      {processIds.length > 0 && (
        <section className="admin-process-card" aria-labelledby="process-spent-title">
          <h5 id="process-spent-title">{t('admin.processes.spent.title')}</h5>
          <p className="admin-help-text">{t('admin.processes.spent.help')}</p>
          {legend}
          {narrow ? spentList : spentGrid}
        </section>
      )}
      {teams}
      {compareTable}
      {metricRows.length > 0 && (
        <section className="admin-process-card" aria-labelledby="process-metrics-title">
          <h5 id="process-metrics-title">{t('admin.processes.metrics', { edition: decl!.edition.slice(0, 6) })}</h5>
          {table(metricRows, metricColumns, 'process-metrics')}
        </section>
      )}
    </section>
  );

  return (
    <div className="admin-section" role="region" aria-label={t('admin.processes.title')} data-testid="processes">
      <h3>
        {t('admin.processes.title')}{' '}
        <InfoTooltip label={t('admin.processes.title')} content={t('admin.processes.tip')} />
      </h3>
      <p className="admin-tab-description">{t('admin.processes.description')}</p>
      {state.truncated && !drill && <p className="admin-info-banner" data-testid="processes-truncated">{t('admin.processes.truncated')}</p>}
      {state.unsupported ? <p className="admin-info-banner">{t('admin.processes.unsupported')}</p>
        : state.error ? <p className="admin-error" role="alert">{t('admin.processes.error')}</p>
          : state.rows === null ? <p className="admin-help-text">{t('admin.processes.loading')}</p>
            : drill ? (
              <section aria-labelledby="process-drill-title" data-testid="process-drill">
                {/* EVERY LEVEL ABOVE IS A LINK: all processes, then the process this id is a run of. */}
                <nav className="admin-breadcrumb" aria-label={t('admin.processes.drill.path')} data-testid="process-drill-breadcrumb">
                  <button type="button" className="btn-link" data-testid="process-drill-all" onClick={() => { setDrill(null); setSelected(null); }}>{t('admin.processes.drill.back')}</button>
                  {(current ?? shownProcess) && <>
                    <span aria-hidden="true"> / </span>
                    <button type="button" className="btn-link" data-testid="process-drill-back" onClick={() => { const p = current ?? shownProcess; setDrill(null); setSelected(p); }}>{label(current ?? shownProcess)}</button>
                  </>}
                  <span aria-hidden="true"> / </span>
                  <span aria-current="page">{t('admin.processes.drill.title', { id: shortId(drill.id) })}</span>
                </nav>
                <h4 id="process-drill-title" ref={drillHeading} tabIndex={-1}>{t('admin.processes.drill.title', { id: shortId(drill.id) })}</h4>
                {drill.error ? <p className="admin-error" role="alert">{t('admin.processes.error')}</p>
                  : drill.rows === null ? <p className="admin-help-text">{t('admin.processes.loading')}</p>
                    : !drillRuns.length ? <p className="admin-tab-empty">{t('admin.processes.drill.empty')}</p>
                      : <div data-testid="process-drill-runs">{drillBody}</div>}
              </section>
            ) : current ? detail : (
              <>
                {ownerNote}
                {names.length ? table(listRows, listColumns, 'processes-table') : <p className="admin-tab-empty" data-testid="processes-empty">{t('admin.processes.empty')}</p>}
              </>
            )}
    </div>
  );
};

export default ProcessesPanel;
