/**
 * Central metric-target registry — defines what "good" is for every measured
 * metric in the admin console, in ONE place, so the dashboard shows targets
 * consistently. Pages annotate metric cards + charts from this registry rather
 * than hard-coding thresholds. (Alerting is a separate, later concern; this is
 * display-only.)
 */

import type { DocLinkKey } from '../../config/docLinks';
import { classificationOf } from '@ae/shared';

export type TargetDirection = 'lower' | 'higher'; // lower-is-better | higher-is-better
export type TargetStatus = 'good' | 'warn' | 'bad';

/**
 * WHERE A NUMBER COMES FROM, so a reader can check it instead of trusting the sentence.
 *
 * A description is a claim. Without a path to the computation, a stale claim is indistinguishable
 * from a current one, and that failure is not hypothetical here: the "Latency by interaction"
 * handover tooltip described the only producer that existed when it was written, stayed in place
 * when a second producer started writing the same `trigger_kind`, and was then wrong about half the
 * rows it counted. Nothing could have caught it, because nothing tied the sentence to the code.
 *
 * ── WHY THE LINE NUMBER IS GENERATED AND NEVER TYPED ─────────────────────────────────────────────
 *
 * The console links to the PUBLIC repo (see `config/docLinks.ts`), which is not this working tree.
 * Measured 2026-10-01: `analytics-aurora/analytics-query.ts` is 3889 lines there and 7411 here, and
 * three of four metric-computing symbols checked - `getLatencyByInteraction`, `getTurnKinds`,
 * `ASSISTANT_TURN_SQL` - do not exist in the public file at all. So a hand-written `#L3295` taken
 * from a local editor lands on unrelated code, and an operator who clicks it is misled with more
 * confidence than if there had been no link.
 *
 * `publicLine` is therefore resolved from the public tree by `scripts/gen-metric-provenance.mjs` and
 * asserted by `metric-help-is-short-and-sourced.test.ts`. When the symbol is not public, the field is
 * absent and the console renders the path as TEXT rather than a link - precise, and unable to lie.
 * Code reaching the public repo later upgrades the text to a link with no copy change.
 */
export interface MetricProvenance {
  /** The guide that explains the metric in prose. A key of `DOC_LINKS`, so a moved doc is one edit. */
  guide: DocLinkKey;
  /** Repo-relative path of the file that COMPUTES the number. */
  file: string;
  /** The function, constant or view the computation lives in. Greppable, so it survives a move. */
  symbol: string;
  /** 1-based line of `symbol` IN THE PUBLIC TREE. GENERATED - do not hand-edit. */
  publicLine?: number;
}

