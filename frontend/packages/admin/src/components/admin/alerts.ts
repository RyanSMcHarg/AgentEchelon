/**
 * Alerts model (SPEC-ADMIN-CONSOLE "Alerts (what error means)").
 *
 * An "error" in the console is broader than a thrown exception. It is any alertable condition, and
 * most of them are the SAME thing underneath: a measured value in `bad` status against its
 * `metricTargets.ts` threshold (plus literal error rows). `computeAlerts` assembles them by scanning the
 * analytics results the dashboard already holds — no new backend query.
 *
 *  - runtime  : sent/thrown errors, failed deliveries, error_response replies, tool-call failures
 *  - latency  : perceived-latency SLO missed (TTFF / E2E over target, plus the P95 worker-compute tail)
 *  - quality  : an intent's or a model's evaluated quality below threshold, and any BLOCKING
 *               compliance breach — the one alert here that is a COUNT rather than a threshold,
 *               because that is what the rule set's `blocking` severity means: somebody needs to know
 *               today. One disclosed card number is not an acceptable percentage of a good week.
 *
 * Pure + deterministic so it is unit-tested (alerts.test.ts).
 */
import i18n from '@ae/shared/i18n';
import { evaluateTarget, formatTarget, targetFor, type TargetStatus } from './metricTargets';
import { EMPTY_FILTERS, type PerformanceFilters } from './PerformanceFilters';
import { coverage, latencyPopulation, measuredValue, weightedMetric } from './latencyAggregate';

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
  /**
   * The Performance surface's filters, so an alert is judged over the population the operator is
   * looking at and against the band that population's tier is held to. Absent means every tier.
   */
  filters?: PerformanceFilters | null;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));
const sevOf = (status: TargetStatus): AlertSeverity | null =>
  status === 'bad' ? 'error' : status === 'warn' ? 'warn' : null;

/**
 * Build an alert from a value + a target-registry key, or null when the value is good / unknown.
 *
 * `tier` goes through `targetFor` exactly as the tab's cards do. Reading `METRIC_TARGETS` directly meant
 * a console narrowed to one tier judged its cards against that tier's band and its alerts against the
 * global one, so the two surfaces could disagree about whether the same window had breached.
 */
function metricAlert(
  value: unknown,
  targetKey: string,
  opts: { id: string; category: AlertCategory; title: string; tab: string; intent?: string; note?: string },
  tier?: string | null,
): Alert | null {
  const { note, ...alert } = opts;
  const t = targetFor(targetKey, tier);
  const n = num(value);
  if (!t || !Number.isFinite(n)) return null;
  const severity = sevOf(evaluateTarget(n, t));
  if (!severity) return null;
  const shown = t.format ? t.format(n) : `${n}${t.unit ?? ''}`;
  return { ...alert, severity, detail: `${shown} vs target ${formatTarget(t)}${note ? ` · ${note}` : ''}` };
}

