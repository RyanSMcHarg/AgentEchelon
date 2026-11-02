import i18n from '@ae/shared/i18n';
import React from 'react';
import { teamAssistant } from '../../services/teamScope';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import DistributionBar from './DistributionBar';
import LineChart from './LineChart';
import { METRIC_TARGETS, targetFor } from './metricTargets';
import PerformanceFilterBar, { isTaskType, rowMatches, type PerformanceFilters } from './PerformanceFilters';
import { InfoTooltip, DocLink, GuideLinks, guide } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import TurnLatencyAudit from './TurnLatencyAudit';
import InteractionLatency from './InteractionLatency';
import { coverage, latencyPopulation, weightedMetric, type WeightedMetric } from './latencyAggregate';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

interface LatencyTabProps {
  data: AnalyticsResult | null;
  /** What each boundary of the router's pre-placeholder path cost (v_router_steps). */
  routerStepsData?: AnalyticsResult | null;
  /** Web-vital / timer percentiles from client_events.performance. */
  pageLoadData?: AnalyticsResult | null;
  isLoading: boolean;
  /** The window the tab is showing. Handed to the per-turn audit drill below. */
  dateRange: AnalyticsDateRange;
  /**
   * THE FILTERS, HANDED IN. Latency and Effectiveness read one population two ways, so they cut it
   * with one set rather than each owning its own - which is how a person could narrow one surface,
   * move to the other, and silently be shown a different population.
   */
  filters: PerformanceFilters;
  onFiltersChange: (next: PerformanceFilters) => void;
  /** Which analytics engine is deployed. Every metric on this tab is served from Aurora (G8). */
  analyticsMode?: 'athena' | 'aurora';
  /**
   * Rendered as a drill of the Performance view, which owns the filter bar: the bar is not repeated
   * here, and `openTtff` opens the first-update breakdown the person clicked to reach.
   */
  embedded?: boolean;
  openTtff?: boolean;
}

