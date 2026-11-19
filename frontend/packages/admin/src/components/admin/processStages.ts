/**
 * A PROCESS'S STAGES, IN RUN ORDER, WITH THEIR TIMES (SPEC-PROCESSES P9; DESIGN-PROCESSES section 6).
 *
 * Pure: every function here reads what the process view already holds, the runs `process_runs` returns and the owner team's
 * active version, and decides; nothing here reads a store.
 *
 * What it guarantees:
 *  - A STAGE IS A STEP WITH A DECLARED LABEL, under that label, tied to its workflow. A step with no label is an internal move
 *    (`open`, `hold`, a send that only tells the room) and is never shown, and a step the workflow does not declare (a
 *    reminder, a repeated event) never ends a stage.
 *  - A STAGE'S TIME IS READ FROM THE RUN'S OWN MESSAGES: it starts at its step's first message and ends where the run's next
 *    labeled step first said something, or at the run's end, and a stage of a run still open has no end yet. A step with no
 *    label belongs to the stage before it, whether it says something (a send that only tells the room) or nothing (a wait,
 *    an `open`), so an internal move never cuts a stage short.
 *  - THE ORDER IS THE RUN'S: workflows in the process's declared order, and within each, stages by the median time from the
 *    run's start to the stage's start, then the order the workflow declares them in.
 * Without the version (a reader who may not read it), every step the runs took is a stage under its own name.
 *  - A JOIN SAYS WHAT IT WAITED FOR (`joinWaitsOf`): its outcome, carried on the run's end record with the run's steps, names
 *    every part, how each ended and which part the join waited on last, so no other store is read.
 */
import { joinOutcomeOf, linkableWorkflows, type JoinPartState } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

/** When a step of a run first said something, epoch milliseconds. */
export interface StepTime { step: string; at: number }

/** A run as `process_runs` returns it, the fields the stages read. */
export interface StageRun {
  process_id?: unknown; workflow?: unknown; started_at?: unknown; ended_at?: unknown; disposition?: unknown;
  steps?: unknown; step_times?: unknown;
}

/** One step of a linked workflow as the owner's version declares it: its name, and, for a stage, its label and description. */
export interface ShapeStep {
  step: string; label?: string; description?: string;
  /** The step's own definition, from which what the stage runs is said (`stageRunsOf`). */
  def?: Record<string, unknown>;
}

/** What the owner's version says of a process: its description, its workflows in order, and each one's steps in order. */
export interface ProcessShape {
  description?: string;
  workflows: string[];
  steps: Record<string, ShapeStep[]>;
}

/** One stage as the process declares it: a labeled step, tied to its workflow, in the order the process links them. */
export interface DeclaredStage { workflow: string; step: string; label: string; description?: string; def?: Record<string, unknown> }

/** Every stage the process declares, workflows in the process's order and steps in each workflow's order. */
export function declaredStages(shape: ProcessShape | null | undefined): DeclaredStage[] {
  if (!shape) return [];
  return shape.workflows.flatMap((workflow) => (shape.steps[workflow] ?? [])
    .filter((s) => s.label)
    .map((s) => ({ workflow, step: s.step, label: s.label!, ...(s.description ? { description: s.description } : {}), ...(s.def ? { def: s.def } : {}) })));
}

/**
 * WHO IS ANSWERABLE FOR A STAGE, read from the step's own definition: an assistant (by the role it holds in the conversation; the
 * console names the assistant that actually answered, where its runs say), a person (by the role the conversation type declares,
 * `role:team`), or the platform itself (a message, an opened conversation, a wait).
 */
export function stageResponsible(def: Record<string, unknown> | undefined): { kind: 'assistant'; role: string } | { kind: 'person'; role: string; team?: string } | { kind: 'platform' } {
  const task = def && isObject(def.task) ? def.task : undefined;
  const by = task && isObject(task.by) ? task.by : undefined;
  if (by && typeof by.assistantRole === 'string') return { kind: 'assistant', role: by.assistantRole };
  if (by && typeof by.participantRole === 'string') {
    const [role, team] = by.participantRole.split(':');
    return { kind: 'person', role: role.replace(/[-_]+/g, ' '), ...(team ? { team } : {}) };
  }
  if (def && isObject(def.agent)) return { kind: 'assistant', role: 'primary' };
  return { kind: 'platform' };
}

