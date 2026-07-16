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
    label: 'Avg total latency', direction: 'lower', target: 10000, warn: 30000, format: fmtMs,
    description:
      'Mean end-to-end time to the completed answer: placeholder polling + Bedrock inference + delivery. Agentic tool loops make multiple model calls, so multi-second totals are normal. Cold starts inflate the average when traffic is low.',
  },
  p95_total_ms: {
    label: 'P95 total latency', direction: 'lower', target: 15000, warn: 30000, format: fmtMs,
    description:
      '95th-percentile end-to-end latency: 95% of responses complete at or under this value. More sensitive than the average to cold starts, long tool loops, and outliers, so it is the better tail-latency signal.',
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