export interface MetricTarget {
  /**
   * Locale key for the metric name. This registry is module scope and shared by every tab, so it NAMES
   * its copy; `descriptionKey` beside it already worked this way and the label was the odd one out.
   */
  labelKey: string;
  /** Set when `targetFor` narrowed this target to one tier, so a view can say which. */
  tierLabel?: string;
  direction: TargetDirection;
  /** Boundary of "good" — at/under (lower) or at/over (higher) is good. */
  target: number;
  /** Boundary of "acceptable" — between target and warn is warn; beyond is bad. */
  warn: number;
  unit?: string;
  format?: (v: number) => string;
  /**
   * LOCALE KEY for what the metric measures and how it is derived - the text lives in
   * `shared/src/locales/en.json` under `admin.metrics.<id>.description`, never here.
   *
   * Copy in a `.ts` registry is copy that cannot be translated, and the console is being brought to
   * where the chat client already is (`react-i18next`, one `en.json`). Keeping the KEY here and the
   * text there also puts the three-sentence rule on the locale file, where one guard covers every
   * admin string instead of only this registry.
   *
   * Three sentences because the tooltip is read while someone is interpreting a number, not studying:
   * what it measures, what population it is over, and the one thing that would otherwise be misread.
   * Anything longer belongs in the guide `provenance.guide` names.
   */
  descriptionKey?: string;
  /** The guide and the code behind the number. Required alongside `descriptionKey` (gated by test). */
  provenance?: MetricProvenance;
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtPct = (v: number): string => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/**
 * Registry keyed by a stable metric id. Targets are SOURCED to published industry
 * standards, NOT to a self-imposed limit. Full basis + citations in
 * docs/guides/developer/LATENCY-TARGETS.md. Summary:
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
  // Nielsen NNG: 1s keeps the user focused. (docs/guides/developer/LATENCY-TARGETS.md)
  ttff_ms: {
    labelKey: 'admin.metrics.ttff_ms.label', direction: 'lower', target: 1000, warn: 2000, format: fmtMs,
    descriptionKey: 'admin.metrics.ttff_ms.description',
    provenance: {
      guide: 'latencyTargets',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getLatencyMetrics', publicLine: 1638},
  },
  // Time to COMPLETE response (secondary). Nielsen NNG: 10s attention limit (good),
  // ~30s abandon threshold (warn). Agentic tool loops legitimately take seconds.
  avg_total_ms: {
    labelKey: 'admin.metrics.avg_total_ms.label', direction: 'lower', target: 10000, warn: 30000, format: fmtMs,
    descriptionKey: 'admin.metrics.avg_total_ms.description',
    provenance: {
      guide: 'latencyTargets',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getLatencyMetrics', publicLine: 1638},
  },
  // The true user-perceived wait (user message -> final answer). Includes the inbound hop + cold start
  // that total omits. Nielsen 10s attention limit (good), ~30s abandon (warn). docs/guides/developer/LATENCY-TARGETS.md.
  avg_e2e_ms: {
    labelKey: 'admin.metrics.avg_e2e_ms.label', direction: 'lower', target: 10000, warn: 30000, format: fmtMs,
    descriptionKey: 'admin.metrics.avg_e2e_ms.description',
    provenance: {
      guide: 'latencyTargets',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getLatencyMetrics', publicLine: 1638},
  },
  p95_total_ms: {
    labelKey: 'admin.metrics.p95_total_ms.label', direction: 'lower', target: 15000, warn: 30000, format: fmtMs,
    descriptionKey: 'admin.metrics.p95_total_ms.description',
    provenance: {
      guide: 'latencyTargets',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getLatencyMetrics', publicLine: 1638},
  },
  avg_bedrock_ms: {
    labelKey: 'admin.metrics.avg_bedrock_ms.label', direction: 'lower', target: 6000, warn: 12000, format: fmtMs,
    descriptionKey: 'admin.metrics.avg_bedrock_ms.description',
    provenance: {
      guide: 'latencyTargets',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getLatencyMetrics', publicLine: 1638},
  },
  // Reliability (lower is better) — defaults; tune to your SLO.
  error_rate: {
    labelKey: 'admin.metrics.error_rate.label', direction: 'lower', target: 1, warn: 5, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.error_rate.description',
    provenance: {
      guide: 'adminConsole',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getErrorRateDaily', publicLine: 1385},
  },
  reconnect_rate: {
    labelKey: 'admin.metrics.reconnect_rate.label', direction: 'lower', target: 5, warn: 15, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.reconnect_rate.description',
    provenance: {
      guide: 'frontendObservability',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getConnectionHealthDaily', publicLine: 1479},
  },
  // Response relevance (higher is better) — 0-100 scale, matching the existing
  // EvaluationsTab.scoreColor bands (good ≥75, acceptable ≥50).
  relevance_score: {
    labelKey: 'admin.metrics.relevance_score.label', direction: 'higher', target: 75, warn: 50, format: (v) => v.toFixed(1),
    descriptionKey: 'admin.metrics.relevance_score.description',
    provenance: {
      guide: 'evaluationDesign',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getEvaluationMetrics', publicLine: 806},
  },
  // Effectiveness dashboard (SPEC-ADMIN-CONSOLE-EFFECTIVENESS, User Experience Description and
  // Mocks) — per-intent quality axes. Defaults;
  // tune per deployment via this registry.
  intent_confidence: {
    labelKey: 'admin.metrics.intent_confidence.label', direction: 'higher', target: 80, warn: 50, format: (v) => v.toFixed(0),
    descriptionKey: 'admin.metrics.intent_confidence.description',
    provenance: {
      guide: 'effectiveness',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getIntentEffectiveness', publicLine: 2240},
  },
  task_completion_rate: {
    labelKey: 'admin.metrics.task_completion_rate.label', direction: 'higher', target: 80, warn: 60, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.task_completion_rate.description',
    provenance: {
      guide: 'effectiveness',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getIntentEffectiveness', publicLine: 2240},
  },
  cost_per_reply: {
    labelKey: 'admin.metrics.cost_per_reply.label', direction: 'lower', target: 0.01, warn: 0.05, format: (v) => `$${v.toFixed(4)}`,
    descriptionKey: 'admin.metrics.cost_per_reply.description',
    provenance: {
      guide: 'effectiveness',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getModelEffectiveness', publicLine: 2145},
  },
  tool_error_rate: {
    labelKey: 'admin.metrics.tool_error_rate.label', direction: 'lower', target: 5, warn: 15, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.tool_error_rate.description',
    provenance: {
      guide: 'effectiveness',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getIntentEffectiveness', publicLine: 2240},
  },
  /**
   * USER SIGNAL: the share of RATED replies somebody marked "Needs work".
   *
   * The denominator is votes cast, not replies sent, and that is the whole subtlety. Voting is
   * voluntary, so this measures the people who chose to speak - it is a floor on dissatisfaction,
   * never a measure of satisfaction, and the unrated remainder is silence rather than approval.
   *
   * The thresholds are DEFAULTS and say so: no baseline has been agreed, and a flag rate is heavily
   * shaped by how visible the control is and who is using the product. Read a change in it rather
   * than the level, and tune these once a deployment has its own history to compare against.
   */
  user_flag_rate: {
    labelKey: 'admin.metrics.user_flag_rate.label', direction: 'lower', target: 10, warn: 25, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.user_flag_rate.description',
    provenance: {
      guide: 'evaluationDesign',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getFlaggedResponses', publicLine: 365},
  },
  // Engagement (higher is better) — defaults; tune.
  signup_conversion: {
    labelKey: 'admin.metrics.signup_conversion.label', direction: 'higher', target: 60, warn: 40, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.signup_conversion.description',
    provenance: {
      guide: 'adminConsole',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getFunnelConversion', publicLine: 1404},
  },
  signin_conversion: {
    labelKey: 'admin.metrics.signin_conversion.label', direction: 'higher', target: 95, warn: 85, unit: '%', format: fmtPct,
    descriptionKey: 'admin.metrics.signin_conversion.description',
    provenance: {
      guide: 'adminConsole',
      file: 'backend/lambda/src/analytics-aurora/analytics-query.ts',
      symbol: 'getFunnelConversion', publicLine: 1404},
  },
};

/**
 * PER-TIER LATENCY BANDS (G10, docs/guides/developer/LATENCY-TARGETS.md).
 *
 * THE GAP. Latency was targeted globally, so a premium turn - larger model, retrieval, a longer tool
 * loop - was held to the same band as a basic turn that runs one small model call and no tools. One
 * band cannot be right for both: set for premium it is so loose that a basic regression is invisible
 * inside it, and set for basic it marks healthy premium traffic as failing. Either way the color on
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
 * THE LIMIT IS INVARIANT. No override may exceed the Nielsen ~30s abandon threshold, whatever the
 * tier: past it a person leaves, and a band that says otherwise is describing a system nobody is
 * still waiting for. Tiering therefore only ever TIGHTENS expectations for cheaper work; it never
 * buys a slower one permission to be slow. Pinned by metric-targets-tier-bands.test.ts.
 */
/**
 * THE KEY A BAND IS DECLARED UNDER: a model of the catalog, the default a classification's assistant answers on
 * (`models.default` on a client classification), never a classification value. A classification reads the band
 * of its default model (`targetFor`), so a deployment's own classification is banded as the model it runs on is,
 * and one that declares none is held to the global target.
 */
export type LatencyTier = string;

/** The Nielsen abandon threshold. No tier band may sit beyond it - see the note above. */
export const ABANDON_LIMIT_MS = 30000;

type Band = Pick<MetricTarget, 'target' | 'warn'>;

export const TIER_TARGET_OVERRIDES: Record<string, Record<LatencyTier, Band>> = {
  // A basic turn is a classification plus one small model call with no tool loop, so seconds of
  // compute is already an anomaly rather than a busy turn. Premium buys a bigger model AND retrieval,
  // and both are on the critical path.
  avg_total_ms: {
    haiku: { target: 4000, warn: 10000 },
    sonnet: { target: 10000, warn: 20000 },
    opus: { target: 15000, warn: ABANDON_LIMIT_MS },
  },
  // The tail widens with the loop: a premium turn has more places to be slow (more iterations, a
  // retrieval that can miss cache), so its P95 sits further from its mean by construction.
  p95_total_ms: {
    haiku: { target: 8000, warn: 15000 },
    sonnet: { target: 15000, warn: ABANDON_LIMIT_MS },
    opus: { target: 22000, warn: ABANDON_LIMIT_MS },
  },
  // The model loop alone. Tracks the same shape as compute, since on most turns it IS most of it.
  avg_bedrock_ms: {
    haiku: { target: 2500, warn: 6000 },
    sonnet: { target: 6000, warn: 12000 },
    opus: { target: 10000, warn: 20000 },
  },
};

/**
 * The target for a metric, narrowed to one tier when the view is scoped to one.
 *
 * Returns the GLOBAL target when no tier is given, when the tier has no override, or when the tier is
 * unrecognized - so a new tier, or the 'unknown' bucket the latency query emits for legacy rows, is
 * held to the published standard rather than to nothing. Falling back to no target would quietly drop
 * the band off the card, which reads as "this metric has no expectation" instead of "this tier has no
 * tuning yet".
 */
export function targetFor(key: string, tier?: string | null): MetricTarget | undefined {
  const base = METRIC_TARGETS[key];
  if (!base) return undefined;
  // `tier` is a CLASSIFICATION; the band is read under the default model it declares (`models.default`).
  const selectionKey = tier ? classificationOf(tier)?.models?.default : undefined;
  const band = selectionKey ? TIER_TARGET_OVERRIDES[key]?.[selectionKey] : undefined;
  if (!band) return base;
  // The tier is RETURNED rather than appended to a string: '(premium)' inside an English label cannot
  // be translated, and a view that needs the suffix composes it from `tierLabel`.
  return { ...base, ...band, tierLabel: tier ?? undefined };
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

/** A metric with a definition and no target: named, defined and sourced like a target, never judged. */
export type MetricDefinition = Pick<MetricTarget, 'labelKey' | 'descriptionKey' | 'provenance'>;

const AQ = 'backend/lambda/src/analytics-aurora/analytics-query.ts';
const defined = (id: string, guide: DocLinkKey, symbol: string): MetricDefinition => ({
  labelKey: `admin.metrics.${id}.label`,
  descriptionKey: `admin.metrics.${id}.description`,
  provenance: { guide, file: AQ, symbol },
});

/**
 * THE REST OF THE GLOSSARY. Every figure the console prints has one definition, in `admin.metrics.*`,
 * read by its card's tooltip; the ones with a band live in METRIC_TARGETS above, these have none.
 * `metric-help-is-short-and-sourced.test.ts` holds both registries to the same rules.
 */
export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  client_ttff_ms: defined('client_ttff_ms', 'latencyTargets', 'getClientServerLatency'),
  inbound_ms: defined('inbound_ms', 'latencyTargets', 'getLatencyMetrics'),
  router_ms: defined('router_ms', 'latencyTargets', 'getLatencyMetrics'),
  classifier_ms: defined('classifier_ms', 'latencyTargets', 'getLatencyMetrics'),
  cold_start_rate: defined('cold_start_rate', 'latencyTargets', 'getLatencyMetrics'),
  placeholder_resolve_ms: defined('placeholder_resolve_ms', 'latencyTargets', 'getLatencyMetrics'),
  guard_ms: defined('guard_ms', 'latencyTargets', 'getLatencyMetrics'),
  poll_rate: defined('poll_rate', 'latencyTargets', 'getLatencyMetrics'),
  poll_ms: defined('poll_ms', 'latencyTargets', 'getLatencyMetrics'),
  model_ms: defined('model_ms', 'latencyTargets', 'getLatencyMetrics'),
  tool_ms: defined('tool_ms', 'latencyTargets', 'getLatencyMetrics'),
  tail_ms: defined('tail_ms', 'latencyTargets', 'getLatencyMetrics'),
  grounded_rate: defined('grounded_rate', 'evaluationDesign', 'getIntentEffectiveness'),
  compliance_rate: defined('compliance_rate', 'evaluationDesign', 'getIntentEffectiveness'),
  passages_used: defined('passages_used', 'evaluationDesign', 'getIntentEffectiveness'),
  flags_raised: defined('flags_raised', 'evaluationDesign', 'getFlaggedResponses'),
  workflow_refusals: defined('workflow_refusals', 'effectiveness', 'getIntentEffectiveness'),
  platform_actions: defined('platform_actions', 'effectiveness', 'getIntentEffectiveness'),
  volume: defined('volume', 'effectiveness', 'getIntentEffectiveness'),
  e2e_p95_ms: defined('e2e_p95_ms', 'effectiveness', 'getIntentEffectiveness'),
  flow_score: defined('flow_score', 'effectiveness', 'getFlows'),
  user_positive_rate: defined('user_positive_rate', 'evaluationDesign', 'getIntentEffectiveness'),
};
