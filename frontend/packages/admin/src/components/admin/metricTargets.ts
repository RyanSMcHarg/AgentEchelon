/**
 * Central metric-target registry — defines what "good" is for every measured
 * metric in the admin console, in ONE place, so the dashboard shows targets
 * consistently. Pages annotate metric cards + charts from this registry rather
 * than hard-coding thresholds. (Alerting is a separate, later concern; this is
 * display-only.)
 */

export type TargetDirection = 'lower' | 'higher'; // lower-is-better | higher-is-better
export type TargetStatus = 'good' | 'warn' | 'bad';

export interface MetricTarget {
  label: string;
  direction: TargetDirection;
  /** Boundary of "good" — at/under (lower) or at/over (higher) is good. */
  target: number;
  /** Boundary of "acceptable" — between target and warn is warn; beyond is bad. */
  warn: number;
  unit?: string;
  format?: (v: number) => string;
  /** Plain-language explanation of what the metric measures and how it's
   *  derived — surfaced as the metric's info tooltip in the console. */
  description?: string;
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtPct = (v: number): string => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/**
 * Registry keyed by a stable metric id. Targets are SOURCED to published industry
 * standards, NOT to a self-imposed ceiling. Full basis + citations in
 * docs/LATENCY-TARGETS.md. Summary:
 *  - TTFF (time to first visible feedback) is the PRIMARY latency metric: <1s good,
 *    <2s warn (Nielsen Norman Group response-time limits). With a placeholder shown
 *    in <1s, TTFF is the latency the user actually perceives.
 *  - Total / Bedrock are time-to-complete-response (secondary). An agentic tool loop
 *    runs multiple Bedrock calls, so completion takes seconds; bounded by the Nielsen
 *    10s attention limit (good) and ~30s abandon threshold (warn).
 *  - Drift TPR/FPR: >=95% TPR, <=5% FPR (drift-validation goal).
 *  - Web-vitals: Google Core Web Vitals (handled inline in LatencyTab).
 *  - Error/reconnect/conversion: reliability/engagement defaults; tune to your SLO.
 */
export const METRIC_TARGETS: Record<string, MetricTarget> = {
  // Time to first visible feedback - the primary, perceived-latency metric.
  // Nielsen NNG: 1s keeps the user focused. (docs/LATENCY-TARGETS.md)
  ttff_ms: {
    label: 'Time to first feedback', direction: 'lower', target: 1000, warn: 2000, format: fmtMs,
    description:
      'Time from the user sending a message to the first visible feedback — the placeholder bubble, not the finished answer. This is the latency users actually perceive. Target under 1s, warn under 2s (Nielsen Norman Group). A cold Lambda start adds one-off seconds; warm invocations are much faster.',
  },
  // Time to COMPLETE response (secondary). Nielsen NNG: 10s attention limit (good),
  // ~30s abandon threshold (warn). Agentic tool loops legitimately take seconds.
  avg_total_ms: {
    label: 'Avg worker-compute latency', direction: 'lower', target: 10000, warn: 30000, format: fmtMs,
    description:
      'Mean async-processor compute for the turn, from processor entry to the answer being posted (history load + tool loop + guardrail + post). NOT the user wall-clock wait: it excludes the inbound hop (router + classifier + invoke), cold start, and delivery, so it is always less than E2E — see E2E for the full wait. Agentic tool loops make multiple model calls, so multi-second values are normal.',
  },
  // The true user-perceived wait (user message -> final answer). Includes the inbound hop + cold start
  // that total omits. Nielsen 10s attention limit (good), ~30s abandon (warn). docs/LATENCY-TARGETS.md.
  avg_e2e_ms: {
    label: 'Avg end-to-end latency', direction: 'lower', target: 10000, warn: 30000, format: fmtMs,
    description:
      'Mean user-perceived wait from the message to the FINAL answer (agent_final_at − user_message_at, both on the Chime clock, so skew-free). Unlike worker compute, it includes the inbound hop and cold start — the real latency an SLA is about.',
  },
  p95_total_ms: {
    label: 'P95 worker-compute latency', direction: 'lower', target: 15000, warn: 30000, format: fmtMs,
    description:
      '95th-percentile async-processor compute latency per turn: 95% of individual turns finish computing at or under this. By default multi-step tasks are excluded; when the response-type filter includes them, each task TURN counts individually (per-turn), never the whole multi-turn task cycle. More sensitive than the average to cold starts, long tool loops, and outliers, so it is the better tail signal.',
  },
  avg_bedrock_ms: {
    label: 'Avg Bedrock latency', direction: 'lower', target: 6000, warn: 12000, format: fmtMs,
    description:
      'Mean time spent in Bedrock model inference per response, summed across every model call in the turn. Usually the dominant share of total latency, and the part that scales with model choice and output length.',
  },
  // Reliability (lower is better) — defaults; tune to your SLO.
  error_rate: {
    label: 'Error rate', direction: 'lower', target: 1, warn: 5, unit: '%', format: fmtPct,
    description: 'Share of requests that ended in an error over the window. A reliability default — tune the target to your own SLO.',
  },
  reconnect_rate: {
    label: 'WS reconnect rate', direction: 'lower', target: 5, warn: 15, unit: '%', format: fmtPct,
    description: 'WebSocket reconnects as a share of connections. A rising rate is usually the first sign of Chime instability or browser-tab WS suspension at scale.',
  },
  // Quality — drift detection goal from AE ROADMAP (≥95% TPR, ≤5% FPR).
  drift_tpr: {
    label: 'Drift detection TPR', direction: 'higher', target: 95, warn: 90, unit: '%', format: fmtPct,
    description: 'True-positive rate of drift detection: of the conversations that genuinely drifted topic, the share the detector caught. Goal ≥95%.',
  },
  drift_fpr: {
    label: 'Drift false-positive rate', direction: 'lower', target: 5, warn: 10, unit: '%', format: fmtPct,
    description: 'False-positive rate of drift detection: of the conversations that did not drift, the share wrongly flagged. Goal ≤5%.',
  },
  // Response relevance (higher is better) — 0-100 scale, matching the existing
  // EvaluationsTab.scoreColor bands (good ≥75, acceptable ≥50).
  relevance_score: {
    label: 'Avg relevance score', direction: 'higher', target: 75, warn: 50, format: (v) => v.toFixed(1),
    description:
      'Automated 0–100 relevance score averaged across evaluated exchanges. Each turn is scored context-aware (with its preceding turns), so a correct contextual reply is not penalised as if isolated. Good ≥75, acceptable ≥50.',
  },
  // Effectiveness dashboard (SPEC-ADMIN-CONSOLE-EFFECTIVENESS §5) — per-intent quality axes. Defaults;
  // tune per deployment via this registry.
  intent_confidence: {
    label: 'Classification confidence', direction: 'higher', target: 80, warn: 50, format: (v) => v.toFixed(0),
    description:
      'Average classifier confidence for this intent, mapped high/medium/low → 100/50/0. Low confidence means the router is unsure it routed the traffic correctly — a taxonomy or classifier signal, distinct from whether the work then succeeded.',
  },
  task_completion_rate: {
    label: 'Task completion rate', direction: 'higher', target: 80, warn: 60, unit: '%', format: fmtPct,
    description:
      'Share of this intent’s multi-step tasks that reached a success terminal state. The execution-quality signal for task-delivery intents (paired with the flow composite).',
  },
  intent_reroute_rate: {
    label: 'Reroute rate', direction: 'lower', target: 10, warn: 25, unit: '%', format: fmtPct,
    description:
      'Share of this intent’s exchanges the router re-classified away from the original intent. A high rate points at a taxonomy overlap or a weak classifier boundary, not a runtime failure.',
  },
  cost_per_reply: {
    label: 'Cost per reply', direction: 'lower', target: 0.01, warn: 0.05, format: (v) => `$${v.toFixed(4)}`,
    description:
      'Estimated USD per bot reply, derived from average tokens × the model’s published rate (not billing reconciliation). A decision column alongside quality: a cheap-but-wrong and an expensive-but-excellent intent are different problems.',
  },
  tool_error_rate: {
    label: 'Tool error rate', direction: 'lower', target: 5, warn: 15, unit: '%', format: fmtPct,
    description:
      'Share of this intent’s tool calls that failed (per the structured per-tool step outcome). Tool use is the mechanism that produces the outcome, so a high tool-error rate is a distinct, actionable failure mode.',
  },
  // Engagement (higher is better) — defaults; tune.
  signup_conversion: {
    label: 'Signup conversion', direction: 'higher', target: 60, warn: 40, unit: '%', format: fmtPct,
    description: 'Share of sign-up funnel starts that completed. An engagement default — tune to your baseline.',
  },
  signin_conversion: {
    label: 'Signin success', direction: 'higher', target: 95, warn: 85, unit: '%', format: fmtPct,
    description: 'Share of sign-in attempts that succeeded. A low value can indicate credential or auth-flow friction.',
  },
};

export function evaluateTarget(value: number, t: MetricTarget): TargetStatus {
  if (t.direction === 'lower') {
    if (value <= t.target) return 'good';
    if (value <= t.warn) return 'warn';
    return 'bad';
  }
  if (value >= t.target) return 'good';
  if (value >= t.warn) return 'warn';
  return 'bad';
}

/** Human-readable target, e.g. "≤ 5.0s" or "≥ 0.70". */
export function formatTarget(t: MetricTarget): string {
  const op = t.direction === 'lower' ? '≤' : '≥';
  const v = t.format ? t.format(t.target) : `${t.target}${t.unit ?? ''}`;
  return `${op} ${v}`;
}

export const STATUS_VAR: Record<TargetStatus, string> = {
  good: 'var(--status-good)',
  warn: 'var(--status-warn)',
  bad: 'var(--status-bad)',
};
const STATUS_GLYPH: Record<TargetStatus, string> = { good: '✓', warn: '⚠', bad: '✗' };
export function statusGlyph(s: TargetStatus): string { return STATUS_GLYPH[s]; }