/** Traffic-weighted mean of `field` over rows (weighted by assistant_turn_count; plain mean if no counts). */
function weightedMean(rows: Row[], field: string): number {
  const total = rows.reduce((s, r) => s + (Number(r.assistant_turn_count) || 0), 0);
  if (total <= 0) return rows.length ? rows.reduce((s, r) => s + num(r[field] || 0), 0) / rows.length : NaN;
  return rows.reduce((s, r) => s + (Number(r[field]) || 0) * (Number(r.assistant_turn_count) || 0), 0) / total;
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

  // --- Latency SLA: THE SAME POPULATION AND THE SAME AVERAGER AS LatencyTab ------------------------
  //
  // "Mirrors LatencyTab" was a comment rather than a mechanism, and it was false in four ways: no scope
  // filter at all, a separate `> 0` subset per metric, the global band instead of the tier's, and duel
  // rounds pooled in with production traffic. It is true by construction now - `latencyPopulation` and
  // `weightedMetric` are the functions the tab itself calls, and the tier goes through `targetFor`.
  //
  // DUELS ARE OUT UNLESS THE OPERATOR ASKED FOR THEM. A duel fans one hand-picked prompt across several
  // assistants, so its rounds move every percentile they are pooled into - and an SLA alert raised off
  // traffic nobody sent is an alert that teaches people to ignore the list.
  const chosen = sources.filters ?? EMPTY_FILTERS;
  const scope: PerformanceFilters = { ...chosen, duel: chosen.duel ?? 'none' };
  const latRows = latencyPopulation(sources.latency ?? [], scope);
  if (latRows.length) {
    // Perceived-latency SLOs the user actually feels: TTFF (time to placeholder) and E2E (user message
    // to final answer, incl. the inbound hop + cold start). P95 worker-compute is the server-side tail
    // signal — it excludes the inbound hop, so it is secondary to E2E for a user-facing SLA.
    const scopeTurns = latRows.reduce((s, r) => s + (Number(r.assistant_turn_count) || 0), 0);
    const latencyAlert = (field: string, targetKey: string, id: string, title: string) => {
      const m = weightedMetric(latRows, field);
      return metricAlert(
        measuredValue(m),
        targetKey,
        { id, category: 'latency', title, tab: 'latency', note: coverage(m, scopeTurns) },
        scope.classification,
      );
    };
    for (const a of [
      latencyAlert('avg_ttff_ms', 'ttff_ms', 'lat-ttff', i18n.t('admin.alerts.timeToFirstFeedbackAbove')),
      latencyAlert('avg_e2e_ms', 'avg_e2e_ms', 'lat-e2e', i18n.t('admin.alerts.endToEndLatencyAbove')),
      latencyAlert('p95_total_ms', 'p95_total_ms', 'lat-p95', i18n.t('admin.alerts.p95WorkerComputeLatencyAbove')),
    ]) {
      if (a) alerts.push(a);
    }
  }

  // --- Per-intent quality + tool errors ------------------------------------------------------------
  for (const row of sources.intentEffectiveness ?? []) {
    const intent = String(row.intent ?? 'unknown');
    const ax = executionAxis(row);
    const exec = metricAlert(ax.value, ax.targetKey, {
      id: `q-exec-${intent}`, category: 'quality', title: `${intent}: ${ax.label} below target`, tab: 'effectiveness', intent,
    });
    // A JUDGED AVERAGE ALERTS ONLY WHEN ITS POPULATION CAN DETECT THE GAP (SPEC-EVALUATION Appendix C4).
    // The server sizes the smallest gap from target the conversations behind the direct relevance
    // average can detect, with the experiment statistics' power math; a gap smaller than that is noise
    // this population cannot tell from a real drop, and an alert raised on it teaches people to ignore
    // the list.
    if (exec && ax.targetKey === 'relevance_score') {
      const mdd = num(row.direct_relevance_mdd);
      const target = targetFor('relevance_score', null)?.target;
      if (Number.isFinite(mdd) && typeof target === 'number' && Math.abs(target - ax.value) < mdd) {
        // Below what this population can detect; not raised.
      } else {
        alerts.push(exec);
      }
    } else if (exec) {
      alerts.push(exec);
    }
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
      detail: i18n.t('admin.alerts.assistantRepliesClassifiedAsAn'), tab: 'flagged',
    });
  }

  // --- Quality: a BLOCKING compliance breach -------------------------------------------------------
  //
  // NOT A THRESHOLD, AND NOT A RATE. Every other alert here asks whether a measured value drifted past
  // a target. This one asks whether a thing happened at all, because that is what the rule set means
  // by `blocking`: "somebody needs to know today". One disclosed card number is not an acceptable
  // percentage of a good week, so it is never averaged into one - the count is the alert.
  //
  // A non-blocking breach deliberately raises nothing. It belongs in the Evaluations tab beside its
  // rate, and promoting every minor finding here is how an alert list stops being read.
  // Read off the intent-effectiveness rows this tab already loads - no new query (the same assembly
  // rule every other alert here follows), and the drill lands on the surface that shows the rate.
  const blockingBreaches = (sources.intentEffectiveness ?? [])
    .reduce((s, r) => s + (Number(r.blocking_violation_count) || 0), 0);
  if (blockingBreaches > 0) {
    alerts.push({
      id: 'q-compliance-blocking', severity: 'error', category: 'quality',
      title: `${blockingBreaches} blocking compliance breach${blockingBreaches === 1 ? '' : 'es'}`,
      detail: 'a reply breached a rule the rule set grades blocking', tab: 'effectiveness',
    });
  }

  // --- Runtime: platform error rate (client_events) ------------------------------------------------
  const errRows = sources.errorRate ?? [];
  if (errRows.length) {
    const totalErrors = errRows.reduce((s, r) => s + (Number(r.error_count) || 0), 0);
    const totalEvents = errRows.reduce((s, r) => s + (Number(r.total_count ?? r.total_events) || 0), 0);
    const pct = totalEvents > 0 ? (totalErrors / totalEvents) * 100
      : weightedMean(errRows, 'error_percent'); // fall back to a per-row percent if totals are absent
    const a = metricAlert(pct, 'error_rate', { id: 'r-error-rate', category: 'runtime', title: i18n.t('admin.alerts.platformErrorRateAboveTarget'), tab: 'overview' });
    if (a) alerts.push(a);
  }

  // Errors first, then warnings; stable within a severity by category then title.
  const rank = (s: AlertSeverity) => (s === 'error' ? 0 : 1);
  return alerts.sort((a, b) => rank(a.severity) - rank(b.severity) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}