function latencyColor(ms: number): string {
  // Time-to-complete-response bands, sourced to Nielsen Norman Group response-time
  // limits (10s attention limit; ~30s abandon), NOT a self-imposed limit. An
  // agentic tool loop legitimately runs multiple Bedrock calls, so total time is
  // seconds. Perceived latency is judged separately by TTFF (<=1s). See
  // docs/guides/developer/LATENCY-TARGETS.md.
  if (ms <= 10000) return 'var(--status-good)';  // Good: within the 10s attention limit
  if (ms <= 30000) return 'var(--status-warn)';  // Warn: 10-30s (show progress; users tiring)
  return 'var(--status-bad)';                    // Bad: >30s (abandon threshold)
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Map raw web-vital metric names to display labels + good/needs-improvement
// thresholds. Other (custom timer) metrics render with the raw name and no
// threshold annotation.
/**
 * What each router boundary is, in the operator's words.
 *
 * Keyed on the step names lib/router-steps.ts declares. A step with no entry here renders under its
 * raw name rather than being hidden - a boundary added to the router and not to this map is a gap in
 * the copy, and dropping the row would turn it into a gap in the measurement.
 */
/**
 * WHAT EACH ROUTER BOUNDARY IS, AND WHEN IT APPLIES.
 *
 * The step table named the boundaries and nothing else, so a reader could see that "Turn claim" cost
 * 865ms and had no way to learn what a turn claim is, or that it only happens where the queue is on.
 * The SECOND half matters as much as the first: every step here has its own denominator, so a step
 * that looks cheap may simply be rare, and one that looks expensive may run on every turn.
 *
 * Kept beside the label map rather than in the copy deck: a boundary added to the router needs a name
 * AND an explanation, and having them adjacent is what makes a missing one obvious.
 */
/**
 * The router's steps, in the operator's terms - now `admin.latency.routerStep.*` in en.json.
 *
 * TWO MAPS WITH TWO DIFFERENT FALLBACKS, which is why they are read through different helpers. An
 * unknown HELP key resolves to `help.fallback`, a sentence saying the set is closed. An unknown LABEL
 * must render the RAW step name instead: inventing a label would hide which step a reader is looking
 * at, and the raw name is at least the truth. So labels pass `defaultValue` rather than a second key.
 */
const routerStepHelpKeys = (step: string): string[] => [
  `admin.latency.routerStep.help.${step}`,
  'admin.latency.routerStep.help.fallback',
];


/**
 * One row of filter pills. The tier control was thirty lines of inline style, and role, version and
 * assistant each needed the same thing - three more copies is how four controls drift apart.
 * `allLabel` is per-filter because "All tiers" and "All versions" are not interchangeable copy.
 */
const LatencyTab: React.FC<LatencyTabProps> = ({
  data,
  routerStepsData,
  pageLoadData,
  filters,
  onFiltersChange,
  isLoading,
  dateRange,
  analyticsMode,
  embedded,
  openTtff,
}) => {
  // Response-type filter (by delivery_option). null = the default set (all NON-task response types, so
  // the perceived-single-reply headline excludes multi-step tasks); a Set = the operator's explicit
  // selection. Task turns show PER-TURN reply latency, not whole-task cycle time (a separate metric on
  // the Tasks / Effectiveness surface). Single-reply targets are shown only when no task type is selected.
  const [includeTasks, setIncludeTasks] = React.useState(false);
  // Whether the TTFF breakdown is showing. Opened by pressing the TTFF card, which is the only card
  // on this tab that has a breakdown to open - see the MetricCard `onDrill` prop.
  const [ttffDrillOpen, setTtffDrillOpen] = React.useState(!!openTtff);
  // The other half of the wait. Independent of the TTFF drill: an operator comparing the two halves
  // wants both open, and closing one to read the other is the page deciding what they may compare.
  const [workerDrillOpen, setWorkerDrillOpen] = React.useState(false);
  // ── THE TURNS BEHIND ONE BREAKDOWN ROW ────────────────────────────────────────────────────────
  //
  // The breakdown showed the groups a headline aggregates from and stopped there, so an operator who
  // distrusted a number had nowhere to go. A figure nobody can check is a figure nobody should act on.
  // Fetched on demand rather than with the tab: it is one group of turns, asked for deliberately.
  const [turnDrill, setTurnDrill] = React.useState<{ row: Record<string, unknown>; rows: Record<string, unknown>[]; loading: boolean; error: string | null } | null>(null);
  const openTurnDrill = React.useCallback(async (row: Record<string, unknown>) => {
    setTurnDrill({ row, rows: [], loading: true, error: null });
    try {
      // EVERY DIMENSION OF THE GROUP, because anything less returns a different population than the
      // row that was clicked - and numbers that nearly reconcile are worse than no drill at all.
      const res = await queryAnalytics('latency_exchanges', dateRange, {
        day: String(row.date ?? '').slice(0, 10),
        agentType: String(row.assistant ?? ''),
        deliveryOption: String(row.delivery_option ?? ''),
        assistantRole: String(row.assistant_role ?? ''),
        profileVersion: row.profile_version == null ? '' : String(row.profile_version),
        conversationClassification: String(row.conversation_classification ?? ''),
        turnEntry: String(row.turn_entry ?? ''),
        limit: '200',
      } as never);
      setTurnDrill({ row, rows: (res?.data ?? []) as Record<string, unknown>[], loading: false, error: null });
    } catch (e) {
      setTurnDrill({ row, rows: [], loading: false, error: e instanceof Error ? e.message : i18n.t('admin.latency.turnsError') });
    }
  }, [dateRange]);
  // Tier scope (G10). null = every tier, which is the honest default: the headline should describe
  // all the traffic unless an operator narrows it. Narrowing to exactly ONE tier is what unlocks the
  // per-tier bands, because a band is only meaningful over a population that shares a budget.
  // WHICH ASSISTANT, IN WHICH ROLE, RUNNING WHICH VERSION. Three questions that used to be one,
  // because `agent_type` held the classification and a classification had one assistant. It names the
  // assistant now, so the classification, the role and the profile version are their own filters.
  // DUEL TURNS POOLED WITH PRODUCTION TRAFFIC in every figure on this grid until the query gained a
  // field to partition on. A hand-picked battle prompt moved the headline numbers and nothing here
  // could show that it had.
  // HOW THE TURN ARRIVED, which under the supported configuration is the same question as whether the
  // message was TARGETED. `StandardMessages: NONE` means an untargeted message reaches no Amazon Lex,
  // so every `lex` turn is a targeted one and every `flow` turn is not (migration 054 states the
  // equivalence). The two paths do different work - the Lex path cannot be handed its placeholder id
  // and falls back to polling for it - so pooling them hides a cost that belongs to one of them.
  //
  // The query has grouped by this since 054 and the step grid already splits on it; it was never
  // offered as a filter, so the page could show the split per step and not answer "what do targeted
  // turns cost".
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="admin-tab">
        <div className="skeleton skeleton--title" style={{ width: '32%' }} />
        <div className="skeleton skeleton--chart" />
        <div className="metric-cards-grid skeleton-grid">
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
        </div>
      </div>
    );
  }

  const rows = (data?.data ?? []) as Array<Record<string, unknown>>;

  // Aggregate metrics. Two corrections vs. the naive version:
  //  1) Filter by RESPONSE TYPE (delivery_option). The default excludes multi-step tasks: a task turn's
  //     total_ms / poll_ms on a heavy generation step (report / extraction) runs 20s-minutes and would
  //     drag the perceived single-reply headline. The operator can add task types back with the filter;
  //     task turns are PER-TURN reply latency (whole-task cycle time is measured on Tasks / Effectiveness).
  //  2) VOLUME-WEIGHT the averages + P95 by assistant_turn_count, so one low-traffic slow group does not define
  //     "the" P95. (A true overall p95 is not recoverable from per-group p95 values; the traffic-weighted
  //     mean is the honest single-number summary — see the tooltip.)
  // Task turns stay out of the timing cards unless the person includes them, or chose a task type on
  // the shared bar. The bar's Response type is the cut; this is Latency's own default on top of it.
  const anyTaskSelected = includeTasks || (filters.responseType !== null && isTaskType(filters.responseType));
  // HOW MANY TURNS THE DEFAULT LEAVES OUT. A headline that omits a class of traffic has to say so, or
  // E2E reads as "what people experienced" while describing a subset nobody chose.
  const excludedTaskTurns = anyTaskSelected || filters.responseType !== null ? 0 : rows
    .filter((r) => isTaskType(String(r.delivery_option ?? '')) && rowMatches(r, filters))
    .reduce((n, r) => n + (Number(r.assistant_turn_count) || 0), 0);
  const hasTaskTurns = rows.some((r) => isTaskType(String(r.delivery_option ?? '')));
  const scopeIsSingle = !anyTaskSelected; // single-reply targets apply only when no task type is selected
  // The tiers present in this window, so the control offers what the data actually has rather than a
  // hardcoded three that may not all be deployed.
  // TIERS COME FROM THE CLASSIFICATION COLUMN, not from `agent_type`. That column named the
  // classification until assistants got their own identity; reading tiers off it now would offer a
  // list of assistant names under a control labelled Tier, and would key the per-tier latency bands on
  // a name no band is written for.
  // The option lists live with the bar that renders them (`PerformanceFilters.filterOptions`), so
  // the choices offered and the rows kept are derived from one place.
  // ALL THREE BUCKETS, INCLUDING `unknown`, AND THAT IS DELIBERATE.
  //
  // Offering only `lex` and `flow` would be a control whose options do not partition the population:
  // measured over 30 days, 493 turns carry no entry against 191 `flow` and 3 `lex`, and 77 of one
  // day's 196 are unrecorded - so an operator filtering to "standard" would see a fraction of the
  // traffic with nothing saying the rest was left out. A filter that silently drops most of the data
  // is the shape this tab has already been wrong in once.
  //
  // An unrecorded entry is a DEFECT rather than a category, and it is selectable so it can be found
  // and chased rather than hidden. The label says so.
  // ONE PREDICATE, IMPORTED. The response-type toggle stays local because it is a property of the
  // DELIVERY (streaming, placeholder-update) rather than of the assistant, and Effectiveness has no
  // such axis; everything the two surfaces share goes through `rowMatches`, which `latencyPopulation`
  // applies below - and which Alerts now applies to the same rows, so the two cannot disagree.
  // The tier the per-tier bands apply to. A band describes ONE budget, so it is offered only when the
  // view is narrowed to one tier - across a mixed population it would judge premium turns by a basic
  // expectation or the reverse, which is the defect G10 names.
  const bandTier = filters.classification;
  // Resolved once and shared by the cards and the trend chart's reference lines. `targetFor` falls
  // back to the published band for an untuned tier, so these are always defined for a registered key.
  const avgTarget = targetFor('avg_total_ms', bandTier) ?? METRIC_TARGETS.avg_total_ms;
  const p95Target = targetFor('p95_total_ms', bandTier) ?? METRIC_TARGETS.p95_total_ms;
  // ── ONE POPULATION FOR THE WHOLE TAB ─────────────────────────────────────────────────────────
  //
  // The cards used to gate on `avg_total_ms > 0` and the TTFF card on `avg_ttff_ms > 0`, while this set
  // - the one the breakdown table below draws - gated on neither. Three populations rendered as one
  // screen, and the query had already removed the `total_ms > 0` gate on purpose so that a response
  // running no measurable compute is counted and attributed rather than vanishing. Putting it back here
  // left the fastest turns on the tab (handler-answered ones, where ttff equals e2e) inside the TTFF
  // headline and outside every other card, which biased E2E upward and made the cards disagree with the
  // table under them.
  //
  // Per-metric absence is handled by the AVERAGER instead: `weightedMetric` skips the rows that did not
  // record a metric and reports how many turns its average covers, so every card can state its own
  // coverage and none of them can be computed over a silently different set.
  const scopedRows = latencyPopulation(rows, filters, includeTasks);
  // The scope-wide denominator. Every coverage note is read against this, so a metric recorded on a
  // fraction of the traffic reads as a fraction rather than as a figure about all of it.
  const totalTurns = scopedRows.reduce((s, r) => s + (Number(r.assistant_turn_count) || 0), 0);
  const metric = (field: string, weightField?: string): WeightedMetric =>
    weightedMetric(scopedRows, field, weightField);
  const covers = (m: WeightedMetric): string => coverage(m, totalTurns);
  const totalMs = metric('avg_total_ms');
  const pollMs = metric('avg_poll_ms');
  const avgTotal = totalMs.value;
  const avgBedrock = metric('avg_bedrock_ms').value;
  const avgPoll = pollMs.value;
  // The P95 card states `p95_total_sample_count` instead, which is the number of TURNS behind the
  // percentile rather than the number behind the mean of per-group percentiles.
  const p95Total = metric('p95_total_ms').value;

  // Time to first feedback (TTFF) is the PRIMARY perceived-latency metric: the
  // placeholder-update delivery makes it the latency the user actually waits on
  // (docs/guides/developer/LATENCY-TARGETS.md). There is no token streaming, so TTFF is the delay
  // until the "One moment…" placeholder appears (acknowledgment latency) — the
  // only pre-answer signal distinct from total time. The latency query reads it from
  // the turn ledger (v_turn_latency.ttff_ms, the placeholder instant less the turn's
  // user instant); the exchange's response_latency_ms is the second opinion the
  // shadow-diff panel below compares against it.
  const ttffMs = metric('avg_ttff_ms');
  const avgTtff = ttffMs.value;
  const ttffCaptured = avgTtff > 0;

  // ── TTFF BY HOW THE TURN ARRIVED ─────────────────────────────────────────────────────────────
  //
  // Two entries do different work in front of the first frame, so one figure over both is a figure
  // about neither. Under the supported configuration the split is also the STANDARD-versus-TARGETED
  // one: every assistant carries `StandardMessages: NONE`, so an Amazon Lex invocation is targeted by
  // construction and a flow invocation is not (migration 054 states the equivalence). The labels say
  // that rather than making a reader carry it.
  //
  // THE UNLABELLED TURNS ARE COUNTED, NOT DROPPED. `turn_entry` is NULL on turns the router never
  // recorded, and a split that quietly omits them reports a clean partition of a population it does
  // not cover. Naming the remainder is the difference between a split and a claim.
  const entryOf = (r: Record<string, unknown>) => String(r.turn_entry ?? 'unknown');
  const entrySplit = ['flow', 'lex', 'platform']
    .map((key) => {
      const m = weightedMetric(scopedRows.filter((r) => entryOf(r) === key), 'avg_ttff_ms');
      return { key, label: t(`admin.latency.entry.${key}`, { defaultValue: key }), turns: m.turns, ttff: m.value, metric: m };
    })
    .filter((s) => s.turns > 0);
  const unlabelledTurns = scopedRows
    .filter((r) => entryOf(r) === 'unknown')
    .reduce((s, r) => s + (Number(r.assistant_turn_count) || 0), 0);

  // ── THE FIRST UPDATE IS WHERE THE TWO PATHS PART, SO IT IS THE ONE FIGURE SHOWN PER PATH ──
  //
  // The targeted path reaches the router through Amazon Lex rather than the channel flow, so the time
  // before the router differs and TTFF with it (LATENCY-TARGETS "Outside the router"). After the
  // placeholder the two run the same worker, so E2E and worker compute stay pooled. The one worker
  // step that still differs is the placeholder lookup, which a targeted turn does by scanning because
  // it cannot be handed the placeholder id; it belongs to worker compute, not to TTFF. The card leads
  // with the standard path, the traffic most people see, and names the targeted figure beside it.
  const ttffStandard = entrySplit.find((s) => s.key === 'flow');
  const ttffTargeted = entrySplit.find((s) => s.key === 'lex');
  const ttffLead = ttffStandard ?? ttffTargeted;
  const ttffOther = ttffLead === ttffStandard ? ttffTargeted : undefined;

  // Full latency set (docs/guides/developer/LATENCY-TARGETS.md). Every one of these is the same weighted
  // average over the same scope, taken by the same helper: a metric is averaged over the rows that
  // RECORDED it, so a multi-step task's minutes-long e2e_ms never pollutes the headline and an absent
  // value does not dilute the mean during a rollout.
  //
  // A STEP AVERAGE IS WEIGHTED BY ITS OWN POPULATION when the row publishes one. A group's router average
  // is over the turns that stamped router_ms, not over every turn in the group, so weighting it by the
  // turn count lets a group with few measured turns count as much as its whole traffic.
  // E2E = user message -> FINAL answer (the true perceived wait); null until the final-answer update
  // is folded, so treat absent as "not captured yet" like TTFF.
  const e2eMs = metric('avg_e2e_ms');
  const avgE2e = e2eMs.value;
  const e2eCaptured = avgE2e > 0;
  // Bedrock (latency_ms) split: model inference vs in-loop tool execution; plus the inbound hop.
  const modelMs = metric('avg_model_ms');
  const toolMs = metric('avg_tool_ms');
  const inboundMs = metric('avg_inbound_ms');
  const avgModel = modelMs.value;
  const avgTool = toolMs.value;
  const avgInbound = inboundMs.value;
  // The path, step by step (docs/guides/developer/LATENCY-TARGETS.md "The message path"). These NEST rather than add:
  // classifier is inside router, poll is inside the answer target check. Adding a parent to its own
  // child double-counts, which is the reading these cards exist to make hard.
  const routerMs = metric('avg_router_ms', 'router_measured_count');
  const classifierMs = metric('avg_classifier_ms', 'classified_by_model_count');
  const routerOtherMs = metric('avg_router_other_ms', 'router_measured_count');
  const guardMs = metric('avg_guard_ms', 'guard_measured_count');
  const resolveMs = metric('avg_placeholder_resolve_ms', 'placeholder_measured_count');
  const tailMs = metric('avg_processor_tail_ms');
  const avgRouter = routerMs.value;
  const avgClassifier = classifierMs.value;
  const avgRouterOther = routerOtherMs.value;
  const avgGuard = guardMs.value;
  const avgResolve = resolveMs.value;
  const avgTail = tailMs.value;
  // HOW OFTEN, not how long. Both of these are counts summed over the scoped rows, because the
  // question they answer is a rate: a mean of a column that is null on most turns would sit between
  // two populations and describe neither.
  const sumCount = (field: string): number =>
    scopedRows.reduce((s, r) => s + (Number(r[field]) || 0), 0);


  // ── THE POPULATIONS BEHIND THE TTFF BREAKDOWN ────────────────────────────────────────────────
  // Shown to the reader rather than assumed equal. A step is stamped only on a turn that ran it, so
  // the TTFF average and the router average are taken over different subsets and their difference
  // describes no single turn - which is exactly why the breakdown below marks the remainder as a
  // bound instead of drawing it as a measured slice.
  const ttffMeasuredTurns = ttffMs.turns;
  const routerMeasuredTurns = sumCount('router_measured_count');
  // THE ROUTER LEG, DIVIDED. Its own query (`router_steps`), because the grain is per STEP rather
  // than per day-and-assistant like every other row on this tab. Worst first, which is the order the
  // backend returns and the order somebody opening this section is looking for.
  // A plain derivation, NOT useMemo: this sits after the loading early-return, and a hook below a
  // conditional return is a rules-of-hooks error. The list is one row per step, so there is nothing
  // here worth a hook even if the position allowed one.
  const routerStepStats = ((routerStepsData?.data ?? []) as Record<string, unknown>[]).map((r) => ({
    ...r,
    // The raw name when the copy has no entry for it: a boundary added to the router and not to the
    // label map is a gap in the copy, and hiding the row would make it a gap in the numbers.
    step: t(`admin.latency.routerStep.label.${String(r.step_name)}`, { defaultValue: String(r.step_name) }),
    // ── THE ENTRY IS PART OF THE LABEL, BECAUSE IT IS PART OF THE GROUPING ────────────────────────
    //
    // The query groups by `(step_name, turn_entry)`, so one step arrives as several rows. Rendering
    // the step name alone printed `classify` two or three times with different numbers and no way to
    // tell which was which - a table that looks like a duplicate-row bug and is actually a missing
    // label (review, 2026-09-17).
    //
    // `unknown` is left off rather than shown: it is what `COALESCE` writes for a turn whose entry
    // was not recorded, and appending it would read as a third kind of entry rather than as an
    // absence.
    // The path is the table the row sits in (below), not a suffix on its name.
    stepEntry: t(`admin.latency.routerStep.label.${String(r.step_name)}`, { defaultValue: String(r.step_name) }),
  }));
  // ONE TABLE PER PATH. The query groups by (step_name, turn_entry), and the two paths do different
  // work in front of the first update; interleaving them made one table read like duplicate rows.
  const stepPaths = (['flow', 'lex', 'platform', 'unknown'] as const)
    .map((key) => ({
      key,
      label: key === 'unknown' ? t('admin.latency.entryUnrecorded') : t(`admin.latency.entry.${key}`),
      rows: routerStepStats.filter((r) => String((r as Record<string, unknown>).turn_entry ?? 'unknown') === key),
    }))
    .filter((p) => p.rows.length > 0);
  const pollFallbacks = sumCount('poll_fallback_count');
  const pollFallbackPct = totalTurns > 0 ? (pollFallbacks / totalTurns) * 100 : 0;
  // ── G9: WHAT THE PERCENTILE IS A PERCENTILE OF, AND WHY THE TAIL MAY BE HIGH ──
  // A P95 over a handful of turns is one of the turns, not a tail statistic, and it renders exactly
  // like a P95 over five hundred. The count is what stops a first-run deployment reading its own
  // noise as a performance characteristic.
  const p95Samples = sumCount('p95_total_sample_count');
  // Under this many turns the percentile is an observation rather than a statistic. 20 is the point
  // where the 95th percentile stops being "the single slowest turn" - it is a rule of thumb and it is
  // labeled as one on the card, not presented as a threshold with authority behind it.
  const P95_STABLE_MIN = 20;
  const p95IsNoisy = p95Samples > 0 && p95Samples < P95_STABLE_MIN;
  const coldStarts = sumCount('cold_start_count');
  const coldStartPct = totalTurns > 0 ? (coldStarts / totalTurns) * 100 : 0;
  // TTFF over warm turns only. The comparison is the point: if this sits close to the headline, cold
  // start was NOT the explanation and the divergence is a real finding.
  const avgTtffWarm = metric('avg_ttff_warm_ms').value;
  const coldStartCostMs = avgTtffWarm > 0 && avgTtff > 0 ? avgTtff - avgTtffWarm : 0;

  // ── WHAT CONTRIBUTED TO TTFF ─────────────────────────────────────────────────────────────────
  //
  // Three rows, and the third is a different KIND of claim from the first two.
  //
  // Classification and the rest of the router both come out of `router_ms`, which is one span on one
  // clock, over one population (`router_measured_count`). `avg_router_other_ms` is AVG(router_ms -
  // COALESCE(classifier_ms, 0)) over those same rows, so the classification contribution is the
  // per-row difference `avg_router_ms - avg_router_other_ms`. That is NOT `avg_classifier_ms`, which
  // is the cost WHEN a model is asked and is averaged over only the turns that asked one. Using the
  // card's figure here would overstate classification for every deployment with fast paths, because it
  // would charge every turn the price only some of them paid.
  //
  // The remainder is MEASURED, not estimated, and getting that wrong here was worth correcting.
  //
  // The first version of this panel drew it hatched and called it unknowable, on the grounds that its
  // endpoints sit on different clocks. That is the right objection to an interval BETWEEN two clocks
  // and the wrong one for this: ttff_ms is Chime-clock at both ends and router_ms is server-clock at
  // both ends, so each is a valid duration and the difference of two durations carries no offset. The
  // constraint that is real is the POPULATION one - so the difference is taken per row, over the turns
  // carrying both, by `avg_ttff_outside_router_ms` in the query rather than by subtracting two
  // averages here.
  //
  // A dashboard whose headline is majority-unexplained does not read as careful, it reads as broken,
  // and it invites a reader to discount the parts that ARE solid.
  const routerClassifyMs = Math.max(0, avgRouter - avgRouterOther);
  const ttffOutsideRouter = metric('avg_ttff_outside_router_ms', 'ttff_router_paired_count').value;
  const ttffPairedTurns = sumCount('ttff_router_paired_count');
  // Fall back to the difference of averages ONLY when the paired column is absent - a deployment that
  // has not yet shipped the query above. Marked so the panel can say which of the two it is showing,
  // because one is a per-row measurement and the other is the cruder figure it replaced.
  const ttffRemainderMeasured = ttffPairedTurns > 0 && ttffOutsideRouter > 0;
  const ttffRemainderMs = ttffRemainderMeasured
    ? ttffOutsideRouter
    : Math.max(0, avgTtff - avgRouter);
  // A NEGATIVE REMAINDER IS A FINDING, NOT A BAR. Confirmed on live data: a window where TTFF averaged
  // 1129ms against a router span of 2071ms, over two turns, reconciling exactly to -942ms.
  //
  // It means the placeholder became visible BEFORE the router finished, and that is ordinary: the
  // ROUTER posts the acknowledgment itself, partway through its own span, then carries on with the
  // hand-off and the dispatch. Its span CONTAINS the placeholder rather than ending at it, so the
  // router leg is not always inside TTFF, and a
  // decomposition that assumes it is has nothing to draw here. Saying so is the honest rendering;
  // clamping to zero would file a structural finding as a fast turn.
  const ttffRouterOverran = ttffRemainderMeasured && ttffOutsideRouter < 0;
  // THE REMAINDER, SPLIT where the channel flow recorded when it received the message (migration 090).
  // Over its own set of turns (standard path, all four instants present), so it is stated beside the
  // row rather than drawn into it: the row is over every paired turn, the split over a subset.
  const flowSplitTurns = sumCount('flow_split_count');
  const toFlowMs = metric('avg_to_flow_ms', 'flow_split_count').value;
  const flowToRouterMs = metric('avg_flow_to_router_ms', 'flow_split_count').value;
  const placeholderReturnMs = metric('avg_placeholder_return_ms', 'flow_split_count').value;
  const ttffWaterfall = avgTtff > 0 && !ttffRouterOverran
    ? [
        { label: t('admin.latency.classificationInRouter'), ms: routerClassifyMs, estimated: false },
        { label: t('admin.latency.restOfTheRouter'), ms: avgRouterOther, estimated: false },
        {
          label: t('admin.latency.reachingTheRouter'),
          ms: ttffRemainderMs,
          estimated: !ttffRemainderMeasured,
        },
      ].map((seg) => ({ ...seg, pct: (seg.ms / avgTtff) * 100 }))
    : [];

  // Round the upper-bound to nice numbers for the distribution rail.
  const distMax = p95Total > 0 ? Math.ceil((p95Total * 1.15) / 500) * 500 : 6000;

  // Per-date trend for the SLO chart: rows are per (date, agent, delivery), so
  // collapse to one point per date — mean of avg_total, worst (max) of p95.
  //
  // ── WEIGHTED BY TURNS, BECAUSE THE ROWS ARE GROUPS AND NOT SAMPLES (review, 2026-09-17) ─────────
  //
  // This averaged the per-row `avg_total_ms` with each row counting once, so a group of three turns
  // pulled the day's number as hard as a group of three thousand. It was already wrong across agent
  // and delivery; adding `turn_entry` to the query's GROUP BY made it visible by splitting each group
  // again and moving the plotted line with no change in traffic at all.
  //
  // `assistant_turn_count` is the group's size and is already on every row, so the day's mean is the
  // turn-weighted one - the number an operator reading an SLO chart believes they are looking at, and
  // the only one that does not move when the grouping changes.
  const byDate = new Map<string, { avgSum: number; avgCount: number; p95Max: number }>();
  for (const r of scopedRows) {
    const d = String(r.date || '');
    if (!d) continue;
    const e = byDate.get(d) || { avgSum: 0, avgCount: 0, p95Max: 0 };
    // Absent or unparsable count falls back to 1, which is the old behavior for that row rather than
    // dropping it: a row with no weight still happened.
    const turns = Number(r.assistant_turn_count) > 0 ? Number(r.assistant_turn_count) : 1;
    // A GROUP THAT RECORDED NO COMPUTE IS NOT A ZERO-MILLISECOND DAY. The scope no longer gates on
    // `avg_total_ms`, so the rows the cards skip reach this loop too - and folding them in at 0 would
    // pull the plotted line down by however many turns were answered without measurable compute.
    if (r.avg_total_ms != null && Number(r.avg_total_ms) !== 0) {
      e.avgSum += Number(r.avg_total_ms) * turns;
      e.avgCount += turns;
    }
    e.p95Max = Math.max(e.p95Max, Number(r.p95_total_ms || 0));
    byDate.set(d, e);
  }
  const latencyTrendDates = [...byDate.keys()].sort();
  const avgSeries = latencyTrendDates.map((d) => {
    const e = byDate.get(d)!;
    return e.avgCount ? e.avgSum / e.avgCount : 0;
  });
  const p95Series = latencyTrendDates.map((d) => byDate.get(d)!.p95Max);

  // ---------- Page-load percentiles ----------
  // ── G5: THE SAME WAIT, MEASURED FROM THE OTHER END ──
  //
  // The server brackets TTFF between two Chime message timestamps. The browser brackets it between
  // the person's click and the bubble appearing. Neither is wrong and they are not the same span:
  // the difference is the WebSocket hop and the render, which no server-side metric can see. Until
  // both were on one surface, a slow perceived reply had two candidate explanations and no way to
  // choose - so the DELTA is the number this pair exists to produce.
  // STILL READ HERE, and only for the browser-versus-server delta below. The web-vital PANELS moved
  // to the Client surface; this is the one place the Performance surface legitimately needs a client
  // number, because the delta between it and the server figure is the thing being measured.
  const pageLoadRows = pageLoadData?.data ?? [];
  const clientMetric = (metric: string): number => {
    const row = pageLoadRows.find((r) => String(r.metric) === metric);
    return row ? Number(row.avg_ms) || 0 : 0;
  };
  const clientMetricSamples = (metric: string): number => {
    const row = pageLoadRows.find((r) => String(r.metric) === metric);
    return row ? Number(row.sample_count) || 0 : 0;
  };
  const clientTtff = clientMetric('client_ttff_ms');
  const clientTtffSamples = clientMetricSamples('client_ttff_ms');
  // Positive = the browser waited longer than the server thinks it made them, which is delivery and
  // render. NEGATIVE is a finding, not a glitch: the two clocks disagree, or the server is measuring
  // from a message the client never sent - so it is shown rather than clamped.
  const deliveryGapMs = clientTtff > 0 && avgTtff > 0 ? clientTtff - avgTtff : 0;

  // ---------- Connection health ----------

  return (
    <div className="admin-tab">
      <h3>
        {t('admin.latency.title')}
        {/* Each figure's definition is the glossary (`admin.metrics.*`) behind its card; this says only
            which turns THIS view counts, because the response-type filter changes that. */}
        <InfoTooltip
          label={t('admin.latency.about')}
          content={
            <>
              {t('admin.latency.aboutText')}{' '}
              <DocLink href={DOC_LINKS.latencyTargets}>{t('admin.latency.aboutLink')}</DocLink>.
            </>
          }
        />
      </h3>
      {analyticsMode === 'athena' && (
        // Every figure here is served from Aurora. Said rather than hiding the tab: an absent tab looks
        // like a missing capability, an empty one like a system with no traffic.
        <div className="admin-info-banner" role="note" style={{ borderLeft: '3px solid var(--status-warn)', padding: 'var(--space-2) var(--space-4)', marginBottom: 'var(--space-3)' }}>
          {t('admin.latency.auroraOnly')}
        </div>
      )}
      <div className="admin-info-banner" style={{ borderLeft: '3px solid var(--status-warn)', padding: 'var(--space-2) var(--space-4)', marginBottom: 'var(--space-3)' }}>
        {t('admin.latency.notOptimized')}{' '}
        <DocLink href={DOC_LINKS.performanceOptimization}>{t('admin.docs.title.performanceOptimization')}</DocLink>
      </div>
      <p className="admin-tab-description">{t('admin.latency.description')}</p>
      <GuideLinks guides={[
        guide(t('admin.guides.latency.flow'), 'messageFlowGuide'),
        guide(t('admin.guides.latency.targets'), 'latencyTargets'),
      ]} />

      {hasTaskTurns && filters.responseType === null && (
        <div className="admin-filter-group">
          <button
            type="button"
            aria-pressed={includeTasks}
            onClick={() => setIncludeTasks((v) => !v)}
            title={t('admin.latency.taskTurnHint')}
            className="admin-filter-btn"
          >
            {t('admin.latency.includeTaskTurns')}
          </button>
          {includeTasks && <span className="admin-field-hint">{t('admin.latency.taskTurnsIncluded')}</span>}
          {!includeTasks && excludedTaskTurns > 0 && (
            <span className="admin-field-hint">{t('admin.latency.taskTurnsExcluded', { count: excludedTaskTurns })}</span>
          )}
        </div>
      )}

      {/* One filter bar shared with Effectiveness, so both read the same turns. Embedded in the
          Performance view, which renders the bar itself. */}
      {!embedded && <PerformanceFilterBar rows={rows} value={filters} onChange={onFiltersChange} />}

      {avgTotal > 0 && (
        <div className="admin-tab-banner" style={{ alignItems: 'stretch', flexDirection: 'column' }}>
          <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
            <span className="admin-tab-banner-label-text">{t('admin.latency.distribution')}</span>
          </div>
          <DistributionBar
            min={0}
            max={distMax}
            unit="ms"
            markers={[
              { value: Math.round(avgPoll), label: t('admin.latency.marker.scan'), intensity: 'secondary' },
              { value: Math.round(avgBedrock), label: t('admin.latency.marker.model'), intensity: 'secondary' },
              { value: Math.round(avgTotal), label: t('admin.latency.marker.avg'), intensity: 'primary' },
              { value: Math.round(p95Total), label: t('admin.latency.marker.p95'), intensity: 'primary' },
            ]}
          />
        </div>
      )}

      {/* The page follows one message in the order it happens. E2E is the whole wait and does not
          open: its breakdown is the two cards beside it. TTFF and Worker compute each open their own. */}
      <div className="admin-metrics-row">
        <MetricCard
          title={t('admin.metrics.avg_e2e_ms.label')}
          value={e2eCaptured ? formatMs(avgE2e) : 'n/a'}
          // The coverage is part of the number: each card averages over the turns that recorded it.
          subtitle={e2eCaptured ? t('admin.latency.e2eSub', { coverage: covers(e2eMs) }) : t('admin.latency.noAnswersYet')}
          target={scopeIsSingle ? targetFor('avg_e2e_ms', bandTier) : undefined}
          rawValue={e2eCaptured ? avgE2e : undefined}
          tooltip={t('admin.metrics.avg_e2e_ms.description')}
        />
        <MetricCard
          title={t('admin.metrics.ttff_ms.label')}
          value={ttffCaptured ? formatMs(ttffLead && ttffLead.ttff > 0 ? ttffLead.ttff : avgTtff) : 'n/a'}
          subtitle={!ttffCaptured
            ? t('admin.latency.noPairedYet')
            : ttffLead
              ? [
                t('admin.latency.ttffPath', { path: ttffLead.label, coverage: covers(ttffLead.metric) }),
                ...(ttffOther ? [t('admin.latency.ttffOtherPath', { path: ttffOther.label, ttff: formatMs(ttffOther.ttff), turns: ttffOther.turns.toLocaleString() })] : []),
              ].join(' ')
              : t('admin.latency.ttffSub', { coverage: covers(ttffMs) })}
          target={scopeIsSingle ? targetFor('ttff_ms', bandTier) : undefined}
          rawValue={ttffCaptured ? (ttffLead && ttffLead.ttff > 0 ? ttffLead.ttff : avgTtff) : undefined}
          tooltip={t('admin.metrics.ttff_ms.description')}
          onDrill={ttffCaptured ? () => setTtffDrillOpen((o) => !o) : undefined}
          drillOpen={ttffDrillOpen}
        />
        <MetricCard
          title={t('admin.metrics.avg_total_ms.label')}
          value={formatMs(avgTotal)}
          subtitle={t('admin.latency.workerSub', { coverage: covers(totalMs) })}
          target={scopeIsSingle ? targetFor('avg_total_ms', bandTier) : undefined}
          rawValue={avgTotal}
          tooltip={t('admin.metrics.avg_total_ms.description')}
          onDrill={() => setWorkerDrillOpen((o) => !o)}
          drillOpen={workerDrillOpen}
        />
      </div>

      {/* WHAT CONTRIBUTED TO TTFF. The router leg is on one clock, so it divides exactly. The rest of
          TTFF crosses a clock boundary: `analytics-query.ts` refuses to store `ttff - router_ms` as a
          column, so where the per-turn figure is missing the row is drawn hatched as an estimate. The
          averages come from different turn counts, so the counts are shown. */}
      {ttffDrillOpen && ttffCaptured && (
        <div className="admin-section admin-metric-drill" role="region" aria-label={t('admin.latency.ttffBreakdown')}>
          <h4>{t('admin.latency.ttffTitle', { value: formatMs(avgTtff) })}</h4>
          <p className="admin-tab-description">{t('admin.latency.ttffLead')} {t('admin.latency.ttffInferred')}</p>

          {entrySplit.length > 1 && (
            <p className="admin-tab-description" role="note">
              <strong>{t('admin.latency.byPath')}</strong>{' '}
              {entrySplit.map((s) => t('admin.latency.pathFigure', { path: s.label, ttff: formatMs(s.ttff), turns: s.turns.toLocaleString() })).join(' · ')}
              {unlabelledTurns > 0 && <> · {t('admin.latency.noPath', { count: unlabelledTurns })}</>}
            </p>
          )}

          {ttffRouterOverran && (
            <p className="admin-tab-description" role="note" style={{ borderLeft: '3px solid var(--status-warn)', paddingLeft: 'var(--space-3)' }}>
              {t('admin.latency.routerOverran', { value: formatMs(Math.abs(ttffOutsideRouter)) })}
            </p>
          )}
          <div className="ttff-waterfall">
            {ttffWaterfall.map((seg) => (
              <div
                key={seg.label}
                className={`ttff-waterfall-row${seg.estimated ? ' ttff-waterfall-row--estimated' : ''}`}
              >
                <span className="ttff-waterfall-label">{seg.label}</span>
                <span className="ttff-waterfall-track">
                  <span
                    className="ttff-waterfall-fill"
                    style={{ width: `${Math.max(0, Math.min(100, seg.pct))}%` }}
                  />
                </span>
                <span className="ttff-waterfall-value">
                  {formatMs(seg.ms)} · {seg.pct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>

          <p className="ttff-waterfall-note">
            {ttffRemainderMeasured
              ? t('admin.latency.remainderMeasured', { count: ttffPairedTurns.toLocaleString() })
              : t('admin.latency.remainderEstimated')}
          </p>
          {flowSplitTurns > 0 && (
            <p className="ttff-waterfall-note" role="note">
              {t('admin.latency.remainderSplit', {
                count: flowSplitTurns,
                toFlow: formatMs(toFlowMs),
                flowToRouter: formatMs(flowToRouterMs),
                placeholderReturn: formatMs(placeholderReturnMs),
              })}
            </p>
          )}
          <p className="ttff-waterfall-note">
            {t('admin.latency.counts', { ttff: ttffMeasuredTurns.toLocaleString(), router: routerMeasuredTurns.toLocaleString() })}
          </p>
          {coldStartCostMs > 0 && (
            <p className="ttff-waterfall-note">
              {t('admin.latency.coldStartCost', { value: formatMs(coldStartCostMs), count: coldStarts })}
            </p>
          )}

          {/* A row of figures invites addition, so the overlap is said beside the cards, not only in
              their tooltips. */}
          <p className="admin-tab-description" role="note">{t('admin.latency.overlapping')}</p>
          <div className="admin-metrics-row">
          <MetricCard
            title={t('admin.metrics.client_ttff_ms.label')}
            value={clientTtff > 0 ? formatMs(clientTtff) : 'n/a'}
            rawValue={clientTtff > 0 ? clientTtff : undefined}
            subtitle={clientTtff > 0
              ? (deliveryGapMs !== 0
                ? t('admin.latency.browserSub', { gap: `${deliveryGapMs > 0 ? '+' : ''}${formatMs(deliveryGapMs)}`, count: clientTtffSamples })
                : t('admin.latency.samples', { count: clientTtffSamples }))
              : t('admin.latency.noBrowserTimings')}
            tooltip={t('admin.metrics.client_ttff_ms.description')}
          />
          <MetricCard title={t('admin.metrics.inbound_ms.label')} value={avgInbound > 0 ? formatMs(avgInbound) : 'n/a'} subtitle={t('admin.latency.inboundSub', { coverage: covers(inboundMs) })} rawValue={avgInbound > 0 ? avgInbound : undefined} tooltip={t('admin.metrics.inbound_ms.description')} />
          <MetricCard
            title={t('admin.metrics.router_ms.label')}
            value={avgRouter > 0 ? formatMs(avgRouter) : 'n/a'}
            rawValue={avgRouter > 0 ? avgRouter : undefined}
            subtitle={[avgRouterOther > 0 ? t('admin.latency.outsideClassification', { value: formatMs(avgRouterOther) }) : '', covers(routerMs)].filter(Boolean).join(' · ')}
            tooltip={t('admin.metrics.router_ms.description')}
          />
          <MetricCard
            title={t('admin.metrics.classifier_ms.label')}
            value={avgClassifier > 0 ? formatMs(avgClassifier) : 'n/a'}
            rawValue={avgClassifier > 0 ? avgClassifier : undefined}
            // The coverage is the "how often a model was asked" figure, read off the metric itself.
            subtitle={classifierMs.turns > 0 ? t('admin.latency.classifierSub', { coverage: covers(classifierMs) }) : t('admin.latency.classifierNone')}
            tooltip={t('admin.metrics.classifier_ms.description')}
          />
          <MetricCard
            title={t('admin.metrics.cold_start_rate.label')}
            value={coldStarts > 0 ? `${coldStartPct.toFixed(coldStartPct < 10 ? 1 : 0)}%` : (totalTurns > 0 ? '0%' : 'n/a')}
            rawValue={coldStarts > 0 ? coldStartPct : undefined}
            subtitle={coldStarts > 0
              ? (coldStartCostMs > 0
                ? t('admin.latency.coldSubCost', { count: coldStarts, total: totalTurns, cost: formatMs(coldStartCostMs) })
                : t('admin.latency.coldSub', { count: coldStarts, total: totalTurns }))
              : (totalTurns > 0 ? t('admin.latency.noColdStarts') : undefined)}
            tooltip={t('admin.metrics.cold_start_rate.description')}
          />
          </div>

          <h5>{t('admin.latency.routerStepsTitle')}</h5>
          <p className="admin-tab-description">{t('admin.latency.routerStepsLead')}</p>
          {routerStepStats.length === 0 ? (
            <p className="admin-tab-empty">{t('admin.latency.noRouterSteps')}</p>
          ) : (
            <>
              {stepPaths.map((p) => (
                <div key={p.key}>
                  {stepPaths.length > 1 && <h6>{p.label}</h6>}
                  <DataTable
                    columns={[
                      // `stepEntry`, not `step`: the query groups by (step_name, turn_entry).
                      {
                        key: 'stepEntry',
                        label: t('admin.latency.col.step'),
                        render: (v: unknown, r: Record<string, unknown>) => (
                          // Help is keyed on the raw step_name; the label is already humanised.
                          <span>
                            {String(v)}{' '}
                            <InfoTooltip
                              label={t('admin.latency.aboutStep', { step: String(v) })}
                              content={t(routerStepHelpKeys(String(r.step_name ?? '')))}
                            />
                          </span>
                        ),
                      },
                      { key: 'avg_ms', label: t('admin.latency.col.avg'), render: (v: unknown) => formatMs(Number(v) || 0) },
                      { key: 'p95_ms', label: t('admin.latency.col.p95'), render: (v: unknown) => formatMs(Number(v) || 0) },
                      { key: 'max_ms', label: t('admin.latency.col.max'), render: (v: unknown) => formatMs(Number(v) || 0) },
                      { key: 'turns', label: t('admin.latency.col.turns'), render: (v: unknown) => Number(v || 0).toLocaleString() },
                    ]}
                    data={p.rows}
                  />
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {workerDrillOpen && (
        <div className="admin-section admin-metric-drill" role="region" aria-label={t('admin.latency.workerBreakdown')}>
          <h4>{t('admin.latency.workerTitle', { value: formatMs(avgTotal) })}</h4>
          <p className="admin-tab-description">{t('admin.latency.workerLead')}</p>
          <div className="admin-metrics-row">
        <MetricCard
          title={t('admin.metrics.placeholder_resolve_ms.label')}
          value={avgResolve > 0 ? formatMs(avgResolve) : 'n/a'}
          subtitle={covers(resolveMs)}
          rawValue={avgResolve > 0 ? avgResolve : undefined}
          tooltip={t('admin.metrics.placeholder_resolve_ms.description')}
        />
        <MetricCard
          title={t('admin.metrics.guard_ms.label')}
          value={avgGuard > 0 ? formatMs(avgGuard) : 'n/a'}
          subtitle={covers(guardMs)}
          rawValue={avgGuard > 0 ? avgGuard : undefined}
          tooltip={t('admin.metrics.guard_ms.description')}
        />
        <MetricCard
          title={t('admin.metrics.poll_rate.label')}
          value={totalTurns > 0 ? `${pollFallbackPct.toFixed(1)}%` : 'n/a'}
          rawValue={totalTurns > 0 ? pollFallbackPct : undefined}
          subtitle={pollFallbacks > 0
            ? t('admin.latency.scanSub', { count: pollFallbacks, total: totalTurns, avg: formatMs(avgPoll) })
            : t('admin.latency.noScanNeeded')}
          // The definition keeps the 2026-09-23 discontinuity: the window can still span it.
          tooltip={t('admin.metrics.poll_rate.description')}
        />
        {/* The cost sits beside the rate: how often a scan happens and what one costs are two questions. */}
        <MetricCard
          title={t('admin.metrics.poll_ms.label')}
          value={pollFallbacks > 0 ? formatMs(avgPoll) : 'n/a'}
          rawValue={pollFallbacks > 0 ? avgPoll : undefined}
          subtitle={pollFallbacks > 0 ? t('admin.latency.scanCostSub', { coverage: covers(pollMs) }) : t('admin.latency.noScan')}
          tooltip={t('admin.metrics.poll_ms.description')}
        />
        <MetricCard title={t('admin.metrics.model_ms.label')} value={formatMs(avgModel)} subtitle={covers(modelMs)} rawValue={avgModel} tooltip={t('admin.metrics.model_ms.description')} />
        <MetricCard title={t('admin.metrics.tool_ms.label')} value={avgTool > 0 ? formatMs(avgTool) : 'n/a'} subtitle={covers(toolMs)} rawValue={avgTool > 0 ? avgTool : undefined} tooltip={t('admin.metrics.tool_ms.description')} />
        <MetricCard
          title={t('admin.metrics.tail_ms.label')}
          value={avgTail !== 0 ? formatMs(avgTail) : 'n/a'}
          subtitle={covers(tailMs)}
          rawValue={avgTail !== 0 ? avgTail : undefined}
          tooltip={t('admin.metrics.tail_ms.description')}
        />
        <MetricCard
          title={t('admin.metrics.p95_total_ms.label')}
          value={formatMs(p95Total)}
          target={scopeIsSingle ? targetFor('p95_total_ms', bandTier) : undefined}
          rawValue={p95Total}
          // The denominator is on the card (G9): the number's meaning changes with it.
          subtitle={p95Samples > 0
            ? t(p95IsNoisy ? 'admin.latency.p95SubFew' : 'admin.latency.p95Sub', { count: p95Samples })
            : undefined}
          tooltip={t('admin.metrics.p95_total_ms.description')}
        />
          </div>
        </div>
      )}

      {latencyTrendDates.length >= 2 && (
        <div className="admin-section">
          <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
            <span className="admin-tab-banner-label-text">{t('admin.latency.trendTitle')}</span>
          </div>
          <p className="admin-tab-description">{t('admin.latency.trendLead')}</p>
          <LineChart
            label={t('admin.latency.trendChart')}
            categories={latencyTrendDates.map((d) => d.slice(5))}
            formatY={formatMs}
            series={[
              { label: t('admin.latency.trendP95'), points: p95Series, color: 'var(--accent-500)' },
              { label: t('admin.latency.trendAvg'), points: avgSeries, color: 'var(--status-good)' },
            ]}
            // The same resolver the cards use, so a card and the chart cannot be judged against two bands.
            referenceLines={[
              { value: p95Target.target, label: t('admin.latency.p95Target', { target: formatMs(p95Target.target) }), color: 'var(--status-bad)' },
              { value: avgTarget.target, label: t('admin.latency.avgTarget', { target: formatMs(avgTarget.target) }), color: 'var(--status-warn)' },
            ]}
          />
          <div className="admin-latency-legend">
            <span style={{ color: 'var(--accent-500)' }}>● {t('admin.latency.trendP95')}</span>
            <span style={{ color: 'var(--status-good)' }}>● {t('admin.latency.trendAvg')}</span>
            <span style={{ color: 'var(--status-bad)' }}>{t('admin.latency.trendTargets')}</span>
          </div>
        </div>
      )}


      <div className="admin-section">
        <h3>{t('admin.latency.groupsTitle')}</h3>
        {/* The grain names all eight dimensions the query groups on, so two rows that agree on date and
            assistant do not read as a duplicate. */}
        <p className="admin-tab-description">{t('admin.latency.groupsLead')}</p>
        <div className="admin-latency-legend" role="note" aria-label={t('admin.latency.colorKey')}>
          <span style={{ color: 'var(--text-secondary, #666)', fontWeight: 600 }}>{t('admin.latency.colorKeyLabel')}</span>
          <span style={{ color: 'var(--status-good)' }}>{t('admin.latency.colorGood')}</span>
          <span style={{ color: 'var(--status-warn)' }}>{t('admin.latency.colorWarn')}</span>
          <span style={{ color: 'var(--status-bad)' }}>{t('admin.latency.colorBad')}</span>
        </div>
        <DataTable
        columns={[
          { key: 'date', label: t('admin.latency.col.date') },
          { key: 'assistant', label: t('admin.latency.col.assistant') },
          {
            key: 'delivery_option',
            label: (
              <>
                {t('admin.latency.col.delivery')}
                <InfoTooltip label={t('admin.latency.aboutDelivery')} content={t('admin.latency.deliveryHelp')} />
              </>
            ),
          },
          { key: 'assistant_turn_count', label: t('admin.latency.col.turns') },
          {
            key: 'avg_ttff_ms',
            label: (
              <>
                {t('admin.latency.col.ttff')}
                <InfoTooltip label={t('admin.latency.aboutTtff')} content={t('admin.latency.ttffColumnHelp')} />
              </>
            ),
            render: (v) => (v == null ? <span style={{ opacity: 0.5 }}>—</span> : formatMs(Number(v))),
          },
          {
            key: 'avg_total_ms',
            label: t('admin.latency.col.worker'),
            render: (v) => (
              <span style={{ color: latencyColor(Number(v)), fontWeight: 600 }}>
                {formatMs(Number(v))}
              </span>
            ),
          },
          { key: 'avg_bedrock_ms', label: t('admin.latency.col.modelLoop'), render: (v) => formatMs(Number(v)) },
          { key: 'avg_poll_ms', label: t('admin.latency.col.scan'), render: (v) => formatMs(Number(v)) },
          {
            key: 'p95_total_ms',
            label: t('admin.latency.col.p95Worker'),
            render: (v) => (
              <span style={{ color: latencyColor(Number(v)), fontWeight: 600 }}>
                {formatMs(Number(v))}
              </span>
            ),
          },
        ]}
        data={scopedRows}
        onRowClick={(row) => { void openTurnDrill(row as Record<string, unknown>); }}
        emptyMessage={t('admin.latency.noData')}
        />
        {turnDrill && (
          <div className="admin-section admin-metric-drill" role="region" aria-label={t('admin.latency.turnsInGroup')}>
            <h4>
              {t('admin.latency.turnsTitle')}
              <button className="btn-secondary" style={{ marginLeft: 'var(--space-3)' }} onClick={() => setTurnDrill(null)}>{t('admin.latency.close')}</button>
            </h4>
            <p className="admin-tab-description">
              {t('admin.latency.turnsLead', {
                date: String(turnDrill.row.date ?? '').slice(0, 10),
                assistant: String(turnDrill.row.assistant ?? '—'),
                delivery: String(turnDrill.row.delivery_option ?? '—'),
                path: String(turnDrill.row.turn_entry ?? '—'),
                version: turnDrill.row.profile_version != null ? ` · v${turnDrill.row.profile_version}` : '',
              })}
            </p>
            {turnDrill.loading && <p className="admin-help-text">{t('admin.latency.readingTurns')}</p>}
            {turnDrill.error && <p className="admin-error" role="alert">{turnDrill.error}</p>}
            {/* The drill reads the same turns the row counts, so an empty drill on a non-empty row means
                the two queries have drifted apart. */}
            {!turnDrill.loading && !turnDrill.error && turnDrill.rows.length === 0 && (
              <p className="admin-tab-empty">{t('admin.latency.noTurns')}</p>
            )}
            {turnDrill.rows.length > 0 && (
              <DataTable
                columns={[
                  { key: 'created_at', label: t('admin.latency.col.when'), render: (v: unknown) => new Date(String(v)).toLocaleTimeString() },
                  { key: 'intent', label: t('admin.latency.col.intent'), render: (v: unknown) => (v ? String(v) : '—') },
                  { key: 'ttff_ms', label: t('admin.latency.col.ttff'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
                  {
                    // The browser's own TTFF beside the server's, in the same filtered set of turns.
                    key: 'client_ttff_ms',
                    label: t('admin.latency.col.browser'),
                    render: (v: unknown) => (v == null
                      ? <span title={t('admin.latency.noClientTiming')}>—</span>
                      : formatMs(Number(v))),
                  },
                  {
                    // Negative is not clamped: it means the clocks disagree, and zero would hide that.
                    key: 'delivery_gap_ms',
                    label: t('admin.latency.col.gap'),
                    render: (v: unknown) => {
                      if (v == null) return '—';
                      const n = Number(v);
                      return (
                        <span
                          style={n < 0 ? { color: 'var(--status-bad)' } : undefined}
                          title={n < 0 ? t('admin.latency.negativeGap') : t('admin.latency.positiveGap')}
                        >
                          {n < 0 ? '' : '+'}{formatMs(n)}
                        </span>
                      );
                    },
                  },
                  { key: 'total_ms', label: t('admin.latency.col.worker'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
                  { key: 'e2e_ms', label: t('admin.latency.col.e2e'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
                  { key: 'router_ms', label: t('admin.latency.col.router'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
                  { key: 'latency_ms', label: t('admin.latency.col.model'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
                  { key: 'bedrock_model', label: t('admin.latency.col.modelId'), render: (v: unknown) => (v ? String(v).split('/').pop() : '—') },
                ]}
                data={turnDrill.rows}
              />
            )}
          </div>
        )}
      </div>

      {/* Page load and connection health live on the Client tab: they come from client_events, a
          different clock and population (tenet D7). Queue Health and Answer Types are their own tabs.
          The two panels below read every assistant's turns, so a team does not see them (FR48). */}
      {!teamAssistant() && <InteractionLatency dateRange={dateRange} />}
      {!teamAssistant() && <TurnLatencyAudit dateRange={dateRange} />}
    </div>
  );
};

export default LatencyTab;
