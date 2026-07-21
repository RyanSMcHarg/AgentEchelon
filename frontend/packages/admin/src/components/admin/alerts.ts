/**
 * Alerts model (SPEC-ADMIN-CONSOLE "Alerts (what error means)").
 *
 * An "error" in the console is broader than a thrown exception. It is any of three alertable
 * conditions, and underneath they are the SAME thing: a measured value in `bad` status against its
 * `metricTargets.ts` threshold (plus literal error rows). `computeAlerts` assembles them by scanning the
 * analytics results the dashboard already holds — no new backend query.
 *
 *  - runtime  : sent/thrown errors, failed deliveries, error_response replies, tool-call failures
 *  - latency  : perceived-latency SLO missed (TTFF / P95 over target)
 *  - quality  : an intent's or a model's evaluated quality below threshold
 *
 * Pure + deterministic so it is unit-tested (alerts.test.ts).
 */
import { METRIC_TARGETS, evaluateTarget, formatTarget, type TargetStatus } from './metricTargets';

export type AlertSeverity = 'error' | 'warn'; // error = `bad` status, warn = `warn` status
export type AlertCategory = 'runtime' | 'latency' | 'quality';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  /** The measured value vs its target, e.g. "3.2s vs target ≤ 1s". */
  detail: string;
  /** TabId the alert links to (drill). */
  tab: string;
  /** For quality alerts, the intent this concerns (lets the Effectiveness tab pre-drill later). */
  intent?: string;
}

export interface AlertSources {
  intentEffectiveness?: Array<Record<string, unknown>> | null; // intent_effectiveness rows
  latency?: Array<Record<string, unknown>> | null;             // latency_metrics rows
  modelEffectiveness?: Array<Record<string, unknown>> | null;  // model_effectiveness rows
  flagged?: Array<Record<string, unknown>> | null;             // flagged_responses rows
  errorRate?: Array<Record<string, unknown>> | null;           // error_rate_daily rows
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));
const sevOf = (status: TargetStatus): AlertSeverity | null =>
  status === 'bad' ? 'error' : status === 'warn' ? 'warn' : null;

/** Build an alert from a value + a target-registry key, or null when the value is good / unknown. */
function metricAlert(
  value: unknown,
  targetKey: string,
  opts: { id: string; category: AlertCategory; title: string; tab: string; intent?: string },
): Alert | null {
  const t = METRIC_TARGETS[targetKey];
  const n = num(value);
  if (!t || !Number.isFinite(n)) return null;
  const severity = sevOf(evaluateTarget(n, t));
  if (!severity) return null;
  const shown = t.format ? t.format(n) : `${n}${t.unit ?? ''}`;
  return { ...opts, severity, detail: `${shown} vs target ${formatTarget(t)}` };
}

const isTaskDelivery = (r: Row) => String(r.delivery_option || '').toUpperCase().startsWith('TASK');

/** Traffic-weighted mean of `field` over rows (weighted by exchange_count; plain mean if no counts). */
function weightedMean(rows: Row[], field: string): number {
  const total = rows.reduce((s, r) => s + (Number(r.exchange_count) || 0), 0);
  if (total <= 0) return rows.length ? rows.reduce((s, r) => s + num(r[field] || 0), 0) / rows.length : NaN;
  return rows.reduce((s, r) => s + (Number(r[field]) || 0) * (Number(r.exchange_count) || 0), 0) / total;
}

/** The execution quality axis for an intent row: task intents by completion, others by relevance. */
function executionAxis(row: Row): { value: number; targetKey: string; label: string } {
  const taskCount = num(row.task_count) || 0;
  const directCount = num(row.direct_count) || 0;
  if (taskCount > 0 && taskCount >= directCount) {
    return { value: num(row.task_completion_rate), targetKey: 'task_completion_rate', label: 'completion' };
  }
  return { value: num(row.direct_relevance), targetKey: 'relevance_score', label: 'relevance' };
}

