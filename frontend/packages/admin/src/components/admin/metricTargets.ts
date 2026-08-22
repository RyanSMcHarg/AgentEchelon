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
      'Mean async-processor compute for the turn, from processor entry to the answer content being ready (history load + tool loop + guardrail). NOT the user wall-clock wait: it excludes the inbound hop (router + classifier + invoke), cold start, posting the answer, and delivery, so it is always less than E2E — see E2E for the full wait. Agentic tool loops make multiple model calls, so multi-second values are normal.',
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

/**
 * PER-TIER LATENCY BANDS (G10, docs/guides/developer/LATENCY-TARGETS.md).
 *
 * THE GAP. Latency was targeted globally, so a premium turn - larger model, retrieval, a longer tool
 * loop - was held to the same band as a basic turn that runs one small model call and no tools. One
 * band cannot be right for both: set for premium it is so loose that a basic regression is invisible
 * inside it, and set for basic it marks healthy premium traffic as failing. Either way the colour on
 * the card stops carrying information, which is worse than having no band at all.
 *
 * WHAT MAY VARY BY TIER, AND WHAT MAY NOT. This is the whole design decision, so it is stated rather
 * than implied:
 *
 *   COMPUTE metrics (worker compute, its P95, the model loop) are ENGINEERING BUDGETS. What a turn
 *   ought to cost genuinely depends on what it was asked to do, so these vary by tier.
 *
 *   PERCEIVED metrics (TTFF, E2E) are UX LIMITS and are deliberately NOT overridden. A person waiting
 *   for a reply does not know or care which model answered them, and the Nielsen thresholds describe
 *   the person, not the system. Giving premium a slower "good" TTFF would not be a tuned target, it
 *   would be a worse experience relabelled as an acceptable one.
 *
 * THE CEILING IS INVARIANT. No override may exceed the Nielsen ~30s abandon threshold, whatever the
 * tier: past it a person leaves, and a band that says otherwise is describing a system nobody is
 * still waiting for. Tiering therefore only ever TIGHTENS expectations for cheaper work; it never
 * buys a slower one permission to be slow. Pinned by metric-targets-tier-bands.test.ts.
 */
export type LatencyTier = 'basic' | 'standard' | 'premium';

/** The Nielsen abandon threshold. No tier band may sit beyond it - see the note above. */
export const ABANDON_CEILING_MS = 30000;

type Band = Pick<MetricTarget, 'target' | 'warn'>;

export const TIER_TARGET_OVERRIDES: Record<string, Partial<Record<LatencyTier, Band>>> = {
  // A basic turn is a classification plus one small model call with no tool loop, so seconds of
  // compute is already an anomaly rather than a busy turn. Premium buys a bigger model AND retrieval,
  // and both are on the critical path.
  avg_total_ms: {
    basic: { target: 4000, warn: 10000 },
    standard: { target: 10000, warn: 20000 },
    premium: { target: 15000, warn: ABANDON_CEILING_MS },
  },
  // The tail widens with the loop: a premium turn has more places to be slow (more iterations, a
  // retrieval that can miss cache), so its P95 sits further from its mean by construction.
  p95_total_ms: {
    basic: { target: 8000, warn: 15000 },
    standard: { target: 15000, warn: ABANDON_CEILING_MS },
    premium: { target: 22000, warn: ABANDON_CEILING_MS },
  },
  // The model loop alone. Tracks the same shape as compute, since on most turns it IS most of it.
  avg_bedrock_ms: {
    basic: { target: 2500, warn: 6000 },
    standard: { target: 6000, warn: 12000 },
    premium: { target: 10000, warn: 20000 },
  },
};

/**
 * The target for a metric, narrowed to one tier when the view is scoped to one.
 *
 * Returns the GLOBAL target when no tier is given, when the tier has no override, or when the tier is
 * unrecognised - so a new tier, or the 'unknown' bucket the latency query emits for legacy rows, is
 * held to the published standard rather than to nothing. Falling back to no target would quietly drop
 * the band off the card, which reads as "this metric has no expectation" instead of "this tier has no
 * tuning yet".
 */
export function targetFor(key: string, tier?: string | null): MetricTarget | undefined {
  const base = METRIC_TARGETS[key];
  if (!base) return undefined;
  const band = tier ? TIER_TARGET_OVERRIDES[key]?.[tier as LatencyTier] : undefined;
  if (!band) return base;
  return { ...base, ...band, label: `${base.label} (${tier})` };
}

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