/** One stage of one run. */
export interface StageSpan {
  workflow: string; step: string; label: string;
  start: number; end: number | null; ms: number | null;
  /** How the step ended, as the run's end recorded it, where it did. */
  outcome?: string;
}

/** One stage across the runs read: how many reached it, and its median and 95th percentile time. */
export interface StageSummary {
  workflow: string; step: string; label: string;
  reached: number; timed: number; p50_ms: number | null; p95_ms: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * THE PROCESS AS ITS OWNER'S VERSION DECLARES IT: the workflows its `processes` entry links (event or request-started), in that order, and each workflow's
 * steps in the order it declares them, with the labels they carry. Null where the version does not declare the process.
 */
export function processShapeOf(body: unknown, process: string): ProcessShape | null {
  if (!isObject(body)) return null;
  const entry = isObject(body.processes) ? body.processes[process] : undefined;
  const description = isObject(entry) && typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : undefined;
  const workflows = isObject(entry) && Array.isArray(entry.workflows) ? entry.workflows.filter((w): w is string => typeof w === 'string') : [];
  if (!workflows.length) return null;
  // ITS WORKFLOWS ARE THE VERSION'S EVENT WORKFLOWS AND ITS REQUEST-STARTED ONES, by name, as the server links them.
  const declared = linkableWorkflows(body.eventWorkflows, body.intentWorkflows);
  const steps: ProcessShape['steps'] = {};
  for (const wf of workflows) {
    const states = isObject(declared[wf]) && isObject((declared[wf] as Record<string, unknown>).states) ? (declared[wf] as { states: Record<string, unknown> }).states : {};
    steps[wf] = Object.entries(states).map(([step, def]) => {
      const label = isObject(def) && typeof def.label === 'string' && def.label.trim() ? def.label.trim() : undefined;
      const about = isObject(def) && typeof def.description === 'string' && def.description.trim() ? def.description.trim() : undefined;
      return { step, ...(label ? { label } : {}), ...(label && about ? { description: about } : {}), ...(isObject(def) ? { def } : {}) };
    });
  }
  return { ...(description ? { description } : {}), workflows, steps };
}

/**
 * THE PROCESS AS ONE VERSION RAN IT: its own `processes` entry where it declares one, else the workflows the process is known to
 * link (from any version, or the runs), read from that version's own definitions, so a version that no longer declares the
 * process (one rolled back to, or edited since) still names its stages and who answers them.
 */
export function shapeOfVersion(body: unknown, process: string, workflows: readonly string[]): ProcessShape | null {
  const declared = processShapeOf(body, process);
  if (declared) return declared;
  if (!isObject(body) || !workflows.length) return null;
  return processShapeOf({ ...body, processes: { [process]: { workflows: [...workflows] } } }, process);
}

/** The step times a run carries, oldest first. */
export function stepTimesOf(run: StageRun): StepTime[] {
  if (!Array.isArray(run.step_times)) return [];
  return (run.step_times as Array<{ step?: unknown; at?: unknown }>)
    .map((s) => ({ step: String(s.step ?? ''), at: num(s.at) }))
    .filter((s): s is StepTime => !!s.step && s.at !== null)
    .sort((a, b) => a.at - b.at);
}

/**
 * ONE RUN'S STAGES, in the order it reached them: each labeled step it took, from its first message to the next labeled
 * step's, or to the run's end; the unlabeled steps between are the stage's own. With no shape for the run's workflow, every
 * step it took is a stage under its own name.
 */
export function runStages(run: StageRun, shape?: ProcessShape | null): StageSpan[] {
  const workflow = String(run.workflow ?? '');
  const declared = shape?.steps[workflow];
  const known = declared ? new Set(declared.map((s) => s.step)) : null;
  const labels = new Map((declared ?? []).filter((s) => s.label).map((s) => [s.step, s.label!] as const));
  const times = stepTimesOf(run).filter((s) => !known || known.has(s.step));
  const ended = num(run.ended_at);
  const outcomes = new Map<string, string>();
  if (Array.isArray(run.steps)) for (const s of run.steps as Array<{ step?: unknown; outcome?: unknown }>) if (s?.step) outcomes.set(String(s.step), String(s.outcome ?? ''));
  const staged = times.flatMap((s) => {
    const label = known ? labels.get(s.step) : s.step;
    return label ? [{ ...s, label }] : [];
  });
  return staged.map((s, i) => {
    const end = i + 1 < staged.length ? staged[i + 1].at : ended;
    const outcome = outcomes.get(s.step);
    return { workflow, step: s.step, label: s.label, start: s.at, end, ms: end === null ? null : Math.max(0, end - s.at), ...(outcome ? { outcome } : {}) };
  });
}

/** One part of a join, as the version declares its step: an opened conversation (by its type) or a task beside the work (by its stage). */
export interface JoinPartRef { step: string; kind: 'open' | 'alongside' | 'unknown'; type?: string; label?: string }
/** What one join of a run waited for: its stage, the edge it went on, the part it waited on last, and every part as it stood. */
export interface JoinWait {
  workflow: string; step: string; label: string;
  edge: 'success' | 'failure' | 'deadline';
  waitedFor?: JoinPartRef;
  parts: Array<JoinPartRef & { state: JoinPartState }>;
}

/** EACH JOIN A RUN WENT ON FROM, read from the outcomes its end record carries (`joined:...`), in the order the run took them. */
export function joinWaitsOf(run: StageRun, shape?: ProcessShape | null): JoinWait[] {
  const workflow = String(run.workflow ?? '');
  const byStep = new Map((shape?.steps[workflow] ?? []).map((s) => [s.step, s] as const));
  const ref = (step: string): JoinPartRef => {
    const def = byStep.get(step)?.def;
    const label = byStep.get(step)?.label;
    const type = def && isObject(def.open) ? String(def.open.type ?? '') : '';
    if (def && isObject(def.open)) return { step, kind: 'open', ...(type ? { type } : {}), ...(label ? { label } : {}) };
    if (def && isObject(def.task)) return { step, kind: 'alongside', ...(label ? { label } : {}) };
    return { step, kind: 'unknown', ...(label ? { label } : {}) };
  };
  const out: JoinWait[] = [];
  for (const s of Array.isArray(run.steps) ? run.steps as Array<{ step?: unknown; outcome?: unknown }> : []) {
    const read = joinOutcomeOf(String(s?.outcome ?? ''));
    if (!read || !s?.step) continue;
    const step = String(s.step);
    out.push({
      workflow, step, label: byStep.get(step)?.label ?? step, edge: read.edge,
      ...(read.last ? { waitedFor: ref(read.last) } : {}),
      parts: Object.entries(read.parts).map(([p, state]) => ({ ...ref(p), state })),
    });
  }
  return out;
}

/** A percentile of sorted values, interpolated between the two nearest as `PERCENTILE_CONT` does. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

const median = (xs: number[]): number => percentile([...xs].sort((a, b) => a - b), 0.5) ?? 0;

/**
 * EVERY STAGE OF A PROCESS ACROSS THE RUNS READ, in run order: how many runs reached it, and the median and 95th percentile of
 * the times of the runs in which it ended.
 */
export function stageSummary(runs: StageRun[], shape?: ProcessShape | null | ((run: StageRun) => ProcessShape | null | undefined)): StageSummary[] {
  // EACH RUN IS READ AGAINST THE SHAPE OF THE VERSION IT RAN ON where one is given per run; the order is the first run's.
  const shapeOf = typeof shape === 'function' ? shape : () => shape;
  const order = typeof shape === 'function' ? (runs.map(shape).find(Boolean) ?? null) : shape;
  const byKey = new Map<string, { workflow: string; step: string; label: string; offsets: number[]; ms: number[]; reached: number }>();
  const firstStart = new Map<string, number>();
  for (const run of runs) {
    const start = num(run.started_at) ?? stepTimesOf(run)[0]?.at ?? 0;
    const wf = String(run.workflow ?? '');
    firstStart.set(wf, Math.min(firstStart.get(wf) ?? Infinity, start));
    for (const s of runStages(run, shapeOf(run))) {
      const key = `${s.workflow}\u0000${s.step}`;
      const row = byKey.get(key) ?? { workflow: s.workflow, step: s.step, label: s.label, offsets: [], ms: [], reached: 0 };
      row.reached += 1;
      row.offsets.push(s.start - start);
      if (s.ms !== null) row.ms.push(s.ms);
      byKey.set(key, row);
    }
  }
  // A WORKFLOW THE PROCESS DOES NOT DECLARE (or no version read) follows the declared ones, by when it first started.
  const undeclared = [...firstStart.entries()].filter(([wf]) => !order?.workflows.includes(wf)).sort((a, b) => a[1] - b[1]).map(([wf]) => wf);
  const wfOrder = (wf: string) => {
    const i = order?.workflows.indexOf(wf) ?? -1;
    return i >= 0 ? i : (order?.workflows.length ?? 0) + undeclared.indexOf(wf);
  };
  const declaredAt = (wf: string, step: string) => order?.steps[wf]?.findIndex((s) => s.step === step) ?? -1;
  return [...byKey.values()]
    .sort((a, b) => wfOrder(a.workflow) - wfOrder(b.workflow)
      || median(a.offsets) - median(b.offsets)
      || declaredAt(a.workflow, a.step) - declaredAt(b.workflow, b.step))
    .map((r) => {
      const sorted = [...r.ms].sort((x, y) => x - y);
      return { workflow: r.workflow, step: r.step, label: r.label, reached: r.reached, timed: sorted.length, p50_ms: percentile(sorted, 0.5), p95_ms: percentile(sorted, 0.95) };
    });
}

/** A process's end to end, from its first run's start to its last run's end; null while any run is open. */
export function endToEnd(runs: StageRun[]): { start: number | null; end: number | null; ms: number | null } {
  const starts = runs.map((r) => num(r.started_at)).filter((v): v is number => v !== null);
  const ends = runs.map((r) => num(r.ended_at));
  const start = starts.length ? Math.min(...starts) : null;
  const end = runs.length && ends.every((v) => v !== null) ? Math.max(...(ends as number[])) : null;
  return { start, end, ms: start !== null && end !== null ? end - start : null };
}

/**
 * HOW A STEP ENDED, AS A KEY OF THE LOCALE FILE (D11: the console says it in the reader's language): a task's settlement
 * (`task:success:acknowledged`) is its edge, with the state it settled in as a value; a run's own outcomes each have a key; an
 * outcome the console does not know is said as written.
 */
export function outcomeCopy(outcome: string | undefined | null): { key: string; values?: Record<string, string> } {
  const o = String(outcome ?? '');
  if (!o) return { key: 'admin.processes.outcome.none' };
  const task = /^task:(success|failure|deadline)(?::(.+))?$/.exec(o);
  if (task) return { key: `admin.processes.outcome.task.${task[1]}`, values: { state: (task[2] ?? '').replace(/[_-]+/g, ' ') } };
  if (KNOWN_OUTCOMES.has(o)) return { key: `admin.processes.outcome.${o === 'no-worker' ? 'noWorker' : o === 'timed-out' ? 'timedOut' : o}` };
  return { key: 'admin.processes.outcome.other', values: { outcome: o } };
}

const KNOWN_OUTCOMES = new Set(['posted', 'opened', 'sent', 'refused', 'failed', 'success', 'failure', 'stopped', 'waiting', 'no-worker', 'timed-out', 'ended']);