export function computeAlerts(sources: AlertSources): Alert[] {
  const alerts: Alert[] = [];

  // --- Latency SLA (perceived: exclude multi-step tasks, traffic-weighted; mirrors LatencyTab) -------
  const latRows = (sources.latency ?? []).filter((r) => !isTaskDelivery(r));
  if (latRows.length) {
    const ttff = weightedMean(latRows.filter((r) => Number(r.avg_ttff_ms) > 0), 'avg_ttff_ms');
    const p95 = weightedMean(latRows.filter((r) => Number(r.p95_total_ms) > 0), 'p95_total_ms');
    const a1 = metricAlert(ttff, 'ttff_ms', { id: 'lat-ttff', category: 'latency', title: 'Time to first feedback above target', tab: 'latency' });
    if (a1) alerts.push(a1);
    const a2 = metricAlert(p95, 'p95_total_ms', { id: 'lat-p95', category: 'latency', title: 'P95 response latency above target', tab: 'latency' });
    if (a2) alerts.push(a2);
  }

  // --- Per-intent quality + tool errors ------------------------------------------------------------
  for (const row of sources.intentEffectiveness ?? []) {
    const intent = String(row.intent ?? 'unknown');
    const ax = executionAxis(row);
    const exec = metricAlert(ax.value, ax.targetKey, {
      id: `q-exec-${intent}`, category: 'quality', title: `${intent}: ${ax.label} below target`, tab: 'effectiveness', intent,
    });
    if (exec) alerts.push(exec);
    const conf = metricAlert(row.avg_confidence, 'intent_confidence', {
      id: `q-conf-${intent}`, category: 'quality', title: `${intent}: classification confidence below target`, tab: 'effectiveness', intent,
    });
    if (conf) alerts.push(conf);
    // Tool failure is a RUNTIME error (the mechanism failed), only meaningful when tools were called.
    if ((num(row.tool_calls) || 0) > 0) {
      const tool = metricAlert(row.tool_error_rate, 'tool_error_rate', {
        id: `r-tool-${intent}`, category: 'runtime', title: `${intent}: tool error rate above target`, tab: 'effectiveness', intent,
      });
      if (tool) alerts.push(tool);
    }
  }

  // --- Per-model evaluated quality -----------------------------------------------------------------
  for (const row of sources.modelEffectiveness ?? []) {
    const model = String(row.model ?? row.bedrock_model ?? 'model');
    const intent = row.intent ? String(row.intent) : undefined;
    const score = row.avg_score ?? row.avg_relevance_score ?? row.avg_relevance;
    const a = metricAlert(score, 'relevance_score', {
      id: `q-model-${model}-${intent ?? 'all'}`, category: 'quality',
      title: `${model}${intent ? ` on ${intent}` : ''}: evaluated quality below target`, tab: 'models', intent,
    });
    if (a) alerts.push(a);
  }

  // --- Runtime: literal error-response replies -----------------------------------------------------
  const errorResponses = (sources.flagged ?? []).filter(
    (r) => String(r.classification ?? '').toLowerCase() === 'error_response',
  ).length;
  if (errorResponses > 0) {
    alerts.push({
      id: 'r-error-responses', severity: 'error', category: 'runtime',
      title: `${errorResponses} error-response ${errorResponses === 1 ? 'reply' : 'replies'}`,
      detail: 'assistant replies classified as an error in this window', tab: 'flagged',
    });
  }

  // --- Runtime: platform error rate (client_events) ------------------------------------------------
  const errRows = sources.errorRate ?? [];
  if (errRows.length) {
    const totalErrors = errRows.reduce((s, r) => s + (Number(r.error_count) || 0), 0);
    const totalEvents = errRows.reduce((s, r) => s + (Number(r.total_count ?? r.total_events) || 0), 0);
    const pct = totalEvents > 0 ? (totalErrors / totalEvents) * 100
      : weightedMean(errRows, 'error_percent'); // fall back to a per-row percent if totals are absent
    const a = metricAlert(pct, 'error_rate', { id: 'r-error-rate', category: 'runtime', title: 'Platform error rate above target', tab: 'overview' });
    if (a) alerts.push(a);
  }

  // Errors first, then warnings; stable within a severity by category then title.
  const rank = (s: AlertSeverity) => (s === 'error' ? 0 : 1);
  return alerts.sort((a, b) => rank(a.severity) - rank(b.severity) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}
